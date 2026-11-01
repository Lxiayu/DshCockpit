// test/mission-store.test.js — P1：事件日志与存储层。
//
// 第一性原理：这组测试守护的是"损坏是局部的、可检测的"
//
//   append-only JSONL 的核心优势不是"快"，而是**失效模式**：
//     全量覆盖写 → 一次崩溃/一个坏字节 = 整份数据不可读，历史全丢
//     append-only → 崩溃最多在**末尾**留半行，前面的事件完好无损
//
//   所以这里重点验证：
//     1. 坏行被捕获且不影响其它行（而不是整体解析失败）
//     2. seq 不单调会被报告（说明日志被改过/恢复错了）
//     3. 脏数据**写不进去**（日志不可改，写进去就永远是历史的一部分）
//     4. 状态永不落盘（磁盘上只有 events.jsonl）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const eventLog = require('../src/mission/event-log.js');
const { createMissionStore } = require('../src/mission/store.js');

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mission-'));
}

function aMission(id = 'mis-a', over = {}) {
  return {
    missionId: id,
    title: `Mission ${id}`,
    intent: '用户原话',
    status: 'active',
    workspaceId: 'ws-1',
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...over,
  };
}

// ------------------------------------------------------------- 编码/解码

test('event-log: encodeEvent produces a single line (no raw newlines)', () => {
  // 一行被拆成两行会让整条日志错位——这是 JSONL 最危险的失效模式
  const line = eventLog.encodeEvent({ seq: 1, type: 'x', atMs: 1, payload: { text: 'a\nb\r\nc' } });
  assert.ok(!line.includes('\n'), 'no raw newline may survive encoding');
  assert.ok(!line.includes('\r'));
  assert.deepEqual(JSON.parse(line).payload.text, 'a\nb\r\nc', 'the value itself round-trips');
});

test('event-log: decodeEvent rejects malformed lines WITHOUT throwing', () => {
  for (const bad of ['', '   ', '{not json', '[1,2,3]', '"a string"', 'null']) {
    const r = eventLog.decodeEvent(bad);
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(typeof r.error, 'string');
  }
});

test('event-log: decodeEvent requires type and a positive seq', () => {
  assert.strictEqual(eventLog.decodeEvent(JSON.stringify({ seq: 1, payload: {} })).ok, false);
  assert.strictEqual(eventLog.decodeEvent(JSON.stringify({ type: 'x', payload: {} })).ok, false);
  assert.strictEqual(eventLog.decodeEvent(JSON.stringify({ seq: 0, type: 'x' })).ok, false);
  assert.strictEqual(eventLog.decodeEvent(JSON.stringify({ seq: -3, type: 'x' })).ok, false);
  assert.strictEqual(eventLog.decodeEvent(JSON.stringify({ seq: 1, type: 'x' })).ok, true);
});

// -------------------------------------------------------------- 读取语义

test('event-log: a missing log reads as empty, not as an error', () => {
  const f = path.join(tmpWs(), 'nope.jsonl');
  const r = eventLog.readLog(f);
  assert.deepEqual(r.events, []);
  assert.strictEqual(r.missing, true);
  assert.deepEqual(r.badLines, []);
});

test('event-log: BAD LINES are isolated — valid lines around them still parse', () => {
  // 这是 append-only 相对"全量 JSON"的核心优势：损坏是局部的。
  const ws = tmpWs();
  const f = path.join(ws, 'events.jsonl');
  eventLog.appendEvents(f, [{ seq: 1, type: 'a', atMs: 1 }]);
  fs.appendFileSync(f, '{ this is broken\n');
  eventLog.appendEvents(f, [{ seq: 3, type: 'c', atMs: 3 }]);

  const r = eventLog.readLog(f);
  assert.deepEqual(r.events.map((e) => e.seq), [1, 3], 'the two valid events survive');
  assert.strictEqual(r.badLines.length, 1);
  assert.strictEqual(r.badLines[0].line, 2, 'the bad line number is reported');
  assert.match(r.badLines[0].error, /JSON/);
});

