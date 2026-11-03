// test/mission-audit-persistence.test.js — 干预审计跨重启（S6）。
//
// 第一性原理：只活一次进程的审计等于没有审计
//
//   审计的全部价值在"事后回看"：用户过十分钟想不起来自己停过什么。
//   如果它只存在内存环里，那么 app 一重启就全没了 ——
//   而那恰恰是最需要它的时候。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');
const { createMissionStore } = require('../src/mission/store.js');

/**
 * 建一套 IPC。调用两次即模拟"重启"：内存全新，工作区不变。
 */
function freshIpc(dir) {
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock: () => 5000,
      log: () => {},
      snapshotOf: () => null,
      cancelSession: async () => ({ ok: true }),
    },
  );
  return handlers.get('mission:invoke');
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-persist-'));
  const s = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
  s.append('mission.created', {
    missionId: 'mis-a', title: 't', intent: 'i', status: 'active',
    workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2,
  });
  return { dir, invoke: freshIpc(dir) };
}

test('audit persists: a pause is still visible after a simulated restart', async () => {
  const { dir, invoke } = setup();
  try {
    await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'paused' });

    // 重启：全新 IPC、全新内存环
    const invoke2 = freshIpc(dir);
    const h = await invoke2(null, 'interventionHistory', { missionId: 'mis-a' });
    assert.equal(h.ok, true);
    assert.equal(h.entries.length, 1, 'the audit must survive the restart');
    assert.equal(h.entries[0].action, 'mission.paused');
    // 关键证据：内存里是空的，所以这条一定来自磁盘
    assert.equal(h.stats.disk.memoryRows, 0, 'proves the entry came from disk, not memory');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit persists: member interventions are recorded too', async () => {
  const { dir, invoke } = setup();
  try {
    // 需要绑定会话才能干预成员
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dsh', 'mission-sessions.json'),
      JSON.stringify({ version: 1, sessions: { 'mis-a': { sessionId: 'session-x', boundAtMs: 1 } } }),
    );
    const withPrompt = (() => {
      const handlers = new Map();
      registerMissionIpc(
        { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
        {
          workspaceDirOf: () => dir,
          clock: () => 5000,
          log: () => {},
          snapshotOf: () => null,
          promptSession: async () => ({ ok: true }),
        },
      );
      return handlers.get('mission:invoke');
    })();
    await withPrompt(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'interrupt', memberName: 'coder',
    });
    const h = await freshIpc(dir)(null, 'interventionHistory', { missionId: 'mis-a' });
    assert.ok(h.entries.some((e) => e.action === 'member.interrupted'));
    assert.ok(h.entries.some((e) => e.memberName === 'coder'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit persists: the message BODY never reaches the audit file', async () => {
  // 隐私铁律：审计记录"做了什么"，不记录"说了什么"。
  const { dir } = setup();
  const secret = '这是不该出现在审计文件里的正文 ZZZ999';
  try {
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dsh', 'mission-sessions.json'),
      JSON.stringify({ version: 1, sessions: { 'mis-a': { sessionId: 'session-x', boundAtMs: 1 } } }),
    );
    const handlers = new Map();
    registerMissionIpc(
      { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
      {
        workspaceDirOf: () => dir, clock: () => 5000, log: () => {},
        snapshotOf: () => null, promptSession: async () => ({ ok: true }),
      },
    );
    const invoke = handlers.get('mission:invoke');
    await invoke(null, 'interveneMember', {
      missionId: 'mis-a', kind: 'message', memberName: 'coder', message: secret,
    });
    // 直接读磁盘上的文件，而不是通过 API —— 要确保它在磁盘上就不存在
    const raw = fs.readFileSync(path.join(dir, '.dsh', 'interventions.jsonl'), 'utf8');
    assert.equal(raw.includes('ZZZ999'), false, 'the message body must never be written to disk');
    assert.ok(raw.includes('member.messaged'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit persists: history is filtered by mission', async () => {
  const { dir, invoke } = setup();
  try {
    const s = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
    s.append('mission.created', {
      missionId: 'mis-b', title: 't2', intent: 'i', status: 'active',
      workspaceId: 'ws-1', createdAtMs: 3, updatedAtMs: 4,
    });
    await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'paused' });
    await invoke(null, 'updateStatus', { missionId: 'mis-b', to: 'paused' });

    const a = await freshIpc(dir)(null, 'interventionHistory', { missionId: 'mis-a' });
    assert.equal(a.entries.length, 1);
    assert.equal(a.entries[0].missionId, undefined, 'missionId is not echoed in the shaped entry');
    const all = await freshIpc(dir)(null, 'interventionHistory', {});
    assert.equal(all.entries.length, 2, 'unfiltered history shows both');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
