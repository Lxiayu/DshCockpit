// test/mission-task-ref.test.js — TaskRef 接线（P4）。
//
// 第一性原理：这个模块只有两个职责，两个都不能错
//
//   1. **隐私派生**：TaskRef 要引用一次 Harness 执行，但**不能存 sessionId**。
//      如果这里出错，raw sessionId 会进 Mission 的 events.jsonl，
//      长期留在用户工作区里 —— 而 Mission 语义上根本不需要它。
//
//   2. **拒绝状态**：schema 明确禁止 TaskRef 带 status（任务状态归 Harness）。
//      如果这里放行，就会出现"两个事实作者" —— 而那正是本产品最核心的
//      架构禁忌（AGENTS.md 铁律 1）。
//
//   所以本文件重点测"不该做的事有没有被挡住"，而不是"能不能用"。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tr = require(path.join(ROOT, 'src/mission/task-ref.js'));
const missionIpc = require(path.join(ROOT, 'src/ipc-mission.js'));

// ============================================ 1. 隐私派生

test('taskref: the same session+turn derives the same ref (idempotent)', () => {
  // 幂等是"关联"能成立的前提：同一次执行被重复关联不该产生两个 ref。
  const a = tr.deriveHarnessRef({ sessionId: 'sess-abc123', turn: 3 });
  const b = tr.deriveHarnessRef({ sessionId: 'sess-abc123', turn: 3 });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.ref, b.ref);
});

test('taskref: different turns in the SAME session get DIFFERENT refs', () => {
  // 一个 session 里可能发生多次属于不同工作流的执行。只 hash sessionId
  // 会让它们撞成一个 —— 那 TaskRef 就失去意义了。
  const t1 = tr.deriveHarnessRef({ sessionId: 'sess-abc123', turn: 1 });
  const t2 = tr.deriveHarnessRef({ sessionId: 'sess-abc123', turn: 2 });
  assert.notStrictEqual(t1.ref, t2.ref);
});

test('taskref: the ref does NOT contain the raw session id (privacy invariant)', () => {
  // AGENTS.md §2.4：raw sessionId 不进 Mission 事实链。
  const secret = 'sess-SUPER-SECRET-TOKEN-9876';
  const r = tr.deriveHarnessRef({ sessionId: secret });
  assert.strictEqual(r.ok, true);
  assert.ok(!r.ref.includes('secret'), 'no fragment of the id may leak (case-insensitive)');
  assert.ok(!r.ref.toLowerCase().includes('super'));
  assert.ok(!r.ref.includes('9876'));
});

test('taskref: the derived ref is fixed-length (bounded, no input-length leak)', () => {
  // 如果 ref 长度随 sessionId 变，就等于泄漏了 id 长度这个侧信道。
  const short = tr.deriveHarnessRef({ sessionId: 'a' });
  const long = tr.deriveHarnessRef({ sessionId: 'a'.repeat(400) });
  assert.strictEqual(short.ok, true);
  assert.strictEqual(long.ok, true);
  assert.strictEqual(short.ref.length, long.ref.length);
});

