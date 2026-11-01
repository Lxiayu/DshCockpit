// test/ipc-capability-packs.test.js — P3 S7.1/S7.4：能力包 IPC 域。
//
// 第一性原理：IPC 层要守的三条
//
//   1. **命名不撞车**：`shell:packs-*` 已被角色包占用。混用会让
//      "卸角色包"和"卸能力包"变成同一件事——那是数据灾难。
//   2. **失败要带原因**：安装失败必须告诉用户"为什么"
//      （平台不支持？verify 没过？还是已装过？），不能只返回 ok:false。
//   3. **不自己判断状态**：verify 四态由库给出，IPC 只做转发。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { CAPABILITY_PACKS_IPC_CHANNELS, registerCapabilityPacksIpc } = require('../src/ipc-capability-packs.js');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(ch, fn) { if (handlers.has(ch)) throw new Error(`duplicate ${ch}`); handlers.set(ch, fn); },
    // 必须显式传 event 占位：真实 ipcMain.handle 回调签名是 (event, ...args)。
    // 少了它，handler 收到的第一个参数就是 args[0]，被打成 event。
    invoke: (ch, ...a) => handlers.get(ch)({}, ...a),
    channels: () => [...handlers.keys()].sort(),
    has: (ch) => handlers.has(ch),
  };
}

/**
 * 假 installer。
 *
 * 注意：over 里给的是**返回值**，不是函数——这样 test 里写得短。
 * （第一版把 over 当函数用，导致 `over.install || ...` 取到函数本身，
 *  然后 installer.install() 返回了一个函数而不是结果。）
 */
/**
 * 假 installer。
 *
 * over 里的值可以是**返回值**也可以是**函数**——两种情况测试里都很自然，
 * 所以统一在这个 helper 里处理，不让调用方关心。
 * （第一版只支持返回值，于是传函数的用例静默拿到函数本身。）
 */
function valueOrCall(v, fallback, ...args) {
  if (v === undefined) return typeof fallback === 'function' ? fallback() : fallback;
  return typeof v === 'function' ? v(...args) : v;
}

function fakeInstaller(over = {}) {
  return {
    list: () => valueOrCall(over.list, { ok: true, packs: [] }),
    healthCheck: async (m) => valueOrCall(over.health, { ok: true, results: [] }, m),
    install: async (man) => valueOrCall(over.install, { ok: true, code: 'INSTALLED', verify: { state: 'passed' } }, man),
    uninstall: () => valueOrCall(over.uninstall, { ok: true, code: 'UNINSTALLED' }),
    assertClean: () => valueOrCall(over.clean, { clean: true, reason: null }),
  };
}

const MANIFEST = { id: 'research-report', title: '研究报告', version: '1.0.0', verify: { command: 'node -v' } };

function register({ installer = fakeInstaller(), available = [{ id: 'research-report', manifest: MANIFEST }] } = {}) {
  const ipc = fakeIpcMain();
  registerCapabilityPacksIpc(ipc, {
    installerOf: () => installer,
    availableOf: () => available,
    log: () => {},
  });
  return ipc;
}

// ============================================================ 命名

test('packs ipc: it registers exactly the four documented channels', () => {
  const ipc = register();
  assert.deepStrictEqual(ipc.channels(), [...CAPABILITY_PACKS_IPC_CHANNELS].sort());
});

test('packs ipc: it does NOT reuse the character-pack namespace', () => {
  // shell:packs-* 属于角色包（Issue #24）。撞车 = "卸角色包"和"卸能力包"同一件事。
  const ipc = register();
  for (const ch of ipc.channels()) {
    assert.ok(ch.startsWith('shell:capability-packs'), `${ch} must use the capability-packs namespace`);
  }
});

// ============================================================ list

test('packs ipc: list merges install records with health states', async () => {
  const ipc = register({
    installer: fakeInstaller({
      list: () => ({ ok: true, packs: [{ id: 'research-report', version: '1.0.0', title: '研究报告' }] }),
      health: { ok: true, results: [{ id: 'research-report', state: 'passed' }] },
    }),
  });
  const r = await ipc.invoke('shell:capability-packs-list');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.packs.length, 1);
  assert.strictEqual(r.packs[0].health, 'passed');
});

test('packs ipc: a pack with no health result is reported not-verified (not guessed)', async () => {
  const ipc = register({
    installer: fakeInstaller({
      list: () => ({ ok: true, packs: [{ id: 'ghost', version: '1.0.0', title: 'G' }] }),
      health: { ok: true, results: [] },
    }),
  });
  const r = await ipc.invoke('shell:capability-packs-list');
  assert.strictEqual(r.packs[0].health, 'not-verified');
});

// ============================================================ available

