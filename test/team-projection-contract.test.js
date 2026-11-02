// test/team-projection-contract.test.js — Team 投影的契约守卫
//
// 第一性原理：Team 投影是 **experimental** 的。
// 官方明说无稳定性保证，所以必须：
//   1. 把当前形状钉死在测试里 → 变了立刻知道
//   2. 缺字段时**如实降级**，不能假装"空团队"
//
// 注意：这些测试**不需要**真实 runtime（团队未启用）。
// 它们钉的是"我们的解析逻辑对形状的处理"，不是"官方一定给这个形状"。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 从官方 .d.ts 里提取类型形状（如果 runtime 已安装）。 */
function officialTypes() {
  const p = path.join(
    require('node:os').homedir(),
    'Library/Application Support/dsh-cockpit/runtime/0.2.1-rc.5',
    'node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/types.d.ts',
  );
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

test('contract: official TeamTask still carries blockedBy + writeScopes + ready', (t) => {
  const src = officialTypes();
  if (!src) return t.skip('runtime .d.ts not installed');
  // 这三个字段是我们整个映射设计的地基。任何一个消失都要立刻知道。
  assert.match(src, /readonly blockedBy: TeamTaskId\[\]/, 'blockedBy is the DAG edge');
  assert.match(src, /readonly writeScopes: string\[\]/, 'writeScopes drives the conflict warning');
  assert.match(src, /readonly ready: boolean/, 'ready tells us if dependencies are met');
  void ROOT;
});

test('contract: TeamProjection still carries failure (stale-state signal)', (t) => {
  const src = officialTypes();
  if (!src) return t.skip('runtime .d.ts not installed');
  // failure 有值时 members/tasks 会停留在"最后一次有效状态"——
  // 那时**不能**把任务列表标为实时。
  assert.match(src, /readonly failure\?: string/);
});

test('contract: TeamTaskStatus vocabulary is what we render', (t) => {
  const src = officialTypes();
  if (!src) return t.skip('runtime .d.ts not installed');
  const m = src.match(/type TeamTaskStatus = ([^;]+);/);
  assert.ok(m, 'TeamTaskStatus must be declared');
  for (const s of ['pending', 'in_progress', 'completed', 'deleted']) {
    assert.ok(m[1].includes(`'${s}'`), `${s} must be a status`);
  }
});

test('contract: ready=false and writeScopes are DIFFERENT concepts', () => {
  // 这是 GPT 指出我们可能写错文案的地方：
  //   ready=false  → 依赖未满足
  //   writeScopes  → 写入路径可能重叠（官方说只是提示，不是锁）
  const doc = fs.readFileSync(path.join(ROOT, 'docs/architecture/team-task-workstream-mapping.md'), 'utf8');
  assert.match(doc, /不能写.*文件已锁定|不是锁/, 'the doc must warn against "locked" wording');
});

test('design: we never copy official task facts into our event log', () => {
  // 铁律 1：官方字段的事实作者是 Harness，我们只存关联。
  const doc = fs.readFileSync(path.join(ROOT, 'docs/architecture/team-task-workstream-mapping.md'), 'utf8');
  assert.match(doc, /不复制|只存.*关联/, 'the design must state we only store the link');
  assert.match(doc, /WorkstreamTaskLink/, 'and must name the link type');
});

test('design: cross-Team dependencies are explicitly out of scope for v1', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/architecture/team-task-workstream-mapping.md'), 'utf8');
  assert.match(doc, /跨 Team|跨Team/, 'must mention it');
  assert.match(doc, /第一版.*不做|不做跨 Team/, 'must say it is not in v1');
});
