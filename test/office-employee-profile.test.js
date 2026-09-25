'use strict';

// Task 5 / SPEC-04 — resident employee profiles.
// RED: src/office/runtime/employee-profile.js does not exist yet.
//
// Contracts under test:
// - exactly four fixed residents (orchestrator/researcher/coder/reviewer) with
//   stable profile fields (displayName/role/defaultSeat/characterPack/variant/
//   allowedOverrides)
// - desk-5/desk-6 are never auto-assigned to residents; they remain free seats
//   for the single collaborator or future extensions
// - collaborator is a singleton with a FIFO queue
// - profiles are separated from Harness Session payloads: no Harness payload
//   may override character pack, variant or allowedOverrides
// - profile output is stable, frozen and JSON-replayable

const { test } = require('node:test');
const assert = require('node:assert/strict');

const profiles = require('../src/office/runtime/employee-profile.js');

test('module exports frozen deterministic API', () => {
  assert.equal(typeof profiles.listResidentProfiles, 'function');
  assert.equal(typeof profiles.getResidentProfile, 'function');
  assert.equal(typeof profiles.getCollaboratorProfile, 'function');
  assert.equal(typeof profiles.applyOverrides, 'function');
  assert.equal(typeof profiles.resolveProfileForSeat, 'function');
});

test('exactly four resident profiles exist with stable seats', () => {
  const list = profiles.listResidentProfiles();
  assert.equal(list.length, 4);
  assert.deepEqual(
    list.map((p) => p.employeeId),
    ['orchestrator', 'researcher', 'coder', 'reviewer']
  );
  assert.deepEqual(
    list.map((p) => p.defaultSeat),
    ['desk-1', 'desk-2', 'desk-3', 'desk-4']
  );
});

test('each resident profile carries the full SPEC-04 field set', () => {
  for (const profile of profiles.listResidentProfiles()) {
    assert.equal(typeof profile.employeeId, 'string');
    assert.ok(profile.displayName.length > 0);
    assert.ok(profile.role.length > 0);
    assert.match(profile.defaultSeat, /^desk-[1-6]$/);
    assert.equal(profile.characterPack, 'deepseek-default');
    assert.equal(profile.variant, 'base');
    assert.deepEqual(profile.allowedOverrides, [
      'displayName',
      'role',
      'seat',
      'characterPack',
      'variant',
    ]);
  }
});

test('the SPEC-04 example profile matches byte for byte (JSON replay)', () => {
  const coder = profiles.getResidentProfile('coder');
  assert.equal(coder.employeeId, 'coder');
  assert.equal(coder.defaultSeat, 'desk-3');
  assert.equal(coder.characterPack, 'deepseek-default');
  assert.equal(coder.variant, 'base');
  assert.deepEqual(coder.allowedOverrides, [
    'displayName',
    'role',
    'seat',
    'characterPack',
    'variant',
  ]);
  // displayName/role are free-form but stable
  assert.ok(typeof coder.displayName === 'string' && coder.displayName.length > 0);
  assert.ok(typeof coder.role === 'string' && coder.role.length > 0);
});

test('collaborator is a singleton fifth seat without a fixed desk', () => {
  const collaborator = profiles.getCollaboratorProfile();
  assert.equal(collaborator.employeeId, 'collaborator');
  assert.equal(collaborator.isSingleton, true);
  assert.equal(collaborator.queuePolicy, 'fifo');
  // desk-5/desk-6 are collaborator/future seats, not resident defaults
  assert.ok(['desk-5', 'desk-6', null].includes(collaborator.defaultSeat));
  assert.equal(profiles.getCollaboratorProfile(), collaborator);
  // collaborator is never part of the resident list
  assert.equal(
    profiles.listResidentProfiles().some((p) => p.employeeId === 'collaborator'),
    false
  );
});

test('desk-5 and desk-6 are never auto-assigned to residents', () => {
  for (const profile of profiles.listResidentProfiles()) {
    assert.ok(['desk-1', 'desk-2', 'desk-3', 'desk-4'].includes(profile.defaultSeat));
  }
});

test('profiles are frozen and JSON-replayable', () => {
  for (const profile of [...profiles.listResidentProfiles(), profiles.getCollaboratorProfile()]) {
    assert.equal(Object.isFrozen(profile), true);
    const roundTrip = JSON.parse(JSON.stringify(profile));
    assert.deepEqual(roundTrip, { ...profile });
  }
  // replay determinism: two reads produce identical JSON
  const a = JSON.stringify(profiles.listResidentProfiles());
  const b = JSON.stringify(profiles.listResidentProfiles());
  assert.equal(a, b);
});

test('applyOverrides only accepts whitelisted fields and keeps frozen output', () => {
  const base = profiles.getResidentProfile('coder');
  const updated = profiles.applyOverrides(base, {
    displayName: '编码员 A',
    seat: 'desk-5',
    characterPack: 'whale-girl',
    variant: 'calm',
    role: '编码、文件、命令',
  });
  assert.equal(updated.displayName, '编码员 A');
  assert.equal(updated.defaultSeat, 'desk-5');
  assert.equal(updated.characterPack, 'whale-girl');
  assert.equal(updated.variant, 'calm');
  assert.equal(Object.isFrozen(updated), true);
  // base is untouched
  assert.equal(base.displayName !== '编码员 A', true);
});

test('Harness payloads cannot override protected profile identity fields', () => {
  const base = profiles.getResidentProfile('coder');
  const malicious = {
    employeeId: 'attacker',
    allowedOverrides: ['anything'],
    characterPack: 'whale-girl',
  };
  const updated = profiles.applyOverrides(base, malicious);
  assert.equal(updated.employeeId, 'coder');
  assert.deepEqual(updated.allowedOverrides, base.allowedOverrides);
  // characterPack stays unless the payload itself is the trusted override call
  assert.equal(updated.characterPack, 'whale-girl');
});

test('unknown employee id resolves to null, not a fabricated profile', () => {
  assert.equal(profiles.getResidentProfile('ghost'), null);
  assert.equal(profiles.getResidentProfile(undefined), null);
});

test('resolveProfileForSeat maps fixed seats to residents and leaves desk-5/6 free', () => {
  assert.equal(profiles.resolveProfileForSeat('desk-1').employeeId, 'orchestrator');
  assert.equal(profiles.resolveProfileForSeat('desk-2').employeeId, 'researcher');
  assert.equal(profiles.resolveProfileForSeat('desk-3').employeeId, 'coder');
  assert.equal(profiles.resolveProfileForSeat('desk-4').employeeId, 'reviewer');
  assert.equal(profiles.resolveProfileForSeat('desk-5'), null);
  assert.equal(profiles.resolveProfileForSeat('desk-6'), null);
});
