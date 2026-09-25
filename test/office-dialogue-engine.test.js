'use strict';

// M4.1d — the dialogue engine had ZERO coverage since E5c-1. These tests pin
// the committed contract the office module now depends on: corpus merge
// (character overrides stack on top of the base pool), per-pair cooldown,
// injected-rng determinism, and the topic vocabulary.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { createDialogueEngine } = require(path.join(ROOT, 'src', 'office', 'runtime', 'dialogue-engine.js'));

const BASE = Object.freeze({
  topics: {
    greeting: [
      { id: 'g-01', text: '早', weight: 3 },
      { id: 'g-02', text: '回来了', weight: 1 },
    ],
    pantry: [
      { id: 'p-01', text: '米缸还有半缸', weight: 2 },
    ],
  },
  limits: { bubbleMs: 3200, maxConcurrent: 2, cooldownMs: 30000 },
});
const OVERRIDES = Object.freeze({
  overrides: {
    greeting: [{ id: 'wg-g-01', text: '咕噜~', weight: 4 }],
    idle: [{ id: 'wg-i-01', text: '（发呆）', weight: 1 }],
  },
});

function seqRng(values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

test('the engine merges character overrides on top of the base pool', () => {
  const engine = createDialogueEngine({ base: BASE, characterOverrides: OVERRIDES });
  const greeting = engine.entriesFor('greeting');
  assert.equal(greeting.length, 3, 'base 2 + override 1');
  assert.ok(greeting.some((entry) => entry.id === 'wg-g-01'), 'the override entry is present');
  assert.deepEqual(engine.topics.slice().sort(), ['greeting', 'idle', 'pantry'], 'override-only topics join the vocabulary');
});

test('pick returns a corpus line and enforces the per-pair cooldown', () => {
  const engine = createDialogueEngine({ base: BASE, characterOverrides: OVERRIDES, cooldownMs: 30000 });
  const rng = seqRng([0.0, 0.0]); // topic = first, entry = first
  const first = engine.pick('orchestrator', 'researcher', 1000, rng);
  assert.ok(first && typeof first.text === 'string' && typeof first.topic === 'string', 'a line comes back');
  assert.equal(engine.pick('orchestrator', 'researcher', 29999, rng), null, 'still on cooldown');
  const second = engine.pick('orchestrator', 'researcher', 31000, rng);
  assert.ok(second, 'cooldown elapsed — the pair speaks again');
  // the pair key is order-independent
  assert.equal(engine.pick('researcher', 'orchestrator', 31001 + 29998, rng), null, 'reverse order shares the cooldown');
  engine.clearCooldown('orchestrator|researcher');
  assert.ok(engine.pick('researcher', 'orchestrator', 1, rng), 'clearCooldown resets the pair');
});

test('pick is deterministic for the same corpus + injected rng sequence', () => {
  const a = createDialogueEngine({ base: BASE, characterOverrides: OVERRIDES });
  const b = createDialogueEngine({ base: BASE, characterOverrides: OVERRIDES });
  const rngA = seqRng([0.5, 0.49, 0.99, 0.99]);
  const rngB = seqRng([0.5, 0.49, 0.99, 0.99]);
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(a.pick('coder', 'reviewer', i * 60000, rngA), b.pick('coder', 'reviewer', i * 60000, rngB));
  }
});

test('the bundled production corpus is valid for the engine (resources copy)', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'dialogue', 'base.json'), 'utf8'));
  const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'dialogue', 'characters', 'deepseek-default.json'), 'utf8'));
  const engine = createDialogueEngine({ base, characterOverrides: overrides });
  assert.ok(engine.topics.length >= 6, `the merged vocabulary carries every topic (${engine.topics.length})`);
  for (const topic of engine.topics) {
    assert.ok(engine.entriesFor(topic).length > 0, `${topic} has entries`);
    for (const entry of engine.entriesFor(topic)) assert.ok(entry.text && entry.text.length > 0, `${topic}:${entry.id} has text`);
  }
});
