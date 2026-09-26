// test/asset-provenance.test.js — P2 运维能力：素材复现链归档的契约。
//
// 全部断言跑在**真实生产资产**上（resources/characters/deepseek-default、
// content/characters/whale-girl、resources/office）——这不是夹具演练，
// 是对"链条能不能真的回溯"的现场核对。无法回溯的环节必须如实出现在
// lostChainSummary / chain[].status 里（lost / not-recorded），不许伪造。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const provenance = require('../scripts/asset-provenance.js');

const animations = provenance.readJson(path.join(provenance.PACK_ROOT, 'animation', 'animations.json')).animations;
const anchors = provenance.readJson(path.join(provenance.PACK_ROOT, 'animation', 'anchors.json'));
const { LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS } = require('../src/office/layout-assets.js');

test('report walk-up: 14 b-series frames, all on disk with sha256, anchored geometry', () => {
  const r = provenance.reportAction('walk-up', animations, anchors);
  assert.equal(r.kind, 'character-action');
  assert.equal(r.animation.frameCount, 14);
  assert.ok(r.animation.frames.every((f) => f.file.includes('/walk/up/walk-up-b')), 'walk-up plays the b-series');
  assert.ok(r.animation.frames.every((f) => f.exists && /^[0-9a-f]{64}$/.test(f.sha256)), 'every frame exists with a hash');
  assert.ok(r.animation.frames.every((f) => f.anchor && Number.isInteger(f.anchor.x)), 'every frame has anchors.json geometry');
  assert.ok(r.animation.perCycleMs > 0);
});

test('report walk-up: content edit source matches the pack; publish ledger is reachable', () => {
  const r = provenance.reportAction('walk-up', animations, anchors);
  assert.equal(r.content.exists, true);
  assert.equal(r.content.matchesPack, true, 'content action doc agrees with pack frames/durations');
  assert.equal(r.content.mirrorIdenticalCount, r.animation.frameCount, 'content mirror is byte-identical to the pack');
  assert.equal(r.provenance.length, 1, 'one publish-ledger entry for walk-up');
  const ledger = r.provenance[0];
  assert.match(ledger.entry, /2026-09-21T18-35-36-468Z-walk-up\.json$/);
  assert.ok(ledger.publishedAt.startsWith('2026-09-21'), 'the 2026-09-21 b-series regeneration is on record');
  // the ledger was written in the s1 era: its backup lives OUTSIDE this repo
  // (read-only reference), and the CLI must say so honestly
  assert.equal(ledger.backupExistsInRepo, false);
  assert.equal(ledger.backupExistsAtRecordedPath, true, 'recorded backup dir is reachable');
  assert.equal(ledger.backupDirPointsOutsideRepo, true);
});

test('report working-back: the 2026-09-22 publish chain ends in this repo', () => {
  const r = provenance.reportAction('working-back', animations, anchors);
  assert.equal(r.animation.frameCount, 3);
  assert.equal(r.provenance.length, 2, '2026-09-17 + 2026-09-22 ledger entries');
  const latest = r.provenance[r.provenance.length - 1];
  assert.ok(latest.publishedAt.startsWith('2026-09-22'));
  assert.equal(latest.backupExistsInRepo, true, 'the newest backup lives in content/build/backups here');
});

test('chain honesty: generation/publish tools are marked traceable-in-history, not fabricated', () => {
  const r = provenance.reportAction('walk-up', animations, anchors);
  const byStep = Object.fromEntries(r.chain.map((s) => [s.step, s]));
  assert.equal(byStep['2 抠像'].status, 'traceable', 'remove-bg.py is in the main repo');
  assert.equal(byStep['3 归一化'].status, 'traceable', 'normalize-character.py is in the main repo');
  assert.equal(byStep['1 生成'].status, 'traceable-in-history', 'gen-frames.js left the repo (P5-2); git-verified recoverable');
  assert.equal(byStep['4 发布'].status, 'traceable-in-history', 'action-publisher.js left the repo (P5); git-verified recoverable');
  // the per-asset generation parameters were NEVER recorded — say so, every time
  assert.match(byStep['1 生成'].gap, /未随资产记录/);
});

