'use strict';

// src/team/runtime/team-schema.js — Team Runtime v0 词表与身份派生。
//
// 纯 CommonJS：零依赖（只有纯计算的 node:crypto），无 Electron / DOM / Pixi /
// fs / 网络 / office 模块 / LLM / 时钟读取。所有时间由调用方注入的 clock 提供。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md
// 调研依据：docs/research/TEAM-RUNTIME-OSS-RESEARCH-2026-10.md
//
// 命名边界（契约 §1.1）：本模块**不占用** Harness 的 `team/*` 事件域。Team 事实
// 使用 `job/*`、`run/*`、`artifact/*` 前缀，与 Harness 的 `turn/*`、`tool/*`、
// `subagent/*` 无重叠。

const crypto = require('node:crypto');

const TEAM_SCHEMA_VERSION = 1;

// ---- 角色（v0 固定枚举；不来自模型、不来自 Harness、不可运行时注册） ----------

const ROLES = Object.freeze(['researcher', 'reviewer']);

// ---- 状态（契约 §3） --------------------------------------------------------

// `dispatched` 与 `running` 分开：前者"已交给执行方"，后者"执行方已确认开始"
// （对应 Temporal ActivityTaskScheduled→Started、REAPI QUEUED→EXECUTING）。
// `attention` 不是终态（可回到 running）。
const RUN_STATUSES = Object.freeze([
  'pending', 'dispatched', 'running', 'attention', 'completed', 'failed', 'cancelled',
]);
const JOB_STATUSES = Object.freeze([
  'pending', 'running', 'attention', 'completed', 'failed', 'cancelled',
]);
const TERMINAL_RUN_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
const TERMINAL_JOB_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed', 'cancelled']);

// ---- artifact ---------------------------------------------------------------

const ARTIFACT_KINDS = Object.freeze(['research-notes', 'review-findings']);
const ARTIFACT_ID_PREFIX = 'art:';
const ARTIFACT_DIGEST_PREFIX = 'art-sha256:';

// ---- 事件类型（append-only fact log） ---------------------------------------

// v0.6（WP2）：progress phase 的 token 形状（闭集校验在执行层 schema 与 office 侧；
// 本层只保证"是粗粒度 token，不是模型文本"）。
const PROGRESS_PHASE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const FACT_TYPES = Object.freeze([
  'job/created',
  'run/dispatched',
  'run/started',
  'run/progress',
  'artifact/available',
  'run/completed',
  'run/failed',
  'run/cancelled',
  'run/attention',
  'run/cancel-requested',
  'run/cancel-acknowledged',
  'job/completed',
  'job/failed',
  'job/cancelled',
  'job/attention',
]);
// 由 Runtime 在 fold 时自动追加的收敛事件（不是调用方命令）。
const JOB_CONVERGENCE_FACT_BY_STATUS = Object.freeze({
  completed: 'job/completed',
  failed: 'job/failed',
  cancelled: 'job/cancelled',
  attention: 'job/attention',
});

// ---- 稳定诊断码 --------------------------------------------------------------

const ERROR_CODES = Object.freeze([
  'PLAN_UNSUPPORTED',
  'JOB_ALREADY_EXISTS',
  'JOB_NOT_CREATED',
  'JOB_TERMINAL',
  'UNKNOWN_ROLE',
  'UNKNOWN_RUN',
  'RUN_NOT_PENDING',
  'RUN_NOT_DISPATCHED',
  'RUN_ALREADY_TERMINAL',
  'DEPENDENCIES_UNSATISFIED',
  'ARTIFACT_PRODUCER_NOT_RUNNING',
  'ARTIFACT_KIND_NOT_OWNED',
  'ARTIFACT_ALREADY_PRODUCED',
  'ARTIFACT_UNKNOWN',
  'ARTIFACT_NOT_CONSUMABLE',
  'INVALID_OUTCOME',
  'TERMINAL_EVIDENCE_REQUIRED',
  'INVALID_ATTENTION_REASON',
  'INVALID_PROGRESS_PHASE',
  'CANCEL_NOT_REQUESTED',
  'DUPLICATE',
  'FACTS_LIMIT_REACHED',
  'HANDOFF_INCOMPLETE',
]);

// ---- v0 计划（唯一被接受的形状；契约 §5.1） ----------------------------------

/** 固定闭环：researcher → reviewer。**任何其它 plan 一律拒绝** —— 这是
 *  "禁止任意任务自动拆解"在契约层的落点：图是常量，不是输入。 */
const TEAM_V0_PLAN = Object.freeze([
  Object.freeze({
    role: 'researcher',
    dependsOn: Object.freeze([]),
    produces: Object.freeze(['research-notes']),
    consumes: Object.freeze([]),
  }),
  Object.freeze({
    role: 'reviewer',
    dependsOn: Object.freeze(['researcher']),
    produces: Object.freeze(['review-findings']),
    consumes: Object.freeze(['research-notes']),
  }),
]);

// ---- 上限（有界账本，契约 §8-5） ---------------------------------------------

const FACTS_MAX = 4096;

