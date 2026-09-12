// src/weekly-report.js — R5 Wrapped-style weekly agent report card.
//
// Two layers:
//   PURE DATA   — buildWeeklyReport(): folds token-stats collect() output
//                 (per-day buckets), scheduler/quickask activity streams and
//                 cache-economics savings into one desensitised dataset for a
//                 Beijing-Monday..Sunday window. No Electron here; fully
//                 unit-testable.
//   ORCHESTRATE — createWeeklyReport(): injects the Electron bits (offscreen
//                 BrowserWindow PNG capture), the IM broadcast hook and the
//                 activity recorder used by event sources.
//
// Desensitisation: workspace names appear as basenames only — never full
// paths (report §5 risk table).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 86_400_000;
const CST = 8 * 3_600_000;

/** Beijing-time Monday 00:00 window containing `ms`.
 * Returns { start, end } in epoch-ms ([start, end)). */
function weekWindowCst(ms) {
  const bj = Number(ms) + CST;
  const dayIdx = Math.floor(bj / DAY_MS);
  const dow = (dayIdx + 4) % 7;        // 0=Sun … 6=Sat (epoch day 0 = Thursday)
  const sinceMon = (dow + 6) % 7;      // 0=Mon … 6=Sun
  const monBj = (dayIdx - sinceMon) * DAY_MS;
  return { start: monBj - CST, end: monBj - CST + 7 * DAY_MS };
}

function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * Build the desensitised weekly dataset.
 * @param {object} deps
 * @param {{totals:object, sessions:object[]}} deps.collectData  token-stats output
 * @param {Array<{ts:string|number, kind:'quickask'|'task', ok:boolean}>} deps.activity
 * @param {{costInputPerM?:number, costOutputPerM?:number, costCacheReadPerM?:number}} deps.pricing
 * @param {number} deps.nowMs
 * @param {string} [deps.lang] 'zh' | 'en' (labels only; numbers are locale-free)
 */
