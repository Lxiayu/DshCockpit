// test/mission-intervene-member.test.js — 对成员干预（S6）。
//
// 第一性原理：这个 action 的语义是"下令"，不是"已执行"
//
//   D11 的硬约束：agent-team 没有 remote 写表面。send_message / interrupt_agent
//   只存在于模型侧工具。壳层**不能直接对成员说话**。
//
//   所以这里锁三件事：
//     1. 用户的原文必须原样传给 Lead（不改写、不概括）
//     2. 成功后只能说"指令已发出"，**不能**说"已中断/已收到"
//     3. 审计只记动作与目标，不记消息正文
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');
const { createMissionStore } = require('../src/mission/store.js');

function setup({ bound = true, promptResult = { ok: true } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-intervene-'));
  const s = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
  s.append('mission.created', {
    missionId: 'mis-a', title: 't', intent: 'i', status: 'active',
    workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2,
  });
  if (bound) {
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dsh', 'mission-sessions.json'),
      JSON.stringify({ version: 1, sessions: { 'mis-a': { sessionId: 'session-x', boundAtMs: 1 } } }),
    );
  }
  const prompts = [];
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock: () => 5000,
      log: () => {},
      snapshotOf: () => null,
      promptSession: async (sid, text) => { prompts.push({ sid, text }); return promptResult; },
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir, prompts };
}

test('intervene: a message is relayed VERBATIM to the Lead', async () => {
  // 用户的原文是这个 action 唯一的内容来源。改写会让他的话失真。
  const { invoke, dir, prompts } = setup();
  const original = '先别改数据库，把接口对完再回来。';
  try {
    const r = await invoke(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'message', memberName: 'coder', message: original,
    });
    assert.equal(r.ok, true);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /send_message/);
    assert.match(prompts[0].text, /coder/);
    // 原话必须逐字出现
    assert.ok(prompts[0].text.includes(original), 'the user text must survive untouched');
    // 必须明确要求"原样转达"
    assert.match(prompts[0].text, /不要改写|原样/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('intervene: success wording is deliberately weak (order given, not done)', async () => {
  // 说"已中断"会让用户以为团队停了，而实际还在跑。
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'interrupt', memberName: 'coder',
    });
    assert.equal(r.ok, true);
    assert.equal(r.delivered, true);
    assert.match(r.note, /以团队状态为准|不代表/);
    assert.doesNotMatch(r.note, /已中断|已停止/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('intervene: interrupt tells the Lead NOT to stop the whole team', async () => {
  // "中断一个成员"和"停掉整支团队"是两件事。混起来会让用户误伤。
  const { invoke, dir, prompts } = setup();
  try {
    await invoke(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'interrupt', memberName: 'coder',
    });
    assert.match(prompts[0].text, /interrupt_agent/);
    assert.match(prompts[0].text, /不要停掉整个团队/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('intervene: the audit records the action but NEVER the message body', async () => {
  // 隐私铁律 §2.4：消息正文不进事实链，审计也不能成为泄露面。
  const { invoke, dir } = setup();
  const secret = '这是不该出现在审计里的正文 ABC123';
  try {
    await invoke(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'message', memberName: 'coder', message: secret,
    });
    const h = await invoke(null, 'interventionHistory', { missionId: 'mis-a' });
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].action, 'member.messaged');
    assert.equal(h.entries[0].memberName, 'coder');
    // 整个返回体里都不该出现正文
    assert.equal(JSON.stringify(h).includes(secret), false,
      'the message body must never reach the audit log');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('intervene: an unbound mission fails clearly (no team to intervene in)', async () => {
  const { invoke, dir } = setup({ bound: false });
  try {
    const r = await invoke(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'interrupt', memberName: 'coder',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SESSION_NOT_BOUND');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('intervene: a rejected prompt is a failure, not a soft success', async () => {
  const { invoke, dir } = setup({ promptResult: { ok: false, reason: 'runtime busy' } });
  try {
    const r = await invoke(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'interrupt', memberName: 'coder',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PROMPT_FAILED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('intervene: invalid kind / empty message / missing member are rejected', async () => {
  const { invoke, dir } = setup();
  try {
    assert.equal((await invoke(null, 'interveneMember', { missionId: 'mis-a', kind: 'nuke', memberName: 'x' })).code, 'INTERVENTION_KIND_INVALID');
    assert.equal((await invoke(null, 'interveneMember', { missionId: 'mis-a', kind: 'message', memberName: 'x' })).code, 'MESSAGE_REQUIRED');
    assert.equal((await invoke(null, 'interveneMember', { missionId: 'mis-a', kind: 'message', memberName: '', message: 'hi' })).code, 'MEMBER_NAME_REQUIRED');
    assert.equal((await invoke(null, 'interveneMember', { missionId: 'mis-a', kind: 'message', memberName: 'x', message: 'a'.repeat(4001) })).code, 'MESSAGE_TOO_LONG');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
