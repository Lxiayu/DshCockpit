'use strict';

// scripts/office-soak.js — P5.7 长稳（soak）真壳探针。
//
// 目的（证明什么）
//   1) 渲染锁死类（adbf225，用户实测）：办公室视图被切到后台再切回前台，
//      画面必须还活着；长期挂机期间渲染态不得停在 static（有界恢复预算内的
//      降档是允许的，恢复预算耗尽不恢复就是缺陷）。
//   2) 同步断档类（9c71ef1，用户实测）：真对话收尾后员工不得卡在「工作中」，
//      office `sync` 不得停在 stale。
//   3) 长稳曲线：Electron 进程树 RSS / CPU 的整段曲线（是否平台化、是否泄漏）。
//   4) 后台存活：办公室不是当前主视图期间，仿真与 follow 继续推进（不冻结）。
//
// 方式：真壳（dev `electron .` 或 `--app <打包产物>`）+ 隔离 userData +
//   DSH_HOME 副本（真凭据、真 home 零残留）+ 真运行时（默认取本机已装最高版本）+
//   真对话（RPC 创建 session 并 prompt，与 UI 发起等价；壳的 follow 接线是产品路径）+
//   定期经 rail 切视图 + 周期采样（进程指标 + 页面/模块事实）。
//
// 不证明（诚实的边界）
//   - 对话由 RPC 发起而不是人手点击 UI；壳侧接线（follow/resync/座位/右栏）是真实路径。
//   - 只覆盖本机平台 + 一个运行时版本；Windows 真机与高分屏另跑
//     （docs/strategy/2026-09-24-windows-perf-audit.md 的 V1–V10）。
//   - 「两类缺陷不再复发」是 N 小时无复发的回归证据，不是形式化证明。
//
// 隔离与清理：userData 与 DSH_HOME 都在临时目录，跑完（含失败）删除；
//   证据只落 `--evidence` 目录（桌面）。探针不复制运行时的 `.out` 日志
//   （那里有 launch token），壳日志复制前做 token/cookie 脱敏。
// 副作用：会消耗少量真实 LLM token（每轮 prompt 很短）；挂机期间窗口可见。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');

const REPO = path.resolve(__dirname, '..');

// --------------------------------------------------------------------- args
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function flagSet(flag) { return process.argv.includes(flag); }

const DRY_MINUTES = argValue('--dry-minutes', '');
const HOURS = Number(argValue('--hours', '4'));
const DURATION_MS = DRY_MINUTES ? Number(DRY_MINUTES) * 60_000 : HOURS * 3600_000;
const SAMPLE_INTERVAL_MS = Number(argValue('--sample-interval-sec', '10')) * 1000;
const TURN_INTERVAL_MS = Number(argValue('--turn-interval-min', '15')) * 60_000;
const SWITCH_INTERVAL_MS = Number(argValue('--switch-interval-min', '24')) * 60_000;
const SWITCH_HOLD_MS = Number(argValue('--switch-hold-min', '4')) * 60_000;
const APP_PATH = argValue('--app', '');            // 打包产物可执行文件；缺省走 dev `electron .`
const RUNTIME_VERSION = argValue('--runtime', ''); // 缺省：本机已装最高版本（<0.2.0）
const DSH_HOME_SRC = argValue('--dsh-home', path.join(os.homedir(), '.dsh'));
const DEBUG_PORT = Number(argValue('--debug-port', '9411'));
const KEEP_RUN_DIR = flagSet('--keep-run-dir');
const NO_CONVERSATION = flagSet('--no-conversation');
const NO_SWITCH = flagSet('--no-switch');
// 每 N 轮里拿一轮做「中途取消」（覆盖 office 的 cancel→释放路径；0 = 关）
const CANCEL_EVERY = Number(argValue('--cancel-every', '0'));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const EVIDENCE = path.resolve(argValue('--evidence',
  path.join(os.homedir(), 'Desktop', 'office-evidence-2026-09-23', `长稳-v0.4.0-${STAMP}`)));

function realUserDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-cockpit');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-cockpit');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dsh-cockpit');
}

const REAL_UD = realUserDataDir();
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-soak-'));
const userDataDir = path.join(runDir, 'userData');
const logsDir = path.join(userDataDir, 'logs');
const probeLog = path.join(EVIDENCE, 'run.log');

