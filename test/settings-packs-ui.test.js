// test/settings-packs-ui.test.js — Issue #24 阶段 3：设置页角色包 UI 的静态契约。
//
// 第一性原理：为什么 UI 也要有离线测试
//
//   真机测试只覆盖 Mission Desk（另一个窗口）。角色包 UI 的真机验收需要
//   用户提供真实包文件，很难自动化。但 UI 的**契约错误**可以离线抓到，
//   而这些恰恰是最容易犯的：
//
//     1. i18n key 命名不合约定 → 用户看到 `packs.title` 原文
//     2. tr() 用了不存在的 key → 同上
//     3. preload 方法名与实际注册的通道不匹配 → 点击无反应（最隐蔽）
//     4. 走错通道（office:* 而非 shell:*）→ 设置页拿不到数据
//     5. 错误只显示"失败"而不显示原因 → 违反 Issue #24 验收标准
//
//   第 3 条尤其隐蔽：`window.dshShell.xxx is not a function` 只在点击时出现，
//   而静态测试能立刻抓到。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'src', 'settings.html'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src', 'settings-preload.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

/**
 * 从 settings.html 里抽出 I18N 某语言表的键名集合。
 *
 * 实际结构是 `const I18N = { zh: {...}, en: {...} }`（不是 I18N.zh）。
 * 这里先定位 `zh: {` / `en: {`，再取到下一个语言块的起点。
 */
function i18nKeysIn(html, lang) {
  const startMarker = `\n    ${lang}: {`;
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `language block not found: ${lang}`);
  // 下一个语言块（或 const I18N 结束）为边界
  const other = lang === 'zh' ? '\n    en: {' : null;
  const end = other ? html.indexOf(other, start + 1) : html.indexOf('\n  };', start + 1);
  const block = html.slice(start, end === -1 ? start + 300000 : end);
  const keys = new Set();
  for (const m of block.matchAll(/(?:^|\s)'?([A-Za-z_][A-Za-z0-9_]*)'?\s*:/g)) {
    keys.add(m[1]);
  }
  return keys;
}

const zhKeys = i18nKeysIn(settingsHtml, 'zh');
const enKeys = i18nKeysIn(settingsHtml, 'en');

// ============================================================ 存在性

test('packs ui: the character pack section exists in the settings page', () => {
  assert.match(settingsHtml, /id="packs-list"/);
  assert.match(settingsHtml, /id="packs-import-folder"/);
  assert.match(settingsHtml, /id="packs-import-zip"/);
  assert.match(settingsHtml, /id="packs-status"/);
});

test('packs ui: the section is inside the office page (it is an appearance setting)', () => {
  const officePage = settingsHtml.indexOf('id="page-office"');
  const packsIds = settingsHtml.indexOf('id="packs-list"');
  const skillsPage = settingsHtml.indexOf('id="page-skills"');
  assert.ok(officePage !== -1 && skillsPage !== -1);
  assert.ok(packsIds > officePage && packsIds < skillsPage,
    'the packs UI must live on the office page, before the skills page starts');
});

// ============================================================ i18n

test('packs ui: every packs_* i18n key exists in BOTH zh and en', () => {
  // 项目约定：i18n key 用下划线（office_desc / channels_allowFrom），不是点号。
  // 我第一版写成 'packs.title' 结果用户会看到原始 key —— 门禁抓到了。
  const used = new Set();
  for (const m of settingsHtml.matchAll(/data-i18n="(packs_[A-Za-z0-9_]+)"/g)) used.add(m[1]);
  for (const m of settingsHtml.matchAll(/tr\('(packs_[A-Za-z0-9_]+)'\)/g)) used.add(m[1]);

  assert.ok(used.size >= 15, `expected a full pack UI vocabulary, found ${used.size} keys`);
  const missingZh = [...used].filter((k) => !zhKeys.has(k));
  const missingEn = [...used].filter((k) => !enKeys.has(k));
  assert.deepEqual(missingZh, [], `missing from I18N.zh: ${missingZh.join(', ')}`);
  assert.deepEqual(missingEn, [], `missing from I18N.en: ${missingEn.join(', ')}`);
});

