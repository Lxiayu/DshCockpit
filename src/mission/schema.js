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
  // Shared Context 的另外三块（2026-11-01）：
  //   finding    = 我们发现的事实（"X 在 Y 条件下会崩"）
  //   assumption = 暂时采用的判断（"我们假设用户会先登录"）
  //   evidence   = 凭什么相信（"依据是 commit abc"）
  //
  // 为什么这三个必须存在：Decision 只记"决定了什么"，
  // 没有 finding 就没有积累，没有 assumption 就没有地雷标记，
  // 没有 evidence 就无法回答"凭什么相信"。
  'finding',
  'assumption',
  'evidence',
]);

/** Finding 状态：发现的验证程度。 */
const FINDING_STATUSES = Object.freeze(['unverified', 'verified', 'refuted']);

/** Assumption 状态：假设的处境。expired 是**显式**状态，不靠时间推算。 */
const ASSUMPTION_STATUSES = Object.freeze(['unverified', 'holding', 'violated', 'expired']);

/** 置信度三档。**不允许 0-100 的小数**——那是虚假精确。 */
const CONFIDENCES = Object.freeze(['low', 'medium', 'high']);

/** Evidence 的种类（决定 UI 怎么展示引用）。 */
const EVIDENCE_KINDS = Object.freeze(['file', 'commit', 'url', 'command', 'observation']);

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

/**
 * 收集隐私禁用字段（递归）。与 collectForbidden 分开，因为**语义不同**：
 *
 *   collectForbidden  → "这是 Harness 或 UI 的事实，你不许存"（事实作者唯一）
 *   collectPrivacy    → "这是敏感数据，存下来就泄露了"（隐私铁律 §2.4）
 *
 * 一个字段可以同时属于两者（sessionId），但修复动作完全不同：
 * 前者要改成读投影，后者要改成存派生句柄/相对路径。
 *
 * 2026-11-04 修正：`PRIVACY_FORBIDDEN_FIELDS` 此前**只定义未使用**——
 * 也就是说 `cwd` / `absolutePath` 这两条隐私约束在代码里从未被执行。
 * 一个"写在常量里但没人调用"的防线等于没有防线，所以这里补上执行点。
 *
 * @param {object} obj 待检查对象
 * @param {string} [path] 递归路径前缀（错误信息用）
 * @param {string[]} [out] 累积结果
 * @returns {string[]} 命中的字段路径
 */
