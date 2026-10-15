'use strict';

// studio/lib/provenance.js — 「素材复现链」引擎（office 工作台 / studio 模块集，纯 Node）。
//
// 移植自主仓 /Users/xia/program/dsh/DshCockpit 的 scripts/asset-provenance.js
// （五段式来源链：生成 → 抠像 → 归一化 → 发布 → 在盘校验），并把主仓的**已知缺口**
// 补上：主仓里"segment 1 生成调用参数从未被记录在任何地方"，本引擎用一份
// **逐动作参数台账**（.params.json ledger）把它关掉：
//
//   content/characters/<characterId>/provenance/generation/<actionId>.params.json
//   { schemaVersion: 1, actionId, records: [ { recordedAt, kind, provider, model,
//     prompt, promptHash, params, seed, references, outputs, command, tool } ] }
//
// 只读/只写边界（硬约束）：
//   - READ  : content/**、resources/**、photo/**（photo 是本机私有素材树，绝不进 git）
//   - WRITE : 只有 <content>/characters/<id>/provenance/generation/*.params.json
//             （追加，绝不改写既有记录）与 --out 指定的索引文件；
//             测试一律用 fs.mkdtempSync 沙箱，绝不写 content/** / resources/** / photo/**。
//
// 诚实原则（整个模块存在的理由）：
//   跑不出来 / 没记录的环节如实标 `lost` / `not-recorded` / `traceable-in-history`，
//   附找回锚点（git 提交、s1 只读参照、台账路径、photo 候选图），**绝不伪造可复现**。
//   宁可全红，不可编造。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { scanForSecrets } = require('./scan.js');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 五段式来源链（顺序即链序）。 */
const SEGMENTS = Object.freeze(['generation', 'matting', 'normalize', 'publish', 'on-disk']);

/** 允许的状态取值——除此之外不许出现（尤其不许出现"可复现"之类的自造词）。 */
const STATUSES = Object.freeze(['traceable', 'traceable-in-history', 'lost', 'not-recorded']);

/** 生成参数台账所在目录（相对 content/characters/<characterId>/）。 */
const PARAMS_DIR_RELATIVE = 'provenance/generation';

const PARAMS_SCHEMA_VERSION = 1;
const PARAMS_FILE_SUFFIX = '.params.json';
const RECORD_KINDS = Object.freeze(['image', 'video', 'frame-sheet']);

const DEFAULT_CHARACTER_ID = 'whale-girl';
const DEFAULT_PACK_ID = 'deepseek-default';
const DEFAULT_INDEX_OUT_RELATIVE = 'studio/build/provenance-index.json';

const PACK_ANIMATIONS_RELATIVE = 'animation/animations.json';
const PACK_ANCHORS_RELATIVE = 'animation/anchors.json';
const CATALOG_RELATIVE = 'src/office/layout-assets.js';

/** s1 在盘工具登记（segment 状态由"在盘 / git 历史可找回 / 都找不到"三态实测得出）。 */
const TOOLS = Object.freeze({
  genFrames: 'scripts/gen-frames.js',
  genImg: 'scripts/gen-img.js',
  genImgEdit: 'scripts/gen-img-edit.js',
  genActions: 'scripts/gen-actions.js',
  genProps: 'scripts/gen-props.js',
  removeBg: 'scripts/remove-bg.py',
  normalizeCharacter: 'scripts/office-assets/normalize-character.py',
  normalizeWalkPlanB: 'scripts/office-assets/normalize-walk-planb.js',
  normalizer: 'src/workbench/lib/normalizer.js',
  actionPublisher: 'src/workbench/lib/action-publisher.js',
  validator: 'scripts/office-assets/validate-character-pack.js',
  catalog: CATALOG_RELATIVE,
});

/** photo/ 里只深扫一层、且只在这些目录内扫（photo 约 1.7GB，绝不全树遍历）。 */
const PHOTO_INNER_DIRS = Object.freeze(['output', 'output_nobg', 'new output', 'new output-clean', 'video-test', 'video-matting-kit']);
const PHOTO_SCAN_BUDGET = 4096;
const PHOTO_HITS_CAP = 60;
const PHOTO_INNER_READ_CAP = 400;

// ---------------------------------------------------------------------------
// 基础工具（纯函数，可单测）
// ---------------------------------------------------------------------------

