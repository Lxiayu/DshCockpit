// test/compact.test.js — long-session center (v0.2.4 C3): /compact trigger
// helpers, the compaction event-chain scanner, savings pricing, the AGENTS.md
// whitelist, tracker integration, and the new context-pressure basis.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const compact = require('../src/compact');
const cost = require('../src/cost');
const tokenStats = require('../src/token-stats');
const { createMemoryFiles } = require('../src/memory-files');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-'));
const j = (o) => JSON.stringify(o);

function usageEvent(input, output, cacheRead, cacheWrite, time) {
  return j({ type: 'assistant/message', time, data: { usage: {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
  } } });
}

// ------------------------------------------------- compaction event chain

test('scanCompactions extracts the full start→summary→end chain with accounting', () => {
  const text = [
    usageEvent(1000, 50, 9000, 500, 1),                       // before basis
    j({ type: 'compaction/start', time: 2, data: { compactionId: 'c1' } }),
    j({ type: 'compaction/summary', time: 3, data: {
      tokensAfter: 3000,
      usage: { inputTokens: 10500, outputTokens: 200 },
      model: 'deepseek-chat',
    } }),
    j({ type: 'compaction/end', time: 4 }),
  ].join('\n');
  const { records, open } = compact.scanCompactions(text);
  assert.strictEqual(open, null);
  assert.strictEqual(records.length, 1);
  const r = records[0];
  assert.strictEqual(r.id, 'c1');
  assert.strictEqual(r.complete, true);
  // before = prompt side (input + cacheRead + cacheWrite) of the last usage before start
  assert.strictEqual(r.beforeTokens, 1000 + 9000 + 500);
  // after = the summary event's own accounting
  assert.strictEqual(r.afterTokens, 3000);
  assert.strictEqual(r.model, 'deepseek-chat');
  assert.deepStrictEqual(r.summaryUsage, { input: 10500, output: 200 });
  assert.strictEqual(r.startedAt, 2);
  assert.strictEqual(r.endedAt, 4);
});

test('scanCompactions falls back to the first post-end usage when the summary carries no tokens', () => {
  const text = [
    usageEvent(1000, 50, 9000, 500, 1),
    j({ type: 'compaction/start', time: 2, data: { compactionId: 'c2' } }),
    j({ type: 'compaction/summary', time: 3, data: { model: 'deepseek-chat' } }),
    j({ type: 'compaction/end', time: 4 }),
    usageEvent(300, 10, 2500, 0, 5),                          // first usage after end
    usageEvent(999, 10, 0, 0, 6),
  ].join('\n');
  const { records, open } = compact.scanCompactions(text);
  assert.strictEqual(open, null);
  const r = records[0];
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.afterTokens, 300 + 2500);              // prompt side of the post usage
  assert.strictEqual(r.beforeTokens, 10500);
});

test('scanCompactions reports an open compaction (start without end) as in-progress', () => {
  const text = [
    usageEvent(1000, 0, 0, 0, 1),
    j({ type: 'compaction/start', time: 2, data: { compactionId: 'c3' } }),
  ].join('\n');
  const { records, open } = compact.scanCompactions(text);
  assert.ok(open, 'open info expected while the chain has no end event');
  assert.strictEqual(open.id, 'c3');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].complete, false);
  assert.strictEqual(records[0].afterTokens, null);
});

// ------------------------------------------------- savings (cost.js rates)

test('estimateSavings prices the saved context at cost.js rates (miss/hit blend, off-peak)', () => {
  const rates = cost.modelRates(cost.DEFAULT_MODEL, false);   // windows=null -> off-peak
  const beforeUsage = { input: 1000, output: 0, cacheRead: 99000, cacheWrite: 0 };
  const s = compact.estimateSavings(100000, 20000, beforeUsage, 0, null, null);
  assert.strictEqual(s.savedTokens, 80000);
  const expectPerM = (1000 * rates.inputPerM + 99000 * rates.cacheReadPerM) / 100000;
  assert.strictEqual(s.perM, expectPerM);
  assert.strictEqual(s.savedYuan, (80000 * expectPerM) / 1e6);
  assert.ok(s.savedYuan > 0);
  // compaction that grew the context must not report negative savings
  const none = compact.estimateSavings(100, 200, null, 0, null, null);
  assert.strictEqual(none.savedTokens, 0);
  assert.strictEqual(none.savedYuan, 0);
});

