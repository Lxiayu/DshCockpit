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
// 契约文本：docs/specs/HARNESS-RUNTIME-CONTRACT-v0.md §2 / §17。

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
    + '新增模块时同步更新 src/office/runtime/index.js 与 docs/specs/HARNESS-RUNTIME-CONTRACT-v0.md §2.3');
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
  const renderer = path.join(OFFICE, 'render', 'pixi-office-renderer.js');
  const rendererRequires = requiresOf(read(renderer)).sort();
  assert.deepEqual(rendererRequires, ['../layout-assets.js', './fps-monitor.js'],
    '渲染器的 require 集合被冻结：只允许 fps-monitor 与 layout-assets');
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
    './layout-assets.js',
    './runtime/animation-controller.js',
    './runtime/approval-risk.js',
    './runtime/behavior-scheduler.js',
    './runtime/dialogue-engine.js',
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
  // 行数上限：当前 ~4530。上限给到 4800（约 +6% 余量），用于吸收小型组合调整，
  // 但明确阻止它继续按"每轮 +100 行"的速度膨胀。真正的功能逻辑属于 runtime/**
  // 或独立 port；超限 = 需要拆分而不是继续堆。
  const lines = read(path.join(OFFICE, 'office-module.js')).split('\n').length;
  assert.ok(lines <= 4800,
    `office-module.js is ${lines} lines (ceiling 4800). `
    + 'Split composition concerns out instead of growing the root (first-principles P1).');
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
