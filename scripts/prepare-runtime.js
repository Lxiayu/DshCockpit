// scripts/prepare-runtime.js — create the bundled runtime seed for packaging.
//
// Copies a full dsh install into vendor/runtime/<version>/ (electron-builder
// ships it via extraResources so first launch needs no download). The seed is
// generated from the discovered dsh install (npx/global) by default, or from
// the npm registry with `--registry` (clean install, slower).
//
// Usage: node scripts/prepare-runtime.js [--registry]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'runtime');

/** Run npm as a child process: streams progress straight to CI logs and has a
 * hard timeout. arborist's silent reify() gave no logs and could hang forever
 * on a slow/stuck registry (observed: 30min+ stall on Windows runner), so the
 * build seed install deliberately uses npm's battle-tested CLI instead. */
function execNpm(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, args, { cwd, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`npm install timed out after ${Math.round(timeoutMs / 60000)}min`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install exited with code ${code}`));
    });
  });
}

function firstLineOf(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch { return null; }
}

function discoverDshBin() {
  const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const shim = firstLineOf(whereCmd, ['dsh']);
  if (shim) {
    const binDir = path.dirname(shim);
    const root = path.dirname(binDir);
    const candidate = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(candidate)) return candidate;
    const candidate2 = path.join(path.dirname(root), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(candidate2)) return candidate2;
  }
  return null;
}

function dshBinMeta(binJs) {
  const m = String(binJs).match(/^(.*[\\/])node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/);
  if (!m) return null;
  const installRoot = m[1].replace(/[\\/]$/, '');
  const pkgDir = path.join(installRoot, 'node_modules', '@deepseek-ai', 'dsh');
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  return { installRoot, version };
}

async function installFromRegistry(version, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: 'dsh-runtime-seed', private: true, dependencies: { '@deepseek-ai/dsh': version } }, null, 2));
  fs.writeFileSync(path.join(dest, '.npmrc'), ['registry=https://registry.npmjs.org/', 'fund=false', 'audit=false', 'loglevel=http', 'maxsockets=10'].join('\n') + '\n');
  await execNpm(['install', '--no-audit', '--no-fund'], dest, 20 * 60_000);
}

(async () => {
  let fromRegistry = process.argv.includes('--registry');
  let version = null;
  let source = null;

  if (!fromRegistry) {
    const binJs = discoverDshBin();
    const meta = dshBinMeta(binJs);
    if (meta && meta.version) {
      version = meta.version;
      source = meta.installRoot;
      console.log(`[prepare] discovered dsh ${version} at ${source}`);
    }
  }

  if (!version) {
    // fallback: resolve the newest version from the registry and install clean
    const pacote = require('pacote');
    const packument = await pacote.packument('@deepseek-ai/dsh', { registry: 'https://registry.npmjs.org/' });
    const versions = Object.keys(packument.versions || {});
    versions.sort((a, b) => { try { return require('semver').rcompare(a, b); } catch { return 0; } });
    version = versions[0];
    fromRegistry = true;
    console.log(`[prepare] no local install; will install ${version} from registry`);
  }

  const dest = path.join(VENDOR, version);
  if (fs.existsSync(path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    console.log(`[prepare] seed already present: ${dest}`);
    process.exit(0);
  }

  if (fromRegistry) {
    console.log(`[prepare] installing ${version} from registry into ${dest} (one-time, build-time only)…`);
    await installFromRegistry(version, dest);
  } else {
    console.log(`[prepare] copying ${source} -> ${dest}…`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(source, dest, { recursive: true });
  }

  const ok = fs.existsSync(path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  if (!ok) {
    console.error('[prepare] FAILED: seed has no dsh bin.js');
    process.exit(1);
  }
  const size = Math.round((fs.readdirSync(dest, { recursive: true }).reduce((a, f) => { try { return a + fs.statSync(path.join(dest, f)).size; } catch { return a; } }, 0) / 1e6));
  console.log(`[prepare] OK: vendor/runtime/${version} (${size} MB)`);
  process.exit(0);
})().catch((e) => { console.error('[prepare] FAILED:', e); process.exit(1); });
