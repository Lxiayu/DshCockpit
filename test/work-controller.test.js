'use strict';

// test/work-controller.test.js — v0.7 P1：工作项状态机与"无产物不算完成"门禁。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createWorkspaceStore } = require('../src/work/workspace-store.js');
const { createWorkController } = require('../src/work/work-controller.js');

function setup({ nowMs = () => 1000, runCommand = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-work-ctl-'));
  const store = createWorkspaceStore({ homeDir: home, nowMs });
  const workspace = store.open({ create: 'ctl' });
  const controller = createWorkController({ store, workspace, nowMs, runCommand });
  return { store, workspace, controller };
}

function addArtifact({ store, workspace, controller, jobId = 'job-1', kind = 'research-notes', role = 'researcher', text = 'notes' }) {
  const dir = path.join(workspace.path, '.dsh', 'artifacts', jobId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}.md`);
  fs.writeFileSync(file, text, 'utf8');
  const digest = `exec-sha256:${crypto.createHash('sha256').update(Buffer.from(text)).digest('hex').slice(0, 16)}`;
  return controller.onArtifact(
    { kind, digest, artifactPath: file, bytes: Buffer.byteLength(text) },
    { jobId, role, runRef: 'exec-run:0123456789abcdef', attempt: 0 },
  );
}

test('work-controller: begin creates a single active item and validates the goal', () => {
  const { controller } = setup();
  assert.equal(controller.begin({ goal: '  ' }).code, 'WORK_GOAL_REQUIRED');
  const first = controller.begin({ goal: '研究主题' });
  assert.equal(first.ok, true);
  assert.equal(first.item.status, 'running');
  assert.equal(first.item.goal, '研究主题');
  const busy = controller.begin({ goal: '第二个任务' });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'WORK_BUSY');
  assert.equal(controller.snapshot().active, true);
});

test('work-controller: phase comes from the running run and clears on terminal', () => {
  const { controller } = setup();
  controller.begin({ goal: '研究' });
  const running = { status: 'running', runs: { researcher: { status: 'running', progress: { phase: 'search' } } } };
  assert.equal(controller.sync(running).changed, true);
  assert.equal(controller.snapshot().current.phase, 'search');
  // identical state → no write
  assert.equal(controller.sync(running).changed, false);
  const done = { status: 'completed', runs: {} };
  controller.sync(done);
  assert.equal(controller.snapshot().current.phase, null);
});

test('work-controller: completed WITHOUT an artifact is never reported as completed', () => {
  const { controller } = setup();
  controller.begin({ goal: '研究' });
  controller.sync({ status: 'completed', runs: {} });
  const snap = controller.snapshot();
  assert.equal(snap.current.status, 'incomplete');
  assert.equal(snap.current.finishedAtMs, 1000);
  assert.notEqual(snap.current.status, 'completed');
});

test('work-controller: completed WITH an artifact is completed; the index has no absolute path', () => {
  const ctx = setup();
  ctx.controller.begin({ goal: '研究' });
  const reg = addArtifact(ctx);
  assert.equal(reg.ok, true);
  ctx.controller.sync({ status: 'completed', runs: {} });
  const snap = ctx.controller.snapshot();
  assert.equal(snap.current.status, 'completed');
  assert.deepEqual(snap.current.artifactRefs, ['job-1:research-notes']);
  assert.equal(snap.artifacts.length, 1);
  assert.equal(snap.artifacts[0].kind, 'research-notes');
  assert.equal(snap.artifacts[0].producerRole, 'researcher');
  assert.equal(JSON.stringify(snap.artifacts).includes(ctx.workspace.path), false, 'snapshot carries no absolute paths');
  assert.equal(JSON.stringify(snap.artifacts).includes('job-1'), true, 'the opaque key is allowed');
  // persistence: a fresh store (new process) sees the same artifact and item status
  const reloadedStore = createWorkspaceStore({ homeDir: path.dirname(path.dirname(ctx.workspace.path)) });
  const reloaded = reloadedStore.open({ path: ctx.workspace.path });
  const onDisk = reloadedStore.readIndex(reloaded);
  assert.equal(onDisk.artifacts.length, 1);
  assert.equal(onDisk.artifacts[0].relPath, '.dsh/artifacts/job-1/research-notes.md');
  assert.equal(onDisk.items[0].status, 'completed');
});

test('work-controller: failure and cancellation map to their own statuses', () => {
  const { controller } = setup();
  controller.begin({ goal: 'a' });
  controller.sync({ status: 'failed', runs: {} });
  assert.equal(controller.snapshot().current.status, 'failed');
  controller.begin({ goal: 'b' });
  controller.sync({ status: 'attention', runs: {} });
  assert.equal(controller.snapshot().current.status, 'attention');
  assert.equal(controller.snapshot().active, true);
  controller.sync({ status: 'cancelled', runs: {} });
  assert.equal(controller.snapshot().current.status, 'cancelled');
});

test('work-controller: attention keeps the item active (no auto-resume, no fake completion)', () => {
  const { controller } = setup();
  controller.begin({ goal: '研究' });
  controller.sync({ status: 'attention', runs: { reviewer: { status: 'attention' } } });
  const snap = controller.snapshot();
  assert.equal(snap.current.status, 'attention');
  assert.equal(snap.current.finishedAtMs, null);
  assert.equal(snap.active, true);
});

test('work-controller: artifacts registered without an active item are refused', () => {
  const ctx = setup();
  const reg = addArtifact(ctx);
  assert.equal(reg.ok, false);
  assert.equal(reg.code, 'WORK_ITEM_NONE');
  assert.equal(ctx.controller.snapshot().artifacts.length, 0);
});

test('work-controller: a stale running item from a previous process is marked interrupted', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-work-restart-'));
  const store = createWorkspaceStore({ homeDir: home });
  const workspace = store.open({ create: 'restart' });
  const first = createWorkController({ store, workspace });
  first.begin({ goal: '未完成任务' });
  assert.equal(first.snapshot().current.status, 'running');
  // 模拟进程重启：新的 controller 看到遗留的 running 项必须如实标注，而不是假装还在跑。
  const second = createWorkController({ store, workspace });
  const item = second.snapshot().items.find((entry) => entry.goal === '未完成任务');
  assert.equal(item.status, 'interrupted');
  assert.equal(second.snapshot().active, false);
});

test('work-controller: a blocked dispatch is surfaced as attention with a reason code (never a silent running)', () => {
  const { controller } = setup();
  controller.begin({ goal: '研究' });
  const verdict = controller.block({ role: 'reviewer', code: 'HANDOFF_INCOMPLETE' });
  assert.equal(verdict.ok, true);
  const snap = controller.snapshot();
  assert.equal(snap.current.status, 'attention');
  assert.equal(snap.current.blockedCode, 'HANDOFF_INCOMPLETE');
  assert.equal(snap.active, true);
  // leaving attention clears the reason (e.g. after a real resume)
  controller.sync({ status: 'running', runs: {} });
  assert.equal(controller.snapshot().current.blockedCode, null);
});

test('work-controller: abandon closes the shell item without inventing a Team terminal', () => {
  const { controller, workspace, store } = setup();
  controller.begin({ goal: '研究' });
  controller.block({ code: 'HANDOFF_INCOMPLETE' });
  const verdict = controller.abandon();
  assert.equal(verdict.ok, true);
  const snap = controller.snapshot();
  assert.equal(snap.current.status, 'abandoned');
  assert.equal(snap.current.blockedCode, null);
  assert.equal(snap.current.finishedAtMs, 1000);
  assert.equal(snap.active, false);
  const onDisk = store.readIndex(workspace).items[0];
  assert.equal(onDisk.status, 'abandoned');
});

test('work-controller: workspace changes are captured as a shell artifact (bounded, relative paths)', () => {
  const { controller, workspace } = setup();
  const goalFile = path.join(workspace.path, 'notes.md');
  fs.writeFileSync(goalFile, 'before\n');
  controller.begin({ goal: '改代码' });
  // the "worker" edits/creates/deletes files after the baseline
  fs.writeFileSync(goalFile, 'after\n');
  fs.writeFileSync(path.join(workspace.path, 'new-file.txt'), 'hello');
  fs.mkdirSync(path.join(workspace.path, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(workspace.path, 'node_modules', 'ignore.js'), 'x');
  controller.sync({ status: 'completed', runs: {} });
  const snap = controller.snapshot();
  const patchEntry = snap.artifacts.find((entry) => entry.kind === 'workspace-patch');
  assert.ok(patchEntry, 'a workspace-patch artifact is registered');
  assert.ok(snap.current.artifactRefs.includes(patchEntry.key));
  const written = JSON.parse(fs.readFileSync(path.join(workspace.path, '.dsh', 'artifacts', snap.current.workItemId, 'workspace-patch.json'), 'utf8'));
  assert.deepEqual(written.modified.map((entry) => entry.path), ['notes.md']);
  assert.deepEqual(written.added.map((entry) => entry.path), ['new-file.txt']);
  assert.equal(JSON.stringify(written).includes('node_modules'), false, 'dependency trees are excluded');
  assert.equal(JSON.stringify(written).includes('.dsh'), false, 'own artifacts are excluded');
  assert.match(written.modified[0].digest, /^ref-sha256:[0-9a-f]{16}$/);
  assert.equal(written.truncated, false);
});

test('work-controller: an unchanged workspace produces no empty patch (no fake evidence)', () => {
  const { controller } = setup();
  controller.begin({ goal: '什么都不改' });
  controller.sync({ status: 'completed', runs: {} });
  const snap = controller.snapshot();
  assert.equal(snap.artifacts.some((entry) => entry.kind === 'workspace-patch'), false);
});

test('work-controller: verification runs in the workspace and records evidence', async () => {
  const calls = [];
  const ctx = setup({
    runCommand: async (args) => { calls.push(args); return { ok: true, code: null, exitCode: 0, signal: null, timedOut: false, durationMs: 42, output: 'all tests passed', truncated: false }; },
  });
  ctx.controller.begin({ goal: '改代码', verifyCommand: 'npm test' });
  ctx.controller.sync({ status: 'completed', runs: {} });
  const result = await ctx.controller.runVerification();
  assert.equal(result.skipped, false);
  assert.equal(result.verification.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npm test');
  assert.equal(calls[0].cwd, ctx.workspace.path);
  const snap = ctx.controller.snapshot();
  const evidence = snap.artifacts.find((entry) => entry.kind === 'verification');
  assert.ok(evidence, 'verification evidence is registered');
  assert.equal(snap.current.verification.ok, true);
  const written = JSON.parse(fs.readFileSync(path.join(ctx.workspace.path, '.dsh', 'artifacts', snap.current.workItemId, 'verification.json'), 'utf8'));
  assert.equal(written.command, 'npm test');
  assert.equal(written.exitCode, 0);
  assert.ok(written.outputTail.includes('all tests passed'));
  assert.equal(written.logRelPath, `.dsh/artifacts/${snap.current.workItemId}/verify.log`);
  assert.equal(fs.readFileSync(path.join(ctx.workspace.path, written.logRelPath), 'utf8'), 'all tests passed');
  // idempotent: a second call does not re-run
  const again = await ctx.controller.runVerification();
  assert.equal(again.skipped, true);
  assert.equal(calls.length, 1);
});

test('work-controller: a failing verification is recorded as not ok (never dressed up)', async () => {
  const ctx = setup({
    runCommand: async () => ({ ok: false, code: null, exitCode: 1, signal: null, timedOut: false, durationMs: 5, output: '1 failing', truncated: false }),
  });
  ctx.controller.begin({ goal: '改代码', verifyCommand: 'npm test' });
  ctx.controller.sync({ status: 'completed', runs: {} });
  const result = await ctx.controller.runVerification();
  assert.equal(result.verification.ok, false);
  assert.equal(result.verification.exitCode, 1);
  assert.equal(ctx.controller.snapshot().current.verification.ok, false);
});

test('work-controller: verification is skipped without a command or before a terminal state', async () => {
  let calls = 0;
  const ctx = setup({ runCommand: async () => { calls += 1; return { ok: true, exitCode: 0, durationMs: 1, output: '' }; } });
  ctx.controller.begin({ goal: '研究' });
  ctx.controller.sync({ status: 'completed', runs: {} });
  assert.equal((await ctx.controller.runVerification()).skipped, true);
  ctx.controller.begin({ goal: '改代码', verifyCommand: 'npm test' });
  ctx.controller.sync({ status: 'attention', runs: {} });
  assert.equal((await ctx.controller.runVerification()).skipped, true);
  assert.equal(calls, 0);
});

test('work-controller: finish(incomplete) goes through the artifact gate', () => {
  const { controller } = setup();
  controller.begin({ goal: '研究' });
  controller.finish('incomplete');
  assert.equal(controller.snapshot().current.status, 'incomplete');
  assert.equal(controller.finish('bogus').code, 'WORK_STATUS_INVALID');
});
