// test/wiring-regressions.test.js — 两处"断线"的回归测试（P3.5 复盘）。
//
// 第一性原理：这两个 bug 为什么能活到真机验收之后
//
//   B-1 白板点击：页面调 `window.dshShell.openMissionDesk()`，但
//       office 视图的 preload 只暴露 `officeBridge`，且处理器全仓不存在。
//       离线测试断言的是"源码里出现了 openMissionDesk 字符串"——它当然通过。
//
//   B-2 能力包安装：`installer.install()` 调 `runVerify` 时不传 cwd/env，
//       而 verify 命令依赖 DSH_PACK_DIR。真机验收把 install 通道整个
//       stub 掉，从未跑过真正的安装器。
//
//   共同教训：**验收用 stub 绕过被测对象，等于没验收。**
//   所以本文件断言的是"真实的调用链是否闭合"，不是"字符串是否存在"。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ==================================================== B-1 白板点击

test('wiring: the board click uses the bridge that actually exists in the office view', () => {
  const html = strip(read('src/office/office.html'));
  const preload = strip(read('src/office/office-preload.js'));

  // 页面调用的桥必须真的被 expose 过
  const calledBridge = html.match(/window\.(\w+)\.openMissionDesk\(\)/);
  assert.ok(calledBridge, 'the board must call some bridge to open the desk');
  const bridgeName = calledBridge[1];
  assert.strictEqual(bridgeName, 'officeBridge',
    `the office view only exposes officeBridge; calling ${bridgeName} throws TypeError`);
  assert.match(preload, /exposeInMainWorld\('officeBridge'/);
});

test('wiring: the office preload really exposes openMissionDesk', () => {
  const preload = strip(read('src/office/office-preload.js'));
  assert.match(preload, /openMissionDesk:\s*\(\)/,
    'officeBridge.openMissionDesk must exist — the board click depends on it');
});

test('wiring: the office:open-desk channel is in the allowed set AND handled', () => {
  const preload = strip(read('src/office/office-preload.js'));
  const module = strip(read('src/office/office-module.js'));
  // 白名单与处理器两侧都要有，否则 invoke 永远 CHANNEL_UNKNOWN
  assert.match(preload, /'office:open-desk'/, 'it must be in the preload allowlist');
  assert.match(module, /'office:open-desk'/, 'it must be in the module channel list');
  assert.match(module, /case 'office:open-desk':/, 'it must have a handler branch');
});

test('wiring: the full chain page → preload → module → window manager is closed', () => {
  // 这是本测试的重点：不是"字符串存在"，是**每一环都接上了**。
  //
  // 2026-11-01：处理逻辑抽到了 office-desk-nav.js（office-module 有 4800 行
  // 硬上限）。所以链路变成 4 段，断言也要跟着分成 4 处——而不是放宽断言。
  const nav = strip(read('src/office/office-desk-nav.js'));
  assert.match(strip(read('src/office/office.html')), /officeBridge\.openMissionDesk\(\)/);
  assert.match(strip(read('src/office/office-preload.js')), /invokeAllowed\('office:open-desk'/);
  assert.match(strip(read('src/office/office-module.js')), /handleOpenDesk\(\{ keys, openDeskWindow \}\)/);
  assert.match(nav, /openDeskWindow\(\)/, 'the nav module must actually call the injected opener');
  // main.js 必须把 openDeskWindow 注入进 office module
  assert.match(strip(read('src/main.js')), /openDeskWindow:\s*\(\)\s*=>\s*auxWindows\.openMissionDesk\(\)/);
});

test('wiring: openDeskWindow is optional and degrades honestly', () => {
  const nav = strip(read('src/office/office-desk-nav.js'));
  assert.match(nav, /typeof openDeskWindow !== 'function'/, 'it must not assume the window manager is wired');
  assert.match(nav, /DESK_UNAVAILABLE/, 'it must report unavailability, not fake success');
});

test('wiring: the nav module touches NO state (it is pure navigation)', () => {
  // 铁律 5：办公室不是输入面。这条断言把"它不写状态"变成机器可查的事实：
  // 这个模块不允许 require store / reducer / projection。
  const nav = strip(read('src/office/office-desk-nav.js'));
  for (const forbidden of ['store', 'reducer', 'projection', 'state-reducer', 'fs']) {
    assert.ok(!new RegExp(`require\\([^)]*${forbidden}`).test(nav),
      `the nav module must not require ${forbidden} — it only opens a window`);
  }
});

// ==================================================== B-2 能力包安装

test('wiring: the installer passes cwd and DSH_PACK_DIR to verify', () => {
  const src = strip(read('src/capability-packs/installer.js'));
  // 必须传 cwd（不在用户目录留垃圾）与 env（verify 靠它定位包目录）
  assert.match(src, /runVerify\(manifest,\s*\{[^}]*cwd:/, 'install must pass cwd');
  assert.match(src, /runVerify\(manifest,\s*\{[^}]*env:/, 'install must pass env (DSH_PACK_DIR)');
});

test('wiring: verify actually runs in a temp dir, not the user cwd', () => {
  const src = strip(read('src/capability-packs/installer.js'));
  assert.match(src, /mkdtempSync/, 'a temp verify dir must be created');
  assert.doesNotMatch(src, /cwd:\s*process\.cwd\(\)/, 'never verify in the user cwd');
});

test('wiring: the IPC layer passes packDir through to install', () => {
  const src = strip(read('src/ipc-capability-packs.js'));
  assert.match(src, /install\(found\.manifest,\s*\{\s*packDir:/, 'packDir must reach the installer');
});

test('wiring: REAL install works end-to-end for both built-in packs (no stubs)', async () => {
  // 这一条是真机验收 stub 掉的环节。在这里用真实的 runner 跑一遍。
  const { createCapabilityInstaller } = require(path.join(ROOT, 'src/capability-packs/installer.js'));
  const { createCommandRunner } = require(path.join(ROOT, 'src/work/command-runner.js'));
  const { validateManifest } = require(path.join(ROOT, 'src/capability-packs/manifest.js'));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wiring-'));
  const inst = createCapabilityInstaller({ dataDir, runner: createCommandRunner() });

  const packsRoot = path.join(ROOT, 'capability-packs');
  const ids = fs.readdirSync(packsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(ids.length >= 2);

  for (const id of ids) {
    const dir = path.join(packsRoot, id);
    const v = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
    assert.strictEqual(v.ok, true, `${id} manifest must be valid`);
    const r = await inst.install(v.value, { packDir: dir });
    assert.strictEqual(r.ok, true, `${id} must really install (got ${r.code}: ${r.reason || ''})`);
    assert.strictEqual(r.verify.state, 'passed');
  }

  // 安装不应在仓库根留垃圾
  const junk = fs.readdirSync(ROOT).filter((f) => f === 'capability-pack-verify.txt' || f === 'kit-selftest.md');
  assert.deepStrictEqual(junk, [], 'verify must not litter the repo root');

  fs.rmSync(dataDir, { recursive: true, force: true });
});
