'use strict';

// src/team-shell-transport.js — 壳侧 Team 执行 transport（Harness v0.4，阶段1 真实 dsh 最小接入）。
//
// 位置说明：这个模块**故意不在** src/team/runtime/** 里 —— 那个目录是纯内核
//（门禁禁止 node:fs）；而 transport 是**壳侧**基础设施（设计 B 方案 A：Electron Shell
// 持有 sessionFor）。它放在 src/ 顶层，与 harness-rpc.js / runtime-mux.js 同级。
//
// 职责（SESSION-OWNERSHIP-DESIGN-2026-10.md 方案 A 的落地）：
//   1. **会话所有权**：resolveSession = 建会话 + 发任务文本（raw sessionId 只在本模块内）。
//   2. **任务文本来源（用户拍板 U3，2026-10-25）**：文本 = **固定模板 + 用户输入的研究主题**。
//      模板是本模块的冻结常量；主题来自用户（env/设置/UI），**执行层与后端都不生成 prompt**。
//   3. **受信 Artifact 来源（用户拍板，本地 materializer）**：artifactFor 把该会话的
//      最终产出物化为本地文件，digest = 文件字节的 sha256；**只**把
//      {kind, digest, locationRef} 交给后端 —— 内容与路径绝不进入 ExecutionEvent。
//   4. **内容捕获**：follow() 对 journal 流做 tee（壳本来就转发这些帧），
//      只记"最后一条 assistant 正文"，不做通用 journal 解析。
//
// 边界（契约 §9 / 任务书红线）：
//   - 本模块**不**映射事件（那是 dsh-execution-backend 的职责）；
//   - **不**从日志文本猜 artifact（只有"会话结束 + 有产出"才物化）；
//   - **不**让 raw sessionId 离开本模块（返回给后端的只有它自己给的 sessionId 参数）；
//   - 所有 IO 经注入（rpc / openFollow / fs），因此**可离线单测**。
//
// 隐私：prompt 正文（含内联的研究笔记）只存在于壳→dsh 的调用参数里；
// ExecutionEvent / Team fact / Office 快照里没有 prompt、没有正文、没有路径。

const crypto = require('node:crypto');

const SHELL_TRANSPORT_VERSION = 'shell-team-transport-1';

// ---- 固定任务模板（冻结；主题是唯一的用户输入） -------------------------------

const RESEARCHER_PROMPT_TEMPLATE = Object.freeze([
  '请研究下面的主题，并输出一份结构化的研究笔记（Markdown）。',
  '',
  '主题：{{topic}}',
  '',
  '要求：',
  '1. 先列出 3-6 个关键子问题；',
  '2. 逐项给出你的发现与依据；',
  '3. 最后一节给出「结论与风险」。',
  '',
  '这是团队任务的第一步：你的研究笔记会交给评审员复核，请确保结论可追溯。',
].join('\n'));

const REVIEWER_PROMPT_TEMPLATE = Object.freeze([
  '请评审下面的研究笔记（团队任务的第二步）。',
  '',
  '主题：{{topic}}',
  '',
  '研究笔记内容：',
  '---',
  '{{notes}}',
  '---',
  '',
  '要求：检查遗漏、事实错误与风险，输出评审结论：明确「通过」或「需补充」，并给出理由。',
].join('\n'));

