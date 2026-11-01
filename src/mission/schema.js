// src/mission/schema.js — Mission Core 实体 schema 与校验（P1，纯函数，零依赖）。
//
// 第一性原理：为什么 schema 必须先于存储
//
//   Mission Core 的价值是"跨 Session 的项目记忆"。它的失效模式不是崩溃，
//   而是**静默的语义腐坏**：
//     · 把 Focused（UI 偏好）当成 Mission 状态存下来 → 两个事实作者
//     · 把 Running（Harness 的事实）写进 Mission → 重启后状态撒谎
//     · 加一个"全局唯一 active"约束 → 用户想并行推进两个项目时被挡住
//
//   这些错误的共同点是**它们在写入时看起来都很合理**，只有在几天后
//   才会表现为"状态不对但说不清哪里不对"。所以 schema 层要把
//   **哪些字段允许写、哪些是派生的、哪些根本不存在** 机械地钉死。
//
//   本文件只做：
//     1. 实体定义（Mission / Workstream / Decision / OpenQuestion / Deliverable / TaskRef）
//     2. 校验（纯函数，输入脏数据不抛异常，返回 {ok, errors}）
//     3. 派生字段的显式标记（不允许被写入）
//
//   不做：存储、IO、事件日志、投影 fold（那些在 store.js / projection.js）。
//   严格分离的理由：schema 是**契约**，存储是**实现**。混在一起后，
//   想换存储格式就得动契约，而契约本应稳定。
'use strict';

const SCHEMA_VERSION = 1;

/** 实体类型。事件日志的 type 字段就是这些值。 */
const ENTITY_TYPES = Object.freeze([
  'mission',
  'workstream',
  'decision',
  'openQuestion',
  'deliverable',
  'taskRef',
]);

/** Mission 状态。**注意：这里没有 'focused'——那是 UI 概念，不是 Mission 状态。** */
const MISSION_STATUSES = Object.freeze(['active', 'paused', 'completed', 'abandoned']);

/** Workstream 状态。 */
const WORKSTREAM_STATUSES = Object.freeze(['active', 'blocked', 'done', 'dropped']);

/** Decision 状态。 */
const DECISION_STATUSES = Object.freeze(['proposed', 'accepted', 'superseded', 'rejected']);

/** OpenQuestion 状态。 */
const QUESTION_STATUSES = Object.freeze(['open', 'answered', 'dropped']);

/**
 * **派生字段黑名单**：这些值绝不允许出现在持久化的实体里。
 *
 * 每一个都对应一个具体的"两个事实作者"风险：
 *   · running      → Harness 的实时事实，写进 Mission 就会在重启后撒谎
 *   · focused      → UI 偏好，属于 ui-state.json，不属于项目数据
 *   · awaitingUser → 派生自 Harness 的 pending approval/question
 *   · stale        → 派生自 updatedAtMs 距今天数
 *   · sessionId    → raw session id 是隐私边界，只能存派生句柄
 *   · prompt/args/content → 隐私边界
 */
const FORBIDDEN_PERSISTED_FIELDS = Object.freeze([
  'running',
  'focused',
  'isFocused',
  'awaitingUser',
  'stale',
  'sessionId',
  'prompt',
  'toolArgs',
  'artifactContent',
]);

