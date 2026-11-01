// test/brief-sync-guards.test.js — Brief 同步的两个真实风险防护。
//
// 第一性原理：这两个防护是从**验证过程**里发现的，不是想出来的
//
//   验证"Brief 是否被下次会话读到"时读了官方源码
//   @deepseek-ai/dsh-agent-instructions，发现两件事：
//
//   1. 项目根判定标记是 `.git` —— 没有 .git 的目录可能不被识别为项目根，
//      于是 `<workspace>/AGENTS.md` **根本不会被加载**。
//   2. 单个指令文件上限 1 MiB —— 超了会被忽略。
//
//   两者的共同点是**静默失效**：Brief 写成功了，但永远不会生效，
//   用户收不到任何提示。这类失败比报错危险得多。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const brief = require('../src/mission/brief-sync.js');
const { syncToWorkspace, inspectWorkspaceRoot, MAX_INSTRUCTION_BYTES } = brief;

function tmpWs({ git = true, prefix = 'brief-guard-' } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (git) fs.mkdirSync(path.join(d, '.git'));
  return d;
}

// ==================================================== 风险 1：没有 .git

test('brief guard: a workspace WITHOUT .git is flagged (silent no-op is the danger)', () => {
  const d = tmpWs({ git: false });
  const r = inspectWorkspaceRoot(d);
  assert.deepStrictEqual(r.looksLikeRoot, false);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /no \.git/);
  assert.match(r.warnings[0], /may not be loaded/);
});

test('brief guard: a workspace WITH .git is not flagged', () => {
  const r = inspectWorkspaceRoot(tmpWs());
  assert.strictEqual(r.looksLikeRoot, true);
  assert.deepStrictEqual(r.warnings, []);
});

test('brief guard: sync still SUCCEEDS without .git, but carries the warning', () => {
  // 不能因为"可能不生效"就拒绝写入——用户可能就是想要个非 git 目录。
  // 正确做法是写进去，同时把风险告诉调用方。
  const d = tmpWs({ git: false });
  const r = syncToWorkspace({ workspaceDir: d, briefText: '一些内容' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /no \.git/);
});

test('brief guard: no warning when the workspace is a git root', () => {
  const d = tmpWs();
  const r = syncToWorkspace({ workspaceDir: d, briefText: '一些内容' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.warnings, []);
});

test('brief guard: a nested git repo still counts as a root', () => {
  // 官方的 projectRootMarkers 是"存在 .git"，不是"是顶层仓库"。
  const d = tmpWs({ git: false });
  fs.mkdirSync(path.join(d, 'nested', '.git'), { recursive: true });
  assert.strictEqual(inspectWorkspaceRoot(path.join(d, 'nested')).looksLikeRoot, true);
});

// ==================================================== 风险 2：大小上限

test('brief guard: the 1 MiB limit matches the official DEFAULT_MAX_SOURCE_BYTES', () => {
  assert.strictEqual(MAX_INSTRUCTION_BYTES, 1048576);
});

test('brief guard: oversized content is REJECTED, not written', () => {
  // 超限时官方会忽略整个文件 —— 写进去等于"看起来成功，实际没生效"。
  const d = tmpWs();
  const huge = 'x'.repeat(MAX_INSTRUCTION_BYTES + 100);
  const r = syncToWorkspace({ workspaceDir: d, briefText: huge });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'INSTRUCTION_TOO_LARGE');
  assert.match(r.reason, /over the runtime limit/);
  // 文件不该被写出来
  assert.strictEqual(fs.existsSync(path.join(d, 'AGENTS.md')), false);
});

test('brief guard: content just under the limit is accepted', () => {
  const d = tmpWs();
  // 留出标记块本身的开销
  const r = syncToWorkspace({ workspaceDir: d, briefText: 'x'.repeat(MAX_INSTRUCTION_BYTES - 5000) });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.statSync(path.join(d, 'AGENTS.md')).size <= MAX_INSTRUCTION_BYTES);
});

test('brief guard: oversized is measured in BYTES, not characters', () => {
  // 中文一个字 3 字节。用 length 判断会漏掉这种超限。
  const d = tmpWs();
  const r = syncToWorkspace({ workspaceDir: d, briefText: '汉'.repeat(MAX_INSTRUCTION_BYTES / 2) });
  assert.strictEqual(r.ok, false, 'byte length must be used, not string length');
  assert.strictEqual(r.code, 'INSTRUCTION_TOO_LARGE');
});

// ==================================================== 不破坏既有行为

test('brief guard: existing sync behaviour is unchanged for normal cases', () => {
  const d = tmpWs();
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# 用户内容\n');
  const r1 = syncToWorkspace({ workspaceDir: d, briefText: '第一条' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.action, 'appended');
  // 幂等
  const r2 = syncToWorkspace({ workspaceDir: d, briefText: '第一条' });
  assert.strictEqual(r2.action, 'unchanged');
  // 用户内容还在
  assert.ok(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8').includes('# 用户内容'));
});