/** sha256(文件字节)。文件不存在时抛错——调用方需要"存在性"时用 statFile。 */
function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** sha256(文本)——提示词等文本资产的默认存储形态。 */
function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 提示词哈希（对外别名：默认只存哈希，不存原文）。 */
function hashPrompt(prompt) {
  return sha256Text(prompt);
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function relFrom(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

function fileStat(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { exists: false };
    return { exists: true, bytes: st.size, sha256: sha256File(file) };
  } catch {
    return { exists: false };
  }
}

function dirHasFiles(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isSafeActionId(actionId) {
  return typeof actionId === 'string'
    && actionId.length > 0
    && actionId.length <= 120
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(actionId)
    && !actionId.includes('..');
}

// ---------------------------------------------------------------------------
// git 历史复核（只在工具/文件不在盘时动用；execFileSync + 显式数组参数，绝不拼 shell）
// ---------------------------------------------------------------------------

const gitCache = new Map();

function gitOutput(repoRoot, args) {
  const key = `${repoRoot}\u0000${args.join(' ')}`;
  if (gitCache.has(key)) return gitCache.get(key);
  let out = null;
  try {
    out = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    out = null; // 无 git / 非仓库 / 超时——一律按"无法复核"处理，绝不断言
  }
  gitCache.set(key, out);
  return out;
}

function gitRepoUsable(repoRoot) {
  if (gitRepoUsable.cache.has(repoRoot)) return gitRepoUsable.cache.get(repoRoot);
  const out = gitOutput(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  const usable = typeof out === 'string' && out.trim() === 'true';
  gitRepoUsable.cache = new Map([[repoRoot, usable]]);
  return usable;
}
gitRepoUsable.cache = new Map();

/** 历史复核：某相对路径是否曾被提交（以及最后一个删除它的提交）。 */
function gitHistoryFor(repoRoot, relPath) {
  if (!gitRepoUsable(repoRoot)) {
    return { usable: false, committed: false, deletedIn: null };
  }
  const first = gitOutput(repoRoot, ['rev-list', '-1', 'HEAD', '--', relPath]);
  const committed = typeof first === 'string' && first.trim().length > 0;
  let deletedIn = null;
  if (committed) {
    const del = gitOutput(repoRoot, ['log', '--diff-filter=D', '--format=%h', '-n', '1', '--', relPath]);
    if (typeof del === 'string' && del.trim()) deletedIn = del.trim().split('\n')[0];
  }
  return { usable: true, committed, deletedIn };
}

/**
 * 工具在盘 / 历史可找回性。返回事实核查结果，不是登记表复读：
 *   在盘            → traceable
 *   不在盘但提交过  → traceable-in-history（附删除提交号）
 *   都不行          → lost
 */
function toolStatus(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  if (fs.existsSync(abs)) {
    return { status: 'traceable', location: relPath, onDisk: true };
  }
  const hist = gitHistoryFor(repoRoot, relPath);
  if (hist.usable && hist.committed) {
    return {
      status: 'traceable-in-history',
      location: relPath,
      onDisk: false,
      note: `不在盘；git 历史复核可找回${hist.deletedIn ? `（删除提交 ${hist.deletedIn}）` : ''}`,
      recoverFrom: `git show ${hist.deletedIn ? `${hist.deletedIn}^` : 'HEAD'}:${relPath}`,
    };
  }
  return {
    status: 'lost',
    location: relPath,
    onDisk: false,
    note: hist.usable ? '不在盘，git 历史复核也未找到' : '不在盘，且 git 不可用（无法复核历史）',
  };
}

// ---------------------------------------------------------------------------
// photo/ 候选图锚点（只读；只扫一层 + 少量已知目录，绝不递归 1.7GB）
// ---------------------------------------------------------------------------

function photoAnchors(photoRoot, needle) {
  const out = [];
  if (!photoRoot || !needle) return out;
  let top;
  try {
    top = fs.readdirSync(photoRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  let budget = PHOTO_SCAN_BUDGET;
  const consider = (dir, name) => {
    if (out.length >= PHOTO_HITS_CAP) return;
    if (!name.toLowerCase().includes(needle.toLowerCase())) return;
    const abs = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(abs); } catch { return; }
    out.push({
      path: toPosix(abs),
      kind: st.isDirectory() ? 'dir' : 'file',
      bytes: st.isDirectory() ? null : st.size,
    });
  };
  for (const entry of top) {
    if (budget-- <= 0 || out.length >= PHOTO_HITS_CAP) break;
    consider(photoRoot, entry.name);
    if (entry.isDirectory() && PHOTO_INNER_DIRS.includes(entry.name)) {
      const inner = path.join(photoRoot, entry.name);
      let names;
      try { names = fs.readdirSync(inner).slice(0, PHOTO_INNER_READ_CAP); } catch { continue; }
      for (const name of names) consider(inner, name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成参数台账（本模块关掉的主仓缺口）
// ---------------------------------------------------------------------------

/**
 * 规范化一条生成记录：提示词默认只留哈希，除非显式 storePromptText。
 * 输入宽进（调用方可传裸参数），输出严出（落盘形状固定）。
 */
function normalizeParamsRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'record must be an object' };
  }
  const actionId = input.actionId;
  if (!isSafeActionId(actionId)) return { ok: false, error: `invalid actionId: ${JSON.stringify(actionId)}` };
  const kind = input.kind === undefined || input.kind === null ? 'image' : String(input.kind);
  if (!RECORD_KINDS.includes(kind)) {
    return { ok: false, error: `invalid kind: ${JSON.stringify(input.kind)} (expected ${RECORD_KINDS.join('|')})` };
  }

  const record = { schemaVersion: PARAMS_SCHEMA_VERSION, actionId, recordedAt: new Date().toISOString() };

  if (typeof input.recordedAt === 'string' && input.recordedAt.trim()) {
    record.recordedAt = input.recordedAt.trim();
  }
  record.kind = kind;
  if (input.provider !== undefined && input.provider !== null) record.provider = String(input.provider);
  if (input.model !== undefined && input.model !== null) record.model = String(input.model);
  if (input.tool !== undefined && input.tool !== null) record.tool = String(input.tool);
  else record.tool = 'studio/bin/provenance.js record';

  // 提示词：默认只存 sha256 哈希；仅当调用方显式 storePromptText 才存原文。
  const storePromptText = input.storePromptText === true;
  const prompt = typeof input.prompt === 'string' ? input.prompt : null;
  if (prompt !== null) {
    record.promptHash = typeof input.promptHash === 'string' && input.promptHash ? input.promptHash : hashPrompt(prompt);
    if (storePromptText) record.prompt = prompt;
  } else if (typeof input.promptHash === 'string' && input.promptHash) {
    record.promptHash = input.promptHash;
  }
  if (input.params !== undefined && input.params !== null) record.params = input.params;
  if (input.seed !== undefined && input.seed !== null) record.seed = input.seed;
  // R4: the executor identity and the tool VERSION travel with the call — a tool
  // name alone rots (the same path can behave differently across versions), and
  // "who ran this" must be answerable per record, not per machine.
  if (typeof input.agent === 'string' && input.agent.trim()) record.agent = input.agent.trim().slice(0, 120);
  if (typeof input.toolVersion === 'string' && input.toolVersion.trim()) record.toolVersion = input.toolVersion.trim().slice(0, 120);
  if (typeof input.note === 'string' && input.note.trim()) record.note = input.note.trim().slice(0, 400);

  // 输入哈希（R4 的显式字段）：`inputs` 与 `references` 同一形状；老调用方（如
  // agent.js intake）只给 `references`，读取侧统一按 `inputs || references` 取。
  if (Array.isArray(input.inputs)) record.inputs = normalizeRefs(input.inputs);
  record.references = normalizeRefs(input.references);
  record.outputs = normalizeRefs(input.outputs);
  if (typeof input.command === 'string' && input.command.trim()) record.command = input.command.trim();
  return { ok: true, record };
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    let p = ref.path;
    if (typeof p !== 'string' || !p.trim()) continue;
    p = p.trim();
    const item = { path: p };
    let sha = typeof ref.sha256 === 'string' && ref.sha256 ? ref.sha256.toLowerCase() : null;
    // 只给了路径没给哈希：路径确实指向一个文件时现场算（recorder 的便利）；
    // 文件不在就保持"无哈希"——report 不会因此把它算成 traceable，绝不编。
    if (!sha) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) sha = sha256File(p);
      } catch { /* 不可读/不存在：不伪造哈希 */ }
    }
    if (sha) item.sha256 = sha;
    if (typeof ref.role === 'string' && ref.role) item.role = ref.role.slice(0, 60);
    if (typeof ref.label === 'string' && ref.label) item.label = ref.label;
    if (typeof ref.note === 'string' && ref.note) item.note = ref.note;
    out.push(item);
  }
  return out;
}

function paramsLedgerPaths(repoRoot, characterId, actionId) {
  const dir = path.join(repoRoot, 'content', 'characters', characterId || DEFAULT_CHARACTER_ID, PARAMS_DIR_RELATIVE);
  return { dir, file: path.join(dir, `${actionId}${PARAMS_FILE_SUFFIX}`) };
}

/**
 * 读逐动作生成参数台账。台账不存在 → { ok:false, exists:false, records:[] }（绝不造空台账）。
 */
function readParamsLedger({ repoRoot, characterId, actionId } = {}) {
  if (!repoRoot || !actionId || !isSafeActionId(actionId)) {
    return { ok: false, exists: false, dir: null, file: null, records: [], reason: 'invalid-args' };
  }
  const { dir, file } = paramsLedgerPaths(repoRoot, characterId, actionId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, exists: false, dir, file, records: [], reason: 'ledger-absent' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, exists: true, dir, file, records: [], reason: `ledger-unparseable: ${e.message}` };
  }
  const records = Array.isArray(parsed.records) ? parsed.records : [];
  return { ok: true, exists: true, dir, file, records, schemaVersion: parsed.schemaVersion };
}

/**
 * 追加一条生成记录（append-only；绝不改写既有记录；自动建目录）。
 * 返回 { ok, file, record }；参数非法 / 台账不可解析时 ok:false 且不落盘。
 *
 * 密钥红线（brief §10.3）：写盘前对**即将落盘的字节**跑形状扫描
 * （`sk-` / `Bearer` / `token=` / cookie …）。命中即拒绝——返回
 * `{ ok:false, code:'SECRET_SHAPE_REFUSED', hits:[指纹] }`，一个字节都不写，
 * 报错里只出现指纹（前 4 位 + 长度 + sha256 前缀），绝不回显值本身。
 */
function writeParamsRecord({ repoRoot, characterId, actionId, record } = {}) {
  if (!repoRoot) return { ok: false, error: 'repoRoot is required' };
  if (!isSafeActionId(actionId)) return { ok: false, error: `invalid actionId: ${JSON.stringify(actionId)}` };
  const normalized = normalizeParamsRecord({ ...(record || {}), actionId });
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const { dir, file } = paramsLedgerPaths(repoRoot, characterId, actionId);
  let existing = [];
  if (fs.existsSync(file)) {
    let parsed;
    try {
      parsed = readJsonFile(file);
    } catch (e) {
      return { ok: false, error: `existing ledger unparseable (refusing to rewrite): ${e.message}` };
    }
    if (!Array.isArray(parsed.records)) return { ok: false, error: 'existing ledger has no records array (refusing to rewrite)' };
    existing = parsed.records;
  }

  const ledger = { schemaVersion: PARAMS_SCHEMA_VERSION, actionId, records: [...existing, normalized.record] };
  const payload = `${JSON.stringify(ledger, null, 2)}\n`;
  const secretScan = scanForSecrets(payload);
  if (!secretScan.ok) {
    return {
      ok: false,
      code: 'SECRET_SHAPE_REFUSED',
      error: `SECRET_SHAPE_REFUSED: refusing to write the params ledger — ${secretScan.hits.length} secret-shaped string(s) [${[...new Set(secretScan.hits.map((hit) => hit.code))].join(',')}] (fingerprints ${secretScan.hits.map((hit) => hit.fingerprint).join(' ')}); the value never reaches disk — remove the credential from the parameters and record again`,
      hits: secretScan.hits.map((hit) => ({ code: hit.code, fingerprint: hit.fingerprint })),
    };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, payload, 'utf8');
  return { ok: true, file, record: normalized.record, appendedAt: ledger.records.length };
}

