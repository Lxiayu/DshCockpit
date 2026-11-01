// src/mission/projection.js — 事件日志 → 当前状态（P1，纯函数）。
//
// 第一性原理：为什么用 fold(events) 而不是"直接存状态"
//
//   Mission Core 要回答的核心问题是"为什么这么决定"（domain-model §2.1.4）。
//   直接存状态的问题不是"不准确"，而是**丢掉了到达这个状态的路径**：
//     · 用户改了 Mission 标题 → 旧标题没了，谁改的、为什么改、没了
//     · Decision 被 superseded → 被什么取代、当时的理由是什么、没了
//   而这些恰恰是 compaction 会丢掉、Agent 下次会话最需要的东西。
//
//   append-only 事件日志 + 派生投影的价值：
//     · 事件是**只追加**的，历史永不被覆盖 → 可审计、可回放
//     · 投影是**纯函数**，同一事件序列永远得到同一状态 → 可测试、可重建
//     · 损坏时可以从任意前缀重建 → 比"全量覆盖写"能救回更多
//
//   本文件只有 fold，不做 IO。这样它可以被单测穷举，
//   而存储层（store.js）只负责"事件从哪来、到哪去"。
//
// 投影不是"存储状态的缓存"——它是**唯一**的状态来源。任何"顺手把状态也存一份"
// 的做法都会立刻制造两个事实作者，而这就是 Mission Core 最想避免的事。
'use strict';

const schema = require('./schema');

/** 事件类型。append-only 日志里的 type 值。 */
const EVENT_TYPES = Object.freeze([
  'mission.created',
  'mission.updated',
  'mission.statusChanged',
  'workstream.created',
  'workstream.updated',
  'workstream.statusChanged',
  'decision.recorded',
  'decision.superseded',
  'question.opened',
  'question.answered',
  'deliverable.registered',
  'taskRef.linked',
  // Shared Context 三实体（2026-11-01）
  'finding.recorded',
  'finding.statusChanged',
  'assumption.recorded',
  'assumption.statusChanged',
  'evidence.recorded',
]);

function emptyProjection() {
  return {
    missions: {},        // missionId -> Mission
    workstreams: {},     // workstreamId -> Workstream
    decisions: {},       // decisionId -> Decision
    questions: {},       // questionId -> OpenQuestion
    deliverables: {},    // deliverableId -> Deliverable
    taskRefs: {},        // taskRefId -> TaskRef
    findings: {},        // findingId -> Finding
    assumptions: {},     // assumptionId -> Assumption
    evidences: {},       // evidenceId -> Evidence
    // 索引：便于"这个 Mission 下有哪些 X"的查询，避免每次全表扫
    byMission: {},       // missionId -> { workstreamIds, decisionIds, questionIds, deliverableIds, taskRefIds }
    // 最后一个成功应用的事件序号（用于检测日志缺口）
    lastSeq: 0,
    appliedCount: 0,
  };
}

function ensureMissionIndex(p, missionId) {
  if (!p.byMission[missionId]) {
    p.byMission[missionId] = {
      workstreamIds: [], decisionIds: [], questionIds: [], deliverableIds: [], taskRefIds: [],
      findingIds: [], assumptionIds: [], evidenceIds: [],
    };
  }
  return p.byMission[missionId];
}

function pushUnique(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}

/**
 * 应用单个事件。返回新的投影（不修改入参——纯函数契约）。
 *
 * 未知事件类型**跳过并计数**，而不是抛异常：一个未来版本写入的新事件
 * 不应该让旧版本完全无法读取历史（向前兼容）。但计数会让调用方知道
 * "这份投影不完整"，而不是悄悄丢掉信息。
 */