// 内联进 reviewer prompt 的笔记上限（防止 prompt 无界膨胀；截断只影响评审输入，不影响物化文件）。
const INLINE_NOTES_MAX_CHARS = 8000;
// 物化文件名：artifactDir/<jobId>/<kind>.md（jobId 由 controller 给出、是 opaque 句柄）。
const ARTIFACT_FILE_SUFFIX = '.md';

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 从 assistant/message 的 data 里提取正文文本（只取 text 片段，不解析其它字段）。 */
function assistantTextOf(data) {
  if (!isPlainObject(data)) return null;
  const content = data.content;
  if (typeof content === 'string' && content.trim() !== '') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((part) => isPlainObject(part) && typeof part.text === 'string' && part.text !== '')
      .map((part) => part.text);
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

/**
 * @param {object} options
 * @param {object} options.rpc            { createSession(), prompt(sessionId,text,mode), cancel(sessionId) }
 * @param {Function} options.openFollow   (sessionId) => AsyncIterable<journalEvent>（壳已有的 follow 流）
 * @param {string}  options.artifactDir   物化文件的根目录（调用方负责创建）
 * @param {object}  [options.fs]          注入 fs（默认 node:fs；测试可换）
 * @param {string}  options.topic         用户输入的研究主题（U3：唯一用户输入）
 * @param {Function} [options.log]
 */
function createShellTeamTransport(options = {}) {
  const rpc = options.rpc;
  if (!rpc || typeof rpc.createSession !== 'function' || typeof rpc.prompt !== 'function'
      || typeof rpc.cancel !== 'function') {
    throw new Error('createShellTeamTransport requires rpc {createSession,prompt,cancel}');
  }
  const openFollow = options.openFollow;
  if (typeof openFollow !== 'function') {
    throw new Error('createShellTeamTransport requires openFollow(sessionId)');
  }
  if (typeof options.artifactDir !== 'string' || options.artifactDir === '') {
    throw new Error('createShellTeamTransport requires an artifactDir');
  }
  if (typeof options.topic !== 'string' || options.topic.trim() === '') {
    // 没有主题就没有任务文本 —— 诚实失败，而不是编一个空任务。
    throw new Error('createShellTeamTransport requires a non-empty user topic (U3: text comes from the user)');
  }
  const fs = options.fs || require('node:fs');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const topic = options.topic.trim();
  const artifactDir = options.artifactDir;

  // raw sessionId -> 会话记录（raw 只在本模块与 rpc 调用线上）。
  const sessions = new Map();
  const stats = { sessionsCreated: 0, promptsSent: 0, artifactsMaterialized: 0, cancels: 0 };

  function buildPrompt(role, inputNotes) {
    if (role === 'researcher') {
      return RESEARCHER_PROMPT_TEMPLATE.replace('{{topic}}', topic);
    }
    if (role === 'reviewer') {
      const notes = typeof inputNotes === 'string' && inputNotes !== ''
        ? inputNotes.slice(0, INLINE_NOTES_MAX_CHARS)
        : '（上游研究笔记不可用）';
      return REVIEWER_PROMPT_TEMPLATE.replace('{{topic}}', topic).replace('{{notes}}', notes);
    }
    return null; // 未知角色：不生成 prompt（fail-closed，防止悄悄扩角色）
  }

  /**
   * resolveSession（v1 transport 契约）：为一次 run 建会话并**发送任务文本**。
   * 文本 = 冻结模板 + 用户主题；reviewer 的模板内联上游研究笔记（壳侧持有内容）。
   * 返回 raw sessionId（只回给后端的 transport 调用线；后端存进自己的闭包）。
   */
  async function resolveSession({ jobId, role, inputArtifacts, consumes } = {}) {
    if (typeof jobId !== 'string' || jobId === '') return null;
    // 下游的输入 = 上游 materialized 笔记。定位方式是 **plan 声明的 consumes**
    //（controller 经 backend 透传；provider 中立）—— 不做 artifactId 反查
    //（Team 的 artifactId 派生式不属于壳），也不从角色名以外的任何文本猜。
    let inputNotes = null;
    const wantedKinds = Array.isArray(consumes) ? consumes : [];
    if (wantedKinds.length > 0) {
      const candidates = [...sessions.values()]
        .filter((s) => s.materialized && wantedKinds.includes(s.materialized.kind) && s.role !== role)
        .sort((a, b) => (a.materialized.atSeq || 0) - (b.materialized.atSeq || 0));
      if (candidates.length > 0) inputNotes = candidates.at(-1).outputText;
    }
    void inputArtifacts; // 保留在契约里（未来按 artifactId 精确绑定时用）；v0 用 consumes 定位
    const prompt = buildPrompt(role, inputNotes);
    if (prompt === null) {
      log(`[team-transport] refuse unknown role "${role}" (no prompt generated)`);
      return null;
    }
    let sessionId;
    try {
      sessionId = await rpc.createSession();
    } catch (error) {
      log(`[team-transport] createSession failed: ${error && error.message}`);
      return null; // → 后端 EXEC_TRANSPORT_UNAVAILABLE → Team attention（设计 B §4.9）
    }
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    try {
      await rpc.prompt(sessionId, prompt, 'steer');
      stats.promptsSent += 1;
    } catch (error) {
      log(`[team-transport] prompt failed: ${error && error.message}`);
      return null;
    }
    stats.sessionsCreated += 1;
    sessions.set(sessionId, {
      sessionId, jobId, role, outputText: null, materialized: null,
    });
    log(`[team-transport] session for ${role} ready (raw id stays in-process)`);
    return sessionId;
  }

  /**
   * follow（v1 transport 契约）：返回 tee 过的 journal 流 —— 壳本来就转发这些帧，
   * tee 只是顺便记录"最后一条 assistant 正文"（materializer 的唯一内容来源）。
   */
  function follow({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw Object.assign(new Error('EXEC_TRANSPORT_UNAVAILABLE: follow requires a session handle'), {
        code: 'EXEC_TRANSPORT_UNAVAILABLE',
      });
    }
    const record = sessions.get(sessionId);
    const upstream = openFollow(sessionId);
    const iterator = upstream[Symbol.asyncIterator]();
    return Object.freeze({
      [Symbol.asyncIterator]: () => ({
        async next() {
          const result = await iterator.next();
          if (!result.done && record) {
            const event = result.value;
            if (event && event.type === 'assistant/message') {
              const text = assistantTextOf(event.data);
              if (text !== null) record.outputText = text; // 只留最后一条正文
            }
          }
          return result;
        },
        return(value) {
          return typeof iterator.return === 'function'
            ? iterator.return(value)
            : Promise.resolve({ value: undefined, done: true });
        },
      }),
    });
  }

  /** cancel（v1 transport 契约）：直接走壳的取消 RPC；ack 语义由后端处理。 */
  async function cancel({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return Object.freeze({ ok: false, code: 'EXEC_TRANSPORT_UNAVAILABLE' });
    }
    stats.cancels += 1;
    try {
      const result = await rpc.cancel(sessionId);
      return Object.freeze({ ok: !!(result && result.ok !== false) });
    } catch (error) {
      return Object.freeze({ ok: false, code: error && error.code ? error.code : 'EXEC_EXECUTOR_ERROR' });
    }
  }

  /**
   * artifactFor（v1 transport 契约，受信 artifact 来源 = 本地 materializer）：
   * 把该会话的最终产出物化为 artifactDir/<jobId>/<kind>.md，
   * digest = 'exec-sha256:' + sha256(文件字节).slice(0,16)，
   * locationRef = 受限 token（**不含路径**；路径只在本模块内部）。
   *
   * fail-closed：没有捕获到正文 → 返回 null（后端不产 artifact 事件，
   * Team 的 HANDOFF_INCOMPLETE 会让下游挂起 —— 宁可挂，不伪造交接）。
   */
  async function artifactFor({ sessionId, kind } = {}) {
    const record = sessions.get(sessionId);
    if (!record) return null;
    if (typeof kind !== 'string' || kind === '') return null;
    if (record.materialized) return record.materialized; // 幂等
    if (record.outputText === null || record.outputText.trim() === '') {
      log(`[team-transport] no captured output for ${record.role}; refusing to fabricate an artifact`);
      return null;
    }
    const dir = `${artifactDir.replace(/\/+$/, '')}/${record.jobId}`;
    const path = `${dir}/${kind}${ARTIFACT_FILE_SUFFIX}`;
    const bytes = Buffer.from(record.outputText, 'utf8');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path, bytes);
    } catch (error) {
      log(`[team-transport] materialize failed: ${error && error.message}`);
      return null;
    }
    stats.artifactsMaterialized += 1;
    record.materialized = Object.freeze({
      kind,
      atSeq: sessions.size,
      digest: `exec-sha256:${sha256Hex(bytes).slice(0, 16)}`,
      locationRef: `ref:${record.role}-${kind}`,
      artifactPath: path, // 只在壳内部（reviewer prompt 与诊断用），绝不进入 ExecutionEvent
      bytes: bytes.length,
    });
    log(`[team-transport] materialized ${kind} (${bytes.length} bytes) for ${record.role}`);
    return record.materialized;
  }

  function describe() {
    return Object.freeze({
      transport: SHELL_TRANSPORT_VERSION,
      network: 'via injected rpc (real dsh when wired in main.js; offline in tests)',
      artifactSource: 'local-materializer',
      topicProvided: true,
      promptSource: 'fixed-template + user topic (never generated by the execution layer)',
      sessions: sessions.size,
      stats: Object.freeze({ ...stats }),
    });
  }

  /** 只读诊断（不含 raw sessionId、不含正文、不含路径）。 */
  function summary() {
    return Object.freeze({
      transport: SHELL_TRANSPORT_VERSION,
      stats: Object.freeze({ ...stats }),
      sessions: [...sessions.values()].map((s) => Object.freeze({
        role: s.role,
        hasOutput: s.outputText !== null,
        materialized: s.materialized !== null,
        kind: s.materialized ? s.materialized.kind : null,
        bytes: s.materialized ? s.materialized.bytes : null,
      })),
    });
  }

  return Object.freeze({
    resolveSession,
    follow,
    cancel,
    artifactFor,
    describe,
    summary,
    // 仅供测试/诊断：主题与模板是公开常量（不含用户隐私）。
    topic,
    RESEARCHER_PROMPT_TEMPLATE,
    REVIEWER_PROMPT_TEMPLATE,
  });
}

module.exports = {
  createShellTeamTransport,
  SHELL_TRANSPORT_VERSION,
  RESEARCHER_PROMPT_TEMPLATE,
  REVIEWER_PROMPT_TEMPLATE,
  INLINE_NOTES_MAX_CHARS,
  assistantTextOf,
};