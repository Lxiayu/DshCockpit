#!/usr/bin/env node
/**
 * 鲸鱼娘生图工具 —— 调用中转站 gpt-image-2 生成 Q 版形象素材
 *
 * 用法：
 *   IMG_API_KEY=sk-xxx node scripts/gen-img.js <输出目录> <提示词文件或prompt>
 *   --ref <png路径>       可选：身份参考图（base64 data URL 传入 inputs）
 *   --size 1024x1024      默认
 *   --out <name.png>      默认 img-<时间戳>.png
 *
 * 响应原样存 <输出目录>/<name>.json 便于排查；图片存 <输出目录>/<name>.png
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.IMG_BASE || 'https://ai.hebox.net/v1';
const API_KEY = process.env.IMG_API_KEY;
const MODEL = process.env.IMG_MODEL || 'gpt-image-2';

const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);

function parseArgs(argv) {
  const out = { refs: [], size: '1024x1024' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') out.refs.push(argv[++i]);
    else if (a === '--size') out.size = argv[++i];
    else if (a === '--out') out.name = argv[++i];
    else rest.push(a);
  }
  if (!SIZES.has(out.size)) throw new Error(`unknown size: ${out.size}`);
  out.outDir = rest[0];
  out.prompt = rest.slice(1).join(' ');
  if (!out.outDir || !out.prompt) throw new Error('usage: node scripts/gen-img.js <outDir> <prompt...> [--ref png] [--size s] [--out name]');
  return out;
}

function dataUrl(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase().replace('.', '') || 'png';
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
}

async function generate({ model, prompt, refs, size }) {
  const body = { model, prompt, size, n: 1, response_format: 'b64_json' };
  if (refs.length) {
    body.inputs = refs.map((f) => ({ type: 'image_url', image_url: { url: dataUrl(f) } }));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000); // 3 min for image gen
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timer);
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 1000)}`);
  const json = JSON.parse(raw);
  const item = json.data && json.data[0];
  if (!item) throw new Error(`no image in response: ${raw.slice(0, 500)}`);
  if (!item.b64_json) throw new Error(`no b64_json (only ${Object.keys(item)}): ${raw.slice(0, 500)}`);
  return { json, b64: item.b64_json };
}

async function main() {
  if (!API_KEY) { console.error('IMG_API_KEY not set'); process.exit(1); }
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });
  const name = args.name || `img-${Date.now()}`;
  const base = path.join(args.outDir, name);

  console.log(`[gen-img] model=${MODEL} size=${args.size} refs=${args.refs.length || 0}`);
  console.log(`[gen-img] prompt=${args.prompt.slice(0, 120)}...`);
  try {
    const { json, b64 } = await generate({ model: MODEL, prompt: args.prompt, refs: args.refs, size: args.size });
    fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2), 'utf8');
    fs.writeFileSync(`${base}.png`, Buffer.from(b64, 'base64'));
    console.log(`✓ 图片已保存: ${base}.png`);
  } catch (err) {
    console.error(`✗ 生图失败: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
