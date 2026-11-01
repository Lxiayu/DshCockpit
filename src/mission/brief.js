// src/mission/brief.js — Mission Brief 生成（P1）：面向 Agent 的跨 Session 上下文。
//
// 第一性原理：Brief 是 Mission Core 的**实际交付物**
//
//   整个 Mission Core 的存在理由是：用户下次开会话时，Agent 能知道
//   "这个项目之前发生了什么、为什么这么决定、还有什么没定"。
//   那个"知道"发生在什么地方？——**就是 Brief**。
//
//   所以 Brief 的设计约束是硬性的：
//
//   1. **有大小预算（默认 8KB）**。它不是文档，是要注入模型上下文的。
//      超过预算的 Brief 会挤掉真正的工作内容，反而降低产出质量。
//      所以 generator 必须先"按重要性排序"再截断，而不是全量拼接。
//
//   2. **只包含派生事实，不含原文**。隐私边界：不出现 prompt 正文、
//      工具参数、绝对路径、raw sessionId。Brief 里可以有 digest 和相对路径。
//
//   3. **必须标注"观察到"的时间**。Mission Core 不拥有 Harness 的实时状态
//      （running / awaitingUser），只能读快照并标注 observedAtMs。
//      否则重启后 Brief 会把陈旧状态当成当前状态——那就是撒谎。
//
//   4. **确定性**。同样的投影永远生成同样的 Brief（不依赖当前时间，
//      除非显式传入 now）。否则无法测试、无法 diff、无法缓存。
//
// 重要性排序（这是 Brief 的核心算法）：
//   P0 必含：title / intent / status / constraints
//   P1 高：最近的 decisions（含 rationale）+ open questions
//   P2 中：active workstreams
//   P3 低：deliverables 列表（只列 label + digest 前缀）
//   超预算时**从 P3 开始丢弃**，并在末尾明确标注 "truncated"。
//   宁可告诉 Agent "还有 5 条决策未显示"，也不要静默丢一半。
'use strict';

const SCHEMA_VERSION = 1;

/** 默认预算：8KB。不是"文档长度"，是**注入模型上下文**的预算。 */
const DEFAULT_MAX_BYTES = 8 * 1024;

/** 各段落在超预算时的丢弃顺序（数值越大越先丢）。 */
const PRIORITY = Object.freeze({
  header: 0,
  intent: 0,
  constraints: 0,
  decisions: 1,
  questions: 1,
  workstreams: 2,
  deliverables: 3,
});

function byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

