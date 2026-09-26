// test/boot-check.test.js — R1 startup self-check: clean / broken-runtime /
// bad-profile-links scenarios, repair whitelist actions, report persistence.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { createBootCheck, runOnStartup, CHECK_IDS } = require('../src/boot-check');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A minimal fake dsh install whose lib/bin.js answers --version. */
function makeRuntime(root, version) {
  const dir = path.join(root, 'runtime', version);
  const binJs = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.writeFileSync(binJs, "process.stdout.write('1.0.0\\n'); process.exit(0);\n");
  return { dir, binJs };
}

function makeDshHome({ credentials } = {}) {
  const home = tmpDir('dsh-boot-home-');
  if (credentials !== false) {
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'super-secret-content-should-never-be-read\n');
  }
  return home;
}

/**
 * Standard fixture: userData root + live runtime + healthy DSH_HOME.
 * Returns { bc, opts, paths } where bc is the boot-check instance.
 */
function fixture(overrides = {}) {
  const userDataDir = tmpDir('dsh-boot-userdata-');
  const version = overrides.version || '0.1.0-rc.9';
  const rt = makeRuntime(userDataDir, version);
  const home = makeDshHome();
  const cfg = { dshHome: home, port: 0 };
  const patched = [];
  let revalidated = 0;
  const installed = [{ version, path: rt.dir, source: 'managed' }];
  // mirrors RuntimeManager.revalidate(): drop entries whose lib/bin.js died
  const revalidate = () => {
    revalidated += 1;
    for (let i = installed.length - 1; i >= 0; i -= 1) {
      const e = installed[i];
      const bin = path.join(e.path, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!fs.existsSync(bin)) installed.splice(i, 1);
    }
  };
  const info = () => ({
    activeVersion: overrides.noActive ? null : version,
    activePath: overrides.activePath === undefined ? rt.dir : overrides.activePath,
    installed: overrides.installed || installed,
  });
  const bc = createBootCheck({
    userDataDir,
    effectiveSettings: () => ({ ...cfg }),
    patchSettings: (p) => { patched.push(p); Object.assign(cfg, p); },
    runtimeInfo: info,
    revalidateRuntime: () => { revalidate(); },
    resolveNodeBin: () => ({ bin: process.execPath, runAsNode: false }),
    shellVersion: '0.0.0-test',
    log: () => {},
    spawn: overrides.spawn,
  });
  return {
    bc,
    userDataDir,
    rt,
    home,
    cfg,
    patched,
    revalidated: () => revalidated,
    installed,
    setInstalled: (v) => { overrides.installed = v; },
  };
}

const resultOf = (report, id) => report.results.find((r) => r.id === id);

test('clean environment: all checks pass and the report is persisted', async () => {
  const f = fixture({});
  const report = await f.bc.runChecks();
  assert.strictEqual(report.overall, 'ok');
  assert.deepStrictEqual(report.results.map((r) => r.id), CHECK_IDS);
  assert.strictEqual(report.summary.total, CHECK_IDS.length);
  assert.strictEqual(report.summary.passed, CHECK_IDS.length);
  assert.strictEqual(report.summary.failed, 0);
  assert.ok(resultOf(report, 'runtime.bin').ok, 'runtime.bin should pass');
  assert.match(resultOf(report, 'runtime.bin').detail, /dsh 1\.0\.0/);
  assert.ok(resultOf(report, 'credentials.exists').ok);
  // report file lands in the NEW diagnostics/ subdir (C-4) and round-trips
  const file = path.join(f.userDataDir, 'diagnostics', 'boot-report.json');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(persisted.overall, 'ok');
  assert.deepStrictEqual(f.bc.readReport(), persisted);
});

test('readReport returns null before any check has ever run', async () => {
  const f = fixture({});
  assert.strictEqual(f.bc.readReport(), null);
});

test('broken runtime pointer: corrupt managed dir detected as fixable; repair clears it and revalidates', async () => {
  const f = fixture({});
  // simulate a half-written install: entry exists but lib/bin.js is gone
  fs.rmSync(f.rt.binJs);
  let report = await f.bc.runChecks();
  const pointer = resultOf(report, 'runtime.pointer');
  assert.strictEqual(pointer.ok, false);
  assert.strictEqual(pointer.fixable, true, 'managed corruption inside userData/runtime must be marked fixable');
  assert.ok(report.summary.fixable >= 1);

  const out = await f.bc.repair();
  assert.ok(out.repaired.includes('runtime.pointer'));
  assert.strictEqual(fs.existsSync(f.rt.dir), false, 'corrupt managed tree must be removed');
  assert.strictEqual(f.revalidated(), 1, 'manager.revalidate() must be invoked to drop stale entries');
  // follow-up report no longer carries a fixable pointer (nothing left to clear)
  const after = resultOf(out.report, 'runtime.pointer');
  assert.strictEqual(after.fixable, false);
});

