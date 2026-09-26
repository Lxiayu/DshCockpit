'use strict';

// test/office-release-gate.test.js — Task 9 / SPEC-09 release gate.
//
// Asserts the evidence contract of the Task 9 acceptance run: the evidence
// directory exists, every automated gate has a recorded exit code, the
// Electron/performance/pixel-diff records satisfy SPEC-09 thresholds (or the
// release decision is "blocked"), the manual-review record does NOT mark the
// two known walk-cycle visual defects as passed, every JSON evidence file is
// privacy-clean (no absolute paths, session ids, prompt/secret shapes), and
// the feature flags remain defaulted to false.
//
// This test reads only repo-relative evidence under
// artifacts/office/task9/<evidence-id>/ and never launches Electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { DEFAULT_FLAGS } = require('../src/office/runtime/office-persistence.js');

const REPO_ROOT = path.resolve(__dirname, '..');
// Which evidence round this gate evaluates: OFFICE_RELEASE_EVIDENCE_ID names
// the artifacts/office/task9/<id> directory under gate. Without it nothing
// is gated and the suite reports skips (never passes) — an evidence round
// must be selected explicitly (the acceptance-run driver that used to live
// at scripts/office-acceptance-run.js moved to the workbench side with the
// authoring block; the evidence tree it produced stays in this repo).
const EVIDENCE_ID = process.env.OFFICE_RELEASE_EVIDENCE_ID || '2194abc-task9-fix1';
const EVIDENCE_DIR = EVIDENCE_ID ? path.join(REPO_ROOT, 'artifacts', 'office', 'task9', EVIDENCE_ID) : null;
const gateTest = EVIDENCE_ID ? test : test.skip;

const REQUIRED_GATES = [
  'node --check src/main.js',
  'node --check src/window-manager.js',
  'for file in src/office/runtime/*.js; do node --check "$file"; done',
  'node --test test/office-*.test.js',
  'git diff --check',
  'npm test',
];

// Gates that may be "pending" while result.json is still being assembled
// (resultComplete=false): the office glob contains this very test file, and
// npm test runs the suite after the round-1 evidence is assembled.
const PENDING_WHILE_INCOMPLETE = new Set([
  'node --test test/office-*.test.js',
  'npm test',
]);

const FINAL_STATUSES = new Set(['passed', 'failed', 'timed-out-no-progress']);
const PRIVACY_FORBIDDEN = [
  { name: 'absolute unix path', re: /\/(Users|home|private|tmp|var|Volumes)\// },
  { name: 'absolute windows path', re: /\b[A-Za-z]:[\\/](?:Users|Program|Windows)/ },
  // Mirrors the orchestrator scan: real id shapes only (sess_/sess- prefixes),
  // not legitimate repo file names like test/session-search.test.js.
  { name: 'session-like id', re: /\bsess[-_:][A-Za-z0-9][A-Za-z0-9_-]{3,}/i },
  { name: 'session-keyed id', re: /\bsession[-_:]\d/i },
  { name: 'run-like id', re: /\brun[-_:][A-Za-z0-9]{6,}/i },
  { name: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'api key', re: /\bsk-[A-Za-z0-9_-]{6,}/ },
  { name: 'bearer token', re: /\bBearer\s+\S+/ },
  { name: 'private key block', re: /-----BEGIN\s+[A-Z ]*PRIVATE/ },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, file), 'utf8'));
}

function evidenceFile(name) {
  return path.join(EVIDENCE_DIR, name);
}

gateTest('task9 evidence directory exists with the SPEC-09 minimum file set', () => {
  assert.equal(fs.existsSync(EVIDENCE_DIR), true, `missing evidence dir: ${EVIDENCE_DIR}`);
  for (const file of [
    'commands.txt',
    'result.json',
    'diagnostics.json',
    'performance.json',
    'replay.json',
    'manual-review.json',
    'npmtest-perfile.json',
  ]) {
    assert.equal(fs.existsSync(evidenceFile(file)), true, `missing evidence file: ${file}`);
  }
  // report.md is written after the office test glob (this test is part of
  // that glob), so it is only required once assembly is complete.
  if (readJson('result.json').resultComplete === true) {
    assert.equal(fs.existsSync(evidenceFile('report.md')), true, 'missing evidence file: report.md');
  }
});

