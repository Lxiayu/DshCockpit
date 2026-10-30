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

// ---------------------------------------------------------------------------
// 2026-10-30：语料内容红线（依据 artifacts/whale-lore-research.md 的社区调研）
// ---------------------------------------------------------------------------
test('dialogue corpus stays inside the community-safe content boundary', () => {
  const files = [
    path.join(ROOT, 'resources', 'dialogue', 'base.json'),
    path.join(ROOT, 'resources', 'dialogue', 'characters', 'deepseek-default.json'),
  ];
  // 每一类都写明"为什么禁用"，避免后人以为是随意黑名单。
  const BANNED = [
    { pattern: /鱼片/, why: '社区语感里=生鱼片/切片，且是"对用户"的称呼，同事互聊不成立' },
    { pattern: /主人|爸爸/, why: '对用户/越界亲密称呼；同事关系里不成立，且部分社区人设明确反对' },
    { pattern: /便宜货|涨价|加钱|降智|上错模型/, why: '绑定 API 定价/技术自贬，与产品可信度冲突' },
    { pattern: /溟月|上善无形|ZipZipPipe|女仆装/, why: '原型版权 CC BY-NC-SA 非商用，商业化产品不能玩梗式提及' },
    { pattern: /AI画|手绘|正统|男版/, why: '社区真实引战话题（画师被冲至删稿），一票否决' },
    { pattern: /玉足|白丝|出浴|涩|丝袜/, why: '擦边软色情，正是当年争议来源，商用必须彻底切割' },
    { pattern: /减肥|又胖了|肥猪/, why: '体重羞辱（对她或对用户），双向红线' },
    { pattern: /DeepSleep|CoT|MoE|token余额/, why: '术语化，非技术用户零理解' },
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { pattern, why } of BANNED) {
      const hit = text.match(pattern);
      assert.equal(hit, null, `${path.basename(file)} 命中禁用内容「${hit && hit[0]}」：${why}`);
    }
  }
});

test('the character corpus never addresses the user (peers talk to each other)', () => {
  // 场景是鲸鱼娘 A 对鲸鱼娘 B 闲聊 —— 同事之间不会互称"鱼片/主人"。
  // 这条测试把"不出现用户称呼"固定下来，避免以后又加回去。
  const corpus = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'resources', 'dialogue', 'characters', 'deepseek-default.json'), 'utf8',
  ));
  for (const [topic, entries] of Object.entries(corpus.overrides)) {
    for (const entry of entries) {
      assert.doesNotMatch(entry.text, /鱼片|主人|爸爸/, `${topic}:${entry.id} 不能称呼用户「${entry.text}」`);
      assert.ok(entry.text.length > 0 && entry.text.length <= 30, `${topic}:${entry.id} 长度合理`);
    }
  }
});
