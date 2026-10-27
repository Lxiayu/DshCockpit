'use strict';

// test/work-e2e-offline.test.js — v0.7 P1 验收：真实 transport 实现 + 工作区落地 + 索引 + 工作项。
//
// 与 team-shell-transport.test.js 的离线端到端同一链路，额外挂上：
//   workspace-store（产物落 <workspace>/.dsh/artifacts）+ work-controller（工作项/门禁）。
// 这是"首跑 5 分钟产出真实文件"的无头等价物（真机脚本在报告里）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createShellTeamTransport } = require('../src/team-shell-transport.js');
const { createWorkspaceStore } = require('../src/work/workspace-store.js');
const { createWorkController } = require('../src/work/work-controller.js');

const T0 = 1_700_000_000_000;
const TOPIC = '调研离线工作区落地';

function fakeRpc() {
  const calls = { create: 0, prompt: [], cancel: [] };
  let next = 0;
  return {
    calls,
    async createSession() { calls.create += 1; next += 1; return `sess-${next}`; },
    async prompt(sessionId, text, mode) { calls.prompt.push({ sessionId, text, mode }); return { ok: true }; },
    async cancel(sessionId) { calls.cancel.push(sessionId); return { ok: true }; },
  };
}

function journalOf(isResearcher) {
  const events = isResearcher
    ? [
      { type: 'turn/start', seq: 1, time: T0 + 1, data: {} },
      { type: 'assistant/message', seq: 2, time: T0 + 2, data: { content: [{ type: 'text', text: '# 工作区研究笔记\n\n发现 A；风险 B。' }] } },
      { type: 'turn/end', seq: 3, time: T0 + 3, data: { reason: { kind: 'completed' } } },
    ]
    : [
      { type: 'turn/start', seq: 1, time: T0 + 1, data: {} },
      { type: 'turn/end', seq: 2, time: T0 + 2, data: { reason: { kind: 'completed' } } },
    ];
  return events;
}

test('work-e2e: a full offline run lands a real file in the workspace and completes the work item', async () => {
  const team = require('../src/team/runtime/index.js');
  const backendModule = require('../src/team/runtime/dsh-execution-backend.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-work-e2e-'));
  let clockMs = T0;
  const clock = { nowMs: () => clockMs };
  const store = createWorkspaceStore({ homeDir: home, nowMs: () => clockMs });
  const workspace = store.open({ create: 'e2e' });
  const work = createWorkController({ store, workspace, nowMs: () => clockMs });
  assert.equal(work.begin({ goal: TOPIC }).ok, true);
  // The worker (running with cwd = workspace on the dedicated runtime) changes a file.
  const workerFile = path.join(workspace.path, 'worker-output.txt');
  fs.writeFileSync(workerFile, 'team was here\n');

  const rpc = fakeRpc();
  const openFollow = () => {
    const isResearcher = rpc.calls.create === 1;
    const events = journalOf(isResearcher);
    let i = 0;
    return Object.freeze({
      [Symbol.asyncIterator]: () => ({
        next() {
          if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
          const value = events[i]; i += 1;
          return Promise.resolve({ value, done: false });
        },
      }),
    });
  };
  const transport = createShellTeamTransport({
    rpc,
    openFollow,
    artifactDir: path.join(workspace.path, '.dsh', 'artifacts'),
    topic: TOPIC,
    log: () => {},
    onArtifact: (record, context) => work.onArtifact(record, context),
  });

  const runtime = team.createTeamRuntime({ clock });
  const backend = backendModule.createDshExecutionBackend({ clock, transport });
  const executor = Object.freeze({
    startRun: (args) => backend.startRun(args),
    observe: (handle) => backend.observe(handle),
    cancel: (handle) => backend.cancel(handle),
    unsupported: Object.freeze(['recover']),
  });
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime, executor, clock, jobId: 'job-work-e2e-1',
  });
  await controller.start();
  for (let i = 0; i < 16; i += 1) {
    await controller.dispatchReady();
    const step = await controller.pumpOne();
    if (!step) break;
    clockMs += 10;
    work.sync(runtime.state());
  }
  work.sync(runtime.state());

  // Team facts: root completed with a real handoff
  const state = runtime.state();
  assert.equal(state.status, 'completed');
  assert.ok(state.runs.researcher.producedArtifactIds.length === 1);

  // artifact on disk, inside the workspace (not userData)
  const artifactAbs = path.join(workspace.path, '.dsh', 'artifacts', 'job-work-e2e-1', 'research-notes.md');
  assert.equal(fs.existsSync(artifactAbs), true, 'the artifact is a real workspace file');
  assert.ok(fs.readFileSync(artifactAbs, 'utf8').includes('工作区研究笔记'));

  // work item + index
  const snap = work.snapshot();
  assert.equal(snap.current.status, 'completed');
  assert.deepEqual(snap.current.artifactRefs.slice().sort(), ['job-work-e2e-1:research-notes', `shell:${snap.current.workItemId}:workspace-patch`].sort());
  assert.equal(snap.artifacts.length, 2);
  const patchEntry = snap.artifacts.find((entry) => entry.kind === 'workspace-patch');
  assert.ok(patchEntry, 'workspace changes ride the work item as a shell artifact');
  assert.equal(snap.artifacts[0].relPath, undefined, 'the status payload omits the relative path');
  const onDisk = store.readIndex(workspace);
  assert.equal(onDisk.artifacts[0].relPath, '.dsh/artifacts/job-work-e2e-1/research-notes.md');
  assert.equal(onDisk.items[0].status, 'completed');

  // privacy: no prompt/notes body and no absolute path in items/artifacts.
  // workspace.displayPath is the ONE shell→work field that may carry the path
  // (the view needs to show which folder it is writing to).
  const serialized = JSON.stringify({ items: snap.items, artifacts: snap.artifacts, current: snap.current });
  assert.equal(serialized.includes('工作区研究笔记'), false, 'artifact content never enters the status payload');
  assert.equal(serialized.includes(workspace.path), false, 'no absolute workspace path in items/artifacts');
  assert.equal(serialized.includes(TOPIC), true, 'the goal is user text and is displayed (allowed)');
  assert.equal(snap.workspace.displayPath, workspace.path, 'the workspace path is shell→view only');
});

