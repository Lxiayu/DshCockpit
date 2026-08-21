// src/compact.js — long-session management: /compact trigger + compaction
// tracking (v0.2.4 C3).
//
// dsh ships a full native compaction stack (dsh-compaction +
// dsh-compaction-basic + dsh-command-compact; `/compact` is idle-only,
// auto-compaction runs at a ~0.8 pressure ratio). The shell stays thin on top:
//   - tracking: scan the active session JSONL for the event chain
//     compaction/start -> compaction/summary (token accounting) ->
//     user/message(surfaceOp:replace) -> compaction/end, and report the
//     before/after context sizes + estimated savings at cost.js rates
//   - history: the last HISTORY_MAX compactions, persisted under userData
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cost = require('./cost');
const tokenStats = require('./token-stats');

const HISTORY_MAX = 20;

// ---------------------------------------------------------------------------
// compaction event chain (session JSONL scanner)
// ---------------------------------------------------------------------------
/** Prompt-side context size of a usage snapshot. */
function promptSide(u) {
  if (!u) return 0;
  return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
}

/** Usage payload of a session event (assistant/message data.usage, or an
 * assistant/chunk usage chunk) — same shapes token-stats sums. */
function usageOf(ev) {
  if (!ev || !ev.data) return null;
  if (ev.type === 'assistant/message' && ev.data.usage) return ev.data.usage;
  if (ev.type === 'assistant/chunk' && ev.data.chunk && ev.data.chunk.type === 'usage') return ev.data.chunk.usage;
  return null;
}

/** Tolerant extraction of the post-compaction token count a summary event
 * carries. The upstream schema is merge-extensible and not yet observed in
 * a local session, so several common shapes are accepted; unknown shapes
 * return null and the scanner falls back to the first usage event after
 * compaction/end. */
function extractAfterTokens(data) {
  if (!data || typeof data !== 'object') return null;
  for (const k of ['tokensAfter', 'afterTokens', 'estimatedTokensAfter', 'contextTokensAfter', 'postTokens']) {
    if (typeof data[k] === 'number' && data[k] >= 0) return data[k];
  }
  for (const holder of [data.tokens, data.tokenCounts, data.counts, data.accounting]) {
    if (holder && typeof holder === 'object') {
      for (const k of ['after', 'afterTokens', 'post', 'postCompaction', 'total', 'totalTokens']) {
        if (typeof holder[k] === 'number' && holder[k] >= 0) return holder[k];
      }
    }
  }
  return null;
}

/** Usage of the summarization call itself (the compaction's own cost), from
 * the summary event's provider/model envelope. */
function extractUsageEnvelope(data) {
  if (!data || typeof data !== 'object') return null;
  for (const holder of [data.usage, data.envelope, data.request]) {
    const u = holder && (holder.usage || holder);
    if (u && typeof u === 'object'
      && (typeof u.inputTokens === 'number' || typeof u.outputTokens === 'number')) {
      return { input: u.inputTokens || 0, output: u.outputTokens || 0 };
    }
  }
  return null;
}

function finishRecord(p) {
  const afterTokens = typeof p.afterTokens === 'number'
    ? p.afterTokens
    : (p.sawEnd && p.postUsage ? promptSide(p.postUsage) : null);
  return {
    id: p.id,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    summaryAt: p.summaryAt || null,
    beforeTokens: p.beforeTokens,
    afterTokens,
    beforeUsage: p.beforeUsage,
    summaryUsage: p.summaryUsage || null,
    model: p.model || null,
    complete: !!p.sawEnd,
  };
}

/**
 * Scan a decoded session log for the compaction event chain. One pass:
 *  - before: prompt side of the most recent usage event at compaction/start
 *    (the same basis as the pill's context pressure)
 *  - after: the summary event's own token accounting, falling back to the
 *    first usage event after compaction/end
 *  - `open` is set while a compaction/start has no matching end yet (in
 *    progress, or a stale orphan after a crash — the tracker resets those
 *    when the runtime restarts)
 * Records only count as complete once their end event has been seen.
 */
