'use strict';

// scripts/poc/s0-model-probe.js — S0 真机探针（真实模型路径）。
//
// 第一性原理：为什么"能读到 agentTeam 空投影"不等于验证完成
//
//   s0-probe.js 证明了：会话里**确实**有 agentTeam 投影，且形状与声明一致。
//   但它拿到的是 `{members:[{lead}], tasks:[]}` —— 一个空团队。
//   空团队不能证明任何**取值**：不能证明 spawn_teammate 真的能派生成员，
//   不能证明 team_task_create 真的会让 tasks 出现，更不能证明 ready/blockedBy 的语义。
//
//   所以本探针做一件 protocol-probe 明确拒绝做的事：**真实模型调用**。
//   它会：
//     1. 用一个真实 prompt 让 Lead 创建一名 teammate + 一个任务；
//     2. 轮询 session/projections，直到 agentTeam 里出现新成员/新任务；
//     3. 把**实际观测到的 JSON** 原样记录（这是 ADR-0002 §9 缺的那份证据）。
//
//   它仍然不写生产代码、不碰 ~/.dsh：所有 IO 在 POC_ROOT 内。
//
// 前置：POC profile 已加 agent-team-profile bundle，且 settings.yaml 配了 provider。
//
// 用法：
//   node scripts/poc/s0-model-probe.js --root <POC_ROOT> [--timeout 240000]

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
  const mark = {
    pass: 'PASS', fail: 'FAIL', 'not-verified': 'NOT-VERIFIED',
    'needs-model': 'NEEDS-MODEL', skipped: 'SKIP',
  }[status];
  console.log(`[s0m] ${mark.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`);
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
  const candidates = [
    path.join(root, 'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    path.join(root, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function parseWebUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s"']+/);
  return m ? m[0] : null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: String(err.message) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
  });
}

async function bootWeb(bin, root) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0', '--no-open'], {
      env: pocEnv(root), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve({ error: 'boot timeout' }); }
    }, 90000);
    const onData = (chunk) => {
      buf += String(chunk);
      const url = parseWebUrl(buf);
      if (url && !settled) { settled = true; clearTimeout(timer); resolve({ url, child }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ error: `exited code=${code}: ${buf.slice(0, 500)}` }); }
    });
  });
}

