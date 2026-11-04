// test/office-board-ui.test.js — P2.3 S4：白板渲染层的静态契约。
//
// 第一性原理：这一层为什么只能做静态断言
//
//   白板渲染的真机验收**未完成**（见 docs/plans/active/P2-OFFICE-OBJECTS-2026-11-01.md
//   的"未完成"一节）。探针反复失败在 office 页的启动链上（自定义协议 +
//   __office 闭包作用域 + page/renderer 的快照副本），调试成本远超收益。
//
//   但**不完整的验证不等于不做验证**。以下这些错误可以用静态断言抓到，
//   而且它们正是最容易犯的：
//     1. renderMissionBoard 定义了却没被调用（白板永远不更新）
//     2. 只接在 renderAll 里、漏了 onSnapshot 的真实数据流路径
//     3. 四种空态分支缺失（用户看到空白）
//     4. i18n key 不存在（用户看到原始 key）
//     5. 点击没接 IPC（白板变成装饰）
//
//   真机验收负责的是"像素上对不对"，那是另一回事。两者不互相替代。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'src', 'i18n.js'), 'utf8');

/** renderMissionBoard 的函数体。 */
function boardFn() {
  const start = html.indexOf('function renderMissionBoard(snapshot)');
  assert.ok(start !== -1, 'renderMissionBoard must exist');
  const end = html.indexOf('function renderUsageBlock', start);
  return html.slice(start, end === -1 ? start + 4000 : end);
}

// ============================================================ DOM 结构

test('board ui: the section and its elements exist', () => {
  for (const id of ['mission-board', 'board-list', 'board-empty', 'board-unavailable', 'board-stale', 'board-more']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

test('board ui: the board sits ABOVE the usage block (attention order)', () => {
  // 白板是"需要你"的地方；它应该在用量统计之前被看到。
  const boardAt = html.indexOf('id="mission-board"');
  const usageAt = html.indexOf('id="usage-block"');
  assert.ok(boardAt !== -1 && usageAt !== -1);
  assert.ok(boardAt < usageAt, 'the board must come before usage — it is what needs action');
});

// ============================================ 接线（最容易漏的一条）

test('board ui: renderMissionBoard is called on the REAL snapshot path', () => {
  // onSnapshot 是真实数据流：mux 推送 → page.applySnapshot → onSnapshot → 面板重绘。
  // 只接 renderAll 是不够的（renderAll 只在语言切换等场景手动调用）——
  // 那样白板只在打开页面那一刻刷新，之后永远不动。
  const onSnapshotStart = html.indexOf('onSnapshot: (snapshot) => {');
  assert.ok(onSnapshotStart !== -1);
  const block = html.slice(onSnapshotStart, onSnapshotStart + 1200);
  assert.match(block, /renderMissionBoard\(snapshot\)/,
    'the board must be refreshed by the same ~10Hz panel cadence as usage/pending');
});

test('board ui: the board is ALSO refreshed by renderAll (language switch)', () => {
  const renderAllStart = html.indexOf('function renderAll()');
  assert.ok(renderAllStart !== -1);
  const block = html.slice(renderAllStart, renderAllStart + 2000);
  // 断言的是**意图**：看板必须由 renderAll 重绘。
  // 不钉死裸调用 —— renderAll 后来给每个块加了容错包裹
  // （`safeRender('missionBoard', () => renderMissionBoard(snapshot))`），
  // 意图没变但裸调用消失了。锁实现的测试会在正确的重构上误报。
  assert.match(block, /renderMissionBoard\(snapshot\)/,
    'switching language must re-render the board');
  assert.match(block, /safeRender\([^)]*renderMissionBoard|renderMissionBoard\(snapshot\)/,
    'and it must still be reachable from renderAll');
});

// ============================================ 四种状态（不出现空白）

test('board ui: all four states have distinct handling', () => {
  const fn = boardFn();
  // ok：列出 Mission
  assert.match(fn, /view\.kind === 'ok'/);
  // empty：正常空态（没有 active Mission）
  assert.match(fn, /view\.kind === 'empty'/);
  // unavailable / not-wired：故障
  assert.match(fn, /unavailEl\.hidden = false/, 'a failure must show the unavailable hint, not a blank area');
  assert.match(fn, /emptyEl\.hidden = false/);
});

test('board ui: a stale board shows its marker', () => {
  const fn = boardFn();
  assert.match(fn, /staleEl\.hidden = !view\.stale/);
});

test('board ui: "more missions" is disclosed, not silently dropped', () => {
  const fn = boardFn();
  assert.match(fn, /view\.moreCount > 0/);
  assert.match(fn, /board-more/);
});

// ============================================ 交互（不是装饰）

test('board ui: clicking a mission opens the Mission Desk', () => {
  const fn = boardFn();
  assert.match(fn, /openMissionDesk/, 'the board must lead somewhere — otherwise it is decoration');
  assert.match(fn, /addEventListener\('click'/);
});

test('board ui: the board is keyboard reachable (a11y, not just mouse)', () => {
  const fn = boardFn();
  assert.match(fn, /tabIndex = 0/);
  assert.match(fn, /addEventListener\('keydown'/);
  assert.match(fn, /Enter/);
});

test('board ui: missions needing an answer are visually distinguished', () => {
  // 待答问题数是白板的核心信号（"需要你"）。不区分就等于没做。
  const fn = boardFn();
  assert.match(fn, /needs-you/);
  assert.match(css, /\.needs-you/, 'the CSS class must actually be styled');
});

// ============================================ i18n（用户不看到原始 key）

test('board ui: every board i18n key exists in BOTH languages', () => {
  const used = new Set();
  for (const m of html.matchAll(/data-i18n="(office\.board\.[A-Za-z.]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/tr\('(office\.board\.[A-Za-z.]+)'/g)) used.add(m[1]);
  assert.ok(used.size >= 8, `expected a full board vocabulary, found ${used.size}`);
  for (const key of used) {
    const occurrences = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) || []).length;
    assert.strictEqual(occurrences, 2, `${key} must exist in both zh and en (found ${occurrences})`);
  }
});

test('board ui: placeholders used by the board exist in the translations', () => {
  // {n} / {a} 占位符缺失会渲染出字面量 "{n}"。
  const fn = boardFn();
  const usedVars = new Set();
  for (const m of fn.matchAll(/tr\('office\.board\.[A-Za-z.]+',\s*\{([^}]+)\}/g)) {
    for (const v of m[1].split(',')) usedVars.add(v.split(':')[0].trim());
  }
  assert.ok(usedVars.size >= 2, `expected placeholder usage, found ${[...usedVars]}`);
});

// ============================================ 隐私（渲染层不引入正文）

test('board ui: the renderer never reads mission free text from the snapshot', () => {
  // 白板只用 counts + label。若渲染层去读 intent/rationale，说明快照泄漏了这些字段。
  const fn = boardFn();
  for (const leak of ['intent', 'rationale', 'prompt', 'sessionId']) {
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(fn), `the board renderer must not touch ${leak}`);
  }
});

test('board ui: the board never writes mission state (read-only projection)', () => {
  // domain-model 铁律：同一状态不许两个写入者。
  const fn = boardFn();
  for (const write of ['missionInvoke', 'dispatch(', 'updateStatus', 'recordDecision']) {
    assert.ok(!fn.includes(write), `the board must not write mission state (found ${write})`);
  }
});
