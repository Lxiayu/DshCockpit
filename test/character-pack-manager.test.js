// test/character-pack-manager.test.js — Issue #24：角色包导入/切换的用户入口。
//
// 第一性原理：为什么这一层需要独立测试，而不是"测安装器就够了"
//
//   安装器的 18 项测试证明的是**它的语义正确**（ZIP 安全、原子 rename、CRC）。
//   但本 Issue 的真正难点不是安装，而是**两个布局之间的翻译**：
//
//   | 项目 | 现有渲染链 | 安装器 |
//   |---|---|---|
//   | packsRoot | resources/characters（打包后**只读**） | 需要可写目录 |
//   | 布局 | <root>/<packId>/manifest.json | <root>/<packId>/versions/<ver>/ |
//   | 激活 | settings.characterPackId | root/active.json |
//
//   接线层要保证的是一组**不变量**，这些不变量在任何一层单独测都测不到：
//     1. 安装失败 → 现有可用包不受影响
//     2. 激活失败 → settings 不被写入（不出现"意图指向不存在的包"）
//     3. 卸载当前包 → 自动回落内置，永不空场景
//     4. 意图指向不存在的包 → 回退内置并**如实上报**（不是静默）
//     5. 错误信息对用户可操作（不是透传开发者的 message）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  BUILTIN_PACK_ID,
  ERROR_GUIDANCE,
  explainError,
  createCharacterPackManager,
} = require('../src/office/character-pack-manager.js');

// --------------------------------------------------------------- test doubles

/** 假安装器：只实现本层用到的 5 个方法，语义与真实安装器一致。 */
function fakeInstaller(over = {}) {
  const state = {
    installed: [],          // [{packId, version, installPath}]
    active: null,           // {packId, version} | null
    imports: new Map(),     // importId -> {packId, version, state}
    counter: 0,
    calls: [],
  };
  const api = {
    importFromFolder(sourceDir) {
      state.calls.push(['importFromFolder', sourceDir]);
      if (over.importFolderThrows) throw over.importFolderThrows;
      state.counter += 1;
      const id = `import-${state.counter}`;
      state.imports.set(id, { packId: over.packId || 'my-pack', version: over.version || '1.0.0', state: 'discovered' });
      return { importId: id, state: 'discovered' };
    },
    importFromZip(zipBuffer) {
      state.calls.push(['importFromZip', zipBuffer]);
      if (over.importZipThrows) throw over.importZipThrows;
      state.counter += 1;
      const id = `import-${state.counter}`;
      state.imports.set(id, { packId: over.packId || 'my-pack', version: over.version || '1.0.0', state: 'discovered' });
      return { importId: id, state: 'discovered' };
    },
    validateImport(id) {
      state.calls.push(['validateImport', id]);
      if (over.validateThrows) throw over.validateThrows;
      const rec = state.imports.get(id);
      if (!rec) throw Object.assign(new Error(`unknown import: ${id}`), { code: 'IMPORT_NOT_FOUND' });
      rec.state = 'validated';
      return { importId: id, state: 'validated', packId: rec.packId, version: rec.version };
    },
    installImport(id) {
      state.calls.push(['installImport', id]);
      if (over.installThrows) throw over.installThrows;
      const rec = state.imports.get(id);
      if (!rec) throw Object.assign(new Error(`unknown import: ${id}`), { code: 'IMPORT_NOT_FOUND' });
      rec.state = 'installed';
      const installPath = `${over.packsRoot || '/packs'}/${rec.packId}/versions/${rec.version}`;
      state.installed.push({ packId: rec.packId, version: rec.version, installPath });
      return { importId: id, state: 'installed', packId: rec.packId, version: rec.version, installPath };
    },
    activate(packId, version) {
      state.calls.push(['activate', packId, version]);
      if (over.activateThrows) throw over.activateThrows;
      const found = state.installed.find((e) => e.packId === packId && e.version === version);
      if (!found) throw Object.assign(new Error(`cannot activate ${packId}@${version}: not installed`), { code: 'PACK_ASSET_MISSING' });
      state.active = { packId, version };
      return { packId, version, installPath: found.installPath, state: 'active' };
    },
    listInstalled() {
      if (over.listThrows) throw over.listThrows;
      return state.installed.map((e) => ({ ...e }));
    },
    getActive() {
      return state.active;
    },
  };
  return { installer: api, state };
}

