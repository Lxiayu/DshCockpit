// test/mission-brief-sync.test.js — P1：Brief 同步进 AGENTS.md。
//
// 第一性原理：为什么这是 Brief 的**唯一**正确接入点
//
//   我最初想在"壳创建 Session 时把 Brief 塞进 system prompt"。核实代码后发现：
//     · main.js:406 `harnessView.loadURL(runtimeUrl)` —— 壳是官方 dsh web UI 的容器
//     · 用户是在**官方 UI 里**发 prompt 的，壳不接管输入面（架构铁律 5）
//     · `createSession` 只被旧 Team Runtime 调用（team-shell-transport.js:171）
//   所以"拦截注入"要么侵入官方 UI，要么重写输入路径——都违反定位。
//
//   正确接入点：dsh-agent-instructions 在**每次 Session 启动时**读
//   `<workspace>/AGENTS.md`。把 Brief 写进去就自动生效，零侵入。
//
// 这组测试的核心关切**不是功能，而是数据安全**：
//   AGENTS.md 是用户的项目说明文件，可能有大量手写内容。
//   如果同步逻辑覆盖了整个文件，就是在销毁用户数据。
//   所以每个用例都在问同一个问题："用户原来写的东西还在吗？"
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bs = require('../src/mission/brief-sync.js');

const USER_CONTENT = '# 我的项目\n\n构建: npm test\n部署: npm run deploy\n';

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bsync-'));
}

// ------------------------------------------------------- 用户数据永不丢失

test('brief-sync: a FIRST sync onto an existing AGENTS.md APPENDS (never overwrites)', () => {
  const r = bs.mergeBrief(USER_CONTENT, '# Mission Brief', {});
  assert.strictEqual(r.action, 'appended');
  assert.ok(r.content.includes('构建: npm test'), 'user content must survive verbatim');
  assert.ok(r.content.includes('部署: npm run deploy'), 'every line, not just the first');
  assert.ok(r.content.indexOf('构建: npm test') < r.content.indexOf(bs.BEGIN_MARK),
    'the auto-generated block goes AFTER the user content');
});

test('brief-sync: a REPLACEMENT only touches the marked block', () => {
  const first = bs.mergeBrief(USER_CONTENT, '第一版 Brief', {});
  const second = bs.mergeBrief(first.content, '第二版 Brief', {});
  assert.strictEqual(second.action, 'replaced');
  assert.ok(second.content.includes('第二版 Brief'));
  assert.ok(!second.content.includes('第一版 Brief'), 'the old block body is gone');
  assert.ok(second.content.includes('构建: npm test'), 'user content untouched');
});

test('brief-sync: user content added AFTER the block also survives a re-sync', () => {
  // 用户可能在 Brief 块后面继续写东西（或者手写补充）。同步不得吃掉它。
  const first = bs.mergeBrief(USER_CONTENT, 'Brief v1', {});
  const withTail = first.content + '\n## 我后来加的\n\n- 记住这条\n';
  const second = bs.mergeBrief(withTail, 'Brief v2', {});
  assert.ok(second.content.includes('我后来加的'));
  assert.ok(second.content.includes('记住这条'));
  assert.ok(second.content.includes('Brief v2'));
});

test('brief-sync: removing the block leaves the user file intact', () => {
  const synced = bs.mergeBrief(USER_CONTENT, 'Brief', {}).content;
  const removed = bs.removeBrief(synced);
  assert.strictEqual(removed.action, 'removed');
  assert.ok(!removed.content.includes(bs.BEGIN_MARK));
  assert.ok(!removed.content.includes(bs.END_MARK));
  assert.ok(removed.content.includes('构建: npm test'), 'user content survives the removal too');
});

test('brief-sync: removing from a file that was never synced is a no-op', () => {
  const r = bs.removeBrief(USER_CONTENT);
  assert.strictEqual(r.action, 'unchanged');
  assert.strictEqual(r.content, USER_CONTENT, 'byte-identical');
});

// ------------------------------------------------------------- 幂等性

test('brief-sync: re-merging identical content reports "unchanged" (no pointless writes)', () => {
  const first = bs.mergeBrief('', 'same brief', { missionId: 'mis-a', fingerprint: 'abc' });
  const again = bs.mergeBrief(first.content, 'same brief', { missionId: 'mis-a', fingerprint: 'abc' });
  assert.strictEqual(again.action, 'unchanged');
  assert.strictEqual(again.content, first.content, 'byte-identical — the file mtime should not change');
});

test('brief-sync: a different fingerprint changes the meta even with the same body', () => {
  const a = bs.mergeBrief('', 'brief', { missionId: 'mis-a', fingerprint: 'f1' });
  const b = bs.mergeBrief(a.content, 'brief', { missionId: 'mis-a', fingerprint: 'f2' });
  assert.strictEqual(b.action, 'replaced');
  assert.ok(b.content.includes('"fingerprint":"f2"'));
});

// ------------------------------------------------------- 损坏标记的处理

test('brief-sync: a begin marker WITHOUT an end marker is refused, not guessed', () => {
  // 文件被截断/手工改坏时，**不能**猜结束位置——猜错就会吃掉用户内容。
  const broken = USER_CONTENT + '\n' + bs.BEGIN_MARK + '\n半截内容\n';
  const r = bs.mergeBrief(broken, 'new brief', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /refusing to guess/);
  assert.strictEqual(r.content, broken, 'the file must be left exactly as it was');
});