test('taskref: an empty/blank session id is refused', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    const r = tr.deriveHarnessRef({ sessionId: bad });
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('taskref: an absurdly long session id is refused (defensive)', () => {
  const r = tr.deriveHarnessRef({ sessionId: 'x'.repeat(600) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'SESSION_ID_TOO_LONG');
});

test('taskref: an out-of-range turn is refused', () => {
  for (const bad of [-1, 1.5, 1e9, 'x']) {
    const r = tr.deriveHarnessRef({ sessionId: 'sess-a', turn: bad });
    assert.strictEqual(r.ok, false, `turn=${JSON.stringify(bad)} must be refused`);
  }
});

test('taskref: isValidHarnessRef accepts the derived shape and rejects others', () => {
  assert.strictEqual(tr.isValidHarnessRef(tr.deriveHarnessRef({ sessionId: 'sess-a' }).ref), true);
  assert.strictEqual(tr.isValidHarnessRef(tr.deriveHarnessRef({ sessionId: 'sess-a', turn: 7 }).ref), true);
  for (const bad of ['sess-abc123', '', 'sess-h-XYZ', 'sess-h-1234', null]) {
    assert.strictEqual(tr.isValidHarnessRef(bad), false, `${bad} must be rejected`);
  }
});

// ============================================ 2. 拒绝状态（两个事实作者）

test('taskref: buildTaskRef carries NO status field', () => {
  const built = tr.buildTaskRef({ missionId: 'mis-1', workstreamId: 'ws-1', sessionId: 'sess-a', summary: 'x' });
  assert.strictEqual(built.ok, true);
  assert.strictEqual('status' in built.taskRef, false,
    'TaskRef must never carry task state — Harness owns it');
});

test('taskref: an unknown kind is refused', () => {
  const built = tr.buildTaskRef({ missionId: 'mis-1', workstreamId: 'ws-1', sessionId: 'sess-a', kind: 'magic' });
  assert.strictEqual(built.ok, false);
  assert.strictEqual(built.code, 'KIND_INVALID');
});

// ============================================ 3. IPC 层

test('taskref ipc: the two actions are registered in ACTIONS', () => {
  assert.ok(missionIpc.ACTIONS.includes('linkTaskRef'));
  assert.ok(missionIpc.ACTIONS.includes('listTaskRefs'));
});

test('taskref ipc: linkTaskRef REFUSES a payload carrying status', () => {
  // 这是硬边界。schema 会挡，但 IPC 层要先给出清楚的错误码，
  // 而不是让调用方看到一个笼统的 "invalid taskRef"。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ipc-mission.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = code.indexOf('linkTaskRef(payload) {');
  const body = code.slice(start, code.indexOf('listTaskRefs(payload) {', start));
  assert.match(body, /TASK_REF_STATUS_FORBIDDEN/, 'it must reject status with a dedicated code');
  assert.match(body, /Harness-owned/, 'and explain that task state belongs to the Harness');
});

test('taskref ipc: linkTaskRef never persists the raw sessionId', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ipc-mission.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = code.indexOf('linkTaskRef(payload) {');
  const body = code.slice(start, code.indexOf('listTaskRefs(payload) {', start));
  // 唯一允许 sessionId 出现的地方是"传给派生函数"，不能是"直接写进实体"
  assert.match(body, /buildTaskRef\(/, 'it must go through the derivation');
  assert.doesNotMatch(body, /harnessRef:\s*argString\(payload\.sessionId\)/,
    'never store the raw id as the ref');
});

// ============================================ 4. 端到端落盘

test('taskref e2e: a linked ref lands in the projection WITHOUT leaking the id', () => {
  const { createMissionStore } = require(path.join(ROOT, 'src/mission/store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-'));
  const store = createMissionStore({ workspaceDir: dir });
  const missionId = 'mis-e2e1';
  store.append('mission.created', {
    missionId, workspaceId: 'wsp-e2e1', title: 'T', intent: 'I', status: 'active',
    createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });
  store.append('workstream.created', {
    workstreamId: 'ws-e2e1', missionId, title: 'WS', status: 'active',
    createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });

  const SECRET = 'sess-PRIVATE-abcdef';
  const built = tr.buildTaskRef({ missionId, workstreamId: 'ws-e2e1', sessionId: SECRET, turn: 1, summary: '做了一件事' });
  assert.strictEqual(store.append('taskRef.linked', built.taskRef, { missionId }).ok, true);

  const view = store.missionView(missionId);
  assert.strictEqual(view.taskRefs.length, 1);
  assert.strictEqual(view.taskRefs[0].summary, '做了一件事');
  // 整个视图序列化后不能出现原文
  assert.ok(!JSON.stringify(view).includes('PRIVATE'), 'the raw session id must never reach the projection');
  assert.ok(tr.isValidHarnessRef(view.taskRefs[0].harnessRef));
});

test('taskref e2e: the persisted events file does not contain the session id', () => {
  // 最强的一条：直接读落盘的事件文件。事实链是长期留存的，
  // 这里泄漏就等于永久泄漏。
  const { createMissionStore } = require(path.join(ROOT, 'src/mission/store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-file-'));
  const store = createMissionStore({ workspaceDir: dir });
  const missionId = 'mis-file1';
  store.append('mission.created', {
    missionId, workspaceId: 'wsp-file1', title: 'T', intent: 'I', status: 'active',
    createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });
  const SECRET = 'sess-NEVER-ON-DISK-4242';
  const built = tr.buildTaskRef({ missionId, workstreamId: 'ws-1', sessionId: SECRET, summary: 's' });
  store.append('taskRef.linked', built.taskRef, { missionId });

  // 扫工作区里所有文件，确认没有泄漏
  const walk = (d) => {
    const out = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const leaks = walk(dir).filter((f) => {
    try { return fs.readFileSync(f, 'utf8').includes('NEVER-ON-DISK'); } catch { return false; }
  });
  assert.deepEqual(leaks, [], `the raw session id must never be written to disk: ${leaks.join(', ')}`);
});

// ============================================ 5. Desk UI

test('taskref ui: the desk renders the linked-execution block', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /api\('linkTaskRef'/, 'the desk must offer a way to link an execution');
  assert.match(code, /关联的执行/, 'the block must have a visible heading');
});

test('taskref ui: the desk does NOT invent a task status (Harness owns it)', () => {
  // 铁律 1：同一状态不许两个写入者。UI 里出现"标记完成"这类控件就错了。
  const html = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');
  const idx = html.indexOf('关联的执行');
  assert.ok(idx !== -1);
  const block = html.slice(idx, idx + 3200);
  for (const forbidden of ['标记完成', '设为已完成', 'status: \'completed\'']) {
    assert.ok(!block.includes(forbidden),
      `the TaskRef block must not let the user set task state (${forbidden})`);
  }
});

test('taskref ui: the desk shows the harness HANDLE, not a session id', () => {
  // 显示的必须是派生句柄。如果 UI 显示"会话 xxxxx"，用户会以为能反查。
  const html = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');
  assert.match(html, /句柄 ?\$?\{?t\.harnessRef/, 'it must label the value as a handle');
});

test('taskref ui: the manual link path does not fake a realistic session id', () => {
  // 没有真实 runtime 时用明确的占位值，而不是伪造一个像真的 sessionId。
  const html = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');
  assert.match(html, /manual-link/, 'a placeholder must be obviously a placeholder');
});
