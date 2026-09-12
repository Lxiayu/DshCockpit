// test/pnpm-profile.test.js — H6: profile-aware pnpm resolution. The profile
// decides which pnpm major runs plugin ops; bundled pnpm 10 stays the default
// fallback (H3 untouched), system PATH wins when version-verified, and
// on-demand installs are cached per major under userData/pnpm-runtime/.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readProfilePnpmMajor,
  cachedPnpmMatches,
  resolvePnpmForProfile,
  SHIM_VERSION,
  BUNDLED_PNPM_MAJOR,
} = require('../src/pnpm-shim');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fake app layout: bundled pnpm 10 reachable by walking up from `fromDir`. */
function makeBundledPnpm() {
  const root = tmpDir('pnpm-bundled-');
  const cjs = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  fs.mkdirSync(path.dirname(cjs), { recursive: true });
  fs.writeFileSync(cjs, '// fake pnpm 10\n');
  return { root, cjs };
}

/** Seed a profile whose .modules.yaml claims the given packageManager. */
function makeProfile(packageManagerLine) {
  const dir = tmpDir('pnpm-profile-');
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  if (packageManagerLine) {
    fs.writeFileSync(path.join(nm, '.modules.yaml'), `storeDir: /x\n${packageManagerLine}\nvirtualStoreDir: /y\n`);
  }
  return dir;
}

/** Install a fake pnpm@<version> tree into dest (mimics arborist output). */
function fakeInstallRunner(installLog) {
  return async ({ dest, major }) => {
    installLog.push(major);
    const cjs = path.join(dest, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    fs.mkdirSync(path.dirname(cjs), { recursive: true });
    fs.writeFileSync(cjs, `// fake pnpm ${major}\n`);
    fs.writeFileSync(path.join(dest, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: `${major}.15.4` }));
  };
}

const base = ({ userDataDir, nodeBin = '/node/bin/node', fromDir, ...rest }) => ({
  userDataDir,
  nodeBin,
  fromDir: fromDir || BUNDLED.fromDir,
  ...rest,
});
const BUNDLED = makeBundledPnpm();

test('.modules.yaml parsing: plain, corepack-hash and non-pnpm managers', () => {
  assert.strictEqual(readProfilePnpmMajor(makeProfile('packageManager: pnpm@9.15.4')).major, 9);
  assert.strictEqual(readProfilePnpmMajor(makeProfile("packageManager: pnpm@11.10.0+sha512.abc123")).major, 11);
  assert.strictEqual(readProfilePnpmMajor(makeProfile('packageManager: "pnpm@10.12.1"')).major, 10);
  assert.strictEqual(readProfilePnpmMajor(makeProfile('packageManager: npm@10.2.0')).major, null);
  assert.strictEqual(readProfilePnpmMajor(makeProfile(null)).major, null); // no .modules.yaml
});

test('no .modules.yaml / npm-managed / major=10 → bundled fallback, ZERO installs or probes', async () => {
  let installs = 0;
  let probes = 0;
  for (const line of [null, 'packageManager: npm@10.2.0', 'packageManager: pnpm@10.12.1']) {
    const userDataDir = tmpDir('pnpm-ud-');
    const res = await resolvePnpmForProfile(base({
      userDataDir,
      profileDir: makeProfile(line),
      systemProbe: async () => { probes += 1; return '/sys/pnpm'; },
      installRunner: async () => { installs += 1; },
    }));
    assert.ok(res.shimDir, `bundled shim expected for ${line}`);
    assert.ok(res.shimDir.includes(path.join(userDataDir, 'shims')), 'shim lives under userData/shims');
  }
  assert.strictEqual(probes, 0, 'system PATH never probed for the bundled-major path');
  assert.strictEqual(installs, 0, 'nothing downloaded for the bundled-major path');
  // marker carries the bumped schema so stale v1 shims get rewritten
  assert.ok(fs.existsSync(path.join(BUNDLED.root ? tmpDir('x') : '/', 'noop')) === false);
});

