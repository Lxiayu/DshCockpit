// test/mission-projection-limits.test.js — 投影透传的体积与安全边界
//
// ============================================================================
// 为什么需要（2026-11-02 复查发现）
//
//   右栏的 sessionProjections 会把官方投影里的 userQuestions.detail
//   （plan-review 的完整计划 markdown）原样透传到渲染层。
//
//   实测：一个 5MB 的 detail 会**原样穿过 IPC**，没有任何上限。
//   后果：IPC 序列化开销、渲染层内存占用、展开计划时卡顿 ——
//   而 380px 侧栏实际能看的部分很有限。
//
//   修法：64k 字符上限，超出截断 + 显式标记（不能静默丢）。
// ============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerMissionIpc } = require('../src/ipc-mission.js');

function envWithQuestion(q) {
  let handler = null;
  registerMissionIpc(
    { handle: (_c, fn) => { handler = fn; } },
    {
      workspaceDirOf: () => '/tmp/x',
      snapshotOf: () => null,
      log: () => {},
      projectionsOf: async () => ({
        ok: true,
        value: { values: { userQuestions: { active: [{ callId: 'c1', state: 'pending', questions: [q] }], settled: [] } } },
      }),
    },
  );
  return { call: (a, p) => handler(null, a, p) };
}

test('a huge plan detail is truncated, not passed through raw', async () => {
  const env = envWithQuestion({ id: 'q1', question: 'Q', detail: 'x'.repeat(5 * 1024 * 1024) });
  const r = await env.call('sessionProjections', {});
  const got = r.activeQuestions[0].questions[0];
  assert.ok(got.detail.length <= 64 * 1024,
    `detail must be capped at 64k chars, got ${got.detail.length}`);
});

test('truncation is DISCLOSED (detailTruncated + original length)', async () => {
  // 静默截断比截断本身更糟：用户会以为计划就这么短。
  const full = 5 * 1024 * 1024;
  const env = envWithQuestion({ id: 'q1', question: 'Q', detail: 'x'.repeat(full) });
  const r = await env.call('sessionProjections', {});
  const got = r.activeQuestions[0].questions[0];
  assert.strictEqual(got.detailTruncated, true);
  assert.strictEqual(got.detailFullLength, full);
});

test('a normal-sized detail is untouched (no false truncation marks)', async () => {
  const detail = '# 计划\n\n' + 'y'.repeat(1000);
  const env = envWithQuestion({ id: 'q1', question: 'Q', detail });
  const r = await env.call('sessionProjections', {});
  const got = r.activeQuestions[0].questions[0];
  assert.strictEqual(got.detail, detail);
  assert.strictEqual(got.detailTruncated, undefined, 'short details must not be marked truncated');
});

test('questions without a detail survive untouched', async () => {
  const env = envWithQuestion({ id: 'q1', question: '普通提问', options: [{ label: 'A' }] });
  const r = await env.call('sessionProjections', {});
  const got = r.activeQuestions[0].questions[0];
  assert.strictEqual(got.question, '普通提问');
  assert.strictEqual(got.detail, undefined);
});

test('the renderer knows how to show the truncation notice', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const desk = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');
  assert.match(desk, /detailTruncated/,
    'the desk must render the truncation notice, otherwise the cap looks like data loss');
});
