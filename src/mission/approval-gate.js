// src/mission/approval-gate.js — 提案-批准闸门（S5）。
// 纯函数 + 内存状态机，零 IO，可离线测试。
//
// 第一性原理：为什么"批准"必须绑定内容 hash
//
//   危险动作的正确流程是两步：模型**提议** → 人**批准** → 执行。
//   这个流程有一个很容易被忽略的漏洞：
//
//     模型提议了 A（"运行 npm test"），人正在读；
//     模型又提取议了 B（"删除整个仓库"）；
//     人点下"批准"——
//     批准的是哪个？
//
//   如果批准只是一个布尔量（approved: true），答案是"不知道"。
//   这就是为什么批准必须携带**提案内容的 hash**：
//   人批准的是他**看见的那一份**，内容一改，旧的批准立即失效。
//
//   第二个漏洞是过期：一份"等待批准"的提案如果永远有效，
//   三天后有人翻到它点一下，会执行一个已经没人记得的上下文里的动作。
//   所以提案必须有 TTL。
//
//   第三个漏洞是幂等：模型重试同一次提议，不应该生成两份待批准事项，
//   否则用户会看到一堆重复卡片，而它们其实是同一件事。
//
//   本模块实现的正是这三点。它**不执行**任何动作 —— 执行是 Harness 的事。
'use strict';

const crypto = require('node:crypto');

/** 提案状态。`expired` 是显式状态，不靠时间推算。 */
const PROPOSAL_STATES = Object.freeze(['awaiting_review', 'approved', 'denied', 'expired']);

/** 默认有效期：30 分钟（与 OpenMuse 一致）。 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** 提案动作的种类。闭集 —— 新增一种要同时想清楚"风险在哪、怎么审"。 */
const PROPOSAL_KINDS = Object.freeze([
  'command.run',    // 执行命令
  'file.write',     // 写文件
  'file.delete',    // 删文件
  'message.send',   // 对外发消息
  'task.create',    // 创建团队任务
  'member.spawn',   // 派生成员
]);

/**
 * 计算提案的内容 hash。
 *
 * 只纳入**会改变动作含义**的字段：kind + 规范化后的 payload。
 * 刻意不纳入时间/随机 id —— 那会让"同一份内容"算不出同一个 hash。
 *
 * @param {object} input { kind, payload }
 * @returns {string} hex sha256
 */
function proposalHash({ kind, payload } = {}) {
  const canonical = stableStringify({ kind: kind || null, payload: payload === undefined ? null : payload });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** 键序稳定的 JSON 序列化（保证相同内容 → 相同 hash）。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 创建提案闸门。
 *
 * @param {object} [options]
 * @param {number} [options.now]      () => ms（可注入，便于测试）
 * @param {number} [options.ttlMs]
 */
function createApprovalGate({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  /** id -> proposal */
  const proposals = new Map();
  /** 幂等键 -> id */
  const idempotency = new Map();

  /**
   * 提议一个动作。**不执行**，只登记。
   *
   * @param {object} input
   * @param {string} input.kind
   * @param {object} [input.payload]
   * @param {string} [input.taskId]
   * @param {string} [input.title]    给人看的一句话（**不含 payload 正文**）
   * @param {string} [input.idempotencyKey]
   * @returns {{ok:boolean, proposal?:object, code?:string}}
   */
  function propose(input = {}) {
    const kind = input.kind;
    if (!PROPOSAL_KINDS.includes(kind)) {
      return { ok: false, code: 'UNKNOWN_PROPOSAL_KIND' };
    }
    // 幂等：同一次提议重试不产生第二张卡片
    const idem = typeof input.idempotencyKey === 'string' && input.idempotencyKey
      ? input.idempotencyKey : null;
    if (idem && idempotency.has(idem)) {
      const existing = proposals.get(idempotency.get(idem));
      if (existing) return { ok: true, proposal: existing, duplicate: true };
    }

    const at = now();
    const hash = proposalHash({ kind, payload: input.payload });
    const proposal = {
      id: `ap-${crypto.randomBytes(6).toString('hex')}`,
      kind,
      hash,
      status: 'awaiting_review',
      title: typeof input.title === 'string' ? input.title.slice(0, 200) : kind,
      ...(typeof input.taskId === 'string' && input.taskId ? { taskId: input.taskId } : {}),
      createdAtMs: at,
      expiresAtMs: at + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS),
    };
    proposals.set(proposal.id, proposal);
    if (idem) idempotency.set(idem, proposal.id);
    return { ok: true, proposal };
  }

  /**
   * 人做决定。**必须提交 hash** —— 这是本模块存在的核心理由。
   *
   * @param {object} input
   * @param {string} input.id
   * @param {string} input.hash      人看见的那份内容的 hash
   * @param {'approve'|'deny'} input.decision
   * @returns {{ok:boolean, proposal?:object, code?:string}}
   */
  function decide(input = {}) {
    const proposal = proposals.get(input.id);
    if (!proposal) return { ok: false, code: 'PROPOSAL_NOT_FOUND' };
    // hash 不匹配 = 批准的不是当前这份内容 → 拒绝，并要求重新查看
    if (typeof input.hash !== 'string' || input.hash !== proposal.hash) {
      return { ok: false, code: 'PROPOSAL_CHANGED' };
    }
    if (proposal.status !== 'awaiting_review') {
      // 已决/已过期：幂等返回当前状态，但绝不改变它
      return { ok: true, proposal, alreadyDecided: true };
    }
    if (now() > proposal.expiresAtMs) {
      proposal.status = 'expired';
      return { ok: false, code: 'PROPOSAL_EXPIRED', proposal };
    }
    if (input.decision !== 'approve' && input.decision !== 'deny') {
      return { ok: false, code: 'INVALID_DECISION' };
    }
    proposal.status = input.decision === 'approve' ? 'approved' : 'denied';
    proposal.decidedAtMs = now();
    return { ok: true, proposal };
  }

  /** 读取当前提案（会顺带把过期的标为 expired —— 状态不靠推算）。 */
  function get(id) {
    const p = proposals.get(id);
    if (!p) return null;
    if (p.status === 'awaiting_review' && now() > p.expiresAtMs) p.status = 'expired';
    return { ...p };
  }

  /** 所有待审提案（UI 的"需要你批准"列表）。 */
  function pending() {
    const at = now();
    const out = [];
    for (const p of proposals.values()) {
      if (p.status === 'awaiting_review' && at > p.expiresAtMs) p.status = 'expired';
      if (p.status === 'awaiting_review') out.push({ ...p });
    }
    return out;
  }

  return { propose, decide, get, pending, size: () => proposals.size };
}

module.exports = {
  PROPOSAL_STATES,
  PROPOSAL_KINDS,
  DEFAULT_TTL_MS,
  proposalHash,
  stableStringify,
  createApprovalGate,
};
