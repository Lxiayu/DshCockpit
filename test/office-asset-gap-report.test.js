'use strict';

// test/office-asset-gap-report.test.js — M3 (2026-09-17): the asset gap report
// decides what MUST be regenerated vs reused (D11: 复用优先，必要的再生成).
// Pure-core contract tests over buildInventory(); the CLI wrapper only reads
// files and prints.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { buildInventory, DEFAULT_TARGET, aliasFor } = require(path.join(ROOT, 'scripts', 'asset-gap-report.js'));

test('buildInventory marks an action complete when the pack already meets the target', () => {
  const report = buildInventory({
    target: { 'walk-left': { frames: 8 } },
    pack: { 'walk-left': 8 },
    candidates: [],
  });
  assert.equal(report.actions['walk-left'].status, 'complete');
  assert.equal(report.actions['walk-left'].toGenerate, 0);
});

test('buildInventory counts the extend gap and credits usable candidates', () => {
  const report = buildInventory({
    target: { 'walk-left': { frames: 8 } },
    pack: { 'walk-left': 5 },
    candidates: ['walk-left-05.png', 'walk-left-06.png', 'walk-right-01.png'],
  });
  // target 8, pack 5 -> gap 3; two walk-left candidates can cover 2 of them
  assert.equal(report.actions['walk-left'].status, 'extend');
  assert.equal(report.actions['walk-left'].gapFrames, 3);
  assert.equal(report.actions['walk-left'].candidateFrames, 2);
  assert.equal(report.actions['walk-left'].toGenerate, 1);
});

test('rework actions never count pack frames as coverage but DO credit clean candidates', () => {
  const report = buildInventory({
    target: { working: { frames: 4, rework: 'desk-edge-baked' } },
    pack: { working: 1 },
    candidates: ['working-front-3q-01.png', 'working-front-3q-02.png'],
  });
  const action = report.actions.working;
  assert.equal(action.status, 'rework');
  assert.equal(action.rework, 'desk-edge-baked');
  // the old pack frame is NOT coverage; the two clean candidates ARE
  assert.equal(action.packFrames, 1);
  assert.equal(action.candidateFrames, 2);
  assert.equal(action.toGenerate, 2);
});

test('buildInventory reports missing actions with zero pack frames and no candidates', () => {
  const report = buildInventory({
    target: { 'idle-nap': { frames: 2 } },
    pack: {},
    candidates: ['action-eat.png'],
  });
  assert.equal(report.actions['idle-nap'].status, 'missing');
  assert.equal(report.actions['idle-nap'].toGenerate, 2);
});

test('aliasFor maps 摸鱼 asset names onto target actions (action-eat -> idle-lunch)', () => {
  assert.equal(aliasFor('action-eat.png'), 'idle-lunch');
  assert.equal(aliasFor('walk-left-03.png'), null);
});

test('buildInventory credits aliased candidates to the aliased action', () => {
  const report = buildInventory({
    target: { 'idle-lunch': { frames: 1 } },
    pack: {},
    candidates: ['action-eat.png'],
  });
  assert.equal(report.actions['idle-lunch'].candidateFrames, 1);
  assert.equal(report.actions['idle-lunch'].toGenerate, 0);
  assert.equal(report.actions['idle-lunch'].status, 'complete'); // covered by candidate, pending import
});

test('summary aggregates generation workload for credit budgeting', () => {
  const report = buildInventory({
    target: {
      'walk-left': { frames: 8 },
      'idle-nap': { frames: 2 },
    },
    pack: { 'walk-left': 5 },
    candidates: [],
  });
  assert.equal(report.summary.toGenerate, 5); // 3 walk-left + 2 idle-nap
});

test('buildInventory never counts candidates that are already imported pack frames (D11 dedup)', () => {
  // the first real run double-counted: photo walk-left-*.png ARE the sources
  // of the 5 registered pack frames, so 5+5 >= 8 wrongly read 'complete'
  const report = buildInventory({
    target: { 'walk-left': { frames: 8 } },
    pack: { 'walk-left': 5 },
    candidates: ['walk-left-01.png', 'walk-left-02.png', 'walk-left-passing-01.png', 'walk-left-new-08.png'],
    importedBasenames: ['walk-left-01.png', 'walk-left-02.png', 'walk-left-passing-01.png'],
  });
  const action = report.actions['walk-left'];
  assert.equal(action.alreadyImported, 3);
  assert.equal(action.candidateFrames, 1); // only the genuinely new frame
  assert.equal(action.toGenerate, 2); // gap 3, one covered
  assert.equal(action.status, 'extend');
});

test('DEFAULT_TARGET matches the confirmed gait decision (8 frames per direction, reworked working)', () => {
  for (const dir of ['walk-down', 'walk-left', 'walk-right', 'walk-up']) {
    assert.equal(DEFAULT_TARGET[dir].frames, 8, `${dir} targets 8 frames (D10)`);
  }
  assert.equal(DEFAULT_TARGET['working-back'].frames, 6, 'working-back upgrades to a 6-frame motion loop (user direction 2026-09-17)');
  assert.equal(DEFAULT_TARGET.working.rework, undefined, 'the front-facing working frame is not a rework target anymore');
  assert.ok(DEFAULT_TARGET['idle-nap'].frames >= 1);
  assert.ok(DEFAULT_TARGET['idle-blink'].frames >= 1);
});