// ---------------------------------------------------------------------------
// 发布台账（content/characters/<id>/provenance/*.json，只追加的既有事实）
// ---------------------------------------------------------------------------

function publishRecords(ctx, actionId) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(ctx.contentDir).filter((n) => n.endsWith('.json')); } catch { return out; }
  const provenanceDir = path.join(ctx.contentDir, 'provenance');
  let provNames;
  try { provNames = fs.readdirSync(provenanceDir).filter((n) => n.endsWith('.json')); } catch { provNames = []; }
  const candidates = [
    ...names.map((n) => ({ name: n, dir: ctx.contentDir })),
    ...provNames.map((n) => ({ name: n, dir: provenanceDir })),
  ];
  for (const { name, dir } of candidates) {
    let entry;
    try { entry = readJsonFile(path.join(dir, name)); } catch { continue; }
    if (!entry || typeof entry !== 'object' || typeof entry.actionId !== 'string' || !entry.actionId) continue;
    if (actionId && entry.actionId !== actionId) continue;
    const relBackup = entry.backupDirRelative
      ? path.join(ctx.contentRoot, entry.backupDirRelative)
      : null;
    const absBackup = entry.backupDir && path.isAbsolute(entry.backupDir) ? entry.backupDir : null;
    out.push({
      entry: `${toPosix(path.relative(ctx.repoRoot, path.join(dir, name)))}`,
      publishedAt: entry.publishedAt || null,
      summary: entry.summary || null,
      changes: entry.changes || [],
      frames: entry.frames || [],
      filesRewritten: (entry.files && entry.files.rewritten) || [],
      backupDir: entry.backupDirRelative || entry.backupDir || null,
      backupDirPointsOutsideRepo: !!(absBackup && !absBackup.startsWith(ctx.repoRoot + path.sep)),
      backupReachable: !!(relBackup && dirHasFiles(relBackup)) || !!(absBackup && dirHasFiles(absBackup)),
      backupChecked: [relBackup, absBackup].filter(Boolean).map((p) => toPosix(p)),
    });
  }
  return out.sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
}

// ---------------------------------------------------------------------------
// s1 树解析
// ---------------------------------------------------------------------------

function loadPack(ctx) {
  if (ctx._pack) return ctx._pack;
  const animationsFile = path.join(ctx.packRoot, PACK_ANIMATIONS_RELATIVE);
  const anchorsFile = path.join(ctx.packRoot, PACK_ANCHORS_RELATIVE);
  let animations = {};
  let anchors = {};
  try { animations = readJsonFile(animationsFile).animations || {}; } catch { animations = {}; }
  try { anchors = readJsonFile(anchorsFile); } catch { anchors = {}; }
  ctx._pack = {
    animations,
    anchors,
    anchorsFrames: anchors.frames || {},
    animationsFile: toPosix(path.relative(ctx.repoRoot, animationsFile)),
    anchorsFile: toPosix(path.relative(ctx.repoRoot, anchorsFile)),
    animationsExists: fs.existsSync(animationsFile),
    anchorsExists: fs.existsSync(anchorsFile),
  };
  return ctx._pack;
}

function loadCatalog(ctx) {
  if (ctx._catalog) return ctx._catalog;
  if (ctx.catalog) { ctx._catalog = ctx.catalog; return ctx._catalog; }
  const file = path.join(ctx.repoRoot, CATALOG_RELATIVE);
  let active = [];
  let archived = [];
  let loadError = null;
  try {
    const mod = require(file);
    active = mod.LAYOUT_ASSETS || [];
    archived = mod.ARCHIVED_LAYOUT_ASSETS || [];
  } catch (e) {
    loadError = e.message;
  }
  ctx._catalog = {
    active: [...active],
    archived: [...archived],
    file: toPosix(path.relative(ctx.repoRoot, file)),
    exists: fs.existsSync(file),
    loadError,
    byId: new Map(),
  };
  for (const asset of ctx._catalog.active) ctx._catalog.byId.set(asset.id, { asset, archived: false });
  for (const asset of ctx._catalog.archived) ctx._catalog.byId.set(asset.id, { asset, archived: true });
  return ctx._catalog;
}

