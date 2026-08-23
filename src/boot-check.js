// src/boot-check.js — startup environment self-check + one-click repair (R1).
//
// Read-only diagnostics over the six boot-critical domains, persisted as a
// structured report under userData/diagnostics/boot-report.json. Repairs are
// strictly whitelisted to the runtime layer and the profile symlink layer —
// sessions/, settings.json and runtime-state.json formats are never touched
// (repair only deletes corrupted runtime trees or symlink farms that dsh
// rebuilds itself on next start; see DESIGN.md §10 "delete links, dsh heals").
//
// Report shape (stable contract consumed by the settings → About page):
//   { at, shellVersion, overall: 'ok'|'degraded'|'failed',
//     summary: { total, passed, failed, fixable, degraded },
//     results: [{ id, ok, fixable, detail, severity }] }
// severity: 'error' (hard failure → overall failed) | 'warning'
// (compatibility degradation, e.g. a newer Harness wrote ~/.dsh in the v1
// credential layout the active runtime cannot read → overall degraded).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const semver = require('semver');

const DSH_PACKAGE_PARTS = ['@deepseek-ai', 'dsh'];
const CREDENTIALS_FILE = '.credentials.yaml';
const PROBE_FILE = '.__dsh_cockpit_write_probe';
const VERSION_PROBE_TIMEOUT_MS = 10_000;
/** First upstream release that reads/writes the v1 (version+refs)
 * credential layout; older runtimes only understand the flat layout. */
const V1_CREDENTIALS_SINCE = '0.1.1';

/** Check ids in stable report order. */
const CHECK_IDS = [
  'runtime.bin',
  'runtime.pointer',
  'dshhome.writable',
  'profile.links',
  'port.available',
  'credentials.exists',
  'credentials.layout',
];

/** Whether the auto self-check should run at app start (feature switch C-6).
 * Manual reruns from Settings → About ignore this switch. */
function runOnStartup(settingsData) {
  return !settingsData || settingsData.bootCheckOnStartup !== false;
}

/**
 * @param {object} deps
 * @param {string} deps.userDataDir              userData root (diagnostics live here)
 * @param {() => object} deps.effectiveSettings  settings.effective()
 * @param {(partial: object) => void} [deps.patchSettings] settings.patch (port repair)
 * @param {() => object} [deps.runtimeInfo]      manager.getInfo(): { activeVersion, activePath, installed }
 * @param {() => void} [deps.revalidateRuntime]  manager.revalidate()
 * @param {string} [deps.shellVersion]
 * @param {() => {bin: string, runAsNode: boolean}} [deps.resolveNodeBin] node used to probe the runtime
 * @param {(line: string) => void} [deps.log]
 * @param {Function} [deps.spawn]                injectable child_process.spawn (tests)
 */
