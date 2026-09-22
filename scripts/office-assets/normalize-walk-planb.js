#!/usr/bin/env node
/**
 * scripts/office-assets/normalize-walk-planb.js — 二代行走素材接入（方案B）。
 *
 * 素材来源：photo/output/b-plan/walk-<dir>-NN.png（AI 视频 → RVM 抠像 →
 * 后处理：黑块清除 / 反预乘 / alpha 硬化，560² RGBA，预乘空间缩放）。
 *
 * 本脚本把素材走 M1 确定性导入管线（normalizeImportFrame：一次等比缩放 +
 * 一次整数平移，alpha 不重采样以外的处理）归一化进角色包几何：
 *   - 可见高统一 256（= 同动作现存帧实测中位数，保持各方向/各帧同尺寸）；
 *   - 鞋线（alpha≥128 最低行中位 x）对齐包锚点 (178, 296)，即 footLine；
 *   - 352² 画布，可见像素必须完整落在画布内（越界即 fail-closed）。
 *
 * 随后写内容资产 + 动作文档（actions/walk-<dir>.json，83ms/帧），
 * 再走发布内核 publishAction（校验 → 同步进 resources 包 → 重建
 * animations.json / anchors.json / character.json + provenance + 备份回滚）。
 *
 * 命名：新帧写为 assets/animations/walk/<dir>/walk-<dir>-bNN.png
 * （b = 二代）。刻意不与旧帧同名：发布器对"已存在的文件名"会沿用旧锚点
 * 元数据，新文件才会重新测量，避免旧几何写进新字节。
 *
 * 用法：
 *   node scripts/office-assets/normalize-walk-planb.js --dry-run
 *   node scripts/office-assets/normalize-walk-planb.js [--dirs left,right,up,down]
 *
 * 退出码：0 = 全部归一化并发布成功；4 = 几何校验失败（未写入）；3 = 用法/环境错误。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeImportFrame } = require(path.join(ROOT, 'src', 'workbench', 'lib', 'normalizer.js'));
const { decodePng, encodePng, lowestRowAtLeastAlpha } = require(path.join(ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
const { measureFrameFile, median } = require(path.join(ROOT, 'src', 'workbench', 'lib', 'character-geometry.js'));
const model = require(path.join(ROOT, 'src', 'workbench', 'lib', 'action-model.js'));
const publisher = require(path.join(ROOT, 'src', 'workbench', 'lib', 'action-publisher.js'));

const CONTENT_DIR = path.join(ROOT, 'content');
const CHARACTERS_ROOT = path.join(ROOT, 'resources', 'characters');
const PLANB_DIR = path.join(ROOT, 'photo', 'output', 'b-plan');
const DURATION_MS = 83;

// 抠像残留的极弱 alpha 噪点（实测 down 帧体外 26~71 个，全部落在 8~32）会把
// alpha>8 的可见包围盒撑到整幅，归一化时被边界钳制采样放大成"输出过高"。
// 导入前把 alpha<48 的像素清零：纯噪点级（<19% 不透明度），肉眼与缩放均不可见。
const FAINT_ALPHA_MIN = 48;

// 水平对齐（踩过的坑，务必保留）：normalizeImportFrame 会把"每帧自己的脚尖"钉到
// 锚点 x=178。走路时脚尖相对躯干前后摆（本批侧视素材里脚尖 x 逐帧跨度 108~118px），
// 逐帧钉脚尖会把躯干整体推来推去 —— 实测 pack 内躯干水平 std 14px、单步突变 0.10
// （相邻帧差均值的 2.4 倍），办公室里表现成"走一段就往回跳一下"。
// 修正：归一化之后按**躯干（上半身）质心**做方向级统一对齐（躯干在源素材里几乎不动，
// std≈0.5px），这样躯干稳定、摆动腿自然前后摆。
const TORSO_TOP_FRACTION = 0.30; // 取可见包围盒上 30%（头/肩）作躯干参照

function stripFaintAlpha(bytes) {
  let image;
  try { image = decodePng(bytes); } catch { return { image: null, stripped: 0 }; }
  const { data } = image;
  let stripped = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0 && data[i] < FAINT_ALPHA_MIN) { data[i] = 0; stripped += 1; }
  }
  return { image, stripped };
}

// 脚尖 x：最低 alpha>=128 行上所有像素的 x 中位数（与 pipeline 的 contact 规则一致）。
function contactXOf(image) {
  const row = lowestRowAtLeastAlpha(image, 128);
  if (row === null) return null;
  const xs = [];
  for (let x = 0; x < image.width; x += 1) {
    if (image.data[(row * image.width + x) * 4 + 3] >= 128) xs.push(x);
  }
  if (!xs.length) return null;
  return xs[Math.floor(xs.length / 2)];
}

// 躯干（上半身）质心 x：取 alpha>8 可见包围盒上 30% 的像素 x 均值。
function torsoCentroidX(image) {
  const { width, data } = image;
  let minX = width; let maxX = -1; let minY = image.height; let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const topLimit = minY + (maxY - minY + 1) * TORSO_TOP_FRACTION;
  let sum = 0; let count = 0;
  for (let y = minY; y <= Math.floor(topLimit); y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) { sum += x; count += 1; }
    }
  }
  return count ? sum / count : null;
}

// 整数像素水平平移（精确搬字节，不重采样）；越界的部分被丢弃，调用方负责校验。
function shiftHorizontally(image, shiftX) {
  if (!shiftX) return { width: image.width, height: image.height, data: Buffer.from(image.data) };
  const { width, height, data } = image;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    const from = Math.max(0, -shiftX);
    const to = Math.min(width, width - shiftX);
    if (to <= from) continue;
    data.copy(out, row + (from + shiftX) * 4, row + from * 4, row + to * 4);
  }
  return { width, height, data: out };
}

function alphaBoundsOf(image, threshold = 8) {
  const { width, height, data } = image;
  let minX = width; let maxX = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > threshold) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  return maxX < 0 ? null : { x: minX, x1: maxX };
}

// 播放序 → b-plan 素材文件（up 为 01~13 + 22，见 output/b-plan/上走选帧记录.md）
const SEQUENCES = Object.freeze({
  left: Array.from({ length: 15 }, (_, i) => `walk-left-${String(i + 1).padStart(2, '0')}.png`),
  right: Array.from({ length: 15 }, (_, i) => `walk-right-${String(i + 1).padStart(2, '0')}.png`),
  down: Array.from({ length: 15 }, (_, i) => `walk-down-${String(i + 1).padStart(2, '0')}.png`),
  up: [...Array.from({ length: 13 }, (_, i) => `walk-up-${String(i + 1).padStart(2, '0')}.png`), 'walk-up-22.png'],
});

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// 目标可见高固定 256（= 二代首轮导入值；不逐次取"现存帧中位数"，否则重复导入会
// 因上一轮结果 256/257 而漂移）。各方向同尺寸是渲染一致性的要求。
const TARGET_HEIGHT = 256;

function targetHeightFor(paths, actionId) {
  if (TARGET_HEIGHT) return TARGET_HEIGHT;
  // 与工作台导入同一规则：目标可见高 = 同动作现存帧实测中位数
  const character = JSON.parse(fs.readFileSync(paths.characterJsonPath, 'utf8'));
  const entry = (character.actions || []).find((candidate) => candidate && candidate.id === actionId);
  const heights = [];
  for (const frame of (entry && entry.frames) || []) {
    const abs = publisher.resolveFramePath(paths, frame.file);
    if (!abs) continue;
    const measured = measureFrameFile(abs);
    if (measured.ok) heights.push(measured.visibleHeight);
  }
  return heights.length ? median(heights) : 256;
}

function packNameFor(dir, index) {
  return `assets/animations/walk/${dir}/walk-${dir}-b${String(index + 1).padStart(2, '0')}.png`;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dirs = (argValue('--dirs') || 'left,right,up,down').split(',').map((s) => s.trim()).filter(Boolean);
  const paths = publisher.createPaths({ contentDir: CONTENT_DIR, charactersRoot: CHARACTERS_ROOT });
  const anchors = JSON.parse(fs.readFileSync(paths.anchorsPath, 'utf8'));
  const packCanvas = anchors.outputCanvas.width;
  const packAnchor = anchors.anchor;

  let failed = 0;
  for (const dir of dirs) {
    const actionId = `walk-${dir}`;
    const sources = SEQUENCES[dir];
    if (!sources) {
      console.error(`[${actionId}] unknown direction`); failed += 1; continue;
    }
    const targetHeight = targetHeightFor(paths, actionId);
    const frames = [];
    const problems = [];
    const cleaned = [];

    for (let index = 0; index < sources.length; index += 1) {
      const name = sources[index];
      const srcAbs = path.join(PLANB_DIR, name);
      let bytes = null;
      try { bytes = fs.readFileSync(srcAbs); } catch { problems.push(`${name}: 读不到源文件`); continue; }
      const stripped = stripFaintAlpha(bytes);
      if (!stripped.image) { problems.push(`${name}: PNG 解码失败`); continue; }
      if (stripped.stripped) cleaned.push(`${name}:${stripped.stripped}`);
      const normalized = normalizeImportFrame({
        sourceBytes: encodePng(stripped.image.data, stripped.image.width, stripped.image.height),
        targetHeight,
        footLine: packAnchor.y,
        packCanvas,
        packAnchor,
      });
      if (!normalized.ok) {
        problems.push(`${name}: ${JSON.stringify(normalized.violations)}`);
        continue;
      }
      const outImage = decodePng(normalized.png);
      const torso = torsoCentroidX(outImage);
      if (torso === null) { problems.push(`${name}: 输出量不到躯干`); continue; }
      frames.push({ source: name, rel: packNameFor(dir, index), png: normalized.png, outImage, torso, metrics: normalized.metrics });
    }
    if (problems.length) {
      console.error(`[${actionId}] 归一化失败，未写入:`);
      for (const p of problems) console.error(`   - ${p}`);
      failed += 1;
      continue;
    }

    // 方向级躯干对齐：把每帧躯干质心统一到中位位置（躯干稳定、摆动腿自然前后摆）。
    // 位移为整数像素精确搬移，并夹在"可见像素不出画布"的范围内。
    const medianTorso = median(frames.map((frame) => frame.torso));
    for (const frame of frames) {
      let shift = Math.round(medianTorso - frame.torso);
      const bounds = alphaBoundsOf(frame.outImage);
      if (bounds) shift = Math.max(-bounds.x, Math.min(packCanvas - 1 - bounds.x1, shift));
      if (shift !== 0) {
        const shifted = shiftHorizontally(frame.outImage, shift);
        frame.png = encodePng(shifted.data, shifted.width, shifted.height);
      }
      frame.shift = shift;
    }
    const shiftValues = frames.map((frame) => frame.shift);
    if (shiftValues.some((value) => value !== 0)) {
      console.log(`[${actionId}] 躯干水平对齐：中位躯干 x=${medianTorso.toFixed(1)}，逐帧平移 ${Math.min(...shiftValues)}..${Math.max(...shiftValues)}px`);
    }
    const heights = frames.map((f) => f.metrics.visibleHeight);
    const feet = frames.map((f) => f.metrics.footLine);
    console.log(`[${actionId}] ${frames.length} 帧归一化 OK：目标高=${targetHeight} 实测高=${Math.min(...heights)}~${Math.max(...heights)} 脚线=${Math.min(...feet)}~${Math.max(...feet)}${cleaned.length ? ` · 弱噪点清理: ${cleaned.join(',')}` : ''}`);
    if (dryRun) continue;

    // 写内容资产
    for (const frame of frames) {
      const abs = path.join(paths.assetsDir, frame.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, frame.png);
    }
    // 写动作文档（发布内核的输入）
    const doc = {
      schemaVersion: 1,
      id: actionId,
      loop: true,
      direction: dir,
      frames: frames.map((frame) => ({ file: frame.rel, durationMs: DURATION_MS })),
      geometry: { footLine: packAnchor.y, tolerancePx: 1 },
    };
    const docPath = path.join(paths.actionsDir, `${actionId}.json`);
    const parsed = model.parseActionDoc(doc);
    if (!parsed.ok) {
      console.error(`[${actionId}] 动作文档非法: ${parsed.code} ${parsed.message}`);
      failed += 1;
      continue;
    }
    fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`);
    // 发布
    const result = publisher.publishAction({ contentDir: CONTENT_DIR, charactersRoot: CHARACTERS_ROOT, actionId });
    if (!result.ok) {
      console.error(`[${actionId}] 发布失败: ${result.code || 'unknown'}`);
      for (const v of result.violations || []) console.error(`   - ${v.file} ${v.check} ${v.detail || ''}`);
      failed += 1;
    } else {
      console.log(`[${actionId}] 发布成功${result.noop ? '（no-op）' : ''}: ${JSON.stringify(result.summary)}`);
    }
  }
  process.exit(failed ? 4 : 0);
}

main();
