'use strict';

// test/office-runtime-boundary.test.js — 第 0 步工程任务 / Phase 4.
//
// 依赖边界门禁（Harness Runtime Kernel Boundary Gate）。
//
// 目的：让"HARNESS-RUNTIME-CONTRACT-v0 §2 的边界"成为**可执行**的约束，而不是
// 只写在文档里的承诺。本文件断言四件事：
//
//   1. 清单完整性：src/office/runtime/index.js 的 KERNEL_MODULES ∪
//      IO_BOUNDARY_MODULES ∪ {index.js} 与目录里的 .js 文件**集合相等**。
//      新增模块必须显式归类，不允许"悄悄多一个文件"。
//   2. 内核纯度（静态）：纯内核模块不得直接 require electron / pixi.js /
//      DOM 全局 / 网络 / 文件系统 / UI 文件 / 组合根；也不得 require
//      render/**（渲染层只能消费状态，不能成为事实来源）。
//   3. 内核纯度（传递闭包）：内核模块的 require 闭包只能落在内核目录内，或
//      落在 index.js 显式登记的"受保护壳边"（GUARDED_SHELL_EDGES）上；闭包里
//      不得出现 electron / pixi.js / fs / 网络。
//   4. 内核纯度（运行时证明）：把 require('electron') 拦截成抛错后，**每一个**
//      内核模块仍必须能加载——静态可达性 ≠ 真实依赖，这条给出真实依赖的证明。
//
// 另外钉住两处易漂移的契约：
//   - renderer / office-page 的"只消费不生产"方向；
//   - main.js 的 0.1.5 journal → adapter 词表翻译层（无 UI 探针复刻了它，
//     这里做源级漂移检测）。
//
// 契约文本：docs/architecture/HARNESS-RUNTIME-CONTRACT-v0.md §2 / §17。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OFFICE = path.join(SRC, 'office');
const RUNTIME = path.join(OFFICE, 'runtime');

const kernelIndex = require('../src/office/runtime/index.js');
const toolPhrasesModule = require('../src/office/runtime/tool-phrases.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.js$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * 去掉块注释与行注释，避免注释里的词（例如 "window"）造成误报。
 *
 * 2026-10-22 修正：旧实现是"正则先删块注释、再删行注释"，当**行注释里出现 `/*`**
 * （例如头注释说明 `team/*` 命名空间）时，它会被当成块注释开始，从而吞掉随后到源码里
 * 第一个 `*​/` 之间的**真实代码** —— 让依赖/纯度断言静默失效（负向变异 M13 实测未检出）。
 * 这里改为单遍词法扫描并识别字符串字面量，行注释里的注释符不再有特殊含义。
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] || ''); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 源码里出现的 require 说明符（字符串字面量形状，不求值）。 */
function requiresOf(source) {
  const out = [];
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** 按 Node 的解析规则解析一个相对说明符（.js 与 /index.js 回退）。 */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 一个入口文件的 require 闭包：{ files:Set<abs>, bare:Set<specifier> }。
 *  注释先被剥离：注释里提到 `require('./x.js')` 不是依赖（否则一条解释性注释
 *  会伪造出一条越界边）。 */
function closureOf(entryFile) {
  const files = new Set();
  const bare = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of requiresOf(stripComments(read(file)))) {
      if (!spec.startsWith('.')) { bare.add(spec); continue; }
      const resolved = resolveRelative(file, spec);
      if (resolved) visit(resolved);
      else bare.add(`UNRESOLVED:${spec}`);
    }
  };
  visit(entryFile);
  return { files, bare };
}

// 内核允许的 Node 内建：纯计算，无 IO / 无网络 / 无 UI。
const ALLOWED_KERNEL_BUILTINS = Object.freeze(['node:crypto']);
// 纯内核绝不允许出现的内建（IO / 网络 / 进程 / 子进程）。
const FORBIDDEN_KERNEL_BUILTINS = Object.freeze([
  'node:fs', 'node:fs/promises', 'node:path', 'node:zlib', 'node:child_process',
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'node:dns',
  'node:worker_threads', 'node:cluster', 'node:v8', 'node:os', 'node:process',
]);
// 纯内核绝不允许出现的第三方包。
const FORBIDDEN_KERNEL_PACKAGES = Object.freeze(['electron', 'pixi.js', 'ws']);

