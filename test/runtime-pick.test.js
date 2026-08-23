// test/runtime-pick.test.js — H5 runtime candidate priority: the shell
// prefers the user's own system dsh (likely the ~/.dsh writer) whenever it is
// at least as new as the bundled seed, with a smoke guard on every
// non-active candidate and graceful fallthrough.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { pickRuntimeCandidate, versionKey } = require('../src/runtime-pick');

const SYSTEM_NEW = { version: '0.1.1-rc.2', path: '/sys/node_modules' };
const SYSTEM_OLD = { version: '0.1.0-rc.7', path: '/sys/node_modules' };
const BUNDLED_RC8 = { version: '0.1.0-rc.8', path: '/bundle/seed' };
const ACTIVE = { version: '0.1.0-rc.8', path: '/active' };
const smokeOk = async () => true;

test('a live active pointer always wins and is never re-smoked', async () => {
  let smokeCalls = 0;
  const pick = await pickRuntimeCandidate({ active: ACTIVE, system: SYSTEM_NEW, bundled: BUNDLED_RC8, smoke: async () => { smokeCalls += 1; return true; } });
  assert.strictEqual(pick.choice, 'active');
  assert.strictEqual(pick.candidate, ACTIVE);
  assert.strictEqual(smokeCalls, 0);
});

test('H5 scenario: system dsh 0.1.1-rc.2 + bundled seed 0.1.0-rc.8 → the SYSTEM dsh is selected', async () => {
  const pick = await pickRuntimeCandidate({ active: null, system: SYSTEM_NEW, bundled: BUNDLED_RC8, smoke: smokeOk });
  assert.strictEqual(pick.choice, 'system');
  assert.strictEqual(pick.candidate.version, '0.1.1-rc.2');
});

test('no system dsh → falls back to the bundled seed', async () => {
  const pick = await pickRuntimeCandidate({ active: null, system: null, bundled: BUNDLED_RC8, smoke: smokeOk });
  assert.strictEqual(pick.choice, 'bundled');
  const none = await pickRuntimeCandidate({ active: null, system: null, bundled: null, smoke: smokeOk });
  assert.strictEqual(none, null);
});

test('an older system dsh (0.1.0-rc.7 < rc.8) loses to the bundled seed', async () => {
  const pick = await pickRuntimeCandidate({ active: null, system: SYSTEM_OLD, bundled: BUNDLED_RC8, smoke: smokeOk });
  assert.strictEqual(pick.choice, 'bundled');
});

test('a failing candidate is skipped and the next one wins; all-fail yields null', async () => {
  // broken npx half-install on PATH → bundled takes over
  const pick = await pickRuntimeCandidate({
    active: null, system: SYSTEM_NEW, bundled: BUNDLED_RC8,
    smoke: async (cand) => cand.path !== SYSTEM_NEW.path,
  });
  assert.strictEqual(pick.choice, 'bundled');
  const none = await pickRuntimeCandidate({ active: null, system: SYSTEM_NEW, bundled: BUNDLED_RC8, smoke: async () => false });
  assert.strictEqual(none, null);
  // a throwing smoke counts as failed too
  const thrown = await pickRuntimeCandidate({ active: null, system: SYSTEM_NEW, bundled: BUNDLED_RC8, smoke: async () => { throw new Error('boom'); } });
  assert.strictEqual(thrown, null);
});

test('unparseable versions sort last but keep the documented order on ties', async () => {
  const junk = { version: 'not-a-version', path: '/junk' };
  const pick = await pickRuntimeCandidate({ active: null, system: junk, bundled: BUNDLED_RC8, smoke: smokeOk });
  assert.strictEqual(pick.choice, 'bundled');
  const tie = await pickRuntimeCandidate({ active: null, system: { ...SYSTEM_NEW }, bundled: { ...BUNDLED_RC8, version: '0.1.1-rc.2' }, smoke: smokeOk });
  assert.strictEqual(tie.choice, 'system', 'equal versions keep system first');
});

test('versionKey normalizes rc tags and nulls out junk', () => {
  assert.strictEqual(versionKey('0.1.1-rc.2'), '0.1.1-rc.2');
  assert.strictEqual(versionKey('0.1.0-rc.8'), '0.1.0-rc.8');
  assert.strictEqual(versionKey('unknown'), null);
  assert.strictEqual(versionKey(''), null);
});
