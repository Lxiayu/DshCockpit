#!/usr/bin/env node
/**
 * 办公室场景物品生图 —— 使用千问 qwen-image-3.0-pro 文生图
 *
 * 用法：
 *   IMG_API_KEY=sk-xxx node scripts/gen-props.js <输出目录>
 *
 * 扁平图标风，后上视角，不含角色，白底（生成后用 remove-bg.py 去白背景）。
 * 注意：qwen-image-3.0-pro 不支持 OpenAI 兼容端点，使用原生 DashScope API。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://dashscope.aliyuncs.com/api/v1';
const ENDPOINT = '/services/aigc/multimodal-generation/generation';
const API_KEY = process.env.IMG_API_KEY;
const MODEL = process.env.IMG_MODEL || 'qwen-image-3.0-pro';

const PROPS = [
  { key: 'prop-desk-monitor',  prompt: 'Flat icon style office desk with monitor from rear-upper view. Desktop surface visible. Monitor screen facing away. Modern minimalist. Navy blue and white color scheme. No person. White background.' },
  { key: 'prop-chair',         prompt: 'Flat icon style office chair from rear-upper view. Back of chair visible. Navy blue. Modern minimalist. No person. White background.' },
  { key: 'prop-coffee-machine', prompt: 'Flat icon style coffee machine. Side view. Stainless steel and navy blue. Modern minimalist. White background.' },
  { key: 'prop-water-bar',     prompt: 'Flat icon style water bar counter with cups. Side view. Navy blue and white. Modern minimalist. White background.' },
  { key: 'prop-plant',         prompt: 'Flat icon style potted plant. Small green plant in navy blue pot. Minimalist. White background.' },
  { key: 'prop-water-cooler',  prompt: 'Flat icon style water cooler dispenser. Side view. Blue and white. Minimalist. White background.' },
  { key: 'prop-treadmill',     prompt: 'Flat icon style mini treadmill from rear view. Navy blue and grey. Minimalist. White background.' },
  { key: 'prop-toilet',        prompt: 'Flat icon style cute toilet booth from side view. Closed door with occupied sign. Navy blue. Minimalist cute. White background.' },
  { key: 'prop-whiteboard',    prompt: 'Flat icon style whiteboard on stand. Blank white surface, navy blue frame. Minimalist. White background.' },
  { key: 'prop-snacks',        prompt: 'Flat icon style small snacks: fish jerky, cake, lollipop, dango on a small plate. Colorful. Minimalist. White background.' },
];

async function generate({ model, prompt, size }) {
  // qwen-image-3.0-pro 原生 DashScope API 格式
  const body = {
    model,
    input: {
      messages: [
        { role: 'user', content: [{ text: prompt }] }
      ]
    },
    parameters: { size: size.replace('x', '*') }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  const res = await fetch(`${BASE}${ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timer);
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 500)}`);
  const json = JSON.parse(raw);
  // 响应格式: output.choices[0].message.content[0].image = URL
  const choice = json.output && json.output.choices && json.output.choices[0];
  if (!choice) throw new Error(`no choice in response: ${raw.slice(0, 300)}`);
  const contentItem = choice.message && choice.message.content && choice.message.content[0];
  if (!contentItem || !contentItem.image) throw new Error(`no image url in response: ${raw.slice(0, 300)}`);
  // 下载图片
  const imgUrl = contentItem.image;
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`download failed: HTTP ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { json, buf };
}

async function main() {
  if (!API_KEY) { console.error('IMG_API_KEY not set'); process.exit(1); }
  const outDir = process.argv[2] || 'photo/output';
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[gen-props] model=${MODEL} out=${outDir}`);

  for (const p of PROPS) {
    const base = path.join(outDir, p.key);
    if (fs.existsSync(`${base}.png`)) {
      console.log(`⏭  ${p.key}.png already exists, skipping`);
      continue;
    }
    console.log(`[gen-props] generating ${p.key}...`);
    try {
      const { json, buf } = await generate({ model: MODEL, prompt: p.prompt, size: '1024x1024' });
      fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2), 'utf8');
      fs.writeFileSync(`${base}.png`, buf);
      console.log(`✓ ${p.key}.png`);
    } catch (err) {
      console.error(`✗ ${p.key}: ${err.message}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  console.log('done');
}

main();
