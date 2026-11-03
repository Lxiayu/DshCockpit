'use strict';
// scripts/poc/s0-verify-restart.js — 验证团队状态能否跨运行时重启恢复（S0，U-9）。
//
// 第一性原理：为什么"重启后还在"是常驻团队的前提
//
//   我们的产品承诺是"团队长期存在"。如果团队的 roster 与任务板只活在
//   进程内存里，那么用户关一次 app、或者 runtime 崩一次，团队就凭空消失 ——
//   那"长期"二字就是谎话。
//
//   官方 README 说这需要 durable session storage（dsh-session-persistence-jsonl），
//   并且 roster 与 task board 是 durable 的。但**声明 ≠ 实测**，
//   本项目已经多次遇到"声明比实际宽"（TeamMemberView、permissions 投影）。
//
//   探针做两件事：
//     1. 第一次启动：建团队 + 建任务 + 记下 sessionId
//     2. 杀掉进程、用同一个 DSH_HOME 重启、重新读该 session 的 agentTeam
//   如果成员与任务都还在，durable 成立。
//
// 用法：node scripts/poc/s0-verify-restart.js --root <POC_ROOT>

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..', '..');
const ROOT = (() => {
  const i = process.argv.indexOf('--root');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
if (!ROOT) { console.error('usage: --root <POC_ROOT>'); process.exit(2); }

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail: detail || '' });
  const mark = { pass: 'PASS', fail: 'FAIL', 'not-verified': 'NOT-VERIFIED' }[status] || status;
  console.log(`[u9] ${mark.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`);
}

function env() {
  return {
    ...process.env,
    DSH_HOME: path.join(ROOT, 'dsh-home'),
    DSH_POC_ISOLATED: '1',
    npm_config_cache: path.join(ROOT, 'npm-cache'),
    DSH_PRIMARY_RUNTIME: path.join(ROOT, 'dsh-home'),
  };
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
  });
}

function bootWeb() {
  const bin = path.join(ROOT, 'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0', '--no-open'], {
      env: env(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve({ error: 'boot timeout' }); }
    }, 90000);
    const onData = (c) => {
      buf += String(c);
      const m = buf.match(/https?:\/\/[^\s"']+/);
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ url: m[0], child }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ error: `exited ${code}` }); }
    });
  });
}

async function connect(url) {
  const res = await httpGet(url);
  const sc = res.headers && res.headers['set-cookie'];
  if (!sc) return null;
  const cookie = (Array.isArray(sc) ? sc : [sc]).map((c) => String(c).split(';')[0]).join('; ');
  const { createRuntimeMux } = require(path.join(REPO, 'src', 'runtime-mux.js'));
  const mux = await new Promise((resolve, reject) => {
    const m = createRuntimeMux({
      baseUrl: new URL(url).origin,
      auth: { getCookie: async () => cookie, invalidate: () => {} },
      log: () => {}, onError: () => {},
    });
    const t = setTimeout(() => reject(new Error('mux timeout')), 25000);
    m.onReady(() => { clearTimeout(t); resolve(m); });
    m.connect();
  });
  return mux;
}

function unwrap(r) { return r && r.value !== undefined ? r.value : r; }

