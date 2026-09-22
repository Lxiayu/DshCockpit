#!/usr/bin/env node
/**
 * 鲸鱼娘六态生图 v2 —— 使用 /images/edits 端点严格锁定角色
 *
 * 用法：
 *   IMG_API_KEY=sk-xxx node scripts/gen-img-edit.js <参考图.png> <输出目录>
 *
 * 以参考图为唯一角色基准，用 image edit 端点逐态生成，角色外观锁死。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.IMG_BASE || 'https://ai.hebox.net/v1';
const API_KEY = process.env.IMG_API_KEY;
const MODEL = process.env.IMG_MODEL || 'gpt-image-2';

const STATES = [
  { key: 'idle',     prompt: 'Keep the exact same character from the input image. Change ONLY the expression: calm peaceful gentle smile, eyes half open relaxed idle state. Keep the same pose standing. Do not change hair, outfit, colors, or proportions.' },
  { key: 'working',  prompt: 'Keep the exact same character from the input image. Change ONLY the expression: focused serious, eyes wide open, slightly furrowed brows, tiny sweat drop. Pose: sitting at a desk typing. Do not change hair, outfit, colors, or proportions.' },
  { key: 'finished', prompt: 'Keep the exact same character from the input image. Change ONLY the expression: joyful big happy smile, eyes closed laughing. Pose: both arms raised in victory celebration. Sparkles around. Do not change hair, outfit, colors, or proportions.' },
  { key: 'warning',  prompt: 'Keep the exact same character from the input image. Change ONLY the expression: worried anxious, furrowed brows, small frown, sweat drop on forehead. Hands clasped nervously. Do not change hair, outfit, colors, or proportions.' },
  { key: 'error',    prompt: 'Keep the exact same character from the input image. Change ONLY the expression: dizzy dazed, X-shaped eyes, wavy mouth. Pose: slumped over slightly. Small spiral marks above head. Do not change hair, outfit, colors, or proportions.' },
  { key: 'offline',  prompt: 'Keep the exact same character from the input image. Change ONLY the expression: eyes closed sleeping peacefully, small zZ floating above. Pose: curled up sleeping. Do not change hair, outfit, colors, or proportions.' },
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
  if (!refPath) { console.error('usage: node scripts/gen-img-edit.js <ref.png> <outDir>'); process.exit(1); }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[gen-img-edit] ref=${refPath} model=${MODEL}`);

  for (const s of STATES) {
    const base = path.join(outDir, `state-${s.key}`);
    try {
      const { json, b64 } = await editImage(refPath, s.prompt);
      fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2), 'utf8');
      fs.writeFileSync(`${base}.png`, Buffer.from(b64, 'base64'));
      console.log(`✓ state-${s.key}.png`);
    } catch (err) {
      console.error(`✗ state-${s.key}: ${err.message}`);
    }
  }
  console.log('done');
}

main();