test('bad profile links (real directory instead of junction): detected, repair deletes the farm for dsh to self-heal', async () => {
  const f = fixture({});
  const farm = path.join(f.home, 'profiles', 'node_modules');
  // a real directory where dsh expects a junction — the crash-loop shape
  const fake = path.join(farm, '@deepseek-ai', 'dsh-plugin-x');
  fs.mkdirSync(fake, { recursive: true });

  let report = await f.bc.runChecks();
  const links = resultOf(report, 'profile.links');
  assert.strictEqual(links.ok, false);
  assert.strictEqual(links.fixable, true);
  assert.match(links.detail, /real directory|link/i);

  const out = await f.bc.repair();
  assert.ok(out.repaired.includes('profile.links'));
  assert.strictEqual(fs.existsSync(farm), false, 'farm must be deleted so dsh rebuilds it (DESIGN.md §10)');
  assert.strictEqual(resultOf(out.report, 'profile.links').ok, true, 'after removal the farm is healthy-by-absence');
});

test('dangling symlink inside the farm is flagged as broken', async () => {
  const f = fixture({});
  const farm = path.join(f.home, 'profiles', 'node_modules');
  fs.mkdirSync(farm, { recursive: true });
  try {
    fs.symlinkSync(path.join(f.home, 'does-not-exist'), path.join(farm, 'dangling'), 'junction');
  } catch {
    fs.symlinkSync(path.join(f.home, 'does-not-exist'), path.join(farm, 'dangling'));
  }
  const report = await f.bc.runChecks();
  const links = resultOf(report, 'profile.links');
  assert.strictEqual(links.ok, false);
  assert.match(links.detail, /dangling/i);
});

test('occupied port is reported fixable; repair switches settings.port to os-assigned', async () => {
  const f = fixture({});
  // occupy a real loopback port
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = blocker.address().port;
  f.cfg.port = occupiedPort;

  const report = await f.bc.runChecks();
  const port = resultOf(report, 'port.available');
  assert.strictEqual(port.ok, false);
  assert.strictEqual(port.fixable, true);

  const out = await f.bc.repair();
  assert.ok(out.repaired.includes('port.available'));
  assert.deepStrictEqual(f.patched, [{ port: 0 }], 'repair must switch to an OS-assigned port');
  assert.strictEqual(resultOf(out.report, 'port.available').ok, true, 'port 0 (os-assigned) always passes');
  blocker.close();
});

test('credentials existence only: missing file flags failure without a fix; content is never read', async () => {
  const f = fixture({});
  fs.rmSync(path.join(f.home, '.credentials.yaml'));
  let report = await f.bc.runChecks();
  let cred = resultOf(report, 'credentials.exists');
  assert.strictEqual(cred.ok, false);
  assert.strictEqual(cred.fixable, false, 'credential setup is a user action, never auto-repaired');

  // present-but-secret: verdict stays existence-only, detail leaks nothing
  fs.writeFileSync(path.join(f.home, '.credentials.yaml'), 'TOP-SECRET-BODY');
  report = await f.bc.runChecks();
  cred = resultOf(report, 'credentials.exists');
  assert.strictEqual(cred.ok, true);
  assert.ok(!JSON.stringify(report).includes('TOP-SECRET-BODY'), 'report must never contain credential contents');
});

test('runtime --version probe failures are surfaced (nonzero exit / spawn error)', async () => {
  // nonzero exit
  const f1 = fixture({});
  fs.writeFileSync(f1.rt.binJs, 'process.exit(3)\n');
  let report = await f1.bc.runChecks();
  let bin = resultOf(report, 'runtime.bin');
  assert.strictEqual(bin.ok, false);
  assert.match(bin.detail, /exited 3/);

  // spawn throws
  const f2 = fixture({ spawn: () => { throw new Error('boom-spawn'); } });
  report = await f2.bc.runChecks();
  bin = resultOf(report, 'runtime.bin');
  assert.strictEqual(bin.ok, false);
  assert.match(bin.detail, /boom-spawn/);
});