/** office-protocol 路由规则：office-assets/ → resources/office，characters/ → resources/characters。 */
function resolveCatalogSrc(ctx, src) {
  const rel = String(src || '').replace(/^\.\//, '');
  if (rel.startsWith('characters/')) {
    const tail = rel.slice('characters/'.length);
    return { root: ctx.charactersRoot, rel: tail, diskPath: `resources/characters/${tail}`, routePath: rel, isCharacter: true };
  }
  if (rel.startsWith('office-assets/')) {
    const tail = rel.slice('office-assets/'.length);
    return { root: ctx.officeRoot, rel: tail, diskPath: `resources/office/${tail}`, routePath: rel, isCharacter: false };
  }
  return { root: ctx.officeRoot, rel, diskPath: `resources/office/${rel}`, routePath: `office-assets/${rel}`, isCharacter: false };
}

function contentActionDoc(ctx, actionId) {
  const file = path.join(ctx.contentDir, 'actions', `${actionId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return { file: toPosix(path.relative(ctx.repoRoot, file)), doc: readJsonFile(file) }; }
  catch (e) { return { file: toPosix(path.relative(ctx.repoRoot, file)), parseError: e.message }; }
}

// ---------------------------------------------------------------------------
// 段构造助手
// ---------------------------------------------------------------------------

function segment(id, status, evidence, notes) {
  return { id, status, evidence: evidence || {}, notes: notes || [] };
}

function finding(level, code, message) {
  return { level, code, message };
}

/**
 * 一条调用台账记录的"可回答"摘要（report 用；完整记录仍在台账文件里）。
 * 刻意带上 toolVersion / agent / command —— 这三个字段是 R4 补上的入账维度：
 * "用什么跑的、谁跑的、怎么重跑"。
 */
function summarizeCallRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    recordedAt: record.recordedAt || null,
    kind: record.kind || null,
    tool: record.tool || null,
    toolVersion: record.toolVersion || null,
    agent: record.agent || null,
    provider: record.provider || null,
    model: record.model || null,
    seed: record.seed === undefined ? null : record.seed,
    promptHash: record.promptHash || null,
    params: record.params === undefined ? null : record.params,
    command: record.command || null,
    inputs: (record.inputs || record.references || []).length,
    outputs: (record.outputs || []).length,
    inputHashes: (record.inputs || record.references || []).map((entry) => entry && entry.sha256).filter(Boolean),
    outputHashes: (record.outputs || []).map((entry) => entry && entry.sha256).filter(Boolean),
    note: record.note || null,
  };
}

/**
 * 一键复现命令：记录里带的 command 就是它。没有 command 的记录直说"不能仅凭台账复现"，
 * 绝不合成一个猜的命令。
 */
function reproduceCommand(record) {
  if (record && typeof record.command === 'string' && record.command.trim()) {
    return { command: record.command.trim(), source: 'recorded', note: 'recorded with the call — copy, paste, rerun' };
  }
  return { command: null, source: 'none', note: 'no command was recorded for this call — it cannot be reproduced from the ledger alone' };
}

function rollupReproducible(segments, findings) {
  const statuses = segments.map((s) => s.status);
  if (statuses.includes('lost')) return 'red';
  if (findings.some((f) => f.level === 'red')) return 'red';
  if (statuses.includes('traceable-in-history') || statuses.includes('not-recorded')) return 'yellow';
  if (findings.some((f) => f.level === 'yellow')) return 'yellow';
  return 'green';
}

/**
 * 资产级状态汇总（verify 的 status 列）：五段链的最差值。
 * 优先级 lost > not-recorded > traceable-in-history > traceable——
 * 任何一段跑不出来就把整条链降级，绝不取最好的一段来"报喜"。
 */
const STATUS_PRECEDENCE = ['lost', 'not-recorded', 'traceable-in-history', 'traceable'];

function rollupStatus(segments) {
  let worst = 'traceable';
  for (const s of segments) {
    if (STATUS_PRECEDENCE.indexOf(s.status) < STATUS_PRECEDENCE.indexOf(worst)) worst = s.status;
  }
  return worst;
}

/** 多个入口工具的段级汇总：能力在盘即 traceable；都在历史里 → traceable-in-history；都没有 → lost。 */
function normalizeBest(tools) {
  const statuses = tools.map((t) => t.status);
  if (statuses.includes('traceable')) return 'traceable';
  if (statuses.includes('traceable-in-history')) return 'traceable-in-history';
  return 'lost';
}

/**
 * 记录的 outputs[].sha256 是否对应盘上一个字节（台账路径本身，或该动作的在盘帧）。
 *
 * 三种结局分开报，因为它们的含义完全不同：
 *   matched   路径解析到文件且内容哈希一致 —— 这次调用的产物还在盘上
 *   tampered  路径解析到文件但内容哈希不同 —— 字节被改过（红：链断了）
 *   unresolved 路径哪儿都不在 —— 文件被搬走/替换/删除（黄：只能说"跑过一次"）
 */
function outputsMatchOnDisk(ctx, outputs, onDiskShas) {
  const matched = [];
  const tampered = [];
  const unresolved = [];
  for (const out of outputs || []) {
    if (!out || !out.sha256) { unresolved.push({ output: out, reason: 'no-sha256-recorded' }); continue; }
    const sha = String(out.sha256).toLowerCase();
    let hit = onDiskShas.has(sha);
    let resolvedPath = null;
    if (out.path) {
      const candidates = path.isAbsolute(out.path)
        ? [out.path]
        : [
            path.join(ctx.contentDir, out.path),
            path.join(ctx.contentDir, 'assets', out.path),
            path.join(ctx.repoRoot, out.path),
            ...(ctx.photoRoot ? [path.join(ctx.photoRoot, out.path)] : []),
          ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          const st = fileStat(cand);
          if (st.exists && st.sha256 === sha) { hit = true; resolvedPath = toPosix(cand); break; }
          if (st.exists) resolvedPath = resolvedPath || toPosix(cand);
        }
      }
    }
    if (hit) matched.push({ path: out.path || null, sha256: sha, resolvedAt: resolvedPath });
    else if (resolvedPath) tampered.push({ path: out.path, sha256: sha, resolvedAt: resolvedPath, reason: 'recorded sha256 does not match the bytes now at that path' });
    else unresolved.push({ output: { path: out.path || null, sha256: sha }, reason: 'sha-not-on-disk' });
  }
  return { matched, tampered, unresolved, missing: [...tampered, ...unresolved] };
}

// ---------------------------------------------------------------------------
// report: 角色动作
// ---------------------------------------------------------------------------

function reportAction(ctx, actionId) {
  const pack = loadPack(ctx);
  const entry = pack.animations[actionId];
  if (!entry) return null;

  const frames = (entry.frames || []).map((f) => {
    const abs = path.join(ctx.packRoot, f.file);
    const st = fileStat(abs);
    const anchorEntry = pack.anchorsFrames[f.file] || null;
    const mirrorCandidates = [path.join(ctx.contentDir, f.file), path.join(ctx.contentDir, 'assets', f.file)];
    const contentFile = mirrorCandidates.find((p) => fs.existsSync(p));
    let mirror = { present: false, identical: null };
    if (contentFile) {
      const cst = fileStat(contentFile);
      mirror = {
        present: true,
        contentPath: toPosix(path.relative(ctx.contentDir, contentFile)),
        identical: cst.exists && st.exists ? cst.sha256 === st.sha256 : null,
        contentSha256: cst.sha256 || null,
      };
    }
    return {
      file: `resources/characters/${ctx.packId}/${f.file}`,
      durationMs: f.durationMs === undefined ? null : f.durationMs,
      bytes: st.bytes,
      sha256: st.sha256 || null,
      exists: st.exists,
      anchor: anchorEntry ? anchorEntry.outputAnchor || null : null,
      anchorRecorded: !!anchorEntry,
      contentMirror: mirror,
    };
  });

  const onDiskShas = new Set(frames.filter((f) => f.sha256).map((f) => f.sha256));
  for (const f of frames) if (f.contentMirror.contentSha256) onDiskShas.add(f.contentMirror.contentSha256);

  const ledger = readParamsLedger({ repoRoot: ctx.repoRoot, characterId: ctx.characterId, actionId });
  const recordedOutputs = ledger.records.flatMap((r) => r.outputs || []);
  const { matched, tampered, missing } = outputsMatchOnDisk(ctx, recordedOutputs, onDiskShas);
  // the newest record is what "how was this made" answers with; older ones stay in
  // the ledger file (append-only) and are counted, not reprinted here.
  const latestRecord = ledger.records.length ? summarizeCallRecord(ledger.records[ledger.records.length - 1]) : null;

  const pub = publishRecords(ctx, actionId);
  const latestPub = pub.length ? pub[pub.length - 1] : null;
  const genAnchors = photoAnchors(ctx.photoRoot, actionId);

  const contentDoc = contentActionDoc(ctx, actionId);
  let drift = [];
  if (contentDoc && contentDoc.doc) {
    const docFrames = ((contentDoc.doc.frames || []).map((f) => f.file));
    const packFrames = (entry.frames || []).map((f) => f.file);
    if (docFrames.length !== packFrames.length) drift.push(`frame count ${docFrames.length} (content) vs ${packFrames.length} (pack)`);
    for (let i = 0; i < Math.min(docFrames.length, packFrames.length); i += 1) {
      if (docFrames[i] !== packFrames[i]) drift.push(`frame[${i}] ${docFrames[i]} (content) vs ${packFrames[i]} (pack)`);
      else {
        const d = (contentDoc.doc.frames[i] || {}).durationMs;
        const p = (entry.frames[i] || {}).durationMs;
        if (String(d) !== String(p)) drift.push(`durationMs[${i}] ${d} (content) vs ${p} (pack)`);
      }
    }
  }

  const findings = [];

  // ---- segment 1: 生成（本模块关掉的主仓缺口）----
  let genStatus;
  let genEvidence = {
    ledger: {
      file: ledger.file ? toPosix(path.relative(ctx.repoRoot, ledger.file)) : null,
      exists: ledger.exists,
      records: ledger.records.length,
      reason: ledger.reason || null,
    },
    recordedOutputs: recordedOutputs.length,
    matchedOutputs: matched.length,
    tamperedOutputs: tampered.slice(0, 20),
    unmatchedOutputs: missing.slice(0, 20),
    latestRecord,
    reproduce: latestRecord ? reproduceCommand(latestRecord) : { command: null, source: 'none', note: 'no call was ever recorded for this action' },
    publishRecord: latestPub ? { entry: latestPub.entry, publishedAt: latestPub.publishedAt } : null,
    photoAnchors: genAnchors.slice(0, 12),
  };
  const genNotes = [];
  if (ledger.ok && ledger.records.length) {
    if (matched.length) {
      genStatus = 'traceable';
      genEvidence.proof = `${matched.length}/${recordedOutputs.length} recorded output sha256 matched a byte currently on disk`;
      if (latestRecord) {
        genNotes.push(`最近一次调用：${latestRecord.tool}${latestRecord.toolVersion ? ` @ ${latestRecord.toolVersion}` : ''} · 执行者 ${latestRecord.agent} · ${latestRecord.recordedAt}`);
        if (latestRecord.command) genNotes.push(`一键复现：${latestRecord.command}`);
      }
    } else {
      genStatus = 'traceable-in-history';
      genEvidence.proof = 'ledger proves a generation run happened, but none of its recorded outputs matches a byte currently on disk (files replaced, moved or re-published since)';
      genNotes.push('记录在盘但字节对不上：不要当成"当前帧就是那次调用的产物"——需要重跑或补一条指向当前字节的记录。');
      findings.push(finding('yellow', 'generation-outputs-not-on-disk',
        `生成台账 ${ledger.records.length} 条，但 recorded outputs 无一对上当前在盘字节（输出被改写/搬移）`));
    }
  } else if (latestPub) {
    genStatus = 'traceable-in-history';
    genEvidence.proof = `no generation params ledger; publish record ${latestPub.entry} (${latestPub.publishedAt}) proves a run happened for this action, but not the call parameters`;
    genNotes.push(`生成调用参数未入台账：用 node studio/bin/provenance.js record --action ${actionId} ... 补记（提示词默认只存 sha256）。`);
    findings.push(finding('info', 'generation-params-not-ledgered',
      `生成参数未入台账；发布台账 ${latestPub.entry} 证明跑过一次，但不含调用参数`));
  } else {
    genStatus = 'not-recorded';
    genEvidence.proof = 'no generation params ledger and no publish record — nothing in the repo proves how the frames were generated';
    genNotes.push('没有任何记录能证明这一动作的帧是怎么生成的（无台账、无发布记录）——别猜，去补 record。');
    findings.push(finding('yellow', 'generation-not-recorded',
      `动作 ${actionId} 无生成参数台账、无发布记录：来源无法回溯`));
  }
  if (ledger.exists && !ledger.ok && ledger.reason !== 'ledger-absent') {
    findings.push(finding('red', 'generation-ledger-unreadable', `生成台账不可解析：${ledger.reason}`));
    genStatus = genStatus === 'traceable' ? 'traceable-in-history' : genStatus;
  }
  // 篡改是红项：台账说"这次调用产出了 sha=X 的字节"，而那个路径上的字节现在是 Y。
  // 这不叫"对不上"（那可能只是搬移），这叫"链被改过"——verify 因此变红。
  if (tampered.length > 0) {
    genNotes.push(`${tampered.length} 个记录的输出路径在盘，但内容哈希与台账不一致（字节被改过）：${tampered.slice(0, 5).map((entry) => entry.resolvedAt || entry.path).join(', ')}`);
    findings.push(finding('red', 'generation-output-tampered',
      `${tampered.length} 个 recorded output 的路径在盘但内容哈希与台账不一致（输出被篡改/改写）：${tampered.slice(0, 3).map((entry) => `${entry.resolvedAt || entry.path} ${entry.sha256.slice(0, 12)}…`).join('; ')}`));
  }
  if (!ledger.exists) genNotes.push(`台账路径（尚不存在）：content/characters/${ctx.characterId}/${PARAMS_DIR_RELATIVE}/${actionId}${PARAMS_FILE_SUFFIX}`);

  // ---- segment 2: 抠像 ----
  const cutoutTool = toolStatus(ctx.repoRoot, TOOLS.removeBg);
  const mattingStatus = cutoutTool.status;
  const mattingNotes = mattingStatus !== 'traceable' ? [cutoutTool.note] : [];
  mattingNotes.push('逐资产的抠像调用参数（阈值/容差/输入目录）未随资产记录，脚本常量是唯一参数权威。');
  const mattingEvidence = {
    tool: TOOLS.removeBg,
    toolStatus: cutoutTool,
    photoAnchors: genAnchors.filter((a) => /nobg|trimmed|matting|抠像/i.test(a.path)).slice(0, 12),
    note: 'photo/ 里的 -nobg/-trimmed 中间产物只是存在性锚点，抠像当次参数没有记录',
  };  if (mattingStatus === 'lost') findings.push(finding('red', 'matting-tool-lost', `抠像工具不在盘且历史不可找回：${TOOLS.removeBg}`));

  // ---- segment 3: 归一化 ----
  // 多个入口工具里只要有一个在盘，"归一化能力"就是可复现的；全不在盘才逐级降级。
  const normalizeTools = [TOOLS.normalizeCharacter, TOOLS.normalizeWalkPlanB, TOOLS.normalizer].map((t) => toolStatus(ctx.repoRoot, t));
  const normalizeStatus = normalizeBest(normalizeTools);
  const anchorsMissing = frames.filter((f) => !f.anchorRecorded).map((f) => f.file);
  const normalizeNotes = [`几何权威 = resources/characters/${ctx.packId}/${PACK_ANCHORS_RELATIVE}；帧/时序权威 = ${PACK_ANIMATIONS_RELATIVE}。`];
  if (anchorsMissing.length) {
    normalizeNotes.push(`anchors.json 缺少 ${anchorsMissing.length} 帧的几何记录：${anchorsMissing.slice(0, 5).join(', ')}`);
    findings.push(finding('yellow', 'anchors-geometry-missing', `anchors.json 未记录 ${anchorsMissing.length} 帧的几何`));
  } else {
    normalizeNotes.push(`anchors.json 记录了全部 ${frames.length} 帧的几何。`);
  }
  if (normalizeStatus === 'lost') findings.push(finding('red', 'normalize-tool-lost', '归一化工具链不可找回'));
  const normalizeEvidence = {
    tools: normalizeTools,
    anchorsFile: pack.anchorsFile,
    anchorsFramesRecorded: frames.length - anchorsMissing.length,
    anchorsFramesTotal: frames.length,
  };

  // ---- segment 4: 发布 ----
  const publisherTool = toolStatus(ctx.repoRoot, TOOLS.actionPublisher);
  const unreachableBackups = pub.filter((p) => !p.backupReachable);
  const publishNotes = [];
  let publishStatus;
  if (pub.length) {
    publishStatus = 'traceable';
    publishNotes.push(`发布台账 ${pub.length} 条，最新 ${latestPub.publishedAt}；backup 在仓内可达 ${pub.length - unreachableBackups.length}/${pub.length}。`);
  } else {
    publishStatus = publisherTool.status === 'traceable' ? 'not-recorded' : publisherTool.status;
    publishNotes.push('该动作无 provenance 发布台账条目：早于发布内核或从未经 publish 改写（原始归一化产物可能在盘）。');
    findings.push(finding('yellow', 'publish-record-missing',
      `动作 ${actionId} 无发布台账条目：无法证明这些字节经过 publishAction`));
  }
  for (const b of unreachableBackups) {
    findings.push(finding('yellow', 'publish-backup-unreachable',
      `备份不可达：${b.entry} → ${b.backupDir}${b.backupDirPointsOutsideRepo ? '（指向仓外，s1 时代记录）' : ''}`));
  }
  const publishEvidence = {
    tool: TOOLS.actionPublisher,
    toolStatus: publisherTool,
    records: pub.length,
    latest: latestPub ? { entry: latestPub.entry, publishedAt: latestPub.publishedAt } : null,
    backupUnreachable: unreachableBackups.map((b) => ({ entry: b.entry, backupDir: b.backupDir, pointsOutsideRepo: b.backupDirPointsOutsideRepo })),
  };

  // ---- segment 5: 在盘校验 ----
  const missingFrames = frames.filter((f) => !f.exists);
  const mirroredDiffering = frames.filter((f) => f.contentMirror.present && f.contentMirror.identical === false);
  const onDiskStatus = missingFrames.length ? 'lost' : 'traceable';
  const onDiskNotes = [];
  if (missingFrames.length) {
    onDiskNotes.push(`缺失帧：${missingFrames.map((f) => f.file).join(', ')}`);
    findings.push(finding('red', 'frames-missing-on-disk', `在盘校验失败：${missingFrames.length} 帧缺失`));
  } else {
    onDiskNotes.push(`在盘 ${frames.length} 帧，sha256 已记录在案。`);
  }
  if (mirroredDiffering.length) {
    onDiskNotes.push(`content 镜像与 pack 不一致 ${mirroredDiffering.length} 帧：${mirroredDiffering.slice(0, 5).map((f) => f.file).join(', ')}`);
    findings.push(finding('yellow', 'content-pack-drift',
      `content↔pack 漂移 ${mirroredDiffering.length} 帧——存在绕开发布链的手改嫌疑`));
  }
  if (drift.length) {
    findings.push(finding('yellow', 'content-action-doc-drift', `content 动作文档与 pack 不一致：${drift.slice(0, 4).join('; ')}`));
  }
  const onDiskEvidence = {
    framesTotal: frames.length,
    framesOnDisk: frames.filter((f) => f.exists).length,
    missing: missingFrames.map((f) => f.file),
    validatorTool: { ...toolStatus(ctx.repoRoot, TOOLS.validator), usage: `node ${TOOLS.validator} resources/characters/${ctx.packId}` },
    contentMirror: {
      actionDoc: contentDoc ? contentDoc.file : `content/characters/${ctx.characterId}/actions/${actionId}.json`,
      exists: !!contentDoc,
      parseError: contentDoc ? contentDoc.parseError || null : null,
      identicalCount: frames.filter((f) => f.contentMirror.identical === true).length,
      presentCount: frames.filter((f) => f.contentMirror.present).length,
      differingCount: mirroredDiffering.length,
    },
    howToVerifyRunningCopy: [
      '运行时经 office-protocol 的 characters/ 路由从 resources/characters（打包后为 process.resourcesPath）读取本包；',
      '把部署目录中这些帧的 sha256 与本报告逐条比对，全等即"跑的就是这一份"。',
    ],
  };

  const durations = frames.map((f) => f.durationMs).filter((d) => d !== null && d !== undefined);
  const segments = [
    segment('generation', genStatus, genEvidence, genNotes),
    segment('matting', mattingStatus, mattingEvidence, mattingNotes),
    segment('normalize', normalizeStatus, normalizeEvidence, normalizeNotes),
    segment('publish', publishStatus, publishEvidence, publishNotes),
    segment('on-disk', onDiskStatus, onDiskEvidence, onDiskNotes),
  ];

  return {
    ok: true,
    id: actionId,
    kind: 'action',
    generatedAt: new Date().toISOString(),
    characterId: ctx.characterId,
    pack: ctx.packId,
    packPath: toPosix(path.relative(ctx.repoRoot, ctx.packRoot)),
    contentDir: toPosix(path.relative(ctx.repoRoot, ctx.contentDir)),
    animation: {
      loop: !!entry.loop,
      direction: entry.direction || null,
      frameCount: frames.length,
      durationMsPerFrame: durations.length ? [...new Set(durations)] : null,
      perCycleMs: durations.length ? durations.reduce((a, b) => a + (b || 0), 0) : null,
    },
    frames,
    publishLedger: pub,
    segments,
    findings,
    reproducible: rollupReproducible(segments, findings),
  };
}

// ---------------------------------------------------------------------------
// report: 办公室资产（catalog 权威 = src/office/layout-assets.js，本模块只读不改）
// ---------------------------------------------------------------------------

function reportOfficeAsset(ctx, asset, archived) {
  const route = resolveCatalogSrc(ctx, asset.src);
  const abs = path.join(route.root, route.rel);
  const st = fileStat(abs);
  const catalog = loadCatalog(ctx);
  const findings = [];

  // ---- segment 1: 生成 ----
  const isRootEnvProp = !route.isCharacter && route.rel.startsWith('prop-') && !route.rel.includes('/');
  let genStatus;
  let genEvidence;
  let genNotes = [];
  if (route.isCharacter) {
    genStatus = 'not-recorded';
    const actionHint = findActionForFrame(ctx, route.rel);
    genEvidence = {
      note: '编辑器起草用角色图 = 生产包在播帧（characters/ 路由），生成链跟随对应动作',
      followUp: actionHint ? `report ${actionHint}` : null,
    };
    genNotes.push(actionHint
      ? `本 asset 的来源链见 report ${actionHint}（同一字节）。`
      : '本 asset 的来源链需按 report <action-id> 查对应动作。');
    findings.push(finding('info', 'office-character-asset-follows-action-chain',
      'catalog 角色图不是独立资产：来源链跟随生产包动作'));
  } else if (isRootEnvProp) {
    const genPropsTool = toolStatus(ctx.repoRoot, TOOLS.genProps);
    genStatus = genPropsTool.status;
    genEvidence = {
      tool: TOOLS.genProps,
      toolStatus: genPropsTool,
      note: '根目录环境道具生成器在盘/历史可找回，但逐资产的调用参数（提示词/尺寸/批次）未入台账',
      paramsLedgerShape: `content/characters/<characterId>/${PARAMS_DIR_RELATIVE}/<actionId>${PARAMS_FILE_SUFFIX}（仅角色动作维度）；办公室道具无等价台账`,
    };
    genNotes.push('生成器脚本本身可复现；这一张 prop 当次用了什么参数，仓库里没有记录。');
    findings.push(finding('yellow', 'office-prop-generation-params-unrecorded',
      `${asset.id}：生成器在盘，但逐资产的生成参数未入台账`));
  } else {
    genStatus = 'not-recorded';
    genEvidence = {
      note: 'flat/ 平面贴图与 layout-editor/ 等轴贴图无生成脚本记录：作者/生成参数/批次都不在仓库；目录表只登记批次标签（v6–v11）与实测 contentBbox',
      batchLabel: asset.contentBbox ? 'v6–v11 批次' : null,
    };
    genNotes.push('用户手绘/外部生成的美术：来源无法回溯——这是素材复现链的真实断点，别用"应该没问题"糊过去。');
    findings.push(finding('yellow', 'office-art-generation-not-recorded',
      `${asset.id}：无生成脚本、无逐资产参数记录，来源无法回溯`));
  }

  // ---- segment 2: 抠像 ----
  const mattingStatus = 'not-recorded';
  const kitDir = 'photo/video-matting-kit';
  const mattingEvidence = {
    note: 'catalog 家具/道具贴图没有抠像环节记录；盘上的 PNG 本身就是唯一产物',
    kitReference: fs.existsSync(path.join(ctx.repoRoot, kitDir)) ? kitDir : null,
  };
  const mattingNotes = ['该资产链路里没有可证明的抠像步骤；不虚构"去过底"。'];

  // ---- segment 3: 归一化 ----
  let normalizeStatus;
  let normalizeEvidence;
  const normalizeNotes = [];
  if (asset.contentBbox) {
    normalizeStatus = 'traceable';
    normalizeEvidence = {
      declared: true,
      contentBbox: asset.contentBbox,
      measurement: 'alpha>8 实测一次，catalog 测试锁定 ±0.002 防漂移',
      note: '渲染用 contentBbox 裁边，不动 PNG 字节；没有画布归一化步骤',
    };
    normalizeNotes.push('归一化结论以 catalog 的 contentBbox 形式在案（实测 + 测试锁定）。');
  } else {
    normalizeStatus = 'not-recorded';
    normalizeEvidence = {
      declared: false,
      note: '该 catalog 条目未声明 contentBbox，也没有画布归一化记录',
    };
    normalizeNotes.push('没有可引用的归一化结论；如后续做画布统一，请把测量值写进 catalog 并补测试。');
  }

  // ---- segment 4: 发布/登记 ----
  const publishStatus = 'traceable';
  const publishEvidence = {
    authority: catalog.file,
    authorityExists: catalog.exists,
    authorityLoadError: catalog.loadError,
    entry: {
      id: asset.id,
      label: asset.label || null,
      kind: asset.kind || null,
      direction: asset.direction || null,
      directional: !!asset.directional,
      archived: !!archived,
    },
    catalogSize: { active: catalog.active.length, archived: catalog.archived.length },
    note: '目录表登记（label/kind/direction/contentBbox）即在案发布记录；catalog 测试锁 ±0.002',
  };
  if (!catalog.exists) findings.push(finding('red', 'catalog-unreadable', `catalog 权威文件缺失：${catalog.file}`));

  // ---- segment 5: 在盘校验 ----
  const onDiskStatus = st.exists ? 'traceable' : 'lost';
  const onDiskEvidence = {
    path: route.diskPath,
    exists: st.exists,
    bytes: st.bytes,
    sha256: st.sha256 || null,
    servedAs: route.routePath,
    note: st.exists ? '在盘，sha256 已记录' : 'catalog 条目指向的文件不在盘（反向缺口！）',
  };
  if (!st.exists) findings.push(finding('red', 'office-texture-missing-on-disk', `catalog 资产在盘缺失：${route.diskPath}`));

  const segments = [
    segment('generation', genStatus, genEvidence, genNotes),
    segment('matting', mattingStatus, mattingEvidence, mattingNotes),
    segment('normalize', normalizeStatus, normalizeEvidence, normalizeNotes),
    segment('publish', publishStatus, publishEvidence, []),
    segment('on-disk', onDiskStatus, onDiskEvidence, st.exists ? [] : [`文件缺失：${route.diskPath}`]),
  ];

  return {
    ok: true,
    id: asset.id,
    kind: 'office-asset',
    generatedAt: new Date().toISOString(),
    label: asset.label || null,
    archived: !!archived,
    catalog: { file: catalog.file, active: !archived },
    file: { path: route.diskPath, servedAs: route.routePath, exists: st.exists, bytes: st.bytes, sha256: st.sha256 || null },
    contentBbox: asset.contentBbox || null,
    segments,
    findings,
    reproducible: rollupReproducible(segments, findings),
  };
}

/** 反查某 pack 帧属于哪个动作（catalog 角色图 → 动作链）。
 *  catalog 的 characters/ 路由给出的是 `deepseek-default/assets/...`（含 pack id 前缀），
 *  而 animations.json 的帧路径是 pack 内相对路径——两种都试。 */
function findActionForFrame(ctx, relFromPack) {
  const pack = loadPack(ctx);
  const candidates = new Set([relFromPack]);
  const prefix = `${ctx.packId}/`;
  if (relFromPack.startsWith(prefix)) candidates.add(relFromPack.slice(prefix.length));
  for (const [actionId, entry] of Object.entries(pack.animations)) {
    for (const f of entry.frames || []) if (candidates.has(f.file)) return actionId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

function createProvenance({
  repoRoot,
  contentDir,
  charactersRoot,
  officeRoot,
  photoRoot,
  characterId,
  packId,
  catalog,
} = {}) {
  const root = path.resolve(repoRoot || path.resolve(__dirname, '..', '..'));
  const ctx = {
    repoRoot: root,
    contentDir: path.resolve(contentDir || path.join(root, 'content', 'characters', DEFAULT_CHARACTER_ID)),
    charactersRoot: path.resolve(charactersRoot || path.join(root, 'resources', 'characters')),
    officeRoot: path.resolve(officeRoot || path.join(root, 'resources', 'office')),
    photoRoot: path.resolve(photoRoot || path.join(root, 'photo')),
    characterId: characterId || path.basename(path.resolve(contentDir || path.join(root, 'content', 'characters', DEFAULT_CHARACTER_ID))),
    packId: packId || DEFAULT_PACK_ID,
    packRoot: null,
    contentRoot: null,
    catalog: catalog || null,
    _pack: null,
    _catalog: null,
  };
  ctx.packRoot = path.join(ctx.charactersRoot, ctx.packId);
  ctx.contentRoot = path.resolve(ctx.contentDir, '..', '..');

  function actionIds() {
    const pack = loadPack(ctx);
    const ids = new Set(Object.keys(pack.animations));
    let actionDir = path.join(ctx.contentDir, 'actions');
    try {
      for (const name of fs.readdirSync(actionDir)) {
        if (name.endsWith('.json')) ids.add(name.replace(/\.json$/, ''));
      }
    } catch { /* 无 content 动作树 */ }
    // 有台账但还没进 pack 的动作也算已知 id（诚实：它确实是人记录过的）
    const genDir = path.join(ctx.contentDir, PARAMS_DIR_RELATIVE);
    try {
      for (const name of fs.readdirSync(genDir)) {
        const m = name.match(/^(.*)\.params\.json$/);
        if (m) ids.add(m[1]);
      }
    } catch { /* 台账目录尚未建立 */ }
    return [...ids].sort();
  }

  function officeAssets() {
    const catalogLoaded = loadCatalog(ctx);
    return [
      ...catalogLoaded.active.map((asset) => ({ asset, archived: false })),
      ...catalogLoaded.archived.map((asset) => ({ asset, archived: true })),
    ];
  }

  function resolve(id) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'id is required' };
    const pack = loadPack(ctx);
    const catalogLoaded = loadCatalog(ctx);
    if (pack.animations[id]) return { ok: true, id, kind: 'action', entry: pack.animations[id] };
    if (catalogLoaded.byId.has(id)) {
      const hit = catalogLoaded.byId.get(id);
      return { ok: true, id, kind: 'office-asset', asset: hit.asset, archived: hit.archived };
    }
    const genDir = path.join(ctx.contentDir, PARAMS_DIR_RELATIVE);
    if (fs.existsSync(path.join(genDir, `${id}${PARAMS_FILE_SUFFIX}`))) {
      return { ok: true, id, kind: 'action', entry: null, note: 'params ledger exists but the action is not in the pack' };
    }
    if (fs.existsSync(path.join(ctx.contentDir, 'actions', `${id}.json`))) {
      return { ok: true, id, kind: 'action', entry: null, note: 'content action doc exists but the action is not in the pack' };
    }
    return { ok: false, error: `unknown id: ${id}`, known: [...new Set([...actionIds(), ...catalogLoaded.byId.keys()])].sort() };
  }

  function report(assetId) {
    const hit = resolve(assetId);
    if (!hit.ok) {
      return {
        ok: false,
        id: assetId,
        error: hit.error,
        known: hit.known || [],
        segments: [],
        findings: [],
        reproducible: 'red',
      };
    }
    if (hit.kind === 'action') {
      const actionReport = reportAction(ctx, assetId);
      if (!actionReport) {
        return {
          ok: false,
          id: assetId,
          kind: 'action',
          error: `action ${assetId} is known (${hit.note || 'no pack entry'}) but has no pack animation entry — nothing on disk to verify`,
          segments: [],
          findings: [],
          reproducible: 'red',
        };
      }
      return actionReport;
    }
    return reportOfficeAsset(ctx, hit.asset, hit.archived);
  }

  function verify() {
    const rows = [];
    // 哈希链汇总：台账条数、记录的输出总数、对上的、被篡改的、找不到的。
    // 这是"verify 校验哈希链"的机器可读形态——篡改一个输出文件，这里就从 0 变 1。
    const hashChain = { ledgers: 0, records: 0, outputsRecorded: 0, outputsMatched: 0, outputsTampered: 0, outputsUnresolved: 0 };
    const noteRow = (r) => {
      const generation = r.segments.find((s) => s.id === 'generation');
      const evidence = (generation && generation.evidence) || {};
      if (evidence.ledger && evidence.ledger.exists) {
        hashChain.ledgers += 1;
        hashChain.records += evidence.ledger.records || 0;
        hashChain.outputsRecorded += evidence.recordedOutputs || 0;
        hashChain.outputsMatched += evidence.matchedOutputs || 0;
        hashChain.outputsTampered += (evidence.tamperedOutputs || []).length;
        hashChain.outputsUnresolved += (evidence.unmatchedOutputs || []).length - (evidence.tamperedOutputs || []).length;
      }
      return {
        status: rollupStatus(r.segments),
        reproducible: r.reproducible,
        tampered: (evidence.tamperedOutputs || []).length,
        detail: r.segments.map((s) => `${s.id}:${s.status}`).join(' '),
        segments: r.segments.map((s) => ({ id: s.id, status: s.status })),
        findings: r.findings.map((f) => ({ level: f.level, code: f.code, message: f.message })),
      };
    };
    for (const id of actionIds()) {
      const r = report(id);
      if (!r.ok) continue;
      rows.push({ id, kind: r.kind, ...noteRow(r) });
    }
    for (const { asset, archived } of officeAssets()) {
      const r = report(asset.id);
      if (!r.ok) continue;
      const row = noteRow(r);
      rows.push({ id: asset.id, kind: 'office-asset', ...row, detail: `${row.detail}${archived ? ' (archived)' : ''}` });
    }
    const counts = { traceable: 0, traceableInHistory: 0, lost: 0, notRecorded: 0, tampered: 0 };
    for (const row of rows) {
      if (row.status === 'traceable') counts.traceable += 1;
      else if (row.status === 'traceable-in-history') counts.traceableInHistory += 1;
      else if (row.status === 'lost') counts.lost += 1;
      else counts.notRecorded += 1;
      if (row.tampered > 0) counts.tampered += 1;
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return {
      ok: counts.lost === 0 && counts.tampered === 0,
      verifiedAt: new Date().toISOString(),
      repo: path.basename(ctx.repoRoot),
      pack: ctx.packId,
      catalog: loadCatalog(ctx).file,
      counts,
      hashChain,
      rows,
      note: 'status = 该资产五段链的最差值（lost > not-recorded > traceable-in-history > traceable）；不是"资产好不好"，是"链全不全"。hashChain = 台账输出哈希与在盘字节的逐条比对（tampered > 0 即红：记录的字节被改过）。',
    };
  }

  function index({ out } = {}) {
    const target = path.resolve(out || path.join(ctx.repoRoot, DEFAULT_INDEX_OUT_RELATIVE));
    const pack = loadPack(ctx);
    const catalogLoaded = loadCatalog(ctx);
    const entries = [];
    for (const id of actionIds()) {
      const r = report(id);
      if (r.ok) entries.push(r);
    }
    for (const { asset, archived } of officeAssets()) {
      const r = report(asset.id);
      if (r.ok) entries.push(r);
    }
    const chainGaps = [];
    for (const entry of entries) {
      for (const s of entry.segments) {
        if (s.status !== 'traceable') {
          chainGaps.push({
            id: entry.id,
            kind: entry.kind,
            segment: s.id,
            status: s.status,
            message: s.notes.join(' '),
            findings: entry.findings.filter((f) => f.level !== 'info').map((f) => f.code),
          });
        }
      }
    }
    const toolStatuses = {};
    for (const [name, rel] of Object.entries(TOOLS)) {
      toolStatuses[name] = { path: rel, ...toolStatus(ctx.repoRoot, rel) };
    }
    const index = {
      schemaVersion: 1,
      kind: 'asset-provenance-index',
      generatedAt: new Date().toISOString(),
      repo: path.basename(ctx.repoRoot),
      divisionOfLabor: '在用清单/孤儿判定见 docs 与 animations.json/anchors.json/src/office/layout-assets.js；本索引只记录来源链与校验方法，不重复在用判定',
      pack: ctx.packId,
      counts: {
        characterActions: entries.filter((e) => e.kind === 'action').length,
        officeAssetsActive: entries.filter((e) => e.kind === 'office-asset' && !e.archived).length,
        officeAssetsArchived: entries.filter((e) => e.kind === 'office-asset' && e.archived).length,
        segments: Object.fromEntries(SEGMENTS.map((s) => [s, entries.filter((e) => e.segments.find((x) => x.id === s).status === 'traceable').length])),
      },
      tools: toolStatuses,
      chainGaps,
      entries,
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    return { ok: true, out: target, index, entries };
  }

  function lost() {
    const entries = [];
    const seen = new Set();
    const push = (id, kind, status, segmentId, reason, anchors) => {
      const key = `${id}|${segmentId}|${status}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ id, kind, status, segment: segmentId, reason, anchors });
    };

    for (const id of actionIds()) {
      const r = report(id);
      if (!r.ok) continue;
      for (const s of r.segments) {
        if (s.status === 'traceable') continue;
        const anchors = [];
        if (s.id === 'generation') {
          const genEvidence = s.evidence;
          anchors.push(`补台账：node studio/bin/provenance.js record --action ${id} --kind frame-sheet ...`);
          if (genEvidence.ledger && genEvidence.ledger.file) anchors.push(`台账文件：${genEvidence.ledger.file}`);
          if (genEvidence.publishRecord) anchors.push(`发布记录：${genEvidence.publishRecord.entry}（${genEvidence.publishRecord.publishedAt}）`);
          for (const p of (genEvidence.photoAnchors || []).slice(0, 6)) anchors.push(`photo 候选：${p.path}`);
          if (genEvidence.unmatchedOutputs && genEvidence.unmatchedOutputs.length) {
            anchors.push(...genEvidence.unmatchedOutputs.slice(0, 4).map((o) => `记录过但不在盘：${o.output.path || '(no path)'} (${String(o.output.sha256 || '').slice(0, 12)})`));
          }
        }
        if (s.id === 'publish' && s.evidence.latest) anchors.push(`最近发布：${s.evidence.latest.entry}`);
        for (const b of (s.evidence.backupUnreachable || [])) anchors.push(`备份不可达：${b.entry} → ${b.backupDir}`);
        if (s.id === 'on-disk') for (const f of s.evidence.missing || []) anchors.push(`缺失帧：${f}`);
        if (!anchors.length) anchors.push(`无找回锚点：请人工确认该环节从未存在，别伪造`);
        push(id, r.kind, s.status, s.id, s.notes.join(' ') || `${s.id} ${s.status}`, anchors);
      }
    }
    for (const { asset } of officeAssets()) {
      const r = report(asset.id);
      if (!r.ok) continue;
      for (const s of r.segments) {
        if (s.status === 'traceable') continue;
        const anchors = [`catalog 权威：${loadCatalog(ctx).file}`, `在盘位置：${r.file.path}`];
        if (s.id === 'generation') {
          anchors.push(`生成器参照：${TOOLS.genProps}（若该资产由其生成）`);
          anchors.push('无逐资产参数台账：需要补 record 或接受"来源不可回溯"的事实');
        }
        push(asset.id, r.kind, s.status, s.id, s.notes.join(' ') || `${s.id} ${s.status}`, anchors);
      }
    }
    // 工具级断点（在盘/git 都找不到的）
    for (const [name, rel] of Object.entries(TOOLS)) {
      const status = toolStatus(ctx.repoRoot, rel);
      if (status.status === 'traceable') continue;
      push(`tool:${name}`, 'tool', status.status, 'tool-chain', `${rel} — ${status.note}`, [status.recoverFrom || `git log -- ${rel}`, rel]);
    }
    return { ok: true, generatedAt: new Date().toISOString(), entries };
  }

  function record(input = {}) {
    const actionId = input.actionId;
    if (!isSafeActionId(actionId)) return { ok: false, error: `invalid actionId: ${JSON.stringify(actionId)}` };
    const kind = input.kind === undefined || input.kind === null ? 'image' : input.kind;
    if (!RECORD_KINDS.includes(kind)) {
      return { ok: false, error: `invalid kind: ${JSON.stringify(kind)} (expected ${RECORD_KINDS.join('|')})` };
    }
    const written = writeParamsRecord({
      repoRoot: ctx.repoRoot,
      characterId: input.characterId || ctx.characterId,
      actionId,
      record: { ...input, kind },
    });
    if (!written.ok) return { ok: false, error: written.error };
    return {
      ok: true,
      file: written.file,
      fileRelative: toPosix(path.relative(ctx.repoRoot, written.file)),
      record: written.record,
    };
  }

  function readParams(actionId) {
    return readParamsLedger({ repoRoot: ctx.repoRoot, characterId: ctx.characterId, actionId });
  }

  function toolChainStatus(relPath) {
    return toolStatus(ctx.repoRoot, relPath);
  }

  const pack = loadPack(ctx);
  const catalogLoaded = loadCatalog(ctx);

  return {
    repoRoot: ctx.repoRoot,
    contentDir: ctx.contentDir,
    charactersRoot: ctx.charactersRoot,
    officeRoot: ctx.officeRoot,
    photoRoot: ctx.photoRoot,
    characterId: ctx.characterId,
    packId: ctx.packId,
    packRoot: ctx.packRoot,
    indexDefaultOut: path.join(ctx.repoRoot, DEFAULT_INDEX_OUT_RELATIVE),
    // 只读查询
    actionIds,
    officeAssets,
    resolve,
    report,
    verify,
    index,
    lost,
    readParams,
    toolChainStatus,
    // 只写台账（追加）
    record,
    // 只读快照（调试/测试用；不写任何东西）
    snapshot() {
      return {
        repoRoot: ctx.repoRoot,
        pack: { id: ctx.packId, animations: pack.animationsExists, anchors: pack.anchorsExists },
        catalog: { file: catalogLoaded.file, exists: catalogLoaded.exists, active: catalogLoaded.active.length, archived: catalogLoaded.archived.length, loadError: catalogLoaded.loadError },
      };
    },
  };
}

module.exports = {
  createProvenance,
  readParamsLedger,
  writeParamsRecord,
  PARAMS_DIR_RELATIVE,
  PARAMS_SCHEMA_VERSION,
  PARAMS_FILE_SUFFIX,
  STATUSES,
  SEGMENTS,
  RECORD_KINDS,
  DEFAULT_CHARACTER_ID,
  DEFAULT_PACK_ID,
  DEFAULT_INDEX_OUT_RELATIVE,
  TOOLS,
  sha256File,
  sha256Text,
  hashPrompt,
  normalizeParamsRecord,
  summarizeCallRecord,
  reproduceCommand,
  toolStatus,
  relFrom,
};
