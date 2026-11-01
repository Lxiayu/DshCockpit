// src/perf-baseline.js — 启动与热路径的耗时基线（P4 性能基线，S1）。
//
// 第一性原理：为什么先建测量，而不是先优化
//
//   用户提出"Windows 上杀毒软件会让程序变慢"。这个判断是对的，但它不能
//   直接转成行动——"哪里慢"和"慢多少"都需要先测量。
//
//   没有测量的优化有三个典型失败：
//     1. 优化了不热的地方（改了代码，用户没感觉）
//     2. 优化过度（为省 3ms 引入复杂缓存，带来一致性 bug）
//     3. **无法证明变好了**（下次有人问"还是慢"，答不出来）
//
//   所以第一步是：给关键路径埋点，让"慢"变成可比较的数字。
//
// 第二性原理：为什么重点盯 Windows
//
//   Windows 上每次文件访问都可能被杀毒软件 hook（实时扫描）。
//   同一个同步 readFileSync 在 macOS 上是几十微秒，在 Windows 上
//   可能变成几毫秒——**同步阻塞主线程时，差距会直接变成 UI 卡顿**。
//
//   所以基线的核心指标不是"总耗时"，而是**主线程被同步 IO 占用的时长**。
'use strict';

/**
 * 一个轻量的耗时收集器。
 *
 * 设计约束：
 *   · 零依赖、零 IO —— 埋点本身不能成为新的性能问题
 *   · 有界 —— 只保留 N 条，避免长期运行内存增长
 *   · 可导出 —— 结果要能写进报告/日志，而不只是活在内存里
 */
function createPerfCollector({ maxSamples = 200 } = {}) {
  /** @type {Map<string, {count:number, totalMs:number, maxMs:number, lastMs:number}>} */
  const stats = new Map();
  let dropped = 0;

  function record(label, ms) {
    if (typeof label !== 'string' || label === '') return;
    // 负值/NaN 一律按 0 处理：时间不可能为负，出现负数说明埋点写错了，
    // 让一个负数污染 avg/total 会掩盖真正的问题。
    const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
    let s = stats.get(label);
    if (!s) {
      if (stats.size >= maxSamples) { dropped += 1; return; }
      s = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
      stats.set(label, s);
    }
    s.count += 1;
    s.totalMs += value;
    s.lastMs = value;
    if (value > s.maxMs) s.maxMs = value;
  }

  /** 同步函数计时。 */
  function time(label, fn) {
    const t0 = process.hrtime.bigint();
    try { return fn(); }
    finally { record(label, Number(process.hrtime.bigint() - t0) / 1e6); }
  }

  /** 异步函数计时。 */
  async function timeAsync(label, fn) {
    const t0 = process.hrtime.bigint();
    try { return await fn(); }
    finally { record(label, Number(process.hrtime.bigint() - t0) / 1e6); }
  }

  function snapshot() {
    const out = [];
    for (const [label, s] of stats) {
      out.push({
        label,
        count: s.count,
        totalMs: round(s.totalMs),
        avgMs: round(s.totalMs / s.count),
        maxMs: round(s.maxMs),
        lastMs: round(s.lastMs),
      });
    }
    // 按总耗时降序——优化的优先级自然浮现
    out.sort((a, b) => b.totalMs - a.totalMs);
    return { samples: out, dropped };
  }

  function reset() { stats.clear(); dropped = 0; }

  return { record, time, timeAsync, snapshot, reset };
}

function round(v) { return Math.round(v * 1000) / 1000; }

/**
 * 判定是否超过预算。
 *
 * 预算的意义不是"精确要求"，而是**在 CI 里挡住明显退化**。
 * Windows 上真实值通常是 macOS 的几倍，所以这里的默认预算给 macOS 留了余量。
 *
 * @param {Array} samples  snapshot().samples
 * @param {object} budget  { label: { maxAvgMs, maxTotalMs } }
 */
function checkBudget(samples, budget = {}) {
  const violations = [];
  for (const s of samples) {
    const b = budget[s.label];
    if (!b) continue;
    if (Number.isFinite(b.maxAvgMs) && s.avgMs > b.maxAvgMs) {
      violations.push({ label: s.label, metric: 'avgMs', actual: s.avgMs, budget: b.maxAvgMs });
    }
    if (Number.isFinite(b.maxTotalMs) && s.totalMs > b.maxTotalMs) {
      violations.push({ label: s.label, metric: 'totalMs', actual: s.totalMs, budget: b.maxTotalMs });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 主线程同步阻塞检测。
 *
 * 这是 Windows 性能问题的**核心指标**：一次 5ms 的同步读在 macOS 无感，
 * 在开了实时扫描的 Windows 上会让动画掉帧。
 *
 * 用法：在事件循环上装一个定时器，测量"期望时刻 vs 实际时刻"的偏差。
 * 偏差越大说明主线程被占得越久。
 */
function createLagProbe({ intervalMs = 100 } = {}) {
  let timer = null;
  let maxLagMs = 0;
  let samples = 0;
  let last = 0;

  function start() {
    if (timer) return;
    last = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - last - intervalMs);
      if (lag > maxLagMs) maxLagMs = lag;
      samples += 1;
      last = now;
    }, intervalMs);
    if (timer.unref) timer.unref(); // 不能因为它让进程不退出
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    return { maxLagMs: round(maxLagMs), samples };
  }

  function reset() { maxLagMs = 0; samples = 0; last = Date.now(); }

  return { start, stop, reset, get maxLagMs() { return round(maxLagMs); } };
}

module.exports = { createPerfCollector, checkBudget, createLagProbe };
