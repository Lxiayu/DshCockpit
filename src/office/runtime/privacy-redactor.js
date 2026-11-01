'use strict';

// src/office/runtime/privacy-redactor.js — Task 1 / SPEC-01 shared privacy
// redactor. Pure deterministic CommonJS; no Electron, Pixi, DOM, filesystem or
// network access. Reusable by SPEC-05 (adapter fingerprint hashing) and
// SPEC-08 (diagnostics, persistence and settings). Callers must redact BEFORE
// hashing or emitting any event data: only coarse event/status fields and
// approved enum values survive in "redacted" mode.

const REDACTED = Object.freeze({
  TEXT: '[REDACTED:text]',
  SESSION: '[REDACTED:session-id]',
  PATH: '[REDACTED:path]',
  SECRET: '[REDACTED:secret]',
  TOKENS: '[REDACTED:token-count]',
});

// Coarse vocabulary approved by SPEC-00 / OFFICE-DESIGN-DISCUSSION that may
// appear in redacted diagnostics. Everything else textual is redacted.
// The P1 right-panel pipeline (spec §4/§5) adds its controlled enum values:
// the usage block's currency/pricing/budget/savings-basis markers, the pending
// risk levels and the pending kinds. All are fixed app vocabulary (never
// runtime payload, identifiers or paths).
const COARSE_ENUMS = new Set([
  // agent lifecycle
  'idle', 'running',
  // turn/end reasons
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted',
  // presence / sync / runtime
  'present', 'healthy', 'stale', 'resyncing',
  'unbound', 'pending', 'bound', 'releasing',
  // activity
  'roaming', 'chatting', 'resting', 'sleeping', 'working', 'thinking', 'waiting', 'celebrating',
  // movement
  'stationary', 'moving', 'arriving', 'leaving',
  // control / queue / binding source
  'none', 'dispatchPending', 'cancellationPending', 'preemptPending', 'empty', 'queued',
  'root', 'manual', 'heuristic', 'one-shot', 'continuable',
  // P1 usage block (spec §4): currency + pricing-basis + budget kinds +
  // savings basis + pending risk levels + pending kinds
  'CNY', 'USD',
  'api-key', 'subscription',
  'monthly', 'daily', 'none',
  'cloud-equivalent',
  'low', 'medium', 'high',
  'approval', 'question',
]);

const SECRET_KEY_RE = /(secret|passwd|password|credential|apikey|api_key|authorization|auth|bearer|cookie|privatekey|private_key)/i;
const SESSION_KEY_RE = /(session|runid|run_id|agentid|agent_id|conversation)/i;
const PATH_KEY_RE = /(path|cwd|directory|folder|filepath|filename)/i;
const TEXT_KEY_RE = /(prompt|message|text|content|title|summary|description|output|result|args|argument|input|query|question|answer|note|command|body)/i;
const TOKEN_COUNT_KEY_RE = /token/i;

const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+|-----BEGIN\s|\bxox[baprs]-[A-Za-z0-9-]{6,}|gh[pousr]_[A-Za-z0-9]{20,})/;
const SESSION_VALUE_RE = /(^|[-_])(sess|session|run|agent|rpc)[-_:][A-Za-z0-9][A-Za-z0-9_-]{4,}/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const PATH_VALUE_RE = /(^|[^\w])\/(Users|home|private|tmp|var|Volumes)\//;
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;
const HOME_TILDE_RE = /^~\//;
// Calendar-day keys ('YYYY-MM-DD') are coarse billing buckets (the P1 usage
// block's dayKey, token-stats' per-day rollups), never identifiers — they
// carry no identity and survive like the coarse enums below.
const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Short enum-ish labels are treated as coarse and kept; prose never matches
// this shape.
//
// Issue #18 (2026-11-01)：这里原先只接受**小写**开头（`^[a-z]`），于是
// 本仓库 184 个 SCREAMING_SNAKE 诊断码（PACK_MISSING / AGENT_STATUS_UNKNOWN /
// ANIMATION_NOT_FOUND …）全部被当成正文脱敏成 "[REDACTED:text]"。
// 后果是诊断信息在最有用的地方消失：出问题时用户和管理员只看到一段红字，
// 无法据此定位。而小写的同义标签却能通过——同一类数据出现两种命运，
// 说明规则本身没有抓住"什么是枚举"。
//
// 正确的判别不是大小写，而是**形状**：
//   · 单个 token（无空格、无标点、无路径分隔）
//   · 只由字母/数字/下划线/斜杠/连字符组成
//   · 长度受限
// SCREAMING_SNAKE 与 kebab-case、camelCase、snake_case 都是枚举的合法形态。
// 真正的正文（prompt、消息、产物内容）含空格或标点，不会匹配。
//
// 注意顺序：classifyByShape() 先跑，所以看起来像路径/会话 id/密钥的字符串
// 仍会被脱敏——这里放宽的只是"短 token 视为枚举"，不是放弃形状防护。
const SHORT_ENUM_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_/-]{0,31}$/;

