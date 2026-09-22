#!/usr/bin/env node
/**
 * 角色帧生图流水线（M3 / 2026-09-17）——「必要的再生成」的执行端。
 *
 * 只对 asset-gap-report 确认的缺口调用生图 API：
 *   node scripts/gen-frames.js --action walk-left --mode edit --grid 3x1 \
 *     --ref photo/output_nobg/walk-left-01.png --ref photo/output_nobg/walk-left-04.png \
 *     --start-index 6 --out photo/output/m3-walk-left
 *
 * 流程：参考图压缩(768px，中转站 >1MB 会 500) → /images/edits(或 generations)
 * → 网格切片(复用 workbench png-geometry 内核) → 去白背景(复用 remove-bg.py)
 * → 归一化预校验(workbench normalizer，与工作台导入同一 fail-closed 规则)
 * → contact-sheet.html（用户定稿入口）。
 *
 * 契约：模型与 key 仅从 ~/.dsh-secrets.env 或进程 env 读入，绝不打印；
 * 提示词 ≤300 字符（中转站 400 陷阱）；单次调用 180s 超时（524 陷阱）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pngGeometry = require(path.join(ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));

const PROMPT_LIMIT = 300;
const DEFAULT_TIMEOUT_MS = 180000;

// ---- pure parts ----------------------------------------------------------------

const ACTION_PHRASES = Object.freeze({
  'walk-left': 'side view walking left',
  'walk-right': 'side view walking right',
  'walk-down': 'front view walking toward viewer',
  'walk-up': 'back view walking away',
  working: 'seated working at a desk, hands on keyboard',
  'working-back': 'sitting working, arms reaching forward and moving, head bobbing in small circles',
  sleeping: 'back view seated dozing off, head slumped forward and tilted, arms folded resting ahead, character only, no desk, no chair, no furniture',
  'idle-blink': 'facing the viewer, calm idle standing pose, eyes gently closed mid-blink',
  'working-front-3q': 'seated working, three-quarter front view, hands reaching forward',
  'idle-nap': 'sitting dozing off, head nodding down, eyes closed',
  'idle-lunch': 'bowing head eating rice from a bowl with chopsticks',
});

function buildPrompt({ action, mode = 'edit', count = 1, grid = null, single = false } = {}) {
  const actionPhrase = ACTION_PHRASES[action] || action.replace(/-/g, ' ');
  const panels = count > 1 ? `${count} equal square panels in one row, ` : '';
  const order = count > 1 ? 'left to right, ' : '';
  let body;
  if (action.startsWith('walk') && single) {
    // 抽卡单帧（2026-09-17 用户定）：小步幅、双腿间距缩小；强调与既有帧同款
    body = `One full-body sprite frame: ${actionPhrase}, small gentle step with legs close together, one foot slightly lifted, flat cel shading, clean lineart.`;
  } else if (action.startsWith('walk')) {
    body = `Walk-cycle sheet: all panels side view facing the same direction, ${panels}${actionPhrase}, clear leg phases (lift, tuck, reach), ${order}same size, same silhouette.`;
  } else if (action === 'working-back') {
    body = `Working loop sheet: all panels back view (seen from behind), ${panels}${actionPhrase}, ${order}same size.`;
  } else if (action.startsWith('working')) {
    body = `Character only, no desk, no laptop. ${panels}${actionPhrase}, ${order}same size.`;
  } else {
    body = `${panels}${actionPhrase}, ${order}same size.`;
  }
  let prompt;
  if (count === 1 && !action.startsWith('walk') && !action.startsWith('working')) {
    prompt = `Same chibi blue whale girl maid, navy dress. One full-body sprite frame: ${actionPhrase}. White background, no text, no border.`;
  } else {
    prompt = `Same chibi blue whale girl maid, navy dress. ${body} White background, no text, no border.`;
  }
  if (prompt.length > PROMPT_LIMIT) {
    throw new Error(`prompt exceeds ${PROMPT_LIMIT} chars (${prompt.length}) — relay returns 400`);
  }
  return prompt;
}

function planSliceRects({ width, height, grid }) {
  const m = /^(\d+)x(\d+)$/.exec(String(grid || '1x1'));
  if (!m) throw new TypeError(`bad grid "${grid}" (expected COLSxROWS like 1x3)`);
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols < 1 || rows < 1 || cols * rows > 16) throw new TypeError('grid out of range');
  const rects = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.round((width * c) / cols);
      const x1 = Math.round((width * (c + 1)) / cols);
      const y0 = Math.round((height * r) / rows);
      const y1 = Math.round((height * (r + 1)) / rows);
      rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
  }
  return rects;
}

function tileFileNames({ action, count, startIndex = 1 }) {
  const names = [];
  for (let i = 0; i < count; i += 1) {
    names.push(`${action}-${String(startIndex + i).padStart(2, '0')}.png`);
  }
  return names;
}

// 等分切片会切穿角色（实测：鲸鱼娘的尾巴横跨三等分边界，尾尖被切进下一格）。
// 按"墨量"（非近白像素数）找每列的真实内容，在等分边界附近窗口内取最空的一列
// 作为切点——空白间隙总是比角色本体更空。
function planContentAwareRects(source, { cols = 1, rows = 1, nearWhite = 240 } = {}) {
  const inkCount = new Array(source.width).fill(0);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const i = (y * source.width + x) * 4;
      const white = source.data[i] > nearWhite && source.data[i + 1] > nearWhite && source.data[i + 2] > nearWhite;
      if (!white) inkCount[x] += 1;
    }
  }
  const cuts = [0];
  for (let c = 1; c < cols; c += 1) {
    const expected = Math.round((source.width * c) / cols);
    const half = Math.max(2, Math.floor(source.width / (cols * 2)));
    let best = expected;
    let bestInk = Infinity;
    for (let x = Math.max(1, expected - half); x <= Math.min(source.width - 2, expected + half); x += 1) {
      if (inkCount[x] < bestInk) { bestInk = inkCount[x]; best = x; }
    }
    cuts.push(best);
  }
  cuts.push(source.width);
  const rowCuts = [0];
  for (let r = 1; r < rows; r += 1) rowCuts.push(Math.round((source.height * r) / rows));
  rowCuts.push(source.height);
  const rects = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      rects.push({ x: cuts[c], y: rowCuts[r], width: cuts[c + 1] - cuts[c], height: rowCuts[r + 1] - rowCuts[r] });
    }
  }
  return rects;
}

// 向右走不重新绘制：walk-left 帧水平镜像即为 walk-right（2026-09-17 用户定）。
// 镜像在 RGBA 缓冲上做（画布与居中锚点关于中线对称，翻转后几何契约不变）。
function flipHorizontal(pngBuffer) {
  const img = pngGeometry.decodePng(pngBuffer);
  const out = pngGeometry.createImage(img.width, img.height);
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const si = (y * img.width + x) * 4;
      const di = (y * img.width + (img.width - 1 - x)) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return pngGeometry.encodePng(out.data, out.width, out.height);
}

function cropRgba(source, rect) {
  const out = Buffer.alloc(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const srcStart = ((rect.y + y) * source.width + rect.x) * 4;
    source.data.copy(out, y * rect.width * 4, srcStart, srcStart + rect.width * 4);
  }
  return out;
}

// 模型偶尔会把每格画上黑色边框（黑线既污染可见边界测量，又把白底封在框内
// 使去背 floodfill 无法进入）。扫描占行/列 >60% 的近黑像素线，裁到线内侧。
function trimBorderLines(tile, { maxTrim = 80, ratio = 0.85 } = {}) {
  // 全图扫描（边框可能悬浮在白色边距内部，不是在瓦片最外缘）：
  // 近黑且占行/列宽度 >ratio 的扫描线视为边框线；取首末两条裁到线内侧。
  // ratio 取 0.85：角色最宽处（深色头发块）也达不到，避免误伤。
  const darkRowRatio = (y) => {
    let dark = 0;
    for (let x = 0; x < tile.width; x += 1) {
      const i = (y * tile.width + x) * 4;
      if (tile.data[i] < 60 && tile.data[i + 1] < 60 && tile.data[i + 2] < 60) dark += 1;
    }
    return dark / tile.width;
  };
  const lineRows = [];
  for (let y = 0; y < tile.height; y += 1) if (darkRowRatio(y) > ratio) lineRows.push(y);
  let top = 0; let bottom = tile.height - 1;
  if (lineRows.length) {
    // 直接裁到首末边框线内侧；maxTrim 只作合理性保护：把剩余高度裁到 <25%
    // 或非法时判定为误检（例如整块深色内容），放弃裁剪
    const t0 = lineRows[0] + 1;
    const b0 = lineRows[lineRows.length - 1] - 1;
    if (b0 - t0 + 1 >= tile.height * 0.25 && t0 < tile.height && b0 >= 0) {
      top = t0;
      bottom = b0;
    }
  }
  const darkColRatio = (x) => {
    let dark = 0;
    for (let y = top; y <= bottom; y += 1) {
      const i = (y * tile.width + x) * 4;
      if (tile.data[i] < 60 && tile.data[i + 1] < 60 && tile.data[i + 2] < 60) dark += 1;
    }
    return dark / (bottom - top + 1);
  };
  const lineCols = [];
  for (let x = 0; x < tile.width; x += 1) if (darkColRatio(x) > ratio) lineCols.push(x);
  let left = 0; let right = tile.width - 1;
  if (lineCols.length) {
    const l0 = lineCols[0] + 1;
    const r0 = lineCols[lineCols.length - 1] - 1;
    if (r0 - l0 + 1 >= tile.width * 0.25 && l0 < tile.width && r0 >= 0) {
      left = l0;
      right = r0;
    }
  }
  // 边缘清理：抗锯齿残影（检测线之外的深色过渡像素）仍会让去背的边缘采样
  // 判定"背景不白"而整体跳过——继续内缩直到边缘行/列不再深色。
  const edgeRowDark = (y) => darkRowRatio(y) > 0.3;
  while (top <= bottom && edgeRowDark(top)) top += 1;
  while (bottom >= top && edgeRowDark(bottom)) bottom -= 1;
  while (left <= right && darkColRatio(left) > 0.3) left += 1;
  while (right >= left && darkColRatio(right) > 0.3) right -= 1;
  // 边框线的 JPEG 压缩碎屑会零星残留在检测线内侧 1-3px（每行仅几个像素，
  // 逃过上一步的比例检测），固定再收 3px 边距把它们清掉。
  const PAD = 3;
  if (!(top === 0 && bottom === tile.height - 1 && left === 0 && right === tile.width - 1)) {
    top += PAD; bottom -= PAD; left += PAD; right -= PAD;
    if (bottom - top + 1 < tile.height * 0.25 || right - left + 1 < tile.width * 0.25) {
      return tile; // 收缩过度视为无有效边框，放弃
    }
  }
  const cropped = pngGeometry.createImage(right - left + 1, bottom - top + 1);
  for (let y = top; y <= bottom; y += 1) {
    const srcStart = (y * tile.width + left) * 4;
    tile.data.copy(cropped.data, (y - top) * cropped.width * 4, srcStart, srcStart + cropped.width * 4);
  }
  return cropped;
}

function slicePngBuffer(pngBuffer, rects, { inset = 0, trimBorders = false } = {}) {
  const source = pngGeometry.decodePng(pngBuffer);
  const shrunk = inset > 0
    ? rects.map((r) => ({ x: r.x + inset, y: r.y + inset, width: r.width - inset * 2, height: r.height - inset * 2 }))
    : rects;
  return shrunk.map((rect) => {
    let tile = { width: rect.width, height: rect.height, data: cropRgba(source, rect) };
    if (trimBorders) tile = trimBorderLines(tile);
    return pngGeometry.encodePng(tile.data, tile.width, tile.height);
  });
}

// ---- io / network ---------------------------------------------------------------

function loadConfig({ baseKey = 'IMG_GPT2' } = {}) {
  let envText = '';
  const secretsPath = path.join(os.homedir(), '.dsh-secrets.env');
  try { envText = fs.readFileSync(secretsPath, 'utf8'); } catch { /* no secrets file */ }
  const pick = (key) => {
    const m = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return (m && m[1].trim()) || process.env[key] || null;
  };
  const base = pick(`${baseKey}_BASE_URL`) || 'https://ai.hebox.net/v1';
  const apiKey = pick(`${baseKey}_API_KEY`);
  const model = pick(`${baseKey}_MODEL`) || 'gpt-image-2';
  if (!apiKey) throw new Error(`no API key: set ${baseKey}_API_KEY or fill ~/.dsh-secrets.env`);
  return { base, apiKey, model };
}