// ===========================================================================
// 1. 清单完整性
// ===========================================================================

test('boundary: the kernel manifest partitions src/office/runtime exactly (no silent files)', () => {
  const actual = listJs(RUNTIME);
  const declared = [
    ...kernelIndex.KERNEL_MODULES,
    ...kernelIndex.IO_BOUNDARY_MODULES,
    kernelIndex.KERNEL_SURFACE_FILE,
  ].sort();
  assert.deepEqual(declared, actual,
    'src/office/runtime 的每个 .js 必须显式登记为 KERNEL_MODULES / IO_BOUNDARY_MODULES / 聚合面；'
    + '新增模块时同步更新 src/office/runtime/index.js 与 docs/architecture/HARNESS-RUNTIME-CONTRACT-v0.md §2.3');
  // 清单自身无重复。
  assert.equal(new Set(declared).size, declared.length, '清单不得有重复条目');
});

test('boundary: the kernel manifest is sorted and every entry exists', () => {
  for (const name of kernelIndex.KERNEL_MODULES) {
    assert.ok(fs.existsSync(path.join(RUNTIME, name)), `missing kernel module: ${name}`);
  }
  assert.deepEqual([...kernelIndex.KERNEL_MODULES], [...kernelIndex.KERNEL_MODULES].sort(),
    'KERNEL_MODULES 按字母序冻结（便于逐条 diff）');
  assert.deepEqual([...kernelIndex.IO_BOUNDARY_MODULES], [...kernelIndex.IO_BOUNDARY_MODULES].sort(),
    'IO_BOUNDARY_MODULES 按字母序冻结');
});

test('boundary: the version constants exist and are frozen', () => {
  assert.equal(typeof kernelIndex.KERNEL_VERSION, 'string');
  assert.equal(typeof kernelIndex.KERNEL_SCHEMA_VERSION, 'number');
  assert.equal(kernelIndex.KERNEL_SCHEMA_VERSION, 1);
  assert.ok(Object.isFrozen(kernelIndex.KERNEL_MODULES));
  assert.ok(Object.isFrozen(kernelIndex.IO_BOUNDARY_MODULES));
  assert.ok(Object.isFrozen(kernelIndex.GUARDED_SHELL_EDGES));
});

// ===========================================================================
// 2. 内核纯度（静态）
// ===========================================================================