/** 记录 onActivated 的调用（模拟渲染层重载）。 */
function makeManager(over = {}) {
  const { installer, state } = fakeInstaller(over);
  const selected = { value: over.selected === undefined ? null : over.selected };
  const activated = [];
  const mgr = createCharacterPackManager({
    installer,
    builtinPackPath: '/builtin/deepseek-default',
    readSelected: () => selected.value,
    writeSelected: (v) => { selected.value = v; },
    onActivated: (a) => activated.push(a),
    log: () => {},
  });
  return { mgr, installerState: state, selected, activated };
}

// =============================================================== 列表

test('pack manager: the builtin pack is ALWAYS listed (no empty scenario, ever)', () => {
  const { mgr } = makeManager();
  const packs = mgr.listPacks();
  const builtin = packs.find((p) => p.packId === BUILTIN_PACK_ID);
  assert.ok(builtin, 'the builtin pack must always be present — it is the fallback');
  assert.strictEqual(builtin.builtin, true);
  assert.strictEqual(builtin.active, true, 'with no selection the builtin is active');
});

test('pack manager: installed packs are listed alongside the builtin', () => {
  const { mgr, installerState } = makeManager();
  installerState.installed.push({ packId: 'my-pack', version: '1.0.0', installPath: '/packs/my-pack/versions/1.0.0' });
  const packs = mgr.listPacks();
  assert.strictEqual(packs.length, 2);
  assert.ok(packs.some((p) => p.packId === 'my-pack' && p.builtin === false));
});

test('pack manager: multiple versions of one pack surface only the newest', () => {
  const { mgr, installerState } = makeManager();
  installerState.installed.push({ packId: 'my-pack', version: '1.0.0', installPath: '/p/1.0.0' });
  installerState.installed.push({ packId: 'my-pack', version: '2.0.0', installPath: '/p/2.0.0' });
  const mine = mgr.listPacks().filter((p) => p.packId === 'my-pack');
  assert.strictEqual(mine.length, 1, 'a version picker is not part of this issue');
  assert.strictEqual(mine[0].version, '2.0.0');
});

test('pack manager: the active flag follows user INTENT when that pack is usable', () => {
  const { mgr, installerState } = makeManager({ selected: 'my-pack' });
  installerState.installed.push({ packId: 'my-pack', version: '1.0.0', installPath: '/p/1' });
  const active = mgr.listPacks().filter((p) => p.active);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].packId, 'my-pack');
});

test('pack manager: intent pointing at a MISSING pack falls back to builtin (and says so)', () => {
  // 手动删目录 / 卸载失败 / 从别的机器同步了设置 —— 都会造成这种情况。
  const { mgr } = makeManager({ selected: 'ghost-pack' });
  const active = mgr.listPacks().filter((p) => p.active);
  assert.strictEqual(active[0].packId, BUILTIN_PACK_ID, 'a dangling intent must not blank the office');
  const resolved = mgr.resolveActive();
  assert.strictEqual(resolved.kind, 'builtin');
  assert.strictEqual(resolved.degradedCode, 'OFFICE_PACK_SELECTION_MISSING',
    'the degradation must be reported, not silent');
});

// =============================================================== 导入流程

