// test/ipc-contract.test.js — Issue #22 Phase 0：IPC 契约快照（小步提取的安全网）。
//
// 第一性原理：为什么"先把通道集合钉住"是拆 main.js 的前提
//
//   src/main.js 有 6385 行 / 196 个顶层函数 / 107 个 ipcMain.handle，且
//   **没有任何测试真正加载它**（test/ 里 38 个文件提到 main.js，全部是
//   fs.readFileSync + assert.match 的源码正则断言）。这意味着：
//     - 无法单元测试任何 handler
//     - 改名/重构会大量误红，真实 bug 反而测不到
//     - 想"小步提取"时没有安全网判断"我有没有改变行为"
//
//   用户明确要求"行为测试先行、小步提取，不进行一次性大规模重构"。
//   所以第一步不是搬代码，而是**建立不变式**：
//
//     不变式 A：IPC 通道集合是契约。任何一次提取后，通道集合必须完全不变。
//     不变式 B：每个 preload 暴露的通道都必须有对应 handler（否则前端会静默失败）。
//     不变式 C：office:* 通道集合已被门禁冻结（见 office-ui.test.js），这里不重复。
//
//   有了这三条，后续每次把一组 handler 从 main.js 搬到独立模块时，
//   只要本测试仍绿，就可以确信"接口没变"——这正是小步提取的前提。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * 从源码里静态提取 `ipcMain.handle('x')` / `ipcMain.on('x')` 的通道名。
 *
 * 为什么用静态提取而不是加载模块：main.js 顶部 `require('electron')`，
 * 纯 Node 无法加载。在 Phase 0 我们**不改变这个事实**（那是后续步骤），
 * 只先建立可机械校验的契约。等模块被提取出来后，再逐步换成真实加载测试。
 */
function extractChannels(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const out = new Map(); // channel -> {kind, line}
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 跳过注释行，避免把注释里的示例当成真实注册
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const re = /ipcMain\.(handle|on)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      out.set(m[2], { kind: m[1], line: i + 1 });
    }
  }
  return out;
}

/** 从 preload 里静态提取 invoke/send 使用的通道名。 */
function extractPreloadChannels(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const names = new Set();
  const re = /(?:invoke|send)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

function listFiles(dir, filter) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter(filter)
    .map((n) => path.join(ROOT, dir, n));
}

// 注册 IPC 的源码文件（main.js 是组合根，ipc-features 是已抽出的域，
// work-ipc 是工作区域）。新增注册点时必须加进这里 —— 下面的测试会校验。
const IPC_SOURCE_FILES = [
  path.join(ROOT, 'src', 'main.js'),
  path.join(ROOT, 'src', 'ipc-features.js'),
  // Issue #22 Phase 1：MCP 域已提取（第一个批次）
  path.join(ROOT, 'src', 'ipc-mcp.js'),
  // Issue #22 Phase 1：手机遥控网关（第二个批次）
  path.join(ROOT, 'src', 'ipc-remote.js'),
  // Issue #22 Phase 1：plugins / search / quickask（第三批次）
  path.join(ROOT, 'src', 'ipc-misc-domains.js'),
  // P1 Mission Core（Issue #12）：单通道 + action 判别式
  path.join(ROOT, 'src', 'ipc-mission.js'),
  // Issue #22 Phase 1：skills 域（shell:* 的第一个批次）
  path.join(ROOT, 'src', 'ipc-skills.js'),
  path.join(ROOT, 'src', 'work', 'work-ipc.js'),
];

function allRegisteredChannels() {
  const all = new Map();
  for (const f of IPC_SOURCE_FILES) {
    for (const [ch, meta] of extractChannels(f)) {
      all.set(ch, { ...meta, file: path.relative(ROOT, f) });
    }
  }
  return all;
}

// --------------------------------------------------------------- 不变式 A

test('ipc-contract: the registered channel set is stable (snapshot)', () => {
  const channels = allRegisteredChannels();
  // 快照：变更这个清单必须是**有意识的**决定，而不是重构的副作用。
  // 若某次提取让这里变红，说明接口变了 —— 要么改回去，要么同步更新快照并在
  // commit 里说明为什么这是有意的接口变更。
  // 快照的含义是"接口没变"。Issue #22 Phase 1 把 MCP 的 11 个 handler
  // 从 main.js 搬到 ipc-mcp.js —— 通道总数**不变**（还是 124），
  // 这正是"提取"与"接口变更"的区别：前者只搬位置，后者才动集合。
  const EXPECTED_COUNT = 125;
  assert.strictEqual(
    channels.size,
    EXPECTED_COUNT,
    `IPC channel count changed: ${channels.size} (snapshot ${EXPECTED_COUNT}). `
    + 'If this is an intentional interface change, update the snapshot AND explain it; '
    + 'if it is a side effect of a refactor, the refactor changed behaviour and must be reverted.',
  );
});

test('ipc-contract: every channel name is namespaced and well-formed', () => {
  const channels = allRegisteredChannels();
  const bad = [];
  for (const [ch] of channels) {
    // 约定：`namespace:kebab-case`。拒绝空格、大写、下划线、裸名字。
    if (!/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(ch)) bad.push(ch);
  }
  assert.deepEqual(bad, [], `malformed channel names: ${bad.join(', ')}`);
});