/**
 * 显式的 effort budget（契约 §5.3）。
 *
 * 调研结论（Anthropic orchestrator-worker 工程文 + 多代理综述）：多代理的 token 成本约为
 * 单代理对话的 15 倍，且"effort scaling rules 必须写死在配置里，不能留给 agent 自行决定"；
 * "结构比规模重要 —— 一个紧凑的 5 角色 SOP 团队胜过 50 个无结构 agent"。
 *
 * v0 的做法：把预算**写成常量**并与 plan 的形状断言一致（测试保证），而不是留给运行时
 * 自行扩张。plan 变宽而不改预算会让测试失败 —— 这是"禁止任意自动拆解"的第二道锁。
 */
const TEAM_V0_BUDGET = Object.freeze({
  maxRuns: TEAM_V0_PLAN.length,
  maxArtifacts: TEAM_V0_PLAN.reduce((sum, entry) => sum + entry.produces.length, 0),
  maxFacts: FACTS_MAX,
});
const EVIDENCE_MAX_CHARS = 120;
// evidence = `<source-event>:<coarse-reason>`，两段都必须是粗粒度 token
// （允许 `turn/end` 这类带 `/` 的事件名）。prose 一律拒绝 —— 隐私边界（§9）。
const EVIDENCE_RE = /^[a-z][a-z0-9_/-]{0,47}:[a-z][a-z0-9_-]{0,47}$/;
const ATTENTION_REASON_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_TEXT_FIELD = 128;

// ---- 身份派生（确定性；契约 §2.3 / §2.4） ------------------------------------

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** v0 恒为 1（重试未实现；见契约 §11-5）。 */
const DEFAULT_ATTEMPT = 1;

/** runId = `${jobId}:${role}:${attempt}` —— 确定性，不含随机数。 */
function runIdFor(jobId, role, attempt) {
  return `${jobId}:${role}:${attempt}`;
}

/** artifactId 由 Runtime 派生（调用方不能提供）：id 本身编码生产者，
 *  因此"伪造生产者"在结构上不可能（对应 REAPI 的内容寻址 + Argo 的
 *  `from: {{tasks.X…}}` 生产者绑定）。 */
function artifactIdFor(jobId, runId, kind) {
  return ARTIFACT_ID_PREFIX + sha256Hex(`${jobId}|${runId}|${kind}`).slice(0, 16);
}

/** digest 是**形状标记**，v0 不承载真实内容哈希（内容绝不进事实层，§9）。
 *  它把 (生产者, 产物槽位, 产出序号) 绑在一起，使"同一槽位的两次产出"不会得到
 *  相同 digest —— v0 禁止重复产出，因此 revision 恒为 0，字段为前向兼容保留。 */
function digestFor(jobId, runId, kind, revision) {
  const rev = Number.isInteger(revision) && revision >= 0 ? revision : 0;
  return ARTIFACT_DIGEST_PREFIX + sha256Hex(`${jobId}|${runId}|${kind}|${rev}`).slice(0, 16);
}

/** 命令幂等键（契约 §8-1）：同一 dedupeKey 的重复命令被吸收。 */
function dedupeKeyFor(parts) {
  return sha256Hex(parts.filter((p) => p !== undefined && p !== null).join('|')).slice(0, 32);
}

// ---- 形状校验 ---------------------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function isBoundedToken(value, max = MAX_TEXT_FIELD) {
  return isNonEmptyString(value) && value.length <= max;
}

function planMatchesV0(plan) {
  if (!Array.isArray(plan) || plan.length !== TEAM_V0_PLAN.length) return false;
  for (let i = 0; i < TEAM_V0_PLAN.length; i += 1) {
    const a = plan[i];
    const b = TEAM_V0_PLAN[i];
    if (!a || typeof a !== 'object') return false;
    if (a.role !== b.role) return false;
    if (JSON.stringify(a.dependsOn) !== JSON.stringify(b.dependsOn)) return false;
    if (JSON.stringify(a.produces) !== JSON.stringify(b.produces)) return false;
    if (JSON.stringify(a.consumes) !== JSON.stringify(b.consumes)) return false;
  }
  return true;
}

module.exports = {
  TEAM_SCHEMA_VERSION,
  ROLES,
  RUN_STATUSES,
  JOB_STATUSES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_JOB_STATUSES,
  TERMINAL_OUTCOMES,
  ARTIFACT_KINDS,
  ARTIFACT_ID_PREFIX,
  ARTIFACT_DIGEST_PREFIX,
  FACT_TYPES,
  PROGRESS_PHASE_RE,
  JOB_CONVERGENCE_FACT_BY_STATUS,
  ERROR_CODES,
  TEAM_V0_PLAN,
  TEAM_V0_BUDGET,
  FACTS_MAX,
  EVIDENCE_MAX_CHARS,
  EVIDENCE_RE,
  ATTENTION_REASON_RE,
  sha256Hex,
  DEFAULT_ATTEMPT,
  runIdFor,
  artifactIdFor,
  digestFor,
  dedupeKeyFor,
  isNonEmptyString,
  isBoundedToken,
  planMatchesV0,
};
