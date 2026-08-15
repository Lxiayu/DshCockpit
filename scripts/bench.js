// scripts/bench.js — quick performance probes (CPU hot paths + history).
// Usage: node scripts/bench.js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tokenStats = require('../src/token-stats');
const { searchSessions } = require('../src/session-search');
const cost = require('../src/cost');

function ms(fn) {
  const s = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - s) / 1e6;
}

async function msAsync(fn) {
  const s = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - s) / 1e6;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bench-'));
  const sd = path.join(dir, 'sessions', 'proj', 'sess1');
  fs.mkdirSync(sd, { recursive: true });

  // synthetic 100k-event session log (~plaintext jsonl)
  const lines = [JSON.stringify({ id: 's1', cwd: 'C:\\bench' })];
  for (let i = 0; i < 100000; i += 1) {
    lines.push(JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 10 } } }));
  }
  const file = path.join(sd, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  console.log(`[bench] synthetic log: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, 100k events`);

  let r;
  let t = await msAsync(() => tokenStats.collect(dir));
  r = await tokenStats.collect(dir);
  console.log(`[bench] token-stats.collect (cold)  : ${t.toFixed(1)} ms  -> ${r.totals.input} input tokens`);
  t = await msAsync(() => tokenStats.collect(dir));
  console.log(`[bench] token-stats.collect (cached): ${t.toFixed(1)} ms`);
  const cacheHits = r.sessionCount;
  console.log(`[bench] sessions parsed: ${cacheHits}`);

  t = ms(() => searchSessions(dir, 'assistant'));
  const hits = searchSessions(dir, 'assistant');
  console.log(`[bench] session-search (first)     : ${t.toFixed(1)} ms  -> ${hits.length} hit(s)`);
  t = ms(() => searchSessions(dir, 'assistant'));
  console.log(`[bench] session-search (cached text): ${t.toFixed(1)} ms`);

  const history = [];
  const today = new Date();
  for (let d = 0; d < 90; d += 1) {
    const dt = new Date(today.getTime() - d * 86400000);
    history.push({ date: dt.toISOString().slice(0, 10), input: 1e6, output: 5e5, cacheRead: 2e6, cacheWrite: 1e4, sessions: 10, cost: 12.5 });
  }
  t = ms(() => { for (let i = 0; i < 1000; i += 1) cost.summarize(history, 30); });
  console.log(`[bench] cost.summarize x1000 (90-day): ${t.toFixed(1)} ms`);

  // real DSH_HOME (only if sessions are present; log size, measure collect)
  const real = path.join(os.homedir(), '.dsh');
  const realRoot = path.join(real, 'sessions');
  if (fs.existsSync(realRoot)) {
    let total = 0;
    try {
      for (const f of fs.readdirSync(realRoot, { recursive: true })) {
        try { total += fs.statSync(path.join(realRoot, f)).size; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    console.log(`[bench] real DSH_HOME sessions: ${(total / 1e6).toFixed(1)} MB`);
    if (total < 500 * 1024 * 1024) {
      const t2 = await msAsync(() => tokenStats.collect(real));
      console.log(`[bench] real session collect   : ${t2.toFixed(0)} ms`);
    } else {
      console.log('[bench] real sessions too large to benchmark safely; skipped');
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('[bench] FAILED:', e); process.exit(1); });