function createBootCheck(deps) {
  const {
    userDataDir,
    effectiveSettings,
    patchSettings = () => {},
    runtimeInfo = () => ({ activeVersion: null, activePath: null, installed: [] }),
    revalidateRuntime = () => {},
    shellVersion = '',
    log = () => {},
    resolveNodeBin = () => ({ bin: process.execPath, runAsNode: false }),
    spawn = require('node:child_process').spawn,
  } = deps || {};

  const diagDir = () => path.join(userDataDir, 'diagnostics');
  const reportFile = () => path.join(diagDir(), 'boot-report.json');

  // --------------------------------------------------------------- helpers
  function atomicWriteJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  /** lib/bin.js of the ACTIVE runtime entry, or null. */
  function activeBinJs(info) {
    if (!info.activePath) return null;
    return path.join(info.activePath, 'node_modules', ...DSH_PACKAGE_PARTS, 'lib', 'bin.js');
  }

  /** True when p is inside the managed runtime root (userData/runtime). */
  function insideManagedRoot(p) {
    const rel = path.relative(path.join(userDataDir, 'runtime'), p);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** `<node> <bin> --version` must exit 0 within the deadline. Never throws. */
  function probeRuntimeVersion(binJs, env) {
    const node = resolveNodeBin();
    if (!node || !node.bin) return Promise.resolve({ ok: false, detail: 'no node binary available' });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(node.bin, [binJs, '--version'], {
          env,
          cwd: path.dirname(binJs),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (err) {
        resolve({ ok: false, detail: err.message });
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, detail: '--version timed out' });
      }, VERSION_PROBE_TIMEOUT_MS);
      child.stdout && child.stdout.on('data', (d) => { out += String(d); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, detail: err.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { resolve({ ok: false, detail: `--version exited ${code}` }); return; }
        const m = String(out).trim().match(/(\d+\.\d+\.\d+[^\s]*)/);
        resolve({ ok: true, detail: m ? `dsh ${m[1]}` : '--version ok' });
      });
    });
  }

  /** Try to bind 127.0.0.1:<port>; resolves true when free. */
  function portFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; try { srv.close(); } catch { /* ignore */ } resolve(v); } };
      srv.once('error', (err) => done(err.code === 'EADDRINUSE' ? false : err.code));
      srv.listen(port, '127.0.0.1', () => done(true));
    });
  }

  /**
   * Inspect one entry of a node_modules link farm. Package entries must be
   * symlinks/junctions pointing at a live target; @scope directories are
   * traversed one level. Returns '' when healthy, else the problem text.
   */
  function inspectFarmEntry(dirPath, name, depth) {
    const p = path.join(dirPath, name);
    let st;
    try { st = fs.lstatSync(p); } catch (err) { return `${name}: unreadable (${err.code || err.message})`; }
    if (st.isSymbolicLink()) {
      try { fs.statSync(p); } catch { return `${name}: dangling link`; }
      return '';
    }
    if (st.isDirectory()) {
      if (depth === 0 && name.startsWith('@')) {
        let children = [];
        try { children = fs.readdirSync(p).filter((c) => !c.startsWith('.')); } catch { return `${name}: unreadable scope dir`; }
        for (const c of children) {
          const problem = inspectFarmEntry(p, c, depth + 1);
          if (problem) return problem;
        }
        return '';
      }
      return `${name}: real directory where a link is expected (corrupt junction farm)`;
    }
    return `${name}: unexpected regular file in node_modules`;
  }

  // ---------------------------------------------------------------- checks
  async function checkRuntimeBin(cfg, info) {
    const binJs = activeBinJs(info);
    if (!info.activeVersion || !binJs) return { id: 'runtime.bin', ok: false, fixable: false, detail: 'no active runtime entry' };
    if (!fs.existsSync(binJs)) return { id: 'runtime.bin', ok: false, fixable: false, detail: `missing ${binJs}` };
    const env = { ...process.env, DSH_HOME: cfg.dshHome };
    const node = resolveNodeBin();
    if (node && node.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    const probe = await probeRuntimeVersion(binJs, env);
    return { id: 'runtime.bin', ok: probe.ok, fixable: false, detail: probe.detail };
  }

  function checkRuntimePointer(info) {
    if (!info.activeVersion) return { id: 'runtime.pointer', ok: false, fixable: false, detail: 'runtime-state.json has no active version' };
    const entry = (info.installed || []).find((e) => e.version === info.activeVersion);
    if (!entry) return { id: 'runtime.pointer', ok: false, fixable: false, detail: `no installed entry for ${info.activeVersion}` };
    const binJs = path.join(entry.path, 'node_modules', ...DSH_PACKAGE_PARTS, 'lib', 'bin.js');
    if (fs.existsSync(binJs)) return { id: 'runtime.pointer', ok: true, fixable: false, detail: `${entry.source}/${entry.version}` };
    const fixable = entry.source === 'managed' && insideManagedRoot(entry.path);
    return {
      id: 'runtime.pointer',
      ok: false,
      fixable,
      detail: fixable
        ? `corrupt managed install at ${entry.path} (repair clears it for reinstall)`
        : `entry for ${info.activeVersion} points outside userData/runtime (${entry.path})`,
      corruptManagedPath: fixable ? entry.path : undefined,
    };
  }

  function checkDshHomeWritable(cfg) {
    const home = cfg.dshHome;
    if (!home) return { id: 'dshhome.writable', ok: false, fixable: false, detail: 'DSH_HOME not configured' };
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, PROBE_FILE), 'probe');
      try { fs.rmSync(path.join(home, PROBE_FILE), { force: true }); } catch { /* best effort */ }
    } catch (err) {
      return { id: 'dshhome.writable', ok: false, fixable: false, detail: `not writable: ${err.message}` };
    }
    return { id: 'dshhome.writable', ok: true, fixable: false, detail: home };
  }

  function checkProfileLinks(cfg) {
    const farm = path.join(cfg.dshHome, 'profiles', 'node_modules');
    let entries = [];
    try { entries = fs.readdirSync(farm).filter((n) => !n.startsWith('.')); }
    catch (err) {
      if (err.code === 'ENOENT') return { id: 'profile.links', ok: true, fixable: false, detail: 'absent — dsh will create it on next start' };
      return { id: 'profile.links', ok: false, fixable: true, detail: `unreadable: ${err.message}`, farm };
    }
    for (const name of entries) {
      const problem = inspectFarmEntry(farm, name, 0);
      if (problem) {
        return { id: 'profile.links', ok: false, fixable: true, detail: `${problem} — repair removes the farm so dsh self-heals`, farm };
      }
    }
    return { id: 'profile.links', ok: true, fixable: false, detail: `${entries.length} top-level entr(ies) healthy` };
  }

  async function checkPortAvailable(cfg) {
    const port = Number(cfg.port) || 0;
    if (!port) return { id: 'port.available', ok: true, fixable: false, detail: 'os-assigned (0)' };
    const free = await portFree(port);
    return free
      ? { id: 'port.available', ok: true, fixable: false, detail: `127.0.0.1:${port} bindable` }
      : { id: 'port.available', ok: false, fixable: true, detail: `port ${port} occupied — repair switches to os-assigned`, port };
  }

  function checkCredentialsExist(cfg) {
    const file = path.join(cfg.dshHome, CREDENTIALS_FILE);
    // existence only — the file is NEVER read here (C-4 / privacy)
    const exists = fs.existsSync(file);
    return exists
      ? { id: 'credentials.exists', ok: true, fixable: false, detail: 'credentials file present' }
      : { id: 'credentials.exists', ok: false, fixable: false, detail: `no ${CREDENTIALS_FILE} in DSH_HOME — configure the API key` };
  }

  /**
   * Read-only layout probe for .credentials.yaml (H5): classifies the file as
   * the legacy flat layout or the v1 (version + refs) nested layout. Only
   * line SHAPES are inspected — no values are ever captured or reported.
   * Returns 'absent' | 'empty' | 'unreadable' | 'flat' | 'v1'.
   */
  function detectCredentialsLayout(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err && err.code === 'ENOENT') return 'absent';
      return 'unreadable';
    }
    if (!String(text).trim()) return 'empty';
    const lines = String(text).split(/\r?\n/);
    const hasTopLevelVersion = lines.some((l) => /^version\s*:/.test(l));
    const hasRefs = lines.some((l) => /^\s*refs\s*:/.test(l));
    return hasTopLevelVersion && hasRefs ? 'v1' : 'flat';
  }

  function checkCredentialsLayout(cfg, info) {
    const file = path.join(cfg.dshHome, CREDENTIALS_FILE);
    const layout = detectCredentialsLayout(file);
    const runtimeVersion = String((info && info.activeVersion) || '');
    const coerced = semver.coerce(runtimeVersion);
    const supportsV1 = !!coerced && semver.gte(coerced, V1_CREDENTIALS_SINCE);
    if (layout === 'absent' || layout === 'empty') {
      return { id: 'credentials.layout', ok: true, fixable: false, severity: 'warning', detail: `${layout} — nothing to classify` };
    }
    if (layout === 'unreadable') {
      return { id: 'credentials.layout', ok: false, fixable: false, severity: 'warning', detail: 'cannot read the credentials file (permissions?)' };
    }
    if (layout === 'v1' && !supportsV1) {
      return {
        id: 'credentials.layout',
        ok: false,
        fixable: false,
        severity: 'warning',
        detail: `data written by a NEWER Harness (v1 credentials layout); active runtime ${runtimeVersion || '(none)'} only reads the flat layout — upgrade the runtime`,
      };
    }
    if (layout === 'flat' && supportsV1) {
      return {
        id: 'credentials.layout',
        ok: true,
        fixable: false,
        severity: 'warning',
        detail: `legacy flat layout; runtime ${runtimeVersion} auto-migrates it on load`,
      };
    }
    return { id: 'credentials.layout', ok: true, fixable: false, severity: 'warning', detail: `${layout} layout matches runtime ${runtimeVersion}` };
  }

  // --------------------------------------------------------------- repairs
  /** Whitelisted fixes only: profile link farm, corrupted managed runtime dir,
   * occupied port → os-assigned. Everything else is reported, never touched. */
  function repairOne(result) {
    switch (result.id) {
      case 'profile.links': {
        try {
          fs.rmSync(result.farm, { recursive: true, force: true });
          log(`[boot-check] removed profile link farm ${result.farm} (dsh will self-heal)`);
          return true;
        } catch (err) { log(`[boot-check] farm removal failed: ${err.message}`); return false; }
      }
      case 'runtime.pointer': {
        if (!result.corruptManagedPath) return false;
        try {
          fs.rmSync(result.corruptManagedPath, { recursive: true, force: true });
          revalidateRuntime(); // drops now-stale installed entries (existing manager logic)
          log(`[boot-check] cleared corrupt managed runtime ${result.corruptManagedPath}`);
          return true;
        } catch (err) { log(`[boot-check] runtime cleanup failed: ${err.message}`); return false; }
      }
      case 'port.available': {
        try {
          patchSettings({ port: 0 });
          log('[boot-check] port conflict: switched to os-assigned port (0)');
          return true;
        } catch (err) { log(`[boot-check] port repair failed: ${err.message}`); return false; }
      }
      default:
        return false; // non-fixable checks are never "repaired"
    }
  }

  // ------------------------------------------------------------------ api
  let lastRichResults = []; // rich check results (repair needs farm/path fields)

  async function runChecks() {
    const cfg = effectiveSettings();
    const info = runtimeInfo();
    const results = [];
    results.push(await checkRuntimeBin(cfg, info));
    results.push(checkRuntimePointer(info));
    results.push(checkDshHomeWritable(cfg));
    results.push(checkProfileLinks(cfg));
    results.push(await checkPortAvailable(cfg));
    results.push(checkCredentialsExist(cfg));
    results.push(checkCredentialsLayout(cfg, info));
    for (const r of results) if (r.severity === undefined) r.severity = 'error';
    lastRichResults = results;
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    const degraded = results.filter((r) => !r.ok && r.severity === 'warning').length;
    const report = {
      at: new Date().toISOString(),
      shellVersion,
      overall: failed === 0 ? 'ok' : (degraded === failed ? 'degraded' : 'failed'),
      summary: { total: results.length, passed, failed, fixable: results.filter((r) => !r.ok && r.fixable).length, degraded },
      results: results.map(({ id, ok, fixable, detail, severity }) => ({ id, ok, fixable, detail, severity })),
    };
    try { atomicWriteJson(reportFile(), report); } catch (err) { log(`[boot-check] report write failed: ${err.message}`); }
    log(`[boot-check] ${passed}/${results.length} checks passed (fixable=${report.summary.fixable}, degraded=${degraded})`);
    return report;
  }

  /** Repair the given check ids (default: every failed+fixable), then re-run.
   * Uses the rich in-memory results from the freshest run — the persisted
   * report intentionally carries only the stable public fields. */
  async function repair(ids) {
    const current = await runChecks();
    const rich = new Map(lastRichResults.map((r) => [r.id, r]));
    const wanted = Array.isArray(ids) && ids.length
      ? new Set(ids)
      : new Set(current.results.filter((r) => !r.ok && r.fixable).map((r) => r.id));
    const repaired = [];
    const skipped = [];
    for (const id of wanted) {
      const result = rich.get(id);
      if (!result || result.ok || !result.fixable) { skipped.push(id); continue; }
      if (repairOne(result)) repaired.push(id);
      else skipped.push(id);
    }
    const report = await runChecks();
    return { report, repaired, skipped };
  }

  /** Latest persisted report, or null when none exists yet. */
  function readReport() {
    try { return JSON.parse(fs.readFileSync(reportFile(), 'utf8')); } catch { return null; }
  }

  return { runChecks, repair, readReport, reportFile };
}

module.exports = { createBootCheck, runOnStartup, CHECK_IDS };