async function teamOf(mux, sid) {
  const p = unwrap(await mux.call('session/projections', { request: { sessionId: sid } }));
  return (p && p.values && p.values.agentTeam) || null;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

(async () => {
  // ---------- 阶段 1：建团队 ----------
  const boot1 = await bootWeb();
  if (boot1.error) { record('first boot', 'fail', boot1.error); return finish(); }
  let mux1;
  try { mux1 = await connect(boot1.url); } catch (e) { record('first mux', 'fail', String(e.message)); return finish(); }
  record('first boot', 'pass', '');

  const sid = unwrap(await mux1.call('session/create', { request: { cwd: path.join(ROOT, 'workspace') } })).sessionId;
  record('session created', 'pass', String(sid).slice(0, 14) + '…');

  const member = 'restartprobe';
  const subject = 'restart-task-' + crypto.randomBytes(2).toString('hex');
  await mux1.call('session/prompt', {
    request: {
      requestId: crypto.randomUUID(), sessionId: sid, mode: 'queue',
      content: [{ type: 'text', text:
        `用 spawn_teammate 创建一个 teammate 名字必须是 ${member}，描述为"重启恢复测试"。`
        + `然后用 team_task_create 创建一个任务，subject 必须是 "${subject}"。完成后汇报。` }],
    },
  });
  const before = await waitFor(async () => {
    const t = await teamOf(mux1, sid);
    if (!t) return null;
    const hasMember = (t.members || []).some((m) => m.name === member);
    const hasTask = (t.tasks || []).some((x) => String(x.subject).includes(subject));
    return (hasMember && hasTask) ? t : null;
  }, 300000);
  if (!before) {
    record('team created before restart', 'not-verified', 'member or task not observed — cannot test persistence');
    try { mux1.close(); } catch { /* */ }
    try { boot1.child.kill(); } catch { /* */ }
    return finish();
  }
  record('team created before restart', 'pass',
    `members=${before.members.length} tasks=${before.tasks.length}`);

  // ---------- 阶段 2：杀掉运行时 ----------
  try { mux1.close(); } catch { /* */ }
  await new Promise((resolve) => {
    let done = false;
    boot1.child.on('exit', () => { done = true; resolve(); });
    try { boot1.child.kill('SIGTERM'); } catch { /* */ }
    setTimeout(() => { if (!done) { try { boot1.child.kill('SIGKILL'); } catch { /* */ } resolve(); } }, 15000);
  });
  record('runtime stopped', 'pass', 'SIGTERM (then SIGKILL if needed)');

  // ---------- 阶段 3：用同一个 DSH_HOME 重启，读同一 session ----------
  const boot2 = await bootWeb();
  if (boot2.error) { record('second boot', 'fail', boot2.error); return finish(); }
  let mux2;
  try { mux2 = await connect(boot2.url); } catch (e) { record('second mux', 'fail', String(e.message)); return finish(); }
  record('second boot (same DSH_HOME)', 'pass', '');

  // 重启后 session 是否还在列表里
  let listed = false;
  try {
    const l = unwrap(await mux2.call('session/list', { _request: {} }));
    const items = (l && l.items) || [];
    listed = items.some((x) => x && x.sessionId === sid);
  } catch { /* */ }
  record('session survives restart', listed ? 'pass' : 'not-verified',
    listed ? 'session is in session/list' : 'session not listed (may still be readable by id)');

  const after = await waitFor(async () => {
    const t = await teamOf(mux2, sid);
    return t || null;
  }, 60000);

  if (!after) {
    record('agentTeam readable after restart', 'fail', 'projection unavailable for the same session');
  } else {
    record('agentTeam readable after restart', 'pass', JSON.stringify(after).slice(0, 200));
    const hasMember = (after.members || []).some((m) => m.name === member);
    const hasTask = (after.tasks || []).some((x) => String(x.subject).includes(subject));
    record('teammate survived restart', hasMember ? 'pass' : 'fail',
      hasMember ? `${member} still in roster` : `${member} missing after restart`);
    record('task board survived restart', hasTask ? 'pass' : 'fail',
      hasTask ? `${subject} still on board` : `${subject} missing after restart`);
  }

  try { mux2.close(); } catch { /* */ }
  try { boot2.child.kill(); } catch { /* */ }
  return finish();
})().catch((e) => { console.error('[u9] FATAL', e && e.stack || e); process.exit(1); });

function finish() {
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  try {
    const dir = path.join(ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's0-restart.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2));
    console.log('[u9] report: ' + path.join(dir, 's0-restart.json'));
  } catch (e) { console.error('[u9] write failed:', e.message); }
  console.log('[u9] counts: ' + JSON.stringify(counts));
  process.exit(0);
}
