// test/office-packs-ipc.test.js — Issue #24 阶段 2：office:settings 的 pack actions。
//
// 第一性原理：为什么这部分必须单独测
//
//   阶段 1 测的是 character-pack-manager 的**不变量**（纯逻辑，安装器 mock）。
//   但那些不变量在真正接线时可能被三处破坏，每处都不在阶段 1 的视野里：
//
//     1. **payload 白名单**：office:* 是冻结集合，payload 走严格校验。
//        漏写一个 action → 用户操作直接 PAYLOAD_INVALID，而 manager 测试全绿。
//     2. **依赖注入**：office-module 是 pure-Node 内核，禁止 fs。
//        packManager 必须由 registerOfficeIpc 注入，而不是模块自己 require。
//     3. **通道冻结**：不新增 office:* 通道（复用 action 判别式）。
//        IPCE 契约测试会抓这个，但这里也钉一次，因为改错成本高。
//
//   这三条都属于"接错线但逻辑对"，是最典型的集成缺陷。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const officeModule = require('../src/office/office-module.js');
const { createOfficeModule } = officeModule;

const ROOT = path.join(__dirname, '..');

// --------------------------------------------------------------- helpers

function fakeOfficeModule() {
  // 最小 office module：只看 IPC 层，不需要真跑仿真。
  return createOfficeModule({ seed: 'packs-ipc' });
}

/** 假 packManager：记录调用，返回可预测结果。 */
function fakePackManager() {
  const calls = [];
  return {
    calls,
    listPacks: () => {
      calls.push(['listPacks']);
      return [
        { packId: 'deepseek-default', version: null, builtin: true, installPath: '/b', active: true },
        { packId: 'my-pack', version: '1.0.0', builtin: false, installPath: '/p/1', active: false },
      ];
    },
    beginImport: (arg) => {
      calls.push(['beginImport', arg]);
      return { ok: true, importId: 'imp-1', packId: 'my-pack', version: '1.0.0' };
    },
    commitImport: (arg) => { calls.push(['commitImport', arg]); return { ok: true, packId: 'my-pack', activated: true }; },
    cancelImport: (arg) => { calls.push(['cancelImport', arg]); return { ok: true, cancelled: true }; },
    selectPack: (arg) => { calls.push(['selectPack', arg]); return { ok: true, packId: arg }; },
    uninstallPack: (arg) => { calls.push(['uninstallPack', arg]); return { ok: true, packId: arg }; },
  };
}

function makeHandles({ packManager = null } = {}) {
  const handles = new Map();
  const module = fakeOfficeModule();
  officeModule.registerOfficeIpc({
    ipcMain: { handle: (channel, handler) => handles.set(channel, handler) },
    module,
    packManager,
  });
  return { handles, module };
}

const invoke = (handles, payload) => handles.get('office:settings')({}, payload);

// ------------------------------------------------- payload 白名单校验

test('packs ipc: packsList payload validates', () => {
  const v = officeModule.validateOfficeIpcPayload('office:settings', { action: 'packsList' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.value.action, 'packsList');
});

test('packs ipc: packImportFolder requires a non-empty bounded folderPath', () => {
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportFolder' }).ok, false);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportFolder', folderPath: '' }).ok, false);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportFolder', folderPath: 123 }).ok, false);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportFolder', folderPath: 'x'.repeat(5000) }).ok, false,
    'a path longer than 4096 must be rejected before it reaches the manager');
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportFolder', folderPath: '/tmp/p' }).ok, true);
});

test('packs ipc: packImportZip requires a bounded base64 string', () => {
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportZip' }).ok, false);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportZip', zipBase64: '' }).ok, false);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportZip', zipBase64: {} }).ok, false);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'packImportZip', zipBase64: 'UEsDBA==' }).ok, true);
});

test('packs ipc: an EXTRA unexpected key is rejected (allowlist, not denylist)', () => {
  // 这是关键：校验必须是"只允许这些 key"，而不是"禁止某些 key"。
  const v = officeModule.validateOfficeIpcPayload('office:settings', {
    action: 'packImportFolder', folderPath: '/tmp/p', somethingElse: 'x',
  });
  assert.strictEqual(v.ok, false, 'unknown keys must not slip through');
});

test('packs ipc: packId-bearing actions require a bounded string', () => {
  for (const action of ['packSelect', 'packUninstall']) {
    assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action }).ok, false);
    assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action, packId: '' }).ok, false);
    assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action, packId: 'a'.repeat(200) }).ok, false);
    assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action, packId: 'my-pack' }).ok, true);
  }
});

test('packs ipc: the existing get/set validation is untouched', () => {
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'get' }).ok, true);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'set', settings: { privacyMode: 'full' } }).ok, true);
  assert.strictEqual(officeModule.validateOfficeIpcPayload('office:settings', { action: 'set', settings: { bogusKey: 1 } }).ok, false);
});

// ------------------------------------------------------- 分发与注入

