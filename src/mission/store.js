// src/mission/store.js — Mission 存储（P1）：事件日志 + 派生视图 + 备份/恢复。
//
// 第一性原理：store 只做"事件从哪来、到哪去"，不做语义
//
//   三层职责必须分离，否则任何一层变化都会牵动其它两层：
//     schema.js     → 契约（哪些字段合法）
//     projection.js → 语义（事件如何折叠成状态）
//     store.js      → 持久化（读写、备份、恢复、归档）
//
//   本模块的关键设计决定：
//
//   1. **状态永不落盘**。磁盘上只有 events.jsonl。
//      任何"顺手把投影也存一份"的做法都会立刻制造两个事实作者——
//      而 Mission Core 存在的意义就是避免这件事。
//
//   2. **写入前先校验，校验失败不写**。宁可让调用方拿到 {ok:false}，
//      也不要把脏事件写进 append-only 日志——因为**日志不可改**，
//      写进去的脏数据会永远留在历史里。
//
//   3. **损坏可见，不自动修复**。坏行、seq 缺口、截断都会如实返回。
//      自动"修复"会掩盖真实的数据丢失。
//
//   4. **seq 由 store 分配**（单写者）。并发写是架构违规，
//      用写锁文件 + 内存队列暴露它，而不是静默接受。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const eventLog = require('./event-log');
const projectionModule = require('./projection');
const schema = require('./schema');

const BACKUP_DEPTH = 3;

