'use strict';

// scripts/poc/s0-probe.js — S0 真机探针：官方 Agent Team 的真实行为。
//
// 第一性原理：为什么必须"先探再建"
//
//   我们的计划（docs/plans/active/NEW-DIRECTION-PERSONAL-TEAM-2026-11-03.md）
//   有一半的设计建立在"官方 Agent Team 能做什么"之上。但截至 2026-11-03，
//   这些能力**一个都没在真实模型下验证过**（ADR-0002 §11 自己就是这么写的）。
//
//   protocol-probe.js 已经证明"装得上、起得来、RPC 通"，但它明确不做
//   "需要真实模型调用"的部分。S0 要补的正是那一段。
//
//   本探针只回答一个问题：**在不调用模型的前提下，能从官方拿到的团队事实有多少？**
//   有模型的检查单独标记为 needs-model，绝不把"没跑"写成"通过"
//   （四态纪律，与 scripts/ci-gate.js 一致）。
//
// 隔离：全部 IO 落在 POC_ROOT 内，不碰 ~/.dsh 与仓库。
//
// 用法：
//   node scripts/poc/s0-probe.js --root <POC_ROOT> --out <dir>

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const results = [];
/** status ∈ pass | fail | not-verified | needs-model | skipped */
function record(name, status, detail, extra) {
  results.push({ name, status, detail: detail || '', ...(extra || {}) });
  const mark = {
    pass: 'PASS', fail: 'FAIL', 'not-verified': 'NOT-VERIFIED',
    'needs-model': 'NEEDS-MODEL', skipped: 'SKIP',
  }[status];
  console.log(`[s0] ${mark.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`);
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
  try {
    const real = fs.realpathSync(path.join(root, 'runtime'));
    const p = path.join(real, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    if (fs.existsSync(p)) return p;
  } catch { /* not a symlink */ }
  return null;
}

function runNode(bin, args, root, timeoutMs = 90000) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [bin, ...args], {
    env: pocEnv(root), encoding: 'utf8', timeout: timeoutMs,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
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

/** 启动 web host，返回 { url, child } 或 { error }。 */
async function bootWeb(bin, root) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0', '--no-open'], {
      env: pocEnv(root), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve({ error: 'boot timeout (no url in 60s)' }); }
    }, 60000);
    const onData = (chunk) => {
      buf += String(chunk);
      const url = parseWebUrl(buf);
      if (url && !settled) {
        settled = true; clearTimeout(timer); resolve({ url, child });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ error: `exited early code=${code} out=${buf.slice(0, 400)}` }); }
    });
  });
}

