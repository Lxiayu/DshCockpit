// test/mission-harvest-deliverables.test.js — 产物「收获」的安全约束
//
// 第一性原理：这个功能最危险的失败模式是
// **把 Agent 的自述当成事实登记进 Mission**。
//
//   Agent 说"我生成了 docs/report.md" —— 这句话不是证据。
//   文件可能根本没创建、创建在别处、或者被后续步骤删了。
//
// 所以本文件断言的都是"**拒绝**"：不存在的文件一个都不许登记。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerMissionIpc } = require('../src/ipc-mission.js');

/** 造一个隔离的 mission 环境，返回可调用的 handler + workspace。 */
function makeEnv({ reply, files = {} }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  let handler = null;
  registerMissionIpc(
    { handle: (_ch, fn) => { handler = fn; } },
    {
      workspaceDirOf: () => ws,
      snapshotOf: () => null,
      log: () => {},
      ensureSession: async () => ({ ok: true, sessionId: 'session-test' }),
      promptSession: async () => ({ ok: true }),
      projectionsOf: async () => ({
        ok: true,
        value: { values: { turnOutline: reply === null ? [] : [{ turn: 1, response: reply }] } },
      }),
    },
  );
  return { ws, call: (action, payload) => handler(null, action, payload) };
}

async function startMission(env) {
  const c = await env.call('create', { title: 'T', intent: 'I', workspaceId: 'w' });
  await env.call('startWork', { missionId: c.missionId, task: '干活' });
  return c.missionId;
}

test('harvest registers ONLY files that really exist', async () => {
  const env = makeEnv({
    reply: '报告在 docs/real.md，另外 docs/ghost.md 是假的',
    files: { 'docs/real.md': '# real' },
  });
  const id = await startMission(env);
  const r = await env.call('harvestDeliverables', { missionId: id });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.added.map((a) => a.relPath), ['docs/real.md']);
  // 提到的假文件必须被如实记录为 skipped
  assert.deepStrictEqual(r.skipped.map((s) => s.relPath), ['docs/ghost.md']);
  // ★ 必须是因为**文件不存在**而跳过，而不是别的下游原因。
  //   如果只断言"被跳过"，那么 stat 检查被删掉时（后面 readFile 也会失败）
  //   测试照样通过 —— 那就是假测试。
  assert.strictEqual(r.skipped[0].reason, 'file not found in workspace',
    'the skip must come from the existence check itself, not a downstream failure');
});

test('harvest registers NOTHING when no mentioned file exists', async () => {
  const env = makeEnv({ reply: '我生成了 docs/a.md 和 src/b.js', files: {} });
  const id = await startMission(env);
  const r = await env.call('harvestDeliverables', { missionId: id });
  assert.deepStrictEqual(r.added, []);
  assert.strictEqual(r.skipped.length, 2);
  for (const sk of r.skipped) {
    assert.strictEqual(sk.reason, 'file not found in workspace',
      `${sk.relPath} must be rejected by the existence check`);
  }
});

test('harvest computes a real digest, not the agent words', async () => {
  const env = makeEnv({ reply: '见 docs/r.md', files: { 'docs/r.md': '# 内容' } });
  const id = await startMission(env);
  const r = await env.call('harvestDeliverables', { missionId: id });
  assert.strictEqual(r.added.length, 1);
  // digest 必须是真实文件内容的 sha256 前缀
  const expected = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(env.ws, 'docs/r.md'))).digest('hex');
  assert.strictEqual(r.added[0].digest, expected.slice(0, 16));
});

test('harvest is idempotent (calling twice does not duplicate)', async () => {
  const env = makeEnv({ reply: '见 docs/r.md', files: { 'docs/r.md': 'x' } });
  const id = await startMission(env);
  await env.call('harvestDeliverables', { missionId: id });
  const second = await env.call('harvestDeliverables', { missionId: id });
  assert.deepStrictEqual(second.added, []);
  assert.match(second.skipped[0].reason, /already registered/);
});

test('harvest rejects absolute paths and .. escapes', async () => {
  const env = makeEnv({
    reply: '写到了 /etc/passwd 和 ../outside/secret.md 和 docs/ok.md',
    files: { 'docs/ok.md': 'ok' },
  });
  const id = await startMission(env);
  const r = await env.call('harvestDeliverables', { missionId: id });
  // 只有 workspace 内的相对路径能被考虑
  assert.deepStrictEqual(r.added.map((a) => a.relPath), ['docs/ok.md']);
  // ★ 绝对路径和 .. 必须**在处理前就被过滤掉**，不能只是"下游拒绝了"。
  //   否则 filter 被删掉时测试照过 —— 又是假测试。
  //   证据：它们不应出现在 mentionedTotal 的候选里被 stat 过。
  assert.strictEqual(r.mentionedTotal, 1,
    'absolute paths and .. must be filtered BEFORE they are considered');
});

test('harvest reports honestly when there is no reply yet', async () => {
  const env = makeEnv({ reply: null });
  const id = await startMission(env);
  const r = await env.call('harvestDeliverables', { missionId: id });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.added, []);
  assert.match(String(r.reason), /no turns yet/);
});

test('harvest refused when no session is bound', async () => {
  const env = makeEnv({ reply: 'x' });
  const c = await env.call('create', { title: 'T', intent: 'I', workspaceId: 'w' });
  const r = await env.call('harvestDeliverables', { missionId: c.missionId });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NOT_BOUND');
});

test('a bare filename is NOT enough (we cannot know where it lives)', async () => {
  const env = makeEnv({ reply: '我更新了 README.md', files: { 'README.md': 'x' } });
  const id = await startMission(env);
  const r = await env.call('harvestDeliverables', { missionId: id });
  // 没有目录信息的路径不登记——位置不确定就别猜
  assert.deepStrictEqual(r.added, []);
});