test('no active runtime entry degrades both runtime checks without crashing', async () => {
  const f = fixture({ noActive: true });
  const report = await f.bc.runChecks();
  assert.strictEqual(resultOf(report, 'runtime.bin').ok, false);
  assert.strictEqual(resultOf(report, 'runtime.pointer').ok, false);
  assert.strictEqual(report.overall, 'failed');
  // non-runtime checks still ran
  assert.ok(resultOf(report, 'dshhome.writable').ok);
});

test('repair() skips ids that are ok or non-fixable, and honors an explicit id list', async () => {
  const f = fixture({});
  const out = await f.bc.repair(['credentials.exists']); // ok → skipped
  assert.deepStrictEqual(out.repaired, []);
  assert.ok(out.skipped.includes('credentials.exists'));

  const out2 = await f.bc.repair(['runtime.bin']); // exists but not fixable → skipped
  assert.deepStrictEqual(out2.repaired, []);
  assert.ok(out2.skipped.includes('runtime.bin'));
});

test('runOnStartup gating respects the C-6 feature switch', () => {
  assert.strictEqual(runOnStartup(undefined), true, 'missing settings default to enabled');
  assert.strictEqual(runOnStartup({}), true);
  assert.strictEqual(runOnStartup({ bootCheckOnStartup: true }), true);
  assert.strictEqual(runOnStartup({ bootCheckOnStartup: false }), false);
});

// --------------------------------------------- H5 credential layout probing

test('H5: v1 credentials + pre-0.1.1 runtime → degraded warning telling the user to upgrade (values never reported)', async () => {
  const f = fixture({}); // active runtime 0.1.0-rc.9 (< 0.1.1)
  const secret = 'sk-live-DO-NOT-LEAK';
  fs.writeFileSync(path.join(f.home, '.credentials.yaml'), `version: 1\nrefs:\n  deepseek:\n    apiKey: ${secret}\n`);
  const report = await f.bc.runChecks();
  assert.deepStrictEqual(report.results.map((r) => r.id), CHECK_IDS, 'layout check joins the stable id order');
  const layout = resultOf(report, 'credentials.layout');
  assert.strictEqual(layout.ok, false);
  assert.strictEqual(layout.severity, 'warning');
  assert.match(layout.detail, /NEWER Harness|upgrade/i);
  // overall degrades instead of failing hard; no credential value ever lands in the report
  assert.strictEqual(report.overall, 'degraded');
  assert.strictEqual(report.summary.degraded, 1);
  assert.ok(!JSON.stringify(report).includes(secret), 'report must never contain credential values');
});

test('H5: v1 credentials + 0.1.1-series runtime → ok (parser supports it)', async () => {
  const f = fixture({ version: '0.1.1-rc.2' });
  fs.writeFileSync(path.join(f.home, '.credentials.yaml'), 'version: 1\nrefs:\n  deepseek:\n    apiKey: sk-x\n');
  const report = await f.bc.runChecks();
  const layout = resultOf(report, 'credentials.layout');
  assert.strictEqual(layout.ok, true);
  assert.match(layout.detail, /matches/);
  assert.strictEqual(report.overall, 'ok');
});

test('H5: legacy flat credentials are fine on both sides (auto-migrate note on new runtimes)', async () => {
  const oldRt = fixture({ version: '0.1.0-rc.9' });
  fs.writeFileSync(path.join(oldRt.home, '.credentials.yaml'), 'apiKey: sk-a\n');
  let report = await oldRt.bc.runChecks();
  let layout = resultOf(report, 'credentials.layout');
  assert.strictEqual(layout.ok, true);

  const newRt = fixture({ version: '0.1.1-rc.2' });
  fs.writeFileSync(path.join(newRt.home, '.credentials.yaml'), 'apiKey: sk-b\n');
  report = await newRt.bc.runChecks();
  layout = resultOf(report, 'credentials.layout');
  assert.strictEqual(layout.ok, true);
  assert.match(layout.detail, /auto-migrat/i);
  assert.strictEqual(report.overall, 'ok');
});