test('boundary: no kernel module directly requires electron, Pixi, fs, network or the UI', () => {
  const offenders = [];
  for (const name of kernelIndex.KERNEL_MODULES) {
    const file = path.join(RUNTIME, name);
    const source = stripComments(read(file));
    for (const spec of requiresOf(source)) {
      if (FORBIDDEN_KERNEL_PACKAGES.includes(spec)) offenders.push(`${name} -> ${spec}`);
      if (FORBIDDEN_KERNEL_BUILTINS.includes(spec)) offenders.push(`${name} -> ${spec}`);
      if (spec.startsWith('node:') && !ALLOWED_KERNEL_BUILTINS.includes(spec)) {
        offenders.push(`${name} -> ${spec} (未登记的内建；内核只允许 ${ALLOWED_KERNEL_BUILTINS.join(', ')})`);
      }
      if (/office-module|render\/|office\.html|office-page|office-preload|\.css$/.test(spec)) {
        offenders.push(`${name} -> ${spec} (UI/组合根方向)`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    '纯内核不得触碰 electron / pixi / fs / 网络 / UI；需要 IO 的模块必须登记为 IO_BOUNDARY_MODULES');
});

test('boundary: no kernel module touches DOM globals, fetch or the filesystem API', () => {
  const offenders = [];
  const DOM_PATTERNS = [
    /\bdocument\s*\./, /\bwindow\s*\./, /\bnavigator\s*\./, /globalThis\s*\.\s*window/,
    /typeof\s+window\b/, /typeof\s+document\b/, /\bXMLHttpRequest\b/, /\blocalStorage\b/,
  ];
  for (const name of kernelIndex.KERNEL_MODULES) {
    const source = stripComments(read(path.join(RUNTIME, name)));
    for (const pattern of DOM_PATTERNS) {
      if (pattern.test(source)) offenders.push(`${name} matches ${pattern}`);
    }
    if (/\bfetch\s*\(/.test(source)) offenders.push(`${name} calls fetch()`);
    if (/\bnew\s+Function\s*\(|\beval\s*\(/.test(source)) offenders.push(`${name} uses eval/new Function`);
  }
  assert.deepEqual(offenders, [], '纯内核必须与 DOM / 网络 / 动态求值无关');
});

test('boundary: the IO boundary modules really own an IO edge (the classification is honest)', () => {
  const offenders = [];
  for (const name of kernelIndex.IO_BOUNDARY_MODULES) {
    const { bare, files } = closureOf(path.join(RUNTIME, name));
    const reachesIo = [...bare].some((spec) => FORBIDDEN_KERNEL_BUILTINS.includes(spec))
      || [...files].some((file) => read(file).includes('node:fs'));
    if (!reachesIo) offenders.push(`${name} reaches no IO edge — it belongs in KERNEL_MODULES`);
  }
  assert.deepEqual(offenders, [], 'IO_BOUNDARY_MODULES 不能当杂物间：每条都必须真的拥有 IO 边');
});

// ===========================================================================
// 3. 内核纯度（传递闭包）
// ===========================================================================

test('boundary: a kernel module\'s require closure never leaves the kernel (except registered shell edges)', () => {
  // 登记过的受保护壳边解析成"允许逃逸的文件 + 允许引入的裸说明符"。
  const guardedFrom = new Map(); // abs from-file -> { target, allows:Set }
  for (const edge of kernelIndex.GUARDED_SHELL_EDGES) {
    const from = path.join(RUNTIME, edge.from);
    const target = resolveRelative(from, edge.to);
    assert.ok(target, `GUARDED_SHELL_EDGES 的 to 必须能解析：${edge.from} -> ${edge.to}`);
    assert.ok(Array.isArray(edge.allows), `${edge.from} 的受保护边必须显式声明 allows`);
    guardedFrom.set(from, { target, allows: new Set(edge.allows) });
  }

  const offenders = [];
  for (const name of kernelIndex.KERNEL_MODULES) {
    const entry = path.join(RUNTIME, name);
    const { files, bare } = closureOf(entry);

    // 该闭包里实际生效的逃逸集合：所有 from 落在闭包内的受保护边。
    const allowedFiles = new Set();
    const allowedBare = new Set();
    for (const file of files) {
      const edge = guardedFrom.get(file);
      if (!edge) continue;
      allowedFiles.add(edge.target);
      for (const spec of edge.allows) allowedBare.add(spec);
    }

    for (const file of files) {
      if (file === entry || file.startsWith(RUNTIME + path.sep)) continue;
      if (allowedFiles.has(file)) continue;
      offenders.push(`${name} reaches ${path.relative(ROOT, file)}`);
    }
    for (const spec of bare) {
      if (ALLOWED_KERNEL_BUILTINS.includes(spec) || allowedBare.has(spec)) continue;
      offenders.push(`${name} reaches bare specifier ${spec}`);
    }
  }
  assert.deepEqual(offenders, [],
    '内核的传递闭包只能落在 src/office/runtime/** 或登记过的受保护壳边上；'
    + '未登记的越界边必须显式登记（见 src/office/runtime/index.js 的 GUARDED_SHELL_EDGES）');
});

test('boundary: the kernel has NO shell edge at all (no registered exceptions remain)', () => {
  // 收尾阶段把 tool-phrases 的 zh 短语表下沉进纯内核后，GUARDED_SHELL_EDGES 应当
  // 为空：纯内核静态不再触达壳的 i18n/Electron。机制保留（未来若有例外必须显式
  // 登记），但**当前不允许任何例外**——这条断言把"零例外"钉住。
  assert.deepEqual([...kernelIndex.GUARDED_SHELL_EDGES], [],
    '纯内核不应再有壳边；若确有必要的例外，必须登记理由并在此处说明');
  // tool-phrases 不再 require 壳字典（注释里提到 i18n.js 是文档，不是依赖）。
  const toolPhrases = read(path.join(RUNTIME, 'tool-phrases.js'));
  const toolPhrasesRequires = requiresOf(stripComments(toolPhrases));
  assert.deepEqual(toolPhrasesRequires.filter((spec) => /i18n/.test(spec)), [],
    'tool-phrases.js 不得再 require 壳的 i18n');
  assert.deepEqual(toolPhrasesRequires, [], 'tool-phrases.js 必须是零依赖的纯模块');
  // 而它需要的 zh 短语以冻结词表的形式留在内核里。
  assert.ok(Object.isFrozen(toolPhrasesModule.PHRASE_ZH));
  assert.deepEqual(Object.keys(toolPhrasesModule.PHRASE_ZH).sort(),
    [...toolPhrasesModule.PHRASE_KEYS].sort(),
    '每个短语 key 都必须有 zh 文本');
});

test('boundary: no kernel module statically reaches any file outside src/office/runtime', () => {
  // 与闭包门禁同源，但**零例外**：任何越界（包括登记过的边）都失败。
  const offenders = [];
  for (const name of kernelIndex.KERNEL_MODULES) {
    const { files, bare } = closureOf(path.join(RUNTIME, name));
    for (const file of files) {
      if (file.startsWith(RUNTIME + path.sep)) continue;
      offenders.push(`${name} reaches ${path.relative(ROOT, file)}`);
    }
    for (const spec of bare) {
      if (ALLOWED_KERNEL_BUILTINS.includes(spec)) continue;
      offenders.push(`${name} reaches bare specifier ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], '纯内核的闭包必须完全落在 src/office/runtime/** 内');
});

// ===========================================================================
// 4. 内核纯度（运行时证明）
// ===========================================================================

test('boundary: every kernel module loads in plain Node with electron unavailable', () => {
  const originalLoad = Module._load;
  const loaded = [];
  const failures = [];
  try {
    Module._load = function guardedLoad(request, parent, isMain) {
      if (request === 'electron') throw new Error('electron is unavailable in this probe');
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const name of kernelIndex.KERNEL_MODULES) {
      const file = path.join(RUNTIME, name);
      try {
        delete require.cache[require.resolve(file)];
        require(file);
        loaded.push(name);
      } catch (error) {
        failures.push(`${name}: ${error && error.message}`);
      }
    }
  } finally {
    Module._load = originalLoad;
  }
  assert.deepEqual(failures, [], '内核模块不得在加载期依赖 electron');
  assert.equal(loaded.length, kernelIndex.KERNEL_MODULES.length);
});

test('boundary: the aggregate kernel surface loads with electron unavailable', () => {
  const originalLoad = Module._load;
  try {
    Module._load = function guardedLoad(request, parent, isMain) {
      if (request === 'electron') throw new Error('electron is unavailable in this probe');
      return originalLoad.call(this, request, parent, isMain);
    };
    const surface = require('../src/office/runtime/index.js');
    assert.equal(surface.KERNEL_VERSION, kernelIndex.KERNEL_VERSION);
    // 聚合面导出的每个值都必须已定义（拼错的别名会让消费者拿到 undefined）。
    const undefinedKeys = Object.entries(surface).filter(([, value]) => value === undefined).map(([key]) => key);
    assert.deepEqual(undefinedKeys, []);
  } finally {
    Module._load = originalLoad;
  }
});

// ===========================================================================
// 5. 渲染层只能消费状态
// ===========================================================================

test('boundary: the renderer and the office page are consumers, never Harness fact sources', () => {
  // office-page.js 按契约零 require（页面只消费注入的 bridge + 快照）。
  const page = read(path.join(OFFICE, 'office-page.js'));
  assert.deepEqual(requiresOf(page), [], 'office-page.js 必须保持 require-free（SPEC-07 契约）');

  // 渲染器只允许 require 帧率监视器与布局资源表；不得触碰 adapter/registry/
  // office-module/Harness —— 渲染不能成为事实来源。
  // P3.0/P3.1：允许再挂两个**纯呈现**模块——presentation-clock（快照间位置
  // 插值）与 code-scene（场景几何描述）。两者都零依赖、无 I/O、不读事件，
  // 只把已有快照/布局换算成绘制参数；下面的事实来源检查对它们同样生效。
  const renderer = path.join(OFFICE, 'render', 'pixi-office-renderer.js');
  const rendererRequires = requiresOf(read(renderer)).sort();
  assert.deepEqual(rendererRequires, ['../layout-assets.js', './code-office.js', './code-scene.js', './fps-monitor.js', './iso-office.js', './iso-projection.js', './presentation-clock.js'],
    '渲染器的 require 集合被冻结：只允许 fps-monitor、layout-assets 与五个纯呈现模块');
  for (const spec of rendererRequires) {
    assert.equal(/runtime\/|office-module|harness/i.test(spec), false);
  }
});

test('boundary: no kernel module requires the renderer, the page or the composition root', () => {
  const offenders = [];
  for (const name of kernelIndex.KERNEL_MODULES) {
    for (const spec of requiresOf(read(path.join(RUNTIME, name)))) {
      if (/render|office-page|office-module|office-preload/.test(spec)) {
        offenders.push(`${name} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    '内核不得反向 import 渲染/页面/组合根（既防止循环依赖，也保证事实方向单一）');
});

test('boundary: the composition root may import the kernel, but never the other way round', () => {
  const moduleSource = read(path.join(OFFICE, 'office-module.js'));
  // 组合根 import 内核（允许方向）。
  assert.match(moduleSource, /require\(\s*'\.\/runtime\/runtime-adapter\.js'\s*\)/);
  assert.match(moduleSource, /require\(\s*'\.\/runtime\/state-reducer\.js'\s*\)/);
  // 组合根允许 fs（fixtures / userData 布局），但它必须登记在 IO 边界之外——
  // 即：它不是内核模块。
  assert.equal(kernelIndex.KERNEL_MODULES.includes('office-module.js'), false);
  assert.equal(kernelIndex.IO_BOUNDARY_MODULES.includes('office-module.js'), false);
  // 反向依赖为 0（由上一个测试覆盖），这里额外断言没有 require 环。
  const kernelFiles = kernelIndex.KERNEL_MODULES.map((n) => path.join(RUNTIME, n));
  for (const file of kernelFiles) {
    const { files } = closureOf(file);
    assert.equal(files.has(path.join(OFFICE, 'office-module.js')), false,
      `${path.basename(file)} 的闭包不得包含 office-module.js`);
  }
});

// ===========================================================================
// 6. main.js 翻译层：源级漂移检测
// ===========================================================================

test('boundary: main.js still owns the 0.1.5 journal -> adapter vocabulary translation', () => {
  // 无 UI 探针（harness-runtime-kernel-probe.test.js）复刻了这层翻译，因为它不能
  // require Electron 壳。这里对 main.js 做源级钉住，防止两边漂移。
  const main = read(path.join(SRC, 'main.js'));
  const anchor = (marker, span) => {
    const at = main.indexOf(marker);
    return at === -1 ? null : main.slice(at, at + span);
  };
  const required = [
    // 翻译入口与顺序
    [/function ingestOfficeJournalEvent\s*\(/, 'ingestOfficeJournalEvent'],
    [/ingestOfficeFollowFrame\s*\(/, 'ingestOfficeFollowFrame'],
    [/function officeAnswerResync\s*\(/, 'officeAnswerResync'],
    // turn/start -> agent/status running
    [/event\.type === 'turn\/start'[\s\S]{0,300}type:\s*'agent\/status'[\s\S]{0,120}status:\s*'running'/, 'turn/start -> agent/status running'],
    // turn/end reason 取自 data.reason.kind
    [/data\.reason\.kind/, 'turn/end reason.kind'],
    // tool/call 只取工具名（共享提取器）
    [/toolNameOfJournalData\(data\)/, 'tool/call -> toolNameOfJournalData'],
    // assistant/message -> turn/usage（只取四个数字；分支内注释很长，按锚点取窗口）
    [/event\.type === 'assistant\/message'/, 'assistant/message 分支存在'],
    // 子代理接线（共享纯模块）
    [/officeSubagentWiring\.handleEvent\(sessionId,\s*event\)/, 'officeSubagentWiring.handleEvent'],
    // 回填入口
    [/mod\.ingestHarnessSnapshot\(\{ sessionId, records \}\)/, 'ingestHarnessSnapshot'],
    // 工具参数原文只进壳的 detailRef 存储，不进办公室
    [/noteOfficeToolCallArgs\(sessionId, event\.data, event\.time\)/, 'noteOfficeToolCallArgs (shell-only)'],
  ];
  const missing = required.filter(([pattern]) => !pattern.test(main)).map(([, label]) => label);
  assert.deepEqual(missing, [], 'main.js 的翻译契约发生了漂移；同步更新契约文档与无 UI 探针');

  // assistant/message 分支必须把 provider usage 翻译成 turn/usage（窗口放宽到
  // 分支后的整段，因为实现里带着一大段解释性注释）。
  const usageWindow = anchor("event.type === 'assistant/message'", 2600);
  assert.ok(usageWindow, 'assistant/message 分支缺失');
  assert.match(usageWindow, /type:\s*'turn\/usage'/, 'assistant/message 必须翻译成 turn/usage');
  assert.match(usageWindow, /inputTokens[\s\S]{0,400}outputTokens/, 'usage 只取四个数字字段');
  assert.equal(/content\s*:/.test(usageWindow), false, 'usage 翻译不得携带消息正文');
});

test('boundary: main.js never forwards raw assistant text to the office module', () => {
  const main = read(path.join(SRC, 'main.js'));
  // assistant-stream（进程内增量帧）只走壳级节奏统计，绝不进办公室：正文是模型
  // 原文，转发会直接击穿隐私边界（SPEC-05 / 契约 §12）。
  const block = main.match(/if \(value\.type === 'assistant-stream'\)[\s\S]{0,600}?\n  \}/);
  assert.ok(block, 'assistant-stream 分支缺失（壳级节奏统计）');
  assert.equal(/ingestHarnessEvent|ingestHarnessSnapshot/.test(block[0]), false,
    'assistant-stream 帧不得转发给 office module（正文是模型原文）');
});

// ===========================================================================
// 7. 组合根冻结：office-module.js 不得再膨胀（第一性原理拆解 P1，2026-10-23）
// ===========================================================================

test('boundary: the composition root require set is frozen (new logic must not move in)', () => {
  // 背景（第一性原理拆解 §"现在应该立即做的架构修正"P1）：office-module.js 已 4500+ 行，
  // 是组合根过载的信号。规定：Team 新逻辑、Worker 新逻辑不得塞进这里；
  // 新 Projection 必须通过单独的 port 接入，office-module.js 只负责组合。
  //
  // 这条门禁把该规定**机械化**：require 说明符集合被冻结。要新增依赖必须
  // （a）先更新这里的冻结清单并说明理由，或（b）放到独立的 port/模块里。
  // 这不是禁止演进，而是让"往组合根里塞东西"变成一个显式决定。
  const FROZEN_REQUIRES = [
    // 2026-11-01（Issue #24）：角色包 action 的校验与分派。
    // 加它是为了**避免** office-module 继续膨胀（4800 行硬上限）——
    // 门禁原话是「超限 = 需要拆分而不是继续堆」。这个依赖是拆分的结果，
    // 而不是把新逻辑塞进组合根。它不碰 fs（磁盘操作在注入的 packManager 里）。
    './office-pack-actions.js',
    // 2026-11-01（P2.3 S3）：白板快照的白名单投影。
    // 同样是为了**避免**组合根膨胀（4800 行硬上限）；拆出的是隐私边界，
    // 它值得被单独审查与测试，而不是埋在一个 4800 行的文件里。
    './office-mission-board.js',
    // 2026-11-01：白板 → Mission Desk 的导航通道。
    // 抽出来的理由与上面几条一致：**避免组合根膨胀**（4800 行硬上限）。
    // 额外好处：这个模块不 require 任何 store/reducer/projection，
    // "它不碰状态"这件事在文件边界上一目了然。
    './office-desk-nav.js',
    './layout-assets.js',
    './runtime/animation-controller.js',
    './runtime/approval-risk.js',
    './runtime/behavior-scheduler.js',
    './runtime/day-record-store.js',
    './runtime/dialogue-engine.js',
    './runtime/employee-placement.js',
    './runtime/employee-profile.js',
    './runtime/employee-registry.js',
    './runtime/movement-controller.js',
    './runtime/office-layout-compiler.js',
    './runtime/office-layout.js',
    './runtime/office-persistence.js',
    './runtime/privacy-redactor.js',
    './runtime/runtime-adapter.js',
    './runtime/runtime-snapshot.js',
    './runtime/state-reducer.js',
    './runtime/subagent-classifier.js',
    './runtime/tool-phrases.js',
    './runtime/transition-controller.js',
    './runtime/usage-snapshot.js',
    'node:fs',
    'node:path',
    'node:perf_hooks',
  ].sort();
  const source = read(path.join(OFFICE, 'office-module.js'));
  const actual = [...new Set(requiresOf(stripComments(source)))].sort();
  assert.deepEqual(actual, FROZEN_REQUIRES,
    'office-module.js 的 require 集合已冻结（第一性原理拆解 P1）。'
    + '新增依赖前请先评估：它是否应该是一个独立模块/port，而不是塞进组合根。'
    + '若确需新增，更新 FROZEN_REQUIRES 并在提交说明里写明理由。');
  // 冻结清单自身不允许悄悄删项（删依赖也要是显式决定）。
  assert.equal(new Set(FROZEN_REQUIRES).size, FROZEN_REQUIRES.length);
});

test('boundary: office-module.js stays under a hard size ceiling (composition, not a monolith)', () => {
  // 上限的**判据**在 2026-11-04 改过一次，原因值得记下来。
  //
  // 原来只数**总行数**（4800）。但实测这个文件：
  //   总行 4800 / 注释+空行 1485（31%）/ 实际代码 3315
  //   —— 也就是说，按总行数算上限，惩罚的主要是**解释**，不是复杂度。
  //
  // 更糟的是它制造了错误的激励：想加代码时第一反应变成"删注释腾地方"，
  // 而不是"这段该不该加 / 该不该拆出去"。
  // 第 55 轮我就为了塞进 artifacts 白名单而压掉了几行注释 —— 那正是信号。
  //
  // 所以改成双判据：
  //   · **代码行**（去注释、去空行）是硬约束 —— 它才是复杂度
  //   · 总行数保留一个更宽松的兜底 —— 防止注释本身失控到不可读
  //
  // 超限的处理不变：拆分**按职责边界**拆（隐私闸门、导航通道这些），
  // 不是按行数凑数。历史上几次拆分都是这么做的，效果很好。
  const source = read(path.join(OFFICE, 'office-module.js'));
  const lines = source.split('\n').length;
  const codeLines = stripComments(source).split('\n').filter((l) => l.trim()).length;

  assert.ok(codeLines <= 3400,
    `office-module.js has ${codeLines} code lines (ceiling 3400). `
    + 'Split a composition concern out instead of growing the root (first-principles P1).');
  assert.ok(lines <= 5200,
    `office-module.js is ${lines} total lines (ceiling 5200). `
    + 'Comments are welcome, but this file must stay navigable.');
});

test('boundary: the old Team ingress name is gone for good (projection semantics, 阶段0)', () => {
  // 第一性原理拆解 P1：office 接收的是 Team 的**表现投影**，不是 Team 本体。
  // 旧名 ingestTeamFact 已于 2026-10-25 硬改名为 ingestTeamProjectionFact（无别名）。
  // 本测试防止有人"顺手"加回旧别名 —— 那会让两个语义并存的调用面重新出现。
  const offenders = [];
  for (const dir of [OFFICE, path.join(SRC, 'team')]) {
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const file = path.join(dir, name);
      const source = stripComments(read(file));
      if (/ingestTeamFact\b/.test(source)) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [],
    'ingestTeamFact was renamed to ingestTeamProjectionFact (hard rename, no alias). '
    + 'Do not reintroduce the old name — update callers instead.');
  // 主进程也不得引用旧名（接线层与内核同口径）。
  assert.equal(/ingestTeamFact\b/.test(stripComments(read(path.join(SRC, 'main.js')))), false);
});

test('boundary: deliverables/presented is intercepted BEFORE it can reach the office', () => {
  // 第一性原理：这条断言守的是隐私铁律 §2.4 的**执行顺序**
  //
  //   官方 present 记录的是绝对路径。如果这个事件像别的事件一样流进
  //   office module，绝对路径就会经 adapter 落进事实链 —— 那时删不掉。
  //
  //   所以它必须在 ingestOfficeJournalEvent 的**前段**被分叉出去，
  //   并在交给 mod 之前 return。下面同时钉住三件事：
  //     1. 有 present 专用的分叉分支
  //     2. 该分支在 mod 调用之前（用 indexOf 位置比较）
  //     3. 分叉后立即 return，不会继续往下走到 mod
  const main = read(path.join(SRC, 'main.js'));
  const fnAt = main.indexOf('function ingestOfficeJournalEvent');
  assert.ok(fnAt !== -1, 'ingestOfficeJournalEvent must exist');
  const fnBody = main.slice(fnAt, fnAt + 4000);

  const branchAt = fnBody.indexOf("event.type === 'deliverables/presented'");
  assert.ok(branchAt !== -1,
    'deliverables/presented must have its own branch (otherwise absolute paths reach the office)');

  // 必须交给收集器（它会削掉绝对路径）
  assert.match(fnBody, /presentedCollector\.ingest\(/,
    'the branch must feed presentedCollector (which strips absolute paths)');

  // 分支必须在"交给 mod"之前。
  //
  // 注意：不能直接 indexOf('mod.ingestHarnessEvent') —— 上面那段解释性注释里
  // 也出现了这个名字，会匹配到注释而不是真实调用。所以找**调用形式**（带左括号）。
  const modAt = fnBody.indexOf('mod.ingestHarnessEvent(');
  assert.ok(modAt !== -1, 'the office ingest call must still exist somewhere in the function');
  assert.ok(branchAt < modAt,
    'the presented branch must come BEFORE the office ingest call');

  // 分支内必须 return（不能 fallthrough 到办公室）。
  //
  // 窗口要精确到**这一个 if 块**为止：早期版本取 700 字符固定窗口，
  // 结果把后面别处的 `return;` 也算了进来，于是"去掉这个 return"的变异
  // 不会被发现 —— 测试看起来在守，其实什么都没守。
  // 现在按花括号配平截出块体，只在这个块里找 return。
  const blockEnd = (start) => {
    let depth = 0;
    for (let i = start; i < fnBody.length; i += 1) {
      const ch = fnBody[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return fnBody.length;
  };
  const openBrace = fnBody.indexOf('{', branchAt);
  assert.ok(openBrace !== -1, 'the presented branch must have a block');
  const branchBlock = fnBody.slice(openBrace, blockEnd(openBrace));
  assert.ok(branchBlock.length > 10, 'the branch block must be non-trivial');
  assert.match(branchBlock, /\breturn\s*;/,
    'the presented branch must return early so the event never reaches the office');
});
