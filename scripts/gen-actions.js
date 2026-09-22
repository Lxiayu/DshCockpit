#!/usr/bin/env node
/**
 * 鲸鱼娘互动动作生图 —— 使用 /images/edits 端点锁定角色生成 6 种动作
 *
 * 用法：
 *   IMG_API_KEY=sk-xxx node scripts/gen-actions.js <参考图.png> <输出目录>
 *
 * 以参考图为角色基准，用 image edit 端点逐动作生成。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.IMG_BASE || 'https://ai.hebox.net/v1';
const API_KEY = process.env.IMG_API_KEY;
const MODEL = process.env.IMG_MODEL || 'gpt-image-2';

const ACTIONS = [
  { key: 'action-wave',  prompt: 'Same character. Waving hello with right hand. Smile. White background.' },
  { key: 'action-jump',  prompt: 'Same character. Jumping up happily, both feet off ground. Arms up. White background.' },
  { key: 'action-shake', prompt: 'Same character. Shaking head no, eyes closed, slight frown. White background.' },
  { key: 'action-nod',   prompt: 'Same character. Nodding yes, gentle smile, eyes half open. White background.' },
  { key: 'action-eat',   prompt: 'Same character. Bowing head down eating rice from a bowl. Chopsticks. White background.' },
  { key: 'action-drag',  prompt: 'Same character. Leaning sideways as if being dragged. Surprised face. White background.' },
];

async function editImage(refPath, prompt) {
  const formData = new FormData();
  formData.append('model', MODEL);
  formData.append('prompt', prompt);
  formData.append('image', new Blob([fs.readFileSync(refPath)], { type: 'image/png' }), path.basename(refPath));
  formData.append('size', '1024x1024');
  formData.append('n', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  const res = await fetch(`${BASE}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: formData,
    signal: controller.signal,
  });
  clearTimeout(timer);
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 500)}`);
  const json = JSON.parse(raw);
  const item = json.data && json.data[0];
  if (!item || !item.b64_json) throw new Error(`no image: ${raw.slice(0, 300)}`);
  return { json, b64: item.b64_json };
}

async function main() {
  if (!API_KEY) { console.error('IMG_API_KEY not set'); process.exit(1); }
  const refPath = process.argv[2];
  const outDir = process.argv[3] || 'photo/output';
  if (!refPath) { console.error('usage: node scripts/gen-actions.js <ref.png> <outDir>'); process.exit(1); }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[gen-actions] ref=${refPath} model=${MODEL}`);

  for (const a of ACTIONS) {
    const base = path.join(outDir, a.key);
    // skip if already exists
    if (fs.existsSync(`${base}.png`)) {
      console.log(`⏭  ${a.key}.png already exists, skipping`);
      continue;
    }
    console.log(`[gen-actions] generating ${a.key}...`);
    try {
      const { json, b64 } = await editImage(refPath, a.prompt);
      fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2), 'utf8');
      fs.writeFileSync(`${base}.png`, Buffer.from(b64, 'base64'));
      console.log(`✓ ${a.key}.png`);
    } catch (err) {
      console.error(`✗ ${a.key}: ${err.message}`);
      // wait 10s before next attempt (坑3: b64_json 偶尔缺失)
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  console.log('done');
}

main();
