// test/pnpm-shim.test.js — pnpm shim resolution & PATH handling
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shim = require('../src/pnpm-shim');

function fakePnpmTree(root) {
  const bin = path.join(root, 'node_modules', 'pnpm', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pnpm.cjs'), '//fake pnpm\n');
  return path.join(bin, 'pnpm.cjs');
}

test('mapAsarUnpack rewrites packaged paths for plain-node children', () => {
  const p = path.join('/app', 'app.asar', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  const out = shim.mapAsarUnpack(p);
  assert.ok(!out.includes('app.asar' + path.sep), `unpacked path must not contain app.asar/: ${out}`);
  assert.ok(out.includes('app.asar.unpacked'), `unpacked path must contain app.asar.unpacked: ${out}`);
  // idempotent — must not double-rewrite
  assert.strictEqual(shim.mapAsarUnpack(out), out);
});

test('bundledPnpmCjs walks up to node_modules/pnpm/bin/pnpm.cjs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  const cjs = fakePnpmTree(root);
  const deep = path.join(root, 'src', 'nested', 'deep');
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(shim.bundledPnpmCjs(deep), cjs);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bundledPnpmCjs returns null when pnpm is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-empty-'));
  assert.strictEqual(shim.bundledPnpmCjs(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ensurePnpmShim writes runnable shims and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-write-'));
  const cjs = fakePnpmTree(root);
  const nodeBin = process.execPath;
  const dir = shim.ensurePnpmShim({ userDataDir: root, nodeBin, fromDir: path.join(root, 'src') });
  assert.ok(dir, 'shim dir should be produced');
  assert.ok(fs.existsSync(path.join(dir, 'pnpm')), 'nix shim file exists');
  if (process.platform === 'win32') {
    assert.ok(fs.existsSync(path.join(dir, 'pnpm.cmd')), 'win shim file exists');
  }
  // the shim runs the fake pnpm via our node. POSIX execs the extensionless
  // script; Windows needs the .cmd and a shell (extensionless files are not
  // executable there) — the same resolution `spawn('pnpm')` does via PATHEXT.
  const { spawnSync } = require('node:child_process');
  const isWin = process.platform === 'win32';
  const r = spawnSync(path.join(dir, isWin ? 'pnpm.cmd' : 'pnpm'), ['--version'], { encoding: 'utf8', shell: isWin });
  assert.strictEqual(r.status, 0, `shim exec failed: ${r.stderr}`);
  // marker prevents rewrite churn
  const mtime = fs.statSync(path.join(dir, 'pnpm')).mtimeMs;
  shim.ensurePnpmShim({ userDataDir: root, nodeBin, fromDir: path.join(root, 'src') });
  assert.strictEqual(fs.statSync(path.join(dir, 'pnpm')).mtimeMs, mtime, 'idempotent: no rewrite');
  fs.rmSync(root, { recursive: true, force: true });
});

test('prependPath keeps existing PATH content', () => {
  assert.strictEqual(shim.prependPath('/a', '/b:/c'), '/a' + path.delimiter + '/b:/c');
  assert.strictEqual(shim.prependPath('/a', ''), '/a');
  assert.strictEqual(shim.prependPath('/a', null), '/a');
});
