// test/brief-cross-session-acceptance.test.js — 跨会话验收探针的离线守卫。
//
// 第一性原理：这个探针最容易犯的错是"证明了自己想证明的东西"
//
//   它要证明"模型真的读了 AGENTS.md"。三种假通过的方式：
//     1. 用可猜测的暗号（比如固定字符串）→ 模型可能从别处看到
//     2. 不真的建会话/发 prompt，只看文件写没写 → 那只是第一层证据
//     3. 前置条件缺失时仍然"通过" → 绿了一路但结果是错的（本轮真踩过）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'brief-cross-session-acceptance.js');
const raw = fs.readFileSync(PROBE, 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('brief e2e: the token is RANDOM (a fixed one could be guessed)', () => {
  assert.match(src, /randomBytes/, 'the token must be random per run');
  assert.match(src, /ZEBRA-/, 'and clearly a marker');
});

test('brief e2e: it really creates a session and sends a prompt', () => {
  assert.match(src, /session\/create/, 'it must create a real session');
  assert.match(src, /session\/prompt/, 'and send a real prompt');
});

test('brief e2e: it subscribes to the follow stream (page alone cannot see deltas)', () => {
  // 第一版只轮询 session/page，永远只能看到 seq=0 的初始事件。
  assert.match(src, /session\/follow/, 'it must subscribe to the session/follow stream');
});

test('brief e2e: it seeds .git so the workspace counts as a project root', () => {
  // 官方用 .git 判定项目根；没有它 AGENTS.md 可能不被加载。
  assert.match(src, /mkdirSync\(path\.join\(WS, '\.git'\)\)/);
});

test('brief e2e: it ensures a model provider is configured before starting', () => {
  // 本轮踩过的坑：key 在但 provider route 不在 → 每一步成功但链路不通。
  assert.match(src, /settings\.yaml/, 'it must write the provider route');
  assert.match(src, /apiKeyEnv/, 'and declare the credential ref');
});

test('brief e2e: it uses the REAL brief sync (not a hand-written file)', () => {
  assert.match(src, /require\(path\.join\(REPO, 'src', 'mission', 'brief-sync\.js'\)\)/);
  assert.match(src, /syncToWorkspace/);
});

test('brief e2e: it also checks the user content is preserved', () => {
  assert.match(src, /用户内容不许丢/);
});

test('brief e2e: it uses unary-over-HTTP with the _request envelope', () => {
  // 0.2.1 的 unary 走 HTTP，且 args 必须包 _request。
  assert.match(src, /type: 'client-request'/);
  assert.match(src, /payload: \{ args \}/);
});

test('brief e2e: the exit code reflects pass/fail', () => {
  assert.match(src, /process\.exit\(failed === 0 \? 0 : 1\)/);
});

test('brief e2e: the probe stays out of the CI test glob', () => {
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
