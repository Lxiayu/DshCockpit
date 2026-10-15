'use strict';

// src/office/behavior-graph/diff.js — the difference report (brief §8: 与现有
// behavior-scheduler 行为的差异报告).
//
// Two producers can drive the office: the shipped behavior scheduler and a behaviour
// graph. This module compares their OUTPUT STREAMS under the same seed and the same
// event script, and reports where they diverge — the activity vocabulary is shared
// (roaming / resting / chatting / sleeping, plus the task loop), so a divergence is
// a real semantic difference, not a naming artifact.
//
// Inputs are plain data, so the caller decides how to obtain them (the scheduler's
// trace, the interpreter's trace, a recorded session):
//   stream = [{ atMs, employeeId, activity }]

const ACTIVITIES = Object.freeze(['roaming', 'resting', 'chatting', 'sleeping', 'working']);

// `continue` is the scheduler's "keep doing what you are doing" sentinel — it is not
// an activity change, so it is dropped (otherwise every stay would read as a
// divergence). Anything else is compared literally.
const CONTINUE_SENTINELS = Object.freeze(['continue']);

function normalizeStream(stream) {
  return (stream || [])
    .filter((entry) => entry && entry.employeeId && entry.activity)
    .map((entry) => ({ atMs: Number(entry.atMs) || 0, employeeId: String(entry.employeeId), activity: String(entry.activity) }))
    .filter((entry) => !CONTINUE_SENTINELS.includes(entry.activity))
    .sort((a, b) => (a.atMs - b.atMs) || a.employeeId.localeCompare(b.employeeId));
}

// A comparable signature per employee: the ordered activity list with the time spent
// in each state (durations make a "same order, wrong pacing" difference visible).
function signature(stream) {
  const byEmployee = new Map();
  for (const entry of stream) {
    if (!byEmployee.has(entry.employeeId)) byEmployee.set(entry.employeeId, []);
    byEmployee.get(entry.employeeId).push(entry);
  }
  const out = {};
  for (const [employeeId, entries] of byEmployee) {
    const runs = [];
    for (const entry of entries) {
      const last = runs[runs.length - 1];
      if (last && last.activity === entry.activity) last.untilMs = entry.atMs;
      else runs.push({ activity: entry.activity, fromMs: entry.atMs, untilMs: entry.atMs });
    }
    out[employeeId] = {
      runs,
      activities: runs.map((run) => run.activity),
      durations: runs.map((run) => run.untilMs - run.fromMs),
      histogram: Object.fromEntries(ACTIVITIES.map((activity) => [activity, runs.filter((run) => run.activity === activity).length])),
    };
  }
  return out;
}

function diffStreams({ scheduled, graphed, toleranceMs = 1000 }) {
  const left = signature(normalizeStream(scheduled));
  const right = signature(normalizeStream(graphed));
  const employees = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const rows = [];
  const divergences = [];
  for (const employeeId of employees) {
    const a = left[employeeId];
    const b = right[employeeId];
    if (!a || !b) {
      divergences.push({ employeeId, kind: 'employee-missing', detail: a ? 'only in the scheduler stream' : 'only in the graph stream' });
      continue;
    }
    const orderMatch = a.activities.length === b.activities.length && a.activities.every((activity, index) => activity === b.activities[index]);
    const histogramMatch = ACTIVITIES.every((activity) => a.histogram[activity] === b.histogram[activity]);
    const maxDurationDelta = Math.max(0, ...a.durations.map((duration, index) => Math.abs(duration - (b.durations[index] || 0))));
    rows.push({
      employeeId,
      schedulerRuns: a.runs.length,
      graphRuns: b.runs.length,
      orderMatch,
      histogramMatch,
      maxDurationDeltaMs: maxDurationDelta,
    });
    if (!orderMatch) {
      const first = a.activities.findIndex((activity, index) => activity !== b.activities[index]);
      divergences.push({
        employeeId,
        kind: 'sequence-divergence',
        at: first,
        scheduler: a.activities.slice(Math.max(0, first - 1), first + 3),
        graph: b.activities.slice(Math.max(0, first - 1), first + 3),
      });
    } else if (!histogramMatch) {
      divergences.push({ employeeId, kind: 'histogram-divergence', scheduler: a.histogram, graph: b.histogram });
    }
    if (maxDurationDelta > toleranceMs) {
      divergences.push({ employeeId, kind: 'pacing-divergence', maxDurationDeltaMs: maxDurationDelta, toleranceMs });
    }
  }
  return {
    ok: divergences.length === 0,
    employees: employees.length,
    rows,
    divergences,
    vocabulary: ACTIVITIES,
    note: '同一 seed + 同一事件脚本下的对比；序列一致但时长差超阈值会单独报出（节奏差异不是语义差异，但要看）。',
  };
}

// The interpreter's trace → a comparable stream (actions carry the activity).
function streamFromInterpreterTrace(trace) {
  return (trace || [])
    .filter((entry) => entry.kind === 'action' && entry.do)
    .map((entry) => ({
      atMs: entry.atMs,
      employeeId: entry.employeeId,
      // `activity.set` carries the scheduler's own vocabulary in `resource`
      activity: entry.do === 'activity.set' && entry.resource ? String(entry.resource) : String(entry.do),
    }));
}

module.exports = { ACTIVITIES, diffStreams, normalizeStream, signature, streamFromInterpreterTrace };