// ------------------------------------------------- stable runtime trigger gate

test('compact trigger is isolated from Harness DOM selectors and wired through runtime RPC', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'compact.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /COMPACT_INPUT_SELECTORS|COMPACT_SEND_SELECTORS|buildInjectScript|executeJavaScript/);
  assert.match(main, /createHarnessRpcClient\(/);
  assert.match(main, /compactLatestSession\(\)/);
  assert.doesNotMatch(main, /compact\.submitCompactCommand/);
});

// ------------------------------------------------- AGENTS.md whitelist

test('memory files: whitelist accepts exactly the two managed AGENTS.md paths', async () => {
  const ws = tmpdir();
  const home = tmpdir();
  const other = tmpdir();
  const mem = createMemoryFiles({ workspaceOf: () => ws, dshHomeOf: () => home });
  assert.strictEqual(mem.isAllowed(path.join(ws, 'AGENTS.md')), true);
  assert.strictEqual(mem.isAllowed(path.join(home, 'AGENTS.md')), true);
  assert.strictEqual(mem.isAllowed(path.join(ws, 'sub', 'AGENTS.md')), false);
  assert.strictEqual(mem.isAllowed(path.join(other, 'AGENTS.md')), false);
  assert.strictEqual(mem.isAllowed(path.join(ws, 'CLAUDE.md')), false);
  assert.strictEqual(mem.isAllowed('/etc/passwd'), false);

  // missing file reads as exists:false; save creates it; get round-trips
  const miss = await mem.get('project');
  assert.strictEqual(miss.ok, true);
  assert.strictEqual(miss.exists, false);
  const saved = await mem.save('project', '# memory\n- prefers tabs');
  assert.strictEqual(saved.ok, true);
  const back = await mem.get('project');
  assert.strictEqual(back.exists, true);
  assert.strictEqual(back.content, '# memory\n- prefers tabs');

  // invalid scope and oversize content are refused with readable codes
  assert.strictEqual((await mem.save('evil', 'x')).code, 'scope');
  assert.strictEqual((await mem.get('evil')).code, 'scope');
  const huge = await mem.save('global', 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.strictEqual(huge.code, 'size');
  assert.strictEqual(fs.existsSync(path.join(home, 'AGENTS.md')), false);
});

test('memory files: remove deletes a managed file and is idempotent when missing', async () => {
  const ws = tmpdir();
  const home = tmpdir();
  const mem = createMemoryFiles({ workspaceOf: () => ws, dshHomeOf: () => home });
  await mem.save('project', '# stale memory');
  const del = await mem.remove('project');
  assert.strictEqual(del.ok, true);
  assert.strictEqual(del.existed, true);
  assert.strictEqual(fs.existsSync(path.join(ws, 'AGENTS.md')), false);
  const back = await mem.get('project');
  assert.strictEqual(back.exists, false);
  // deleting an already-missing file is a success (idempotent)
  const again = await mem.remove('project');
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.existed, false);
});

test('memory files: remove refuses invalid scopes and non-whitelist paths', async () => {
  const ws = tmpdir();
  const home = tmpdir();
  const mem = createMemoryFiles({ workspaceOf: () => ws, dshHomeOf: () => home });
  assert.strictEqual((await mem.remove('evil')).code, 'scope');
  assert.strictEqual((await mem.remove('../escape')).code, 'scope');
  // The closed-resolve guard refuses any root whose joined path is not already
  // canonical: the whitelist entry stays relative while the candidate resolves
  // against the process cwd, so unlink and save must both be denied. The root is
  // built relative to the repo (never `path.relative(cwd, tmpdir)`, which turns
  // ABSOLUTE on Windows when cwd and the temp dir live on different drives and
  // would therefore be legitimately whitelisted).
  const relRoot = path.join('..', 'dsh-memory-whitelist-fixture');
  const relMem = createMemoryFiles({ workspaceOf: () => relRoot, dshHomeOf: () => home });
  const refused = await relMem.remove('project');
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, 'denied');
  assert.strictEqual((await relMem.save('project', 'x')).code, 'denied');
  assert.strictEqual(fs.existsSync(path.resolve(relRoot, 'AGENTS.md')), false);
});

// ------------------------------------------------- tracker integration

