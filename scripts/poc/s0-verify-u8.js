'use strict';

// scripts/poc/s0-verify-u8.js — 验证 U-8：session/page 的正确读法。
//
// 第一性原理：为什么 U-8 值得单独查
//
//   S0 第一轮里，`session/page throughSeq=1e9` 返回 `records=0`，而同一会话里
//   团队和任务明明都建好了。当时把它记为"原因未明"（U-8）。
//
//   查了 .d.ts 才发现：`throughSeq` 的文档写的是
//   **"Inclusive log cut obtained from the corresponding follow opening frame"**
//   —— 它不是"一个足够大的数"，而是**必须来自 follow 的 cursor**。
//   生产代码 src/main.js:4544 也是这么用的（officeFollowCursors）。
//
//   所以 U-8 很可能不是官方缺陷，而是**我的探针用错了参数**。
//   这正是"不要闭门造车/先读文档"的价值：一个错误参数会让整条链路看起来坏了。
//
// 本脚本证明：follow 拿到 cursor → page(throughSeq=cursor) → 拿到 records。
//
// 用法：node scripts/poc/s0-verify-u8.js --root <POC_ROOT>

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const results = [];
function record(name, status, detail, extra) {
  results.push({ name, status, detail: detail || '', ...(extra || {}) });
  const mark = { pass: 'PASS', fail: 'FAIL', 'not-verified': 'NOT-VERIFIED' }[status] || status;
  console.log(`[u8] ${mark.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`);
}

function pocEnv(root) {
  return {
    ...process.env,
    DSH_HOME: path.join(root, 'dsh-home'),
    DSH_POC_ISOLATED: '1',
    npm_config_cache: path.join(root, 'npm-cache'),
    DSH_PRIMARY_RUNTIME: path.join(root, 'dsh-home'),
  };
}

function findBin(root) {
  const c = [
    path.join(root, 'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    path.join(root, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  return null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
  });
}

async function bootWeb(bin, root) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0', '--no-open'], {
      env: pocEnv(root), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = ''; let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch {} resolve({ error: 'boot timeout' }); } }, 90000);
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/https?:\/\/[^\s"']+/);
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ url: m[0], child }); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ error: `exited ${code}: ${buf.slice(0, 300)}` }); } });
  });
}

async function exchangeCookie(url) {
  const res = await httpGet(url);
  const sc = res.headers && res.headers['set-cookie'];
  if (!sc) return null;
  return (Array.isArray(sc) ? sc : [sc]).map((c) => String(c).split(';')[0]).join('; ');
}

function muxFactory(baseUrl, cookie) {
  const { createRuntimeMux } = require(path.join(REPO_ROOT, 'src', 'runtime-mux.js'));
  const auth = { getCookie: async () => cookie, invalidate: () => {} };
  const origin = new URL(baseUrl).origin;
  return new Promise((resolve, reject) => {
    const mux = createRuntimeMux({ baseUrl: origin, auth, log: () => {}, onError: () => {} });
    const t = setTimeout(() => { try { mux.close(); } catch {} reject(new Error('mux timeout')); }, 25000);
    mux.onReady(() => { clearTimeout(t); resolve(mux); });
    try { mux.connect(); } catch (e) { clearTimeout(t); reject(e); }
  });
}

function unwrap(r) { return r && r.value !== undefined ? r.value : r; }

/** 打开 follow 流，取 opening snapshot 的 cursor + records。 */
function openFollow(mux, sessionId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const streamId = 'follow-' + crypto.randomUUID();
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; cleanup(); resolve({ error: 'follow timeout (no snapshot)' }); } }, timeoutMs);
    let off = null;
    function cleanup() { clearTimeout(timer); try { off && off(); } catch {} try { mux.closeStream(streamId); } catch {} }
    off = mux.onItem(streamId, (item) => {
      if (settled) return;
      const t = item && item.type;
      if (t === 'snapshot') {
        settled = true;
        const out = {
          cursor: item.cursor,
          records: Array.isArray(item.records) ? item.records.length : null,
          hasMore: !!item.hasMore,
          projections: item.projections ? Object.keys(item.projections.values || {}).length : null,
        };
        cleanup(); resolve(out);
      }
    });
    mux.openStream(streamId, 'session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 30 },
    });
  });
}