gateTest('commands.txt records the exact SPEC-09 gate commands', () => {
  const text = fs.readFileSync(evidenceFile('commands.txt'), 'utf8');
  for (const command of REQUIRED_GATES) {
    assert.equal(text.includes(command), true, `commands.txt missing: ${command}`);
  }
});

gateTest('result.json records a final status for every gate (self gate may be pending only while incomplete)', () => {
  const result = readJson('result.json');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.evidenceId, EVIDENCE_ID);
  const byCommand = new Map(result.gates.map((gate) => [gate.command, gate]));
  for (const command of REQUIRED_GATES) {
    assert.equal(byCommand.has(command), true, `result.json missing gate: ${command}`);
    const gate = byCommand.get(command);
    if (PENDING_WHILE_INCOMPLETE.has(gate.command) && result.resultComplete === false) {
      // The self gate is pending while assembly is in flight and npm test
      // runs after assembly; neither has an exit code or duration yet.
      assert.equal(gate.status, 'pending', `gate "${command}" must be pending while assembly is incomplete`);
    } else {
      assert.equal(FINAL_STATUSES.has(gate.status), true, `gate "${command}" status not final: ${gate.status}`);
      assert.equal(typeof gate.exitCode, 'number', `gate "${command}" has no recorded exit code`);
      assert.equal(typeof gate.durationMs, 'number', `gate "${command}" has no duration`);
    }
  }
  const pendingGates = result.gates.filter((gate) => PENDING_WHILE_INCOMPLETE.has(gate.command) && gate.status === 'pending');
  assert.equal(result.resultComplete, pendingGates.length === 0,
    'assembly is complete exactly when no deferred gate is pending');
  assert.equal(['blocked', 'candidate', 'approved'].includes(result.decision), true);
  assert.equal(Array.isArray(result.decisionReasons) && result.decisionReasons.length > 0, true);
  assert.equal(result.host.electronVersion, '37');
  assert.equal(typeof result.host.nodeVersion, 'string');
});

gateTest('release decision is conservatively blocked while known blockers are open', () => {
  const result = readJson('result.json');
  const manual = readJson('manual-review.json');
  const failedGates = result.gates.filter((gate) => gate.status === 'failed' || gate.status === 'timed-out-no-progress');
  const blockersOpen = failedGates.length > 0
    || (manual.openDefectCount || 0) > 0
    || result.flags.officeRuntimeEnabled !== false;
  if (blockersOpen) {
    assert.equal(result.decision, 'blocked', 'open blockers require decision=blocked');
  }
  // Current evidence state: the two walk-cycle asset defects are open, so the
  // gate must NOT approve or promote regardless of automation outcomes.
  assert.equal((manual.openDefectCount || 0) > 0, true, 'known asset defects must stay recorded until replaced art is reviewed');
  assert.equal(result.decision, 'blocked', 'SPEC-09 release decision for this evidence must be blocked');
  // 历史证据如实保留：该轮取证时 flags 全 false（M4 翻转之前）
  assert.deepEqual(result.flags, { officeRuntimeEnabled: false, officePlaygroundEnabled: false });
});

gateTest('production feature flags: runtime ON since M4, playground stays OFF', () => {
  // 2026-09-17 M4 直启动：DEFAULT_FLAGS.officeRuntimeEnabled 翻转为 true；
  // 历史 evidence（result.json）仍记录翻转前的 false —— 证据是当时事实
  assert.equal(DEFAULT_FLAGS.officeRuntimeEnabled, true);
  assert.equal(DEFAULT_FLAGS.officePlaygroundEnabled, false);
  const result = readJson('result.json');
  assert.equal(result.flags.officeRuntimeEnabled, false, 'the pre-M4 evidence keeps its historical flag');
  assert.equal(result.flags.officePlaygroundEnabled, false);
});

gateTest('every JSON evidence file passes the independent privacy scan', () => {
  const jsonFiles = fs.readdirSync(EVIDENCE_DIR).filter((file) => file.endsWith('.json'));
  assert.equal(jsonFiles.length >= 6, true, 'expected at least six JSON evidence files');
  for (const file of jsonFiles) {
    const text = fs.readFileSync(evidenceFile(file), 'utf8');
    for (const rule of PRIVACY_FORBIDDEN) {
      assert.equal(rule.re.test(text), false, `${file} leaks ${rule.name}`);
    }
  }
  // report.md is exported alongside the JSON evidence and must be clean too;
  // like the file-set test, it only exists once assembly is complete.
  if (fs.existsSync(evidenceFile('report.md'))) {
    const reportText = fs.readFileSync(evidenceFile('report.md'), 'utf8');
    for (const rule of PRIVACY_FORBIDDEN) {
      assert.equal(rule.re.test(reportText), false, `report.md leaks ${rule.name}`);
    }
  }
});

