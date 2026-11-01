// src/mission/event-log.js — append-only JSONL 事件日志（P1）。
//
// 第一性原理：为什么是"单文件 append-only"而不是"每 Mission 一个文件"
//
//   三个候选：
//     A. 每 Mission 一个 events.jsonl
//        → 隔离好，但**无法全局排序**；跨 Mission 操作（移动 Workstream）困难；
//          备份碎片化（N 个文件要各自原子写，失败面变大）
//     B. 单个 SQLite
//        → 事务好，但引入原生依赖（打包复杂），且我们要的是"追加 + 全量读"，
//          用不上关系查询（mission-core.md §4.1 评估）
//     C. **单一 events.jsonl，每行带 missionId**
//        → 全局 seq 排序、单文件备份、跨 Mission 可查、零原生依赖
//
//   选 C。代价是文件随 Mission 数增长 —— 用归档阈值（20MB / 50 万行）兜住。
//
//   为什么 append-only 是关键：Mission Core 的核心价值是"为什么这么决定"。
//   任何"覆盖写"都会让历史消失，而历史正是跨 Session 记忆的内容本身。
//
// 本模块只负责**字节层面**：追加、逐行解析、坏行跳过、truncate 检测。
// 不做语义校验（那是 schema.js）、不做 fold（那是 projection.js）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 归档阈值。超过后由 store.js 触发 compaction（本模块只提供判断）。 */
const MAX_BYTES = 20 * 1024 * 1024;   // 20MB
const MAX_LINES = 500 * 1000;          // 50 万行

/** 日志文件名（相对 workspace 的 .dsh/mission/）。 */
const LOG_FILE_NAME = 'events.jsonl';

/**
 * 把一个事件序列化成**单行** JSON。
 *
 * 必须保证不含裸换行——否则一行会被拆成两行，读取时整条日志错位。
 * JSON.stringify 会把字符串里的 \n 转义成 \\n，所以只要不手动拼接就是安全的；
 * 这里额外断言一次，防止未来有人改成模板字符串拼接。
 */
function encodeEvent(event) {
  const line = JSON.stringify(event);
  if (line.includes('\n') || line.includes('\r')) {
    throw new Error('encoded event must be a single line (no raw newlines)');
  }
  return line;
}

/**
 * 把一行文本解析成事件。
 *
 * 设计原则：**坏行不抛异常**，返回 {ok:false, error}。
 * 理由：一条损坏的行不应该让整个日志不可读——那正是"全量覆盖写"的失效模式。
 * append-only 的价值之一就是"逐行可跳过坏行"（mission-core.md §4.1）。
 */
function decodeEvent(line) {
  const text = String(line || '').trim();
  if (!text) return { ok: false, error: 'empty line' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'event must be a JSON object' };
  }
  if (typeof parsed.type !== 'string' || !parsed.type) {
    return { ok: false, error: 'event.type is required' };
  }
  if (!Number.isFinite(Number(parsed.seq)) || Number(parsed.seq) < 1) {
    return { ok: false, error: 'event.seq must be a positive number' };
  }
  return { ok: true, event: parsed };
}

/**
 * 读取整个日志。
 *
 * @returns {{events:Array, badLines:Array<{line:number,error:string}>, bytes:number, lineCount:number}}
 *   badLines 非空说明日志有损坏——调用方必须**如实报告**，而不是当成正常。
 */
function readLog(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { events: [], badLines: [], bytes: 0, lineCount: 0, missing: true };
    }
    throw err;
  }

  const events = [];
  const badLines = [];
  const lines = text.split('\n');
  // 末尾的换行会产生一个空串，不算坏行
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === '' && i === lines.length - 1) continue;
    const decoded = decodeEvent(raw);
    if (!decoded.ok) {
      badLines.push({ line: i + 1, error: decoded.error });
      continue;
    }
    events.push(decoded.event);
  }

  return {
    events,
    badLines,
    bytes: Buffer.byteLength(text, 'utf8'),
    lineCount: events.length + badLines.length,
    missing: false,
  };
}

/**
 * 追加事件到日志。
 *
 * 原子性说明（重要，别误以为它是事务性的）：
 *   `fs.appendFileSync` 在 POSIX 上对**单次小于 PIPE_BUF 的写入**是原子的；
 *   更大的写入可能被拆成多次 write。因此本函数：
 *     1. 用 `O_APPEND` 打开（内核保证写位置在文件末尾，不会覆盖既有内容）
 *     2. 一次性写入整批（把一批事件拼成一个 buffer）
 *     3. 崩溃最多导致**末尾出现半行**——读取时会被 badLines 捕获，
 *        而不会破坏前面已写入的事件
 *
 *   这正是 append-only 的核心优势：损坏是**局部的、末尾的、可检测的**，
 *   而不是"整份 JSON 解析失败，全部丢失"。
 *
 * @returns {{appended:number, bytes:number}}
 */
function appendEvents(file, events) {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) return { appended: 0, bytes: 0 };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 每条事件一行；用 \n 连接并补末尾换行，保证下次追加时不会粘到上一行
  const payload = `${list.map(encodeEvent).join('\n')}\n`;
  fs.appendFileSync(file, payload, { encoding: 'utf8' });
  return { appended: list.length, bytes: Buffer.byteLength(payload, 'utf8') };
}

/** 当前日志的字节数（不存在则 0）。 */
function logBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

/** 是否需要归档（按字节或行数）。 */
function needsArchive(file) {
  if (logBytes(file) >= MAX_BYTES) return { needed: true, reason: 'bytes' };
  const r = readLog(file);
  if (r.lineCount >= MAX_LINES) return { needed: true, reason: 'lines' };
  return { needed: false, reason: null };
}

/**
 * 检测日志是否被截断 / 回退（seq 不单调）。
 *
 * append-only 的日志**应该**是单调递增的。如果不单调，说明：
 *   · 有人手动改过文件
 *   · 从备份恢复时混入了旧内容
 *   · 两个写者并发（这本身是架构违规）
 * 三种都必须让调用方知道。
 */
function detectTruncation(events) {
  const problems = [];
  let prev = 0;
  for (const e of Array.isArray(events) ? events : []) {
    const seq = Number(e && e.seq);
    if (!Number.isFinite(seq)) continue;
    if (seq <= prev) {
      problems.push({ seq, prev, reason: 'seq is not strictly increasing' });
    }
    prev = Math.max(prev, seq);
  }
  return { ok: problems.length === 0, problems };
}

/** 下一个可用的 seq（日志空则为 1）。 */
function nextSeq(events) {
  let max = 0;
  for (const e of Array.isArray(events) ? events : []) {
    const seq = Number(e && e.seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max + 1;
}

module.exports = {
  MAX_BYTES,
  MAX_LINES,
  LOG_FILE_NAME,
  encodeEvent,
  decodeEvent,
  readLog,
  appendEvents,
  logBytes,
  needsArchive,
  detectTruncation,
  nextSeq,
};
