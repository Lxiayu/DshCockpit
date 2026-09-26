// src/mcp-verify-gate.js — debounced / merged `--dump-config` verification gate
// (2026-09-25 windows-perf P1, audit §三#2 / §四C).
//
// Problem being fixed: every cordis.patch.yml write used to pay one FULL
// `--dump-config` child cold start (node boot + thousands of module files
// through the Windows AV filter driver). Consecutive edits — a save burst,
// enable/disable toggles, a multi-server import — each paid it again, even
// though only the FINAL file state is what dump-config can meaningfully
// judge (the spawn reads whatever is on disk when it runs).
//
// The gate sits between the patch-file write pipeline (mcp-manager) and the
// raw spawn verifier (main.js dumpConfigVerify) and gives the pipeline three
// cheaper behaviors without weakening the safety net:
//
//   1. Reuse — a text that byte-equals the last text a REAL dump-config run
//      passed is accepted immediately (0 spawns). Invalidation criteria: the
//      content differs, or the ACTIVE runtime version changed (dump-config
//      validates against the active runtime's config schema). Skipped runs
//      (no runtime / spawn error / timeout) are NEVER cached as verified —
//      a skip proves nothing about the content.
//   2. Debounce/merge — writes that land within `delayMs` of each other are
//      verified once: only the LATEST text is spawned for (it is what's on
//      disk by then) and every writer of the burst gets that one result.
//      `maxWaitMs` caps the debounce so a continuous stream of edits cannot
//      starve verification. The whole burst fails or succeeds together and
//      the pre-burst text is restored exactly once (the gate owns rollback;
//      writers never roll back individually, so a burst cannot clobber
//      itself with two competing restorations).
//   3. Serialize — one spawn at a time. A request arriving DURING a run is
//      verified in a FOLLOW-UP round against the then-current disk content,
//      never merged into the running one and never answered by it.
//
// Failure semantics are unchanged from the caller's point of view: a rejected
// write still returns { ok:false, reason } to every writer of the burst and
// the patch file ends up byte-identical to the pre-burst state.
//
// Rollback races (all closed here, each covered by a test):
//   - A failed burst restores ONLY if the disk still holds its own text
//     (a follow-up burst may have written a newer text meanwhile — that
//     newer text must be judged on its own merits, not clobbered).
//   - A follow-up burst's pre may itself be a text an earlier burst just
//     REJECTED (it was on disk between the two writes). Restoring it would
//     resurrect a rejected config, so the restore target walks back through
//     the rejected-text chain to the newest state that was never rejected.
//     dump-config is content-deterministic, so a text built on top of a
//     rejected text is rejected for the same reason and the walk terminates
//     at the last good state.
'use strict';

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_WAIT_MS = 2_000;
const BAD_CHAIN_MAX = 16; // rejected-text → its pre; bounded, FIFO eviction

/**
 * @param {object} opts
 * @param {() => Promise<{ok: boolean, reason?: string, skipped?: string}>} opts.spawnVerify
 *        the raw dump-config verifier (reads the patch file from disk)
 * @param {() => string} [opts.readText]  current file text ('' = absent) —
 *        makes rollback conditional (never clobbers a newer pending write)
 * @param {(text: string) => boolean} [opts.restore]  restore a pre-burst
 *        file text ( '' = the file did not exist ); false/throw = failed
 * @param {() => string} [opts.runtimeVersion]  active runtime version — part
 *        of the reuse key (schema vocabulary changes with the runtime)
 * @param {number} [opts.delayMs]   debounce window (default 300)
 * @param {number} [opts.maxWaitMs] max age of a burst before it must verify (default 2000)
 * @param {() => number} [opts.now]
 * @param {(fn: Function, ms: number) => any} [opts.schedule]  injectable timer (tests)
 * @param {(handle: any) => void} [opts.cancel]
 * @param {(line: string) => void} [opts.log]
 */