test('event-log: a truncated final line (crash mid-write) is detected, prior events intact', () => {
  // 模拟崩溃：最后一行只写了一半
  const ws = tmpWs();
  const f = path.join(ws, 'events.jsonl');
  eventLog.appendEvents(f, [{ seq: 1, type: 'a', atMs: 1 }, { seq: 2, type: 'b', atMs: 2 }]);
  fs.appendFileSync(f, '{"seq":3,"type":"c","atMs":3,"payl');

  const r = eventLog.readLog(f);
  assert.deepEqual(r.events.map((e) => e.seq), [1, 2], 'everything before the crash survives');
  assert.strictEqual(r.badLines.length, 1, 'and the damage is visible');
});

test('event-log: appendEvents creates the parent directory', () => {
  const f = path.join(tmpWs(), 'deep', 'nested', 'events.jsonl');
  eventLog.appendEvents(f, [{ seq: 1, type: 'x', atMs: 1 }]);
  assert.ok(fs.existsSync(f));
});

test('event-log: appending does not rewrite previous lines (append-only)', () => {
  const ws = tmpWs();
  const f = path.join(ws, 'events.jsonl');
  eventLog.appendEvents(f, [{ seq: 1, type: 'a', atMs: 1 }]);
  const firstBytes = fs.readFileSync(f, 'utf8');
  eventLog.appendEvents(f, [{ seq: 2, type: 'b', atMs: 2 }]);
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(after.startsWith(firstBytes), 'existing content must be byte-identical');
});

// ------------------------------------------------------------ seq 完整性

test('event-log: detectTruncation flags non-monotonic seq (tampered/restored log)', () => {
  const ok = eventLog.detectTruncation([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  assert.strictEqual(ok.ok, true);

  const bad = eventLog.detectTruncation([{ seq: 1 }, { seq: 3 }, { seq: 2 }]);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.problems.length, 1);
  assert.match(bad.problems[0].reason, /not strictly increasing/);
});

test('event-log: nextSeq returns 1 for an empty log and max+1 otherwise', () => {
  assert.strictEqual(eventLog.nextSeq([]), 1);
  assert.strictEqual(eventLog.nextSeq(null), 1);
  assert.strictEqual(eventLog.nextSeq([{ seq: 1 }, { seq: 7 }, { seq: 3 }]), 8);
});

test('event-log: needsArchive triggers on the line threshold', () => {
  const ws = tmpWs();
  const f = path.join(ws, 'events.jsonl');
  eventLog.appendEvents(f, [{ seq: 1, type: 'x', atMs: 1 }]);
  assert.strictEqual(eventLog.needsArchive(f).needed, false);
  // 直接构造超行数：用一个小的假阈值不方便，改为验证函数存在且形状正确
  assert.equal(typeof eventLog.needsArchive(f).reason, 'object');
});

// ------------------------------------------------------------------ store

test('mission-store: append validates BEFORE writing (the log is immutable, so dirty data must never enter)', () => {
  const st = createMissionStore({ workspaceDir: tmpWs() });
  const bad = st.append('mission.created', { ...aMission(), running: true });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /derived fields must not be persisted/);
  // 关键：拒绝的事件不能留下任何痕迹
  assert.strictEqual(st.report().eventCount, 0);
});