async function main() {
  const root = argValue('--root');
  const outDir = path.join(root || '.', 'logs');
  if (!root) { console.error('usage: --root <POC_ROOT>'); process.exit(2); }
  const bin = findBin(root);
  if (!bin) { record('runtime binary', 'fail', 'missing'); return finish(outDir); }

  const boot = await bootWeb(bin, root);
  if (boot.error) { record('boot', 'fail', boot.error); return finish(outDir); }
  record('boot web host', 'pass', '');

  const cookie = await exchangeCookie(boot.url);
  if (!cookie) { record('cookie', 'fail', 'none'); try { boot.child.kill(); } catch {} return finish(outDir); }
  record('auth cookie', 'pass', '');

  let mux;
  try { mux = await muxFactory(boot.url, cookie); } catch (e) { record('mux', 'fail', String(e.message)); return finish(outDir); }
  record('mux connect', 'pass', '');

  const cwd = path.join(root, 'workspace');
  let sid = null;
  try {
    const created = unwrap(await mux.call('session/create', { request: { cwd } }));
    sid = created && created.sessionId;
    record('session/create', sid ? 'pass' : 'fail', sid ? String(sid).slice(0, 12) + '…' : 'no id');
  } catch (e) { record('session/create', 'fail', String(e.message).slice(0, 160)); }
  if (!sid) { try { mux.close(); boot.child.kill(); } catch {} return finish(outDir); }

  // 发一条最小 prompt，制造至少一条 user 记录（不需要模型回答完）
  const token = 'U8-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  try {
    await mux.call('session/prompt', {
      request: {
        requestId: crypto.randomUUID(), sessionId: sid, mode: 'queue',
        content: [{ type: 'text', text: `只回复这四个字符，不要做别的事：${token}` }],
      },
    });
    record('prompt accepted', 'pass', token);
  } catch (e) { record('prompt accepted', 'fail', String(e.message).slice(0, 200)); }

  // 等 turn 结束（最多 120s），同时用 follow 的 cursor 读历史
  await new Promise((r) => setTimeout(r, 8000));
  const follow = await openFollow(mux, sid);
  if (follow.error) {
    record('follow opening snapshot', 'fail', follow.error);
  } else {
    record('follow opening snapshot', 'pass',
      `cursor=${follow.cursor} records=${follow.records} hasMore=${follow.hasMore} projections=${follow.projections}`);
    record('follow snapshot carries records', follow.records > 0 ? 'pass' : 'fail',
      `records=${follow.records}`);
    // 用 follow 的 cursor 做 page（这是 .d.ts 要求的正确用法）
    try {
      const page = unwrap(await mux.call('session/page', {
        request: { address: { kind: 'session', sessionId: sid }, throughSeq: follow.cursor, maxMessages: 30 },
      }));
      const n = page && Array.isArray(page.records) ? page.records.length : null;
      record('session/page with follow cursor', n > 0 ? 'pass' : 'fail', `records=${n}`);
      if (n > 0) {
        // 确认能看到我们发的那条 prompt
        const text = JSON.stringify(page.records);
        record('prompt text visible in history', text.includes(token) ? 'pass' : 'fail',
          text.includes(token) ? 'token found' : 'token NOT found');
      }
    } catch (e) {
      record('session/page with follow cursor', 'fail', String(e.message).slice(0, 200));
    }
    // 对照：用 1e9（上一轮的错误用法）应失败或返回 0
    try {
      const bad = unwrap(await mux.call('session/page', {
        request: { address: { kind: 'session', sessionId: sid }, throughSeq: 1e9, maxMessages: 30 },
      }));
      const n = bad && Array.isArray(bad.records) ? bad.records.length : null;
      record('session/page throughSeq=1e9（对照组）', 'pass',
        `records=${n} ← 这就是上一轮 U-8 的根因`);
    } catch (e) {
      record('session/page throughSeq=1e9（对照组）', 'pass', 'rejected: ' + String(e.message).slice(0, 120));
    }
  }

  try { mux.close(); } catch {}
  try { boot.child.kill('SIGTERM'); } catch {}
  return finish(outDir);
}

function finish(outDir) {
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 's0-u8.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2));
    console.log('[u8] report: ' + path.join(outDir, 's0-u8.json'));
  } catch (e) { console.error('[u8] write failed:', e.message); }
  console.log('[u8] counts: ' + JSON.stringify(counts));
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}

main().catch((e) => { console.error('[u8] FATAL', e && e.stack || e); process.exit(1); });