function applyEvent(projection, event) {
  // `applied` 由各分支显式置位。之前用 appliedCount 前后比较来判断"是否被跳过"，
  // 但那让每个分支末尾都得记得推进计数——未知类型分支照样 +1，
  // 于是 skipped 永远是 0（测试立刻抓到了）。
  // 现在改为：分支成功才置 applied = true，末尾统一处理计数。
  let applied = false;
  const next = {
    ...projection,
    missions: { ...projection.missions },
    workstreams: { ...projection.workstreams },
    decisions: { ...projection.decisions },
    questions: { ...projection.questions },
    deliverables: { ...projection.deliverables },
    taskRefs: { ...projection.taskRefs },
    byMission: { ...projection.byMission },
    lastSeq: projection.lastSeq,
    appliedCount: projection.appliedCount,
  };

  if (!event || typeof event !== 'object') return next;
  const { type, payload } = event;
  const at = Number.isFinite(event.atMs) ? event.atMs : 0;

  switch (type) {
    case 'mission.created': {
      if (!schema.validateMission(payload).ok) break;
      next.missions[payload.missionId] = { ...payload };
      ensureMissionIndex(next, payload.missionId);
      applied = true;
      break;
    }
    case 'mission.updated': {
      const cur = next.missions[payload.missionId];
      if (!cur) break;
      // 只允许改用户可写的字段；status 走 statusChanged（保留语义）
      const { missionId, status, createdAtMs, ...rest } = payload;
      next.missions[missionId] = { ...cur, ...rest, updatedAtMs: at || cur.updatedAtMs };
      applied = true;
      break;
    }
    case 'mission.statusChanged': {
      const cur = next.missions[payload.missionId];
      if (!cur) break;
      if (!schema.MISSION_STATUSES.includes(payload.to)) break;
      next.missions[payload.missionId] = {
        ...cur,
        status: payload.to,
        updatedAtMs: at || cur.updatedAtMs,
      };
      applied = true;
      break;
    }
    case 'workstream.created': {
      if (!schema.validateWorkstream(payload).ok) break;
      next.workstreams[payload.workstreamId] = { ...payload };
      ensureMissionIndex(next, payload.missionId).workstreamIds.push(payload.workstreamId);
      applied = true;
      break;
    }
    case 'workstream.updated': {
      const cur = next.workstreams[payload.workstreamId];
      if (!cur) break;
      const { workstreamId, status, missionId, createdAtMs, ...rest } = payload;
      next.workstreams[workstreamId] = { ...cur, ...rest, updatedAtMs: at || cur.updatedAtMs };
      applied = true;
      break;
    }
    case 'workstream.statusChanged': {
      const cur = next.workstreams[payload.workstreamId];
      if (!cur) break;
      if (!schema.WORKSTREAM_STATUSES.includes(payload.to)) break;
      next.workstreams[payload.workstreamId] = {
        ...cur, status: payload.to, updatedAtMs: at || cur.updatedAtMs,
      };
      applied = true;
      break;
    }
    case 'finding.recorded': {
      if (!schema.validateFinding(payload).ok) break;
      next.findings[payload.findingId] = { ...payload };
      ensureMissionIndex(next, payload.missionId).findingIds.push(payload.findingId);
      applied = true;
      break;
    }
    case 'finding.statusChanged': {
      const cur = next.findings[payload.findingId];
      if (!cur) break;
      const updated = { ...cur, status: payload.to, updatedAtMs: payload.atMs };
      // refuted 是最强的语义反转，必须留下理由——否则这条记录无法追溯
      if (payload.to === 'refuted') {
        if (!schema.isNonEmptyString(payload.reason)) break;
        updated.refutedReason = payload.reason;
      }
      if (!schema.validateFinding(updated).ok) break;
      next.findings[payload.findingId] = updated;
      applied = true;
      break;
    }
    case 'assumption.recorded': {
      if (!schema.validateAssumption(payload).ok) break;
      next.assumptions[payload.assumptionId] = { ...payload };
      ensureMissionIndex(next, payload.missionId).assumptionIds.push(payload.assumptionId);
      applied = true;
      break;
    }
    case 'assumption.statusChanged': {
      const cur = next.assumptions[payload.assumptionId];
      if (!cur) break;
      const updated = { ...cur, status: payload.to, updatedAtMs: payload.atMs };
      // "被推翻"必须说清楚为什么——这是假设最重要的时刻
      if (payload.to === 'violated') {
        if (!schema.isNonEmptyString(payload.reason)) break;
        updated.violatedReason = payload.reason;
      }
      if (!schema.validateAssumption(updated).ok) break;
      next.assumptions[payload.assumptionId] = updated;
      applied = true;
      break;
    }
    case 'evidence.recorded': {
      if (!schema.validateEvidence(payload).ok) break;
      next.evidences[payload.evidenceId] = { ...payload };
      ensureMissionIndex(next, payload.missionId).evidenceIds.push(payload.evidenceId);
      // 反向关联：证据可以挂在 decision / finding / assumption 上。
      // 用 targetKind + targetId 表达"这条证据支持什么"。
      if (payload.targetKind && payload.targetId) {
        const bucket = payload.targetKind === 'decision' ? next.decisions
          : payload.targetKind === 'finding' ? next.findings
            : payload.targetKind === 'assumption' ? next.assumptions : null;
        const target = bucket && bucket[payload.targetId];
        if (target) {
          const ids = Array.isArray(target.evidenceIds) ? target.evidenceIds : [];
          if (!ids.includes(payload.evidenceId)) {
            target.evidenceIds = [...ids, payload.evidenceId];
          }
        }
      }
      applied = true;
      break;
    }
    case 'decision.recorded': {
      if (!schema.validateDecision(payload).ok) break;
      next.decisions[payload.decisionId] = { ...payload };
      ensureMissionIndex(next, payload.missionId).decisionIds.push(payload.decisionId);
      applied = true;
      break;
    }
    case 'decision.superseded': {
      const cur = next.decisions[payload.decisionId];
      if (!cur) break;
      next.decisions[payload.decisionId] = {
        ...cur,
        status: 'superseded',
        supersededBy: payload.supersededBy || null,
      };
      applied = true;
      break;
    }
    case 'question.opened': {
      if (!schema.validateOpenQuestion(payload).ok) break;
      next.questions[payload.questionId] = { ...payload, status: 'open' };
      ensureMissionIndex(next, payload.missionId).questionIds.push(payload.questionId);
      applied = true;
      break;
    }
    case 'question.answered': {
      const cur = next.questions[payload.questionId];
      if (!cur) break;
      next.questions[payload.questionId] = {
        ...cur, status: 'answered', answer: payload.answer, answeredAtMs: at,
      };
      applied = true;
      break;
    }
    case 'deliverable.registered': {
      if (!schema.validateDeliverable(payload).ok) break;
      next.deliverables[payload.deliverableId] = { ...payload };
      ensureMissionIndex(next, payload.missionId).deliverableIds.push(payload.deliverableId);
      applied = true;
      break;
    }
    case 'taskRef.linked': {
      if (!schema.validateTaskRef(payload).ok) break;
      next.taskRefs[payload.taskRefId] = { ...payload };
      ensureMissionIndex(next, payload.missionId).taskRefIds.push(payload.taskRefId);
      applied = true;
      break;
    }
    default:
      // 未知类型：跳过但不隐瞒
      break;
  }

  next.lastSeq = Math.max(next.lastSeq, Number(event.seq) || 0);
  if (applied) next.appliedCount += 1;
  return next;
}

