'use strict';

// test/office-artifact-marker.test.js — v0.7 P1 WP4：座位级产物标记。
//
// 只允许：闭集 kind + 计数。任何 id / 路径 / 内容都不得进入快照。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');

const T0 = 1_700_300_000_000;
const RUN = `team-run-sha256:${'1'.repeat(16)}`;
const JOB_HANDLE = `team-job-sha256:${'2'.repeat(16)}`;

function makeOffice() {
  const P = path.join(__dirname, '..', 'src', 'office', 'fixtures', 'character-pack');
  const pack = assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
    anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
    animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
  }).pack;
  return officeModule.createOfficeModule({ pack, seed: 'artifact-seed', config: { resultPresentationMs: 200 }, log: () => {} });
}

function identityFor(seq, factType) {
  return { jobHandle: JOB_HANDLE, runHandle: RUN, role: 'researcher', seq, factType, statusSource: 'team-runtime' };
}

function startResearcher(office) {
  const started = office.ingestTeamProjectionFact({
    kind: 'run-started', identity: identityFor(1, 'run/started'), atMs: T0, seat: 'researcher', role: 'researcher',
  });
  assert.equal(started.ok, true, `office rejected run-started: ${started.code}`);
}

function seatOf(office) {
  const snapshot = office.state();
  return snapshot.employees.find((entry) => entry.employeeId === 'researcher');
}

test('office artifact marker: counts closed-set kinds per seat, nothing else', () => {
  const office = makeOffice();
  startResearcher(office);
  const first = office.ingestTeamProjectionFact({
    kind: 'artifact-available', identity: identityFor(2, 'artifact/available'), atMs: T0 + 10,
    seat: 'researcher', role: 'researcher', artifactKind: 'research-notes',
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'artifact');
  const second = office.ingestTeamProjectionFact({
    kind: 'artifact-available', identity: identityFor(3, 'artifact/available'), atMs: T0 + 20,
    seat: 'researcher', role: 'researcher', artifactKind: 'review-findings',
  });
  assert.equal(second.ok, true);
  const seat = seatOf(office);
  assert.equal(seat.artifacts.count, 2);
  assert.deepEqual({ ...seat.artifacts.kinds }, { 'research-notes': 1, 'review-findings': 1 });
  // no ids, paths or content in the snapshot
  const serialized = JSON.stringify(seat.artifacts);
  assert.equal(serialized.includes('sha256'), false);
  assert.equal(serialized.includes('/'), false);
});

test('office artifact marker: a model-text-looking kind is refused (no guessed vocabulary)', () => {
  const office = makeOffice();
  startResearcher(office);
  const bad = office.ingestTeamProjectionFact({
    kind: 'artifact-available', identity: identityFor(2, 'artifact/available'), atMs: T0 + 10,
    seat: 'researcher', role: 'researcher', artifactKind: '研究笔记正文不能进 kind',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'TEAM_ARTIFACT_KIND_UNKNOWN');
  assert.equal(seatOf(office).artifacts.count, 0);
});

test('office artifact marker: an artifact for an unknown run is noted but never attributed', () => {
  const office = makeOffice();
  // 没有 run-started → 没有绑定。产物事实仍然可诊断，但绝不落到任何座位。
  const orphan = office.ingestTeamProjectionFact({
    kind: 'artifact-available', identity: identityFor(2, 'artifact/available'), atMs: T0 + 10,
    seat: 'researcher', role: 'researcher', artifactKind: 'research-notes',
  });
  assert.equal(orphan.ok, true, 'an orphan artifact is noted, not fatal');
  assert.equal(orphan.status, 'unbound');
  assert.equal(seatOf(office).artifacts.count, 0, 'an unbound artifact is never attributed to a seat');
});