test('work-e2e: a missing upstream artifact blocks the next step observably (no silent running)', async () => {
  // 真机验收 2026-10-27 的场景：researcher 完成但没有正文 → 物化拒绝 → reviewer 被
  // Team 的 HANDOFF_INCOMPLETE 挡住。v0 没有 job 级 attention 命令，因此壳必须把
  // controller 的 blocked 呈现为可处理的 attention，而不是永远 running。
  const team = require('../src/team/runtime/index.js');
  const backendModule = require('../src/team/runtime/dsh-execution-backend.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-work-e2e-blocked-'));
  let clockMs = T0;
  const clock = { nowMs: () => clockMs };
  const store = createWorkspaceStore({ homeDir: home, nowMs: () => clockMs });
  const workspace = store.open({ create: 'blocked' });
  const work = createWorkController({ store, workspace, nowMs: () => clockMs });
  work.begin({ goal: '没有产出的任务' });

  const rpc = fakeRpc();
  let followCount = 0;
  const openFollow = () => {
    followCount += 1;
    const events = followCount === 1
      ? [
        { type: 'turn/start', seq: 1, time: T0 + 1, data: {} },
        // 没有 assistant/message → 没有可物化的正文
        { type: 'turn/end', seq: 2, time: T0 + 2, data: { reason: { kind: 'completed' } } },
      ]
      : [];
    let i = 0;
    return Object.freeze({
      [Symbol.asyncIterator]: () => ({
        next() {
          if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
          const value = events[i]; i += 1;
          return Promise.resolve({ value, done: false });
        },
      }),
    });
  };
  const transport = createShellTeamTransport({
    rpc, openFollow, artifactDir: path.join(workspace.path, '.dsh', 'artifacts'),
    topic: '没有产出的任务', log: () => {},
    onArtifact: (record, context) => work.onArtifact(record, context),
  });
  const runtime = team.createTeamRuntime({ clock });
  const backend = backendModule.createDshExecutionBackend({ clock, transport });
  const executor = Object.freeze({
    startRun: (args) => backend.startRun(args),
    observe: (handle) => backend.observe(handle),
    cancel: (handle) => backend.cancel(handle),
    unsupported: Object.freeze(['recover']),
  });
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime, executor, clock, jobId: 'job-work-e2e-blocked',
  });
  await controller.start();
  for (let i = 0; i < 16; i += 1) {
    await controller.dispatchReady();
    const step = await controller.pumpOne();
    if (!step) break;
    clockMs += 10;
  }
  assert.equal(runtime.state().runs.researcher.status, 'completed');
  assert.equal(runtime.state().runs.reviewer.status, 'pending', 'the reviewer never starts without the artifact');
  const blocked = controller.blocked();
  assert.ok(blocked, 'the controller must report the blocked dispatch');
  assert.equal(blocked.role, 'reviewer');
  assert.equal(blocked.code, 'HANDOFF_INCOMPLETE');

  const surfaced = work.block(blocked);
  assert.equal(surfaced.ok, true);
  const snap = work.snapshot();
  assert.equal(snap.current.status, 'attention');
  assert.equal(snap.current.blockedCode, 'HANDOFF_INCOMPLETE');
  assert.equal(snap.artifacts.length, 0);
  // 用户放弃：壳状态收口，Team 事实保持原样（没有伪造 completed/failed）
  assert.equal(work.abandon().ok, true);
  assert.equal(work.snapshot().current.status, 'abandoned');
  assert.equal(runtime.state().runs.reviewer.status, 'pending');
  assert.equal(JSON.stringify(runtime.facts()).includes('abandoned'), false);
});
