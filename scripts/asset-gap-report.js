#!/usr/bin/env node
/**
 * 素材缺口报告（M3 / 2026-09-17）——「必要的再生成」的第一道闸门。
 *
 * 对照目标库存（D10 步态决议 + working 桌沿重制 + 摸鱼三姿态）盘点：
 *   - 生产包已注册帧数（resources/characters/deepseek-default）
 *   - photo/output_nobg/ 候选帧（复用优先，D11）
 * 输出每个动作的 status / gap / 可复用候选 / 需生成数，供 gen-frames.js
 * 只对缺口调用生图 API。纯核心 buildInventory 可测；CLI 只读文件并打印。
 *
 * 用法：node scripts/asset-gap-report.js [--json photo/build/gap-report.json]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 摸鱼/动作素材与目标动作的别名映射（文件名 → 目标动作）
const ALIASES = Object.freeze({
  'action-eat.png': 'idle-lunch',
});

function aliasFor(filename) {
  return ALIASES[filename] || null;
}

// 目标库存（2026-09-16 D10/D11 决议）。rework 动作的存量帧一律不算覆盖。
const DEFAULT_TARGET = Object.freeze({
  'walk-down': { frames: 8, note: '步态 8 帧 @150-200ms（D10）' },
  'walk-left': { frames: 8, note: '步态 8 帧 @150-200ms（D10）' },
  'walk-right': { frames: 8, note: '步态 8 帧 @150-200ms（D10）' },
  'walk-up': { frames: 8, note: '步态 8 帧 @150-200ms（D10）' },
  // 2026-09-17 用户定：工作表现由背向坐姿承担（正面朝观众的 working 不用于工位场景）
  working: { frames: 1, note: '正面工作帧保持现状（不用于工位呈现）' },
  'working-back': { frames: 6, note: '背向坐姿动作循环升级 3→6 帧（手臂/头部小动作，用户 2026-09-17 定）' },
  'idle-nap': { frames: 1, note: '摸鱼三姿态（P1）' },
  'idle-blink': { frames: 1, note: '摸鱼三姿态（P1）' },
  'idle-lunch': { frames: 1, note: '摸鱼三姿态（P1）' },
});

function candidateMatches(action, filename) {
  // walk-left-03.png / working-front-3q-01.png → 同动作前缀
  return filename.startsWith(`${action}-`) && /\.png$/.test(filename);
}

function buildInventory({ target = DEFAULT_TARGET, pack = {}, candidates = [], importedBasenames = [] } = {}) {
  if (!target || typeof target !== 'object') throw new TypeError('buildInventory requires a target map');
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array of filenames');
  if (!Array.isArray(importedBasenames)) throw new TypeError('importedBasenames must be an array');
  const imported = new Set(importedBasenames);

  const actions = {};
  let toGenerateTotal = 0;

  for (const [name, spec] of Object.entries(target)) {
    const wanted = spec.frames;
    const packFrames = pack[name] || 0;
    const allMatches = candidates.filter((f) => candidateMatches(name, f) || aliasFor(f) === name);
    // D11 dedup: a candidate whose basename is already a pack frame is the
    // SOURCE of that registered frame, not new coverage — counting both was
    // double counting (the M3 first run mistook walk dirs for 'complete').
    const candidateFiles = allMatches.filter((f) => !imported.has(f));
    const alreadyImported = allMatches.length - candidateFiles.length;
    const candidateFrames = candidateFiles.length;

    let status;
    let gapFrames;
    let toGenerate;

    if (spec.rework) {
      // 重制组：包内存量不算覆盖（旧帧带桌沿等缺陷），但未导入的干净候选算
      // （2026-09-17 视觉复核：working-front-3q×4 即无桌沿重制组，直接复用）
      status = 'rework';
      gapFrames = Math.max(0, wanted - candidateFrames);
      toGenerate = gapFrames;
    } else if (packFrames >= wanted) {
      status = 'complete';
      gapFrames = 0;
      toGenerate = 0;
    } else {
      gapFrames = wanted - packFrames;
      // 候选可抵扣缺口，但候选是否真能过几何归一化由导入预校验决定（第二步）
      toGenerate = Math.max(0, gapFrames - candidateFrames);
      status = packFrames === 0 && candidateFrames === 0 ? 'missing' : (packFrames === 0 ? 'candidate-only' : 'extend');
      if (toGenerate === 0 && packFrames + candidateFrames >= wanted) status = 'complete';
    }

    actions[name] = Object.freeze({
      status, wanted, packFrames, candidateFrames, alreadyImported,
      candidateFiles: Object.freeze(candidateFiles),
      gapFrames, toGenerate, rework: spec.rework || null, note: spec.note || null,
    });
    toGenerateTotal += toGenerate;
  }

  return Object.freeze({
    actions: Object.freeze(actions),
    summary: Object.freeze({ toGenerate: toGenerateTotal }),
  });
}

// ---- CLI ---------------------------------------------------------------------

function readPackAnimationCounts(repoRoot) {
  const animationsPath = path.join(repoRoot, 'resources', 'characters', 'deepseek-default', 'animation', 'animations.json');
  const parsed = JSON.parse(fs.readFileSync(animationsPath, 'utf8'));
  const counts = {};
  for (const [name, entry] of Object.entries(parsed.animations || {})) {
    counts[name] = Array.isArray(entry.frames) ? entry.frames.length : 0;
  }
  return counts;
}

function readImportedBasenames(repoRoot) {
  const animRoot = path.join(repoRoot, 'resources', 'characters', 'deepseek-default', 'assets', 'animations');
  const names = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.png')) names.push(entry.name);
    }
  };
  walk(animRoot);
  return names;
}

function readCandidates(repoRoot) {
  const dir = path.join(repoRoot, 'photo', 'output_nobg');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort();
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const report = buildInventory({
    target: DEFAULT_TARGET,
    pack: readPackAnimationCounts(repoRoot),
    candidates: readCandidates(repoRoot),
    importedBasenames: readImportedBasenames(repoRoot),
  });

  const lines = ['# 素材缺口报告（必要的再生成）', '',
    '| 动作 | 状态 | 包内 | 候选 | 缺口 | 需生成 | 备注 |', '|---|---|---|---|---|---|---|'];
  for (const [name, a] of Object.entries(report.actions)) {
    lines.push(`| ${name} | ${a.status} | ${a.packFrames} | ${a.candidateFrames} | ${a.gapFrames} | ${a.toGenerate} | ${a.rework || a.note || ''} |`);
  }
  lines.push('', `**合计需生成：${report.summary.toGenerate} 帧**`, '');
  console.log(lines.join('\n'));

  const jsonFlag = process.argv.indexOf('--json');
  if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
    const out = process.argv[jsonFlag + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(`[gap-report] wrote ${out}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main();

module.exports = { buildInventory, DEFAULT_TARGET, aliasFor, candidateMatches };
