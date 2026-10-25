'use strict';

// src/team/runtime/team-office-adapter.js — Team → Office 白名单映射器（第二阶段第 5 项）。
//
// 纯 CommonJS、**无状态纯函数**：零依赖（只有 team-schema 的纯词表与 sha256），
// 无 Electron / DOM / Pixi / fs / 网络 / 时钟读取 / office 模块 import。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md §13
//
// 职责边界（Team 契约 §10 / §13.1）：
//   - Team Runtime 是**唯一事实作者**。本模块只做"Team fact → 白名单 office 事实"的
//     翻译，**不**判断依赖是否满足、**不**创建/关闭 WorkerRun、**不**读 label/prompt/
//     任务正文、**不**从 UI 文本猜 Role。
//   - 无状态是刻意的：`mapFact()` 对同一 Team fact 恒等输出，因此 replay / duplicate /
//     乱序的映射结果天然一致；幂等由 office 侧的既有不变式兜底（见 §13.4）。
//   - 失败一律 fail-closed：返回 { ok:false, code, officeFacts: [] }，绝不猜测。

const {
  ROLES,
  TERMINAL_OUTCOMES,
  ARTIFACT_KINDS,
  EVIDENCE_RE,
  EVIDENCE_MAX_CHARS,
  ATTENTION_REASON_RE,
  JOB_STATUSES,
  DEFAULT_ATTEMPT,
  runIdFor,
  sha256Hex,
  isNonEmptyString,
} = require('./team-schema.js');

/**
 * Role → Seat 显式映射（契约 §13.3）。
 *
 * 静态、冻结、受测试保护。**不是**从 role 名推导出来的，也**不会**在缺项时回退成
 * "role 名当座位"：缺项 → `TEAM_SEAT_UNMAPPED` fail-closed。表是唯一权威 ——
 * 改这张表就改绑定结果（有测试证明"表决定，而非名字决定"）。
 *
 * 语义理由：Team 的 `researcher` / `reviewer` 是**任务职责**，office 的同名座位是
 * **可视化座位**。二者当前取值相同是这张表的**决定**，不是概念合并（契约 §1.1）。
 */
const TEAM_ROLE_TO_SEAT = Object.freeze({
  researcher: 'researcher',
  reviewer: 'reviewer',
});

// Office 侧允许出现的事实种类（白名单；未知 kind 一律拒绝）。
const OFFICE_FACT_KINDS = Object.freeze([
  'run-started',
  'run-attention',
  'run-terminal',
  'artifact-available',
  'cancel-requested',
  'cancel-acknowledged',
  'job-status',
]);

// adapter 自己的稳定拒绝码（fail-closed 且可观测）。
const ADAPTER_CODES = Object.freeze([
  'TEAM_FACT_SHAPE_INVALID',
  'TEAM_FACT_UNKNOWN_TYPE',
  'TEAM_IDENTITY_REQUIRED',
  'TEAM_ROLE_UNKNOWN',
  'TEAM_SEAT_UNMAPPED',
  'TEAM_SEAT_UNKNOWN',
  'TEAM_OUTCOME_UNKNOWN',
  'TEAM_EVIDENCE_REQUIRED',
  'TEAM_ATTENTION_REASON_INVALID',
  'TEAM_ARTIFACT_KIND_UNKNOWN',
  'TEAM_JOB_STATUS_UNKNOWN',
]);

// Team fact → office 事实 kind。`null` 表示"该 Team fact 在 office 侧没有效果"
// （不是错误）：job/created 与 run/dispatched 属此类，见 §13.2。
const TEAM_FACT_TO_OFFICE_KIND = Object.freeze({
  'job/created': null,
  'run/dispatched': null,
  'run/started': 'run-started',
  'artifact/available': 'artifact-available',
  'run/attention': 'run-attention',
  'run/completed': 'run-terminal',
  'run/failed': 'run-terminal',
  'run/cancelled': 'run-terminal',
  'run/cancel-requested': 'cancel-requested',
  'run/cancel-acknowledged': 'cancel-acknowledged',
  'job/completed': 'job-status',
  'job/failed': 'job-status',
  'job/cancelled': 'job-status',
  'job/attention': 'job-status',
});