test('H5: absent credentials keep the layout check green', async () => {
  const f = fixture({});
  fs.rmSync(path.join(f.home, '.credentials.yaml'));
  const report = await f.bc.runChecks();
  const layout = resultOf(report, 'credentials.layout');
  assert.strictEqual(layout.ok, true);
  assert.match(layout.detail, /absent|empty/i);
});

// ------------------- windows-perf P1 #2: the runtime.bin probe is on-demand

/** Spawn-counting fixture: counts cold starts of the --version probe. */
function countingFixture() {
  let spawns = 0;
  const realSpawn = require('node:child_process').spawn;
  const f = fixture({ spawn: (...args) => { spawns += 1; return realSpawn(...args); } });
  f.spawns = () => spawns;
  return f;
}

test('REGRESSION #2 (on-demand): a fresh healthy report reuses runtime.bin — second boot pays 0 spawns', async () => {
  const f = countingFixture();
  const first = await f.bc.runChecks();
  assert.strictEqual(resultOf(first, 'runtime.bin').ok, true);
  assert.strictEqual(f.spawns(), 1, 'first boot: deep probe runs');
  const second = await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 1, 'second boot within TTL: probe reused, 0 spawns');
  const bin = resultOf(second, 'runtime.bin');
  assert.strictEqual(bin.ok, true);
  assert.match(bin.detail, /reused/);
  assert.strictEqual(second.overall, 'ok');
  assert.strictEqual(second.probe.ok, true, 'reuse keys persist for the next boot');
  // manual rerun (Settings → About) is always deep
  const manual = await f.bc.runChecks({ deep: true });
  assert.strictEqual(f.spawns(), 2, 'manual deep rerun probes again');
  assert.doesNotMatch(resultOf(manual, 'runtime.bin').detail, /reused/);
});

test('REGRESSION #2 (discoverability): a cheap-check anomaly forces the deep probe and is still reported', async () => {
  const f = countingFixture();
  await f.bc.runChecks(); // healthy baseline persisted
  assert.strictEqual(f.spawns(), 1);
  // break the profile link farm (what dsh's own heal watches)
  fs.mkdirSync(path.join(f.home, 'profiles', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'profiles', 'node_modules', 'broken-pkg'), 'not a link');
  const report = await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 2, 'anomaly → the deep probe runs again');
  assert.strictEqual(resultOf(report, 'profile.links').ok, false);
  assert.strictEqual(report.overall, 'failed');
  const healed = JSON.parse(fs.readFileSync(f.bc.reportFile(), 'utf8'));
  assert.strictEqual(healed.probe.ok, true, 'the fresh probe verdict is persisted, never the reused one');
});

test('REGRESSION #2 (TTL/keys): stale, foreign or failed probe verdicts are never reused', async () => {
  const f = countingFixture();
  await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 1);
  const file = f.bc.reportFile();
  const readReport = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  // 1) older than the 24h TTL → deep again
  const stale = readReport();
  stale.probe.at = new Date(Date.now() - 25 * 3_600_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stale));
  await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 2, 'expired probe verdict re-probes');

  // 2) a FAILED verdict is never reused (the last real probe saw exit 3):
  // the next boot probes deep even though the env is otherwise fresh
  fs.writeFileSync(f.rt.binJs, 'process.exit(3)\n');
  const failed = readReport();
  failed.probe.ok = false;
  failed.probe.detail = '--version exited 3';
  fs.writeFileSync(file, JSON.stringify(failed));
  const bad = await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 3, 'a failed verdict is never reused — deep probe runs');
  assert.strictEqual(resultOf(bad, 'runtime.bin').ok, false);
  fs.writeFileSync(f.rt.binJs, "process.stdout.write('1.0.0\\n'); process.exit(0);\n");
  const healed = await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 4, 'verdict after a failure re-probes once more');
  assert.strictEqual(resultOf(healed, 'runtime.bin').ok, true);

  // 3) a different dshHome invalidates the reuse
  const foreign = readReport();
  foreign.probe.dshHome = path.join(f.userDataDir, 'some-other-home');
  fs.writeFileSync(file, JSON.stringify(foreign));
  await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 5, 'dshHome change invalidates the reuse');

  // 4) a different active runtime version invalidates the reuse
  const otherRt = readReport();
  otherRt.probe.runtimeVersion = '9.9.9';
  fs.writeFileSync(file, JSON.stringify(otherRt));
  await f.bc.runChecks();
  assert.strictEqual(f.spawns(), 6, 'runtime version change invalidates the reuse');
});