// SCREAMING_SNAKE 诊断码（PACK_MISSING / AGENT_STATUS_UNKNOWN / ANIMATION_NOT_FOUND）。
//
// Issue #18：这类 token 与真实的 session/agent 句柄在**字符集**上重叠，
// SESSION_VALUE_RE 的启发式会把 `AGENT_STATUS_UNKNOWN` 当成 `agent-xxxxx` 句柄。
// 但两者形状有一个决定性差异：
//   · 诊断码：全大写 + 下划线分隔（每个词都是大写字母开头的语义词）
//   · 真实句柄：含小写/数字混合、常带随机编码段
// 所以把"全大写 + 下划线"作为**更强的**信号，先于 session 形状判定。
// 这不会削弱防护：真实的 session/agent 句柄几乎不会是纯 SCREAMING_SNAKE，
// 且下方仍有 SECRET/UUID/LONG_HEX/PATH 等形状检查。
const DIAGNOSTIC_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

// Strong value-shape signals win over key-name buckets: a path or session id
// is redacted even when the surrounding key name looks innocent.
function classifyByShape(value) {
  if (SECRET_VALUE_RE.test(value)) return REDACTED.SECRET;
  // 诊断码优先于 session 启发式（见 DIAGNOSTIC_CODE_RE 的说明）
  if (DIAGNOSTIC_CODE_RE.test(value)) return null; // null = 不按形状脱敏，交给枚举判定
  if (UUID_RE.test(value) || LONG_HEX_RE.test(value) || SESSION_VALUE_RE.test(value)) {
    return REDACTED.SESSION;
  }
  if (PATH_VALUE_RE.test(value) || WINDOWS_PATH_RE.test(value) || HOME_TILDE_RE.test(value)) {
    return REDACTED.PATH;
  }
  return null;
}

function classifyString(mode, value) {
  if (!value) return value;
  const byShape = classifyByShape(value);
  if (byShape) return byShape;
  if (COARSE_ENUMS.has(value)) return value;
  // 诊断码有独立的形状规则，**不共享**"短 token"的 32 字符上界。
  // 原因：OFFICE_COMPILE_WORKSTATION_MEMBER_DUPLICATE 这类码天然更长，
  // 而它们的信息价值恰恰在于可读——截断或脱敏等于把诊断变成哑谜。
  // 上界存在的目的是区分"短枚举"与"长正文"，诊断码本身已由
  // DIAGNOSTIC_CODE_RE 的全大写+下划线结构证明了自己不是正文。
  if (DIAGNOSTIC_CODE_RE.test(value)) return value;
  if (SHORT_ENUM_TOKEN_RE.test(value)) return value;
  if (CALENDAR_DAY_RE.test(value)) return value; // billing-day bucket key
  return mode === 'full' ? value : REDACTED.TEXT;
}

// Applies key semantics to a raw child value, then value-shape semantics.
function applyKey(mode, key, value, seen) {
  if (typeof value === 'string') {
    if (SECRET_KEY_RE.test(key)) return REDACTED.SECRET;
    const byShape = classifyByShape(value);
    if (byShape) return byShape;
    if (SESSION_KEY_RE.test(key)) return REDACTED.SESSION;
    if (PATH_KEY_RE.test(key)) return REDACTED.PATH;
    if (TOKEN_COUNT_KEY_RE.test(key)) return REDACTED.TOKENS;
    if (TEXT_KEY_RE.test(key)) {
      if (mode === 'full') return value;
      return REDACTED.TEXT;
    }
    return classifyString(mode, value);
  }
  if (typeof value === 'number') {
    return TOKEN_COUNT_KEY_RE.test(key) ? REDACTED.TOKENS : value;
  }
  return redactNode(mode, value, seen);
}

function redactNode(mode, value, seen) {
  if (value === null || typeof value === 'boolean' || value === undefined) return value;
  if (typeof value === 'string') return classifyString(mode, value);
  if (typeof value === 'number') return value;
  if (typeof value !== 'object') return REDACTED.TEXT;
  if (seen.has(value)) return REDACTED.TEXT;
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((item) => redactNode(mode, item, seen));
    seen.delete(value);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return REDACTED.TEXT;
  seen.add(value);
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = applyKey(mode, key, value[key], seen);
  }
  seen.delete(value);
  return out;
}

function createPrivacyRedactor(options) {
  const mode = options && options.mode === 'full' ? 'full' : 'redacted';
  return {
    mode,
    redactText(text) {
      if (text === null || text === undefined) return '';
      const value = String(text);
      if (value === '') return '';
      return mode === 'full' ? value : REDACTED.TEXT;
    },
    redactValue(value) {
      return redactNode(mode, value, new Set());
    },
    redactEvent(event) {
      if (!event || typeof event !== 'object') return null;
      const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? event.data
        : {};
      return {
        type: typeof event.type === 'string' ? event.type : '',
        seq: event.seq,
        time: event.time,
        dataKeys: Object.keys(data).sort(),
      };
    },
  };
}

module.exports = { createPrivacyRedactor, REDACTED, COARSE_ENUMS };
