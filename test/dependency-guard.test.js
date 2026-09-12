// test/dependency-guard.test.js — guard against the H5/H6 class of failures:
// implicit dependencies that exist in the dev tree but are missing from the
// packaged app (→ instant crash in production), version-drift between the
// bundled toolchain and the constants that describe it, and cross-file check
// contracts that the generic i18n gates cannot see (dynamically built tr keys).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Provided by the packaging toolchain itself, never bundled into dependencies. */
const PACKAGER_PROVIDED = new Set(['electron']);

// ------------------------------------------------------------- scanning utils

function listJsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsFiles(full));
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

function externalRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    // bare specifier: take the package name (scope or not)
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    found.push(name);
  }
  return found;
}

const SRC_FILES = [
  ...listJsFiles(path.join(ROOT, 'src')),
  ...listJsFiles(path.join(ROOT, 'scripts')),
];

test('every external require() resolves to a declared dependency (no implicit deps)', () => {
  const deps = new Set(Object.keys(pkg.dependencies || {}));
  const offenders = new Map();
  for (const file of SRC_FILES) {
    for (const name of externalRequires(file)) {
      if (!deps.has(name) && !PACKAGER_PROVIDED.has(name) && !offenders.has(name)) {
        offenders.set(name, path.relative(ROOT, file));
      }
    }
  }
  assert.deepStrictEqual(
    [...offenders.entries()],
    [],
    `packages required by src/scripts but missing from package.json dependencies `
    + `(these crash only AFTER packaging): ${[...offenders.keys()].join(', ')}`
  );
});

test('declared dependencies are actually used (or whitelisted child-process tools)', () => {
  const WHITELIST = new Set([
    'pnpm', // executed via file-path shims by dsh children, never required
    'electron-updater', // lazy-required inside packaged builds only
  ]);
  const used = new Set(SRC_FILES.flatMap((f) => externalRequires(f)));
  const unused = Object.keys(pkg.dependencies || {}).filter((d) => !used.has(d) && !WHITELIST.has(d));
  assert.deepStrictEqual(unused, [], `unused dependencies (dead weight / drift): ${unused.join(', ')}`);
});

test('pnpm-shim BUNDLED_PNPM_MAJOR agrees with the shipped pnpm dependency major', () => {
  const shim = require('../src/pnpm-shim');
  const m = String(pkg.dependencies.pnpm || '').match(/\^?(\d+)\./);
  assert.ok(m, 'package.json declares a pnpm dependency with a parseable major');
  assert.strictEqual(
    shim.BUNDLED_PNPM_MAJOR,
    Number(m[1]),
    'H6 decision tree treats these as the same tool — a mismatch silently '
    + 'routes every profile to on-demand installs (or the wrong store)'
  );
});

test('runtime-pick/boot-check semver usage is covered by a declared dependency', () => {
  assert.ok(pkg.dependencies.semver, 'semver must stay a direct dependency (H5 comparisons)');
});

test('boot-check CHECK_IDS ↔ settings page titles stay aligned (dynamic tr keys)', () => {
  const { CHECK_IDS } = require('../src/boot-check');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'settings.html'), 'utf8');

  // slice the inline-script object literals (brace-balanced, string-aware —
  // same technique as settings-ui.test.js)
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).join('\n');
  const literal = (name) => {
    const head = inlineScripts.search(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`));
    assert.notStrictEqual(head, -1, `${name} not found in settings.html`);
    let i = inlineScripts.indexOf('{', head);
    let depth = 0;
    let quote = null;
    let esc = false;
    for (; i < inlineScripts.length; i++) {
      const c = inlineScripts[i];
      if (quote) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return new Function(`return (${inlineScripts.slice(inlineScripts.indexOf('{', head), i + 1)})`)(); }
    }
    throw new Error(`unbalanced braces in ${name}`);
  };
  const titles = literal('BOOT_CHECK_TITLES');
  const I18N = literal('I18N');
  const norm = (k) => k.replaceAll('.', '_').replaceAll('-', '_');

  for (const id of CHECK_IDS) {
    assert.ok(id in titles, `BOOT_CHECK_TITLES is missing check id "${id}"`);
    const dictKey = norm(titles[id]);
    assert.ok(dictKey in I18N.zh, `I18N.zh missing "${dictKey}" (About card would render a raw id)`);
    assert.ok(dictKey in I18N.en, `I18N.en missing "${dictKey}"`);
  }
});