test('report flat-desk: office texture is on disk, placed in scene, generation honestly not-recorded', () => {
  const asset = LAYOUT_ASSETS.find((a) => a.id === 'flat-desk');
  const r = provenance.reportOfficeAsset(asset, false);
  assert.equal(r.publishedTo, 'resources/office/flat/prop-desk-front.png');
  assert.equal(r.file.exists, true);
  assert.ok(/^[0-9a-f]{64}$/.test(r.file.sha256));
  assert.equal(r.scenePlacement.placedInCurrentScene, true);
  assert.equal(r.chain[0].status, 'not-recorded', 'flat/ art has no recorded generator — a real chain break');
  assert.match(r.chain[0].gap, /无法回溯/);
});

test('report prop-plant: env-prop generator is recoverable from git history (verified, not assumed)', () => {
  const asset = LAYOUT_ASSETS.find((a) => a.id === 'prop-plant');
  const r = provenance.reportOfficeAsset(asset, false);
  assert.equal(r.file.exists, true);
  assert.equal(r.chain[0].status, 'traceable-in-history');
  assert.equal(r.chain[0].gap, null, 'tool is recoverable; only the per-asset params are unrecorded');
});

test('verifyAll: pack validator ok, zero reference gaps, content mirror identical', () => {
  const report = provenance.verifyAll(animations, anchors, LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS);
  assert.equal(report.validator.ok, true, `validator errors: ${JSON.stringify(report.validator.errors)}`);
  assert.deepEqual(report.gaps, [], 'no referenced-but-missing assets (reverse gaps)');
  for (const [actionId, mirror] of Object.entries(report.actions)) {
    assert.equal(mirror.mirrorIdentical, true, `content↔pack mirror drifted for ${actionId}: ${mirror.differingFiles.join(', ')}`);
  }
  assert.equal(report.ok, true);
});

test('buildIndex: 17 actions + 37 active + 24 archived textures, with a non-empty lost-chain summary', () => {
  const index = provenance.buildIndex();
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.counts.characterActions, 17);
  assert.equal(index.counts.officeTexturesActive, 37);
  assert.equal(index.counts.officeTexturesArchived, 24);
  assert.ok(index.entries.length === 17 + 37 + 24);
  assert.ok(index.lostChainSummary.length > 0, 'the index must record chain breaks, not hide them');
  for (const row of index.lostChainSummary) {
    assert.ok(['lost', 'not-recorded', 'traceable-in-history'].includes(row.status), `honest status vocabulary: ${row.status}`);
  }
  // the un-recoverable category is non-empty: flat/ + layout-editor/ art origin
  assert.ok(index.lostChainSummary.some((row) => row.status === 'not-recorded' && row.kind === 'office-texture'));
});

test('LOST_TOOLS: every registered recovery anchor verifies against git history', () => {
  for (const tool of provenance.LOST_TOOLS) {
    if (tool.deletedIn.startsWith('(')) continue; // historical relocation note, not a loss
    const spec = tool.deletedIn === '2041757' ? `2041757^:${tool.tool}` : `44ed956:${tool.tool}`;
    assert.ok(provenance.toolChainStatus(tool.tool).status === 'traceable-in-history',
      `${tool.tool} must be git-recoverable via ${spec}`);
  }
});

test('findEntry: unknown ids are rejected with the known-id list, not silently matched', () => {
  assert.equal(provenance.findEntry('no-such-asset', animations, LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS), null);
  assert.ok(provenance.findEntry('idle-blink', animations, LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS).kind === 'character-action');
  assert.ok(provenance.findEntry('flat-island', animations, LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS).kind === 'office-texture');
  assert.ok(provenance.findEntry('prop-desk-back', animations, LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS).archived === true);
});
