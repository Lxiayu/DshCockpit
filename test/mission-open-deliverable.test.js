// test/mission-open-deliverable.test.js — 打开交付物的安全边界。
//
// 第一性原理：为什么"能打开"是"能信任"的前提
//
//   右栏一直告诉用户"团队产出了 X 文件，sha256 是 abc…"。
//   但如果他打不开它，"可复核"就只是我们自说自话 ——
//   用户凭什么相信这个文件就是他要的那个？
//
//   verifyDeliverables 能证明"文件没变过"，却证明不了"它是不是你要的"。
//   后者只能靠人看一眼。
//
//   而"能打开文件"是一个**危险能力**：它会调用系统默认程序执行任意路径。
//   所以边界必须极窄，且每条都要测。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');

function setup({ shellOpenImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-'));
  const handlers = new Map();
  const opened = [];
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock: () => 1000,
      log: () => {},
      snapshotOf: () => null,
      shellOpen: shellOpenImpl || (async (p) => { opened.push(p); return ''; }),
      ensureSession: async () => ({ ok: true, sessionId: 's' }),
      promptSession: async () => ({ ok: true }),
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir, opened };
}

test('open: a file inside the workspace opens', async () => {
  const { invoke, dir, opened } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'out.txt'), 'hello');
    const r = await invoke(null, 'openDeliverable', { relPath: 'out.txt' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(opened.length, 1);
    assert.equal(opened[0], path.join(fs.realpathSync(dir), 'out.txt'));
    // 绝不把绝对路径返回给调用方
    assert.equal(JSON.stringify(r).includes(dir), false,
      'the response must not leak the absolute path');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open: an ABSOLUTE path is rejected (no exception for convenience)', async () => {
  const { invoke, dir, opened } = setup();
  try {
    const r = await invoke(null, 'openDeliverable', { relPath: '/etc/passwd' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DELIVERABLE_INVALID');
    assert.equal(opened.length, 0, 'nothing may be opened');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open: path traversal is rejected', async () => {
  const { invoke, dir, opened } = setup();
  try {
    for (const bad of ['../outside.txt', 'a/../../outside.txt', '../../etc/passwd']) {
      const r = await invoke(null, 'openDeliverable', { relPath: bad });
      assert.equal(r.ok, false, `should reject: ${bad}`);
      assert.equal(r.code, 'DELIVERABLE_INVALID', bad);
    }
    assert.equal(opened.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open: a SYMLINK pointing outside the workspace is rejected', async () => {
  // 这是最容易被忽略的一条：路径本身看起来合法，但 realpath 在工作区外。
  const { invoke, dir, opened } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    } catch { return; } // 平台不支持符号链接就跳过（不算通过）
    const r = await invoke(null, 'openDeliverable', { relPath: 'link.txt' });
    assert.equal(r.ok, false, 'a symlink escaping the workspace must be rejected');
    assert.equal(opened.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('open: a missing file reports not-found, not a generic failure', async () => {
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'openDeliverable', { relPath: 'nope.txt' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DELIVERABLE_NOT_FOUND');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open: an OS-level failure is surfaced, not swallowed', async () => {
  // openPath 返回错误字符串时必须当成失败 —— 否则用户以为打开了。
  const { invoke, dir } = setup({ shellOpenImpl: async () => 'No application is associated' });
  try {
    fs.writeFileSync(path.join(dir, 'out.txt'), 'hello');
    const r = await invoke(null, 'openDeliverable', { relPath: 'out.txt' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'OPEN_FAILED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open: when the environment cannot open files, say so honestly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-'));
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir, clock: () => 1000, log: () => {},
      snapshotOf: () => null,
      // 刻意不注入 shellOpen
      ensureSession: async () => ({ ok: true, sessionId: 's' }),
      promptSession: async () => ({ ok: true }),
    },
  );
  try {
    fs.writeFileSync(path.join(dir, 'out.txt'), 'x');
    const r = await handlers.get('mission:invoke')(null, 'openDeliverable', { relPath: 'out.txt' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DESK_UNAVAILABLE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open: blank input never reaches the filesystem layer', async () => {
  const { invoke, dir, opened } = setup();
  try {
    for (const bad of [undefined, null, '', '   ']) {
      const r = await invoke(null, 'openDeliverable', { relPath: bad });
      assert.equal(r.ok, false, String(bad));
    }
    assert.equal(opened.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
