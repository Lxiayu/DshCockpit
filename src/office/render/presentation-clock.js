'use strict';

// src/office/render/presentation-clock.js — P3.0 呈现时钟（纯函数，零依赖）。
//
// 契约（P3 计划 §2/§5）：这一层**只决定"画在哪"**，不产生任何办公室事实。
// 位置/状态的唯一作者仍是主进程模拟；渲染器把最近两次推送的快照做双缓冲，
// 用真实经过的时间在 prev→curr 之间插值。因此：
//   - 没有快照变化时，采样收敛到 curr，不会有自走/漂移；
//   - 快照间隔抖动（主进程事件环被占）被时间轴吸收，画面仍连续；
//   - 时间倒流/暂停/超长间隔/实体消失这类"逻辑断点"一律不插值（直接吸附），
//     不 interpolate 幽灵、不跨断点外推。
//
// 为什么不是"往前外推"：外推会画出模拟尚未到达的位置（等于渲染层编事实）。
// 这里固定落后一个推送间隔（生产 ~16ms），换来的是任何推送节奏下都连续。
//
// 时钟/定时器全部由调用方注入（渲染器用 rAF），本模块自身不读墙钟。

// 两次快照的真实间隔超过这个值就视为断点（页面被节流、窗口挂起后回来）。
const DEFAULT_MAX_GAP_MS = 250;
// 归一化场景坐标下的"肉眼可分辨"门限（1280 宽约 0.013px），用于判断是否
// 还值得继续出帧。
const DEFAULT_MIN_DISTANCE = 1e-5;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function readEmployee(employee) {
  if (!employee || typeof employee.employeeId !== 'string' || employee.employeeId === '') return null;
  const position = employee.position;
  if (!position || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) return null;
  return { employeeId: employee.employeeId, x: position.x, y: position.y };
}

function createPresentationClock(options) {
  const settings = options || {};
  const maxGapMs = isFiniteNumber(settings.maxGapMs) && settings.maxGapMs > 0
    ? settings.maxGapMs
    : DEFAULT_MAX_GAP_MS;
  const minDistance = isFiniteNumber(settings.minDistance) && settings.minDistance >= 0
    ? settings.minDistance
    : DEFAULT_MIN_DISTANCE;

  let previous = null;
  let current = null;

  // A simulation timeline that froze, rewound or paused is a discontinuity:
  // interpolating across it would invent motion the main process never made.
  function continuesTimeline(snapshot) {
    if (!current) return false;
    if (snapshot.paused === true) return false;
    if (!isFiniteNumber(snapshot.simulatedAtMs) || !isFiniteNumber(current.simulatedAtMs)) {
      // Without simulated time the wall-clock arrival gap is the only signal.
      return true;
    }
    return snapshot.simulatedAtMs > current.simulatedAtMs;
  }

  /** Buffer one pushed snapshot. `atMs` is the caller's presentation clock. */
  function capture(snapshot, atMs) {
    if (!snapshot || !Array.isArray(snapshot.employees) || !isFiniteNumber(atMs)) return false;
    const byId = new Map();
    for (const employee of snapshot.employees) {
      const sample = readEmployee(employee);
      if (sample) byId.set(sample.employeeId, sample);
    }
    const next = {
      at: atMs,
      simulatedAtMs: isFiniteNumber(snapshot.simulatedAtMs) ? snapshot.simulatedAtMs : null,
      byId,
    };
    const gapOk = current
      && next.at > current.at
      && (next.at - current.at) <= maxGapMs;
    previous = gapOk && continuesTimeline(snapshot) ? current : null;
    current = next;
    return true;
  }

  function alphaAt(nowMs) {
    if (!current) return 1;
    if (!previous) return 1;
    const span = current.at - previous.at;
    if (!(span > 0)) return 1;
    const elapsed = isFiniteNumber(nowMs) ? nowMs - current.at : span;
    if (elapsed <= 0) return 0;
    if (elapsed >= span) return 1;
    return elapsed / span;
  }

  /** Interpolated logical positions at `nowMs`. Empty until the first capture. */
  function sample(nowMs) {
    if (!current) return [];
    const alpha = alphaAt(nowMs);
    const out = [];
    for (const [employeeId, c] of current.byId) {
      const p = previous ? previous.byId.get(employeeId) : null;
      if (!p) {
        // A newcomer has no earlier sample: appear exactly where it is.
        out.push({ employeeId, x: c.x, y: c.y, interpolated: false });
        continue;
      }
      out.push({
        employeeId,
        x: p.x + (c.x - p.x) * alpha,
        y: p.y + (c.y - p.y) * alpha,
        interpolated: alpha > 0 && alpha < 1,
      });
    }
    return out;
  }

  /** True while at least one entity is between its two samples. The renderer
   *  keeps its frame loop running only while this is true. */
  function interpolating(nowMs) {
    if (!previous || !current) return false;
    if (alphaAt(nowMs) >= 1) return false;
    for (const [employeeId, c] of current.byId) {
      const p = previous.byId.get(employeeId);
      if (!p) continue;
      if (Math.abs(c.x - p.x) > minDistance || Math.abs(c.y - p.y) > minDistance) return true;
    }
    return false;
  }

  function reset() {
    previous = null;
    current = null;
  }

  return {
    capture,
    sample,
    interpolating,
    alphaAt,
    reset,
    // Observability for probes/tests: counts only, never positions of removed
    // entities.
    stats() {
      return {
        hasPrevious: previous !== null,
        hasCurrent: current !== null,
        employeeCount: current ? current.byId.size : 0,
      };
    },
  };
}

module.exports = {
  createPresentationClock,
  DEFAULT_MAX_GAP_MS,
  DEFAULT_MIN_DISTANCE,
};