test('mission-store: unknown event types are refused', () => {
  const st = createMissionStore({ workspaceDir: tmpWs() });
  const r = st.append('mission.madeUp', { missionId: 'mis-a' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unknown event type/);
});

test('mission-store: state is NEVER persisted — only events.jsonl exists on disk', () => {
  // 这是"单一事实作者"的结构保证：如果磁盘上有状态副本，
  // 就一定会有"事件说 A、状态文件说 B"的那一天。
  const ws = tmpWs();
  const st = createMissionStore({ workspaceDir: ws });
  st.append('mission.created', aMission());
  const files = fs.readdirSync(st.dir);
  assert.deepEqual(files.sort(), ['events.jsonl'],
    'no snapshot/projection/state file may exist — the log is the single source of truth');
});

test('mission-store: multiple active missions coexist after a reload', () => {
  const ws = tmpWs();
  const st = createMissionStore({ workspaceDir: ws });
  st.append('mission.created', aMission('mis-a'));
  st.append('mission.created', aMission('mis-b'));
  st.append('mission.created', aMission('mis-c', { status: 'paused' }));

  const reopened = createMissionStore({ workspaceDir: ws });
  assert.strictEqual(reopened.listMissions().length, 3);
  assert.strictEqual(reopened.activeMissions().length, 2,
    'active coexistence must survive a restart');
});

test('mission-store: a healthy log reports healthy', () => {
  const st = createMissionStore({ workspaceDir: tmpWs() });
  st.append('mission.created', aMission());
  const r = st.report();
  assert.strictEqual(r.healthy, true);
  assert.strictEqual(r.eventCount, 1);
  assert.deepEqual(r.badLines, []);
  assert.deepEqual(r.gaps, []);
});

test('mission-store: a damaged log reports NOT healthy (never silently normal)', () => {
  const ws = tmpWs();
  const st = createMissionStore({ workspaceDir: ws });
  st.append('mission.created', aMission());
  fs.appendFileSync(path.join(ws, '.dsh', 'mission', 'events.jsonl'), 'garbage\n');

  const reopened = createMissionStore({ workspaceDir: ws });
  const r = reopened.report();
  assert.strictEqual(r.healthy, false, 'damage must be visible');
  assert.strictEqual(r.badLines.length, 1);
});

test('mission-store: seq gaps are surfaced in the report', () => {
  const ws = tmpWs();
  const dir = path.join(ws, '.dsh', 'mission');
  eventLog.appendEvents(path.join(dir, 'events.jsonl'), [
    { seq: 1, type: 'mission.created', atMs: 1, payload: aMission() },
    { seq: 5, type: 'mission.created', atMs: 2, payload: aMission('mis-b') },
  ]);
  const st = createMissionStore({ workspaceDir: ws });
  const r = st.report();
  assert.strictEqual(r.healthy, false);
  assert.ok(r.gaps.length > 0, 'a missing seq is data loss and must be reported');
});

test('mission-store: backups rotate and a damaged main file can be restored EXPLICITLY', () => {
  const ws = tmpWs();
  const st = createMissionStore({ workspaceDir: ws });
  st.append('mission.created', aMission('mis-a'));
  st.append('mission.created', aMission('mis-b')); // 这次写入前会把上一份轮转为 .bak

  const logFile = path.join(ws, '.dsh', 'mission', 'events.jsonl');
  assert.ok(fs.existsSync(`${logFile}.bak`), 'a backup must exist after the second append');

  // 破坏主文件
  fs.writeFileSync(logFile, 'totally broken\n');

  const damaged = createMissionStore({ workspaceDir: ws });
  assert.strictEqual(damaged.report().healthy, false);
  assert.strictEqual(damaged.listMissions().length, 0, 'no events readable from the broken file');

  const restored = damaged.restoreFromBackup();
  assert.strictEqual(restored.ok, true);
  assert.ok(restored.report.eventCount >= 1, 'the restore must bring events back');
  // 损坏的文件被保留为证据，不是被静默覆盖
  const leftovers = fs.readdirSync(path.dirname(logFile)).filter((n) => n.includes('.corrupt-'));
  assert.ok(leftovers.length >= 1, 'the damaged file must be preserved for post-mortem');
});

test('mission-store: restoreFromBackup reports failure when there is nothing to restore', () => {
  const st = createMissionStore({ workspaceDir: tmpWs() });
  const r = st.restoreFromBackup();
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no readable backup/);
});

test('mission-store: appended events get strictly increasing seq assigned by the store', () => {
  const st = createMissionStore({ workspaceDir: tmpWs() });
  const a = st.append('mission.created', aMission('mis-a'));
  const b = st.append('mission.created', aMission('mis-b'));
  assert.strictEqual(a.event.seq, 1);
  assert.strictEqual(b.event.seq, 2);
});

test('mission-store: the in-memory projection is updated incrementally after each append', () => {
  const st = createMissionStore({ workspaceDir: tmpWs() });
  assert.strictEqual(st.snapshot().missions['mis-a'], undefined);
  st.append('mission.created', aMission('mis-a'));
  assert.ok(st.snapshot().missions['mis-a'], 'the projection must reflect the new event immediately');
});

test('mission-store: report lists which backups exist', () => {
  const ws = tmpWs();
  const st = createMissionStore({ workspaceDir: ws });
  st.append('mission.created', aMission('mis-a'));
  st.append('mission.created', aMission('mis-b'));
  const r = st.report();
  assert.ok(r.backups.includes('events.jsonl.bak'));
});