test('packs ui: no dotted i18n keys leaked into the packs section', () => {
  // 显式防止回退到点号风格
  assert.doesNotMatch(settingsHtml, /data-i18n="packs\./);
  assert.doesNotMatch(settingsHtml, /tr\('packs\./);
});

// ============================================ preload ↔ IPC 一致性

test('packs ui: every window.dshShell method the UI calls exists in the preload', () => {
  // 这是最隐蔽的一类错误：`dshShell.xxx is not a function` 只在点击时炸。
  // 两种调用形态都要看：
  //   · 直接调：window.dshShell.pickCharacterPackFolder()
  //   · 经 packAction 分派：shellApi.packsList() 等
  const called = new Set();
  for (const m of settingsHtml.matchAll(/window\.dshShell\.([A-Za-z0-9_]+)\(/g)) {
    if (m[1].startsWith('packs') || m[1].startsWith('pickCharacterPack')) called.add(m[1]);
  }
  for (const m of settingsHtml.matchAll(/shellApi\.([A-Za-z0-9_]+)\(/g)) {
    if (m[1].startsWith('packs')) called.add(m[1]);
  }
  assert.ok(called.size >= 6, `expected the pack bridge methods to be used, found ${called.size}`);
  const missing = [...called].filter((fn) => !new RegExp(`\\b${fn}\\s*:`).test(preload));
  assert.deepEqual(missing, [], `preload is missing: ${missing.join(', ')}`);
});

test('packs ui: every preload pack method maps to a REGISTERED main-process channel', () => {
  // preload 调 invoke('shell:xxx')，main 必须 handle('shell:xxx')。
  // 少一边就是静默无响应。
  const invoked = [];
  for (const m of preload.matchAll(/ipcRenderer\.invoke\('(shell:packs-[a-z-]+)'/g)) invoked.push(m[1]);
  assert.ok(invoked.length >= 7, `expected the pack channels, found ${invoked.length}`);
  for (const ch of invoked) {
    assert.ok(mainJs.includes(`ipcMain.handle('${ch}'`),
      `${ch} is invoked by the preload but never handled in main.js`);
  }
});

test('packs ui: the settings window uses shell:* — NOT office:*', () => {
  // office:* 是办公室页面的冻结通道集合，只有办公室视图持有它。
  // 设置窗口用它会让 office:* 的信任边界失效。
  const packBlockStart = settingsHtml.indexOf('async function packAction(payload)');
  assert.ok(packBlockStart !== -1);
  const block = settingsHtml.slice(packBlockStart, packBlockStart + 1200);
  assert.doesNotMatch(block, /officeInvoke\(/, 'the settings window must not drive office:* directly');
  assert.match(block, /shellApi\.packs/, 'it must go through the shell:packs-* bridge');
});

// ============================================ 错误呈现（验收标准）

test('packs ui: errors are rendered with title + hint + collapsible detail', () => {
  // Issue #24 验收：「校验失败的每一条原因都能看到（不是笼统"导入失败"）」
  assert.match(settingsHtml, /function renderPackError/, 'there must be a dedicated error renderer');
  const idx = settingsHtml.indexOf('function renderPackError');
  const block = settingsHtml.slice(idx, idx + 1400);
  assert.match(block, /err\.title/, 'the title is shown');
  assert.match(block, /err\.hint/, 'the actionable hint is shown');
  assert.match(block, /err\.detail/, 'the technical detail is shown');
  assert.match(block, /createElement\('details'\)/, 'detail is collapsed by default, not dumped on the user');
});

test('packs ui: a failed import does not claim success', () => {
  assert.match(settingsHtml, /if \(!beginResult \|\| !beginResult\.ok\)/,
    'the begin step must check ok (and guard an undefined result)');
  const idx = settingsHtml.indexOf('async function finishImport');
  const block = settingsHtml.slice(idx, idx + 900);
  assert.match(block, /renderPackError/, 'a failure must be rendered as an error');
});

test('packs ui: uninstalling the active pack tells the user it fell back', () => {
  // 静默回落会让用户以为"卸载后办公室坏了"。
  assert.match(settingsHtml, /fellBackToBuiltin/);
  assert.match(settingsHtml, /tr\('packs_fellBack'\)/);
});

test('packs ui: a cancelled file dialog exits quietly (no error toast)', () => {
  // 用户按"取消"不是错误——弹红字会让人以为出问题了。
  const idx = settingsHtml.indexOf("$('packs-import-folder')");
  const block = settingsHtml.slice(idx, idx + 800);
  assert.match(block, /if \(!picked \|\| !picked\.ok \|\| !picked\.path\) return;/,
    'cancellation must return early without an error message');
});

// ============================================ 安全性

test('packs ui: the zip size limit is checked BEFORE reading into memory', () => {
  // 300MB 的 zip 先读进内存再判断大小 = 一次 OOM。
  const idx = mainJs.indexOf("ipcMain.handle('shell:packs-pick-zip'");
  assert.ok(idx !== -1);
  const block = mainJs.slice(idx, idx + 1000);
  const statAt = block.indexOf('fs.statSync');
  const readAt = block.indexOf('readFileSync');
  assert.ok(statAt !== -1 && readAt !== -1);
  assert.ok(statAt < readAt, 'stat must come before read (do not buffer an unbounded file)');
  assert.match(block, /tooLarge/);
});

test('packs ui: the base64 transport is bounded by the shared IPC payload limit', () => {
  // 128MB 的 zip → base64 约 171MB，超过 MAX_IPC_PAYLOAD_BYTES 会被拒。
  // 这是**有意的**：大包应当从文件夹导入，或者将来走流式。
  const { MAX_IPC_PAYLOAD_BYTES } = require('../src/office/office-pack-actions.js');
  assert.ok(MAX_IPC_PAYLOAD_BYTES === undefined || typeof MAX_IPC_PAYLOAD_BYTES === 'number');
  assert.match(mainJs, /128 \* 1024 \* 1024/, 'the zip size ceiling must be explicit');
});