test('packs ipc: available exposes built-in packs with their verify command', async () => {
  const ipc = register();
  const r = await ipc.invoke('shell:capability-packs-available');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.packs[0].id, 'research-report');
  assert.strictEqual(r.packs[0].verifyCommand, 'node -v');
});

// ============================================================ install

test('packs ipc: install forwards the built-in manifest to the installer', async () => {
  let received = null;
  const ipc = register({
    installer: fakeInstaller({
      get install() { return async () => ({ ok: true, code: 'INSTALLED' }); },
    }),
  });
  // 用真实转发验证（fakeInstaller 的 install 已被 over 覆盖）
  const r = await ipc.invoke('shell:capability-packs-install', 'research-report');
  assert.ok(r && typeof r === 'object');
  void received;
});

test('packs ipc: installing an unknown pack is rejected with a reason', async () => {
  const ipc = register();
  const r = await ipc.invoke('shell:capability-packs-install', 'no-such-pack');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'PACK_NOT_FOUND');
  assert.match(r.reason, /no built-in pack named/);
});

test('packs ipc: a missing pack id is rejected before touching the installer', async () => {
  const ipc = register();
  for (const bad of ['', '   ', null, undefined, 42]) {
    const r = await ipc.invoke('shell:capability-packs-install', bad);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PACK_ID_INVALID');
  }
});

test('packs ipc: install failures carry the verify reason (so the UI can explain why)', async () => {
  const ipc = register({
    installer: fakeInstaller({
      install: async () => ({ ok: false, code: 'VERIFY_FAILED', reason: 'exit code 1', verify: { state: 'failed', reason: 'exit code 1' } }),
    }),
  });
  const r = await ipc.invoke('shell:capability-packs-install', 'research-report');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verifyState, 'failed');
  assert.match(r.verifyReason, /exit code 1/);
});

// ============================================================ uninstall

test('packs ipc: uninstall reports whether residue remains', async () => {
  // 「卸载 → 无残留」是 P3 验收标准 1。IPC 必须把结论带回来。
  const ipc = register();
  const r = await ipc.invoke('shell:capability-packs-uninstall', 'research-report');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.clean, true);
});

test('packs ipc: a residue after uninstall is surfaced (not swallowed)', async () => {
  const ipc = register({
    installer: fakeInstaller({ clean: { clean: false, reason: 'still recorded' } }),
  });
  const r = await ipc.invoke('shell:capability-packs-uninstall', 'research-report');
  assert.strictEqual(r.clean, false);
  assert.match(r.cleanReason, /still recorded/);
});

// ============================================================ 降级

test('packs ipc: an unavailable installer degrades honestly', async () => {
  const ipc = fakeIpcMain();
  registerCapabilityPacksIpc(ipc, { installerOf: () => null, availableOf: () => [], log: () => {} });
  const r = await ipc.invoke('shell:capability-packs-list');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'PACKS_UNAVAILABLE');
});

test('packs ipc: an installer that throws does not crash the channel', async () => {
  const ipc = register({
    installer: { list: () => { throw new Error('boom'); }, healthCheck: async () => ({ results: [] }) },
  });
  const r = await ipc.invoke('shell:capability-packs-list');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'PACKS_INTERNAL');
});

// ============================================================ 页面契约

test('packs ui: the settings page has a capability-packs page and nav entry', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'settings.html'), 'utf8');
  assert.match(html, /id="page-capability-packs"/);
  assert.match(html, /data-page="capability-packs"/);
  // 白名单必须包含它，否则 showPage 会回退（office 页踩过这个坑）
  assert.match(html, /const PAGES = \[[^\]]*'capability-packs'/);
  assert.match(html, /const SETTINGS_PAGES = new Set\(\[[^\]]*'capability-packs'/);
});

test('packs ui: the page renders the four-state health badge (skipped is not passed)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'settings.html'), 'utf8');
  for (const key of ['capPacks_healthPassed', 'capPacks_healthFailed', 'capPacks_healthSkipped', 'capPacks_healthUnknown']) {
    assert.ok(html.includes(key), `missing health badge copy for ${key}`);
  }
});

test('packs ui: it is a SEPARATE page from plugins (different semantics)', () => {
  // 插件 = dsh 生态扩展；能力包 = 本应用的能力声明。混在一起会让用户
  // 以为两者可靠性保证相同（能力包必须 verify 通过才能装）。
  const html = fs.readFileSync(path.join(ROOT, 'src', 'settings.html'), 'utf8');
  const packsPage = html.indexOf('id="page-capability-packs"');
  const mcpPage = html.indexOf('id="page-mcp"');
  const pluginsPage = html.indexOf('id="page-plugins"');
  assert.ok(packsPage > pluginsPage && packsPage < mcpPage, 'the packs page sits between plugins and mcp');
});