test('tracker follows the active session file: running→idle, history entry with savings', async () => {
  const home = tmpdir();
  const sesDir = path.join(home, 'sessions', 'proj1', 'ses-42');
  await fsp.mkdir(sesDir, { recursive: true });
  const file = path.join(sesDir, 'session.jsonl');
  const historyFile = path.join(home, 'compact-history.json');

  const statuses = [];
  const records = [];
  const tracker = compact.createTracker({
    historyFile,
    dshHomeOf: () => home,
    windows: () => null,
    log: () => {},
    onStatus: (s) => statuses.push(s),
    onRecord: (r) => records.push(r),
  });

  await fsp.writeFile(file, [
    usageEvent(1000, 50, 9000, 500, 1),
    j({ type: 'compaction/start', time: 2, data: { compactionId: 'run-1' } }),
  ].join('\n') + '\n');
  await tracker.tick();
  assert.strictEqual(tracker.isCompacting(), true);
  assert.deepStrictEqual(statuses, ['running']);
  assert.strictEqual(tracker.history().length, 0);

  await fsp.appendFile(file, [
    j({ type: 'compaction/summary', time: 3, data: { tokensAfter: 3000, model: cost.DEFAULT_MODEL } }),
    j({ type: 'compaction/end', time: 4 }),
  ].join('\n') + '\n');
  await tracker.tick();
  assert.strictEqual(tracker.isCompacting(), false);
  assert.deepStrictEqual(statuses, ['running', 'idle']);
  const hist = tracker.history();
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].id, 'run-1');
  assert.strictEqual(hist[0].sessionId, 'ses-42');
  assert.strictEqual(hist[0].beforeTokens, 10500);
  assert.strictEqual(hist[0].afterTokens, 3000);
  assert.ok(hist[0].savedYuan > 0);
  assert.strictEqual(records.length, 1);

  // the record persists and dedupes across restarts (known-id skip)
  const reloaded = compact.loadHistory(historyFile);
  assert.strictEqual(reloaded.length, 1);
  await tracker.tick();
  assert.strictEqual(tracker.history().length, 1);
});

test('tracker delegates log scanning and does not overlap worker requests', async () => {
  const home = tmpdir();
  const sesDir = path.join(home, 'sessions', 'proj', 'ses-worker');
  await fsp.mkdir(sesDir, { recursive: true });
  await fsp.writeFile(path.join(sesDir, 'session.jsonl'), '{}\n');
  let calls = 0;
  const tracker = compact.createTracker({
    historyFile: path.join(home, 'compact-history.json'),
    dshHomeOf: () => home,
    scan: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { records: [], open: null };
    },
  });
  await Promise.all([tracker.tick(), tracker.tick()]);
  assert.equal(calls, 1);
});

// ------------------------------------------------- pressure basis (main.js fix)

test('pressureOf: context pressure is the LAST request prompt side, not the history sum', () => {
  assert.strictEqual(tokenStats.pressureOf({ lastUsage: { input: 1000, cacheRead: 500, cacheWrite: 200 } }), 1700);
  assert.strictEqual(tokenStats.pressureOf({ lastUsage: { input: 1, cacheRead: 0, cacheWrite: 0 } }), 1);
  // no usage seen yet / malformed input -> 0, never NaN
  assert.strictEqual(tokenStats.pressureOf({}), 0);
  assert.strictEqual(tokenStats.pressureOf(null), 0);
  assert.strictEqual(tokenStats.pressureOf({ input: 999999 }), 0); // lifetime sums no longer count
});

test('parseSessionLogAsync surfaces lastUsage = the most recent usage event, not the sum', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    usageEvent(50000, 100, 0, 0, 1),
    usageEvent(2000, 30, 3000, 0, 2),
  ].join('\n') + '\n');
  const r = await tokenStats.parseSessionLogAsync(file, null);
  assert.ok(r);
  // cumulative totals still grow…
  assert.strictEqual(r.totals.input, 52000);
  // …but the pressure basis is only the last request's prompt side (2000+3000)
  assert.deepStrictEqual(r.totals.lastUsage, { input: 2000, output: 30, cacheRead: 3000, cacheWrite: 0 });
  assert.strictEqual(tokenStats.pressureOf(r.totals), 5000);
});

// ------------- windows-perf P1 #4: the compact tick shares the token poll's traversal

