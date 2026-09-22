#!/usr/bin/env node
/**
 * 应用最终行走序列（M3 / 2026-09-17）——把用户定稿的帧顺序写进角色包。
 *
 * 用法：
 *   node scripts/apply-walk-sequence.js --action walk-left \
 *     --order "pack:02,pack:03,card:C-02,pack:passing,card:C-04,card:C-01,card:C-05,pack:03" \
 *     --duration 180 [--publish]
 *
 * --order 项：
 *   pack:NN        包内现有帧 assets/animations/walk/<dir>/walk-<dir>-NN.png
 *   pack:passing   包内 passing 帧
 *   card:C-XX      gpt 抽卡帧（photo/output/m3-walk-gacha-nobg/walk-<dir>-XX.png），
 *                  归一化后作为内容资产写入，发布时复制进包
 *
 * --mirror-right：读取左走定稿序列，逐帧水平镜像生成右走同名帧并写右走文档。
 *   镜像=不重绘（用户 2026-09-17 定）；重复帧（同一文件出现两次）原样保留。
 *
 * 发布走 workbench 发布内核（fail-closed + 备份 + provenance），与工作台同一路径。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const lib = {
  model: require(path.join(ROOT, 'src', 'workbench', 'lib', 'action-model.js')),
  normalizer: require(path.join(ROOT, 'src', 'workbench', 'lib', 'normalizer.js')),
  publisher: require(path.join(ROOT, 'src', 'workbench', 'lib', 'action-publisher.js')),
  geometry: require(path.join(ROOT, 'src', 'workbench', 'lib', 'character-geometry.js')),
};

const CHARACTERS_ROOT = path.join(ROOT, 'resources', 'characters');
const PATHS = lib.publisher.createPaths({ contentDir: path.join(ROOT, 'content'), charactersRoot: CHARACTERS_ROOT });

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function packDefaults() {
  const character = JSON.parse(fs.readFileSync(PATHS.characterJsonPath, 'utf8'));
  return {
    canvas: character.pack.canvas,
    anchor: character.pack.anchor,
    footLine: character.pack.footLine,
  };
}

function walkMedianVisibleHeight(actionId) {
  // 目标可见高 = 同动作现存帧实测中位数（与工作台导入同一规则）
  const character = JSON.parse(fs.readFileSync(PATHS.characterJsonPath, 'utf8'));
  const entry = character.actions && character.actions[actionId];
  const heights = [];
  if (entry && Array.isArray(entry.frames)) {
    for (const frame of entry.frames) {
      const abs = lib.publisher.resolveFramePath(PATHS, frame.file);
      if (!abs) continue;
      const m = lib.geometry.measureFrameFile(abs);
      if (m.ok) heights.push(m.visibleHeight);
    }
  }
  if (!heights.length) return 256;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)];
}

function cardAssetName(actionId, dir, cardLabel) {
  // 确定性命名（幂等）：C-02 -> assets/animations/walk/left/walk-left-c02.png
  return `assets/animations/walk/${dir}/${actionId}-c${cardLabel.replace(/^C-/, '').toLowerCase()}.png`;
}

function normalizeCard({ actionId, dir, cardLabel, targetHeight, footLine, defaults, taken }) {
  // C-02 → photo/output/m3-walk-gacha-nobg/walk-left-02.png
  const num = cardLabel.replace(/^C-/, '');
  const src = path.join(ROOT, 'photo', 'output', 'm3-walk-gacha-nobg', `${actionId}-${num}.png`);
  if (!fs.existsSync(src)) return { ok: false, error: `card source missing: ${src}` };
  const name = cardAssetName(actionId, dir, cardLabel);
  const targetAbs = path.join(PATHS.assetsDir, name);
  if (fs.existsSync(targetAbs)) {
    // 复用已归一化资产（确定性归一化：同源同参同字节）
    return { ok: true, name, src, reused: true };
  }
  const outcome = lib.normalizer.normalizeImportFrame({
    sourceBytes: fs.readFileSync(src),
    targetHeight,
    footLine,
    packCanvas: defaults.canvas,
    packAnchor: defaults.anchor,
  });
  if (!outcome.ok) return { ok: false, error: `card ${cardLabel} failed normalize`, violations: outcome.violations };
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, outcome.png);
  taken.add(name);
  return { ok: true, name, src };
}

function buildOrderItems(order, actionDir) {
  // "pack:02" → assets/animations/walk/left/walk-left-02.png
  return order.split(',').map((item) => {
    const [kind, label] = item.split(':');
    if (kind === 'pack') {
      const file = label === 'passing'
        ? `assets/animations/walk/${actionDir}/walk-${actionDir}-passing-01.png`
        : `assets/animations/walk/${actionDir}/walk-${actionDir}-${label}.png`;
      return { kind, label, file };
    }
    return { kind, label };
  });
}

// geometry.footLine is AUTO-MEASURED from the doc's own frames (the §6.2
// contract) — the pack-level default only made sense while the published
// sequence happened to share its median (2026-09-18: dropping a frame shifted
// the median 296 → 295 and the doc silently disagreed with its own frames).
function measuredFootLine(frames) {
  const feet = frames.map((file) => {
    const abs = lib.publisher.resolveFramePath(PATHS, file);
    if (!abs) { console.error(`[apply] cannot resolve ${file} for geometry`); process.exit(1); }
    return lib.geometry.measureFrameFile(abs).footLine;
  });
  return Math.round(lib.geometry.median(feet));
}

function writeDoc(actionId, direction, frames, durationMs) {
  const doc = {
    schemaVersion: 1,
    id: actionId,
    loop: true,
    direction,
    frames: frames.map((file) => ({ file, durationMs })),
    geometry: { footLine: measuredFootLine(frames), tolerancePx: 1 },
  };
  const parsed = lib.model.parseActionDoc(JSON.stringify(doc));
  if (!parsed.ok) return { ok: false, error: 'doc rejected by model', detail: parsed };
  lib.model.saveActionDoc(path.join(PATHS.actionsDir, `${actionId}.json`), parsed.action);
  return { ok: true, doc: parsed.action };
}

function publish(actionId) {
  return lib.publisher.publishAction({
    contentDir: path.join(ROOT, 'content'),
    charactersRoot: CHARACTERS_ROOT,
    actionId,
  });
}

function main() {
  const duration = Number(argValue('--duration', '180'));
  const doPublish = process.argv.includes('--publish');
  const mirrorRight = process.argv.includes('--mirror-right');

  if (mirrorRight) {
    // 读取左走定稿文档 → 逐帧镜像 → 写右走内容资产 → 写右走文档
    const leftDoc = JSON.parse(fs.readFileSync(path.join(PATHS.actionsDir, 'walk-left.json'), 'utf8'));
    const defaults = packDefaults();
    const rightFrames = [];
    const seen = new Set();
    for (const frame of leftDoc.frames) {
      const rightFile = frame.file.replace('/walk/left/', '/walk/right/').replace('walk-left', 'walk-right');
      if (!seen.has(rightFile)) {
        seen.add(rightFile);
        const srcAbs = lib.publisher.resolveFramePath(PATHS, frame.file);
        if (!srcAbs) { console.error(`[apply] cannot resolve ${frame.file}`); process.exit(1); }
        const mirror = require(path.join(ROOT, 'scripts', 'gen-frames.js')).flipHorizontal(fs.readFileSync(srcAbs));
        const dstAbs = path.join(PATHS.assetsDir, rightFile);
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.writeFileSync(dstAbs, mirror);
        console.log(`[apply] mirror ${frame.file} -> ${rightFile}`);
      }
      rightFrames.push(rightFile);
    }
    const wrote = writeDoc('walk-right', 'right', rightFrames, leftDoc.frames[0].durationMs);
    if (!wrote.ok) { console.error('[apply] right doc rejected:', JSON.stringify(wrote.detail)); process.exit(1); }
    console.log(`[apply] walk-right doc: ${rightFrames.length} frames`);
    if (doPublish) {
      const result = publish('walk-right');
      console.log('[apply] publish walk-right:', JSON.stringify(result, null, 1).slice(0, 800));
      process.exit(result.ok ? 0 : 1);
    }
    return;
  }

  const actionId = argValue('--action', 'walk-left');
  const order = argValue('--order');
  if (!order) { console.error('--order required'); process.exit(2); }
  const direction = actionId.replace('walk-', '');
  const defaults = packDefaults();
  const targetHeight = walkMedianVisibleHeight(actionId);
  const footLine = defaults.footLine;

  const items = buildOrderItems(order, direction);
  const taken = new Set(items.filter((x) => x.kind === 'pack').map((x) => x.file));
  const frames = [];
  console.log(`[apply] ${actionId}: targetHeight=${targetHeight} footLine=${footLine} duration=${duration}ms`);
  for (const item of items) {
    if (item.kind === 'pack') {
      const abs = lib.publisher.resolveFramePath(PATHS, item.file);
      if (!abs) { console.error(`[apply] pack frame missing: ${item.file}`); process.exit(1); }
      frames.push(item.file);
      console.log(`  pack  ${item.label} -> ${item.file}`);
    } else {
      const result = normalizeCard({ actionId, dir: direction, cardLabel: item.label, targetHeight, footLine, defaults, taken });
      if (!result.ok) {
        console.error(`[apply] card ${item.label} failed: ${result.error}`, JSON.stringify(result.violations || []));
        process.exit(1);
      }
      frames.push(result.name);
      console.log(`  card  ${item.label} -> ${result.name}${result.reused ? ' (复用已归一化资产)' : ` (from ${path.relative(ROOT, result.src)})`}`);
    }
  }
  const wrote = writeDoc(actionId, direction, frames, duration);
  if (!wrote.ok) { console.error('[apply] doc rejected:', JSON.stringify(wrote.detail)); process.exit(1); }
  console.log(`[apply] ${actionId} doc written: ${frames.length} frames (含重复帧保留)`);

  if (doPublish) {
    const result = publish(actionId);
    console.log('[apply] publish:', JSON.stringify(result, null, 1).slice(0, 1200));
    if (!result.ok) process.exit(1);
  } else {
    console.log('[apply] 未发布（加 --publish 才写入包）');
  }
}

if (require.main === module) main();
module.exports = { buildOrderItems, cardAssetName };
