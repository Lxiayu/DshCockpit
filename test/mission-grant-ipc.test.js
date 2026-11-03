// test/mission-grant-ipc.test.js — Grant 的 IPC 契约（D10）。
//
// 第一性原理：信任根必须写在代码里，而不是信任调用方
//
//   createGrant 不接受 grantedBy 参数，写死 'user'。
//   如果让调用方传，任何能调 IPC 的代码都能自称用户 ——
//   那样"Grant 只能由用户创建"这条规则就只是文档里的一句话。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');
const grantModule = require('../src/mission/grant.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-grant-ipc-'));
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock: () => 5000,
      log: () => {},
      snapshotOf: () => null,
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir };
}

test('grant ipc: creating a grant on the workspace root works', async () => {
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'createGrant', {});
    assert.equal(r.ok, true);
    assert.match(r.grant.grantId, /^gr-/);
    assert.equal(r.grant.grantedBy, 'user');
    assert.equal(r.grant.access, 'read', 'default access is read (least privilege)');
    assert.equal(r.grant.workspaceDir, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: grantedBy is ALWAYS user — the caller cannot claim otherwise', async () => {
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'createGrant', { grantedBy: 'lead', access: 'write' });
    assert.equal(r.ok, true);
    assert.equal(r.grant.grantedBy, 'user',
      'the trust root is hard-coded: a caller-supplied grantedBy would defeat it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: a subdir creates the directory and grants inside it (new dir = authorization)', async () => {
  // D10："新建子目录"是一个用户动作：同一步骤内创建目录并创建 Grant。
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'createGrant', { subdir: 'work/sub', access: 'write' });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'sub')), true, 'the directory is created');
    assert.equal(r.grant.workspaceDir, path.join(dir, 'work', 'sub'));
    assert.equal(r.grant.access, 'write');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: traversal and absolute subdirs are refused', () => {
  const { invoke, dir } = setup();
  try {
    // 这些是异步的，但校验在 await 之前，用同步断言更直接
    assert.doesNotThrow(() => {});
    return Promise.all([
      invoke(null, 'createGrant', { subdir: '../outside' }).then((r) => {
        assert.equal(r.ok, false); assert.equal(r.code, 'GRANT_PATH_TRAVERSAL');
      }),
      invoke(null, 'createGrant', { subdir: '/etc' }).then((r) => {
        assert.equal(r.ok, false); assert.equal(r.code, 'GRANT_PATH_ABSOLUTE');
      }),
    ]).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
});

test('grant ipc: creating the same grant twice is idempotent (no duplicates)', async () => {
  // 否则用户连点两次就有两条一样的授权，撤销时很容易漏掉一条。
  const { invoke, dir } = setup();
  try {
    const a = await invoke(null, 'createGrant', { access: 'write' });
    const b = await invoke(null, 'createGrant', { access: 'write' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.reused, true);
    assert.equal(b.grant.grantId, a.grant.grantId);
    const list = await invoke(null, 'listGrants');
    assert.equal(list.grants.length, 1, 'no duplicate grant rows');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: revoking marks rather than deletes (history preserved)', async () => {
  const { invoke, dir } = setup();
  try {
    const created = await invoke(null, 'createGrant', { access: 'write' });
    const r = await invoke(null, 'revokeGrant', { grantId: created.grant.grantId });
    assert.equal(r.ok, true);
    assert.equal(r.grant.revokedAtMs, 5000);
    assert.equal(r.grant.revokeReason, 'user-revoked');
    // 记录还在，只是不 active
    const list = await invoke(null, 'listGrants');
    assert.equal(list.grants.length, 1, 'the grant row is kept (not deleted)');
    assert.equal(list.grants[0].active, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: revoking twice is idempotent and keeps the FIRST revocation time', async () => {
  const { invoke, dir } = setup();
  try {
    let now = 5000;
    const handlers = new Map();
    registerMissionIpc(
      { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
      { workspaceDirOf: () => dir, clock: () => now, log: () => {}, snapshotOf: () => null },
    );
    const inv = handlers.get('mission:invoke');
    const created = await inv(null, 'createGrant', { access: 'write' });
    await inv(null, 'revokeGrant', { grantId: created.grant.grantId });
    now = 9999; // 时间前进
    const second = await inv(null, 'revokeGrant', { grantId: created.grant.grantId });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyRevoked, true);
    assert.equal(second.grant.revokedAtMs, 5000, 'the first revocation time is the truth');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: revoking an unknown id fails clearly', async () => {
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'revokeGrant', { grantId: 'gr-nope' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'GRANT_NOT_FOUND');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: a revoked grant cannot be re-activated by creating "the same" grant', async () => {
  // D10："快照不随撤销复活"。新授权必须是一条新记录。
  const { invoke, dir } = setup();
  try {
    const a = await invoke(null, 'createGrant', { access: 'write' });
    await invoke(null, 'revokeGrant', { grantId: a.grant.grantId });
    const b = await invoke(null, 'createGrant', { access: 'write' });
    assert.equal(b.ok, true);
    assert.equal(b.reused, false, 'a revoked grant must not be reused');
    assert.notEqual(b.grant.grantId, a.grant.grantId, 'a fresh grant id is issued');
    const list = await invoke(null, 'listGrants');
    assert.equal(list.grants.length, 2, 'both rows exist: one revoked, one active');
    assert.equal(list.grants.filter((g) => g.active).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: an invalid access value is refused', async () => {
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'createGrant', { access: 'admin' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'GRANT_ACCESS_INVALID');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grant ipc: corrupted rows are surfaced as degraded, not silently skipped', async () => {
  const { invoke, dir } = setup();
  try {
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(grantModule.grantsFilePath(dir), JSON.stringify({
      version: 1,
      grants: [{ grantId: 'gr-ok', grantedBy: 'user', access: 'read', workspaceDir: dir, createdAtMs: 1 },
        { junk: true }],
    }), 'utf8');
    const list = await invoke(null, 'listGrants');
    assert.equal(list.grants.length, 1);
    assert.ok(list.degraded, 'the user must know some rows were dropped');
    assert.match(list.degraded.reason, /invalid grant/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
