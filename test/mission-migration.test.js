// test/mission-migration.test.js — P1：schema 版本迁移。
//
// 第一性原理：这组测试直接对照 src/work 已知的失败模式
//
//   Issue #12 记录了 work 模块的现状：
//     · `schemaVersion !== 1` 直接 fail-closed → 用户升级后旧数据不可读
//     · 索引损坏 → 刻意不重建 → 数据永久不可读
//     · 无 .bak
//   结果是**版本一变就等于数据丢失**，且没有逃生路径。
//
//   Mission Core 不能重犯。所以这里锁死：
//     1. 迁移是纯函数（可 dry-run、可预览、不碰磁盘）
//     2. 未知的**更高**版本必须明确拒绝，而不是"尽力而为"改坏未来数据
//     3. 混杂版本必须拒绝，而不是猜
//     4. 迁移永不丢弃事件
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('../src/mission/migration.js');
const eventLog = require('../src/mission/event-log.js');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mig-'));
  return path.join(dir, 'events.jsonl');
}

// ------------------------------------------------------------- 版本探测

test('migration: a uniformly-versioned log reports that version', () => {
  const r = m.detectVersion([{ schemaVersion: 1, seq: 1 }, { schemaVersion: 1, seq: 2 }]);
  assert.strictEqual(r.version, 1);
  assert.strictEqual(r.mixed, false);
});

test('migration: events without schemaVersion are detected as v0', () => {
  const r = m.detectVersion([{ seq: 1 }, { seq: 2 }]);
  assert.strictEqual(r.version, 0);
  assert.strictEqual(r.mixed, false);
});

test('migration: a MIXED-version log is flagged (never silently normalised)', () => {
  // 混杂说明日志被不同版本的壳写过——继续迁移会掩盖真实问题。
  const r = m.detectVersion([{ seq: 1 }, { schemaVersion: 1, seq: 2 }]);
  assert.strictEqual(r.mixed, true);
  assert.strictEqual(r.version, null);
  assert.deepEqual(r.versions, [0, 1]);
});

test('migration: an empty log is treated as current (nothing to migrate)', () => {
  assert.strictEqual(m.detectVersion([]).version, m.CURRENT_VERSION);
});

// ------------------------------------------------------------- 版本链

test('migration: the step chain is CONTINUOUS from 0 to current', () => {
  // 版本链必须连续（0→1→2…），不能有跳跃。缺环意味着某些用户的数据无法升级。
  const chain = m.chainOf(0);
  assert.ok(chain, 'a chain from v0 must exist');
  assert.strictEqual(chain[0].from, 0);
  let expectedFrom = 0;
  for (const step of chain) {
    assert.strictEqual(step.from, expectedFrom, 'chain must be contiguous');
    assert.strictEqual(step.to, expectedFrom + 1, 'each step advances exactly one version');
    expectedFrom = step.to;
  }
  assert.strictEqual(expectedFrom, m.CURRENT_VERSION, 'the chain must reach CURRENT_VERSION');
});

test('migration: chainOf(current) is empty (nothing to do)', () => {
  assert.deepEqual(m.chainOf(m.CURRENT_VERSION), []);
});

test('migration: chainOf a future version returns null (no downgrade path exists)', () => {
  assert.strictEqual(m.chainOf(m.CURRENT_VERSION + 1), null);
});

// ------------------------------------------------------------- 迁移语义

test('migration: a current-version log needs no write', () => {
  const r = m.migrateEvents([{ schemaVersion: 1, seq: 1, type: 'x' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needsWrite, false);
  assert.deepEqual(r.steps, []);
});

test('migration: a v0 log is migrated and the steps are reported', () => {
  const r = m.migrateEvents([{ seq: 1, type: 'x', payload: {} }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.from, 0);
  assert.strictEqual(r.to, m.CURRENT_VERSION);
  assert.deepEqual(r.steps, ['v0→v1']);
  assert.strictEqual(r.needsWrite, true);
  assert.strictEqual(r.events[0].schemaVersion, 1, 'the migrated event carries the new version');
});

test('migration: NEVER drops events (only adds what is needed)', () => {
  // 迁移丢事件 = 静默的数据丢失，这是最不可接受的失效模式。
  const input = [
    { seq: 1, type: 'a', payload: { x: 1 } },
    { seq: 2, type: 'b', payload: { y: 2 } },
    { seq: 3, type: 'c', payload: { z: 3 } },
  ];
  const r = m.migrateEvents(input);
  assert.strictEqual(r.events.length, input.length);
  assert.deepEqual(r.events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(r.events[2].payload, { z: 3 }, 'payload content is preserved');
});

test('migration: unknown fields are PRESERVED (forward compatibility)', () => {
  // 旧壳读新数据时，不理解字段也要原样保留——否则用户在两个版本间来回切会丢数据。
  const r = m.migrateEvents([{ seq: 1, type: 'x', futureField: { nested: true } }]);
  assert.deepEqual(r.events[0].futureField, { nested: true });
});

test('migration: a FUTURE version is refused with an upgrade instruction (never guess)', () => {
  // "尽力而为"地迁移未来数据 = 把它改坏，且用户不知道为什么。
  const r = m.migrateEvents([{ schemaVersion: 99, seq: 1, type: 'x' }]);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /NEWER than this build supports/);
  assert.match(r.reason, /upgrade the app/);
  assert.deepEqual(r.events, [{ schemaVersion: 99, seq: 1, type: 'x' }], 'the input must be untouched');
});

test('migration: a MIXED log is refused instead of guessed', () => {
  const r = m.migrateEvents([{ seq: 1 }, { schemaVersion: 1, seq: 2 }]);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /mixed schema versions/);
});

test('migration: migration is a PURE function (input not mutated)', () => {
  const input = [{ seq: 1, type: 'x', payload: { a: 1 } }];
  const snapshot = JSON.stringify(input);
  m.migrateEvents(input);
  assert.strictEqual(JSON.stringify(input), snapshot, 'the caller\'s array must be untouched');
});

test('migration: running migrate twice is idempotent', () => {
  const once = m.migrateEvents([{ seq: 1, type: 'x', payload: {} }]);
  const twice = m.migrateEvents(once.events);
  assert.strictEqual(twice.ok, true);
  assert.strictEqual(twice.needsWrite, false, 'a second run finds nothing to do');
  assert.deepEqual(twice.events, once.events);
});

// --------------------------------------------------------------- dry-run

test('migration: plan() reports what WOULD happen without returning the migrated data', () => {
  const p = m.plan([{ seq: 1 }, { seq: 2 }]);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.eventCount, 2);
  assert.deepEqual(p.steps, ['v0→v1']);
  assert.strictEqual(p.needsWrite, true);
  assert.ok(!('events' in p), 'a dry-run must not hand back migrated data (no accidental writes)');
});

test('migration: planFile() reads the log and blocks when there are bad lines', () => {
  // 有坏行时迁移结果不可信——必须先修损坏，否则会把"半份数据"当成完整来迁移。
  const f = tmpFile();
  eventLog.appendEvents(f, [{ seq: 1, type: 'x', payload: {} }]);
  fs.appendFileSync(f, 'broken\n');

  const p = m.planFile(f);
  assert.strictEqual(p.blocked, true);
  assert.strictEqual(p.badLines, 1);
  assert.match(p.reason, /repair before migrating/);
});

test('migration: planFile() on a missing log is a no-op', () => {
  const p = m.planFile(tmpFile());
  assert.strictEqual(p.eventCount, 0);
  assert.strictEqual(p.blocked, false);
  assert.strictEqual(p.needsWrite, false);
});