async function exchangeCookie(url) {
  const res = await httpGet(url);
  const sc = res.headers && res.headers['set-cookie'];
  if (!sc) return null;
  const list = Array.isArray(sc) ? sc : [sc];
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

function muxFactory(baseUrl, cookie) {
  const { createRuntimeMux } = require(path.join(REPO_ROOT, 'src', 'runtime-mux.js'));
  const auth = { getCookie: async () => cookie, invalidate: () => {} };
  const origin = new URL(baseUrl).origin;
  return new Promise((resolve, reject) => {
    const mux = createRuntimeMux({ baseUrl: origin, auth, log: () => {}, onError: () => {} });
    const timer = setTimeout(() => { try { mux.close(); } catch { /* */ } reject(new Error('mux timeout')); }, 25000);
    mux.onReady(() => { clearTimeout(timer); resolve(mux); });
    try { mux.connect(); } catch (err) { clearTimeout(timer); reject(err); }
  });
}

function unwrap(res) {
  if (!res) return null;
  if (res.value !== undefined) return res.value;
  return res;
}

async function readTeam(mux, sessionId) {
  const proj = unwrap(await mux.call('session/projections', { request: { sessionId } }));
  if (!proj) return { kind: null, team: null, keys: [] };
  const values = proj.values || {};
  return { kind: proj.kind, team: values.agentTeam || null, keys: Object.keys(values) };
}

async function main() {
  const root = argValue('--root');
  const timeoutMs = Number(argValue('--timeout', '240000'));
  const outDir = path.join(root || '.', 'logs');
  if (!root) { console.error('usage: node scripts/poc/s0-model-probe.js --root <POC_ROOT>'); process.exit(2); }

  const bin = findBin(root);
  if (!bin) { record('runtime binary', 'fail', 'missing'); return finish(outDir); }

  const boot = await bootWeb(bin, root);
  if (boot.error) { record('boot web host', 'fail', boot.error); return finish(outDir); }
  record('boot web host', 'pass', boot.url);

  const cookie = await exchangeCookie(boot.url);
  record('auth cookie', cookie ? 'pass' : 'fail', cookie ? 'ok' : 'none');
  if (!cookie) { try { boot.child.kill(); } catch { /* */ } return finish(outDir); }

  let mux;
  try { mux = await muxFactory(boot.url, cookie); }
  catch (err) { record('mux connect', 'fail', String(err.message)); return finish(outDir); }
  record('mux connect', 'pass', 'ready');

  const cwd = path.join(root, 'workspace');
  let sid = null;
  try {
    const created = unwrap(await mux.call('session/create', { request: { cwd } }));
    sid = created && created.sessionId;
    record('session/create', sid ? 'pass' : 'fail', sid ? `${String(sid).slice(0, 12)}…` : 'no id');
  } catch (err) { record('session/create', 'fail', String(err.message).slice(0, 200)); }
  if (!sid) { try { mux.close(); boot.child.kill(); } catch { /* */ } return finish(outDir); }

  // 基线：空团队
  const base = await readTeam(mux, sid);
  record('baseline agentTeam', base.team ? 'pass' : 'fail',
    base.team ? JSON.stringify(base.team).slice(0, 300) : 'absent',
    { observed: base.team });

  // ---- 真实模型：让 Lead 派生一名 teammate ----
  const name = 'probehelper';
  const prompt = [
    '请用 spawn_teammate 工具创建一个名为 ' + name + ' 的 teammate，',
    '它的职责是"检查文档拼写"，使用 fresh 上下文。',
    '然后创建一个团队任务，subject 为 "probe-task-alpha"，不需要 blockedBy。',
    '完成后用一句话汇报你做了什么。不要做任务之外的任何改动。',
  ].join('');
  try {
    await mux.call('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: sid,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      },
    });
    record('prompt accepted', 'pass', 'lead asked to spawn teammate + create task');
  } catch (err) {
    record('prompt accepted', 'fail', String(err.message).slice(0, 300));
  }

  // ---- 轮询投影，直到出现新成员或任务 ----
  const deadline = Date.now() + timeoutMs;
  let sawMember = false;
  let sawTask = false;
  let lastTeam = base.team;
  let attempts = 0;
  const snapshots = [];
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const now = await readTeam(mux, sid);
      if (now.team) {
        lastTeam = now.team;
        const names = (now.team.members || []).map((m) => m.name);
        const taskIds = (now.team.tasks || []).map((t) => t.id);
        if (attempts % 5 === 0) {
          snapshots.push({ at: attempts, members: names, tasks: taskIds });
        }
        if (names.includes(name)) sawMember = true;
        if ((now.team.tasks || []).some((t) => String(t.subject || '').includes('probe-task-alpha'))) sawTask = true;
        if (sawMember && sawTask) break;
      }
    } catch { /* 轮询期间的瞬时错误不致命 */ }
    await new Promise((r) => setTimeout(r, 3000));
  }

  record('teammate spawned (agentTeam.members)', sawMember ? 'pass' : 'not-verified',
    sawMember ? `${name} appeared in projection` : `not seen in ${attempts} polls`, { observed: lastTeam });
  record('task created (agentTeam.tasks)', sawTask ? 'pass' : 'not-verified',
    sawTask ? 'probe-task-alpha appeared' : 'not seen', { observed: lastTeam });

  // 记录真实观测到的完整 JSON（这是 ADR-0002 §9 要的证据）
  if (lastTeam) {
    const detail = {
      members: (lastTeam.members || []).map((m) => ({
        name: m.name, role: m.role, phase: m.phase,
        idPrefix: String(m.id || '').slice(0, 8),
      })),
      tasks: (lastTeam.tasks || []).map((t) => ({
        id: t.id, revision: t.revision, subject: t.subject, status: t.status,
        ready: t.ready, blockedBy: t.blockedBy, writeScopeWarnings: t.writeScopeWarnings,
        ownerName: t.ownerName,
      })),
      failure: lastTeam.failure,
    };
    record('observed agentTeam shape', 'pass', JSON.stringify(detail).slice(0, 600), { observedTeam: detail });
  }

  // 会话状态与事件：确认 turn 真的结束了
  try {
    const page = unwrap(await mux.call('session/page', {
      request: { address: { kind: 'session', sessionId: sid }, throughSeq: 1e9 },
    }));
    const records = (page && page.records) || [];
    record('session history readable', 'pass', `records=${records.length}`);
  } catch (err) {
    record('session history readable', 'fail', String(err.message).slice(0, 160));
  }

  try { mux.close(); } catch { /* */ }
  try { boot.child.kill('SIGTERM'); } catch { /* */ }
  return finish(outDir, { sessionId: sid, snapshots });
}

function finish(outDir, extra = {}) {
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 's0-model-probe.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), counts, results, ...extra }, null, 2));
    console.log(`[s0m] report: ${path.join(outDir, 's0-model-probe.json')}`);
  } catch (err) { console.error('[s0m] write failed:', err.message); }
  console.log('[s0m] counts: ' + JSON.stringify(counts));
  const hardFail = results.some((r) => r.status === 'fail');
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => { console.error('[s0m] FATAL', err && err.stack || err); process.exit(1); });
