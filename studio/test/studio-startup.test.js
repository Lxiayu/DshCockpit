'use strict';

// studio/test/studio-startup.test.js — the real-shell boot contract of the
// studio entry: `npm run studio` (studio/main.js) must reach the shell, embed
// the real preview, and answer the studio IPC from the REAL content/pack trees.
//
// House style follows test/office-ui.test.js: spawn the repo's Electron binary,
// keep the run short and self-cleaning, and let the evidence file be the
// assertion source (piped stdout is captured but never trusted for state).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STUDIO_ROOT = path.join(__dirname, '..');
const ROOT = path.join(STUDIO_ROOT, '..');

test('studio boots: STUDIO_READY, the preview embeds, and the passport answers', { timeout: 240000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-boot-'));
  const evidenceDir = path.join(sandbox, 'evidence');
  try {
    const stdout = execFileSync(electronBin, [path.join(STUDIO_ROOT, 'main.js')], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        STUDIO_DATA_DIR: path.join(sandbox, 'data'),
        STUDIO_EVIDENCE_DIR: evidenceDir,
      },
    });
    assert.match(stdout, /STUDIO_READY/, 'the stdout launch contract');
    assert.match(stdout, /STUDIO_EVIDENCE_OK/, 'the evidence sweep finished');

    const results = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'results.json'), 'utf8'));
    assert.equal(results.windowTitle, 'PROBE 临时数据（可关闭）', 'probe runs carry the probe title so they are never mistaken for the user window');
    assert.equal(results.previewReady, true, 'the real office preview embedded and reported ready');
    assert.equal(results.studioInfo.ok, true);
    assert.equal(results.studioInfo.packId, 'deepseek-default');
    assert.deepEqual(results.studioInfo.segments, ['generation', 'matting', 'normalize', 'publish', 'on-disk']);

    // the passport answered from the REAL trees
    assert.equal(results.passportWalkLeft.ok, true);
    assert.equal(results.passportWalkLeft.frameCount, 15, 'walk-left really has 15 frames in the pack');
    assert.deepEqual(results.passportWalkLeft.segments.map((segment) => segment.id), ['generation', 'matting', 'normalize', 'publish', 'on-disk']);
    assert.equal(results.passportWalkLeft.segments.find((segment) => segment.id === 'on-disk').status, 'traceable');
    assert.equal(typeof results.passportVerifyCounts.traceable, 'number');

    // the generation-params breakpoint is reported honestly (empty today)
    assert.equal(results.paramsLedger.recordCount, 0, 'no params ledger exists yet — the passport must say so, not invent one');

    // the renderer bridge handshake (studio:info through the preload)
    assert.equal(results.rendererBridgeInfo.ok, true, 'the studio bridge answers inside the renderer');
    assert.equal(results.rendererBridgeInfo.version, results.studioInfo.version);

    const shot = path.join(evidenceDir, 'studio-shell.png');
    assert.ok(fs.existsSync(shot) && fs.statSync(shot).size > 10000, 'the shell screenshot is a real capture');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
