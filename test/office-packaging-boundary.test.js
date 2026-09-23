'use strict';

// test/office-packaging-boundary.test.js — P5 packaging self-containment.
//
// The packaged artifact only ships src/** (+ production node_modules and
// package.json): electron-builder.js `files` is a whitelist. Any require edge
// from src/** to a tree that is NOT packaged (scripts/, test/, content/, …)
// resolves at dev time but points at a file that DOES NOT EXIST in the
// artifact — a latent MODULE_NOT_FOUND that only real packaged runs hit.
//
// The concrete case this file pins: character-pack-installer.js (product
// code) used to require '../../../scripts/office-assets/validate-character-
// pack.js'; the validator was internalized to src/office/runtime/ in P5.
//
// Assertions:
//   1. no src/** module requires a path that resolves outside src/**;
//   2. the installer's validator require resolves to a file inside src/**;
//   3. the internalized validator is the same single source of truth the
//      pack tests require.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** Resolve a require specifier the way Node does, with the .js fallback. */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // bare specifier: node built-in or dependency
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || base;
}

test('P5 boundary: no src/** module requires a path outside src/** (packaging self-containment)', () => {
  // Electron-builder ALWAYS packages the app manifest at the asar root
  // (package.json — its `main` field points at src/main.js), so a require of
  // the repo-root package.json is the one legitimate out-of-src edge.
  const PACKAGE_MANIFEST = path.join(ROOT, 'package.json');
  const offenders = [];
  for (const file of listFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // node:* built-ins and dependencies are packaged by policy
      const resolved = resolveSpecifier(file, spec);
      if (resolved === null || resolved.startsWith(SRC + path.sep)) continue;
      if (resolved === PACKAGE_MANIFEST) continue; // packaged at the asar root by policy
      offenders.push(`${path.relative(ROOT, file)} -> ${spec} (resolves to ${resolved ? path.relative(ROOT, resolved) : 'nothing'})`);
    }
  }
  assert.deepEqual(offenders, [],
    'src/** must be self-contained: the artifact ships src/** only, so a require into scripts//test//content/ would break packaged runs');
});

test('P5 boundary: the character-pack installer validates through the internalized in-src validator', () => {
  const installerPath = path.join(SRC, 'office', 'runtime', 'character-pack-installer.js');
  const src = fs.readFileSync(installerPath, 'utf8');
  assert.match(src, /require\('\.\/validate-character-pack\.js'\)/,
    'the installer requires the validator as an in-src sibling');
  assert.doesNotMatch(src, /require\(['"][^'"]*scripts\//,
    'no require edge into the dev-only scripts/ tree remains');
  const validatorPath = path.join(SRC, 'office', 'runtime', 'validate-character-pack.js');
  assert.equal(fs.existsSync(validatorPath), true, 'src/office/runtime/validate-character-pack.js exists (it ships in app.asar)');
  const validator = require(validatorPath);
  assert.equal(typeof validator.validateCharacterPack, 'function', 'the internalized validator exports validateCharacterPack');
});

test('P5 boundary: the packaged product surface ships the internalized validator (asar surface contract)', () => {
  // Mirrors scripts/verify-dist.js REQUIRED_ASAR_PATHS: the file the
  // installer requires at module level MUST be part of the packaged surface.
  const { listAsarEntries } = require('../scripts/verify-dist.js');
  const app = path.join(ROOT, 'dist', 'mac-arm64', 'DshCockpit.app', 'Contents', 'Resources', 'app.asar');
  if (!fs.existsSync(app)) {
    // No artifact on this machine — the static guarantees above still hold;
    // the artifact-side gate runs in build (node scripts/build.js) / CI.
    return;
  }
  const entries = listAsarEntries(app);
  assert.ok(entries.includes('src/office/runtime/validate-character-pack.js'),
    'app.asar ships the internalized validator');
  assert.ok(entries.includes('src/office/runtime/character-pack-installer.js'),
    'app.asar ships the installer');
});
