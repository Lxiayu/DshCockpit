// scripts/upstream-compat-smoke.js — verify one @deepseek-ai/dsh release
// installs and boots on this platform (the R2 "who declared compat first"
// pipeline). Runs three gates, mirrors the shell's own boot path:
//   1. install   : scripts/prepare-runtime.js <version> (arborist-grade npm
//                  tree into vendor/runtime/<version>, validated + atomic)
//   2. dumpConfig: `node lib/bin.js --dump-config` exits 0 (offline smoke,
//                  identical to RuntimeManager.smokeTest)
//   3. healthCheck: boot `--profile web --port 0 --no-open`, wait for the
//                  "dsh web: http://127.0.0.1:<port>" line, GET until 200
// Emits a machine-readable verdict (JSON) so the report step can aggregate
// both platforms into docs/compat/. A failed gate is DATA, not an abort:
// the script still writes its result file (ok:false + reason) unless writing
// itself fails, so the matrix never loses the failure evidence.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PACKAGE_NAME = '@deepseek-ai/dsh';
const INSTALL_TIMEOUT_MS = 40 * 60_000;
const DUMP_TIMEOUT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 120_000;

/** Extract the runtime's printed URL from raw output.
 * dsh 0.1.2+ prints the AUTHENTICATED url (its process launch token rides as
 * `?token=…`) and answers an index request without token/cookie with 401, so the
 * whole token — not just the origin — is what the health probe must use. */