fs.mkdirSync(EVIDENCE, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
const shotsDir = path.join(EVIDENCE, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

function log(line) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const text = `[soak ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${line}`;
  console.log(text);
  try { fs.appendFileSync(probeLog, text + '\n'); } catch { /* best effort */ }
}
function writeJson(name, value) {
  try { fs.writeFileSync(path.join(EVIDENCE, name), JSON.stringify(value, null, 2)); } catch (err) { log(`evidence write failed (${name}): ${err.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 屏幕/会话呈现状态：渲染类判据只在"真的有人在呈现"时才有意义。
 * 2026-09-25 实测：机器锁屏 + 显示器休眠期间，Chromium 把 WebContents 节流到
 * ~1.3fps，办公室按设计进入 static 诊断态——这是诚实结果，不是回归。判据必须
 * 区分"没人看"与"有人看但画面死了"。
 *   locked : ioreg 的 CGSSessionScreenIsLocked（快，30s 查一次）
 *   display: pmset 的 Display is turned on/off（慢 ~1.2s，60s 查一次）
 */
function screenLocked() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8', timeout: 5000 });
    const m = /"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)/.exec(out);
    return m ? m[1] === 'Yes' : null;
  } catch { return null; }
}

function displayState() {
  if (process.platform !== 'darwin') return 'unknown';
  try {
    const out = execFileSync('pmset', ['-g', 'log'], { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
    let state = 'unknown';
    for (const line of out.split('\n')) {
      if (line.includes('Display is turned on')) state = 'on';
      else if (line.includes('Display is turned off')) state = 'off';
    }
    return state;
  } catch { return 'unknown'; }
}

/** 是否"有人在看"：显示器亮 且 屏幕未锁。读不到 → null（未知，按"有人在看"处理）。 */
function presentedNow(state) {
  if (Date.now() - (state.presentationCheckedAt || 0) > 30_000) {
    state.presentationCheckedAt = Date.now();
    state.screenLocked = screenLocked();
    if (Date.now() - (state.displayCheckedAt || 0) > 60_000) {
      state.displayCheckedAt = Date.now();
      const next = displayState();
      if (next !== 'unknown' && next !== state.display) log(`display → ${next}`);
      if (next !== 'unknown') state.display = next;
    }
  }
  if (state.screenLocked === true) return false;
  if (state.display === 'off') return false;
  if (state.screenLocked === null && state.display === 'unknown') return null;
  return true;
}

// ------------------------------------------------------- runtime + homes
/** 选一个本机可用、且在当前支持区间内的运行时版本：已装目录优先，其次仓库内置种子。 */
function pickRuntimeVersion() {
  if (RUNTIME_VERSION) return RUNTIME_VERSION;
  const candidates = [];
  try {
    for (const name of fs.readdirSync(path.join(REAL_UD, 'runtime'))) {
      if (/^\d+\.\d+\.\d+/.test(name) && fs.existsSync(path.join(REAL_UD, 'runtime', name, 'package.json'))) candidates.push(name);
    }
  } catch { /* none installed */ }
  try {
    for (const name of fs.readdirSync(path.join(REPO, 'vendor', 'runtime'))) {
      if (/^\d+\.\d+\.\d+/.test(name) && fs.existsSync(path.join(REPO, 'vendor', 'runtime', name, 'package.json'))) candidates.push(name);
    }
  } catch { /* no seed */ }
  const semver = require('semver');
  const usable = candidates
    .filter((v) => { try { return semver.satisfies(v, '<0.2.0-0', { includePrerelease: true }); } catch { return false; } })
    .sort((a, b) => semver.rcompare(a, b));
  return usable[0] || '';
}

/** 把运行时拷进隔离 userData，并写好 runtime-state.json（activeVersion 直指副本）。 */
function seedRuntime(version) {
  const installed = path.join(REAL_UD, 'runtime', version);
  const bundled = path.join(REPO, 'vendor', 'runtime', version);
  const src = fs.existsSync(path.join(installed, 'package.json')) ? installed
    : (fs.existsSync(path.join(bundled, 'package.json')) ? bundled : null);
  if (!src) return null;
  const target = path.join(runDir, 'runtime', version);
  log(`seeding runtime ${version} ← ${src} (copied, no network)`);
  fs.cpSync(src, target, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'runtime-state.json'), JSON.stringify({
    activeVersion: version,
    previousVersion: null,
    pendingVersion: null,
    installed: [{ version, path: target, source: 'managed' }],
    broken: [],
    knownIssues: {},
    lastSnapshot: null,
    startupFailStreak: 0,
    startupFailStreakVersion: null,
    lastStartupFailReason: null,
  }, null, 2));
  return { src, target };
}

/** DSH_HOME 副本：真凭据照用，会话残渣落在临时目录（真 home 零改动）。 */
function copyDshHome() {
  const target = path.join(runDir, 'dsh-home');
  if (!fs.existsSync(DSH_HOME_SRC)) { log(`DSH_HOME 源不存在：${DSH_HOME_SRC} —— 真对话会失败（降级为纯挂机）`); return target; }
  fs.cpSync(DSH_HOME_SRC, target, { recursive: true });
  log(`DSH_HOME copied ← ${DSH_HOME_SRC} (real credentials, isolated residue)`);
  return target;
}

// ---------------------------------------------------------------- process
function killTree(child, signal) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else if (child.pid) { try { process.kill(-child.pid, signal || 'SIGTERM'); } catch { try { child.kill(signal || 'SIGTERM'); } catch { /* gone */ } } }
  } catch { /* already gone */ }
}

function processTreeMetrics(rootPid) {
  let rows = [];
  try {
    rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,pcpu='], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { const [pid, ppid, rss, pcpu] = l.split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss), cpu: Number(pcpu) }; });
  } catch { return null; }
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const tree = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((r) => r.pid === pid);
    if (row) tree.push(row);
    for (const child of byParent.get(pid) || []) queue.push(child.pid);
  }
  if (!tree.length) return null;
  return {
    processes: tree.length,
    rssMb: Math.round(tree.reduce((sum, r) => sum + r.rssKb, 0) / 1024 * 10) / 10,
    cpuPct: Math.round(tree.reduce((sum, r) => sum + r.cpu, 0) * 10) / 10,
    maxProcRssMb: Math.round(Math.max(...tree.map((r) => r.rssKb)) / 1024 * 10) / 10,
  };
}

// -------------------------------------------------------------- log tailer
// 只读 `*.log`（壳日志）。运行时的 `*.out` 含 launch token，绝不复制/解析进证据。
const LOG_PATTERNS = [
  ['runtimeUrl', /\[shell\] runtime URL: (https?:\/\/127\.0\.0\.1:\d+)/],
  ['rendererMode', /\[office\] renderer mode=(\S+) code=(\S+)/],
  ['sync', /\[office\] sync (healthy|resyncing|stale)\b/],
  ['resyncAnswered', /\[office\] resync (?:baseline|continuation) applied/],
  ['followOpen', /\[office\] follow open/],
  ['followReopen', /\[office\] follow reopen/],
  ['followClosed', /\[office\] follow closed/],
  ['followWindow', /\[office\] follow window/],
  ['pendingNote', /\[office\] pending (?:approval|question) noted/],
  ['stateDiag', /\[office\] state: /],
  ['runtimeDegraded', /\[shell\] runtime degraded/],
  ['runtimeRecovered', /\[shell\] runtime health recovered/],
  ['streamEnd', /\[office\] assistant-stream end/],
];
function redact(line) {
  return String(line)
    .replace(/token=[A-Za-z0-9._~+/=-]+/g, 'token=<redacted>')
    .replace(/dsh-auth-[A-Za-z0-9._~+/=-]+/g, 'dsh-auth-<redacted>');
}

class ShellLogTailer {
  constructor(dir) { this.dir = dir; this.consumed = new Map(); this.counts = new Map(); this.notable = []; }
  scan() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((n) => n.endsWith('.log')); } catch { return; }
    for (const name of files) {
      const full = path.join(this.dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const from = this.consumed.get(full) || 0;
      if (st.size <= from) continue;
      let text = '';
      try {
        const fd = fs.openSync(full, 'r');
        try {
          const buf = Buffer.alloc(st.size - from);
          const read = fs.readSync(fd, buf, 0, buf.length, from);
          const n = typeof read === 'number' ? read : ((read && read.bytesRead) || 0);
          this.consumed.set(full, from + n);
          text = buf.toString('utf8', 0, n);
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        for (const [key, pattern] of LOG_PATTERNS) {
          if (!pattern.test(line)) continue;
          this.counts.set(key, (this.counts.get(key) || 0) + 1);
          if (this.notable.length < 1500) this.notable.push({ at: new Date().toISOString(), key, line: redact(line).slice(0, 220) });
        }
      }
    }
  }
}

// ------------------------------------------------------------------ HTTP
function httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* ignore */ } reject(new Error(`timeout ${url}`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 极简 runtime 客户端（legacy 0.1.1 点方法 / slash 0.1.5 斜杠端点 + Cookie）。
 * 探针自持一份，不依赖 src（发版探针要能独立跑，且 src 的接线是被测对象）。
 */
function createRuntimeClient({ origin, protocol, authUrl }) {
  const slash = protocol === 'slash';
  let cookie = null;
  let cookieTried = false;

  async function ensureCookie() {
    if (!slash || cookie || cookieTried) return;
    cookieTried = true;
    if (!authUrl) return;
    try {
      const res = await httpJson(authUrl, { timeoutMs: 8000 });
      const setCookie = res.headers['set-cookie'];
      if (Array.isArray(setCookie) && setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      log(`runtime cookie exchange: status=${res.status} cookie=${cookie ? 'yes' : 'no'}`);
    } catch (err) { log(`runtime cookie exchange failed: ${err.message}`); }
  }

  async function rpc(method, args) {
    await ensureCookie();
    // legacy（0.1.1）：payload 是平铺参数；slash（0.1.5）：payload.args 是命名参数。
    const body = { type: 'client-request', rpcId: 'soak-' + crypto.randomBytes(5).toString('hex'), method, payload: slash ? { args } : args };
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (slash && cookie) headers.cookie = cookie;
    const res = await httpJson(`${origin}/api/${slash ? method : method.replace('/', '.')}`, {
      method: 'POST', headers, body: JSON.stringify(body), timeoutMs: 20_000,
    });
    if (res.status === 401 && slash && cookie) { // token 稳定：重换一次 cookie
      cookie = null; cookieTried = false;
      await ensureCookie();
      if (cookie) headers.cookie = cookie;
      const retry = await httpJson(`${origin}/api/${method}`, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: 20_000 });
      return unwrap(retry, method);
    }
    return unwrap(res, method);
  }
  function unwrap(res, method) {
    const result = res.json && res.json.result ? res.json.result : null;
    if (!result) throw new Error(`${method}: HTTP ${res.status} (no result envelope)`);
    if (!result.ok) throw Object.assign(new Error(`${method}: ${(result.error && result.error.message) || 'failed'}`), { code: result.error && result.error.code });
    return result.value;
  }

  // session/create 的 cwd 在 0.1.1 / 0.1.5 上都不是必填：带 cwd 失败就退回空请求，
  // 保证「会话能建起来」这条不因版本差异而假红。
  const create = (cwd) => {
    const attempt = (withCwd) => (slash
      ? rpc('session/create', { request: withCwd ? { cwd } : {} })
      : rpc('session/create', withCwd ? { cwd } : {}));
    return attempt(true).then((v) => v && v.sessionId).catch(() => attempt(false).then((v) => v && v.sessionId));
  };

  return {
    slash,
    list: () => rpc('session/list', slash ? { _request: {} } : {}).then((v) => (v && v.items) || []),
    create,
    prompt: (sessionId, text, mode) => (slash
      ? rpc('session/prompt', { request: { requestId: 'soak-' + crypto.randomBytes(5).toString('hex'), sessionId, mode, content: [{ type: 'text', text }] } })
      : rpc('session/prompt', { sessionId, mode, content: [{ type: 'text', text }] })),
    cancel: (sessionId) => (slash ? rpc('session/cancel', { request: { sessionId } }) : rpc('session/cancel', { sessionId })),
  };
}

// ------------------------------------------------------------------- CDP
class CdpTarget {
  constructor(wsUrl, label) { this.wsUrl = wsUrl; this.label = label; this.id = 0; this.pending = new Map(); this.ws = null; }
  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      this.ws = ws;
      ws.on('open', resolve);
      ws.on('error', reject);
      ws.on('message', (raw) => {
        let msg = null;
        try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (!msg.id || !this.pending.has(msg.id)) return;
        const { resolve: done, reject: fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message || 'cdp error'));
        else done(msg.result);
      });
      ws.on('close', () => { for (const { reject: fail } of this.pending.values()) fail(new Error('cdp closed')); this.pending.clear(); });
    });
    return this;
  }
  send(method, params, timeoutMs = 15_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  async eval(expression, timeoutMs = 15_000) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (res && res.exceptionDetails) throw new Error(`eval threw: ${(res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text}`);
    return res && res.result ? res.result.value : undefined;
  }
  async screenshot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' }, 20_000);
    if (!res || !res.data) return false;
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return true;
  }
  close() { try { this.ws && this.ws.close(); } catch { /* ignore */ } }
}

async function findTarget(predicate, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { timeoutMs: 4000 });
      const list = (res.json && Array.isArray(res.json) ? res.json : []).filter((t) => t && t.webSocketDebuggerUrl);
      const hit = list.find(predicate);
      if (hit) return hit;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return null;
}

// ------------------------------------------------------------ office facts
const OFFICE_FACTS_EXPR = `(() => {
  const api = window.__office && window.__office.api;
  if (!api) return { ready: false, error: (window.__office && window.__office.error) || 'no-api' };
  const snap = api.snapshot ? api.snapshot() : null;
  const diag = api.rendererDiagnostics ? api.rendererDiagnostics() : null;
  return {
    ready: window.__office.ready === true,
    mode: api.rendererMode ? api.rendererMode() : null,
    code: api.diagnosticCode ? api.diagnosticCode() : null,
    recoveryAttempts: diag ? diag.recoveryAttempts : null,
    renderProfile: diag ? diag.renderProfile : null,
    packMissing: diag ? diag.packMissing : null,
    entityCount: diag ? diag.entityCount : null,
    foreground: diag ? diag.foreground : null,
    fps: diag && diag.fps ? {
      windows: diag.fps.windows, lowWindows: diag.fps.lowWindows, lastFps: diag.fps.lastFps,
      degraded: diag.fps.degraded, consecutiveLowWindows: diag.fps.consecutiveLowWindows,
    } : null,
    sync: snap ? snap.sync : null,
    paused: snap ? !!snap.paused : null,
    staff: snap && Array.isArray(snap.employees) ? snap.employees.map((e) => ({
      id: e.employeeId, activity: e.activity, movement: e.movement,
      bound: !!e.binding, queue: e.queueCount || 0,
      task: e.taskLabel || null, tool: e.toolKind || null,
      result: e.lastResult ? e.lastResult.outcome : null,
    })) : null,
    pending: snap && Array.isArray(snap.pending) ? snap.pending.length : null,
  };
})()`;

// ------------------------------------------------------------------ main
const PROMPTS = [
  '请用三个并行子任务分别检查这个仓库：① 顶层目录结构；② src/ 下 js 文件数量；③ package.json 的 scripts 列表。汇总成一份不少于 500 字的详细报告，逐项说明。',
  '请阅读 README.md 前 120 行，写一份不少于 500 字的介绍，分四段：定位、核心能力、使用方式、局限。',
  '请统计 test/ 目录下的测试文件数量，按文件名前缀（office-、runtime-、其它）分组计数，并对每组写不少于 120 字的说明，总计不少于 450 字。',
  '请用大约 500 字、分三段，说明「桌面壳应用」相比直接用网页版的价值，面向普通开发者，每段都要举一个具体场景。',
];

async function main() {
  const startedAt = Date.now();
  const runtimeVersion = pickRuntimeVersion();
  log(`evidence: ${EVIDENCE}`);
  log(`run dir : ${runDir}`);
  log(`target  : ${APP_PATH || `dev (electron .) @ ${REPO}`}`);
  log(`runtime : ${runtimeVersion || '(none found)'}`);
  log(`duration: ${(DURATION_MS / 3600_000).toFixed(2)}h, sample every ${SAMPLE_INTERVAL_MS / 1000}s`);

  const seeded = runtimeVersion ? seedRuntime(runtimeVersion) : null;
  if (!seeded) { log('FATAL: no usable runtime to seed'); return { fatal: 'no-runtime' }; }
  const dshHome = copyDshHome();
  const protocol = runtimeVersion.startsWith('0.1.1') ? 'legacy' : 'slash';

  const child = spawn(
    APP_PATH || require(path.join(REPO, 'node_modules', 'electron')),
    APP_PATH ? [`--remote-debugging-port=${DEBUG_PORT}`] : [`--remote-debugging-port=${DEBUG_PORT}`, '.'],
    {
      cwd: REPO,
      env: {
        ...process.env,
        DSH_DESKTOP_USER_DATA: userDataDir,
        DSH_DESKTOP_DSH_HOME: dshHome,
        DSH_DESKTOP_NO_TRAY: '1',
        DSH_DESKTOP_NO_KEYCHAIN: '1',
        DSH_DESKTOP_OPEN_OFFICE: '1',
      },
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    },
  );
  log(`app spawned pid=${child.pid}`);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; log(`app exited code=${code} signal=${signal}`); });

  const tailer = new ShellLogTailer(logsDir);
  const violations = [];
  const notes = [];
  const samples = [];
  const cycles = [];
  const state = {
    viewActive: true,           // 打开时便激活办公室（DSH_DESKTOP_OPEN_OFFICE=1）
    lastReturnAt: null,
    staticSince: null,
    codeSince: null,
    lastRssMb: null,
    maxRssMb: null,
    minRssMb: null,
    lastSample: null,
    officeReady: false,
    lastWindows: undefined,
    lastWindowsAdvanceAt: null,
    pausedReported: false,
    packMissingReported: false,
    display: "unknown",
    displayCheckedAt: 0,
    staticWhileDisplayOffNoted: false,
  };

  function violation(kind, detail) {
    const rec = { at: new Date().toISOString(), elapsedMin: Math.round((Date.now() - startedAt) / 60000), kind, detail };
    violations.push(rec);
    log(`VIOLATION ${kind}: ${JSON.stringify(detail)}`);
    writeJson('violations.json', violations);
  }

  // observations：不是违规，但必须留档的事实（例：显示器休眠期间的 latch 是设计内
  // 的诚实结果；唤醒后不自愈，恢复路径=切视图/手动重试）。
  function note(kind, detail) {
    const rec = { at: new Date().toISOString(), elapsedMin: Math.round((Date.now() - startedAt) / 60000), kind, detail };
    notes.push(rec);
    log(`NOTE ${kind}: ${JSON.stringify(detail).slice(0, 300)}`);
    writeJson('notes.json', notes);
  }

  // --- 1) 等壳拿到 runtime URL（同时确认办公室视图已建）
  let runtimeOrigin = null;
  const bootDeadline = Date.now() + 240_000;
  while (Date.now() < bootDeadline && !runtimeOrigin && !exited) {
    tailer.scan();
    const urlLine = [...tailer.notable].reverse().find((n) => n.key === 'runtimeUrl');
    if (urlLine) {
      const m = /runtime URL: (https?:\/\/127\.0\.0\.1:\d+)/.exec(urlLine.line);
      if (m) { runtimeOrigin = m[1]; break; }
    }
    await sleep(1000);
  }
  if (!runtimeOrigin) { log('FATAL: runtime URL never appeared'); killTree(child); return { fatal: 'no-runtime-url', exited, counts: Object.fromEntries(tailer.counts) }; }
  log(`runtime origin: ${runtimeOrigin} (protocol=${protocol})`);

  // 0.1.2+ 的 RPC 需要 Cookie：从运行时的 .out 日志里取带 token 的 URL 做一次交换（token 不进证据）。
  let authUrl = null;
  try {
    for (const name of fs.readdirSync(logsDir)) {
      if (!name.endsWith('.out')) continue;
      const text = fs.readFileSync(path.join(logsDir, name), 'utf8');
      for (const m of text.matchAll(/dsh web: (\S+)/g)) authUrl = m[1].replace(/[),.]+$/, '');
    }
  } catch { /* runtime log not written yet */ }
  const client = createRuntimeClient({ origin: runtimeOrigin, protocol, authUrl });

  // --- 2) 附上办公室页面（CDP）
  const officeTarget = await findTarget((t) => String(t.url || '').startsWith('office-runtime://'), { timeoutMs: 120_000 });
  if (!officeTarget) { log('FATAL: office page target not found (office view never created?)'); killTree(child); return { fatal: 'no-office-target', counts: Object.fromEntries(tailer.counts) }; }
  const office = await new CdpTarget(officeTarget.webSocketDebuggerUrl, 'office').connect();
  log(`office page attached: ${officeTarget.url}`);
  const railTarget = await findTarget((t) => String(t.url || '').endsWith('office-rail.html'), { timeoutMs: 30_000 });
  const rail = railTarget ? await new CdpTarget(railTarget.webSocketDebuggerUrl, 'rail').connect() : null;
  log(`rail page: ${rail ? 'attached' : 'NOT FOUND (view switching disabled for this run)'}`);

  // 办公室页面 boot（webgl/pack/布局）
  for (let i = 0; i < 60; i += 1) {
    try {
      const facts = await office.eval(OFFICE_FACTS_EXPR);
      if (facts && facts.ready) { state.officeReady = true; log(`office ready: mode=${facts.mode} profile=${facts.renderProfile} entities=${facts.entityCount} packMissing=${facts.packMissing}`); break; }
      if (facts && facts.error) log(`office page error: ${facts.error}`);
    } catch (err) { log(`office eval during boot failed: ${err.message}`); }
    await sleep(1000);
  }
  if (!state.officeReady) violation('OFFICE_NOT_READY', { note: 'office page never reported ready within 60s' });

  // --- 3) 周期循环
  const cyclesFile = path.join(EVIDENCE, 'cycles.json');
  const samplesFile = path.join(EVIDENCE, 'samples.jsonl');
  let nextTurnAt = Date.now() + 60_000;                 // 首轮对话：boot 后 1 分钟
  let nextSwitchAt = NO_SWITCH ? Infinity : Date.now() + SWITCH_INTERVAL_MS;
  let backToOfficeAt = null;                            // 非空时：到点切回办公室
  let shotsTaken = 0;
  const activeSession = { id: null, turnStartedAt: null, promptIndex: 0 };

  async function sampleOnce(tag) {
    const row = { at: new Date().toISOString(), elapsedMin: Math.round((Date.now() - startedAt) / 60000), tag, viewActive: state.viewActive };
    // 呈现状态（锁屏/息屏时渲染类判据不适用；30s 查锁屏、60s 查显示器）
    const presented = presentedNow(state);
    row.presented = presented;
    row.screenLocked = state.screenLocked;
    row.display = state.display;
    if (presented === false) state.suppressedSamples = (state.suppressedSamples || 0) + 1;
    else if (presented === true) state.presentedSamples = (state.presentedSamples || 0) + 1;
    if (presented === true && state.lastSample && state.lastSample.mode === 'static' && state.viewActive
      && !state.staticWhileLockedNoted) {
      // 解锁/唤醒后不自愈（latch 无自动恢复），恢复路径 = 切视图 / 手动重试。如实记录。
      state.staticWhileLockedNoted = true;
      note('PRESENTED_BUT_STATIC', {
        note: 'screen is presented again while the office is the active view, but the renderer is still latched (recovery = view switch or manual retry)',
        code: state.lastSample.code, fps: state.lastSample.fps, recoveryAttempts: state.lastSample.recoveryAttempts,
      });
    }
    if (presented === false) state.staticWhileLockedNoted = false;
    const metrics = processTreeMetrics(child.pid);
    if (metrics) {
      row.rssMb = metrics.rssMb; row.cpuPct = metrics.cpuPct; row.processes = metrics.processes; row.maxProcRssMb = metrics.maxProcRssMb;
      state.minRssMb = state.minRssMb === null ? metrics.rssMb : Math.min(state.minRssMb, metrics.rssMb);
      state.maxRssMb = state.maxRssMb === null ? metrics.rssMb : Math.max(state.maxRssMb, metrics.rssMb);
      state.lastRssMb = metrics.rssMb;
    }
    try { row.office = await office.eval(OFFICE_FACTS_EXPR, 20_000); }
    catch (err) { row.officeError = err.message; }
    if (row.office) state.lastSample = row.office;
    samples.push(row);
    state.lastSampleRow = row;
    try { fs.appendFileSync(samplesFile, JSON.stringify(row) + '\n'); } catch { /* best effort */ }

    // ---- 不变量 1：渲染锁死类（显示器关着时不判定：合成器不呈现，1~2fps 是真实环境）
    const off = row.office;
    const busy = off && off.staff ? off.staff.filter((s) => s.bound || s.activity === 'working') : [];
    row.busyStaff = busy.map((s) => s.id);
    if (off && off.mode) {
      const isStatic = off.mode === 'static' || off.code === 'LOW_FPS_PERSISTENT';
      if (isStatic && state.viewActive && presented === false) {
        if (!state.staticWhileDisplayOffNoted) {
          state.staticWhileDisplayOffNoted = true;
          note('STATIC_WHILE_NOT_PRESENTED', {
            note: 'renderer latched while the screen was locked/off — expected (nothing is presented); render judgements are suppressed in this window',
            code: off.code, fps: off.fps, recoveryAttempts: off.recoveryAttempts,
            screenLocked: state.screenLocked, display: state.display,
          });
        }
      } else if (isStatic && state.viewActive) {
        if (state.staticSince === null) state.staticSince = Date.now();
        else if (Date.now() - state.staticSince > 120_000) {
          violation('RENDER_LATCHED_ACTIVE', { mode: off.mode, code: off.code, sinceMin: Math.round((Date.now() - state.staticSince) / 60000), fps: off.fps, recoveryAttempts: off.recoveryAttempts });
          state.staticSince = null; // 只报一次，避免刷屏
        }
      } else if (!isStatic) {
        state.staticSince = null;
      }
      if (!isStatic && state.viewActive && off.fps && off.fps.windows !== undefined) {
        if (state.lastWindows === undefined || off.fps.windows > state.lastWindows) state.lastWindowsAdvanceAt = Date.now();
        state.lastWindows = off.fps.windows;
      }
      if (state.viewActive && state.lastWindowsAdvanceAt && Date.now() - state.lastWindowsAdvanceAt > 180_000) {
        violation('RENDER_NOT_PRESENTING', { note: 'fps windows stopped advancing while office is the active view', fps: off.fps });
        state.lastWindowsAdvanceAt = Date.now();
      }
    }
    // ---- 不变量 2：同步断档类
    if (off && off.sync === 'stale') {
      if (state.codeSince === null) state.codeSince = Date.now();
      else if (Date.now() - state.codeSince > 120_000) { violation('SYNC_STALE', { detail: 'office sync stayed stale > 2min', staff: off.staff }); state.codeSince = null; }
    } else if (off) {
      state.codeSince = null;
    }
    if (off && off.paused === true && presented === true && !state.pausedReported) {
      state.pausedReported = true;
      violation('SIM_PAUSED_WHILE_VISIBLE', { note: 'module paused although the screen is presented and the office is the active view' });
    }
    // 锁屏/息屏期间模块按设计暂停仿真：绑定不会走回漫游，卡住类判据一律不适用。
    row.simPaused = !!(off && off.paused === true);
    if (off && off.packMissing === true && !state.packMissingReported) { state.packMissingReported = true; violation('PACK_MISSING', { note: 'renderer has no character pack' }); }
    return row;
  }

  async function runTurnCycle() {
    const cycle = { at: new Date().toISOString(), elapsedMin: Math.round((Date.now() - startedAt) / 60000), promptIndex: activeSession.promptIndex };
    try {
      const sessionId = await client.create(REPO);
      cycle.sessionId = sessionId;
      cycle.sessionShort = String(sessionId).slice(0, 8);
      // 真人节奏：会话先建、随后才发消息，壳在这中间把 journal follow 挂上。
      // 若抢在 follow 之前 prompt，首窗会落在 turn/start 之后——办公室看不到
      // running 事实就不会派员工上工（探针节奏问题，不是产品路径问题）。
      // 判据用累计计数（followOpen 事件数）而不是 notable 缓冲：壳日志只打
      // sessionId 前 8 位，而所有根会话都以 "session-" 开头，按前缀匹配会误判。
      const followWaitStart = Date.now();
      const opensAtStart = tailer.counts.get('followOpen') || 0;
      let sawNewOpen = false;
      while (Date.now() - followWaitStart < 45_000 && !exited) {
        tailer.scan();
        if ((tailer.counts.get('followOpen') || 0) > opensAtStart) { sawNewOpen = true; break; }
        if (Date.now() - followWaitStart > 20_000) break; // 兜底：等够了就发，如实记录
        await sleep(1000);
      }
      cycle.followWaitMs = Date.now() - followWaitStart;
      cycle.followWaitSignal = sawNewOpen ? 'new-follow-open' : 'timeout';
      const text = PROMPTS[activeSession.promptIndex % PROMPTS.length];
      activeSession.promptIndex += 1;
      cycle.promptChars = text.length;
      const before = state.lastSample;
      cycle.staffBefore = before && before.staff ? before.staff.filter((s) => s.activity !== 'idle' && s.activity !== 'roaming' && s.activity !== 'sleeping').map((s) => `${s.id}:${s.activity}`) : null;
      let mode = 'queue';
      try { await client.prompt(sessionId, text, mode); }
      catch (err) { mode = 'steer'; cycle.promptFallback = err.message; await client.prompt(sessionId, text, mode); }
      cycle.promptMode = mode;
      activeSession.id = sessionId;
      activeSession.turnStartedAt = Date.now();
      const t0 = Date.now();
      let sawBound = false;
      let sawRunning = false;
      let running = null;
      let falseObservations = 0;
      let cancelSent = false;
      const cancelThisTurn = CANCEL_EVERY > 0 && (activeSession.promptIndex % CANCEL_EVERY === 0);
      const busyIds = new Set();
      let maxBusy = 0;
      await sleep(1500);
      while (Date.now() - t0 < 8 * 60_000 && !exited) {
        const row = await sampleOnce(`turn:${activeSession.promptIndex}`);
        const staff = (row.office && row.office.staff) || [];
        const busyNow = staff.filter((s) => s.bound || s.activity === 'working');
        if (busyNow.length) { sawBound = true; for (const s of busyNow) busyIds.add(s.id); maxBusy = Math.max(maxBusy, busyNow.length); }
        try {
          const items = await client.list();
          const mine = items.find((it) => (it.sessionId || it.id) === sessionId);
          if (mine && typeof mine.running === 'boolean') {
            running = mine.running;
            if (mine.running) { sawRunning = true; falseObservations = 0; }
            else {
              falseObservations += 1;
              // 权威判据：见过 running 之后转 false。短 turn 可能在第一次轮询前就跑完
              // （连看两次 false 且已过 20s）——如实记为 never-saw-running，不假装看见过。
              if (sawRunning) { cycle.endDetection = 'turn-end'; break; }
              if (falseObservations >= 2 && Date.now() - t0 > 20_000) { cycle.endDetection = 'never-saw-running'; break; }
            }
          } else if (mine === undefined) {
            cycle.sessionMissingPolls = (cycle.sessionMissingPolls || 0) + 1;
          }
        } catch (err) { row.listError = err.message; }
        if (cancelThisTurn && !cancelSent && Date.now() - t0 > 25_000) {
          cancelSent = true;
          try {
            await client.cancel(sessionId);
            cycle.cancelled = true;
            log(`cancel sent (${cycle.sessionShort}) 25s into the turn`);
          } catch (err) { cycle.cancelError = err.message; }
        }
        await sleep(3000);
      }
      if (!cycle.endDetection) { cycle.endDetection = sawRunning ? 'timeout-running' : 'timeout'; cycle.timeoutAfterMs = Date.now() - t0; }
      cycle.turnMs = Date.now() - t0;
      cycle.sawEmployeeBusy = sawBound;
      cycle.busyEmployees = [...busyIds];
      cycle.maxConcurrentBusy = maxBusy;
      cycle.sessionRunningAtEnd = running;
      cycle.listedSession = cycle.sessionMissingPolls ? false : true;
      // 收尾观察：真对话结束后，办公室绑定必须在 180s 内释放。
      // 同时区分两种"忙"：交付后的展示 + 走回漫游是**正常**的（movement=moving），
      // 而报告过的缺陷是"卡在 working 且静止"——只有后者算冻结。
      const releaseDeadline = Date.now() + 180_000;
      let released = false;
      let releasedAfterMs = null;
      let frozenSince = null;
      while (Date.now() < releaseDeadline && !exited) {
        const row = await sampleOnce(`settle:${activeSession.promptIndex}`);
        if (row.presented === false || row.simPaused === true) { cycle.releaseEvaluated = false; cycle.releaseSkipReason = row.presented === false ? 'not-presented' : 'simulation-paused'; break; }
        const staff = (row.office && row.office.staff) || [];
        const busy = staff.filter((s) => s.bound || s.activity === 'working');
        const frozen = busy.filter((s) => s.movement === 'stationary');
        if (frozen.length) { if (frozenSince === null) frozenSince = Date.now(); }
        else frozenSince = null;
        if (frozenSince !== null && Date.now() - frozenSince > 90_000) {
          violation('STUCK_WORKING_FROZEN', { note: 'bound employee stationary >90s after the turn ended', sessionId: cycle.sessionId, frozen: frozen.map((s) => `${s.id}:${s.activity}`), staff: staff.map((s) => `${s.id}:${s.activity}${s.bound ? '/B' : ''}:${s.movement}`) });
          frozenSince = null; // 只报一次
        }
        if (!busy.length) { released = true; releasedAfterMs = Date.now() - (t0 + cycle.turnMs); break; }
        await sleep(3000);
      }
      cycle.bindingReleased = released;
      cycle.releasedAfterMs = releasedAfterMs;
      cycle.syncAtEnd = state.lastSample ? state.lastSample.sync : null;
      cycle.staffAtEnd = state.lastSample && state.lastSample.staff ? state.lastSample.staff.map((s) => `${s.id}:${s.activity}${s.bound ? '/bound' : ''}`) : null;
      const lastResult = state.lastSample && state.lastSample.staff ? state.lastSample.staff.map((s) => s.result).filter(Boolean) : [];
      cycle.lastResultOutcomes = lastResult;
      // 卡住类判据只在这两个前提下成立：① 本轮确实有人被绑上（否则无可释放）；
      // ② 收尾期间"有人在看且仿真在跑"（锁屏/息屏期间的绑定行为不适用）。
      if (cycle.releaseEvaluated === false) {
        cycle.releaseNote = `release check suppressed (${cycle.releaseSkipReason})`;
        log(`release check suppressed (${cycle.releaseSkipReason}) for ${cycle.sessionShort}`);
      } else if (sawBound && !released) {
        violation('STUCK_WORKING', { note: 'employee was bound during the turn but is still bound/working 180s after it ended', sessionId: cycle.sessionId, staff: cycle.staffAtEnd });
      }
      if (state.lastSample && state.lastSample.sync === 'stale') violation('SYNC_STALE_AFTER_TURN', { sessionId: cycle.sessionId });
      log(`turn done: ${cycle.sessionShort} turn=${(cycle.turnMs / 1000).toFixed(0)}s followWait=${(cycle.followWaitMs / 1000).toFixed(0)}s detection=${cycle.endDetection} busySaw=${sawBound}${busyIds.size ? `(${[...busyIds].join(',')} max ${maxBusy})` : ''} released=${released}${releasedAfterMs !== null ? ` (+${(releasedAfterMs / 1000).toFixed(0)}s)` : ''} outcomes=${JSON.stringify(cycle.lastResultOutcomes)}`);
    } catch (err) {
      cycle.error = err.message;
      log(`turn cycle failed: ${err.message}`);
    }
    cycles.push(cycle);
    try { fs.writeFileSync(cyclesFile, JSON.stringify(cycles, null, 2)); } catch { /* best effort */ }
    return cycle;
  }

  async function switchView(target) {
    if (!rail) return false;
    const expr = target === 'harness'
      ? 'window.officeRail.switchView("harness").then((r) => r && (r.ok === undefined ? true : r.ok))'
      : 'window.officeRail.toggleOffice().then((r) => r && (r.ok === undefined ? true : r.ok))';
    try {
      const ok = await rail.eval(expr, 20_000);
      log(`view switch → ${target}: ${ok === false ? 'refused' : 'ok'}`);
      return ok !== false;
    } catch (err) { log(`view switch → ${target} failed: ${err.message}`); return false; }
  }

  writeJson('plan.json', {
    startedAt: new Date().toISOString(), evidence: EVIDENCE, runDir,
    durationMs: DURATION_MS, runtimeVersion, protocol, runtimeSource: seeded.src,
    app: APP_PATH || 'dev electron .', repo: REPO, dshHomeSource: DSH_HOME_SRC,
    sampleIntervalMs: SAMPLE_INTERVAL_MS, turnIntervalMs: TURN_INTERVAL_MS, switchIntervalMs: SWITCH_INTERVAL_MS,
    appVersion: require(path.join(REPO, 'package.json')).version,
    prompts: PROMPTS,
  });

  // 起手基线采样 + 一张基线截图（供用户目检）
  await sleep(20_000);
  await sampleOnce('baseline');
  try { if (await office.screenshot(path.join(shotsDir, `00-baseline.png`))) shotsTaken += 1; } catch { /* screenshot optional */ }

  const endAt = startedAt + DURATION_MS;
  let lastSampleAt = 0;
  let turnPromise = null; // 对话轮在后台跑：切视图/采样不被一轮对话阻塞
  while (Date.now() < endAt && !exited) {
    tailer.scan();
    const now = Date.now();
    if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) { lastSampleAt = now; await sampleOnce('idle'); }
    if (!NO_SWITCH && backToOfficeAt && now >= backToOfficeAt) {
      await switchView('office');
      state.viewActive = true;
      state.lastReturnAt = now;
      state.staticSince = null;
      backToOfficeAt = null;
      // 回前台 90s 内不得停在 static（有界恢复是允许的，锁死不是）
      setTimeout(async () => {
        const row = await sampleOnce('after-return');
        const off = row.office;
        // 只在"有人在看"时判定（锁屏/息屏期间的 static 是诚实结果，不是回归）
        if (row.presented !== false && off && (off.mode === 'static' || off.code === 'LOW_FPS_PERSISTENT')) {
          violation('RENDER_LATCHED_AFTER_RETURN', { mode: off.mode, code: off.code, fps: off.fps, recoveryAttempts: off.recoveryAttempts, note: '90s after returning to the office view' });
        }
        if (shotsTaken < 12) { try { if (await office.screenshot(path.join(shotsDir, `${String(++shotsTaken).padStart(2, '0')}-after-return.png`))) shotsTaken += 1; } catch { /* optional */ } }
      }, 90_000);
    }
    if (!NO_SWITCH && !backToOfficeAt && now >= nextSwitchAt) {
      if (await switchView('harness')) {
        state.viewActive = false;
        backToOfficeAt = now + SWITCH_HOLD_MS;
        nextSwitchAt = now + SWITCH_INTERVAL_MS;
      } else {
        nextSwitchAt = now + 60_000; // rail 不可用：稍后再试
      }
    }
    if (!NO_CONVERSATION && !turnPromise && now >= nextTurnAt) {
      turnPromise = runTurnCycle()
        .catch((err) => log(`turn cycle threw: ${err.message}`))
        .finally(() => { turnPromise = null; nextTurnAt = Date.now() + TURN_INTERVAL_MS; });
    }
    await sleep(1000);
  }
  if (turnPromise) { log('waiting for the in-flight turn cycle to settle…'); await Promise.race([turnPromise, sleep(180_000)]); }

  if (exited) violation('APP_EXITED_EARLY', { exited, note: 'app process exited before the soak window closed' });

  // --- 4) 收尾：优雅退出 + 证据
  tailer.scan();
  writeJson('violations.json', violations);
  log(`soak window closed; samples=${samples.length} violations=${violations.length}; shutting down`);
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const exitDeadline = Date.now() + 20_000;
  while (!exited && Date.now() < exitDeadline) await sleep(300);
  if (!exited) { log('app did not exit after SIGTERM — killing tree'); killTree(child, 'SIGKILL'); await sleep(2000); }

  const rssSeries = samples.filter((s) => typeof s.rssMb === 'number');
  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationMin: Math.round((Date.now() - startedAt) / 60000),
    runtimeVersion, protocol,
    app: APP_PATH || 'dev electron .',
    samples: samples.length,
    samplesWithOffice: samples.filter((s) => s.office).length,
    memory: {
      firstRssMb: rssSeries.length ? rssSeries[0].rssMb : null,
      lastRssMb: rssSeries.length ? rssSeries[rssSeries.length - 1].rssMb : null,
      minRssMb: state.minRssMb, maxRssMb: state.maxRssMb,
      lastQuarterAvgMb: rssSeries.length >= 4 ? Math.round(rssSeries.slice(-Math.ceil(rssSeries.length / 4)).reduce((s, r) => s + r.rssMb, 0) / Math.ceil(rssSeries.length / 4) * 10) / 10 : null,
    },
    cpu: {
      avg: rssSeries.length ? Math.round(samples.reduce((s, r) => s + (r.cpuPct || 0), 0) / samples.length * 10) / 10 : null,
      max: rssSeries.length ? Math.max(...samples.map((r) => r.cpuPct || 0)) : null,
    },
    rendererModes: (() => {
      const modes = {};
      for (const s of samples) { const m = s.office && s.office.mode; if (m) modes[m] = (modes[m] || 0) + 1; }
      return modes;
    })(),
    rendererCodes: (() => {
      const codes = {};
      for (const s of samples) { const c = s.office && s.office.code; if (c) codes[c] = (codes[c] || 0) + 1; }
      return codes;
    })(),
    syncStates: (() => {
      const st = {};
      for (const s of samples) { const v = s.office && s.office.sync; if (v) st[v] = (st[v] || 0) + 1; }
      return st;
    })(),
    // 呈现覆盖：只在"有人在看"（屏幕未锁 + 显示器亮）的样本上判定渲染类不变量；
    // 锁屏/息屏期间的 latch 是设计内的诚实结果，抑制并留档（notes.json）。
    presentation: {
      presentedSamples: state.presentedSamples || 0,
      suppressedSamples: state.suppressedSamples || 0,
      unknownSamples: samples.filter((s) => s.presented === null).length,
      maxPresentedFps: samples.reduce((max, s) => (s.presented === true && s.office && s.office.fps && Number.isFinite(s.office.fps.lastFps) ? Math.max(max, s.office.fps.lastFps) : max), 0),
      presentedStaticSamples: samples.filter((s) => s.presented === true && s.office && (s.office.mode === 'static' || s.office.code === 'LOW_FPS_PERSISTENT')).length,
    },
    logCounts: Object.fromEntries(tailer.counts),
    notes,
    cycles: cycles.length,
    turns: cycles.filter((c) => c.sessionId).length,
    violations,
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
  };
  writeJson('summary.json', summary);
  writeJson('notable-log-lines.json', tailer.notable);

  // 壳日志复制（仅 .log，脱敏；运行时的 .out 不复制——含 launch token）
  const logsOut = path.join(EVIDENCE, 'shell-logs');
  try {
    fs.mkdirSync(logsOut, { recursive: true });
    for (const name of fs.readdirSync(logsDir)) {
      if (!name.endsWith('.log')) continue;
      const text = fs.readFileSync(path.join(logsDir, name), 'utf8');
      fs.writeFileSync(path.join(logsOut, name), redact(text));
    }
    log(`shell logs copied → ${logsOut}`);
  } catch (err) { log(`shell log copy failed: ${err.message}`); }

  // 清理临时目录（保留证据）
  if (!KEEP_RUN_DIR) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); log('temp run dir removed (userData + DSH_HOME copy)'); }
    catch (err) { log(`temp cleanup failed (manual removal): ${runDir} — ${err.message}`); }
  } else {
    log(`run dir kept for debugging: ${runDir}`);
  }
  office.close(); if (rail) rail.close();

  log(`VERDICT: ${summary.verdict} — violations=${violations.length}, samples=${samples.length}, turns=${summary.turns}`);
  return summary;
}

main()
  .then((summary) => {
    if (summary && summary.fatal) process.exit(2);
    process.exit(summary && summary.verdict === 'PASS' ? 0 : 1);
  })
  .catch((err) => {
    log(`FATAL: ${err && err.stack ? err.stack : err}`);
    try { process.exit(2); } catch { /* ignore */ }
  });