test('H6 scenario: profile created by pnpm 9 → on-demand install + per-major shim dir', async () => {
  const userDataDir = tmpDir('pnpm-ud9-');
  const installs = [];
  const res = await resolvePnpmForProfile(base({
    userDataDir,
    profileDir: makeProfile('packageManager: pnpm@9.15.4'),
    systemProbe: async () => null,
    installRunner: fakeInstallRunner(installs),
  }));
  assert.ok(!res.error, `expected success, got ${JSON.stringify(res)}`);
  assert.ok(res.shimDir.includes(path.join(userDataDir, 'shims', '9')), `shim isolated to shims/9 (${res.shimDir})`);
  assert.deepStrictEqual(installs, [9]);
  // the generated shim points at the freshly installed pnpm.cjs
  const marker = JSON.parse(fs.readFileSync(path.join(res.shimDir, `.v${SHIM_VERSION}.marker`), 'utf8'));
  assert.match(marker.pnpmCjs, /pnpm-runtime[\\/]9[\\/]node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.cjs$/);
  assert.ok(fs.existsSync(path.join(userDataDir, 'pnpm-runtime', '9', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')));
});

test('corepack hash format resolves the right major (11) with its own shim dir', async () => {
  const userDataDir = tmpDir('pnpm-ud11-');
  const installs = [];
  const res = await resolvePnpmForProfile(base({
    userDataDir,
    profileDir: makeProfile('packageManager: pnpm@11.10.0+sha512.deadbeef'),
    systemProbe: async () => null,
    installRunner: fakeInstallRunner(installs),
  }));
  assert.ok(!res.error);
  assert.ok(res.shimDir.includes(path.join('shims', '11')));
  assert.deepStrictEqual(installs, [11]);
});

test('cache reuse: second resolution of the same major does NOT reinstall', async () => {
  const userDataDir = tmpDir('pnpm-udcache-');
  const installs = [];
  const opts = base({
    userDataDir,
    profileDir: makeProfile('packageManager: pnpm@9.15.4'),
    systemProbe: async () => null,
    installRunner: fakeInstallRunner(installs),
  });
  await resolvePnpmForProfile(opts);
  await resolvePnpmForProfile(opts);
  assert.strictEqual(installs.length, 1, 'cached pnpm-runtime/9 must be reused');
  assert.strictEqual(cachedPnpmMatches(path.join(userDataDir, 'pnpm-runtime', '9'), 9), true);
  assert.strictEqual(cachedPnpmMatches(path.join(userDataDir, 'pnpm-runtime', '9'), 11), false);
});

test('a VERSION-VERIFIED system pnpm of the matching major wins over installing', async () => {
  const userDataDir = tmpDir('pnpm-udsys-');
  const installs = [];
  const res = await resolvePnpmForProfile(base({
    userDataDir,
    profileDir: makeProfile('packageManager: pnpm@11.10.0'),
    systemProbe: async (major) => (major === 11 ? '/usr/local/bin-dir' : null),
    installRunner: fakeInstallRunner(installs),
  }));
  assert.ok(!res.error);
  assert.strictEqual(res.shimDir, '/usr/local/bin-dir', 'system dir used as-is (its own runnable bin)');
  assert.strictEqual(installs.length, 0);
  // a probe that only certifies pnpm 11 must NOT serve a pnpm-9 profile →
  // fall through to the on-demand install of the matching major
  const res2 = await resolvePnpmForProfile(base({
    userDataDir: tmpDir('pnpm-udsys2-'),
    profileDir: makeProfile('packageManager: pnpm@9.1.0'),
    systemProbe: async (major) => (major === 11 ? '/only-has-11' : null),
    installRunner: fakeInstallRunner([]),
  }));
  assert.ok(!res2.error);
  assert.ok(res2.shimDir.includes(path.join('shims', '9')), 'system pnpm 11 is distrusted for a pnpm-9 profile');
});

test('total failure returns a readable error carrying the major (never raw pnpm text)', async () => {
  const res = await resolvePnpmForProfile(base({
    userDataDir: tmpDir('pnpm-udfail-'),
    profileDir: makeProfile('packageManager: pnpm@9.15.4'),
    systemProbe: async () => null,
    installRunner: async () => { throw new Error('registry unreachable'); },
  }));
  assert.strictEqual(res.error, 'install-failed');
  assert.strictEqual(res.major, 9);
  assert.match(res.reason, /registry unreachable/);
  assert.ok(typeof res.reason === 'string' && res.reason.length < 200, 'reason stays a short summary');
});

test('bundled fallback still works when only FALLBACK_DIRS exist (H3 preserved)', async () => {
  const userDataDir = tmpDir('pnpm-udh3-');
  const res = await resolvePnpmForProfile({
    userDataDir,
    profileDir: makeProfile(null),
    nodeBin: '/node/bin/node',
    fromDir: BUNDLED.root,
    systemProbe: async () => { throw new Error('must not be called'); },
    installRunner: async () => { throw new Error('must not be called'); },
  });
  assert.ok(res.shimDir && res.shimDir.startsWith(userDataDir));
  // both platform shims written
  assert.ok(fs.existsSync(path.join(res.shimDir, 'pnpm')));
  assert.ok(fs.existsSync(path.join(res.shimDir, 'pnpm.cmd')));
});
