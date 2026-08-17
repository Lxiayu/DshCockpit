// test/plugin-flow.test.js — unit tests for the plugin install/remove flow
// helpers (serialization guard, failure classification, cleanup decision,
// output summarizing, stage inference). Pure module — no electron needed.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createPluginOpGuard, failureCode, shouldCleanupAfterFailure, summarizeOutput, inferStage,
  parsePnpmBlockedPackage, upsertOnlyBuiltDependencies, pickSubpackage, resolveDepKey,
  pruneBundles, sanitizeProfile,
} = require('../src/plugin-flow');

test('guard rejects a second concurrent plugin op', () => {
  const guard = createPluginOpGuard();
  assert.strictEqual(guard.tryBegin('install', 'a/b'), true);
  assert.strictEqual(guard.tryBegin('install', 'c/d'), false, 'must serialize');
  assert.deepStrictEqual(guard.current, { action: 'install', fullName: 'a/b', startedAt: guard.current.startedAt });
});

test('guard allows the next op after release', () => {
  const guard = createPluginOpGuard();
  guard.tryBegin('remove', 'a/b');
  guard.release();
  assert.strictEqual(guard.current, null);
  assert.strictEqual(guard.tryBegin('install', 'c/d'), true);
  guard.release();
});

test('failureCode classifies timeout / spawn / exit results', () => {
  assert.strictEqual(failureCode({ ok: false, code: 'timeout', output: 'timeout' }), 'timeout');
  assert.strictEqual(failureCode({ ok: false, output: 'timeout' }), 'timeout', 'legacy result without code');
  assert.strictEqual(failureCode({ ok: false, code: 'spawn', output: 'ENOENT' }), 'spawn');
  assert.strictEqual(failureCode({ ok: false, code: 'exit', output: 'boom' }), 'exit');
  assert.strictEqual(failureCode(null), 'exit');
});

test('cleanup runs after a failed install but not after a failed remove', () => {
  assert.strictEqual(shouldCleanupAfterFailure('install'), true);
  assert.strictEqual(shouldCleanupAfterFailure('remove'), false);
});

test('summarizeOutput prefers error lines and caps length', () => {
  const out = 'npm warn config\nadded 3 packages\nnpm error code E404\nnpm error 404 Not Found - GET https://registry/x\n';
  const s = summarizeOutput(out);
  assert.match(s, /E404/);
  assert.ok(s.length <= 600);
  assert.strictEqual(summarizeOutput('   \n\n'), '');
  const long = Array.from({ length: 50 }, (_, i) => `line ${i} error`).join('\n');
  assert.ok(summarizeOutput(long).length <= 600, 'capped at 600 chars');
});

test('inferStage maps npm/git output chunks to coarse stages', () => {
  assert.strictEqual(inferStage('resolved 15 packages fetching metadata'), 'resolve');
  assert.strictEqual(inferStage('Cloning into bare repository...'), 'download');
  assert.strictEqual(inferStage('added 12 packages in 3s'), 'install');
  assert.strictEqual(inferStage('running postinstall script'), 'install');
  assert.strictEqual(inferStage(''), null);
  assert.strictEqual(inferStage('something unrelated'), null);
});

// real pnpm 10 output captured from a failed dsh-TUI install (2026-08-17)
const REAL_PNPM_BLOCK = `❌ 操作失败：ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  Failed to prepare git-hosted package fetched from "\`https://codeload.github.com/ccch1mneyyy/dsh-TUI/tar.gz/09ac89c\`": The git-hosted package "@deepseek-harness-tui/dsh-tui@0.7.3" needs to execute build scripts but is not in the "onlyBuiltDependencies" allowlist. | This error happened while installing a direct dependency of /Users/xia/.dsh/profiles/web | dsh: pnpm failed in profile directory /Users/xia/.dsh/profiles/web`;

test('parsePnpmBlockedPackage extracts the scoped name from real pnpm output', () => {
  assert.strictEqual(parsePnpmBlockedPackage(REAL_PNPM_BLOCK), '@deepseek-harness-tui/dsh-tui');
});

test('parsePnpmBlockedPackage handles unscoped names, no version, and non-matching output', () => {
  const pnpm = (q) => `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED Failed to prepare git-hosted package: The git-hosted package "${q}" needs to execute build scripts`;
  assert.strictEqual(parsePnpmBlockedPackage(pnpm('my-plugin@2.0.0')), 'my-plugin');
  assert.strictEqual(parsePnpmBlockedPackage(pnpm('@scope/no-version')), '@scope/no-version');
  assert.strictEqual(parsePnpmBlockedPackage('some other pnpm ERR_PNPM_ERESOLVE failure'), null);
  assert.strictEqual(parsePnpmBlockedPackage(''), null);
  // a hostile "package name" that fails validation is rejected, not returned
  assert.strictEqual(parsePnpmBlockedPackage(pnpm('not a;valid pkg')), null);
});