function parseUrlLine(text) {
  const m = String(text || '').match(/dsh web: (\S+)/);
  if (!m) return null;
  try {
    const url = new URL(m[1].replace(/[),.]+$/, ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Assemble the verdict document written next to the CI logs. */
function buildResult({ version, platform, startedAt, finishedAt, install, dumpConfig, healthCheck }) {
  const gates = { install, dumpConfig, healthCheck };
  const ok = Object.values(gates).every((g) => g && g.ok);
  return {
    schema: 1,
    package: PACKAGE_NAME,
    version,
    platform,
    ok,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    gates,
    // first failing reason at the top level keeps the Markdown renderer dumb
    reason: ok ? '' : Object.entries(gates).filter(([, g]) => !(g && g.ok)).map(([k, g]) => `${k}: ${g.reason}`).join('; '),
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Resolve the version under test: --version > --resolve-tag dist-tag lookup. */
function resolveExplicitVersion() {
  return argValue('--version');
}

function resolveFromDistTag(tag) {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // shell:true required on Windows — .cmd shims cannot be spawned directly
    let child;
    try {
      child = spawn(npmCmd, ['view', `${PACKAGE_NAME}@${tag}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: true });
    } catch (err) { resolve({ ok: false, version: '', reason: err.message }); return; }
    let out = '';
    child.stdout && child.stdout.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 30_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, version: '', reason: err.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const v = out.trim().split(/\r?\n/).pop().trim();
      if (code === 0 && v) resolve({ ok: true, version: v, reason: '' });
      else resolve({ ok: false, version: '', reason: `npm view exited ${code}` });
    });
  });
}

/** Run a child to completion with output captured to an fd-backed file. */
function runChild(bin, args, env, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `compat-${Date.now()}.out`);
    let fd = -1;
    try { fd = fs.openSync(outFile, 'a'); } catch { /* fall back to pipes-less ignore */ }
    let child;
    try {
      child = spawn(bin, args, { env, cwd, windowsHide: true, stdio: fd === -1 ? 'ignore' : ['ignore', fd, fd] });
    } catch (err) {
      try { if (fd !== -1) fs.closeSync(fd); } catch { /* ignore */ }
      resolve({ code: -1, output: '', reason: err.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      try { if (fd !== -1) fs.closeSync(fd); } catch { /* ignore */ }
      resolve({ code: -1, output: '', reason: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { if (fd !== -1) fs.closeSync(fd); } catch { /* ignore */ }
      let output = '';
      try { output = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      resolve({ code: code === null ? -1 : code, output, reason: '' });
    });
  });
}

async function gateInstall(version) {
  const t0 = Date.now();
  const res = await runChild(process.execPath, [path.join(ROOT, 'scripts', 'prepare-runtime.js'), '--version', version],
    { ...process.env }, ROOT, INSTALL_TIMEOUT_MS);
  return res.code === 0
    ? { ok: true, ms: Date.now() - t0, reason: '' }
    : { ok: false, ms: Date.now() - t0, reason: res.reason || `prepare-runtime exited ${res.code}` };
}

async function gateDumpConfig(runtimeBinJs, dshHome) {
  const t0 = Date.now();
  const res = await runChild(process.execPath, [runtimeBinJs, '--profile', 'web', '--dump-config'],
    { ...process.env, DSH_HOME: dshHome }, os.tmpdir(), DUMP_TIMEOUT_MS);
  return res.code === 0
    ? { ok: true, ms: Date.now() - t0, reason: '' }
    : { ok: false, ms: Date.now() - t0, reason: res.reason || `--dump-config exited ${res.code}` };
}

/** Poll the booted web UI until it answers 200 (same shape as main.js waitForHealth). */
function probeHealth(url, deadline) {
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) { resolve({ ok: false, reason: 'health check timed out' }); return; }
      const req = http.get(url, (res) => {
        res.resume();
        // 200 = index served; 3xx = the browser-auth exchange answering the
        // token URL with its cookie-minting redirect (dsh 0.1.2+).
        if (res.statusCode === 200 || (res.statusCode >= 300 && res.statusCode < 400)) { resolve({ ok: true, reason: '' }); return; }
        setTimeout(tick, 500);
      });
      req.setTimeout(3_000, () => { try { req.destroy(); } catch { /* ignore */ } setTimeout(tick, 500); });
      req.on('error', () => setTimeout(tick, 500));
    };
    tick();
  });
}

async function gateHealthCheck(runtimeBinJs, dshHome) {
  const t0 = Date.now();
  const stamp = Date.now();
  const outFile = path.join(os.tmpdir(), `compat-server-${stamp}.out`);
  let fd = -1;
  try { fd = fs.openSync(outFile, 'a'); } catch { /* ignore */ }
  const child = spawn(process.execPath, [runtimeBinJs, '--profile', 'web', '--port', '0', '--no-open'],
    { env: { ...process.env, DSH_HOME: dshHome }, cwd: os.tmpdir(), windowsHide: true, stdio: fd === -1 ? 'ignore' : ['ignore', fd, fd] });
  const finish = async (gate) => {
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref?.();
    try { if (fd !== -1) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
    return { ...gate, ms: Date.now() - t0 };
  };
  // Tail the fd log for the URL line (the runtime prints it once listening).
  const deadlineBoot = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadlineBoot) {
    let text = '';
    try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* not created yet */ }
    const url = parseUrlLine(text);
    if (url) {
      const probe = await probeHealth(url, deadlineBoot);
      if (!probe.ok) return finish(probe);
      return finish({ ok: true, reason: '' });
    }
    const exited = await Promise.race([
      new Promise((r) => { if (child.exitCode !== null) r(true); else child.once('close', () => r(true)); }),
      new Promise((r) => setTimeout(() => r(false), 500)),
    ]);
    if (exited) return finish({ ok: false, reason: `server exited early (code ${child.exitCode})` });
    await new Promise((r) => setTimeout(r, 400));
  }
  return finish({ ok: false, reason: 'URL line never appeared (boot timed out)' });
}

async function run() {
  const startedAt = Date.now();
  const platform = `${process.platform}-${os.arch()}`;
  let version = resolveExplicitVersion();
  if (!version) {
    const tag = argValue('--resolve-tag') || 'rc';
    console.log(`[compat] resolving ${PACKAGE_NAME}@${tag} …`);
    const resolved = await resolveFromDistTag(tag);
    if (!resolved.ok) {
      const result = buildResult({
        version: '', platform, startedAt, finishedAt: Date.now(),
        install: { ok: false, ms: 0, reason: resolved.reason },
        dumpConfig: { ok: false, ms: 0, reason: 'skipped' },
        healthCheck: { ok: false, ms: 0, reason: 'skipped' },
      });
      emit(result);
      process.exit(1);
    }
    version = resolved.version;
  }
  console.log(`[compat] verifying ${PACKAGE_NAME}@${version} on ${platform}`);
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-dsh-home-'));
  const install = await gateInstall(version);
  console.log(`[compat] install: ${install.ok ? 'pass' : `FAIL (${install.reason})`}`);

  let dumpConfig = { ok: false, ms: 0, reason: 'skipped (install failed)' };
  let healthCheck = { ok: false, ms: 0, reason: 'skipped (install failed)' };
  if (install.ok) {
    const binJs = path.join(ROOT, 'vendor', 'runtime', version, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js');
    dumpConfig = await gateDumpConfig(binJs, dshHome);
    console.log(`[compat] dump-config: ${dumpConfig.ok ? 'pass' : `FAIL (${dumpConfig.reason})`}`);
    healthCheck = await gateHealthCheck(binJs, dshHome);
    console.log(`[compat] health-check: ${healthCheck.ok ? 'pass' : `FAIL (${healthCheck.reason})`}`);
    try { fs.rmSync(dshHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const result = buildResult({ version, platform, startedAt, finishedAt: Date.now(), install, dumpConfig, healthCheck });
  emit(result);
  process.exit(result.ok ? 0 : 2);
}

function emit(result) {
  console.log('[compat] result: ' + JSON.stringify(result));
  const out = argValue('--out');
  if (!out) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`[compat] wrote ${out}`);
  } catch (err) {
    console.error(`[compat] cannot write result file: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  run().catch((err) => { console.error('[compat] FAILED:', err); process.exit(1); });
}

module.exports = { parseUrlLine, buildResult, probeHealth, argValue };