test('pack manager: importing a folder validates and reports what will be installed', () => {
  const { mgr } = makeManager();
  const r = mgr.beginImport({ folderPath: '/tmp/pack' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.packId, 'my-pack');
  assert.strictEqual(r.version, '1.0.0');
});

test('pack manager: importing a zip goes through importFromZip (not the folder path)', () => {
  const { mgr, installerState } = makeManager();
  mgr.beginImport({ zipBuffer: Buffer.from('PK') });
  assert.ok(installerState.calls.some(([m]) => m === 'importFromZip'));
  assert.ok(!installerState.calls.some(([m]) => m === 'importFromFolder'));
});

test('pack manager: a missing source is rejected with actionable guidance', () => {
  const { mgr } = makeManager();
  const r = mgr.beginImport({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NO_SOURCE');
  assert.ok(r.error.hint.length > 0);
});

test('pack manager: a validation failure surfaces the SPECIFIC reason, not just "failed"', () => {
  // Issue #24 验收标准：「校验失败的每一条原因都能看到」
  const { mgr } = makeManager({
    validateThrows: Object.assign(new Error('../x: path traversal'), { code: 'PACK_UNSAFE_ARCHIVE' }),
  });
  const r = mgr.beginImport({ folderPath: '/tmp/evil' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'PACK_UNSAFE_ARCHIVE');
  assert.match(r.error.title, /不安全/);
  assert.match(r.error.hint, /可信来源/, 'the hint must tell the user what to DO');
  assert.match(r.error.detail, /path traversal/, 'technical detail is preserved for feedback');
});

test('pack manager: commit installs and activates, then records user intent', () => {
  const { mgr, selected, activated } = makeManager();
  const began = mgr.beginImport({ folderPath: '/tmp/pack' });
  const done = mgr.commitImport({ importId: began.importId });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.activated, true);
  assert.strictEqual(selected.value, 'my-pack', 'intent is persisted so it survives a restart');
  assert.strictEqual(activated.length, 1, 'the renderer is told to reload');
});

test('pack manager: commit with activate=false installs but does NOT switch', () => {
  const { mgr, selected } = makeManager();
  const began = mgr.beginImport({ folderPath: '/tmp/pack' });
  const done = mgr.commitImport({ importId: began.importId, activate: false });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.activated, false);
  assert.strictEqual(selected.value, null, 'the current pack stays selected');
});

test('pack manager: an INSTALL failure leaves the previous pack untouched', () => {
  // Issue #24 验收标准：「安装失败必须保留原有可用包」
  const { mgr, selected, installerState } = makeManager({
    installThrows: Object.assign(new Error('disk full'), { code: 'PACK_LOAD_FAILED' }),
  });
  installerState.installed.push({ packId: 'old-pack', version: '1.0.0', installPath: '/p/old' });
  selected.value = 'old-pack';

  const began = mgr.beginImport({ folderPath: '/tmp/pack' });
  const done = mgr.commitImport({ importId: began.importId });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(selected.value, 'old-pack', 'the working pack must survive a failed install');
});

test('pack manager: an ACTIVATE failure does NOT write user intent', () => {
  // 否则会出现"设置说 A，磁盘上没有 A"——重启后回退，用户困惑。
  const { mgr, selected } = makeManager({
    activateThrows: Object.assign(new Error('manifest gone'), { code: 'PACK_ASSET_MISSING' }),
  });
  const began = mgr.beginImport({ folderPath: '/tmp/pack' });
  const done = mgr.commitImport({ importId: began.importId });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(selected.value, null, 'intent must not point at a pack that failed to activate');
  assert.ok(done.installed, 'but the report says the files ARE installed (user can retry selecting)');
});

test('pack manager: committing an unknown import id is rejected', () => {
  const { mgr } = makeManager();
  const r = mgr.commitImport({ importId: 'nope' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'IMPORT_NOT_FOUND');
});

test('pack manager: a cancelled import cannot be committed', () => {
  const { mgr } = makeManager();
  const began = mgr.beginImport({ folderPath: '/tmp/pack' });
  mgr.cancelImport(began.importId);
  const r = mgr.commitImport({ importId: began.importId });
  assert.strictEqual(r.ok, false);
});

// =============================================================== 切换/卸载

test('pack manager: switching to the builtin clears the intent (null, not a string)', () => {
  const { mgr, selected, installerState } = makeManager({ selected: 'my-pack' });
  installerState.installed.push({ packId: 'my-pack', version: '1.0.0', installPath: '/p/1' });
  const r = mgr.selectPack(BUILTIN_PACK_ID);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(selected.value, null, 'null expresses "no custom choice" more accurately than a string');
});

test('pack manager: switching to an uninstalled pack is rejected', () => {
  const { mgr } = makeManager();
  const r = mgr.selectPack('ghost');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'PACK_NOT_INSTALLED');
});

test('pack manager: switching to an installed pack activates it', () => {
  const { mgr, selected, installerState, activated } = makeManager();
  installerState.installed.push({ packId: 'my-pack', version: '1.0.0', installPath: '/p/1' });
  const r = mgr.selectPack('my-pack');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(selected.value, 'my-pack');
  assert.strictEqual(activated.length, 1);
});

test('pack manager: uninstalling the ACTIVE pack falls back to builtin automatically', () => {
  // 「卸载后回落内置，不出现空场景」——这是渲染层不会黑屏的保证。
  const { mgr, selected, installerState, activated } = makeManager({ selected: 'my-pack' });
  installerState.installed.push({ packId: 'my-pack', version: '1.0.0', installPath: '/p/1' });
  const r = mgr.uninstallPack('my-pack');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fellBackToBuiltin, true);
  assert.strictEqual(selected.value, null);
  assert.strictEqual(activated.at(-1).packId, BUILTIN_PACK_ID);
});

test('pack manager: uninstalling a NON-active pack does not change the selection', () => {
  const { mgr, selected, installerState } = makeManager({ selected: 'keep-me' });
  installerState.installed.push({ packId: 'keep-me', version: '1.0.0', installPath: '/p/keep' });
  installerState.installed.push({ packId: 'other', version: '1.0.0', installPath: '/p/other' });
  const r = mgr.uninstallPack('other');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fellBackToBuiltin, false);
  assert.strictEqual(selected.value, 'keep-me');
});