function createMcpVerifyGate(opts) {
  const spawnVerify = opts.spawnVerify;
  const readText = opts.readText || (() => null); // null = cannot read → restore is unconditional
  const restore = opts.restore || (() => true);
  const runtimeVersion = opts.runtimeVersion || (() => '');
  const now = opts.now || (() => Date.now());
  const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel || ((h) => clearTimeout(h));
  const log = opts.log || (() => {});
  const delayMs = Number.isFinite(opts.delayMs) && opts.delayMs >= 0 ? opts.delayMs : DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs > 0 ? opts.maxWaitMs : DEFAULT_MAX_WAIT_MS;

  // Last text a REAL (non-skipped) dump-config run accepted, + the runtime
  // vocabulary it was accepted under. null = nothing verified yet.
  let verifiedText = null;
  let verifiedRt = null;
  // Rejected text → the pre its own burst would have restored to. A later
  // burst built on a rejected text must not resurrect it on failure.
  const badChain = new Map();

  let timer = null;
  let burstStartedAt = 0;
  let pendingText = null; // the latest text of the open burst (what's on disk)
  let preText = null;     // file state before the burst's FIRST write
  let waiters = [];
  let running = false;

  function settle(list, result) {
    // ONLY resolves the settling round's waiters — burst fields (pendingText/
    // preText/burstStartedAt) were already closed by the runNow prologue and
    // may hold a NEWER burst opened mid-run; touching them here would wipe it.
    for (const w of list) w.resolve(result);
  }

  /** Newest restore target that was never rejected by a real dump-config run. */
  function restoreTargetFor(pre) {
    let t = pre;
    let guard = 0;
    while (badChain.has(t) && guard++ < BAD_CHAIN_MAX) t = badChain.get(t);
    return t;
  }

  async function runNow() {
    if (timer) { cancel(timer); timer = null; }
    if (running || !waiters.length) return;
    // Close the burst NOW: pendingText/preText go null so a request landing
    // during the run OPENS A FRESH BURST (follow-up round) instead of merging
    // into the closed one or riding its verdict.
    running = true;
    const list = waiters;
    const text = pendingText;
    const pre = preText;
    waiters = [];
    pendingText = null;
    preText = null;
    try {
      let result;
      try {
        result = await spawnVerify();
      } catch (err) {
        result = { ok: true, skipped: 'spawn' }; // never block the pipeline on a broken verifier
      }
      if (result && result.ok && !result.skipped) {
        verifiedText = text;
        verifiedRt = String(runtimeVersion() || '');
        badChain.clear();
        log(`[mcp] dump-config verified the write (${String(text).split('\n').length} lines)`);
        settle(list, { ok: true });
      } else if (result && !result.ok) {
        badChain.set(text, pre);
        while (badChain.size > BAD_CHAIN_MAX) badChain.delete(badChain.keys().next().value);
        const target = restoreTargetFor(pre);
        let restored = true;
        try {
          const cur = readText();
          if (cur === null || cur === text) {
            restored = restore(target) !== false; // disk still ours → roll back
            if (restored) log('[mcp] rollback: restored the pre-burst text');
          }
          // else a newer write is pending its own round; leave the disk alone
        } catch { restored = false; }
        if (!restored) log('[mcp] rollback failed: restore threw');
        settle(list, { ok: false, reason: restored ? result.reason : `${result.reason}; rollback failed` });
      } else {
        // skipped (no runtime / spawn error / timeout) — prove nothing, cache nothing
        settle(list, { ok: true, skipped: (result && result.skipped) || 'unknown' });
      }
    } finally {
      running = false;
      if (waiters.length) runNow().catch(() => {}); // follow-up burst queued during the run
    }
  }

  return {
    /** Register a just-written patch text. Resolves once THIS burst is verified
     * (or the text is accepted from cache). `pre` is the file text the writer
     * read before its own write — the FIRST writer's `pre` is what a failed
     * burst is rolled back to. */
    request(text, pre) {
      if (text === verifiedText && String(runtimeVersion() || '') === verifiedRt) {
        return Promise.resolve({ ok: true, reused: true });
      }
      return new Promise((resolve) => {
        waiters.push({ resolve });
        if (pendingText === null) {
          // new burst: the pre-burst state comes from this first writer
          pendingText = text;
          preText = pre;
          burstStartedAt = now();
        } else {
          pendingText = text; // latest write wins; only it is on disk by spawn time
        }
        if (timer) cancel(timer);
        if (now() - burstStartedAt >= maxWaitMs) {
          runNow().catch(() => {});
          return;
        }
        timer = schedule(runNow, delayMs);
      });
    },

    /** Drop the cached verified text (e.g. the patch file was modified by
     * something outside the manager and the caller knows it). */
    invalidate() {
      verifiedText = null;
      verifiedRt = null;
    },

    /** Test/probe hook: what the reuse path would currently accept. */
    verified() {
      return verifiedText === null ? null : { text: verifiedText, runtimeVersion: verifiedRt };
    },
  };
}

module.exports = { createMcpVerifyGate, DEFAULT_DEBOUNCE_MS, DEFAULT_MAX_WAIT_MS };