function scanCompactions(text) {
  const records = [];
  let open = null;
  let lastUsage = null;
  let pending = null;
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.length === 0) {
      if (nl === -1) break;
      continue;
    }
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    const usage = usageOf(ev);
    if (usage) {
      lastUsage = {
        input: usage.inputTokens || 0, output: usage.outputTokens || 0,
        cacheRead: usage.cacheReadTokens || 0, cacheWrite: usage.cacheWriteTokens || 0,
      };
      if (pending && pending.sawEnd && !pending.postUsage) pending.postUsage = { ...lastUsage };
    }
    if (ev.type === 'compaction/start') {
      if (pending) records.push(finishRecord(pending));
      const d = ev.data || {};
      pending = {
        id: typeof d.compactionId === 'string' ? d.compactionId : `start-${records.length + 1}`,
        startedAt: typeof ev.time === 'number' ? ev.time : null,
        endedAt: null,
        summaryAt: null,
        beforeUsage: lastUsage ? { ...lastUsage } : null,
        beforeTokens: promptSide(lastUsage),
        afterTokens: null,
        summaryUsage: null,
        model: null,
        sawEnd: false,
        postUsage: null,
      };
      open = { id: pending.id, startedAt: pending.startedAt, beforeTokens: pending.beforeTokens };
    } else if (ev.type === 'compaction/summary' && pending) {
      const d = ev.data || {};
      const at = extractAfterTokens(d);
      if (typeof at === 'number') pending.afterTokens = at;
      pending.summaryUsage = extractUsageEnvelope(d);
      if (typeof d.model === 'string') pending.model = d.model;
      else if (d.envelope && typeof d.envelope.model === 'string') pending.model = d.envelope.model;
      if (typeof ev.time === 'number') pending.summaryAt = ev.time;
    } else if (ev.type === 'compaction/end' && pending) {
      pending.sawEnd = true;
      if (typeof ev.time === 'number') pending.endedAt = ev.time;
      open = null;
    }
    // the checkpoint user/message (source.plugin === 'compact',
    // surfaceOp: replace) is log-visible but carries no token accounting
    if (nl === -1) break;
  }
  if (pending) records.push(finishRecord(pending));
  return { records, open };
}

/** Estimated ¥ saved per subsequent turn = (before − after) context tokens
 * priced at the input side of the official matrix. When the before usage
 * split is known, the miss/hit blend of the actual last request is used;
 * peak vs off-peak follows the summary event's time. Pure — reused by tests. */
function estimateSavings(beforeTokens, afterTokens, beforeUsage, timeMs, windows, model) {
  const rates = cost.modelRates(model || cost.DEFAULT_MODEL, cost.isPeakTime(timeMs || 0, windows));
  let perM = rates.inputPerM;
  if (beforeUsage && ((beforeUsage.input || 0) + (beforeUsage.cacheRead || 0)) > 0) {
    const miss = beforeUsage.input || 0;
    const hit = beforeUsage.cacheRead || 0;
    perM = (miss * rates.inputPerM + hit * rates.cacheReadPerM) / (miss + hit);
  }
  const savedTokens = Math.max(0, (beforeTokens || 0) - (afterTokens || 0));
  return { savedTokens, perM, savedYuan: (savedTokens * perM) / 1e6 };
}

// ---------------------------------------------------------------------------
// persisted history (last HISTORY_MAX compactions, newest first)
// ---------------------------------------------------------------------------
function loadHistory(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) return raw.filter((r) => r && r.id);
  } catch { /* first run / corrupt */ }
  return [];
}

function appendHistory(file, rec) {
  const list = loadHistory(file);
  if (list.some((r) => r.id === rec.id)) return list;
  list.unshift(rec);
  const trimmed = list.slice(0, HISTORY_MAX);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
  return trimmed;
}

