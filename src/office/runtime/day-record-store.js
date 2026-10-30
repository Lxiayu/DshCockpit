'use strict';

// src/office/runtime/day-record-store.js — per-employee day record + turn usage.
//
// 2026-10-30（高内聚拆分）：这一段原本长在 office-module.js 里（composite root），
// 但它和办公室的业务流程没有耦合 —— 只关心"每个员工的今日用量/完成数/工具统计"
// 怎么累计、怎么跨天滚动。抽出后 root 只保留一句组装，符合
// "组合根只负责组合，功能逻辑属于 runtime/**" 的既有边界规范。
//
// 纯逻辑：不读时钟、不碰 DOM/Electron、不持有全局单例（状态由调用方创建）。
// 依赖注入 realClock，缺失时退化为"会话窗口"（dayKey 恒 null，不跨天）。

const { billingDayKey } = require('./usage-snapshot.js');

/** 工具种类与"最近使用"两个环形上限（与原实现一致，避免记录无界增长）。 */
const TOOL_KINDS_CAP = 8;
const RECENT_CAP = 6;

function createDayRecordStore({ realClock = null } = {}) {
  /** employeeId -> record state */
  const dayRecords = new Map();

  function emptyRecord() {
    return {
      dayKey: null,
      tasks: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
      cost: 0,
      durationMs: 0,
      tools: new Map(),
      toolsTotal: 0,
      recentRing: [],
    };
  }

  function recordFor(employeeId) {
    let record = dayRecords.get(employeeId);
    if (!record) {
      record = emptyRecord();
      record.employeeId = employeeId;
      dayRecords.set(employeeId, record);
    }
    return record;
  }

  /** The record's current real day key, or null without a realClock. */
  function currentDayKey() {
    return realClock ? billingDayKey(realClock()) : null;
  }

  /** Reset the record when the real calendar day rolled over (midnight). */
  function rollIfNeeded(record) {
    const key = currentDayKey();
    if (key !== null && record.dayKey !== null && record.dayKey !== key) {
      const fresh = emptyRecord();
      fresh.employeeId = record.employeeId;
      fresh.dayKey = key;
      dayRecords.set(record.employeeId, fresh);
      return fresh;
    }
    if (key !== null && record.dayKey === null) record.dayKey = key;
    return record;
  }

  /** 只统计四种任务结果类活动；其它（睡眠/闲聊/控制）只进日志与时间线。 */
  const COUNT_FIELD_BY_KIND = Object.freeze({
    'task-started': 'tasks',
    'result-completed': 'completed',
    'result-failed': 'failed',
    'result-cancelled': 'cancelled',
  });

  function bumpCount(record, kind) {
    const field = COUNT_FIELD_BY_KIND[kind];
    if (field) record[field] += 1;
  }

  /** 时间线环形：最近 RECENT_CAP 条（存 {kind, atMs, realMs} 对象）。 */
  function pushTimeline(record, item) {
    record.recentRing.push(item);
    while (record.recentRing.length > RECENT_CAP) record.recentRing.shift();
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /** 累加一次 turn 用量到该员工的今日记录（跨天自动滚动）。 */
  function accrueUsage(employeeId, stamp) {
    if (!employeeId || !stamp) return null;
    const record = rollIfNeeded(recordFor(employeeId));
    const u = stamp.turnUsage || {};
    record.usage.input += num(u.input);
    record.usage.output += num(u.output);
    record.usage.cacheRead += num(u.cacheRead);
    record.usage.total += num(u.total);
    record.cost += num(stamp.turnCost);
    record.durationMs += num(stamp.turnDurationMs);
    return record;
  }

  /** 记录一次工具调用：种类数封顶 TOOL_KINDS_CAP，超出上限的新种类忽略。 */
  function tallyTool(employeeId, toolKind) {
    if (!employeeId || typeof toolKind !== 'string' || toolKind === '') return null;
    const record = rollIfNeeded(recordFor(employeeId));
    if (!record.tools.has(toolKind) && record.tools.size >= TOOL_KINDS_CAP) return record;
    record.tools.set(toolKind, (record.tools.get(toolKind) || 0) + 1);
    record.toolsTotal += 1;
    return record;
  }

  return Object.freeze({
    TOOL_KINDS_CAP,
    RECENT_CAP,
    recordFor,
    currentDayKey,
    rollIfNeeded,
    bumpCount,
    pushTimeline,
    accrueUsage,
    tallyTool,
    /** 只读快照（供 state() 组装；调用方不改动返回值）。 */
    all: () => dayRecords,
  });
}

module.exports = { createDayRecordStore };