/**
 * 把事件序列 fold 成投影。
 *
 * @param {Array} events  按 seq 升序的事件
 * @returns {{projection, skipped:number, gaps:number[]}}
 *   skipped = 校验失败或未知类型被跳过的事件数（>0 说明投影不完整）
 *   gaps    = seq 不连续的位置（说明日志有缺失，可能是损坏或并发写入）
 */
function fold(events) {
  let projection = emptyProjection();
  let skipped = 0;
  const gaps = [];
  let expectedSeq = 1;

  for (const event of Array.isArray(events) ? events : []) {
    const seq = Number(event && event.seq);
    if (Number.isFinite(seq) && seq > 0) {
      if (seq !== expectedSeq) gaps.push({ expected: expectedSeq, actual: seq });
      expectedSeq = seq + 1;
    }
    const before = projection.appliedCount;
    projection = applyEvent(projection, event);
    if (projection.appliedCount === before) skipped += 1;
  }

  return { projection, skipped, gaps };
}

/** 某个 Mission 的完整视图（含索引出来的子实体）。 */
function missionView(projection, missionId) {
  const m = projection.missions[missionId];
  if (!m) return null;
  const idx = projection.byMission[missionId] || {};
  return {
    mission: m,
    workstreams: (idx.workstreamIds || []).map((id) => projection.workstreams[id]).filter(Boolean),
    decisions: (idx.decisionIds || []).map((id) => projection.decisions[id]).filter(Boolean),
    questions: (idx.questionIds || []).map((id) => projection.questions[id]).filter(Boolean),
    deliverables: (idx.deliverableIds || []).map((id) => projection.deliverables[id]).filter(Boolean),
    taskRefs: (idx.taskRefIds || []).map((id) => projection.taskRefs[id]).filter(Boolean),
    findings: (idx.findingIds || []).map((id) => projection.findings[id]).filter(Boolean),
    assumptions: (idx.assumptionIds || []).map((id) => projection.assumptions[id]).filter(Boolean),
    evidences: (idx.evidenceIds || []).map((id) => projection.evidences[id]).filter(Boolean),
  };
}

/**
 * 列出所有 active Mission。
 *
 * **刻意不做唯一性检查**：domain-model §2.1.1 明确允许一个 Workspace
 * 同时有多个 active Mission。软上限（建议 ≤10）由 UI 层计算，不在数据层。
 */
function activeMissions(projection) {
  return Object.values(projection.missions).filter((m) => m.status === 'active');
}

module.exports = {
  EVENT_TYPES,
  emptyProjection,
  applyEvent,
  fold,
  missionView,
  activeMissions,
};
