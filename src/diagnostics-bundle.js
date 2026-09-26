'use strict';

// src/diagnostics-bundle.js — one-click diagnostics bundle export (P2 运维能力).
//
// Collects a SUPPORT-READY, PRIVACY-REDACTED bundle directory:
//   README.txt            privacy manifest — what IS in the bundle, what is NOT
//   manifest.json         bundle schema + per-file byte counts + generation time
//   environment.json      shell/runtime/electron/node versions, platform, arch
//   runtime-summary.json  render state (mode/code/recoveryAttempts/fps),
//                         sync state, bound-session COUNT + ROLES (no ids)
//   office-diagnostics.json  the office:diagnostics projection (codes only)
//   crashes.json          recent crash records (logTail re-redacted, no paths)
//   logs/runtime-*.log    newest shell logs, line-redacted, tail-capped
//
// PRIVACY CONTRACT (guarded below and by the final scan, fail-closed):
//   - WHITELIST ONLY: every field written here is enumerated in this file.
//     No settings.json, no credentials, no DSH_HOME/session files, no
//     prompts/tool arguments/results, no session ids, no employee ids or
//     display names, no hostnames/usernames, no raw runtime .out files.
//   - The runtime .out files (raw harness stdout) are NEVER included — they
//     have carried token/cookie material historically.
//   - Shell logs go through redactLogLine() (launch-token URLs, dsh-auth-*
//     cookies, api keys, Bearer headers, JWTs, private-key blocks, home paths).
//   - After writing, EVERY text file in the bundle is scanned again
//     (scanTextForSecrets). Any residual hit FAILS the export and the bundle
//     directory is removed — fail-closed, never "close enough".
//   - Sensitive-value shapes mirror src/office/runtime/privacy-redactor.js
//     (SECRET_VALUE_RE / cookie / session shapes) — same redaction spirit,
//     line-oriented because the input here is log text, not JSON trees.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const BUNDLE_SCHEMA_VERSION = 1;
const BUNDLE_PREFIX = 'dsh-cockpit-diagnostics-';
const MAX_LOG_FILES = 3;          // newest N shell logs (runtime-*.log only)
const MAX_LOG_LINES = 2000;       // tail cap per log file
const MAX_CRASH_RECORDS = 10;     // newest crash-*.json records
const REDACTED = '[REDACTED]';

// --- line redactor ------------------------------------------------------------

// Sensitive KEY names whose `key=value` / `key: value` payloads get redacted.
// Same key vocabulary as privacy-redactor's SECRET_KEY_RE plus cookie/token.
const SECRET_ASSIGNMENT_RE = /((?:api[-_]?key|secret|password|passwd|credential|authorization|auth|cookie|token)\s*[=:]\s*)(?!\[REDACTED\])("[^"]*"|\S+)/gi;
// Launch-token URL query (?token=... or &token=...).
const TOKEN_QUERY_RE = /([?&])token=([^&\s'"]+)/gi;
// The runtime browser-session cookies (dsh-auth-* per src/runtime-auth.js).
const DSH_COOKIE_RE = /(dsh-auth-[A-Za-z0-9-]+)(=|:\s*)([^;\s'"']+)/gi;
// Value-shape secrets — the same shapes privacy-redactor classifies as SECRET.
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{6,}/g,                      // deepseek/openai style keys
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,          // authorization headers
  /-----BEGIN [A-Z ]*-----[^-]*-----END [A-Z ]*-----?/g, // PEM blocks
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]*/g,  // JWTs
  /\bxox[baprs]-[A-Za-z0-9-]{6,}/g,             // slack tokens
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                // github tokens
];
// Very long hex blobs (raw secrets/hashes that are not display material).
const LONG_HEX_RE = /\b[0-9a-f]{40,}\b/gi;

/** Redacts one shell-log line. Home paths collapse to `~` (they carry the
 * username), every secret-shaped substring collapses to [REDACTED]. */