test('REGRESSION #4 (shared stat): the compact tick rides the token-poll snapshot — one stat per tick, zero walks, TTL falls back to the walk', async () => {
  const home = tmpdir();
  const sesDir = path.join(home, 'sessions', 'proj', 'ses-share');
  await fsp.mkdir(sesDir, { recursive: true });
  const file = path.join(sesDir, 'session.jsonl');
  await fsp.writeFile(file, usageEvent(1000, 10, 0, 0, 1) + '\n');
  const root = path.join(home, 'sessions');

  // what a tokenStats.collect()/session-worker result carries for the tracker
  const st = await fsp.stat(file);
  const stats = { sessions: [{ file, usage: {}, mtimeMs: st.mtimeMs, size: st.size }] };

  let clock = 1_000_000;
  let statCalls = 0;
  let deepScans = 0;
  const snapshot = compact.createSessionSnapshot({
    ttlMs: 15_000,
    rootOf: () => root,
    deepScan: async () => { deepScans += 1; return compact.walkActiveSession(() => home); },
    now: () => clock,
    stat: async (f) => { statCalls += 1; return fsp.stat(f); },
  });
  snapshot.update(stats, root); // fed by pollTokens after each collect()

  let scans = 0;
  const tracker = compact.createTracker({
    historyFile: path.join(home, 'compact-history.json'),
    dshHomeOf: () => home,
    activeFile: () => snapshot.activeFile(),
    scan: async () => { scans += 1; return { records: [], open: null }; },
    log: () => {},
  });

  const walksBefore = tokenStats.walkCacheStats().walks;
  await tracker.tick();
  await tracker.tick();
  await tracker.tick();
  assert.strictEqual(tokenStats.walkCacheStats().walks, walksBefore, 'quiet ticks: zero full-tree walks');
  assert.strictEqual(statCalls, 3, 'exactly ONE stat per quiet tick (was N per tick before)');
  assert.strictEqual(deepScans, 0);
  assert.strictEqual(scans, 1, 'baseline scan once, quiet ticks skip via size/mtime gating');

  // the writer appends → the single stat sees the new size → rescan
  await fsp.appendFile(file, usageEvent(100, 5, 0, 0, 2) + '\n');
  await tracker.tick();
  assert.strictEqual(statCalls, 4, 'still exactly one stat per tick');
  assert.strictEqual(scans, 2, 'change detected through the shared snapshot');

  // snapshot goes stale (token poll stalled) → old walk path, tracking survives
  clock += 20_000;
  const walksBeforeStale = tokenStats.walkCacheStats().walks;
  await tracker.tick();
  assert.strictEqual(deepScans, 1, 'stale snapshot hands back to the deep scan');
  assert.strictEqual(tokenStats.walkCacheStats().walks, walksBeforeStale + 1, 'the fallback is the pre-P1 walk');
  assert.strictEqual(scans, 2, 'unchanged file still not rescanned through the fallback');
});

test('REGRESSION #4 (invalidation): missing snapshot, foreign root, and stale snapshot all fall back', async () => {
  const home = tmpdir();
  const root = path.join(home, 'sessions');
  let deepScans = 0;
  const snapshot = compact.createSessionSnapshot({
    rootOf: () => root,
    deepScan: async () => { deepScans += 1; return null; },
    now: () => 0,
    stat: async () => { throw new Error('stat must not run while invalid'); },
  });
  await snapshot.activeFile();
  assert.strictEqual(deepScans, 1, 'no snapshot yet → deep scan');
  snapshot.update({ sessions: [{ file: '/x', mtimeMs: 1, size: 0 }] }, path.join(home, 'sessions-of-old-home'));
  await snapshot.activeFile();
  assert.strictEqual(deepScans, 2, 'foreign root (dshHome switched) → deep scan');
  snapshot.update({ sessions: [{ file: '/x', mtimeMs: 1, size: 0 }] }, root);
  assert.strictEqual(await snapshot.activeFile(), null, 'fresh snapshot: stat of a vanished file → quiet null');
  assert.strictEqual(deepScans, 2, 'fresh snapshot serves without the deep scan');
  snapshot.update(null, root);
  snapshot.update({}, root);
  assert.strictEqual(snapshot.fresh(), true, 'malformed collect results are ignored, good snapshot kept');
});
