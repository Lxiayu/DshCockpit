// test/mission-startwork-taskref.test.js — startWork 必须真的记下 TaskRef
//
// ============================================================================
// 这个测试存在的两个真实原因（2026-11-02 复查发现）
//
//   这两层 bug 叠在一起，让"记录这次执行"这个功能**完全静默失效**：
//
//   bug 1：deriveHarnessRef 返回 { ok, ref } **对象**，代码却当字符串用。
//          → isValidHarnessRef(对象) === false → 条件永远不成立。
//
//   bug 2：即使修好 bug 1，append 的 payload 也缺 `workstreamId`（schema 必填）、
//          且用了 `ref` 而不是 `harnessRef`。
//          → projection.js 里 `if (!validate) break;` **静默丢弃**，不抛错。
//
//   表现为：UI 上「交给团队」成功、会话绑定成功，但 Mission 里永远没有
//   "关联的执行"。没有任何报错，没有任何日志。
//
// ============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerMissionIpc } = require('../src/ipc-mission.js');

function makeEnv() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tref-'));
  const logs = [];
  let handler = null;
  registerMissionIpc(
    { handle: (_c, fn) => { handler = fn; } },
    {
      workspaceDirOf: () => ws,
      snapshotOf: () => null,
      log: (m) => logs.push(String(m)),
      ensureSession: async () => ({ ok: true, sessionId: 'session-abc-123-def' }),
      promptSession: async () => ({ ok: true }),
      projectionsOf: async () => ({ ok: true, value: { values: { turnOutline: [] } } }),
    },
  );
  return { call: (a, p) => handler(null, a, p), logs };
}

test('startWork records a TaskRef once the mission has a workstream', async () => {
  const env = makeEnv();
  const c = await env.call('create', { title: 'T', intent: 'I', workspaceId: 'w' });
  await env.call('addWorkstream', { missionId: c.missionId, title: '研究' });
  await env.call('startWork', { missionId: c.missionId, task: '干点活' });

  const v = await env.call('get', { missionId: c.missionId });
  const refs = v.view.taskRefs || [];
  assert.strictEqual(refs.length, 1, 'exactly one TaskRef must be recorded');
});

test('the recorded harnessRef is a DERIVED handle, never a raw session id', async () => {
  const env = makeEnv();
  const c = await env.call('create', { title: 'T', intent: 'I', workspaceId: 'w' });
  await env.call('addWorkstream', { missionId: c.missionId, title: '研究' });
  await env.call('startWork', { missionId: c.missionId, task: '干点活' });

  const v = await env.call('get', { missionId: c.missionId });
  const ref = (v.view.taskRefs || [])[0];
  assert.ok(ref, 'a TaskRef must exist');
  assert.match(ref.harnessRef, /^sess-h-[a-f0-9]{12}/, 'harnessRef must be the derived handle shape');
  // 绝不能出现原始 session id
  assert.ok(!String(ref.harnessRef).includes('session-abc-123-def'),
    'the raw session id must never be persisted');
});

test('without a workstream it SKIPS the TaskRef and says so in the log', async () => {
  // 静默丢弃是最坏的行为：用户以为记下了，实际没有。
  const env = makeEnv();
  const c = await env.call('create', { title: 'T', intent: 'I', workspaceId: 'w' });
  await env.call('startWork', { missionId: c.missionId, task: '干点活' });

  const v = await env.call('get', { missionId: c.missionId });
  assert.deepStrictEqual(v.view.taskRefs || [], [], 'no workstream means no TaskRef');
  assert.ok(
    env.logs.some((l) => /no workstream yet, skipping the taskRef/.test(l)),
    'skipping must be logged, never silent',
  );
});

test('startWork still succeeds even when the TaskRef cannot be recorded', async () => {
  // 绑定会话是主目标；记 TaskRef 是附带。不能因为附带失败就让整次启动失败。
  const env = makeEnv();
  const c = await env.call('create', { title: 'T', intent: 'I', workspaceId: 'w' });
  const r = await env.call('startWork', { missionId: c.missionId, task: '干点活' });
  assert.strictEqual(r.ok, true, 'the session was bound, so startWork succeeded');
});
