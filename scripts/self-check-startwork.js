'use strict';
// 「交给团队」真实链路自检（在应用**外部**跑，用独立 runtime）
//
// 第一性原理：前面所有验收都是"UI fixture"，证明不了"Agent 真的动了"。
// 这个脚本用真实 runtime + 真实凭据，端到端验证：
//   session/create → session/prompt → agent 真的产生 turn
//
// 注意：它启动的是**独立 runtime**（隔离 DSH_HOME），
// 不会干扰正在运行的 DshCockpit。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const REPO = path.join(__dirname, '..');
const RT = path.join(os.homedir(),
  'Library/Application Support/dsh-cockpit/runtime/0.2.1-rc.5');
const BIN = path.join(RT, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const REAL_HOME = path.join(os.homedir(), '.dsh');

const results = [];
let failed = 0;
const rec = (n, ok, d) => {
  results.push({ n, ok: !!ok, d: String(d || '') });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'swcheck-'));
  for (const f of ['.credentials.yaml', 'settings.yaml', 'settings.yaml.imported']) {
    try { fs.copyFileSync(path.join(REAL_HOME, f), path.join(HOME, f)); } catch { /* optional */ }
  }
  const PROF = path.join(HOME, 'profiles', 'web');
  fs.mkdirSync(PROF, { recursive: true });
  fs.writeFileSync(path.join(PROF, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2));
  try { fs.symlinkSync(path.join(RT, 'node_modules'), path.join(HOME, 'node_modules'), 'dir'); } catch { /* exists */ }

  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'swws-'));
  fs.mkdirSync(path.join(WS, '.git'));
  const logFile = path.join(WS, 'dsh.log');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [BIN, '--profile', 'web', '--port', '0', '--no-open'],
    { env: { ...process.env, DSH_HOME: HOME }, cwd: WS, stdio: ['ignore', fd, fd] });

  const cleanup = () => { try { child.kill(); } catch { /* gone */ } };
  process.on('exit', cleanup);

  let url = null;
  for (let i = 0; i < 120 && !url; i += 1) {
    await sleep(500);
    try {
      const t = fs.readFileSync(logFile, 'utf8');
      const m = t.match(/dsh web: (\S+)/);
      if (m) url = m[1].replace(/[),.]+$/, '');
    } catch { /* not ready */ }
  }
  rec('isolated runtime boots', !!url);
  if (!url) { cleanup(); process.exit(1); }

  const base = url.replace(/\/\?.*$/, '').replace(/\/+$/, '');
  const { createRuntimeAuth } = require(path.join(REPO, 'src', 'runtime-auth.js'));
  const auth = createRuntimeAuth({ log: () => {} });
  auth.setAuthUrl(url);
  const cookie = await auth.getCookie();
  rec('authenticated', !!cookie);

  const rpc = async (method, args) => {
    const res = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    });
    const t = await res.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* non-json */ }
    return { ok: res.status === 200 && j && j.result && j.result.ok === true,
      value: j && j.result && j.result.value, err: j && j.result && j.result.error };
  };

  // ★ 这两步就是 missionEnsureSession + missionPromptSession 的真实实现
  const c = await rpc('session/create', { request: {} });
  rec('session/create (what startWork calls first)', c.ok,
    c.ok ? c.value.sessionId.slice(0, 16) : (c.err && c.err.message));
  if (!c.ok) { cleanup(); process.exit(1); }
  const sid = c.value.sessionId;

  const prompt = '【Mission】链接验证\n目标：确认「交给团队」能把工作真的送到 Agent\n\n'
    + '【本次任务】\n只回复两个字：收到';
  const pr = await rpc('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId: sid, mode: 'queue',
      content: [{ type: 'text', text: prompt }] },
  });
  rec('session/prompt (what startWork calls second)', pr.ok,
    pr.ok ? 'accepted' : (pr.err && pr.err.message));

  // ★ 关键：证明 Agent 真的动了，而不是"prompt 被接受但没人理"
  console.log('等待 agent 产生 turn…');
  let saw = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(3000);
    const pj = await rpc('session/projections', { request: { sessionId: sid } });
    if (!pj.ok) continue;
    const v = pj.value.values || {};
    const stats = v.sessionStats || {};
    const turns = Number.isFinite(stats.turns) ? stats.turns : 0;
    const steps = Number.isFinite(stats.steps) ? stats.steps : 0;
    if (i % 4 === 0) console.log(`  [${(i + 1) * 3}s] turns=${turns} steps=${steps}`);
    if (turns > 0) {
      rec('the agent ACTUALLY produced a finished turn', true, `turns=${turns} steps=${steps}`);
      saw = true;
      break;
    }
  }
  if (!saw) rec('the agent ACTUALLY produced a finished turn', false, 'timeout');

  const final = await rpc('session/projections', { request: { sessionId: sid } });
  const fin = final.ok ? (final.value.values || {}) : {};
  const st = fin.sessionStats || {};
  rec('workStatus would report turns/steps', Number.isFinite(st.turns),
    `turns=${st.turns} steps=${st.steps}`);

  fs.writeFileSync(path.join(os.tmpdir(), 'startwork-selfcheck.json'),
    JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('crashed:', e && e.stack || e); process.exit(1); });
