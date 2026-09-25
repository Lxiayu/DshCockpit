#!/usr/bin/env node
// scripts/asset-pack-resolve-probe.js — 迁移接线验证探针（docs/strategy/
// 2026-09-23-migration-wiring-verification.md §1）：生产角色包的 resolve() 覆盖面
// ——四方向行走（b01..bNN 多帧序列）/ working-back / sleeping / idle / idle-blink /
// idle-lunch，以及 adapter 词汇表到美术的兜底链。只读 pack 文件：零网络、零
// Electron、零副作用。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createAssetPack } = require('../src/office/runtime/asset-pack.js');

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'resources', 'characters', 'deepseek-default');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = readJson(path.join(root, 'manifest.json'));
const pack = createAssetPack({
  manifest,
  anchors: readJson(path.join(root, 'animation', 'anchors.json')),
  animations: readJson(path.join(root, 'animation', 'animations.json')),
});
if (!pack.ok) {
  console.error(`pack invalid (${root}): ${pack.code}`);
  process.exit(1);
}
const P = pack.pack;
const show = (r) => ({ code: r.code, resource: r.resource, frames: r.frameCount, fallback: r.fallbackReason, missing: [...r.capabilityMissing] });

const out = { packRoot: root, packId: manifest.id, packVersion: manifest.version, walk: {}, states: {}, derived: {}, declared: {}, onDisk: {} };

for (const dir of ['up', 'down', 'left', 'right']) {
  out.walk[dir] = show(P.resolve({ state: 'walk', direction: dir }));
}
for (const state of ['working', 'working-back', 'sleeping', 'idle', 'idle-blink', 'idle-lunch', 'finished', 'error', 'warning', 'side-left', 'side-right', 'side-back']) {
  out.states[state] = show(P.resolve({ state }));
}
// adapter vocabulary → art fallback chains (documented degradation)
for (const state of ['chatting', 'celebrating', 'completed', 'failed', 'attention', 'thinking', 'waiting', 'moving']) {
  out.derived[state] = show(P.resolve({ state, direction: 'left' }));
}

// declared frame sequences vs the files actually on disk
const animations = readJson(path.join(root, 'animation', 'animations.json'));
for (const [id, anim] of Object.entries(animations.animations)) {
  const files = (anim.frames || []).map((f) => (typeof f === 'string' ? f : f.file)).filter(Boolean);
  const missing = files.filter((file) => !fs.existsSync(path.join(root, file)));
  out.declared[id] = { frames: files.length, first: files[0] ? path.basename(files[0]) : null, last: files.length ? path.basename(files[files.length - 1]) : null };
  out.onDisk[id] = { missing: missing.length };
}
out.missingCapabilities = P.missingCapabilities();
console.log(JSON.stringify(out, null, 1));

const bad = Object.entries(out.onDisk).filter(([, v]) => v.missing > 0).map(([k]) => k);
if (bad.length) {
  console.error(`declared frames missing on disk: ${bad.join(', ')}`);
  process.exit(2);
}
