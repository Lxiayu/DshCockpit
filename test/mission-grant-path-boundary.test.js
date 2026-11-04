// test/mission-grant-path-boundary.test.js — Grant 目录的隐私边界。
//
// 第一性原理：Grant 是**唯一**合法携带绝对路径的实体，边界必须明确
//
//   AGENTS.md §2.4：绝对路径不进 Office 快照与事实链。
//   但 Grant 必须存目录 —— 否则"我授权了哪个目录"这个问题无法回答，
//   而它正是用户敢不敢离开屏幕的前提。
//
//   所以规则不是"任何地方都不许有路径"，而是：
//     · Grant 表（grants.json）  → **可以有**目录（它是授权的定义）
//     · IPC 返回值               → **可以有**目录（用户要看清楚才能撤销）
//     · Mission 事实链（events.jsonl）→ **绝对不可以**（只存 grantId 引用）
//
//   这条测试就是钉住第三行 —— 它是三者里最容易被破坏的（一次手滑就写进去了）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gpath-'));
  const handlers = new Map();
  const prompts = [];
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir, clock: () => 1000, log: () => {},
      snapshotOf: () => null,
      ensureSession: async () => ({ ok: true, sessionId: 'session-x' }),
      promptSession: async (sid, text) => { prompts.push(text); return { ok: true }; },
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir, prompts };
}

test('boundary: the granted directory NEVER reaches the Mission event log', async () => {
  const { invoke, dir } = setup();
  try {
    const c = await invoke(null, 'create', { title: 't', intent: 'i' });
    const g = await invoke(null, 'createGrant', { access: 'write' });
    await invoke(null, 'saveContract', {
      missionId: c.missionId,
      contract: { acceptance: [{ id: 'a1', text: 'x', kind: 'manual' }], grantId: g.grant.grantId },
    });
    await invoke(null, 'startWork', { missionId: c.missionId, task: 't' });

    const log = path.join(dir, '.dsh', 'mission', 'events.jsonl');
    const raw = fs.readFileSync(log, 'utf8');
    assert.equal(raw.includes(dir), false,
      'the absolute workspace path must never be written to the fact chain');
    assert.equal(raw.includes('workspaceDir'), false,
      'the contract must reference grantId, never the directory itself');
    assert.ok(raw.includes(g.grant.grantId), 'the grantId reference IS expected');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('boundary: the dispatch instruction never contains the absolute directory', async () => {
  // prompt 会进会话历史；路径出现在那里同样是泄露。
  const { invoke, dir, prompts } = setup();
  try {
    const c = await invoke(null, 'create', { title: 't', intent: 'i' });
    const g = await invoke(null, 'createGrant', { access: 'write' });
    await invoke(null, 'saveContract', {
      missionId: c.missionId,
      contract: { acceptance: [{ id: 'a1', text: 'x', kind: 'manual' }], grantId: g.grant.grantId },
    });
    await invoke(null, 'startWork', { missionId: c.missionId, task: 't' });
    assert.equal(prompts[0].includes(dir), false,
      'the instruction must not carry the absolute workspace path');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('boundary: granting is the ONE place an absolute path is legitimately returned', async () => {
  // 反过来说：如果这里也把路径藏了，用户就不知道该撤销哪一条。
  // 所以这是一条"必须存在"的断言，不是"必须不存在"。
  const { invoke, dir } = setup();
  try {
    const g = await invoke(null, 'createGrant', { access: 'write' });
    assert.equal(g.grant.workspaceDir, dir,
      'the grant IPC must expose the directory — the user cannot revoke what they cannot see');
    const list = await invoke(null, 'listGrants');
    assert.equal(list.grants[0].workspaceDir, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