/** 用 token URL 换 cookie（与 protocol-probe 同一路径）。 */
async function exchangeCookie(url) {
  const res = await httpGet(url);
  const setCookie = res.headers && res.headers['set-cookie'];
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

/** 用 runtime-mux 调 unary RPC。 */
function muxCallFactory(baseUrl, cookie) {
  const { createRuntimeMux } = require(path.join(REPO_ROOT, 'src', 'runtime-mux.js'));
  const auth = { getCookie: async () => cookie, invalidate: () => {} };
  const u = new URL(baseUrl);
  const origin = u.origin;
  return new Promise((resolve, reject) => {
    const mux = createRuntimeMux({ baseUrl: origin, auth, log: () => {}, onError: () => {} });
    const timer = setTimeout(() => { try { mux.close(); } catch { /* */ } reject(new Error('mux timeout')); }, 25000);
    mux.onReady(() => { clearTimeout(timer); resolve({ mux }); });
    try { mux.connect(); } catch (err) { clearTimeout(timer); reject(err); }
  });
}

async function main() {
  const root = argValue('--root');
  const outDir = argValue('--out', path.join(root || '.', 'logs'));
  if (!root) { console.error('usage: node scripts/poc/s0-probe.js --root <POC_ROOT>'); process.exit(2); }

  // ---- T0：环境 ----
  const bin = findBin(root);
  if (!bin) { record('runtime binary present', 'fail', `no dsh bin.js under ${root}`); return finish(outDir); }
  record('runtime binary present', 'pass', bin);
  const ver = runNode(bin, ['--version'], root, 30000);
  record('runtime version', ver.code === 0 ? 'pass' : 'fail', String(ver.stdout || ver.stderr).trim().split('\n').pop());

  // ---- 能力包是否随该版本安装 ----
  const nm = path.join(path.dirname(path.dirname(bin)), ''); // .../@deepseek-ai/dsh/lib -> up
  let pkgDir = null;
  try {
    const realBin = fs.realpathSync(bin);
    pkgDir = path.join(realBin.split('/lib/')[0], '');
    // bin 的 package 是 dsh 本体；@deepseek-ai 目录在 node_modules 下
  } catch { /* */ }
  const scoped = (() => {
    try {
      const realBin = fs.realpathSync(bin);
      const idx = realBin.indexOf('/node_modules/@deepseek-ai/');
      return idx === -1 ? null : realBin.slice(0, idx + '/node_modules/@deepseek-ai'.length);
    } catch { return null; }
  })();
  const required = [
    'dsh-experimental-agent-team',
    'dsh-experimental-tool-agent-team',
    'dsh-experimental-agent-team-profile',
    'dsh-user-questions',
    'dsh-user-approval',
    'dsh-workspace-changes',
    'dsh-permission-presets',
    'dsh-fs-observation-policy',
  ];
  if (scoped) {
    for (const name of required) {
      const present = fs.existsSync(path.join(scoped, name));
      record(`package: ${name}`, present ? 'pass' : 'fail', present ? 'present' : 'MISSING');
    }
  } else {
    record('scoped package dir resolvable', 'fail', `cannot resolve @deepseek-ai dir from ${bin}`);
  }

  // ---- 静态类型事实：agentTeam projection 的形状（读 .d.ts，不猜） ----
  if (scoped) {
    const projDts = path.join(scoped, 'dsh-experimental-agent-team/lib/types/types.d.ts');
    const idxDts = path.join(scoped, 'dsh-experimental-agent-team/lib/types/index.d.ts');
    if (fs.existsSync(projDts)) {
      const text = fs.readFileSync(projDts, 'utf8');
      record('agentTeam projection declared', text.includes('agentTeam') ? 'pass' : 'fail',
        'TeamProjection in SessionProjectionMap');
      const hasMembers = /members:\s*TeamMemberProjection\[\]/.test(text);
      const hasTasks = /tasks:\s*TeamTaskView\[\]/.test(text);
      const hasFailure = /failure\?:\s*string/.test(text);
      record('TeamProjection = {members, tasks, failure}', hasMembers && hasTasks && hasFailure ? 'pass' : 'fail',
        `members=${hasMembers} tasks=${hasTasks} failure=${hasFailure}`);
      const viewOk = /ready:\s*boolean/.test(text) && /writeScopeWarnings:\s*string\[\]/.test(text);
      record('TeamTaskView has ready + writeScopeWarnings', viewOk ? 'pass' : 'fail', '');
    } else {
      record('agent-team types present', 'fail', 'types.d.ts missing');
    }
    if (fs.existsSync(idxDts)) {
      const idx = fs.readFileSync(idxDts, 'utf8');
      const methods = ['spawnTeammate', 'sendMessage', 'createTask', 'updateTask', 'listTasks', 'listMembers', 'interrupt', 'waitForChange'];
      const missing = methods.filter((m) => !idx.includes(m));
      record('TeamService method surface', missing.length === 0 ? 'pass' : 'fail',
        missing.length ? `missing: ${missing.join(', ')}` : methods.join(', '));
    }
    // 关键：agent-team 是否有 remote 表面（决定我们能否从壳里直接调用）
    const teamLib = path.join(scoped, 'dsh-experimental-agent-team/lib');
    let hasRemote = false;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.js')) {
          const t = fs.readFileSync(f, 'utf8');
          if (/typert|RemoteMethod|registerRemote|remote-method/i.test(t)) hasRemote = true;
        }
      }
    };
    try { walk(teamLib); } catch { /* */ }
    record('agent-team exposes a remote RPC surface', hasRemote ? 'pass' : 'fail',
      hasRemote ? 'found remote machinery' : 'NO remote surface — 壳只能读 projection，不能直接调 TeamService');
  }

  // ---- 运行时：session/projections 能否读到 agentTeam ----
  record('boot web host', 'skipped', 'starting…');
  const boot = await bootWeb(bin, root);
  if (boot.error) {
    record('boot web host', 'fail', boot.error);
    return finish(outDir);
  }
  record('boot web host', 'pass', boot.url);
  const cookie = await exchangeCookie(boot.url);
  record('auth cookie exchange', cookie ? 'pass' : 'fail', cookie ? 'ok' : 'no set-cookie');
  if (cookie) {
    try {
      const { mux } = await muxCallFactory(boot.url, cookie);
      // 建一个会话（cwd 指向 POC workspace）
      const cwdGuess = path.join(root, 'workspace');
      let sid = null;
      try {
        const created = await mux.call('session/create', { request: { cwd: cwdGuess } });
        sid = (created && (created.sessionId || (created.value && created.value.sessionId))) || null;
        record('session/create with cwd', sid ? 'pass' : 'fail', sid ? `sessionId=${String(sid).slice(0, 12)}…` : 'no sessionId');
      } catch (err) {
        record('session/create with cwd', 'fail', String(err.message).slice(0, 200));
      }
      if (sid) {
        // 读投影：agentTeam 是否出现（即便为空团队）
        try {
          const proj = await mux.call('session/projections', { request: { sessionId: sid } });
          const value = (proj && (proj.value !== undefined ? proj.value : proj)) || null;
          const kind = value && value.kind;
          const values = (value && value.values) || {};
          const keys = Object.keys(values);
          record('session/projections responds', kind ? 'pass' : 'fail', `kind=${kind} keys=${keys.length}`);
          const hasTeam = Object.prototype.hasOwnProperty.call(values, 'agentTeam');
          record('projection includes agentTeam', hasTeam ? 'pass' : 'not-verified',
            hasTeam ? JSON.stringify(values.agentTeam).slice(0, 300)
              : `agentTeam absent; keys=${keys.join(',') || '(none)'}`);
          // 记录我们关心的键是否存在
          for (const k of ['userQuestions', 'permissions', 'plan', 'workingDirectory', 'inbox', 'todos']) {
            const present = Object.prototype.hasOwnProperty.call(values, k);
            record(`projection key: ${k}`, present ? 'pass' : 'not-verified', present ? 'present' : 'absent');
          }
        } catch (err) {
          record('session/projections responds', 'fail', String(err.message).slice(0, 200));
        }
      }
      try { mux.close(); } catch { /* */ }
    } catch (err) {
      record('mux connect', 'fail', String(err.message).slice(0, 200));
    }
  }

  // ---- 必须真实模型才能验证的项，如实标记 ----
  record('团队创建/成员派生（P-0.1）', 'needs-model', '需要真实模型调用 spawnTeammate');
  record('agentTeam 真实内容（P-0.2）', 'needs-model', '空团队投影不足以验证字段取值');
  record('readiness/blockedBy 派生（P-0.3）', 'needs-model', '需要真实任务图');
  record('成员 inbox 消息（P-0.4）', 'needs-model', 'sendMessage 需真实 Agent 实例');
  record('任务修改/重分配（P-0.5）', 'needs-model', 'updateTask 需真实 Agent 实例');
  record('停止成员（P-0.6）', 'needs-model', 'interrupt 需真实运行中的 teammate');
  record('提问回流（P-0.7）', 'needs-model', 'userQuestions 需真实模型触发');
  record('Brief 跨会话（P-0.8）', 'needs-model', '见 scripts/acceptance/brief-cross-session-acceptance.js');
  record('workspace/changes 事件（P-0.9）', 'needs-model', '需要真实 turn 产生文件变更');
  record('权限预设（P-0.11/P-0.12）', 'needs-model', '需真实模型触发 permission/preset 事件');

  try { boot.child.kill('SIGTERM'); } catch { /* */ }
  return finish(outDir);
}

function finish(outDir) {
  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 's0-probe.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2));
    console.log(`[s0] report: ${path.join(outDir, 's0-probe.json')}`);
  } catch (err) {
    console.error('[s0] cannot write report:', err.message);
  }
  console.log('[s0] counts: ' + JSON.stringify(counts));
  const hardFail = results.some((r) => r.status === 'fail');
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  console.error('[s0] FATAL', err && err.stack || err);
  process.exit(1);
});