test('pack manager: the builtin pack CANNOT be uninstalled (it is the fallback)', () => {
  const { mgr } = makeManager();
  const r = mgr.uninstallPack(BUILTIN_PACK_ID);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'PACK_BUILTIN_PROTECTED');
});

// =============================================================== 解析

test('pack manager: resolveActive returns the builtin when nothing is selected', () => {
  const { mgr } = makeManager();
  const r = mgr.resolveActive();
  assert.strictEqual(r.kind, 'builtin');
  assert.strictEqual(r.packId, BUILTIN_PACK_ID);
  assert.strictEqual(r.installPath, '/builtin/deepseek-default');
});

test('pack manager: resolveActive follows a usable selection', () => {
  const { mgr, installerState } = makeManager({ selected: 'my-pack' });
  installerState.installed.push({ packId: 'my-pack', version: '1.1.0', installPath: '/p/1.1.0' });
  const r = mgr.resolveActive();
  assert.strictEqual(r.kind, 'pack');
  assert.strictEqual(r.installPath, '/p/1.1.0', 'the resolved path is the one the renderer can load');
});

test('pack manager: resolveActive NEVER returns an empty result', () => {
  // 空场景 = 办公室黑屏。这是必须守住的不变量。
  for (const selected of [null, '', 'ghost', BUILTIN_PACK_ID]) {
    const { mgr } = makeManager({ selected });
    const r = mgr.resolveActive();
    assert.ok(r && typeof r.installPath === 'string' && r.installPath.length > 0,
      `resolveActive must always yield a path (selected=${selected})`);
  }
});

// ========================================================= 错误可操作性

test('pack manager: every known error code has a user-facing title AND a hint', () => {
  for (const [code, g] of Object.entries(ERROR_GUIDANCE)) {
    assert.ok(g.title && g.title.length > 0, `${code} needs a title`);
    assert.ok(g.hint && g.hint.length > 10, `${code} needs an actionable hint (not just a restatement)`);
  }
});

test('pack manager: an unknown error code degrades honestly (does not pretend to know)', () => {
  const e = explainError(Object.assign(new Error('weird internal thing'), { code: 'SOMETHING_NEW' }));
  assert.strictEqual(e.code, 'SOMETHING_NEW');
  assert.match(e.hint, /未识别/, 'it must say it does not know, not invent a cause');
  assert.match(e.detail, /weird internal thing/);
});

test('pack manager: security-related codes are explained as "do not trust this pack"', () => {
  // 这些码对应真实的攻击面（遍历/炸弹/CRC），提示必须引导用户放弃该包，
  // 而不是"重试一下"。
  for (const code of ['PACK_UNSAFE_ARCHIVE', 'PACK_TOO_LARGE', 'PACK_CRC_MISMATCH']) {
    const g = ERROR_GUIDANCE[code];
    assert.ok(g, `${code} must be documented`);
    assert.match(g.hint, /重新获取|可信来源|损坏/, `${code} must tell the user the pack itself is suspect`);
  }
});

// ==================================================== 安装器零改动（验收）

test('pack manager: the installer is consumed as-is (no monkey-patching of its semantics)', () => {
  // Issue #24 验收标准：「安装器本身零改动」
  const fs = require('node:fs');
  const path = require('node:path');
  const mgrSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'character-pack-manager.js'), 'utf8');
  const installerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'runtime', 'character-pack-installer.js'), 'utf8');

  // 本层不得 require 安装器的内部函数（只通过工厂返回值使用）
  // 用字符串包含检查（正则转义在这里只是噪音）
  const reachesInternals = mgrSrc.includes('require(\'./runtime/character-pack-installer')
    || mgrSrc.includes('require("./runtime/character-pack-installer');
  assert.strictEqual(reachesInternals, false,
    'the manager must receive the installer via injection, not reach into its internals');

  // 安装器的导出面保持不变（仍只有工厂 + LIMITS）
  assert.match(installerSrc, /module\.exports = \{ createCharacterPackInstaller, LIMITS \}/);
});

test('pack manager: it refuses to work without the required injections (fail fast)', () => {
  assert.throws(() => createCharacterPackManager({}), /requires readSelected/);
  assert.throws(() => createCharacterPackManager({ readSelected: () => null }), /requires writeSelected/);
  assert.throws(() => createCharacterPackManager({
    readSelected: () => null, writeSelected: () => {},
  }), /requires the pack installer/);
});