// 派生内部句柄（契约 §13.4）。raw jobId / raw runId **不离开 adapter**。
const JOB_HANDLE_PREFIX = 'team-job-sha256:';
const RUN_HANDLE_PREFIX = 'team-run-sha256:';

function jobHandleFor(rawJobId) {
  if (!isNonEmptyString(rawJobId)) return null;
  return JOB_HANDLE_PREFIX + sha256Hex(rawJobId).slice(0, 16);
}

function runHandleFor(rawRunId) {
  if (!isNonEmptyString(rawRunId)) return null;
  return RUN_HANDLE_PREFIX + sha256Hex(rawRunId).slice(0, 16);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejected(code) {
  return Object.freeze({ ok: false, code, officeFacts: Object.freeze([]) });
}

function accepted(kind, identity, fields) {
  return Object.freeze({
    ok: true,
    code: null,
    officeFacts: Object.freeze([
      Object.freeze({
        kind,
        identity,
        atMs: fields.atMs,
        seat: fields.seat === undefined ? null : fields.seat,
        role: identity.role,
        outcome: fields.outcome === undefined ? null : fields.outcome,
        evidence: fields.evidence === undefined ? null : fields.evidence,
        reason: fields.reason === undefined ? null : fields.reason,
        artifactKind: fields.artifactKind === undefined ? null : fields.artifactKind,
        jobStatus: fields.jobStatus === undefined ? null : fields.jobStatus,
      }),
    ]),
  });
}

/**
 * @param {{roleToSeat?: object, knownSeats?: string[]}} options
 *   `roleToSeat` 默认为冻结常量 `TEAM_ROLE_TO_SEAT`（测试可注入替代表以证明
 *   "表决定绑定"）。`knownSeats` 是 office 的座位白名单；给出时会在映射期校验。
 */
function createTeamOfficeAdapter(options = {}) {
  const table = isPlainObject(options.roleToSeat) ? options.roleToSeat : TEAM_ROLE_TO_SEAT;
  const knownSeats = Array.isArray(options.knownSeats) ? options.knownSeats : null;

  /** Role → Seat（显式表查询；无回退）。 */
  function seatForRole(role) {
    if (typeof role !== 'string' || role === '') return null;
    const seat = Object.prototype.hasOwnProperty.call(table, role) ? table[role] : null;
    if (typeof seat !== 'string' || seat === '') return null;
    if (knownSeats && !knownSeats.includes(seat)) return null;
    return seat;
  }

  function identityOf(teamFact, role) {
    const jobHandle = jobHandleFor(teamFact.jobId);
    // runId 用 team-schema 的同一个派生式（不复制格式，避免漂移）。
    const runHandle = runHandleFor(
      typeof role === 'string' && role !== '' ? runIdFor(teamFact.jobId, role, DEFAULT_ATTEMPT) : null
    );
    return Object.freeze({
      jobHandle,
      runHandle,
      role: typeof role === 'string' && role !== '' ? role : null,
      seq: Number.isInteger(teamFact.seq) ? teamFact.seq : null,
      factType: teamFact.type,
      statusSource: 'team-runtime',
    });
  }

  /**
   * 把一条 Team fact 映射为 0..1 条白名单 office 事实。
   * 纯函数：无内部状态，重复调用输出恒等。
   */
  function mapFact(teamFact) {
    if (!isPlainObject(teamFact)) return rejected('TEAM_FACT_SHAPE_INVALID');
    if (typeof teamFact.type !== 'string' || teamFact.type === '') return rejected('TEAM_FACT_SHAPE_INVALID');
    if (!Object.prototype.hasOwnProperty.call(TEAM_FACT_TO_OFFICE_KIND, teamFact.type)) {
      return rejected('TEAM_FACT_UNKNOWN_TYPE');
    }
    const officeKind = TEAM_FACT_TO_OFFICE_KIND[teamFact.type];
    // 该 Team fact 在 office 侧无效果：合法且确定（不是错误）。
    if (officeKind === null) {
      return Object.freeze({ ok: true, code: null, officeFacts: Object.freeze([]) });
    }
    if (!isNonEmptyString(teamFact.jobId)) return rejected('TEAM_IDENTITY_REQUIRED');
    const atMs = Number.isFinite(teamFact.atMs) ? teamFact.atMs : null;
    if (atMs === null) return rejected('TEAM_FACT_SHAPE_INVALID');

    // 座位范围的事实：必须能显式映射到座位。
    const seatScoped = officeKind === 'run-started' || officeKind === 'run-attention'
      || officeKind === 'run-terminal' || officeKind === 'cancel-requested'
      || officeKind === 'cancel-acknowledged';
    let role = null;
    let seat = null;
    if (seatScoped) {
      role = teamFact.role;
      if (typeof role !== 'string' || role === '') return rejected('TEAM_ROLE_UNKNOWN');
      if (!ROLES.includes(role)) return rejected('TEAM_ROLE_UNKNOWN');
      seat = seatForRole(role);
      // 显式表缺项 / 座位不在 office 白名单 → fail-closed（绝不回退成 role 名）。
      if (seat === null) {
        return rejected(knownSeats && !Object.prototype.hasOwnProperty.call(table, role)
          ? 'TEAM_SEAT_UNMAPPED'
          : (Object.prototype.hasOwnProperty.call(table, role) ? 'TEAM_SEAT_UNKNOWN' : 'TEAM_SEAT_UNMAPPED'));
      }
    } else {
      role = typeof teamFact.role === 'string' && teamFact.role !== '' ? teamFact.role : null;
    }
    const identity = identityOf(teamFact, role);

    switch (officeKind) {
      case 'run-started':
      case 'cancel-requested':
      case 'cancel-acknowledged':
        return accepted(officeKind, identity, { atMs, seat });

      case 'run-attention': {
        const reason = teamFact.reason;
        if (!isNonEmptyString(reason) || !ATTENTION_REASON_RE.test(reason)) {
          return rejected('TEAM_ATTENTION_REASON_INVALID');
        }
        return accepted(officeKind, identity, { atMs, seat, reason });
      }

      case 'run-terminal': {
        const outcome = teamFact.outcome;
        if (!TERMINAL_OUTCOMES.includes(outcome)) return rejected('TEAM_OUTCOME_UNKNOWN');
        const evidence = teamFact.evidence;
        if (!isNonEmptyString(evidence) || evidence.length > EVIDENCE_MAX_CHARS || !EVIDENCE_RE.test(evidence)) {
          return rejected('TEAM_EVIDENCE_REQUIRED');
        }
        return accepted(officeKind, identity, { atMs, seat, outcome, evidence });
      }

      case 'artifact-available': {
        const artifactKind = teamFact.kind;
        if (!ARTIFACT_KINDS.includes(artifactKind)) return rejected('TEAM_ARTIFACT_KIND_UNKNOWN');
        // 只传白名单 kind 作粗粒度阶段提示；id/digest/内容/路径一律不透传。
        return accepted(officeKind, identity, { atMs, artifactKind });
      }

      case 'job-status': {
        const jobStatus = teamFact.type.slice('job/'.length);
        if (!JOB_STATUSES.includes(jobStatus)) return rejected('TEAM_JOB_STATUS_UNKNOWN');
        return accepted(officeKind, identity, { atMs, jobStatus });
      }

      default:
        return rejected('TEAM_FACT_UNKNOWN_TYPE');
    }
  }

  function describe() {
    return Object.freeze({
      adapter: 'team-office-adapter-1',
      roleToSeat: Object.freeze({ ...table }),
      knownSeats: knownSeats ? Object.freeze([...knownSeats]) : null,
      officeFactKinds: OFFICE_FACT_KINDS,
      adapterCodes: ADAPTER_CODES,
    });
  }

  return Object.freeze({
    mapFact,
    seatForRole,
    describe,
    TEAM_ROLE_TO_SEAT: table,
  });
}

module.exports = {
  createTeamOfficeAdapter,
  TEAM_ROLE_TO_SEAT,
  OFFICE_FACT_KINDS,
  ADAPTER_CODES,
  TEAM_FACT_TO_OFFICE_KIND,
  jobHandleFor,
  runHandleFor,
};
