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

// ------------------------------------------------- selector table fallback

test('firstMatch degrades through the selector table (null and throwing selectors skipped)', () => {
  const table = ['a', 'b', 'c', 'd'];
  const queries = { a: () => null, b: () => { throw new Error('bad selector'); }, c: () => ({ tag: 'el' }) };
  const hit = compact.firstMatch(table, (s) => queries[s]());
  assert.deepStrictEqual(hit, { selector: 'c', el: { tag: 'el' } });
  assert.strictEqual(compact.firstMatch(['x'], () => null), null);
});

test('buildInjectScript embeds the selector table, native value setter and Enter fallback', () => {
  const script = compact.buildInjectScript(['textarea.x'], ['button.y']);
  assert.ok(script.includes(JSON.stringify(['textarea.x'])));
  assert.ok(script.includes(JSON.stringify(['button.y'])));
  assert.ok(script.includes("'/compact'"));
  assert.ok(script.includes('HTMLTextAreaElement.prototype')); // React-controlled setter
  assert.ok(script.includes('KeyboardEvent'));                 // Enter fallback path
  assert.ok(script.includes('no-input'));                      // readable failure code
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
  // a relative root makes the joined path resolve outside the whitelist —
  // the closed-resolve guard must refuse to unlink (and to save) it
  const rel = path.relative(process.cwd(), ws);
  const relMem = createMemoryFiles({ workspaceOf: () => rel, dshHomeOf: () => home });
  const refused = await relMem.remove('project');
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, 'denied');
  assert.strictEqual((await relMem.save('project', 'x')).code, 'denied');
  assert.strictEqual(fs.existsSync(path.join(rel, 'AGENTS.md')), false);
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