/** 隐私相关的禁止字段（与上面重叠但语义不同，单独列出便于诊断区分）。 */
const PRIVACY_FORBIDDEN_FIELDS = Object.freeze([
  'sessionId',
  'prompt',
  'toolArgs',
  'artifactContent',
  'absolutePath',
  'cwd',
]);

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNonNegative(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** 派生句柄：`<prefix>-<opaque>`，永不包含 raw session id。 */
function isDerivedHandle(v, prefix) {
  if (!isNonEmptyString(v)) return false;
  return new RegExp(`^${prefix}-[A-Za-z0-9][A-Za-z0-9._:-]*$`).test(v);
}

/** 收集所有禁用字段（递归，因为嵌套对象里也可能混进来）。 */
function collectForbidden(obj, path = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => collectForbidden(item, `${path}[${i}]`, out));
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_PERSISTED_FIELDS.includes(key)) out.push(here);
    collectForbidden(value, here, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 实体校验
// ---------------------------------------------------------------------------

/**
 * 校验一个 Mission。
 *
 * 硬约束（来自 domain-model.md §2.1）：
 *   · status 只能是四种之一，**没有 focused**
 *   · 允许多个 active（本函数不做唯一性检查——那是存储层的语境，且**禁止**做）
 *   · running 等派生字段不得出现
 */
function validateMission(m) {
  const errors = [];
  if (!isPlainObject(m)) return { ok: false, errors: ['mission must be an object'] };

  if (!isNonEmptyString(m.missionId) || !/^mis-[A-Za-z0-9][A-Za-z0-9-]*$/.test(m.missionId)) {
    errors.push('missionId must look like "mis-<opaque>"');
  }
  if (!isNonEmptyString(m.title)) errors.push('title is required');
  if (!isNonEmptyString(m.intent)) {
    errors.push('intent is required (the user\'s own words; never model-rewritten)');
  }
  if (!MISSION_STATUSES.includes(m.status)) {
    errors.push(`status must be one of ${MISSION_STATUSES.join('|')} (note: "focused" is a UI concept, not a Mission status)`);
  }
  if (!isNonEmptyString(m.workspaceId)) {
    errors.push('workspaceId is required (join to a Project Workspace; never an absolute path)');
  }
  if (!isFiniteNonNegative(m.createdAtMs)) errors.push('createdAtMs must be a non-negative finite number');
  if (!isFiniteNonNegative(m.updatedAtMs)) errors.push('updatedAtMs must be a non-negative finite number');
  if (m.createdAtMs > m.updatedAtMs) errors.push('createdAtMs must not be after updatedAtMs');

  // 数组型索引字段
  for (const key of ['constraints', 'workstreamIds', 'decisionIds', 'openQuestionIds', 'deliverableIds']) {
    if (m[key] !== undefined && !Array.isArray(m[key])) errors.push(`${key} must be an array`);
  }

  // constraints 的元素形状
  if (Array.isArray(m.constraints)) {
    m.constraints.forEach((c, i) => {
      if (!isPlainObject(c)) { errors.push(`constraints[${i}] must be an object`); return; }
      if (!isNonEmptyString(c.id)) errors.push(`constraints[${i}].id is required`);
      if (!isNonEmptyString(c.text)) errors.push(`constraints[${i}].text is required`);
      if (c.source !== 'user' && c.source !== 'model') {
        errors.push(`constraints[${i}].source must be "user" or "model"`);
      }
    });
  }

  // Mission 内部的 focus 指针（注意：与全局 UI 的 focusedMissionId 不是一回事）
  if (m.currentFocusWorkstreamId !== undefined && m.currentFocusWorkstreamId !== null) {
    if (!isNonEmptyString(m.currentFocusWorkstreamId)) {
      errors.push('currentFocusWorkstreamId must be a workstream id or null');
    }
  }

  // lastSessionRef 只能是派生句柄
  if (m.lastSessionRef !== undefined && m.lastSessionRef !== null) {
    if (!isDerivedHandle(m.lastSessionRef, 'sess-h')) {
      errors.push('lastSessionRef must be a derived handle (sess-h-…), never a raw session id');
    }
  }

  // 派生字段黑名单
  const forbidden = collectForbidden(m);
  if (forbidden.length) {
    errors.push(`derived fields must not be persisted (they belong to Harness or UI): ${forbidden.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

/** 校验一个 Workstream。 */
function validateWorkstream(w) {
  const errors = [];
  if (!isPlainObject(w)) return { ok: false, errors: ['workstream must be an object'] };

  if (!isNonEmptyString(w.workstreamId) || !/^ws-[A-Za-z0-9][A-Za-z0-9-]*$/.test(w.workstreamId)) {
    errors.push('workstreamId must look like "ws-<opaque>"');
  }
  if (!isNonEmptyString(w.missionId)) errors.push('missionId is required');
  if (!isNonEmptyString(w.title)) errors.push('title is required');
  if (!WORKSTREAM_STATUSES.includes(w.status)) {
    errors.push(`status must be one of ${WORKSTREAM_STATUSES.join('|')}`);
  }
  if (!isFiniteNonNegative(w.createdAtMs)) errors.push('createdAtMs must be a non-negative finite number');
  if (!isFiniteNonNegative(w.updatedAtMs)) errors.push('updatedAtMs must be a non-negative finite number');

  if (w.taskRefIds !== undefined && !Array.isArray(w.taskRefIds)) errors.push('taskRefIds must be an array');

  const forbidden = collectForbidden(w);
  if (forbidden.length) {
    errors.push(`derived fields must not be persisted: ${forbidden.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}

/** 校验一个 Decision（Shared Context 的核心：为什么这么决定）。 */
function validateDecision(d) {
  const errors = [];
  if (!isPlainObject(d)) return { ok: false, errors: ['decision must be an object'] };

  if (!isNonEmptyString(d.decisionId)) errors.push('decisionId is required');
  if (!isNonEmptyString(d.missionId)) errors.push('missionId is required');
  if (!isNonEmptyString(d.text)) errors.push('text is required (what was decided)');
  if (!isNonEmptyString(d.rationale)) {
    errors.push('rationale is required — a decision without WHY is exactly what compaction destroys');
  }
  if (!DECISION_STATUSES.includes(d.status)) {
    errors.push(`status must be one of ${DECISION_STATUSES.join('|')}`);
  }
  if (!isFiniteNonNegative(d.decidedAtMs)) errors.push('decidedAtMs must be a non-negative finite number');
  if (d.decidedBy !== 'user' && d.decidedBy !== 'model') {
    errors.push('decidedBy must be "user" or "model"');
  }
  const forbidden = collectForbidden(d);
  if (forbidden.length) errors.push(`derived fields must not be persisted: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/** 校验一个 OpenQuestion。 */
function validateOpenQuestion(q) {
  const errors = [];
  if (!isPlainObject(q)) return { ok: false, errors: ['openQuestion must be an object'] };

  if (!isNonEmptyString(q.questionId)) errors.push('questionId is required');
  if (!isNonEmptyString(q.missionId)) errors.push('missionId is required');
  if (!isNonEmptyString(q.text)) errors.push('text is required');
  if (!QUESTION_STATUSES.includes(q.status)) {
    errors.push(`status must be one of ${QUESTION_STATUSES.join('|')}`);
  }
  if (!isFiniteNonNegative(q.askedAtMs)) errors.push('askedAtMs must be a non-negative finite number');
  if (q.status === 'answered' && !isNonEmptyString(q.answer)) {
    errors.push('an answered question must carry an answer');
  }
  const forbidden = collectForbidden(q);
  if (forbidden.length) errors.push(`derived fields must not be persisted: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/** 校验一个 Deliverable（产物登记）。 */
function validateDeliverable(d) {
  const errors = [];
  if (!isPlainObject(d)) return { ok: false, errors: ['deliverable must be an object'] };

  if (!isNonEmptyString(d.deliverableId)) errors.push('deliverableId is required');
  if (!isNonEmptyString(d.missionId)) errors.push('missionId is required');
  if (!isNonEmptyString(d.label)) errors.push('label is required');
  // 只存相对路径 + digest；绝对路径是隐私边界
  if (!isNonEmptyString(d.relPath)) errors.push('relPath is required (relative to the workspace)');
  if (d.relPath && (d.relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(d.relPath) || d.relPath.includes('..'))) {
    errors.push('relPath must be a safe workspace-relative path (no absolute paths, no "..")');
  }
  if (!isNonEmptyString(d.digest) || !/^[a-f0-9]{16,64}$/i.test(d.digest)) {
    errors.push('digest must be a hex sha256 (16–64 chars)');
  }
  if (!isFiniteNonNegative(d.registeredAtMs)) errors.push('registeredAtMs must be a non-negative finite number');
  const forbidden = collectForbidden(d);
  if (forbidden.length) errors.push(`derived fields must not be persisted: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * 校验一个 TaskReference —— Mission 与 Harness 的连接点。
 *
 * 关键边界：Mission **不拥有** task 状态，只引用它。
 * 所以这里故意**不允许**出现 status 字段（那是 Harness 的事实）。
 */
function validateTaskRef(t) {
  const errors = [];
  if (!isPlainObject(t)) return { ok: false, errors: ['taskRef must be an object'] };

  if (!isNonEmptyString(t.taskRefId)) errors.push('taskRefId is required');
  if (!isNonEmptyString(t.missionId)) errors.push('missionId is required');
  if (!isNonEmptyString(t.workstreamId)) errors.push('workstreamId is required');
  // 引用 Harness 的标识：只能是派生句柄
  if (!isNonEmptyString(t.harnessRef)) {
    errors.push('harnessRef is required (points at the Harness session/turn)');
  }
  if (t.status !== undefined) {
    errors.push('TaskRef must NOT carry a status — task state is Harness-owned (two owners = lying state)');
  }
  if (t.observedAtMs !== undefined && !isFiniteNonNegative(t.observedAtMs)) {
    errors.push('observedAtMs must be a non-negative finite number when present');
  }
  const forbidden = collectForbidden(t);
  if (forbidden.length) errors.push(`derived fields must not be persisted: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/** 按类型分派校验。未知类型返回失败而不是静默通过。 */
function validateEntity(type, entity) {
  switch (type) {
    case 'mission': return validateMission(entity);
    case 'workstream': return validateWorkstream(entity);
    case 'decision': return validateDecision(entity);
    case 'openQuestion': return validateOpenQuestion(entity);
    case 'deliverable': return validateDeliverable(entity);
    case 'taskRef': return validateTaskRef(entity);
    default:
      return { ok: false, errors: [`unknown entity type: ${type}`] };
  }
}

module.exports = {
  SCHEMA_VERSION,
  ENTITY_TYPES,
  MISSION_STATUSES,
  WORKSTREAM_STATUSES,
  DECISION_STATUSES,
  QUESTION_STATUSES,
  FORBIDDEN_PERSISTED_FIELDS,
  PRIVACY_FORBIDDEN_FIELDS,
  isPlainObject,
  isNonEmptyString,
  isFiniteNonNegative,
  isDerivedHandle,
  collectForbidden,
  validateMission,
  validateWorkstream,
  validateDecision,
  validateOpenQuestion,
  validateDeliverable,
  validateTaskRef,
  validateEntity,
};