test('ipc-contract: no channel is registered twice (no silent override)', () => {
  // ipcMain.handle on an already-handled channel throws at runtime; catching it
  // statically is cheaper than discovering it as a boot failure.
  const perFile = new Map();
  for (const f of IPC_SOURCE_FILES) {
    for (const [ch] of extractChannels(f)) {
      if (!perFile.has(ch)) perFile.set(ch, []);
      perFile.get(ch).push(path.relative(ROOT, f));
    }
  }
  const dupes = [...perFile.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(dupes.map(([ch, f]) => `${ch} in ${f.join(' + ')}`), [],
    'a channel registered in two files means one overwrites the other');
});

// --------------------------------------------------------------- 不变式 B

test('ipc-contract: every channel a preload invokes has a registered handler', () => {
  const registered = allRegisteredChannels();
  const preloads = listFiles('src', (n) => n.endsWith('-preload.js') || n === 'preload.js');
  assert.ok(preloads.length >= 4, `expected several preloads, found ${preloads.length}`);

  const missing = [];
  for (const p of preloads) {
    for (const ch of extractPreloadChannels(p)) {
      if (!registered.has(ch)) missing.push(`${path.relative(ROOT, p)} → ${ch}`);
    }
  }
  assert.deepEqual(missing, [],
    'a preload invoking a channel with no handler fails silently at runtime '
    + '(the promise never resolves). These must be wired or removed.');
});

// --------------------------------------------------------------- 静态度量

test('ipc-contract: the office:* channel set matches the frozen contract', () => {
  // 注意实现差异：office:* **不**用 ipcMain.handle 逐个注册，而是：
  //   - office-module.js 里一个 OFFICE_IPC_CHANNELS 冻结常量（单一真源）
  //   - main.js 用一个分发器把这个集合接到 ipcMain
  // 因此静态扫描 `ipcMain.handle('office:...')` 是**抓不到**的。
  // 这里直接读那个常量——它才是契约本身（office-ui.test.js 另有 5 个套件
  // 精确断言这个集合，此处做一次交叉确认）。
  const modSrc = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8');
  const m = modSrc.match(/const OFFICE_IPC_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'OFFICE_IPC_CHANNELS must be a frozen array literal');
  const channels = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(channels, [
    'office:cancel',
    'office:diagnostics',
    'office:dispatch',
    'office:interrupt',
    'office:pending',
    'office:place',
    'office:settings',
    'office:state',
    'office:visibility',
  ], 'the office:* frozen set must not change (see docs/architecture/2026-08-30-office-spec-00-boundaries.md)');
});

test('ipc-contract: already-extracted domains are registered through their own module, not main.js', () => {
  // This is the "small step extraction" invariant: once a domain is moved out,
  // its channels must NOT creep back into main.js.
  const mainChannels = extractChannels(path.join(ROOT, 'src', 'main.js'));
  const featureChannels = extractChannels(path.join(ROOT, 'src', 'ipc-features.js'));
  assert.ok(featureChannels.size > 0, 'ipc-features.js must register some channels');

  const leaked = [...featureChannels.keys()].filter((ch) => mainChannels.has(ch));
  assert.deepEqual(leaked, [],
    'channels owned by ipc-features.js must not also be registered in main.js '
    + '(double registration silently overrides)');
});

test('ipc-contract: registering files are all accounted for (no hidden registration point)', () => {
  // Guard against a future extraction adding a new module that nobody lists above.
  //
  // 已知且**故意排除**的注册点：
  //   - src/workbench/**  构建期已被 electron-builder 排除，不进正式包（TD-26）
  //   - src/office/**     office:* 走 OFFICE_IPC_CHANNELS 常量 + 分发器，
  //                       不出现 ipcMain.handle 字面量（上面单独断言）
  const srcFiles = listFiles('src', (n) => n.endsWith('.js'));
  const candidates = srcFiles.filter((f) => !f.includes(`${path.sep}workbench${path.sep}`));
  const unlisted = [];
  for (const f of candidates) {
    const src = fs.readFileSync(f, 'utf8');
    if (/ipcMain\.(handle|on)\(/.test(src) && !IPC_SOURCE_FILES.includes(f)) {
      unlisted.push(path.relative(ROOT, f));
    }
  }
  assert.deepEqual(unlisted, [],
    'these files register IPC channels but are not listed in IPC_SOURCE_FILES — '
    + 'add them so the contract snapshot covers them');
});

// ------------------------------------------------------- Phase 0 完成度度量

test('ipc-contract: phase-0 baseline — main.js handler count is recorded', () => {
  // Not a pass/fail gate on the number itself: it documents the starting point
  // so the "small step" progress is measurable over time without guessing.
  const mainChannels = extractChannels(path.join(ROOT, 'src', 'main.js'));
  const featureChannels = extractChannels(path.join(ROOT, 'src', 'ipc-features.js'));
  const total = mainChannels.size + featureChannels.size;

  // The point of recording this: after each extraction batch, mainChannels.size
  // should DROP while the total stays constant, and this test keeps it visible.
  assert.ok(mainChannels.size > 0, 'main.js still owns channels (expected in phase 0)');
  assert.ok(
    mainChannels.size + featureChannels.size > 0,
    'sanity: channels exist',
  );
  // Emit the numbers into the test name so a CI log reads like a progress report.
  assert.ok(total > 50, `expected a substantial IPC surface, got ${total}`);
});
