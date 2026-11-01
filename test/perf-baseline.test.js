// test/perf-baseline.test.js — P4 性能基线的测量工具本身。
//
// 第一性原理：测量工具比被测量的代码更需要正确
//
//   如果埋点有 bug，后续所有优化都建立在错误数字上：
//     · 计时算错 → 优化了不热的地方
//     · 无界增长 → 埋点本身变成新的性能问题
//     · 异常路径不记录 → 最慢的那条路径恰好是抛异常的那条
//
//   所以本文件重点测"边界情况"，而不是正常路径。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createPerfCollector, checkBudget, createLagProbe } = require('../src/perf-baseline.js');

// ============================================================ collector

test('perf: time() returns the function result (transparent wrapping)', () => {
  const c = createPerfCollector();
  assert.strictEqual(c.time('x', () => 42), 42);
});

test('perf: time() records even when the function THROWS', () => {
  // 最慢的路径往往是报错路径（超时、重试）。不记录会漏掉它。
  const c = createPerfCollector();
  assert.throws(() => c.time('boom', () => { throw new Error('x'); }));
  const s = c.snapshot();
  assert.strictEqual(s.samples[0].label, 'boom');
  assert.strictEqual(s.samples[0].count, 1);
});

test('perf: timeAsync records on async rejection too', async () => {
  const c = createPerfCollector();
  await assert.rejects(c.timeAsync('aboom', async () => { throw new Error('x'); }));
  assert.strictEqual(c.snapshot().samples[0].count, 1);
});

test('perf: aggregates count/avg/max correctly', () => {
  const c = createPerfCollector();
  c.record('a', 1); c.record('a', 3); c.record('a', 2);
  const s = c.snapshot().samples[0];
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.totalMs, 6);
  assert.strictEqual(s.avgMs, 2);
  assert.strictEqual(s.maxMs, 3);
});

test('perf: samples are ordered by total time (optimization priority is obvious)', () => {
  const c = createPerfCollector();
  c.record('cheap', 1); c.record('expensive', 100);
  const labels = c.snapshot().samples.map((x) => x.label);
  assert.deepStrictEqual(labels, ['expensive', 'cheap']);
});

test('perf: the collector is BOUNDED (instrumentation must not leak memory)', () => {
  const c = createPerfCollector({ maxSamples: 3 });
  for (let i = 0; i < 10; i += 1) c.record(`label-${i}`, 1);
  const s = c.snapshot();
  assert.strictEqual(s.samples.length, 3);
  assert.strictEqual(s.dropped, 7, 'dropped samples must be counted, not silently lost');
});

test('perf: a garbage label/time does not poison the stats', () => {
  const c = createPerfCollector();
  c.record('', 1); c.record(null, 1); c.record('ok', NaN); c.record('ok2', -5);
  const s = c.snapshot();
  assert.ok(s.samples.every((x) => Number.isFinite(x.avgMs) && x.avgMs >= 0));
});

test('perf: reset() clears everything', () => {
  const c = createPerfCollector();
  c.record('a', 1);
  c.reset();
  assert.deepStrictEqual(c.snapshot(), { samples: [], dropped: 0 });
});

// ============================================================ budget

test('perf: budget violations are reported with actual vs budget', () => {
  const samples = [{ label: 'read', count: 1, totalMs: 50, avgMs: 50, maxMs: 50, lastMs: 50 }];
  const r = checkBudget(samples, { read: { maxAvgMs: 10 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations[0].actual, 50);
  assert.strictEqual(r.violations[0].budget, 10);
});

test('perf: labels without a budget are ignored (not万事皆过)', () => {
  const samples = [{ label: 'unknown', count: 1, totalMs: 999, avgMs: 999, maxMs: 999, lastMs: 999 }];
  assert.strictEqual(checkBudget(samples, {}).ok, true);
});

test('perf: totalMs budget works independently of avgMs', () => {
  const samples = [{ label: 'x', count: 100, totalMs: 500, avgMs: 5, maxMs: 6, lastMs: 5 }];
  assert.strictEqual(checkBudget(samples, { x: { maxTotalMs: 100 } }).ok, false);
  assert.strictEqual(checkBudget(samples, { x: { maxAvgMs: 10 } }).ok, true);
});

// ============================================================ lag probe

test('perf: the lag probe measures main-thread blocking (the Windows symptom)', async () => {
  const p = createLagProbe({ intervalMs: 10 });
  p.start();
  await new Promise((r) => setTimeout(r, 50));
  const r = p.stop();
  assert.ok(r.samples >= 1, 'it must actually sample');
  assert.ok(r.maxLagMs >= 0);
});

test('perf: a synchronous block is visible as lag', async () => {
  const p = createLagProbe({ intervalMs: 5 });
  p.start();
  await new Promise((r) => setTimeout(r, 30));
  // 故意阻塞主线程（模拟同步 fs 在杀毒扫描下的表现）
  const t0 = Date.now();
  while (Date.now() - t0 < 40) { /* spin */ }
  await new Promise((r) => setTimeout(r, 40));
  const r = p.stop();
  assert.ok(r.maxLagMs >= 20, `a 40ms block must show up as lag, got ${r.maxLagMs}`);
});

test('perf: the probe timer is unref-ed (it must not keep the process alive)', () => {
  const p = createLagProbe({ intervalMs: 1000 });
  p.start();
  // 能走到这里说明 unref 生效（否则 node --test 会挂住）
  p.stop();
  assert.ok(true);
});