/** 截断到指定字节数（按 UTF-8 边界安全截断，不切坏多字节字符）。 */
function truncateBytes(text, maxBytes) {
  const s = String(text);
  if (byteLen(s) <= maxBytes) return s;
  // 逐字符累加，确保不切断多字节序列
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = byteLen(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/** 单行化：Brief 是给模型读的，多行会浪费 token 且难对齐。 */
function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * 生成 Mission Brief。
 *
 * @param {object} view  projection.missionView() 的结果
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {object} [opts.observed]   Harness 快照（只读）：{ hasRunningAgent, pendingApprovals, ... }
 * @param {number} [opts.observedAtMs]  该快照的时间戳（必须传，否则不标注）
 * @param {boolean} [opts.includeDeliverables]
 * @returns {{text:string, bytes:number, truncated:boolean, dropped:object, sections:string[]}}
 */
function buildBrief(view, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const includeDeliverables = opts.includeDeliverables !== false;

  if (!view || !view.mission) {
    return { text: '', bytes: 0, truncated: false, dropped: {}, sections: [], empty: true };
  }
  const m = view.mission;

  // --- 段落构建（每段独立，便于按优先级丢弃）---
  const sections = [];

  const headerLines = [
    `# Mission: ${oneLine(m.title)}`,
    `- status: ${m.status}`,
    `- missionId: ${m.missionId}`,
    `- workspaceId: ${m.workspaceId}`,
    `- updatedAtMs: ${m.updatedAtMs}`,
  ];

  // Harness 快照：**必须标注 observedAtMs**，否则会被误读为当前状态
  if (opts.observed && Number.isFinite(opts.observedAtMs)) {
    const running = opts.observed.hasRunningAgent === true;
    const pending = Number(opts.observed.pendingApprovals) || 0;
    const waiting = Number(opts.observed.pendingQuestions) || 0;
    headerLines.push(
      `- live (observed at ${new Date(opts.observedAtMs).toISOString()}): `
      + `running=${running ? 'yes' : 'no'}, `
      + `pendingApprovals=${pending}, pendingQuestions=${waiting}`,
    );
  }
  sections.push({ key: 'header', text: headerLines.join('\n') });

  // intent 是用户原话，必须完整保留（不截断到不可读）
  sections.push({ key: 'intent', text: `\n## Intent (user's own words)\n${oneLine(m.intent)}` });

  // constraints：用户确认过的边界。这是**最不能丢**的东西。
  const constraints = Array.isArray(m.constraints) ? m.constraints : [];
  if (constraints.length) {
    const lines = constraints.map((c) => `- ${oneLine(c.text)}${c.source === 'model' ? ' (proposed by model)' : ''}`);
    sections.push({ key: 'constraints', text: `\n## Constraints (must not be violated)\n${lines.join('\n')}` });
  }

  // decisions：**带 rationale**。这正是 compaction 会丢掉的东西。
  const decisions = (view.decisions || []).slice().sort((a, b) => (b.decidedAtMs || 0) - (a.decidedAtMs || 0));
  if (decisions.length) {
    const lines = decisions.map((d) => {
      const sup = d.status === 'superseded' ? ` [superseded by ${d.supersededBy || '?'}]` : '';
      return `- (${d.status}) ${oneLine(d.text)}${sup}\n  why: ${oneLine(d.rationale)}`;
    });
    sections.push({ key: 'decisions', text: `\n## Decisions (most recent first)\n${lines.join('\n')}` });
  }

  const questions = (view.questions || []).filter((q) => q.status === 'open');
  if (questions.length) {
    const lines = questions.map((q) => `- ${oneLine(q.text)}`);
    sections.push({ key: 'questions', text: `\n## Open questions (unresolved)\n${lines.join('\n')}` });
  }

  const workstreams = (view.workstreams || []).filter((w) => w.status !== 'dropped');
  if (workstreams.length) {
    const lines = workstreams.map((w) => `- [${w.status}] ${oneLine(w.title)} (${w.workstreamId})`);
    sections.push({ key: 'workstreams', text: `\n## Workstreams\n${lines.join('\n')}` });
  }

  if (includeDeliverables) {
    const dels = (view.deliverables || []);
    if (dels.length) {
      // 只列 label + 相对路径 + digest 前缀。**绝不**内联内容。
      const lines = dels.map((d) => `- ${oneLine(d.label)}: ${d.relPath} (sha256:${String(d.digest).slice(0, 12)}…)`);
      sections.push({ key: 'deliverables', text: `\n## Deliverables (registered)\n${lines.join('\n')}` });
    }
  }

  // --- 按预算装配：超预算时从最低优先级段开始丢弃 ---
  const dropped = {};
  let kept = sections;
  let truncated = false;

  const total = () => byteLen(kept.map((s) => s.text).join('\n'));

  if (total() > maxBytes) {
    truncated = true;
    // 按优先级从高到低尝试保留
    const order = [...kept].sort((a, b) => (PRIORITY[a.key] || 0) - (PRIORITY[b.key] || 0));
    kept = [];
    for (const sec of order) {
      const trial = [...kept, sec];
      if (byteLen(trial.map((s) => s.text).join('\n')) <= maxBytes) {
        kept.push(sec);
      } else {
        dropped[sec.key] = (dropped[sec.key] || 0) + 1;
      }
    }
    // 恢复原始顺序（按 key 在 sections 里的位置）
    const orderIndex = new Map(sections.map((s, i) => [s.key, i]));
    kept.sort((a, b) => orderIndex.get(a.key) - orderIndex.get(b.key));
  }

  let text = kept.map((s) => s.text).join('\n');

  // 截断必须**明说**：静默丢弃会让 Agent 以为自己看到了全貌
  if (truncated) {
    const note = `\n\n> [Brief truncated to ${maxBytes} bytes. Omitted: `
      + `${Object.entries(dropped).map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}`
      + '. Ask the user for specifics rather than assuming.]';
    text += note;
  }

  // 极端情况：连 note 都超预算 —— 硬截断（但这不该发生，说明 maxBytes 太小）
  if (byteLen(text) > maxBytes) {
    text = truncateBytes(text, maxBytes);
    truncated = true;
  }

  return {
    text,
    bytes: byteLen(text),
    truncated,
    dropped,
    sections: kept.map((s) => s.key),
    empty: false,
  };
}

/**
 * Brief 的指纹（用于事件日志的 `brief/rendered` 追溯，以及缓存失效判断）。
 * 同样的内容 → 同样的指纹。
 */
function briefFingerprint(brief) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(String(brief.text || ''), 'utf8').digest('hex').slice(0, 16);
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_MAX_BYTES,
  PRIORITY,
  buildBrief,
  briefFingerprint,
  truncateBytes,
  byteLen,
};
