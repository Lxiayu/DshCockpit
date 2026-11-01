'use strict';

// scripts/poc/protocol-probe.js — Issue #9：真实验证 0.2.x 的协议与功能。
//
// 第一性原理：为什么不能用"能启动"当作 POC 结论
//
//   CI 的三个 gate（install / dump-config / health-check）证明的只是
//   "装得上、起得来、HTTP 200"。而 DshCockpit 依赖的是**协议行为**：
//     - /api/remote.mux 能不能连、$events 能不能收到 ready、waterfall 能不能回
//     - session RPC 的参数形状有没有变（session/list、session/page…）
//     - journal 事件词表是否仍能喂给办公室的翻译层
//   这些一条都不在 CI 覆盖范围内。如果 POC 也只测"能启动"，那就等于没有 POC。
//
//   所以本探针逐项验证真实能力，并把"没验证到"如实记为 not-verified ——
//   不把"没跑"写成"通过"（与 #10 的四态纪律一致）。
//
// 它**只读**地 import 仓库的 src/runtime-mux.js 与 src/runtime-auth.js
// （它们是纯 Node、transport 可注入的），但所有 IO 都落在 POC_ROOT 内：
// DSH_HOME、workspace、日志、cache 全部隔离。
//
// 用法（通常由 runtime-poc.sh 调用）：
//   node scripts/poc/protocol-probe.js --version 0.2.1-rc.5 --root /tmp/.../0.2.1-rc.5

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const results = [];
/** 记录一项检查。status ∈ pass | fail | not-verified | skipped */
function record(name, status, detail, extra) {
  results.push({ name, status, detail: detail || '', ...(extra || {}) });
  const mark = { pass: 'PASS', fail: 'FAIL', 'not-verified': 'NOT-VERIFIED', skipped: 'SKIP' }[status];
  console.log(`[probe] ${mark.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 固定的 POC 沙箱环境：任何 spawn 都必须带这份 env，杜绝污染生产。 */
function pocEnv(root) {
  return {
    ...process.env,
    DSH_HOME: path.join(root, 'dsh-home'),
    DSH_POC_ISOLATED: '1',
    npm_config_cache: path.join(root, 'npm-cache'),
    // 不让子进程发现用户真实的 dsh 配置
    DSH_PRIMARY_RUNTIME: path.join(root, 'dsh-home'),
  };
}

function findBin(root) {
  const candidates = [
    path.join(root, 'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    path.join(root, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // symlinked vendored runtime
  try {
    const real = fs.realpathSync(path.join(root, 'runtime'));
    const p = path.join(real, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    if (fs.existsSync(p)) return p;
  } catch { /* not a symlink */ }
  return null;
}

/** 跑一个短命令，返回 {code, stdout, stderr, ms}。 */
function runNode(bin, args, root, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [bin, ...args], {
      env: pocEnv(root),
      cwd: path.join(root, 'workspace'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message || err), ms: Date.now() - t0 });
    });
  });
}

/** 从 dsh 的 stdout 里抓 web URL（两代都是 `dsh web: <url>`）。 */
function parseWebUrl(text) {
  const m = String(text || '').match(/dsh web: (\S+)/);
  if (!m) return null;
  try {
    const u = new URL(m[1].replace(/[),.]+$/, ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
    return u.href;
  } catch { return null; }
}

function get(url, headers) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += String(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(5000, () => { try { req.destroy(); } catch { /* ignore */ } resolve({ status: 0, headers: {}, body: '' }); });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
  });
}

/**
 * 启动 runtime 的 web profile，等 URL 出现并健康。
 * 返回 {child, url, logs}，失败返回 {error}。
 */
function bootWeb(bin, root, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const outFile = path.join(root, 'logs', `boot-${Date.now()}.log`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const fd = fs.openSync(outFile, 'a');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0', '--no-open'], {
      env: pocEnv(root),
      cwd: path.join(root, 'workspace'),
      stdio: ['ignore', fd, fd],
    });
    let done = false;
    const started = Date.now();
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve({ ...value, logFile: outFile, child });
    };
    const tick = async () => {
      if (Date.now() - started > timeoutMs) { finish({ error: 'boot timeout (no web URL line)' }); return; }
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* not yet */ }
      const url = parseWebUrl(text);
      if (!url) { setTimeout(tick, 700); return; }
      // health check: root with token → 200/3xx
      const r = await get(url);
      if (r.status === 200 || (r.status >= 300 && r.status < 400)) finish({ url, logFile: outFile });
      else setTimeout(tick, 700);
    };
    child.on('exit', () => { if (!done) finish({ error: 'runtime exited before serving' }); });
    setTimeout(tick, 800);
  });
}

async function main() {
  const version = argValue('--version');
  const root = argValue('--root');
  if (!version || !root) {
    console.error('[probe] --version and --root are required');
    process.exit(2);
  }

  const bin = findBin(root);
  if (!bin) {
    record('runtime binary present', 'fail', `no dsh bin.js under ${root}`);
    finishWrite(root, version);
    return;
  }
  record('runtime binary present', 'pass', bin);

  // ---- 1. 版本自证（确认跑的真是目标版本，而不是被缓存糊弄）----
  const verRun = await runNode(bin, ['--version'], root, 60000);
  const verText = `${verRun.stdout}${verRun.stderr}`.trim();
  if (verRun.code === 0 && verText.includes(version)) {
    record('runtime version self-report', 'pass', verText.split('\n').pop());
  } else {
    record('runtime version self-report', 'fail', `expected ${version}, got "${verText.slice(0, 120)}" (exit ${verRun.code})`);
  }

  // ---- 2. dump-config（CI 已覆盖，但这里顺带确认 profile 可解析）----
  const dump = await runNode(bin, ['--profile', 'web', '--dump-config'], root, 120000);
  record('dump-config (web profile)', dump.code === 0 ? 'pass' : 'fail',
    dump.code === 0 ? `${dump.ms}ms` : (dump.stderr || '').slice(0, 200));

  // ---- 3. 启动 web host ----
  const boot = await bootWeb(bin, root);
  if (boot.error) {
    record('boot web host', 'fail', boot.error);
    finishWrite(root, version);
    return;
  }
  record('boot web host', 'pass', `${boot.url}`);

  // ---- 4. HTTP 面 ----
  const rootResp = await get(boot.url);
  record('GET / (token url) answers', rootResp.status === 200 || (rootResp.status >= 300 && rootResp.status < 400)
    ? 'pass' : 'fail', `status=${rootResp.status}`);

  // ---- 5. Cookie 认证交换（mux 需要它）----
  const { createRuntimeAuth } = require(path.join(REPO_ROOT, 'src', 'runtime-auth.js'));
  const auth = createRuntimeAuth({ log: () => {} });
  auth.setAuthUrl(boot.url);
  const cookie = await auth.getCookie();
  record('browser-auth cookie exchange', cookie ? 'pass' : 'fail',
    cookie ? `${String(cookie).split(';')[0].slice(0, 40)}…` : 'no cookie obtained');

  // ---- 6. mux 协议：连接 + $events ready（这是 CI 完全没覆盖的）----
  if (!cookie) {
    record('mux connect ($events ready)', 'not-verified', 'skipped: no auth cookie');
  } else {
    const muxResult = await probeMux(boot.url, cookie, root);
    record('mux connect ($events ready)', muxResult.ok ? 'pass' : 'fail', muxResult.detail);
    if (muxResult.ok) {
      record('session/list RPC', muxResult.sessionList.ok ? 'pass' : 'fail', muxResult.sessionList.detail);
      record('session/create RPC', muxResult.sessionCreate.ok ? 'pass' : 'fail', muxResult.sessionCreate.detail);
      record('session/page RPC', muxResult.sessionPage.ok ? 'pass' : 'fail', muxResult.sessionPage.detail);
    } else {
      record('session RPCs', 'not-verified', 'skipped: mux not usable');
    }
  }

  // ---- 7. 能力面探测：哪些新包在该版本里真的存在 ----
  const capabilityRoot = path.join(root, 'runtime');
  const capReport = probeCapabilities(capabilityRoot, root);
  for (const c of capReport) record(`capability: ${c.name}`, c.present ? 'pass' : 'not-verified', c.detail);

  // ---- 8. 未验证项（诚实清单）----
  for (const item of [
    'Team 成员事件（team/member、team/task 的实际 payload）',
    'User Question 往返（需真实模型调用）',
    'Approval 往返（需真实工具调用）',
    '断线重连与状态恢复（需长连接 + 强制断开）',
  ]) {
    record(`not verified: ${item}`, 'not-verified', '需要交互式会话与真实模型调用；本探针不做');
  }

  try { boot.child.kill('SIGTERM'); } catch { /* ignore */ }
  finishWrite(root, version);
}

/**
 * 用仓库的 runtime-mux 连 POC host，验证 $events ready + 三个 session RPC。
 * 全程在 POC sandbox 内，不触碰生产 runtime。
 */
function probeMux(baseUrl, cookie, root) {
  return new Promise((resolve) => {
    const { createRuntimeMux } = require(path.join(REPO_ROOT, 'src', 'runtime-mux.js'));
    const auth = { getCookie: async () => cookie, invalidate: () => {} };
    let mux;
    const timeout = setTimeout(() => {
      try { mux && mux.close && mux.close(); } catch { /* ignore */ }
      resolve({ ok: false, detail: 'mux timeout (no ready frame in 20s)', sessionList: {}, sessionCreate: {}, sessionPage: {} });
    }, 20000);

    const done = (value) => { clearTimeout(timeout); try { mux && mux.close && mux.close(); } catch { /* ignore */ } resolve(value); };

    // 关键：createRuntimeMux 期望的是 **origin**（如 http://127.0.0.1:PORT），
    // 不是带 `?token=` 的启动 URL。传完整 URL 会拼出
    // `ws://host/?token=xxx/api/remote.mux` —— 路径错位，握手直接 hang up。
    // 生产代码（main.js:startMuxEventsFeed）传的也是 origin。
    let origin;
    try {
      const u = new URL(baseUrl);
      u.search = '';
      u.hash = '';
      origin = u.origin;
    } catch {
      done({ ok: false, detail: `cannot parse base url: ${baseUrl}`, sessionList: {}, sessionCreate: {}, sessionPage: {} });
      return;
    }
    try {
      mux = createRuntimeMux({
        baseUrl: origin,
        auth,
        log: () => {},
        onError: () => {},
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({ ok: false, detail: `createRuntimeMux threw: ${err.message}`, sessionList: {}, sessionCreate: {}, sessionPage: {} });
      return;
    }

    let settled = false;
    mux.onReady(async ({ clientId }) => {
      if (settled) return;
      settled = true;
      const result = { ok: true, detail: `ready frame received (clientId ${String(clientId).slice(0, 8)}…)`, sessionList: {}, sessionCreate: {}, sessionPage: {} };
      // session/list
      try {
        const list = await mux.call('session/list', { _request: {} });
        const items = (list && (list.items || list.value && list.value.items)) || [];
        result.sessionList = { ok: true, detail: `items=${Array.isArray(items) ? items.length : '?'}` };
      } catch (err) {
        result.sessionList = { ok: false, detail: String(err.message || err).slice(0, 160) };
      }
      // session/create（在 POC workspace 内建会话，不碰用户目录）
      let createdId = null;
      try {
        const created = await mux.call('session/create', {
          request: { cwd: path.join(root, 'workspace') },
        });
        createdId = (created && (created.sessionId || (created.value && created.value.sessionId))) || null;
        result.sessionCreate = { ok: !!createdId, detail: createdId ? `sessionId=${String(createdId).slice(0, 10)}…` : 'no sessionId in response' };
      } catch (err) {
        result.sessionCreate = { ok: false, detail: String(err.message || err).slice(0, 160) };
      }
      // session/page（若拿到 sessionId 就翻一页；空会话也应返回结构）
      if (createdId) {
        try {
          const page = await mux.call('session/page', {
            request: { address: { kind: 'session', sessionId: createdId }, throughSeq: 1e9 },
          });
          const records = (page && (page.records || (page.value && page.value.records))) || [];
          result.sessionPage = { ok: true, detail: `records=${Array.isArray(records) ? records.length : '?'}, hasMore=${!!(page && page.hasMore)}` };
        } catch (err) {
          result.sessionPage = { ok: false, detail: String(err.message || err).slice(0, 160) };
        }
      } else {
        result.sessionPage = { ok: false, detail: 'needs a sessionId from session/create' };
      }
      done(result);
    });

    try { mux.connect(); } catch (err) { done({ ok: false, detail: `connect threw: ${err.message}`, sessionList: {}, sessionCreate: {}, sessionPage: {} }); }
  });
}

/** 探测 0.2.x 的新能力包是否真的随该版本安装。 */
function probeCapabilities(runtimePath, root) {
  let nmDir = null;
  try {
    const real = fs.realpathSync(runtimePath);
    nmDir = path.join(real, 'node_modules', '@deepseek-ai');
  } catch {
    nmDir = path.join(root, 'runtime-install', 'node_modules', '@deepseek-ai');
  }
  const wanted = [
    ['dsh-experimental-agent-team', 'Agent Teams（roster/任务板/inbox）'],
    ['dsh-experimental-worktree', 'worktree 隔离原语'],
    ['dsh-workspace-changes', 'per-turn 文件变更捕获'],
    ['dsh-goal', 'Session 级持久目标'],
    ['dsh-session-query-sqlite', '历史检索后端（FTS5）'],
    ['dsh-experimental-session-search', '模型侧会话检索 bundle'],
  ];
  return wanted.map(([pkg, desc]) => {
    const present = !!nmDir && fs.existsSync(path.join(nmDir, pkg));
    return { name: pkg, present, detail: present ? desc : `absent in this runtime (${desc})` };
  });
}

/** 写 JSON + Markdown 报告到 POC logs 目录。 */
function finishWrite(root, version) {
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const jsonPath = path.join(logsDir, 'verify.json');
  const mdPath = path.join(logsDir, 'verify.md');
  const summary = {
    version,
    generatedAt: new Date().toISOString(),
    isolated: {
      root,
      dshHome: path.join(root, 'dsh-home'),
      workspace: path.join(root, 'workspace'),
    },
    counts: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
    results,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n');

  const lines = [];
  lines.push(`# Runtime POC 验证报告 · ${version}`);
  lines.push('');
  lines.push(`- 生成时间：${summary.generatedAt}`);
  lines.push(`- 隔离根目录：\`${root}\``);
  lines.push(`- DSH_HOME：\`${summary.isolated.dshHome}\``);
  lines.push(`- workspace：\`${summary.isolated.workspace}\``);
  lines.push('');
  lines.push('## 结论计数');
  lines.push('');
  lines.push('| 状态 | 数量 |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(summary.counts)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## 逐项结果');
  lines.push('');
  lines.push('| 检查项 | 状态 | 说明 |');
  lines.push('|---|---|---|');
  for (const r of results) lines.push(`| ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|')} |`);
  lines.push('');
  lines.push('> 状态说明：`pass` 实际验证通过；`fail` 验证失败；');
  lines.push('> `not-verified` **未验证**（不等于通过）；`skipped` 主动跳过。');
  lines.push('');
  fs.writeFileSync(mdPath, lines.join('\n'));

  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`[probe] report: ${mdPath}`);
  console.log(`[probe] counts: ${JSON.stringify(summary.counts)}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[probe] FATAL:', err && err.stack ? err.stack : err);
  process.exit(2);
});
