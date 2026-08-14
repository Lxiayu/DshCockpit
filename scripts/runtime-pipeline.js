// test/runtime-manager.test.js — headless pipeline test for RuntimeManager.
// Run: node test/runtime-manager.test.js
// Exercises: bootstrap -> registry check -> arborist install -> smoke -> activate -> rollback -> gc.
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { SettingsStore } = require('../src/settings-store');
const { RuntimeManager } = require('../src/runtime-manager');

// Isolate everything: temp userData, temp DSH_HOME, temp workspace.
const userData = path.join(os.tmpdir(), 'dsh-rm-test-' + Date.now());
const dshHome = path.join(userData, 'dsh-home');
fs.mkdirSync(userData, { recursive: true });
process.env.DSH_DESKTOP_DSH_HOME = dshHome;
process.env.DSH_DESKTOP_WORKSPACE = path.join(userData, 'workspace');

const log = (m) => console.log('[test]', m);
const settings = new SettingsStore(userData);
const manager = new RuntimeManager({
  userDataDir: userData,
  settings,
  log,
  resolveNodeBin: () => ({ bin: process.execPath, runAsNode: false }),
});

const NPM_CACHE_ROOT = 'C:\\Users\\Lenovo\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0';
const BOOTSTRAP_VERSION = '0.1.0-rc.6';
const OLD_VERSION = '0.1.0-rc.3';

let failures = 0;
function assert(cond, name, extra) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures += 1; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  // 1. bootstrap from the existing npx-cache install
  console.log('1) bootstrap');
  manager.bootstrapFrom(NPM_CACHE_ROOT, BOOTSTRAP_VERSION);
  assert(manager.getInfo().activeVersion === BOOTSTRAP_VERSION, 'active = ' + BOOTSTRAP_VERSION);
  assert(manager.entry(BOOTSTRAP_VERSION).source === 'bootstrap', 'source = bootstrap');

  // 2. real registry update check (should report up-to-date)
  console.log('2) update check (real registry)');
  const check = await manager.checkForUpdate();
  assert(check.ok === true, 'check ok', JSON.stringify(check));
  assert(check.available === false, 'not available (rc.6 is latest)', check.reason);
  assert(check.current === BOOTSTRAP_VERSION, 'current matches');

  // 3. install an older version to exercise the install pipeline
  console.log('3) arborist install ' + OLD_VERSION);
  const entry = await manager.installVersion(OLD_VERSION);
  assert(!!entry && entry.source === 'managed', 'entry registered', entry && entry.path);
  assert(fs.existsSync(path.join(entry.path, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), 'bin.js present');

  // 4. smoke test on the freshly installed version
  console.log('4) smoke test');
  const smoke = await manager.smokeTest(entry);
  console.log('   smoke result:', JSON.stringify(smoke));
  assert(smoke.ok === true, 'dump-config exit 0', smoke.reason || String(smoke.exitCode));

  // 5. activate (switch pointer; simulates applying an update)
  console.log('5) activate ' + OLD_VERSION);
  const act = await manager.activate(OLD_VERSION);
  assert(act.current === OLD_VERSION && manager.getInfo().activeVersion === OLD_VERSION, 'active switched');
  assert(fs.existsSync(manager.lastSnapshot), 'DSH_HOME snapshot taken');

  // 6. rollback to bootstrap version
  console.log('6) rollback');
  const rb = await manager.rollback();
  assert(rb.to === BOOTSTRAP_VERSION && manager.getInfo().activeVersion === BOOTSTRAP_VERSION, 'active restored');
  assert(manager.getInfo().knownIssues[OLD_VERSION], 'knownIssues recorded');

  // 7. gc keeps managed versions per keepVersions (2) and never the active one
  console.log('7) gc');
  manager.gc();
  const info = manager.getInfo();
  assert(info.activeVersion === BOOTSTRAP_VERSION, 'gc keeps active');
  assert(info.installed.length === 2, 'installed = 2 (bootstrap + managed)', JSON.stringify(info.installed));

  console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});