test('brief-sync: extractBlock reports broken state explicitly', () => {
  const e = bs.extractBlock(`${bs.BEGIN_MARK}\nno end`);
  assert.strictEqual(e.present, false);
  assert.strictEqual(e.broken, true);
});

test('brief-sync: an empty brief is refused (never blanks out an existing block)', () => {
  const r = bs.mergeBrief(USER_CONTENT, '   ', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.content, USER_CONTENT);
});

// ------------------------------------------------------------- 状态读取

test('brief-sync: readSyncState reports which mission the block belongs to', () => {
  const r = bs.mergeBrief('', 'brief', { missionId: 'mis-x', fingerprint: 'ff' });
  const st = bs.readSyncState(r.content);
  assert.strictEqual(st.present, true);
  assert.strictEqual(st.missionId, 'mis-x');
  assert.strictEqual(st.fingerprint, 'ff');
});

test('brief-sync: readSyncState on a plain file says "not present"', () => {
  const st = bs.readSyncState(USER_CONTENT);
  assert.strictEqual(st.present, false);
  assert.strictEqual(st.missionId, null);
});

// --------------------------------------------------------------- 文件层

test('brief-sync: syncToWorkspace CREATES AGENTS.md when missing', () => {
  const ws = tmpWs();
  const r = bs.syncToWorkspace({ workspaceDir: ws, briefText: '# Brief', meta: { missionId: 'mis-a' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, 'created');
  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('# Brief'));
});

test('brief-sync: syncToWorkspace on a workspace with an existing AGENTS.md preserves it', () => {
  const ws = tmpWs();
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), USER_CONTENT);
  const r = bs.syncToWorkspace({ workspaceDir: ws, briefText: '# Brief', meta: {} });
  assert.strictEqual(r.ok, true);
  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('构建: npm test'), 'the pre-existing file must keep its content');
});

test('brief-sync: syncToWorkspace is idempotent at the file level', () => {
  const ws = tmpWs();
  const first = bs.syncToWorkspace({ workspaceDir: ws, briefText: '# Brief', meta: { missionId: 'm' } });
  const mtime1 = fs.statSync(path.join(ws, 'AGENTS.md')).mtimeMs;
  const second = bs.syncToWorkspace({ workspaceDir: ws, briefText: '# Brief', meta: { missionId: 'm' } });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.action, 'unchanged', 'identical content must not be rewritten');
  assert.strictEqual(fs.statSync(path.join(ws, 'AGENTS.md')).mtimeMs, mtime1,
    'an unchanged sync must not touch the file (mtime is a signal users can see)');
});

test('brief-sync: unsyncFromWorkspace removes only the block', () => {
  const ws = tmpWs();
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), USER_CONTENT);
  bs.syncToWorkspace({ workspaceDir: ws, briefText: '# Brief', meta: {} });
  const r = bs.unsyncFromWorkspace({ workspaceDir: ws });
  assert.strictEqual(r.action, 'removed');
  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.ok(!text.includes(bs.BEGIN_MARK));
  assert.ok(text.includes('构建: npm test'));
});

test('brief-sync: unsyncFromWorkspace on a missing file is a no-op (idempotent)', () => {
  const ws = tmpWs();
  const r = bs.unsyncFromWorkspace({ workspaceDir: ws });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, 'no-file');
  assert.ok(!fs.existsSync(path.join(ws, 'AGENTS.md')), 'must not create a file just to delete from it');
});

test('brief-sync: inspect reports sync state without writing', () => {
  const ws = tmpWs();
  assert.strictEqual(bs.inspect({ workspaceDir: ws }).exists, false);

  bs.syncToWorkspace({ workspaceDir: ws, briefText: '# Brief', meta: { missionId: 'mis-q' } });
  const after = bs.inspect({ workspaceDir: ws });
  assert.strictEqual(after.exists, true);
  assert.strictEqual(after.synced, true);
  assert.strictEqual(after.missionId, 'mis-q');
});

test('brief-sync: writing leaves no temp files behind (atomic rename)', () => {
  const ws = tmpWs();
  bs.syncToWorkspace({ workspaceDir: ws, briefText: '# Brief', meta: {} });
  const leftovers = fs.readdirSync(ws).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('brief-sync: a missing workspaceDir is refused', () => {
  assert.strictEqual(bs.syncToWorkspace({ briefText: 'x' }).ok, false);
  assert.strictEqual(bs.unsyncFromWorkspace({}).ok, false);
  assert.strictEqual(bs.inspect({}).ok, false);
});

// --------------------------------------------------- 与 dsh 的契约

test('brief-sync: the generated block is valid Markdown (dsh feeds this to the model)', () => {
  const r = bs.mergeBrief('', '## Intent\n做点事', {});
  assert.ok(r.content.includes('## Mission Context'), 'a heading so the model sees structure');
  assert.ok(r.content.includes('auto-generated'), 'and knows it is not user-authored');
  assert.ok(r.content.includes('overwritten'), 'and knows edits inside will be lost');
});