test('upsertOnlyBuiltDependencies creates the section when absent', () => {
  const out = upsertOnlyBuiltDependencies('packages:\n  - .\n\nnodeLinker: hoisted\n', '@a/b');
  assert.match(out, /onlyBuiltDependencies:\n  - '@a\/b'\n$/);
  // runtime-generated keys stay untouched above the appended section
  assert.match(out, /nodeLinker: hoisted\n#/);
});

test('upsertOnlyBuiltDependencies appends under an existing list with matching indent and is idempotent', () => {
  const cur = 'packages:\n  - .\n\nonlyBuiltDependencies:\n    - \'x\'\n';
  const out = upsertOnlyBuiltDependencies(cur, '@a/b');
  assert.match(out, /onlyBuiltDependencies:\n    - 'x'\n    - '@a\/b'\n/);
  assert.strictEqual(upsertOnlyBuiltDependencies(out, '@a/b'), out); // no dup, no reorder
  assert.strictEqual(upsertOnlyBuiltDependencies(cur, 'x'), cur);     // bare name already listed
});

// trees shaped like Small-tailqwq/dsh-deep-whale: no root package.json, the
// installable skin lives in maid-atelier/
test('pickSubpackage finds a unique depth-1 subpackage and ignores nested ones', () => {
  const tree = [
    { path: 'README.md', type: 'blob' },
    { path: 'AGENTS.md', type: 'blob' },
    { path: 'maid-atelier', type: 'tree' },
    { path: 'maid-atelier/package.json', type: 'blob' },
    { path: 'maid-atelier/src', type: 'tree' },
    { path: 'maid-atelier/lib/index.js', type: 'blob' },
    { path: 'preview', type: 'tree' },
  ];
  assert.deepStrictEqual(pickSubpackage(tree), { sub: 'maid-atelier', candidates: ['maid-atelier'] });
});

test('pickSubpackage returns null for normal repos (root package.json) and ambiguous collections', () => {
  // root package.json present at depth 0 -> never a candidate path
  const normal = [
    { path: 'package.json', type: 'blob' },
    { path: 'src', type: 'tree' },
  ];
  assert.deepStrictEqual(pickSubpackage(normal), { sub: null, candidates: [] });
  // two subpackages -> ambiguous, caller must not guess
  const ambiguous = [
    { path: 'a', type: 'tree' }, { path: 'a/package.json', type: 'blob' },
    { path: 'b', type: 'tree' }, { path: 'b/package.json', type: 'blob' },
  ];
  assert.deepStrictEqual(pickSubpackage(ambiguous), { sub: null, candidates: ['a', 'b'] });
  // nested packages/foo/package.json is depth 2 -> ignored
  const nested = [
    { path: 'packages', type: 'tree' },
    { path: 'packages/foo/package.json', type: 'blob' },
  ];
  assert.deepStrictEqual(pickSubpackage(nested), { sub: null, candidates: [] });
  assert.deepStrictEqual(pickSubpackage(null), { sub: null, candidates: [] });
});

test('resolveDepKey matches exact, #path:, and subdir specs for a repo', () => {
  const deps = {
    'dsh-deep-whale': 'github:Small-tailqwq/dsh-deep-whale',
    '@dsh-external/dsh-client-ui-skin-maid-atelier': 'github:Small-tailqwq/dsh-deep-whale#path:maid-atelier',
    'other': 'github:someone/else',
  };
  // first match wins (callers loop to drop every entry pointing at the repo)
  assert.strictEqual(resolveDepKey(deps, 'Small-tailqwq/dsh-deep-whale'), 'dsh-deep-whale');
  delete deps['dsh-deep-whale'];
  assert.strictEqual(resolveDepKey(deps, 'Small-tailqwq/dsh-deep-whale'), '@dsh-external/dsh-client-ui-skin-maid-atelier');
  assert.strictEqual(resolveDepKey({ 'x': 'github:Small-tailqwq/dsh-deep-whale/maid-atelier' }, 'Small-tailqwq/dsh-deep-whale'), 'x');
  // a similarly-named repo must not match (prefix trap: dsh-deep-whale-2)
  assert.strictEqual(resolveDepKey({ 'y': 'github:Small-tailqwq/dsh-deep-whale-2' }, 'Small-tailqwq/dsh-deep-whale'), null);
  assert.strictEqual(resolveDepKey({}, 'a/b'), null);
  assert.strictEqual(resolveDepKey(null, 'a/b'), null);
});

// the crash-loop case from 2026-08-17: force-prune dropped the dependency but
// left @dsh-external/dsh-ads in dsh.profile.bundles -> runtime threw
// "cannot resolve profile bundle" on every boot
test('pruneBundles drops dangling bundle registrations for removed plugins', () => {
  const pkg = {
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-external/dsh-ads'] } },
  };
  const out = pruneBundles(pkg, ['dsh-ads', '@dsh-external/dsh-ads']);
  assert.deepStrictEqual(out.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  // official bundles and unrelated entries stay
  const pkg2 = pruneBundles({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'other'] } } }, ['x']);
  assert.deepStrictEqual(pkg2.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'other']);
});

test('sanitizeProfile removes non-official bundles missing from node_modules, keeps the rest', () => {
  const pkg = () => ({
    dependencies: { '@dsh-external/dsh-ads': 'github:a/dsh-ads', '@dsh-external/skin': 'github:a/skin' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-external/dsh-ads', '@dsh-external/skin'] } },
  });
  // dsh-ads is missing from node_modules -> dropped with its dependency;
  // skin is present and official bundles never checked -> kept
  const { pkg: out, removed } = sanitizeProfile(pkg(), (n) => n === '@dsh-external/skin');
  assert.deepStrictEqual(removed, ['@dsh-external/dsh-ads']);
  assert.deepStrictEqual(out.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-external/skin']);
  assert.ok(!out.dependencies['@dsh-external/dsh-ads']);
  assert.ok(out.dependencies['@dsh-external/skin']);
  // everything present -> nothing removed, no dependency churn
  const clean = sanitizeProfile(pkg(), () => true);
  assert.deepStrictEqual(clean.removed, []);
  assert.strictEqual(Object.keys(clean.pkg.dependencies).length, 2);
});
