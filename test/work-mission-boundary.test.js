// test/work-mission-boundary.test.js — `src/work` 与 Mission 的边界契约。
//
// 第一性原理：为什么这条规则必须变成测试而不是只写在文档里
//
//   repo-map.md §4.6 明确："能变成测试的架构规则就写成测试，不要只写在文档里"。
//
//   这条规则尤其需要机械化，因为它是**反直觉**的：
//   用户会自然期望"我能不能同时跑两个任务"——答案是"能，但要分成两个 workspace"。
//   而开发者在看到 `WORK_BUSY` 时，第一反应往往是"这是个限制，应该去掉"。
//
//   去掉它就等于让两个执行共享同一个工作区基线，于是：
//     · captureDiff() 分不清改动属于哪个 item
//     · runVerification() 的成败归属不明
//     · 产物 key = ${jobId}:${kind} 会跨 item 串味
//   这不是"实现难度"问题，而是**语义上无法定义**。
//
//   所以这里把 domain-model §5.2 的硬契约逐条钉死。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ------------------------------------------------- 契约 1：存储完全隔离

test('boundary: work and mission NEVER share storage', () => {
  // 共享存储 = 两个事实作者。这是最容易在"顺手复用"时破坏的一条。
  const workStore = read('src/work/workspace-store.js');
  const missionStore = read('src/mission/store.js');

  // work 用 .dsh/index.json
  assert.match(workStore, /INDEX_FILE = 'index\.json'/);
  // mission 用 .dsh/mission/events.jsonl
  assert.match(missionStore, /path\.join\(workspaceDir, '\.dsh', 'mission'\)/);
  assert.match(read('src/mission/event-log.js'), /LOG_FILE_NAME = 'events\.jsonl'/);

  // mission 的目录必须是 work 目录的**子目录**下的独立子目录，
  // 而不是与 index.json 同一个文件
  assert.ok(!missionStore.includes("INDEX_FILE"), 'mission must not reuse the work index file');
  assert.ok(!missionStore.includes("workspace-store"), 'mission must not require the work store');
});

test('boundary: src/mission/** never requires src/work/**', () => {
  // domain-model §5.2 契约 2。方向性依赖一旦建立就很难撤销。
  const missionDir = path.join(ROOT, 'src', 'mission');
  const files = fs.readdirSync(missionDir).filter((n) => n.endsWith('.js'));
  const violations = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(missionDir, file), 'utf8');
    // 只检查真实 require，不检查注释
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/require\(['"][^'"]*\/work\//.test(code)) violations.push(file);
  }
  assert.deepEqual(violations, [], 'mission must not depend on the work module (wrong direction)');
});

// --------------------------------------- 契约 2：work 保持单实例约束

test('boundary: work keeps its SINGLE-ACTIVE constraint (it is semantic, not incidental)', () => {
  const src = read('src/work/work-controller.js');
  assert.match(src, /let currentId = null;/, 'the single-active pointer must exist');
  assert.match(src, /WORK_BUSY/, 'and the busy rejection must exist');
  // 基线是单份内存状态 —— 多并行会让它失去归属
  assert.match(src, /let baseline = null;/);
  assert.match(src, /let baselineItemId = null;/);
});

test('boundary: currentId is NOT an array (removing the constraint would break diff attribution)', () => {
  const src = read('src/work/work-controller.js');
  assert.doesNotMatch(src, /let currentIds = \[/, 'a multi-value currentId would make diff ownership undefined');
  assert.doesNotMatch(src, /currentIds\./, 'no multi-active bookkeeping may exist');
});

// ------------------------------- 契约 3：Mission 可以有多个 workstream

test('boundary: Mission allows MANY workstreams per mission (no parallel limit)', () => {
  // 规划层多并行是正确的；受限的是执行层。
  const projection = require('../src/mission/projection.js');
  const events = [
    { seq: 1, type: 'mission.created', atMs: 1, payload: { missionId: 'mis-a', title: 'A', intent: 'I', status: 'active', workspaceId: 'w', createdAtMs: 1, updatedAtMs: 1 } },
    { seq: 2, type: 'workstream.created', atMs: 2, payload: { workstreamId: 'ws-1', missionId: 'mis-a', title: 'W1', status: 'active', createdAtMs: 2, updatedAtMs: 2 } },
    { seq: 3, type: 'workstream.created', atMs: 3, payload: { workstreamId: 'ws-2', missionId: 'mis-a', title: 'W2', status: 'active', createdAtMs: 3, updatedAtMs: 3 } },
    { seq: 4, type: 'workstream.created', atMs: 4, payload: { workstreamId: 'ws-3', missionId: 'mis-a', title: 'W3', status: 'active', createdAtMs: 4, updatedAtMs: 4 } },
  ];
  const { projection: p } = projection.fold(events);
  const view = projection.missionView(p, 'mis-a');
  assert.strictEqual(view.workstreams.length, 3, 'three workstreams under one mission is fine');
});

test('boundary: the mission schema has NO single-workstream constraint', () => {
  const schema = read('src/mission/schema.js');
  assert.doesNotMatch(schema, /currentFocusWorkstreamId.*must be the only/,
    'a focus pointer is a UI preference, not an exclusivity constraint');
  assert.match(schema, /workstreamIds/, 'the plural index field proves N is expected');
});

// ------------------------------------------ 契约 4：TaskRef 是引用不是副本

test('boundary: TaskRef references the harness, it does NOT copy work item state', () => {
  // domain-model §5.2 契约 3：跨层只传派生引用。
  const schema = require('../src/mission/schema.js');
  const base = { taskRefId: 'tr-1', missionId: 'mis-a', workstreamId: 'ws-1', harnessRef: 'exec-run:abc' };
  assert.deepStrictEqual(schema.validateTaskRef(base).errors, []);

  // 携带 work 的 item 状态就是"两个事实作者"
  const copied = schema.validateTaskRef({ ...base, status: 'running' });
  assert.strictEqual(copied.ok, false);
  assert.match(copied.errors.join(' '), /must NOT carry a status/);
});

// -------------------------------------------- 文档与代码必须一致

test('boundary: domain-model §5.2 exists and states the contract', () => {
  // 规则写在文档里但没有测试 = 会腐烂。这条确保文档没被删掉。
  const doc = read('docs/architecture/domain-model.md');
  assert.match(doc, /### 5\.2 `src\/work` 的定位契约/);
  assert.match(doc, /一次只跑一个 Team 执行/, 'the WORK_BUSY meaning must be stated');
  assert.match(doc, /1—N` 引用，不是替换/, 'the relationship must be stated');
});

test('boundary: tech-debt TD-15 is marked as no longer standing', () => {
  const doc = read('docs/quality/tech-debt-inventory.md');
  const idx = doc.indexOf('### TD-15');
  assert.ok(idx !== -1, 'TD-15 must still be documented (history matters)');
  const section = doc.slice(idx, idx + 3000);
  assert.match(section, /不成立/, 'TD-15 must record that the original assessment was wrong');
  assert.match(section, /2026-11-01/, 'and when it was corrected');
});