// ---------------------------------------------------------------------------
// tracker: watch the active (latest-mtime) session for compaction events
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 *   historyFile  path under userData for the persisted records
 *   dshHomeOf    () => DSH_HOME root (sessions live under <root>/sessions)
 *   windows      () => peak hour ranges for savings pricing (or null)
 *   log          optional line logger
 *   onStatus     optional ('running'|'idle', openInfo?) on transitions
 *   onRecord     optional (entry) when a new completed compaction lands
 */
function createTracker(opts) {
  const historyFile = opts.historyFile;
  const dshHomeOf = opts.dshHomeOf;
  const windowsOf = opts.windows || (() => null);
  const log = opts.log || (() => {});
  const onStatus = opts.onStatus || null;
  const onRecord = opts.onRecord || null;
  const scan = opts.scan || (async (file) => {
    const text = await tokenStats.decodeSessionLogAsync(file);
    return text === null ? { records: [], open: null, unavailable: true } : scanCompactions(text);
  });
  let history = loadHistory(historyFile);
  const known = new Set(history.map((r) => r.id));
  let lastFile = null;
  let lastSize = -1;
  let lastMtimeMs = -1;
  let compacting = false;
  let openId = null;
  let tickInFlight = false;

  async function activeFile() {
    const root = path.join(dshHomeOf(), 'sessions');
    const files = await tokenStats.walkSessionFilesAsync(root);
    let best = null;
    for (const f of files) {
      let st;
      try { st = await fsp.stat(f); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, size: st.size, mtimeMs: st.mtimeMs };
    }
    return best;
  }

  async function tick() {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      let active;
      try { active = await activeFile(); } catch { return; }
      if (!active) return;
      if (active.file === lastFile && active.size === lastSize && active.mtimeMs === lastMtimeMs) return;
      let result;
      try { result = await scan(active.file); } catch { return; }
      if (result.unavailable) return; // zstd frame mid-write; retry next tick
      lastFile = active.file;
      lastSize = active.size;
      lastMtimeMs = active.mtimeMs;
      if (result.open && result.open.id !== openId) {
        openId = result.open.id;
        compacting = true;
        if (onStatus) onStatus('running', result.open);
      } else if (!result.open && openId !== null) {
        openId = null;
        compacting = false;
        if (onStatus) onStatus('idle');
      }
      for (const rec of result.records) {
        if (!rec.complete || known.has(rec.id)) continue;
        known.add(rec.id);
        const sessionId = path.basename(path.dirname(active.file));
        const s = estimateSavings(
          rec.beforeTokens, rec.afterTokens, rec.beforeUsage,
          rec.summaryAt || rec.endedAt || rec.startedAt, windowsOf(), rec.model
        );
        const entry = {
          id: rec.id,
          sessionId,
          at: rec.endedAt || rec.summaryAt || rec.startedAt || Date.now(),
          beforeTokens: rec.beforeTokens,
          afterTokens: rec.afterTokens,
          savedYuan: Math.round(s.savedYuan * 1e4) / 1e4,
          model: rec.model || cost.DEFAULT_MODEL,
        };
        history = appendHistory(historyFile, entry);
        log(`[compact] session ${sessionId} compacted: ${rec.beforeTokens} -> ${rec.afterTokens} tokens (≈¥${s.savedYuan.toFixed(4)}/turn saved)`);
        if (onRecord) onRecord(entry);
      }
    } finally {
      tickInFlight = false;
    }
  }

  return {
    tick,
    history: () => history.slice(),
    isCompacting: () => compacting,
    /** Forget an open compaction (a runtime restart orphaned its start). */
    resetOpen() {
      openId = null;
      compacting = false;
    },
  };
}

module.exports = {
  HISTORY_MAX,
  promptSide,
  scanCompactions,
  estimateSavings,
  loadHistory,
  appendHistory,
  createTracker,
};