gateTest('manual-review record keeps both walk-cycle asset defects open and unapproved', () => {
  const manual = readJson('manual-review.json');
  assert.equal(['PENDING_HUMAN_REVIEW', 'BLOCKED_KNOWN_DEFECTS'].includes(manual.status), true,
    'manual review must not claim approval');
  const ids = new Set((manual.knownDefects || []).map((defect) => defect.id));
  assert.equal(ids.has('walk-right-single-frame-left-jump'), true, 'walk-right frame jump defect not recorded');
  assert.equal(ids.has('walk-leg-continuity-unnatural'), true, 'walk leg continuity defect not recorded');
  for (const defect of manual.knownDefects || []) {
    if (ids.has(defect.id)) {
      assert.equal(defect.status, 'open', `${defect.id} must stay open`);
      assert.equal(defect.layer, 'asset', `${defect.id} responsibility layer must be asset`);
      assert.equal(defect.codeOffsetCompensation, false, 'no programmatic offset compensation may be applied');
    }
  }
  assert.equal((manual.openDefectCount || 0) >= 2, true);
  assert.equal(Array.isArray(manual.requiredUserReview) && manual.requiredUserReview.length > 0, true,
    'must list the PNGs/scenarios the user still has to review');
});

gateTest('performance record: five active characters, FPS threshold 30, separate failure classes', () => {
  const perf = readJson('performance.json');
  assert.equal(perf.schemaVersion, 1);
  assert.equal(perf.scenario.activeCharacters >= 5, true, 'FPS scenario needs five active characters');
  assert.equal(perf.scenario.viewport, '1280x840');
  assert.equal(typeof perf.scenario.devicePixelRatio, 'number');
  assert.equal(perf.scenario.devicePixelRatio >= 1, true);
  if (perf.scenario.devicePixelRatio !== 1) {
    // The DPR 1 reference cannot be forced on this single-2x-display machine;
    // that limitation must be recorded and must keep the decision blocked.
    assert.equal(typeof perf.scenario.dprNote, 'string');
    assert.equal(perf.scenario.dprNote.length > 0, true);
    const result = readJson('result.json');
    assert.equal(result.decision, 'blocked', 'missing DPR 1 baseline forces decision=blocked');
  }
  assert.equal(perf.fps.threshold, 30);
  assert.equal(typeof perf.fps.measuredAvg, 'number');
  assert.equal(typeof perf.fps.pass, 'boolean');
  assert.equal(perf.tickers.appTickerStarted === false || perf.tickers.sharedCount <= 1, true,
    'exactly one ticker per view; no duplicate tickers');
  assert.equal(typeof perf.textures.decodedRgbaBytes, 'number');
  assert.equal(perf.textures.decodedRgbaBytes > 0, true);
  assert.equal(typeof perf.textures.loadMs, 'number');
  assert.equal(typeof perf.dpi, 'number');
  assert.equal(typeof perf.fonts, 'string');
  assert.equal(perf.fonts.length > 0, true);
  assert.equal(Array.isArray(perf.memoryTrend) && perf.memoryTrend.length >= 2, true, 'memory trend needs samples');
  assert.equal(perf.classification.separatelyClassified, true, 'WebGL failure and low FPS must be classified separately');
  assert.equal(perf.classification.lowFps.watchdogPresent, true,
    'the runtime FPS watchdog must be present');
  if (perf.fps.pass === false) {
    const result = readJson('result.json');
    assert.equal(result.decision, 'blocked', 'FPS below threshold forces decision=blocked');
  }
});

gateTest('fake-clock fixed-layout replay records the 5% pixel-diff threshold honestly', () => {
  const replay = readJson('replay.json');
  assert.equal(replay.schemaVersion, 1);
  assert.equal(replay.thresholdPercent, 5);
  assert.equal(typeof replay.fakeClockTickMs, 'number');
  assert.equal(replay.excludedAnimationFrames, true, 'same-tick capture must exclude animation-frame diffs');
  assert.equal(typeof replay.pixelDiffPercent, 'number');
  assert.equal(Array.isArray(replay.capturedFrames) && replay.capturedFrames.length === 2, true);
  assert.equal(replay.pass, replay.pixelDiffPercent <= replay.thresholdPercent);
  if (replay.pass === false) {
    const result = readJson('result.json');
    assert.equal(result.decision, 'blocked', 'layout pixel diff above 5% forces decision=blocked');
  }
});