function redactLogLine(line, homeDir) {
  let out = String(line);
  if (homeDir && homeDir.length > 1) {
    try { out = out.split(homeDir).join('~'); } catch { /* literal split */ }
  }
  // Generic mac/unix home prefix (defense in depth; also covers foreign logs).
  out = out.replace(/\/Users\/[^/\s]+/g, '~');
  out = out.replace(TOKEN_QUERY_RE, `$1token=${REDACTED}`);
  out = out.replace(DSH_COOKIE_RE, `$1$2${REDACTED}`);
  out = out.replace(SECRET_ASSIGNMENT_RE, `$1${REDACTED}`);
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(LONG_HEX_RE, REDACTED);
  // Fail-closed residual check: if a secret-looking shape survives (a value
  // that is NOT our own [REDACTED] marker), drop the whole line.
  if (residualSecretHit(out)) return `${REDACTED}:line`;
  return out;
}

function residualSecretHit(text) {
  if (DSH_COOKIE_RE_TEST.test(text)) return true;
  if (/sk-[A-Za-z0-9_-]{6,}/.test(text)) return true;
  if (/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/i.test(text)) return true;
  if (/BEGIN [A-Z ]*PRIVATE/.test(text)) return true;
  if (/eyJ[A-Za-z0-9_-]{10,}\./.test(text)) return true;
  // key=value with a real (non-marker) value
  if (/(?:api[-_]?key|secret|password|passwd|credential|authorization|auth|cookie|token)\s*[=:]\s*(?!\[REDACTED\])(?:"[^"]*"|\S{6,})/i.test(text)) return true;
  return false;
}
const DSH_COOKIE_RE_TEST = /dsh-auth-[A-Za-z0-9-]+=(?!\[REDACTED\])[^;\s'"]+/;

// --- final bundle scan (fail-closed) ------------------------------------------

const SCAN_PATTERNS = Object.freeze([
  { kind: 'token-url', re: /[?&]token=(?!\[REDACTED\])[^&\s'"]+/ },
  { kind: 'cookie', re: /dsh-auth-[A-Za-z0-9-]+=(?!\[REDACTED\])[^;\s'"]+/ },
  { kind: 'cookie-header', re: /cookie\s*[:=]\s*(?!\[REDACTED\])("[^"]{6,}"|\S{12,})/i },
  { kind: 'api-key', re: /sk-[A-Za-z0-9_-]{6,}/ },
  { kind: 'bearer', re: /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/i },
  { kind: 'private-key', re: /BEGIN [A-Z ]*PRIVATE/ },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'secret-assignment', re: /(?:api[-_]?key|secret|password|passwd|credential)\s*[=:]\s*(?!\[REDACTED\])("[^"]{6,}"|\S{12,})/i },
]);

/** Returns [{kind, line}] for every residual secret-shaped hit. */
function scanTextForSecrets(text) {
  const findings = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const { kind, re } of SCAN_PATTERNS) {
      if (re.test(lines[i])) findings.push({ kind, line: i + 1 });
    }
  }
  return findings;
}

// --- README (privacy manifest) -------------------------------------------------

function readmeText(ctx) {
  return [
    'DshCockpit 诊断包 / DshCockpit diagnostics bundle',
    `生成时间 / generated at: ${ctx.generatedAt}`,
    `壳版本 / shell: ${ctx.shellVersion}    运行时 / runtime: ${ctx.runtimeVersion}`,
    '',
    '== 包内字段清单 / WHAT IS INSIDE (whitelist, each file enumerated) ==',
    '- manifest.json         包清单：schema 版本、生成时间、每个文件与字节数',
    '- environment.json      环境：壳版本、运行时版本、electron/node/chrome 版本、',
    '                        平台 (darwin/win32/linux)、系统类型与内核版本、CPU 架构、locale、进程运行时长',
    '- runtime-summary.json  渲染态：mode / diagnosticCode / recoveryAttempts / fps / renderProfile；',
    '                        同步态：sync（healthy/stale/resyncing 枚举）、paused；',
    '                        绑定会话：只有「数量 + 角色名 + 活动枚举 + 队列长度」；',
    '                        仿真时钟概要：ticks / catchUpTicks / simPerWall / 事件循环分位（均为数字）',
    '- office-diagnostics.json  办公室模块诊断（office:diagnostics 投影）：',
    '                        diagnostics 环只有 {atMs, code, count}（固定诊断码词表），',
    '                        不含任何事件正文',
    '- crashes.json          最近崩溃记录：时间、退出码/信号、壳与运行时版本、',
    '                        日志尾部（同样逐行脱敏，且已去掉文件路径）',
    '- logs/runtime-*.log    最近的壳日志（最多 3 个、每文件最多 2000 行尾摘），',
    '                        逐行脱敏：token URL、dsh-auth-* cookie、各类 key、',
    '                        Bearer/JWT/私钥块、长十六进制串；家目录路径折叠为 ~',
    '',
    '== 不含什么 / WHAT IS NOT INSIDE (guaranteed absent, enforced by scan) ==',
    '- 不含任何 API key / cookie / launch token / Bearer / JWT / 私钥',
    '  （写包前逐行脱敏；写包后再全文扫描，任何残留命中即整个导出失败并删除包目录）',
    '- 不含任何 prompt / 工具参数 / 工具结果 / 消息正文（结构上不采集）',
    '- 不含任何会话 id、员工 id、员工显示名、文件路径中的用户名（家目录折叠为 ~）',
    '- 不含 settings.json / credentials / DSH_HOME 下任何文件 / 原始 runtime .out',
    '  （.out 是 harness 原始输出，历史上带过 token/cookie，永不入包）',
    '',
    '复现方法 / reproducibility: 每个文件的生成逻辑都在 src/diagnostics-bundle.js，',
    '字段为封闭白名单；本 README 由同一模块生成，与包内容同源。',
    '',
    'This bundle contains version/platform metrics, coarse enum states, numeric',
    'timings, redacted log lines and crash codes ONLY. Share it with a',
    'maintainer without further editing.',
    '',
  ].join('\n');
}

// --- helpers -------------------------------------------------------------------

function sha256File(file) {
  const h = crypto.createHash('sha256');
  try {
    h.update(fs.readFileSync(file));
    return h.digest('hex');
  } catch { return null; }
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function newestMatching(dir, re, limit) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => re.test(n));
  } catch { return []; }
  return names
    .map((n) => {
      const p = path.join(dir, n);
      let m = 0;
      try { m = fs.statSync(p).mtimeMs; } catch { return null; }
      return { name: n, p, m };
    })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .slice(0, limit);
}

// --- factory -------------------------------------------------------------------

/**
 * createDiagnosticsBundle(deps) — all deps injected; pure Node, no Electron.
 *   appVersion() -> string
 *   runtimeVersion() -> string (active runtime version or '')
 *   runtimeState() -> coarse string ('stopped'|'starting'|'running'|...)
 *   logDir() -> shell log directory (runtime-*.log)
 *   crashDir() -> crash-*.json directory (or null)
 *   officeDiagnostics() -> office:diagnostics snapshot or null
 *   officeEmployees() -> [{role, activity, movement, bound, bindingSource, queueCount}] or []
 *   locale() -> string
 *   home() -> home dir (for path folding)
 *   now() -> Date
 */
function createDiagnosticsBundle(deps) {
  const d = deps || {};
  const appVersion = () => String(d.appVersion ? d.appVersion() : 'dev');
  const homeDir = () => (d.home ? d.home() : os.homedir());
  const now = () => (d.now ? d.now() : new Date());

  function collectEnvironment() {
    return {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      shellVersion: appVersion(),
      runtimeVersion: String(d.runtimeVersion ? d.runtimeVersion() : ''),
      runtimeState: String(d.runtimeState ? d.runtimeState() : 'unknown'),
      platform: process.platform,
      osType: os.type(),
      osRelease: os.release(),
      arch: process.arch,
      electron: process.versions.electron || null,
      node: process.versions.node || null,
      chrome: process.versions.chrome || null,
      locale: String(d.locale ? d.locale() : ''),
      uptimeSeconds: Math.round(process.uptime()),
      // Deliberately ABSENT: hostname, username, home path, cwd, env, settings
      // paths (see README.txt).
    };
  }

  function collectRuntimeSummary() {
    const office = d.officeDiagnostics ? d.officeDiagnostics() : null;
    const employees = (d.officeEmployees ? d.officeEmployees() : []) || [];
    const bound = employees.filter((e) => e && e.bound);
    const renderer = office && office.renderer ? { ...office.renderer } : null;
    const clock = office && office.clock
      ? {
          running: office.clock.running, ticks: office.clock.ticks,
          catchUpTicks: office.clock.catchUpTicks, lateFires: office.clock.lateFires,
          meanBehindMs: office.clock.meanBehindMs, maxBehindMs: office.clock.maxBehindMs,
          droppedDebtMs: office.clock.droppedDebtMs, simulatedPerWall: office.clock.simulatedPerWall,
          eventLoop: office.clock.eventLoop ? { ...office.clock.eventLoop } : null,
        }
      : null;
    return {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      generatedAt: now().toISOString(),
      runtimeState: String(d.runtimeState ? d.runtimeState() : 'unknown'),
      render: renderer,
      sync: office ? office.sync : null,
      paused: office ? office.paused : null,
      employeeCount: office ? office.employeeCount : employees.length,
      sessions: {
        boundCount: bound.length,
        roles: [...new Set(bound.map((e) => String(e.role)).filter(Boolean))].sort(),
        // Per-employee coarse state ONLY: role + enum activity/movement +
        // queue length. No employeeId, no displayName, no session id, no
        // task text, no tool names/arguments (privacy contract).
        employees: employees.map((e) => ({
          role: e.role,
          activity: e.activity,
          movement: e.movement,
          bound: !!e.bound,
          bindingSource: e.bound ? e.bindingSource : null,
          queueCount: e.queueCount,
        })),
      },
      clock,
    };
  }

  function collectOfficeDiagnostics() {
    const office = d.officeDiagnostics ? d.officeDiagnostics() : null;
    if (!office) return null;
    return {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      projectedFrom: 'office:diagnostics',
      simulatedAtMs: office.simulatedAtMs,
      sync: office.sync,
      paused: office.paused,
      employeeCount: office.employeeCount,
      activityLogSize: office.activityLogSize,
      packPresent: office.packPresent,
      adapterCount: office.adapterCount,
      renderer: office.renderer ? { ...office.renderer } : null,
      clock: office.clock ? JSON.parse(JSON.stringify(office.clock)) : null,
      // diagnostics ring entries are {atMs, code, count} — fixed app
      // vocabulary, no payload text ever enters this ring.
      diagnostics: (office.diagnostics || []).map((e) => ({ atMs: e.atMs, code: e.code, count: e.count })),
      // Deliberately ABSENT: activityLog content, usage (costs/budgets),
      // pending requests (they carry task text), employees list w/ ids.
    };
  }

  function collectCrashes() {
    const dir = d.crashDir ? d.crashDir() : null;
    if (!dir) return [];
    return newestMatching(dir, /^crash-\d+\.json$/, MAX_CRASH_RECORDS)
      .map((f) => {
        try {
          const raw = JSON.parse(fs.readFileSync(f.p, 'utf8'));
          return {
            ts: raw.ts,
            code: raw.code,
            signal: raw.signal,
            activeVersion: raw.activeVersion,
            // logTail is raw shell-log text: re-redact line by line, and drop
            // logPath (absolute path carries the username).
            logTail: typeof raw.logTail === 'string'
              ? raw.logTail.split('\n').map((l) => redactLogLine(l, homeDir())).join('\n')
              : null,
          };
        } catch { return null; }
      })
      .filter(Boolean);
  }

  function collectLogs() {
    const dir = d.logDir ? d.logDir() : null;
    if (!dir) return [];
    return newestMatching(dir, /^runtime-\d{4}-\d{2}-\d{2}T.*\.log$/, MAX_LOG_FILES)
      .map((f) => {
        try {
          const all = fs.readFileSync(f.p, 'utf8').split('\n');
          if (all.length > 0 && all[all.length - 1] === '') all.pop(); // trailing newline is not a line
          const tail = all.slice(-MAX_LOG_LINES).map((l) => redactLogLine(l, homeDir()));
          return { name: f.name, text: tail.join('\n'), lines: tail.length };
        } catch { return null; }
      })
      .filter(Boolean);
  }

  /**
   * build(targetDir) — creates <targetDir>/dsh-cockpit-diagnostics-<stamp>/
   * Returns {ok:true, path, bytes, files:[{name, bytes}], redaction:{scannedFiles, findings}}
   * or {ok:false, error, code}.
   */
  async function build(targetDir) {
    const generatedAt = now().toISOString();
    const stamp = generatedAt.replace(/[:.]/g, '-').replace(/T/, '-').slice(0, 19);
    const bundleDir = path.join(targetDir, `${BUNDLE_PREFIX}${stamp}`);
    const written = [];

    try {
      fs.mkdirSync(bundleDir, { recursive: true });
      const environment = collectEnvironment();
      const summary = collectRuntimeSummary();
      const office = collectOfficeDiagnostics();
      const crashes = collectCrashes();
      const logs = collectLogs();

      const files = [
        ['environment.json', JSON.stringify(environment, null, 2)],
        ['runtime-summary.json', JSON.stringify(summary, null, 2)],
        // always present: JSON null when the office module was not running —
        // a missing file is indistinguishable from a lost file downstream.
        ['office-diagnostics.json', JSON.stringify(office, null, 2)],
        ['crashes.json', JSON.stringify({ schemaVersion: BUNDLE_SCHEMA_VERSION, count: crashes.length, records: crashes }, null, 2)],
      ];
      for (const lg of logs) files.push([path.join('logs', lg.name), lg.text]);

      const ctx = {
        generatedAt,
        shellVersion: environment.shellVersion,
        runtimeVersion: environment.runtimeVersion,
      };
      files.push(['README.txt', readmeText(ctx)]);
      // manifest last so it can carry the real per-file byte counts
      const manifest = {
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        kind: 'dsh-cockpit-diagnostics',
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        generatedAt,
        shellVersion: environment.shellVersion,
        runtimeVersion: environment.runtimeVersion,
        privacy: 'see README.txt (whitelist fields; secrets/cookies/tokens/prompts/session-ids excluded; fail-closed final scan)',
        files: [],
      };

      for (const [rel, text] of files) {
        if (text === null || text === undefined) continue;
        const dest = path.join(bundleDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
        written.push({ name: rel, bytes: Buffer.byteLength(text, 'utf8') });
      }

      // Fail-closed final scan over EVERY written text file (plus the
      // manifest about to be written). Any residual secret shape fails the
      // whole export and removes the bundle directory.
      const findings = [];
      for (const w of written) {
        const p = path.join(bundleDir, w.name);
        const found = scanTextForSecrets(fs.readFileSync(p, 'utf8'));
        for (const f of found) findings.push({ file: w.name, ...f });
      }
      if (findings.length > 0) {
        try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* best effort */ }
        return {
          ok: false,
          code: 'SECRET_SCAN_FAILED',
          error: `redaction residual detected: ${findings.slice(0, 5).map((f) => `${f.kind}@${f.file}:${f.line}`).join(', ')}`,
          findings,
        };
      }

      manifest.files = written.map((w) => ({ name: w.name, bytes: w.bytes, sha256: sha256File(path.join(bundleDir, w.name)) }));
      const manifestText = JSON.stringify(manifest, null, 2);
      fs.writeFileSync(path.join(bundleDir, 'manifest.json'), manifestText);
      written.push({ name: 'manifest.json', bytes: Buffer.byteLength(manifestText, 'utf8') });

      const bytes = written.reduce((acc, w) => acc + w.bytes, 0);
      return {
        ok: true,
        path: bundleDir,
        bytes,
        bytesHuman: humanBytes(bytes),
        files: written,
        redaction: { scannedFiles: written.length, findings: [] },
      };
    } catch (error) {
      try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, code: 'EXPORT_FAILED', error: error && error.message ? error.message : String(error) };
    }
  }

  return {
    build,
    redactLogLine: (line) => redactLogLine(line, homeDir()),
    scanTextForSecrets,
    collectEnvironment,
    collectRuntimeSummary,
    collectOfficeDiagnostics,
    collectCrashes,
    collectLogs,
    humanBytes,
    BUNDLE_SCHEMA_VERSION,
    BUNDLE_PREFIX,
  };
}

module.exports = {
  createDiagnosticsBundle,
  redactLogLine,
  scanTextForSecrets,
  humanBytes,
  BUNDLE_SCHEMA_VERSION,
  BUNDLE_PREFIX,
};