function compressRef(srcPath, tmpDir) {
  // 中转站 /images/edits 传 >1MB 参考图会 500（IMG-GEN-KICKOFF 坑 4）
  const dst = path.join(tmpDir, `ref-${path.basename(srcPath)}`);
  execFileSync('sips', ['-Z', '768', srcPath, '--out', dst], { stdio: 'ignore' });
  return dst;
}

function buildGeminiPayload({ prompt, imagesBase64 }) {
  // tu-zi gemini 原生：contents[0].parts = [文本, ...inline_data 图片]
  const parts = [{ text: prompt }];
  for (const b64 of imagesBase64) {
    parts.push({ inline_data: { mime_type: 'image/png', data: b64 } });
  }
  return { contents: [{ parts }] };
}

async function callGeminiProvider({ base, apiKey, model, prompt, refPaths, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const root = base.replace(/\/v1$/, '');
  const url = `${root}/v1beta/models/${model}:generateContent`;
  const imagesBase64 = refPaths.map((r) => fs.readFileSync(r).toString('base64'));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildGeminiPayload({ prompt, imagesBase64 })),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
    const inline = parts.find((x) => x.inlineData || x.inline_data);
    if (inline) {
      const d = inline.inlineData || inline.inline_data;
      return Buffer.from(d.data, 'base64');
    }
    const fileRef = parts.find((x) => x.fileData || x.file_data);
    if (fileRef) {
      const fd = fileRef.fileData || fileRef.file_data;
      const imgRes = await fetch(fd.fileUri || fd.file_uri);
      if (!imgRes.ok) throw new Error(`result download failed: HTTP ${imgRes.status}`);
      return Buffer.from(await imgRes.arrayBuffer());
    }
    throw new Error(`no image part in gemini response (retryable): ${raw.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

function buildDashscopePayload({ model, prompt, imagesBase64, size }) {
  // 原生多模态端点：content 数组按 [图片..., 文本] 顺序；size 用 1024*1024
  return {
    model,
    input: {
      messages: [{
        role: 'user',
        content: [
          ...imagesBase64.map((b64) => ({ image: `data:image/png;base64,${b64}` })),
          { text: prompt },
        ],
      }],
    },
    parameters: { size: String(size).replace('x', '*') },
  };
}

async function callDashscopeEdit({ base, apiKey, model, prompt, refPaths, size, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const nativeBase = base.includes('/compatible-mode') ? base.replace('/compatible-mode/v1', '/api/v1') : base;
  const imagesBase64 = refPaths.map((r) => Buffer.from(fs.readFileSync(r)).toString('base64'));
  const payload = buildDashscopePayload({ model, prompt, imagesBase64, size });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${nativeBase}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const choice = json.output && json.output.choices && json.output.choices[0];
    const item = choice && choice.message && (choice.message.content || []).find((c) => c.image);
    if (!item) throw new Error(`no image in dashscope response (retryable): ${raw.slice(0, 200)}`);
    const imgRes = await fetch(item.image);
    if (!imgRes.ok) throw new Error(`download failed: HTTP ${imgRes.status}`);
    return Buffer.from(await imgRes.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function callImageApi({ base, apiKey, model, prompt, size, editRefPaths, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    if (editRefPaths && editRefPaths.length) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('n', '1');
      for (const ref of editRefPaths) {
        form.append('image', new Blob([fs.readFileSync(ref)], { type: 'image/png' }), path.basename(ref));
      }
      res = await fetch(`${base}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: ctrl.signal });
    } else {
      res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt, size, n: 1, response_format: 'b64_json' }),
        signal: ctrl.signal,
      });
    }
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const item = json.data && json.data[0];
    if (!item || !item.b64_json) {
      // 坑 3：200 但缺 b64_json（上游过载）——调用方负责重试
      throw new Error(`no b64_json in response (retryable): ${raw.slice(0, 200)}`);
    }
    return Buffer.from(item.b64_json, 'base64');
  } finally {
    clearTimeout(timer);
  }
}

