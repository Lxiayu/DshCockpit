// test/mission-decision-governance.test.js — 决策的治理规则（审计 B-4 修复）。
//
// 第一性原理：这条规则为什么必须由代码而不是文档保证
//
//   user-journeys §5.4 写着：「Agent 不能直接把东西标为"已定决策"」。
//   但修复前 `recordDecision` 的默认值是：
//
//       status:    payload.status    || 'accepted'   // ← 已接受
//       decidedBy: payload.decidedBy || 'user'       // ← 用户拍的板
//
//   两个默认值合起来的意思就是：**任何人不传这两个字段，写出来的就是
//   "用户已经接受的决策"**。模型只要调一次，幻觉就变成了用户共识。
//
//   这不是"可能发生"，是默认行为。文档禁止它，代码却默认这么做。
//
//   所以这里断言的不是"能不能传"，而是"**不传的时候会变成什么**"。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'ipc-mission.js'), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = strip(ipcSrc);

// 只截 recordDecision 的函数体：文件里还有其他 `status: payload.status || ...`
// （例如 updateStatus 的 `|| 'active'`），全文匹配会抓错。
function recordDecisionBody() {
  const start = code.indexOf('recordDecision(payload) {');
  assert.ok(start !== -1, 'recordDecision must exist');
  const end = code.indexOf('openQuestion(payload) {', start);
  assert.ok(end > start);
  return code.slice(start, end);
}

// ============================================ 默认值必须 fail-safe

test('governance: recordDecision defaults status to proposed, NOT accepted', () => {
  // 不传 status 时不能是"已接受"——那等于让模型替用户拍板。
  const body = recordDecisionBody();
  assert.match(body, /status:\s*payload\.status\s*\|\|\s*'proposed'/,
    'a decision without an explicit status must be a PROPOSAL, not an accepted decision');
  assert.doesNotMatch(body, /\|\|\s*'accepted'/,
    'never default to accepted — that turns a model guess into user consensus');
});

test('governance: recordDecision defaults decidedBy to model, NOT user', () => {
  // 不传来源时不能声称"是用户决定的"。
  const body = recordDecisionBody();
  assert.match(body, /decidedBy:\s*payload\.decidedBy\s*\|\|\s*'model'/,
    'an unknown author must not be labelled as the user');
  assert.doesNotMatch(body, /decidedBy:\s*payload\.decidedBy\s*\|\|\s*'user'/,
    'never default to "user" — that is the exact failure mode this fix prevents');
});

test('governance: the two defaults are fail-SAFE in the same direction', () => {
  // 两个默认值必须同向：proposed + model = "模型提议，待用户确认"。
  // 一真一假（比如 proposed + user）会造成"用户提议"的荒谬状态。
  const body = recordDecisionBody();
  const statusDefault = body.match(/status:\s*payload\.status\s*\|\|\s*'(\w+)'/);
  const byDefault = body.match(/decidedBy:\s*payload\.decidedBy\s*\|\|\s*'(\w+)'/);
  assert.ok(statusDefault && byDefault);
  assert.strictEqual(statusDefault[1], 'proposed');
  assert.strictEqual(byDefault[1], 'model');
});

// ============================================ 显式值仍然可用

test('governance: an explicit status/decidedBy is still honoured', () => {
  // 修复不能把正常用法也堵死：用户显式拍板时必须写得进去。
  const body = recordDecisionBody();
  assert.match(body, /status:\s*payload\.status\s*\|\|/, 'explicit status must win');
  assert.match(body, /decidedBy:\s*payload\.decidedBy\s*\|\|/, 'explicit decidedBy must win');
});

// ============================================ 真实落盘验证

test('governance: the fail-safe defaults survive validation and land in the projection', () => {
  // 静态断言之外，真跑一遍 store，确认这两个值能通过 schema 校验并真的落盘。
  const { createMissionStore } = require(path.join(ROOT, 'src/mission/store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-'));
  const store = createMissionStore({ workspaceDir: dir });
  const missionId = 'mis-gov1';
  const workspaceId = 'wsp-gov1';

  assert.strictEqual(store.append('mission.created', {
    missionId, workspaceId, title: 'T', intent: 'I', status: 'active',
    createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId }).ok, true);

  // 用修复后的默认值写一条（模拟"模型调 recordDecision 但没传这两个字段"）
  const appended = store.append('decision.recorded', {
    decisionId: 'dec-gov1', missionId, text: '模型提议的方案', rationale: '因为看起来更简单',
    status: 'proposed', decidedAtMs: Date.now(), decidedBy: 'model',
  }, { missionId });
  assert.strictEqual(appended.ok, true, 'proposed+model must pass schema validation');

  const view = store.missionView(missionId);
  const d = view.decisions[0];
  assert.strictEqual(d.status, 'proposed', 'it must NOT be accepted');
  assert.strictEqual(d.decidedBy, 'model', 'it must NOT claim the user decided');
});

test('governance: an explicitly accepted user decision still validates', () => {
  // 反向确认：正常路径没被堵死。
  const { createMissionStore } = require(path.join(ROOT, 'src/mission/store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov2-'));
  const store = createMissionStore({ workspaceDir: dir });
  const missionId = 'mis-gov2';
  store.append('mission.created', {
    missionId, workspaceId: 'wsp-gov2', title: 'T', intent: 'I', status: 'active',
    createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });
  const r = store.append('decision.recorded', {
    decisionId: 'dec-gov2', missionId, text: '用户拍的板', rationale: '我决定这么做',
    status: 'accepted', decidedAtMs: Date.now(), decidedBy: 'user',
  }, { missionId });
  assert.strictEqual(r.ok, true);
  const d = store.missionView(missionId).decisions[0];
  assert.strictEqual(d.status, 'accepted');
  assert.strictEqual(d.decidedBy, 'user');
});
