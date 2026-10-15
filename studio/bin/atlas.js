#!/usr/bin/env node
'use strict';

// studio/bin/atlas.js — atlas packing CLI (P8).
//
//   node studio/bin/atlas.js pack [--pack deepseek-default] [--out <dir>] [--format png|webp] [--json]
//   node studio/bin/atlas.js plan [--pack deepseek-default]        只报数，不写盘
//
// 诚实结论：图集把 74 张纹理合成 1 张（上传/绑定/绘制开销），PNG 体积与散帧持平（1.04×），
// 真正的字节收益来自 --format webp（无损 WebP，Chromium 原生解码）。

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const { collectPlayedFrames, packAtlas } = require(path.join(STUDIO_ROOT, 'lib', 'atlas', 'pack.js'));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; index += 1; }
    } else positional.push(token);
  }
  return { positional, flags };
}

const USAGE = `usage:
  atlas pack [--pack deepseek-default] [--out <dir>] [--format png|webp] [--json]
  atlas plan [--pack deepseek-default]`;

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || 'plan';
  const packId = flags.pack ? String(flags.pack) : 'deepseek-default';
  const packRoot = path.join(REPO_ROOT, 'resources', 'characters', packId);
  if (!fs.existsSync(packRoot)) { console.error(`no such pack: ${packRoot}`); return 1; }

  if (command === 'plan') {
    const collected = collectPlayedFrames({ packRoot });
    const files = collected.frames.map((frame) => frame.file);
    const bytes = files.reduce((sum, file) => sum + (fs.existsSync(path.join(packRoot, file)) ? fs.statSync(path.join(packRoot, file)).size : 0), 0);
    if (flags.json) { console.log(JSON.stringify({ packId, actions: collected.actions, frames: files.length, bytes }, null, 2)); return 0; }
    console.log(`${packId} · ${collected.actions.length} 个动作 / ${files.length} 张被播放的帧 / ${(bytes / 1048576).toFixed(2)} MiB`);
    for (const action of collected.actions) console.log(`  ${action.actionId.padEnd(14)} ${String(action.frames).padStart(2)} 帧（去重后 ${action.unique}）`);
    return 0;
  }

  if (command === 'pack') {
    const out = flags.out ? path.resolve(String(flags.out)) : path.join(REPO_ROOT, 'content', 'build', 'atlas', packId);
    const format = flags.format === 'webp' ? 'webp' : 'png';
    const report = packAtlas({ packRoot, outDir: out, format });
    if (!report.ok) { console.error(`${report.code}: ${JSON.stringify(report.missing || report.message)}`); return 1; }
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return 0; }
    console.log(`图集：${report.frames} 帧 / ${report.actions} 动作 → ${report.atlas.width}×${report.atlas.height}（${(report.atlas.bytes / 1048576).toFixed(2)} MiB）`);
    console.log(`散帧：${report.loose.files} 文件 / ${(report.loose.bytes / 1048576).toFixed(2)} MiB · PNG 体积比 ${report.ratio}× · 纹理数 ${report.loose.files} → 1`);
    console.log(`裁剪后内容占原画布 ${report.trimmedPercent}%（其余本来是透明）`);
    if (report.webp && report.webp.ok) console.log(`WebP 无损：${(report.webp.bytes / 1048576).toFixed(2)} MiB · 比散帧小 ${report.webp.ratio}×`);
    else if (report.webp) console.log(`WebP 未生成：${report.webp.code} ${report.webp.message || ''}`);
    console.log(`写出：${report.pngPath}`);
    console.log(`清单：${report.jsonPath}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, main, parseArgs };