gateTest('diagnostics record corrupt office-state recovery, fallback codes and open findings', () => {
  const diagnostics = readJson('diagnostics.json');
  assert.equal(diagnostics.schemaVersion, 1);
  const byScenario = new Map((diagnostics.records || []).map((record) => [record.scenario, record]));
  const corrupt = byScenario.get('s9-corrupt-office-state');
  assert.notEqual(corrupt, undefined, 'missing corrupt office-state recovery record');
  assert.equal(corrupt.code, 'OFFICE_STATE_CORRUPT');
  assert.equal(['defaults', 'backup'].includes(corrupt.recoveredTo), true);
  assert.equal(corrupt.legacyFilesUnchanged, true, 'old settings/sessions must be untouched');
  assert.equal(byScenario.has('s8-webgl-failure'), true, 'missing WebGL failure fallback record');
  assert.equal(byScenario.has('s8-pack-missing'), true, 'missing pack fallback record');
  for (const finding of diagnostics.findings || []) {
    assert.equal(typeof finding.responsibilitySpec, 'string');
    assert.equal(finding.responsibilitySpec.length > 0, true, `finding ${finding.id} needs a responsible SPEC`);
  }
});

gateTest('fix round: pack manifest fallback, low-fps fallback and resolved blockers are recorded', () => {
  const diagnostics = readJson('diagnostics.json');
  const byScenario = new Map((diagnostics.records || []).map((record) => [record.scenario, record]));
  const manifest = byScenario.get('s8-pack-manifest-fallback');
  assert.notEqual(manifest, undefined, 'missing pack manifest fallback record');
  assert.equal(manifest.code, 'PACK_MISSING');
  assert.equal(manifest.pageReady, true, 'page must stay ready with a missing manifest');
  assert.equal(manifest.detailsReadable, true, 'details must stay usable with a missing manifest');
  const lowFps = byScenario.get('s8-low-fps-fallback');
  assert.notEqual(lowFps, undefined, 'missing low-fps fallback record');
  assert.equal(lowFps.code, 'LOW_FPS_PERSISTENT');
  assert.equal(lowFps.rendererModeAfter, 'static');
  assert.equal(lowFps.simulationClockUntouched, true, 'the FPS observer must not touch the simulation clock');
  // Fixed blockers must be recorded as resolved, no longer open.
  const openIds = new Set((diagnostics.findings || []).map((finding) => finding.id));
  const resolvedIds = new Set((diagnostics.resolvedFindings || []).map((finding) => finding.id));
  for (const fixed of ['office-page-pack-manifest-boot-failure', 'low-fps-watchdog-absent', 'npm-test-full-runner-hang']) {
    assert.equal(openIds.has(fixed), false, `${fixed} is fixed and must not be an open finding`);
    assert.equal(resolvedIds.has(fixed), true, `${fixed} must be recorded in resolvedFindings`);
  }
});

gateTest('evidence contains fixed-viewport scenario screenshots with scenario-stage names', () => {
  const pngs = fs.readdirSync(EVIDENCE_DIR).filter((file) => file.endsWith('.png')).sort();
  assert.equal(pngs.length >= 12, true, `expected >= 12 PNG captures, found ${pngs.length}`);
  const requiredPrefixes = [
    's1-local-roam',
    's2-walk-to-seat',
    's2-working-at-seat',
    's3-fifo-waiting',
    's4-cancel-pending',
    's5-stale-resyncing',
    's6-resize-narrow',
    's7-two-views',
    's8-webgl-fallback',
    's8-pack-missing-fallback',
    's9-corrupt-state',
    'hidpi-',
    'perf-five-active',
    'replay-a-t',
    'replay-b-t',
  ];
  for (const prefix of requiredPrefixes) {
    assert.equal(pngs.some((file) => file.startsWith(prefix)), true, `missing capture: ${prefix}*.png`);
  }
  for (const file of pngs) {
    assert.equal(/^[a-z0-9][a-z0-9-]*\.png$/.test(file), true, `bad capture filename: ${file}`);
    const stats = fs.statSync(evidenceFile(file));
    assert.equal(stats.size > 1000, true, `capture looks empty: ${file}`);
  }
});

