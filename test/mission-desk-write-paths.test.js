// test/mission-desk-write-paths.test.js — Desk 的写入入口（P4）。
//
// 第一性原理：为什么这组测试必须存在
//
//   审计发现 18 个 action 里 7 个没有 UI 出口。缺的是**写入**——
//   也就是说 Mission Desk 是个只读报表。
//
//   而本产品的两条核心价值主张都依赖写入：
//     V2「跨会话不丢决策」← 需要 recordDecision
//     V3「产物是真实文件」← 需要 registerDeliverable
//
//   所以这里断言的不是"按钮存在"，是**每条写入路径都能真的落盘**：
//   静态契约（UI 调了哪个 action）+ 端到端（真的写进去、读得回来）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DESK = path.join(ROOT, 'src', 'mission-desk.html');
const deskHtml = fs.readFileSync(DESK, 'utf8');
// 只看代码：注释里提到 action 名不等于 UI 真的调了它
const deskCode = deskHtml.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Desk UI 实际调用过的 action 列表。 */
function calledActions() {
  return [...deskCode.matchAll(/api\('([a-zA-Z]+)'/g)].map((m) => m[1]);
}

// ============================================ 静态契约：7 个 action 的覆盖

test('desk: the UI calls the decision + deliverable + workstream write actions', () => {
  const called = calledActions();
  for (const action of ['recordDecision', 'registerDeliverable', 'addWorkstream', 'updateWorkstreamStatus']) {
    assert.ok(called.includes(action),
      `${action} must have a UI entry point — without it Mission Desk is a read-only report`);
  }
});

test('desk: previously-covered actions are not lost in the process', () => {
  const called = calledActions();
  for (const action of ['list', 'get', 'create', 'updateStatus', 'answerQuestion', 'getBrief', 'syncBrief']) {
    assert.ok(called.includes(action), `${action} must still work`);
  }
});

test('desk: every write form reports WHY it failed (not just {ok:false})', () => {
  // 只说"失败"的表单会让用户反复重试。失败原因必须落到屏幕上。
  const writes = ['recordDecision', 'registerDeliverable', 'addWorkstream'];
  for (const action of writes) {
    const idx = deskCode.indexOf(`api('${action}'`);
    assert.ok(idx !== -1);
    const window = deskCode.slice(idx, idx + 1400);
    assert.match(window, /失败：|reason|code/,
      `${action}'s form must surface the failure reason`);
  }
});

test('desk: the decision form requires a rationale before submitting', () => {
  // schema 已经强制 rationale，UI 应该在提交前就挡住，而不是让用户吃一个后端错误。
  const idx = deskCode.indexOf("api('recordDecision'");
  const before = deskCode.slice(Math.max(0, idx - 1200), idx);
  assert.match(before, /请填写理由/, 'the form must ask for a reason before calling the API');
});

test('desk: the decision form declares the author explicitly (user, not default)', () => {
  // 治理规则：默认值是 proposed/model（模型提议）。用户在 UI 里点"记录决策"
  // 是他自己的动作，所以必须**显式**传 accepted/user。
  const idx = deskCode.indexOf("api('recordDecision'");
  const window = deskCode.slice(idx, idx + 600);
  assert.match(window, /status:\s*'accepted'/, 'a user clicking the button is an accepted decision');
  assert.match(window, /decidedBy:\s*'user'/, 'and the author is the user');
});

test('desk: proposed vs accepted is visible in the UI (not silently merged)', () => {
  // 如果两者看起来一样，"模型提议"会被误读成"已经拍板"。
  assert.match(deskCode, /提议中/, 'proposed decisions must be labelled');
  assert.match(deskCode, /已接受/, 'accepted decisions must be labelled');
});

// ============================================ 端到端：真的能落盘

function freshStore() {
  const { createMissionStore } = require(path.join(ROOT, 'src', 'mission/store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-write-'));
  return { store: createMissionStore({ workspaceDir: dir }), dir };
}

function seedMission(store) {
  const missionId = 'mis-desk1';
  store.append('mission.created', {
    missionId, workspaceId: 'wsp-desk1', title: 'T', intent: 'I', status: 'active',
    createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });
  return missionId;
}

test('desk e2e: a recorded decision survives in the projection', () => {
  // V2「跨会话不丢决策」的最小证明：写进去，读得回来。
  const { store } = freshStore();
  const missionId = seedMission(store);
  const r = store.append('decision.recorded', {
    decisionId: 'dec-desk1', missionId, text: '用 SQLite 而不是 JSON',
    rationale: '并发写入更安全', status: 'accepted', decidedAtMs: Date.now(), decidedBy: 'user',
  }, { missionId });
  assert.strictEqual(r.ok, true);
  const d = store.missionView(missionId).decisions[0];
  assert.strictEqual(d.text, '用 SQLite 而不是 JSON');
  assert.strictEqual(d.rationale, '并发写入更安全');
  assert.strictEqual(d.status, 'accepted');
});

test('desk e2e: a registered deliverable proves the FILE exists (real digest)', () => {
  // V3「产物是真实文件」的机械保证：登记会真的读文件算 sha256。
  // 这不是"存了一个路径字符串"。
  const deliverable = require(path.join(ROOT, 'src', 'mission', 'deliverable.js'));
  const { store, dir } = freshStore();
  const missionId = seedMission(store);

  // 场景 A：文件不存在 → 必须被拒绝
  const missing = deliverable.registerDeliverable({
    workspaceDir: dir, missionId, label: '报告', relPath: 'docs/report.md', now: Date.now(),
  });
  assert.strictEqual(missing.ok, false, 'a non-existent file must NOT be registrable');

  // 场景 B：文件存在 → 登记成功且带真实 digest
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'report.md'), '# 真实内容\n');
  const ok = deliverable.registerDeliverable({
    workspaceDir: dir, missionId, label: '报告', relPath: 'docs/report.md', now: Date.now(),
  });
  assert.strictEqual(ok.ok, true);
  assert.match(ok.deliverable.digest, /^[0-9a-f]{64}$/, 'a real sha256 must be computed');

  const appended = store.append('deliverable.registered', ok.deliverable, { missionId });
  assert.strictEqual(appended.ok, true);
  assert.strictEqual(store.missionView(missionId).deliverables[0].label, '报告');
});

test('desk e2e: a workstream can be created and its status changed', () => {
  const { store } = freshStore();
  const missionId = seedMission(store);
  const ws = {
    workstreamId: 'ws-desk1', missionId, title: '接入 StepFun',
    status: 'active', createdAtMs: Date.now(), updatedAtMs: Date.now(),
  };
  assert.strictEqual(store.append('workstream.created', ws, { missionId }).ok, true);
  assert.strictEqual(store.append('workstream.statusChanged',
    { workstreamId: 'ws-desk1', to: 'blocked' }, { missionId }).ok, true);

  const view = store.missionView(missionId);
  assert.strictEqual(view.workstreams[0].title, '接入 StepFun');
  assert.strictEqual(view.workstreams[0].status, 'blocked');
});