function collectPrivacy(obj, path = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => collectPrivacy(item, `${path}[${i}]`, out));
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    const here = path ? `${path}.${key}` : key;
    if (PRIVACY_FORBIDDEN_FIELDS.includes(key)) out.push(here);
    collectPrivacy(value, here, out);
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

  // 交付合同（S2）：可选字段，但一旦存在就必须自洽。
  // 老 Mission 没有 contract 仍然有效 —— 升级不是迁移，新能力不强迫旧数据变形状。
  if (m.contract !== undefined && m.contract !== null) {
    if (!isPlainObject(m.contract)) {
      errors.push('contract must be an object when present');
    } else {
      for (const e of validateContract(m.contract)) errors.push(e);
    }
  }

  // 派生字段黑名单
  const forbidden = collectForbidden(m);
  if (forbidden.length) {
    errors.push(`derived fields must not be persisted (they belong to Harness or UI): ${forbidden.join(', ')}`);
  }

  // 隐私黑名单（2026-11-04 起真正执行；此前 PRIVACY_FORBIDDEN_FIELDS 只定义未使用）
  const privacy = collectPrivacy(m);
  if (privacy.length) {
    errors.push(`privacy-sensitive fields must not be persisted (store a derived handle or a Grant reference instead): ${privacy.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 交付合同（S2，2026-11-04）
// ---------------------------------------------------------------------------

/**
 * 验收条件的验证方式。**闭集**：新增一种必须先想清楚"谁来检查、凭什么相信"。
 *
 * 之所以是闭集而不是自由字符串：验证方式是"凭证"的判据。
 * 如果允许模型自己发明一种（比如 "agent-says-so"），
 * 那合同就重新变成了自我报告 —— 而自我报告正是我们要修的病。
 */
const ACCEPTANCE_KINDS = Object.freeze([
  'command',   // 跑一条命令，按退出码判定（真正的自动验证）
  'artifact',  // 必须产出一个具体文件（存在性 + 可选的内容检查）
  'manual',    // 人明确点了"我验收了"（最弱，但诚实）
]);

/** 合同状态。draft = 还在编辑，不参与派发。 */
const CONTRACT_STATUSES = Object.freeze(['draft', 'dispatching', 'active', 'ended']);

/** 派发策略：由确定性规则选出，用户可覆盖。 */
const DISPATCH_STRATEGIES = Object.freeze(['single', 'sequential', 'parallel']);

/**
 * 校验交付合同。返回错误字符串数组（空 = 通过）。
 *
 * 第一性原理：为什么合同不是"多几个输入框"
 *
 *   派发现在只是"发一段文本给 Lead"。Agent 收到后自己决定做多少、
 *   做到什么程度算完成 —— 于是"完成"由**执行者自己定义**。
 *   这正是"Agent 自我报告不能成为完成依据"那句诊断的根。
 *
 *   合同把判定权拿回人类一侧：人先写下"什么算做完"，
 *   并给每条验收条件绑定一种**可检查的**验证方式。
 *   没有验收条件的合同不许存在 —— 否则它只是一段更长的 prompt。
 *
 * 刻意不检查的东西：绝对路径、cwd、sessionId ——
 * 它们在 FORBIDDEN_PERSISTED_FIELDS 里，由 collectForbidden 统一拦截。
 * 合同里放的是 `grantId`（我们自己的授权记录引用），永远不是目录路径。
 *
 * @param {object} c 合同对象
 * @returns {string[]} 错误列表
 */
function validateContract(c) {
  const errors = [];
  if (!isPlainObject(c)) return ['contract must be an object'];

  if (!CONTRACT_STATUSES.includes(c.status)) {
    errors.push(`contract.status must be one of ${CONTRACT_STATUSES.join('|')}`);
  }

  // 验收条件：必须有，且每条都要有可检查的验证方式。
  // 「一条都没有」不是"还没填"，而是"这份合同无法判定完成"——直接拒。
  if (!Array.isArray(c.acceptance)) {
    errors.push('contract.acceptance must be an array');
  } else if (c.acceptance.length === 0) {
    errors.push('contract.acceptance must contain at least one criterion '
      + '(a contract with no acceptance test cannot decide when the work is done)');
  } else {
    c.acceptance.forEach((a, i) => {
      if (!isPlainObject(a)) { errors.push(`contract.acceptance[${i}] must be an object`); return; }
      if (!isNonEmptyString(a.id)) errors.push(`contract.acceptance[${i}].id is required`);
      if (!isNonEmptyString(a.text)) {
        errors.push(`contract.acceptance[${i}].text is required (what must be true)`);
      }
      if (!ACCEPTANCE_KINDS.includes(a.kind)) {
        errors.push(`contract.acceptance[${i}].kind must be one of ${ACCEPTANCE_KINDS.join('|')}`);
      }
      // 只写 kind 而不写判据等于没有验证方式：
      // command 必须给出跑什么，artifact 必须给出产物引用。
      if (a.kind === 'command' && !isNonEmptyString(a.command)) {
        errors.push(`contract.acceptance[${i}].command is required when kind=command`);
      }
      if (a.kind === 'artifact' && !isNonEmptyString(a.artifactRef)) {
        errors.push(`contract.acceptance[${i}].artifactRef is required when kind=artifact`);
      }
    });
  }

  // 预算：可留空（空 = 不限），给了就必须是非负有限数。
  // 0 合法（"不许花"），负数与 NaN 不合法。
  if (c.budget !== undefined && c.budget !== null) {
    if (!isPlainObject(c.budget)) {
      errors.push('contract.budget must be an object when present');
    } else {
      if (c.budget.maxTokens !== undefined && c.budget.maxTokens !== null
        && !isFiniteNonNegative(c.budget.maxTokens)) {
        errors.push('contract.budget.maxTokens must be a non-negative finite number');
      }
      if (c.budget.maxWallMs !== undefined && c.budget.maxWallMs !== null
        && !isFiniteNonNegative(c.budget.maxWallMs)) {
        errors.push('contract.budget.maxWallMs must be a non-negative finite number');
      }
    }
  }

  // 工作目录只能引用 Grant，不能是路径。
  if (c.grantId !== undefined && c.grantId !== null) {
    if (!isNonEmptyString(c.grantId) || !/^gr-[A-Za-z0-9][A-Za-z0-9-]*$/.test(c.grantId)) {
      errors.push('contract.grantId must look like "gr-<opaque>" (a Grant reference, never a path)');
    }
  }

  // 派发策略：确定性规则选出来的结果，用户可覆盖。
  if (c.strategy !== undefined && c.strategy !== null) {
    if (!DISPATCH_STRATEGIES.includes(c.strategy)) {
      errors.push(`contract.strategy must be one of ${DISPATCH_STRATEGIES.join('|')}`);
    }
  }

  // 幂等键：同一份合同重复派发时用来识别"这是同一次下达"。
  // 它会写进 prompt 的固定首行标记，派发确认阶段用它匹配。
  if (c.dispatchKey !== undefined && c.dispatchKey !== null) {
    if (!isNonEmptyString(c.dispatchKey)) {
      errors.push('contract.dispatchKey must be a non-empty string when present');
    }
  }

  return errors;
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

/**
 * 校验一个 Finding（我们发现了什么）。
 *
 * 与 Decision 的区别：Decision 是"我们选择了 A"，
 * Finding 是"我们发现 X 成立"。前者是意志，后者是事实。
 */
function validateFinding(f) {
  const errors = [];
  if (!isPlainObject(f)) return { ok: false, errors: ['finding must be an object'] };

  if (!isNonEmptyString(f.findingId)) errors.push('findingId is required');
  if (!isNonEmptyString(f.missionId)) errors.push('missionId is required');
  if (!isNonEmptyString(f.text)) errors.push('text is required (what was found)');
  if (!FINDING_STATUSES.includes(f.status)) {
    errors.push(`status must be one of ${FINDING_STATUSES.join('|')}`);
  }
  if (!CONFIDENCES.includes(f.confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCES.join('|')} — no fake precision like 73%`);
  }
  if (!isFiniteNonNegative(f.foundAtMs)) errors.push('foundAtMs must be a non-negative finite number');
  if (f.foundBy !== 'user' && f.foundBy !== 'model') {
    errors.push('foundBy must be "user" or "model"');
  }
  // 证据引用：允许空（早期发现可能还没有证据），但必须是有序的 id 数组
  if (f.evidenceIds !== undefined && !Array.isArray(f.evidenceIds)) errors.push('evidenceIds must be an array');
  if (f.workstreamId !== undefined && f.workstreamId !== null && !isNonEmptyString(f.workstreamId)) {
    errors.push('workstreamId must be a workstream id or null');
  }
  const forbidden = collectForbidden(f);
  if (forbidden.length) errors.push(`derived fields must not be persisted: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * 校验一个 Assumption（我们暂时假设什么）。
 *
 * **为什么这个实体最重要**：假设是未来的地雷。
 * 没有它，团队会在三天后基于一个早已不成立的前提继续工作，
 * 而且没人知道当初假设了什么。
 *
 * 所以它必须有 `expiresAtMs` 与显式的 `status`——
 * 而不是靠"时间过了就自动过期"（那是**推断**，不是事实）。
 */
function validateAssumption(a) {
  const errors = [];
  if (!isPlainObject(a)) return { ok: false, errors: ['assumption must be an object'] };

  if (!isNonEmptyString(a.assumptionId)) errors.push('assumptionId is required');
  if (!isNonEmptyString(a.missionId)) errors.push('missionId is required');
  if (!isNonEmptyString(a.text)) errors.push('text is required (what is being assumed)');
  if (!ASSUMPTION_STATUSES.includes(a.status)) {
    errors.push(`status must be one of ${ASSUMPTION_STATUSES.join('|')}`);
  }
  if (!isFiniteNonNegative(a.assumedAtMs)) errors.push('assumedAtMs must be a non-negative finite number');
  if (a.assumedBy !== 'user' && a.assumedBy !== 'model') {
    errors.push('assumedBy must be "user" or "model"');
  }
  // 验证方法：怎么确认这个假设还成立
  if (a.verifyBy !== undefined && a.verifyBy !== null && !isNonEmptyString(a.verifyBy)) {
    errors.push('verifyBy must be a non-empty string (how to check it) or null');
  }
  // 过期时间：可选，但给了就必须是有限数且不早于 assumedAtMs
  if (a.expiresAtMs !== undefined && a.expiresAtMs !== null) {
    if (!isFiniteNonNegative(a.expiresAtMs)) {
      errors.push('expiresAtMs must be a non-negative finite number or null');
    } else if (isFiniteNonNegative(a.assumedAtMs) && a.expiresAtMs < a.assumedAtMs) {
      errors.push('expiresAtMs must not be before assumedAtMs');
    }
  }
  // "被推翻"时必须说清楚为什么——否则是一条无法追溯的记录
  if (a.status === 'violated' && !isNonEmptyString(a.violatedReason)) {
    errors.push('a violated assumption must say why (violatedReason) — otherwise it is untraceable');
  }
  const forbidden = collectForbidden(a);
  if (forbidden.length) errors.push(`derived fields must not be persisted: ${forbidden.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * 校验一条 Evidence（凭什么相信）。
 *
 * 关键约束：**只存引用，不存内容**。
 * `ref` 是相对路径 / commit sha / URL / 命令 / 观察描述，
 * 绝不存文件内容本身（那是隐私边界，也会让事件日志爆炸）。
 */
function validateEvidence(e) {
  const errors = [];
  if (!isPlainObject(e)) return { ok: false, errors: ['evidence must be an object'] };

  if (!isNonEmptyString(e.evidenceId)) errors.push('evidenceId is required');
  if (!isNonEmptyString(e.missionId)) errors.push('missionId is required');
  if (!EVIDENCE_KINDS.includes(e.kind)) {
    errors.push(`kind must be one of ${EVIDENCE_KINDS.join('|')}`);
  }
  if (!isNonEmptyString(e.ref)) errors.push('ref is required (what to look at)');
  if (!isNonEmptyString(e.claim)) {
    errors.push('claim is required — evidence without a claim is just a link, it does not support anything');
  }
  if (!isFiniteNonNegative(e.recordedAtMs)) errors.push('recordedAtMs must be a non-negative finite number');
  if (e.recordedBy !== 'user' && e.recordedBy !== 'model') {
    errors.push('recordedBy must be "user" or "model"');
  }
  // ref 不能是绝对路径（隐私边界）
  // schema.js 刻意零依赖（连 node:path 都不 require），所以绝对路径用字符串判断。
  if (isNonEmptyString(e.ref) && (e.ref.startsWith('/') || /^[A-Za-z]:\\/.test(e.ref))) {
    errors.push('ref must be relative (absolute paths are a privacy boundary)');
  }
  const forbidden = collectForbidden(e);
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
    case 'finding': return validateFinding(entity);
    case 'assumption': return validateAssumption(entity);
    case 'evidence': return validateEvidence(entity);
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
  ACCEPTANCE_KINDS,
  CONTRACT_STATUSES,
  DISPATCH_STRATEGIES,
  validateContract,
  isPlainObject,
  isNonEmptyString,
  isFiniteNonNegative,
  isDerivedHandle,
  collectForbidden,
  collectPrivacy,
  validateMission,
  validateWorkstream,
  validateDecision,
  validateOpenQuestion,
  validateDeliverable,
  validateTaskRef,
  validateFinding,
  validateAssumption,
  validateEvidence,
  validateEntity,
  FINDING_STATUSES,
  ASSUMPTION_STATUSES,
  CONFIDENCES,
  EVIDENCE_KINDS,
};