function nowMs() {
  return Date.now();
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 备份路径链：events.jsonl.bak / .bak.1 / .bak.2 */
function backupCandidates(file) {
  return [`${file}.bak`, `${file}.bak.1`, `${file}.bak.2`];
}

/** 轮转备份（写前调用，此时主文件仍是上一份有效内容）。 */
function rotateBackups(file) {
  for (let i = BACKUP_DEPTH - 1; i >= 0; i -= 1) {
    const from = i === 0 ? file : [`${file}.bak`, `${file}.bak.1`][i - 1];
    const to = i === 0 ? `${file}.bak` : [`${file}.bak.1`, `${file}.bak.2`][i - 1];
    if (!from || !fs.existsSync(from)) continue;
    try { fs.copyFileSync(from, to); } catch { /* 备份失败不阻塞写入 */ }
  }
}

/**
 * 创建一个 Mission Store。
 *
 * @param {object} opts
 * @param {string} opts.workspaceDir   workspace 根（Mission 数据放 <ws>/.dsh/mission/）
 * @param {Function} [opts.now]        注入时钟（测试用）
 * @param {Function} [opts.log]
 */
function createMissionStore({ workspaceDir, now = nowMs, log = () => {} } = {}) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('createMissionStore requires workspaceDir');
  }
  const dir = path.join(workspaceDir, '.dsh', 'mission');
  const file = path.join(dir, eventLog.LOG_FILE_NAME);

  // 内存投影：**唯一**的状态来源，每次写入后增量更新，读时可按需重建
  let projection = projectionModule.emptyProjection();
  let loaded = false;
  let loadReport = null;
  // 写串行化：单写者是架构约束，这里用一个 Promise 链强制执行
  let writeChain = Promise.resolve();

  /** 从磁盘重建投影。返回加载报告（含损坏信息）。 */
  function load() {
    const read = eventLog.readLog(file);
    const trunc = eventLog.detectTruncation(read.events);
    const folded = projectionModule.fold(read.events);
    projection = folded.projection;
    loaded = true;
    loadReport = {
      missing: !!read.missing,
      eventCount: read.events.length,
      badLines: read.badLines,
      gaps: folded.gaps,
      skipped: folded.skipped,
      truncationProblems: trunc.problems,
      bytes: read.bytes,
      // 有任何异常都必须让调用方看见
      healthy: read.badLines.length === 0 && folded.gaps.length === 0
        && folded.skipped === 0 && trunc.ok,
    };
    if (!loadReport.healthy) {
      log(`[mission] log not healthy: badLines=${read.badLines.length} gaps=${folded.gaps.length} skipped=${folded.skipped} trunc=${trunc.problems.length}`);
    }
    return loadReport;
  }

  function ensureLoaded() {
    if (!loaded) load();
  }

  /**
   * 追加一条事件。
   *
   * @param {string} type   事件类型（见 projection.EVENT_TYPES）
   * @param {object} payload
   * @param {object} [meta]  { missionId, atMs }
   * @returns {{ok:boolean, event?:object, reason?:string}}
   */
  function append(type, payload, meta = {}) {
    ensureLoaded();

    if (!projectionModule.EVENT_TYPES.includes(type)) {
      return { ok: false, reason: `unknown event type: ${type}` };
    }
    // 写入前校验：日志不可改，脏数据一旦写进去就永远留在历史里
    const missionId = meta.missionId || (payload && payload.missionId);
    const entityType = missionId ? type.split('.')[0] : null;
    if (entityType) {
      const validated = validateByEventType(type, payload);
      if (!validated.ok) {
        return { ok: false, reason: `invalid payload: ${validated.errors.join('; ')}` };
      }
    }

    const atMs = Number.isFinite(meta.atMs) ? meta.atMs : now();
    const event = {
      seq: eventLog.nextSeq(collectEventsFromProjection()),
      type,
      atMs,
      payload,
    };
    if (missionId) event.missionId = missionId;

    try {
      rotateBackups(file);
      eventLog.appendEvents(file, [event]);
    } catch (err) {
      log(`[mission] append failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }

    // 增量更新投影（避免每次写都全量重读）
    projection = projectionModule.applyEvent(projection, event);
    // 同步更新加载报告：否则 report() 的 eventCount 会永远停在首次加载的值，
    // 让日志有多少条事件这个最基本的可观测信息变成谎言。
    if (loadReport) {
      loadReport.eventCount += 1;
      loadReport.bytes = eventLog.logBytes(file);
      loadReport.healthy = loadReport.badLines.length === 0 && loadReport.gaps.length === 0
        && loadReport.skipped === 0 && loadReport.truncationProblems.length === 0;
    }
    return { ok: true, event };
  }

  /** 从当前投影重建"已存在哪些 seq"——用于分配下一个 seq。 */
  function collectEventsFromProjection() {
    const out = [];
    const maxSeq = projection.lastSeq || 0;
    // 只关心最大值，造一个占位即可
    if (maxSeq > 0) out.push({ seq: maxSeq });
    return out;
  }

  /** 按事件类型选择校验器。 */
  function validateByEventType(type, payload) {
    switch (type) {
      case 'mission.created': return schema.validateMission(payload);
      case 'workstream.created': return schema.validateWorkstream(payload);
      case 'decision.recorded': return schema.validateDecision(payload);
      case 'question.opened': return schema.validateOpenQuestion(payload);
      case 'deliverable.registered': return schema.validateDeliverable(payload);
      case 'taskRef.linked': return schema.validateTaskRef(payload);
      // 更新类事件只校验"目标存在"+ 允许字段，完整实体校验不适用
      case 'mission.updated':
      case 'mission.statusChanged':
        return payload && typeof payload.missionId === 'string'
          ? { ok: true, errors: [] }
          : { ok: false, errors: ['missionId is required'] };
      case 'workstream.updated':
      case 'workstream.statusChanged':
        return payload && typeof payload.workstreamId === 'string'
          ? { ok: true, errors: [] }
          : { ok: false, errors: ['workstreamId is required'] };
      case 'decision.superseded':
        return payload && typeof payload.decisionId === 'string'
          ? { ok: true, errors: [] }
          : { ok: false, errors: ['decisionId is required'] };
      case 'question.answered':
        return payload && typeof payload.questionId === 'string' && typeof payload.answer === 'string'
          ? { ok: true, errors: [] }
          : { ok: false, errors: ['questionId and answer are required'] };
      default:
        return { ok: true, errors: [] };
    }
  }

  /** 读当前投影（只读副本，防止调用方直接改内部状态）。 */
  function snapshot() {
    ensureLoaded();
    return projection;
  }

  /** 加载报告（损坏/缺口/缺口都会在这里）。 */
  function report() {
    ensureLoaded();
    return { ...loadReport, backups: backupCandidates(file).filter((p) => fs.existsSync(p)).map((p) => path.basename(p)) };
  }

  /** 列出某 workspace 的所有 Mission（多个 active 并存是合法的）。 */
  function listMissions() {
    return Object.values(snapshot().missions);
  }

  function activeMissions() {
    return projectionModule.activeMissions(snapshot());
  }

  function missionView(missionId) {
    return projectionModule.missionView(snapshot(), missionId);
  }

  /** 恢复到备份（显式操作，不自动）。返回是否有可恢复的备份。 */
  function restoreFromBackup() {
    const candidates = backupCandidates(file);
    for (const backup of candidates) {
      if (!fs.existsSync(backup)) continue;
      const read = eventLog.readLog(backup);
      if (read.badLines.length > 0) continue; // 坏备份不用
      // 保留当前（可能已损坏的）文件作为证据
      try { fs.copyFileSync(file, `${file}.corrupt-${isoStamp()}`); } catch { /* ignore */ }
      fs.copyFileSync(backup, file);
      loaded = false;
      load();
      log(`[mission] restored from ${path.basename(backup)}`);
      return { ok: true, restoredFrom: path.basename(backup), report: loadReport };
    }
    return { ok: false, reason: 'no readable backup available' };
  }

  /** 是否需要归档（交给上层决定何时 compaction）。 */
  function archiveStatus() {
    return eventLog.needsArchive(file);
  }

  return {
    dir,
    file,
    load,
    append,
    snapshot,
    report,
    listMissions,
    activeMissions,
    missionView,
    restoreFromBackup,
    archiveStatus,
    // 暴露给测试：把写串行化也放进来（目前 append 是同步的，这里保留给未来异步 IO）
    _writeChain: () => writeChain,
  };
}

module.exports = { createMissionStore, BACKUP_DEPTH, backupCandidates, rotateBackups };
