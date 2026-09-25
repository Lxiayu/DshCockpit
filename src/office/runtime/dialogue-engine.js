'use strict';

// src/office/runtime/dialogue-engine.js — pure dialogue state machine.
// Consumes the base corpus + character overrides, selects a topic line for
// an active chat pair, and enforces cooldowns. No DOM, no Electron, no clock
// (now is injected). Deterministic for the same (corpus, tick, seed) input.

function createDialogueEngine(options = {}) {
  const base = options.base || {};
  const overrides = options.characterOverrides || {};
  const cooldownMs = options.cooldownMs || 30000;
  const bubbleMs = options.bubbleMs || 3200;
  const maxConcurrent = options.maxConcurrent || 2;

  // merged topic pool: character overrides take priority over base entries
  const topicPool = {};
  for (const [topic, entries] of Object.entries(base.topics || {})) {
    topicPool[topic] = entries.map((e) => Object.freeze({ ...e }));
  }
  const charOverrides = overrides.overrides || {};
  for (const [topic, entries] of Object.entries(charOverrides)) {
    if (!topicPool[topic]) topicPool[topic] = [];
    for (const e of entries) topicPool[topic].push(Object.freeze({ ...e }));
  }
  const topicNames = Object.freeze(Object.keys(topicPool));

  // per-pair cooldown state
  const pairCooldowns = new Map(); // key "a|b" (sorted) → lastShownAtMs

  // Weighted pick over the topic pool (corpus entries carry a weight; the
  // default is 1). Consumes exactly ONE rng value, like the uniform pick did,
  // so injected-rng determinism is unchanged.
  function pickEntry(topicName, rng) {
    const pool = topicPool[topicName];
    if (!pool || pool.length === 0) return null;
    const weights = pool.map((entry) => (Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = (typeof rng === 'function' ? rng() : Math.random()) * total;
    for (let index = 0; index < pool.length; index += 1) {
      roll -= weights[index];
      if (roll < 0) return pool[index];
    }
    return pool[pool.length - 1] || null;
  }

  return Object.freeze({
    topics: topicNames,
    // Select a dialogue line for a chat pair at time `nowMs`.
    // Returns { text, topic } or null if on cooldown.
    // options.inConversation: the pair is mid-chat — members alternate at the
    // bubble cadence (the 30s cooldown governs BETWEEN conversations, never
    // inside one; a 15s chat used to show a single line because the cooldown
    // outlasted the chat). The pick still records lastShownAt, so the
    // between-conversations cooldown starts at the pair's final line.
    pick(aId, bId, nowMs, rng, options = {}) {
      const key = [aId, bId].sort().join('|');
      const last = pairCooldowns.get(key);
      if (!options.inConversation && last !== undefined && nowMs - last < cooldownMs) return null;
      const topicName = topicNames[Math.floor((typeof rng === 'function' ? rng() : Math.random()) * topicNames.length)];
      const entry = pickEntry(topicName, rng);
      if (!entry) return null;
      pairCooldowns.set(key, nowMs);
      return { text: entry.text, topic: topicName };
    },
    // Direct topic query (for testing / forced selection)
    entriesFor(topicName) {
      return topicPool[topicName] || [];
    },
    clearCooldown(pairKey) {
      pairCooldowns.delete(pairKey);
    },
  });
}

module.exports = { createDialogueEngine };