test('packs ipc: packsList reaches the injected manager', async () => {
  const pm = fakePackManager();
  const { handles } = makeHandles({ packManager: pm });
  const r = await invoke(handles, { action: 'packsList' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.packs.length, 2);
  assert.deepStrictEqual(pm.calls[0], ['listPacks']);
});

test('packs ipc: folder import forwards the path unchanged', async () => {
  const pm = fakePackManager();
  const { handles } = makeHandles({ packManager: pm });
  const r = await invoke(handles, { action: 'packImportFolder', folderPath: '/tmp/my-pack' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(pm.calls[0], ['beginImport', { folderPath: '/tmp/my-pack' }]);
});

test('packs ipc: zip import decodes base64 into a Buffer before the manager sees it', async () => {
  // 传输编码的转换必须发生在 IPC 层：manager 不该知道 base64 的存在。
  const pm = fakePackManager();
  const { handles } = makeHandles({ packManager: pm });
  const payload = Buffer.from('PK\x03\x04fake-zip');
  await invoke(handles, { action: 'packImportZip', zipBase64: payload.toString('base64') });
  const [, arg] = pm.calls[0];
  assert.ok(Buffer.isBuffer(arg.zipBuffer), 'the manager receives a Buffer, not a base64 string');
  assert.deepStrictEqual(arg.zipBuffer, payload);
});

test('packs ipc: malformed base64 does not throw across the boundary', async () => {
  const pm = fakePackManager();
  const { handles } = makeHandles({ packManager: pm });
  // Buffer.from(..., 'base64') 对垃圾输入不抛错（它尽力解码），
  // 关键是这一层不能把异常漏给渲染进程。
  const r = await invoke(handles, { action: 'packImportZip', zipBase64: '!!!not base64!!!' });
  assert.ok(r && typeof r === 'object');
});

test('packs ipc: commit/cancel/select/uninstall all reach the manager', async () => {
  const pm = fakePackManager();
  const { handles } = makeHandles({ packManager: pm });
  await invoke(handles, { action: 'packCommitImport', importId: 'imp-1' });
  await invoke(handles, { action: 'packCancelImport', importId: 'imp-2' });
  await invoke(handles, { action: 'packSelect', packId: 'my-pack' });
  await invoke(handles, { action: 'packUninstall', packId: 'my-pack' });
  assert.deepStrictEqual(pm.calls.map(([m]) => m),
    ['commitImport', 'cancelImport', 'selectPack', 'uninstallPack']);
});

test('packs ipc: without an injected manager the actions report UNAVAILABLE (do not fake success)', async () => {
  // 诚实降级：装不了就说装不了，不能返回 ok:true 让 UI 以为成功。
  const { handles } = makeHandles({ packManager: null });
  for (const payload of [{ action: 'packsList' }, { action: 'packSelect', packId: 'x' }]) {
    const r = await invoke(handles, payload);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'OFFICE_PACKS_UNAVAILABLE');
  }
});

// ------------------------------------------------------- 架构约束

test('packs ipc: NO new office:* channel was added (action discriminator only)', () => {
  // Issue #24 设计约束：「不新增裸通道」
  const channels = officeModule.registerOfficeIpc;
  const src = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8');
  const frozenList = src.slice(src.indexOf('const OFFICE_IPC_CHANNELS'), src.indexOf(']);', src.indexOf('const OFFICE_IPC_CHANNELS')));
  assert.ok(!/pack/i.test(frozenList), 'the frozen channel set must not grow for character packs');
  for (const ch of ['office:packs', 'office:pack-import', 'office:character-pack']) {
    assert.ok(!frozenList.includes(ch), `${ch} must not exist — packs ride on office:settings actions`);
  }
});

test('packs ipc: pack file IO does NOT spread into office-module (injection boundary)', () => {
  // 澄清：office-module **本来就有** fs —— 它读 layout fixture（:499）和
  // 已装状态文件（:4755）。所以"office-module 禁止 fs"这个断言前提是错的。
  //
  // 真正要守的边界是：**角色包的写盘/解压/校验不扩散到这个文件**。
  // 那 442 行安全实现（ZIP 遍历、压缩炸弹、CRC）必须留在安装器里，
  // 经由注入的 packManager 调用——而不是在这里再长一份。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const forbidden of ['rmSync', 'mkdtemp', 'createCharacterPackInstaller', 'readZipEntries', 'extractZip']) {
    assert.ok(!code.includes(forbidden), `${forbidden} must stay in the installer/manager, not office-module`);
  }
  // 它只应通过注入的 packManager 使用角色包能力
  assert.match(code, /packManager/, 'packs are reached through the injected manager');
});

test('packs ipc: main.js wires the manager into registerOfficeIpc', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(src, /registerOfficeIpc\(\{[^}]*packManager: characterPackManager/,
    'the manager must be injected at the composition root');
  assert.match(src, /createOfficeCharacterPackManager\(\)/);
});

test('packs ipc: the install root lives under userData, NOT resources (writable + survives upgrade)', () => {
  // 这是 Issue #24 最核心的架构约束：往 resources 写会在打包后失败，
  // 且升级应用时连带丢包。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const fnStart = src.indexOf('function createOfficeCharacterPackManager()');
  assert.ok(fnStart !== -1);
  const fnBody = src.slice(fnStart, fnStart + 2000);
  assert.match(fnBody, /\('userData'\), 'characters'/, 'installed packs live in userData');
  assert.match(fnBody, /officeCharactersRoot\(\), 'deepseek-default'/, 'the builtin stays in resources');
  assert.doesNotMatch(fnBody, /packsRoot = .*officeCharactersRoot/,
    'the writable root must never be the read-only resources dir');
});