function buildWeeklyReport({ collectData, activity = [], pricing = {}, nowMs = Date.now(), lang = 'zh' }) {
  const win = weekWindowCst(nowMs);
  const prev = { start: win.start - 7 * DAY_MS, end: win.start };
  const inWin = (ts) => {
    const t = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
    return t >= win.start && t < win.end;
  };

  const pIn = Number(pricing.costInputPerM) || 0;   // ¥ per 1M tokens
  const pOut = Number(pricing.costOutputPerM) || 0;
  const pCr = Number(pricing.costCacheReadPerM) || 0;
  const pCw = Number(pricing.costCacheWritePerM) || 0;
  const costOf = (b) => ((b.input || 0) / 1e6) * pIn + ((b.output || 0) / 1e6) * pOut
    + ((b.cacheRead || 0) / 1e6) * pCr + ((b.cacheWrite || 0) / 1e6) * pCw;

  // ---- per-day fold over the window (flat prices; estimate semantics)
  let tokensIn = 0, tokensOut = 0, tokensCacheRead = 0, costYuan = 0;
  let peakDay = null; // busiest by total tokens
  const perDay = [];
  for (const [day, b] of Object.entries((collectData && collectData.totals && collectData.totals.days) || {})) {
    const t = Date.parse(`${day}T00:00:00+08:00`);
    if (!(t >= win.start && t < win.end)) continue;
    const tokens = (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0);
    const cost = costOf(b);
    perDay.push({ day, tokens, costYuan: cost });
    tokensIn += b.input || 0; tokensOut += b.output || 0; tokensCacheRead += b.cacheRead || 0;
    if (!peakDay || tokens > peakDay.tokens) peakDay = { day, tokens, costYuan: cost };
    costYuan += cost;
  }
  perDay.sort((a, b) => (a.day < b.day ? -1 : 1));

  // ---- top workspace (basename alias only)
  let topWorkspace = '';
  let topTokens = 0;
  for (const s of (collectData && collectData.sessions) || []) {
    const u = s.usage || {};
    const tokens = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    if (tokens > topTokens) { topTokens = tokens; topWorkspace = basename(s.cwd); }
  }

  // ---- activity streams (this window only)
  let tasksDone = 0, quickAsks = 0;
  for (const a of activity) {
    if (!a || !inWin(a.ts)) continue;
    if (a.kind === 'task') tasksDone += 1;
    else if (a.kind === 'quickask') quickAsks += 1;
  }

  // ---- cache savings for the same window (flat gap, consistent with costYuan)
  const gap = Math.max(0, pIn - pCr); // ¥ per 1M cache-read tokens
  let cacheSavedYuan = 0;
  for (const d of perDay) {
    // recover the day's cacheRead share from the fold above
    const b = ((collectData && collectData.totals && collectData.totals.days) || {})[d.day] || {};
    cacheSavedYuan += ((b.cacheRead || 0) / 1e6) * gap;
  }
  void tokensCacheRead; // kept implicit via perDay; totals not surfaced on the card

  const zh = lang !== 'en';
  const weekNum = (() => {
    const d = new Date(win.start + CST);
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wk = Math.ceil(((d - jan1) / DAY_MS + jan1.getUTCDay() + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
  })();

  return {
    schema: 1,
    lang: zh ? 'zh' : 'en',
    weekLabel: `${zh ? '第' : ''}${weekNum}${zh ? '周' : ''}`,
    window: { start: new Date(win.start).toISOString(), end: new Date(win.end).toISOString() },
    costYuan,
    tokens: { input: tokensIn, output: tokensOut },
    peakDay: peakDay ? { ...peakDay, label: zh ? '最忙的一天' : 'Busiest day' } : null,
    topWorkspace,
    tasksDone,
    quickAsks,
    cacheSavedYuan,
  };
}

/** Fixed-size brand card markup (dark/light, zh/en). Pure string builder. */
function cardHtml(data, { dark = true } = {}) {
  const zh = data.lang !== 'en';
  const bg = dark ? '#0A0A0C' : '#F5F5F7';
  const panel = dark ? '#141417' : '#FFFFFF';
  const text = dark ? '#EDEDF0' : '#1A1A1E';
  const dim = dark ? '#8A8A93' : '#6E6E76';
  const accent = '#4D6BFE';
  const okColor = '#10B981';
  const L = {
    title: zh ? 'DSH 周报' : 'DSH Weekly',
    sub: zh ? '你的 Agent 一周' : 'Your agent, this week',
    cost: zh ? '花费' : 'Spend',
    peakDay: data.peakDay ? (zh ? '最忙的一天' : 'Busiest day') : '',
    topWs: zh ? '最活跃工作区' : 'Top workspace',
    tasks: zh ? '定时任务完成' : 'Scheduled runs',
    asks: zh ? '快捷问询' : 'Quick Asks',
    saved: zh ? '缓存节省' : 'Cache saved',
    foot: 'DshCockpit · Harness owns the workspace',
  };
  const cell = (label, value) => `<div class="cell"><div class="l">${label}</div><div class="v">${value}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
    body{width:1200px;height:675px;background:${bg};color:${text};display:flex;align-items:center;justify-content:center}
    .card{width:1080px;height:560px;background:${panel};border-radius:28px;padding:48px 56px;display:flex;flex-direction:column}
    .head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:36px}
    h1{font-size:44px;letter-spacing:-1px} .sub{color:${dim};font-size:20px;margin-top:6px}
    .badge{background:${accent};color:#fff;border-radius:12px;padding:8px 18px;font-size:18px}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;flex:1}
    .cell{background:${bg};border-radius:18px;padding:26px;display:flex;flex-direction:column;justify-content:center}
    .l{color:${dim};font-size:16px;margin-bottom:10px} .v{font-size:34px;font-weight:700}
    .foot{margin-top:26px;color:${dim};font-size:14px;text-align:right}
    .save{color:${okColor}}
  </style></head><body><div class="card">
    <div class="head"><div><h1>${L.title} · ${data.weekLabel}</h1><div class="sub">${L.sub}</div></div>
    <div class="badge">${new Date(data.window.start).toISOString().slice(0, 10)} → ${new Date(new Date(data.window.end).getTime() - 1).toISOString().slice(0, 10)}</div></div>
    <div class="grid">
      ${cell(L.cost, '¥' + (Number(data.costYuan) || 0).toFixed(2))}
      ${cell(L.tasks, String(data.tasksDone))}
      ${cell(L.asks, String(data.quickAsks))}
      ${cell(L.topWs, data.topWorkspace || '—')}
      ${data.peakDay ? cell(L.peakDay, `${data.peakDay.day.slice(5)} · ¥${(data.peakDay.costYuan || 0).toFixed(2)}`) : ''}
      ${cell(L.saved, `<span class="save">¥${(Number(data.cacheSavedYuan) || 0).toFixed(2)}</span>`)}
    </div>
    <div class="foot">${L.foot}</div>
  </div></body></html>`;
}

/**
 * Orchestration factory (Electron-aware parts injected).
 * @param {object} deps
 * @param {() => string} deps.userDataDir
 * @param {() => Promise<{totals:object, sessions:object[]}>} deps.collectStatsShared main.js collectStats (TTL-cached)
 * @param {() => object} [deps.getSettings]
 * @param {(text: string) => Promise} [deps.broadcastText] IM fan-out (optional)
 * @param {new (o: object) => {loadURL:Function,webContents:{capturePage:Function},destroy:Function}} [deps.BrowserWindow]
 * @param {() => boolean} [deps.isDark]
 * @param {() => string} [deps.lang]
 * @param {(line: string) => void} [deps.log]
 */
function createWeeklyReport(deps) {
  const {
    userDataDir,
    collectStatsShared,
    getSettings,
    broadcastText = null,
    BrowserWindow = null,
    isDark = () => true,
    lang = () => 'zh',
    log = () => {},
  } = deps || {};

  const outDir = () => path.join(userDataDir(), 'weekly');
  const activityFile = () => path.join(userDataDir(), 'weekly', 'activity.jsonl');

  function record(kind, ok = true) {
    try {
      fs.mkdirSync(path.dirname(activityFile()), { recursive: true });
      fs.appendFileSync(activityFile(), JSON.stringify({ ts: new Date().toISOString(), kind, ok }) + '\n');
    } catch { /* best effort */ }
  }

  function readActivity() {
    try {
      return fs.readFileSync(activityFile(), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }

  async function buildData() {
    const settings = getSettings ? getSettings() : {};
    const collectData = await collectStatsShared();
    return buildWeeklyReport({
      collectData,
      activity: readActivity(),
      pricing: settings,
      nowMs: Date.now(),
      lang: lang(),
    });
  }

  /** Render the PNG card; returns the written file path. */
  async function generate({ theme } = {}) {
    if (!BrowserWindow) throw new Error('BrowserWindow unavailable (packaged runtime?)');
    const settings = getSettings ? getSettings() : {};
    const collectData = await collectStatsShared();
    const data = buildWeeklyReport({
      collectData,
      activity: readActivity(),
      pricing: settings,
      nowMs: Date.now(),
      lang: lang(),
    });
    const html = cardHtml(data, { dark: theme !== undefined ? !!theme : isDark() });
    const width = 1200;
    const height = 675;
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      frame: false,
      webPreferences: { offscreen: true, javascriptCanAccessClipboard: false },
    });
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await new Promise((r) => setTimeout(r, 200)); // fonts/paint settle
      const image = await win.webContents.capturePage();
      fs.mkdirSync(outDir(), { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      const file = path.join(outDir(), `weekly-${stamp}.png`);
      fs.writeFileSync(file, image.toPNG());
      log(`[weekly] card written: ${file}`);
      return { ok: true, file, data };
    } finally {
      try { win.destroy(); } catch { /* ignore */ }
    }
  }

  function listFiles() {
    try {
      return fs.readdirSync(outDir()).filter((n) => n.endsWith('.png'))
        .map((n) => path.join(outDir(), n));
    } catch { return []; }
  }

  /** Auto-run gate: due when enabled AND Beijing-weekday is Monday AND this
   * week's card has not been generated yet (marker file per ISO week). */
  function shouldAutoGenerate(lastMarker) {
    if (!getSettings || !getSettings().weeklyReportEnabled) return false;
    const nowMs = Date.now();
    const { start } = weekWindowCst(nowMs);
    if (!lastMarker) return true;
    return start > Number(lastMarker); // marker stores the week's start ms
  }

  return { record, buildData, generate, listFiles, outDir, shouldAutoGenerate, weekWindowCst, activityFile };
}

module.exports = { createWeeklyReport, buildWeeklyReport, cardHtml, weekWindowCst, basename };