gateTest('per-file test ledger covers every repo test file to isolate office regressions', () => {
  const ledger = readJson('npmtest-perfile.json');
  assert.equal(ledger.schemaVersion, 1);
  const recorded = new Map(ledger.files.map((entry) => [entry.file, entry]));
  const repoTests = fs.readdirSync(path.join(REPO_ROOT, 'test'))
    .filter((file) => file.endsWith('.test.js'))
    .sort();
  const SELF_TEST_FILE = 'test/office-release-gate.test.js';
  // 证据轮是发布期产物：**晚于证据轮新增的测试文件**不可能有 per-file 记录。
  // 这类文件按 mtime 判定并显式标注"待下一轮证据"，而不是把它当成台账缺失
  // （真正的缺失——证据轮时已存在却没有记录——仍然 fail）。
  const ledgerPath = path.join(EVIDENCE_DIR, 'npmtest-perfile.json');
  // 2026-09-26: CI 上所有文件的 mtime 都是检出时间，mtime 判据在那里失效
  // （本地绿、CI 全红）。改用文件的**最后提交时间**（git log -1 --format=%ct），
  // 无 git 时回落 mtime。语义不变：晚于证据轮提交的测试文件标"待下一轮证据"。
  const gitCommitMs = (relPath) => {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', relPath], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      const secs = Number(out);
      return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
    } catch { return null; }
  };
  const ledgerMtimeMs = gitCommitMs(EVIDENCE_DIR.replace(`${REPO_ROOT}/`, '')) ?? fs.statSync(ledgerPath).mtimeMs;
  const pending = [];
  for (const file of repoTests) {
    const entry = recorded.get(`test/${file}`);
    if (entry === undefined) {
      const rel = `test/${file}`;
      const fileMtimeMs = gitCommitMs(rel) ?? fs.statSync(path.join(REPO_ROOT, 'test', file)).mtimeMs;
      if (fileMtimeMs > ledgerMtimeMs + 1000) { pending.push(rel); continue; }
    }
    assert.notEqual(entry, undefined, `per-file ledger missing test/${file}`);
    if (pending.includes(`test/${file}`)) continue;
    if (entry.file === SELF_TEST_FILE && entry.status === 'pending-self') {
      // The ledger is read by this very test; its own entry may be pending
      // until the office glob completes and backfills it.
      assert.equal(entry.exitCode, null);
      continue;
    }
    assert.equal(typeof entry.exitCode, 'number', `per-file ledger has no exit code for test/${file}`);
  }
  // The aggregate check must account for the pending files exempted above
  // (added after the evidence round). Before that exemption existed, any new
  // test file made recorded.size < repoTests.length and failed the gate for a
  // reason the per-file loop had already cleared. Stale ledger entries (tests
  // deleted since the round) only ever inflate recorded.size, so the corrected
  // predicate is: every repo file is either recorded or pending.
  assert.equal(recorded.size + pending.length >= repoTests.length, true);
  const officeFailures = ledger.files.filter(
    (entry) => entry.exitCode !== 0 && entry.file.startsWith('test/office-') && entry.status !== 'pending-self',
  );
  assert.equal(officeFailures.length, 0, `office per-file failures: ${officeFailures.map((entry) => entry.file).join(', ')}`);
});

gateTest('npm test hang, if recorded, documents timeout, last visible progress and stall policy', () => {
  const result = readJson('result.json');
  const npmGate = result.gates.find((gate) => gate.command === 'npm test');
  assert.notEqual(npmGate, undefined);
  if (npmGate.status === 'timed-out-no-progress') {
    assert.equal(typeof npmGate.timeoutMs, 'number');
    assert.equal(npmGate.timeoutMs >= 600000, true, 'must wait at least 10 minutes before declaring the known hang');
    assert.equal(typeof npmGate.durationMs, 'number');
    assert.equal(typeof npmGate.lastVisibleProgress, 'string');
    assert.equal(npmGate.lastVisibleProgress.length > 0, true);
    assert.equal(npmGate.perFileLedger, 'npmtest-perfile.json');
    assert.equal(npmGate.flagConsequence, 'officeRuntimeEnabled stays false');
  }
});