function ensurePng(buffer, tmpDir) {
  // tu-zi gemini 返回 JPEG（即使调用方按 .png 命名）；任何非 PNG 结果统一用
  // sips 转成 PNG（下游切片/去背/归一化都按 PNG 契约）
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return buffer;
  const rawPath = path.join(tmpDir, 'raw-result');
  const pngPath = path.join(tmpDir, 'raw-result.png');
  fs.writeFileSync(rawPath, buffer);
  execFileSync('sips', ['-s', 'format', 'png', rawPath, '--out', pngPath], { stdio: 'ignore' });
  return fs.readFileSync(pngPath);
}

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function argValues(flag) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

async function main() {
  const mirrorSrc = argValue('--mirror');
  if (mirrorSrc) {
    const outPath = argValue('--out');
    if (!outPath) { console.error('--mirror requires --out <file>'); process.exit(2); }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, flipHorizontal(fs.readFileSync(mirrorSrc)));
    console.log(`[gen-frames] mirrored ${mirrorSrc} -> ${outPath}`);
    return;
  }
  const reslicePath = argValue('--reslice');
  if (reslicePath) {
    const action = argValue('--action');
    if (!action) { console.error('--reslice requires --action'); process.exit(2); }
    const grid = argValue('--grid', '1x1');
    const size = argValue('--size', '1024x1024');
    const outDir = argValue('--out', path.dirname(reslicePath));
    const startIndex = Number(argValue('--start-index', '1'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-frames-'));
    const raw = ensurePng(fs.readFileSync(reslicePath), tmpDir);
    const autoSlice = process.argv.includes('--auto-slice');
    let rects;
    if (autoSlice) {
      const m = /^(\d+)x(\d+)$/.exec(grid);
      const decoded = pngGeometry.decodePng(raw);
      rects = planContentAwareRects(decoded, { cols: Number(m[1]), rows: Number(m[2]) });
      console.log(`[gen-frames] auto-slice cuts: ${rects.map((r) => r.x).join(',')}`);
    } else {
      rects = planSliceRects({ width: Number(size.split('x')[0]), height: Number(size.split('x')[1]), grid });
    }
    fs.mkdirSync(outDir, { recursive: true });
    const inset = Number(argValue('--inset', '0'));
    const tiles = slicePngBuffer(raw, rects, { inset, trimBorders: process.argv.includes('--trim-borders') });
    const names = tileFileNames({ action, count: rects.length, startIndex });
    tiles.forEach((buf, i) => fs.writeFileSync(path.join(outDir, names[i]), buf));
    console.log(`[gen-frames] resliced ${names.length} tiles from ${reslicePath} -> ${outDir}`);
    return;
  }
  const action = argValue('--action');
  if (!action) { console.error('usage: node scripts/gen-frames.js --action walk-left [--mode edit] [--grid 3x1] --ref <png>... --out <dir>'); process.exit(2); }
  const mode = argValue('--mode', 'edit');
  const grid = argValue('--grid', null);
  const refs = argValues('--ref');
  const outDir = argValue('--out', path.join(ROOT, 'photo', 'output', `m3-${action}`));
  const size = argValue('--size', '1024x1024');
  const startIndex = Number(argValue('--start-index', '1'));
  const provider = argValue('--provider', 'tuzi');
  const config = loadConfig({ baseKey: provider === 'dashscope' ? 'IMG_QWEN' : (provider === 'tuzi' ? 'NANOBANANA' : argValue('--key-env', 'IMG_GPT2')) });
  const modelOverride = argValue('--model');
  if (modelOverride) config.model = modelOverride;
  if (provider === 'dashscope' && !modelOverride) config.model = 'qwen-image-edit';

  const rects = grid ? planSliceRects({ width: Number(size.split('x')[0]), height: Number(size.split('x')[1]), grid }) : [{ x: 0, y: 0, width: Number(size.split('x')[0]), height: Number(size.split('x')[1]) }];
  const count = rects.length;
  const prompt = buildPrompt({ action, mode, count, grid, single: process.argv.includes('--single') });
  console.log(`[gen-frames] model=${config.model} mode=${mode} action=${action} tiles=${count}`);
  console.log(`[gen-frames] prompt(${prompt.length}): ${prompt}`);

  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-frames-'));
  const refPaths = refs.map((r) => compressRef(r, tmpDir));

  let raw = null;
  for (let attempt = 1; attempt <= 2 && !raw; attempt += 1) {
    try {
      raw = provider === 'dashscope'
        ? await callDashscopeEdit({ base: config.base, apiKey: config.apiKey, model: config.model, prompt, refPaths, size })
        : provider === 'tuzi'
          ? await callGeminiProvider({ base: config.base, apiKey: config.apiKey, model: config.model, prompt, refPaths })
          : await callImageApi({ base: config.base, apiKey: config.apiKey, model: config.model, prompt, size, editRefPaths: mode === 'edit' ? refPaths : null });
    } catch (error) {
      console.error(`[gen-frames] attempt ${attempt} failed: ${error.message}`);
      if (attempt === 2) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, 10000)); // 坑 3：等 10 秒重试
    }
  }

  raw = ensurePng(raw, tmpDir);
  fs.writeFileSync(path.join(outDir, `${action}-sheet-raw.png`), raw);
  const tiles = slicePngBuffer(raw, rects, { inset: Number(argValue('--inset', '0')), trimBorders: process.argv.includes('--trim-borders') });
  const names = tileFileNames({ action, count, startIndex });
  tiles.forEach((buf, i) => fs.writeFileSync(path.join(outDir, names[i]), buf));
  console.log(`[gen-frames] wrote ${names.length} tiles + raw sheet to ${outDir}`);
  console.log(`[gen-frames] next: python3 scripts/remove-bg.py ${outDir} ${outDir}-nobg  然后进工作台归一化导入`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => { console.error('[gen-frames] FAILED:', error.message); process.exit(1); });
}

module.exports = { flipHorizontal, buildPrompt, planSliceRects, planContentAwareRects, tileFileNames, slicePngBuffer, trimBorderLines, loadConfig, buildDashscopePayload, buildGeminiPayload };
