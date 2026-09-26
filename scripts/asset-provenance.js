#!/usr/bin/env node
'use strict';

// scripts/asset-provenance.js — 办公室美术资产「复现链」归档 CLI（P2 运维能力）。
//
// 背景：素材/资产类缺陷（行走帧、贴图）的复现曾依赖外部脚本与手工步骤，
// 出问题难以回溯"这一帧/这张贴图从哪来、怎么变成现在这份"。本 CLI 把
// 每个在用资产的**来源链**变成可机器核对的记录：
//
//   生成（生图脚本/参数）→ 抠像（remove-bg.py）→ 归一化（normalize-character.py
//   / workbench normalizer）→ 发布（action-publisher + provenance 台账）→
//   在盘校验（sha256 + validateCharacterPack + 引用完整性）。
//
// 复用而非重建（与 docs/strategy/2026-09-22-assets-in-use.md 分工）：
//   - 在用判定/权威引用表 = 该文档 + animations.json / anchors.json /
//     src/office/layout-assets.js —— 本 CLI 不另立清单，只**追加链信息**；
//   - 发布台账 = content/characters/whale-girl/provenance/*.json（只追加）；
//   - 几何 = anchors.json（唯一权威）；帧/时序 = animations.json（唯一权威）。
//
// 诚实原则：跑不出来的环节如实标 `lost` / `not-recorded`，并给出找回锚点
// （git 提交、s1 只读参照），绝不伪造"可复现"。已知丢失点（P5-2 主仓清出
// 创作块，能力留在 s1）在 LOST_TOOLS 里逐条登记，运行时用 git cat-file
// 复核"能否从历史找回"，复核结果写进产出。
//
// 用法：
//   node scripts/asset-provenance.js report <资产或动作ID>   # 单个资产的链
//       例：report walk-up | report working-back | report flat-desk | report prop-plant
//   node scripts/asset-provenance.js verify [--json]         # 全量在盘校验
//   node scripts/asset-provenance.js index [--out <file>]    # 重建 JSON 索引
//   node scripts/asset-provenance.js lost                    # 列出无法回溯的环节

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const CHARACTERS_ROOT = path.join(ROOT, 'resources', 'characters');
const CONTENT_ROOT = path.join(ROOT, 'content', 'characters', 'whale-girl');
const OFFICE_ROOT = path.join(ROOT, 'resources', 'office');
const INDEX_OUT = path.join(ROOT, 'docs', 'strategy', '2026-09-26-asset-provenance-index.json');

// ---------------------------------------------------------------------------
// 已知"链断点"登记（2026-09-26 盘点；每条都给找回锚点，运行时复核）
// 断点来源：commit ebf8e59（p5-2 创作块清出主仓，能力留 s1）与 2041757
// （p5 夹具/工具边清理）。s1 仓 /Users/xia/program/dsh/DshCockpit-s1 为只读
// 参照，本 CLI 绝不写它。
// ---------------------------------------------------------------------------
const LOST_TOOLS = [
  {
    tool: 'scripts/gen-img.js',
    role: '生成（生图 API 调用：gpt-image-2，key 仅从 env/ ~/.dsh-secrets.env 读入，绝不打印）',
    affected: ['expressions/*', 'walk/*（一代帧）'],
    deletedIn: 'ebf8e59',
    recoverFrom: ['git show 44ed956:scripts/gen-img.js', '/Users/xia/program/dsh/DshCockpit-s1/scripts/gen-img.js（只读）'],
  },
  {
    tool: 'scripts/gen-frames.js',
    role: '生成（M3 缺口再生成流水线：参考图压缩 → /images/edits → 网格切片 → 去白底 → 归一化预校验）',
    affected: ['walk/{down,left,right,up}（二代 b 系列，2026-09-21）'],
    deletedIn: 'ebf8e59',
    recoverFrom: ['git show 44ed956:scripts/gen-frames.js', '/Users/xia/program/dsh/DshCockpit-s1/scripts/gen-frames.js（只读）'],
  },
  {
    tool: 'scripts/gen-props.js',
    role: '生成（根目录环境道具 prop-*.png 的生成器）',
    affected: ['resources/office/prop-*.png（除 flat/ 与 layout-editor/ 外的根目录道具）'],
    deletedIn: 'ebf8e59',
    recoverFrom: ['git show 44ed956:scripts/gen-props.js', '/Users/xia/program/dsh/DshCockpit-s1/scripts/gen-props.js（只读）'],
  },
  {
    tool: 'scripts/apply-walk-sequence.js',
    role: '拼装（M3/E5a 行走序列拼装：passing/C 系卡片帧的输入映射）',
    affected: ['anchors-only 的一代行走帧（若重新启用）'],
    deletedIn: 'ebf8e59',
    recoverFrom: ['git show 44ed956:scripts/apply-walk-sequence.js', '/Users/xia/program/dsh/DshCockpit-s1/scripts/apply-walk-sequence.js（只读）'],
  },
  {
    tool: 'src/workbench/lib/action-publisher.js',
    role: '发布（publishAction：全仓唯一允许写生产字节的路径；写 provenance 台账 + backup）',
    affected: ['content → pack 的发布同步（全部动作）'],
    deletedIn: '2041757',
    recoverFrom: ['git show 2041757^:src/workbench/lib/action-publisher.js', '/Users/xia/program/dsh/DshCockpit-s1/src/workbench/lib/（只读）'],
  },
  {
    tool: 'scripts/office-assets/validate-character-pack.js',
    role: '验收（历史位置；现役版本在 src/office/runtime/validate-character-pack.js，仍可用）',
    affected: [],
    deletedIn: '(历史搬迁)',
    recoverFrom: ['git show 44ed956:scripts/office-assets/validate-character-pack.js'],
    note: '非丢失：校验能力仍在，只是换了位置',
  },
];

/** git cat-file -e 复核"能否从历史找回"——结果写进产出，不凭记忆断言。 */
function gitObjectExists(spec) {
  try {
    execFileSync('git', ['-C', ROOT, 'cat-file', '-e', spec, '--'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function statFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { exists: false };
    return { exists: true, bytes: st.size, sha256: sha256File(file) };
  } catch {
    return { exists: false };
  }
}

function packAnimations() {
  return readJson(path.join(PACK_ROOT, 'animation', 'animations.json')).animations;
}

function packAnchors() {
  return readJson(path.join(PACK_ROOT, 'animation', 'anchors.json'));
}

function contentProvenanceEntries(actionId) {
  const dir = path.join(CONTENT_ROOT, 'provenance');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const entry = readJson(path.join(dir, name));
      if (actionId && entry.actionId !== actionId) continue;
      const backupAbsolute = entry.backupDir && path.isAbsolute(entry.backupDir) ? entry.backupDir : null;
      // backupDirRelative 是相对 content/（发布内核的账本基约定）
      const backupInRepo = entry.backupDirRelative ? path.join(ROOT, 'content', entry.backupDirRelative) : null;
      const dirHasFiles = (dir) => {
        try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0; } catch { return false; }
      };
      const backupExistsInRepo = !!(backupInRepo && dirHasFiles(backupInRepo));
      // 台账是 s1 时代写的：backupDir 记的是当时的绝对路径（常在 s1 仓内）。
      // 本仓只读不写 s1；这里仅核对"记录的备份现在是否真的可达"。
      const backupExistsAtRecordedPath = backupExistsInRepo || !!(backupAbsolute && dirHasFiles(backupAbsolute));
      out.push({
        entry: `content/characters/whale-girl/provenance/${name}`,
        publishedAt: entry.publishedAt,
        summary: entry.summary,
        changes: entry.changes || [],
        frames: entry.frames || [],
        filesRewritten: entry.files ? entry.files.rewritten : [],
        backupDir: entry.backupDirRelative || entry.backupDir || null,
        backupDirPointsOutsideRepo: !!(backupAbsolute && !backupAbsolute.startsWith(ROOT + path.sep)),
        backupExistsInRepo,
        backupExistsAtRecordedPath,
      });
    } catch { /* unreadable ledger entry: skip, verify() reports ledger health separately */ }
  }
  return out.sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
}

/** 生成链工具的在盘/历史可找回性（结果 = 事实核查，不是登记表复读）。 */
function toolChainStatus(relPathFromRoot) {
  const onDisk = fs.existsSync(path.join(ROOT, relPathFromRoot));
  if (onDisk) return { status: 'traceable', location: relPathFromRoot };
  const gitVerified = LOST_TOOLS.some((t) => t.tool === relPathFromRoot)
    ? gitObjectExists(`44ed956:${relPathFromRoot}`) || gitObjectExists(`2041757^:${relPathFromRoot}`)
    : gitObjectExists(`44ed956:${relPathFromRoot}`);
  if (gitVerified) return { status: 'traceable-in-history', location: relPathFromRoot, note: '主仓已删（P5-2 创作块清出，能力留 s1）；git 历史复核可找回' };
  return { status: 'lost', location: relPathFromRoot, note: '主仓与 git 历史复核均未找到' };
}

// ---------------------------------------------------------------------------
// 角色动作（resources/characters/deepseek-default）
// ---------------------------------------------------------------------------
function reportAction(actionId, animations, anchors) {
  const entry = animations[actionId];
  if (!entry) return null;

  const frames = (entry.frames || []).map((f) => {
    const file = path.join(PACK_ROOT, f.file);
    const st = statFile(file);
    const anchorEntry = anchors.frames ? anchors.frames[f.file] : null;
    return {
      file: `resources/characters/deepseek-default/${f.file}`,
      durationMs: f.durationMs,
      bytes: st.bytes,
      sha256: st.exists ? st.sha256 : null,
      exists: st.exists,
      anchor: anchorEntry ? anchorEntry.outputAnchor : null,
    };
  });

  // content 编辑源（上游）：actions/<id>.json 是否在、与 pack 是否一致
  const actionDocPath = path.join(CONTENT_ROOT, 'actions', `${actionId}.json`);
  let content = { actionDoc: `content/characters/whale-girl/actions/${actionId}.json`, exists: false };
  if (fs.existsSync(actionDocPath)) {
    try {
      const doc = readJson(actionDocPath);
      const docFrames = (doc.frames || []).map((f) => f.file);
      const packFrames = (entry.frames || []).map((f) => f.file);
      const drift = [];
      if (docFrames.length !== packFrames.length) drift.push(`frame count ${docFrames.length} (content) vs ${packFrames.length} (pack)`);
      for (let i = 0; i < Math.min(docFrames.length, packFrames.length); i += 1) {
        if (docFrames[i] !== packFrames[i]) drift.push(`frame[${i}] ${docFrames[i]} (content) vs ${packFrames[i]} (pack)`);
        else {
          const docDur = (doc.frames[i] || {}).durationMs;
          const packDur = (entry.frames[i] || {}).durationMs;
          if (String(docDur) !== String(packDur)) drift.push(`durationMs[${i}] ${docDur} (content) vs ${packDur} (pack)`);
        }
      }
      // 逐字节镜像比对（content PNG ↔ pack 同名副本）。content 树把帧嵌在
      // assets/assets/…（resolveFramePath 相对 content 的 assets/ 解析），两个
      // 位置都探测。
      const mirror = docFrames.map((rel) => {
        const candidates = [path.join(CONTENT_ROOT, rel), path.join(CONTENT_ROOT, 'assets', rel)];
        const contentFile = candidates.find((p) => fs.existsSync(p));
        const packFile = path.join(PACK_ROOT, rel);
        if (!contentFile) return { file: rel, present: false, identical: null };
        if (!fs.existsSync(packFile)) return { file: rel, present: true, identical: false, note: 'pack side missing' };
        const identical = sha256File(contentFile) === sha256File(packFile);
        return { file: rel, present: true, identical, contentPath: path.relative(CONTENT_ROOT, contentFile) };
      });
      content = {
        actionDoc: `content/characters/whale-girl/actions/${actionId}.json`,
        exists: true,
        loop: !!doc.loop,
        direction: doc.direction || null,
        frameCount: docFrames.length,
        matchesPack: drift.length === 0,
        drift,
        mirrorIdenticalCount: mirror.filter((m) => m.identical === true).length,
        mirror,
      };
    } catch (e) {
      content = { actionDoc: `content/characters/whale-girl/actions/${actionId}.json`, exists: true, parseError: e.message };
    }
  }

  const ledger = contentProvenanceEntries(actionId);
  const durations = frames.map((f) => f.durationMs).filter((d) => d !== null && d !== undefined);
  const genTool = toolChainStatus('scripts/gen-frames.js');
  const genImgTool = toolChainStatus('scripts/gen-img.js');
  const cutoutTool = toolChainStatus('scripts/remove-bg.py');
  const normalizeTool = toolChainStatus('scripts/office-assets/normalize-character.py');
  const publishTool = toolChainStatus('src/workbench/lib/action-publisher.js');
  const validatorTool = toolChainStatus('src/office/runtime/validate-character-pack.js');

  return {
    id: actionId,
    kind: 'character-action',
    pack: 'resources/characters/deepseek-default',
    runtimeAuthority: 'animation/animations.json（帧/时序唯一权威）+ animation/anchors.json（几何唯一权威）',
    howToVerifyRunningCopy: [
      '运行时经 office-protocol 的 characters/ 路由从 resources/characters（打包后为 process.resourcesPath）读取本包；',
      '把部署目录中下列帧文件的 sha256 与本报告逐条比对，全等即"跑的就是这一份"；',
      '修改任何帧必须经 publish 流程（重写 animations.json + anchors.json 键序 + provenance 台账），',
      '本报告的 content.mirror 与 provenance 段会暴露绕过发布链的手改。',
    ],
    animation: {
      loop: !!entry.loop,
      direction: entry.direction || null,
      frameCount: frames.length,
      durationMsPerFrame: durations.length ? [...new Set(durations)] : null,
      perCycleMs: durations.length ? durations.reduce((a, b) => a + (b || 0), 0) : null,
      frames,
    },
    content,
    provenance: ledger,
    chain: [
      {
        step: '1 生成',
        tool: 'gen-img.js / gen-frames.js（生图 API；key 仅从 env 读入，绝不打印）',
        status: genImgTool.status === 'traceable' || genTool.status === 'traceable' ? 'traceable'
          : (genImgTool.status === 'traceable-in-history' || genTool.status === 'traceable-in-history') ? 'traceable-in-history' : 'lost',
        evidence: 'usage 记录于脚本头部注释；M3 b 系列再生成流水线见 gen-frames.js 头注',
        gap: '逐资产的单次生成调用参数（--action/--grid/--ref/--start-index/prompt）未随资产记录——仓库无逐资产参数台账',
      },
      {
        step: '2 抠像',
        tool: 'scripts/remove-bg.py（去白底/背景）',
        status: cutoutTool.status,
        evidence: cutoutTool.status === 'traceable' ? '脚本在盘，参数在脚本常量' : cutoutTool.note,
      },
      {
        step: '3 归一化',
        tool: 'scripts/office-assets/normalize-character.py（SPEC-02：统一画布/脚锚点/平移对齐，常量在脚本头）',
        status: normalizeTool.status,
        evidence: normalizeTool.status === 'traceable' ? '整包归一化器；逐帧几何由 anchors.json 记录（权威）' : normalizeTool.note,
      },
      {
        step: '4 发布',
        tool: 'src/workbench/lib/action-publisher.js publishAction（唯一写生产字节路径；写 provenance 台账）',
        status: publishTool.status,
        evidence: ledger.length
          ? `provenance 台账 ${ledger.length} 条（最新 ${ledger[ledger.length - 1].publishedAt}）；backup 在 repo: ${ledger[ledger.length - 1].backupExistsInRepo}`
          : '该动作无 provenance 台账条目——早于 M1 发布内核或从未经 publish 改写（原始归一化产物直接在盘）',
        gap: publishTool.status !== 'traceable' ? '发布内核主仓已删；重发布前需先找回（见 lost 子命令）' : null,
      },
      {
        step: '5 校验',
        tool: 'src/office/runtime/validate-character-pack.js + 本 CLI verify',
        status: validatorTool.status,
        evidence: 'fail-closed 校验（帧存在性/几何/安全约束）；sha256 镜像比对见本报告 verify 段',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 办公室贴图（resources/office，经 src/office/layout-assets.js 目录表）
// ---------------------------------------------------------------------------
function sceneAssetIds() {
  if (sceneAssetIds.cache) return sceneAssetIds.cache;
  const ids = new Set();
  const sceneLayout = path.join(ROOT, 'content', 'scenes', 'flat', 'layout.json');
  try {
    for (const item of readJson(sceneLayout).items || []) if (item.asset) ids.add(item.asset);
  } catch { /* scene draft absent */ }
  for (const fixture of ['src/office/fixtures/office-layout-flat.json', 'src/office/fixtures/office-layout.json']) {
    try {
      for (const furniture of readJson(path.join(ROOT, fixture)).furniture || []) if (furniture.assetId) ids.add(furniture.assetId);
    } catch { /* fixture absent */ }
  }
  sceneAssetIds.cache = ids;
  return ids;
}

/** office-protocol 路由规则（src/office/office-protocol.js）：office-assets/ →
 * resources/office，characters/ → resources/characters。返回磁盘位置与路由位置。 */
function resolveCatalogSrc(src) {
  const rel = src.replace(/^\.\//, '');
  if (rel.startsWith('characters/')) {
    const tail = rel.slice('characters/'.length);
    return { root: CHARACTERS_ROOT, rel: tail, diskPath: `resources/characters/${tail}`, routePath: rel };
  }
  if (rel.startsWith('office-assets/')) {
    const tail = rel.slice('office-assets/'.length);
    return { root: OFFICE_ROOT, rel: tail, diskPath: `resources/office/${tail}`, routePath: rel };
  }
  return { root: OFFICE_ROOT, rel, diskPath: `resources/office/${rel}`, routePath: `office-assets/${rel}` };
}

function reportOfficeAsset(asset, archived) {
  const route = resolveCatalogSrc(asset.src);
  const relSrc = route.rel;
  const file = path.join(route.root, relSrc);
  const st = statFile(file);
  const inScene = sceneAssetIds().has(asset.id);
  const isCharacter = route.root === CHARACTERS_ROOT;
  const isRootEnvProp = !isCharacter && relSrc.startsWith('prop-') && !relSrc.includes('/');
  const genStatus = isCharacter
    ? { status: 'not-recorded', note: '编辑器起草用角色图 = 生产包在播帧（经 characters/ 路由），来源链跟随对应动作（report <action-id>）' }
    : isRootEnvProp
      ? toolChainStatus('scripts/gen-props.js')
      : { status: 'not-recorded', note: '无生成脚本记录：flat/ 平面贴图与 layout-editor/ 等轴贴图的来源（作者/生成参数/批次）未入台账；目录表只记录了批次标签（v6–v11）与实测 contentBbox' };

  return {
    id: asset.id,
    kind: 'office-texture',
    label: asset.label,
    direction: asset.direction,
    archived: !!archived,
    publishedTo: route.diskPath,
    servedAs: route.routePath,
    runtimeAuthority: 'src/office/layout-assets.js（LAYOUT_ASSETS / ARCHIVED_LAYOUT_ASSETS 目录表 = 唯一权威）',
    howToVerifyRunningCopy: [
      '运行时经 office-protocol（office-assets/ → resources/office，characters/ → resources/characters，打包后为 process.resourcesPath）读取；',
      '把部署目录中该 PNG 的 sha256 与本报告比对；catalog 断言测试（test/office-asset-runtime.test.js）钉住目录表与在盘文件一一对应。',
    ],
    file: { path: route.diskPath, exists: st.exists, bytes: st.bytes, sha256: st.sha256 },
    contentBbox: asset.contentBbox || null,
    scenePlacement: { placedInCurrentScene: inScene, note: archived ? 'ARCHIVED：编辑器货架退出，仅 layoutAssetById 兜底（等轴回退）' : undefined },
    chain: [
      {
        step: '1 生成',
        tool: isCharacter ? '（跟随角色包动作链）' : isRootEnvProp ? 'scripts/gen-props.js（环境道具生成器）' : '未记录（无生成脚本）',
        status: genStatus.status,
        evidence: genStatus.note || '生成器在盘（或 git 历史可找回），但逐资产的调用参数未随资产记录',
        gap: genStatus.status === 'not-recorded' && !isCharacter ? '来源无法回溯：作者/提示词/参数/原图都不在仓库——这是素材复现链的真实断点' : null,
      },
      {
        step: '2 发布/登记',
        tool: 'src/office/layout-assets.js 目录表（手工登记 + contentBbox 实测）',
        status: 'traceable',
        evidence: 'catalog 条目（含 label/kind/direction/contentBbox）；catalog 测试锁 ±0.002 防漂移',
      },
      {
        step: '3 校验',
        tool: '本 CLI verify（存在性 + sha256 + 在用引用完整性）',
        status: 'traceable',
        evidence: st.exists ? `在盘 ${st.bytes} B` : '文件缺失（反向缺口！）',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 全量校验 / 索引
// ---------------------------------------------------------------------------
function verifyAll(animations, anchors, layoutAssets, archivedAssets) {
  const { validateCharacterPack } = require(path.join(ROOT, 'src', 'office', 'runtime', 'validate-character-pack.js'));
  const validator = validateCharacterPack(PACK_ROOT);
  const report = { validatedAt: new Date().toISOString(), pack: 'resources/characters/deepseek-default', validator, actions: {}, office: {}, gaps: [] };

  // 反向缺口：anchors 引用 vs 磁盘
  const missingAnchors = Object.keys(anchors.frames || {}).filter((rel) => !fs.existsSync(path.join(PACK_ROOT, rel)));
  if (missingAnchors.length) report.gaps.push({ kind: 'anchors-missing-on-disk', files: missingAnchors });

  // 反向缺口：animations 帧引用 vs 磁盘
  const missingFrames = Object.values(animations).flatMap((e) => (e.frames || []).map((f) => f.file))
    .filter((rel) => !fs.existsSync(path.join(PACK_ROOT, rel)));
  if (missingFrames.length) report.gaps.push({ kind: 'frames-missing-on-disk', files: missingFrames });

  // 反向缺口：catalog 资产 vs 磁盘（office-protocol 同规则路由）
  for (const [asset] of [...layoutAssets.map((a) => [a, false]), ...archivedAssets.map((a) => [a, true])]) {
    const route = resolveCatalogSrc(asset.src);
    if (!fs.existsSync(path.join(route.root, route.rel))) report.gaps.push({ kind: 'office-texture-missing-on-disk', id: asset.id, file: route.diskPath });
  }

  // content ↔ pack 镜像（存在 content action doc 的动作）
  for (const actionId of Object.keys(animations)) {
    const docPath = path.join(CONTENT_ROOT, 'actions', `${actionId}.json`);
    if (!fs.existsSync(docPath)) continue;
    const doc = readJson(docPath);
    const diff = (doc.frames || []).filter((f) => {
      const packFile = path.join(PACK_ROOT, f.file);
      const contentFile = path.join(CONTENT_ROOT, f.file);
      return fs.existsSync(contentFile) && fs.existsSync(packFile) && sha256File(contentFile) !== sha256File(packFile);
    }).map((f) => f.file);
    report.actions[actionId] = { mirrorIdentical: diff.length === 0, differingFiles: diff };
  }

  // 台账健康：backup 目录可达性
  const ledgerAll = contentProvenanceEntries(null);
  report.provenanceLedger = {
    entries: ledgerAll.length,
    backupMissingAtRecordedPath: ledgerAll.filter((e) => !e.backupExistsAtRecordedPath).map((e) => ({ entry: e.entry, backupDir: e.backupDir, pointsOutsideRepo: e.backupDirPointsOutsideRepo })),
  };
  report.ok = validator.ok && report.gaps.length === 0
    && Object.values(report.actions).every((a) => a.mirrorIdentical);
  return report;
}

function buildIndex() {
  const animations = packAnimations();
  const anchors = packAnchors();
  const { LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS } = require(path.join(ROOT, 'src', 'office', 'layout-assets.js'));
  const entries = [];
  for (const actionId of Object.keys(animations).sort()) entries.push(reportAction(actionId, animations, anchors));
  for (const asset of LAYOUT_ASSETS) entries.push(reportOfficeAsset(asset, false));
  for (const asset of ARCHIVED_LAYOUT_ASSETS) entries.push(reportOfficeAsset(asset, true));
  const lost = entries.flatMap((e) => e.chain
    .filter((step) => step.status === 'lost' || step.status === 'not-recorded' || step.status === 'traceable-in-history')
    .map((step) => ({ id: e.id, kind: e.kind, step: step.step, tool: step.tool, status: step.status, gap: step.gap || step.note || null })));
  return {
    schemaVersion: 1,
    kind: 'asset-provenance-index',
    generatedAt: new Date().toISOString(),
    repo: 'DshCockpit（主仓）',
    divisionOfLabor: '在用清单/孤儿判定见 docs/strategy/2026-09-22-assets-in-use.md；本索引只记录来源链与校验方法，不重复在用判定',
    counts: {
      characterActions: entries.filter((e) => e.kind === 'character-action').length,
      officeTexturesActive: entries.filter((e) => e.kind === 'office-texture' && !e.archived).length,
      officeTexturesArchived: entries.filter((e) => e.kind === 'office-texture' && e.archived).length,
    },
    lostChainSummary: lost,
    entries,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function findEntry(id, animations, layoutAssets, archivedAssets) {
  if (animations[id]) return reportAction(id, animations, packAnchors());
  const active = layoutAssets.find((a) => a.id === id);
  if (active) return reportOfficeAsset(active, false);
  const archived = archivedAssets.find((a) => a.id === id);
  if (archived) return reportOfficeAsset(archived, true);
  return null;
}

function main(argv) {
  const [cmd, arg] = argv;
  const { LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS } = require(path.join(ROOT, 'src', 'office', 'layout-assets.js'));
  const animations = packAnimations();

  if (cmd === 'report') {
    if (!arg) { console.error('usage: report <id>'); process.exit(2); }
    const entry = findEntry(arg, animations, LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS);
    if (!entry) {
      const known = [...Object.keys(animations), ...LAYOUT_ASSETS.map((a) => a.id), ...ARCHIVED_LAYOUT_ASSETS.map((a) => a.id)];
      console.error(`unknown id: ${arg}\nknown ids: ${known.sort().join(', ')}`);
      process.exit(2);
    }
    console.log(JSON.stringify(entry, null, 2));
    return 0;
  }

  if (cmd === 'verify') {
    const report = verifyAll(animations, packAnchors(), LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS);
    if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
    console.log(`pack validator: ${report.validator.ok ? 'ok' : `FAILED (${report.validator.errors.length} errors)`}`);
    for (const err of report.validator.errors || []) console.log(`  - ${err.code}: ${err.message}`);
    console.log(`gaps: ${report.gaps.length}`);
    for (const g of report.gaps) console.log(`  - ${g.kind}: ${JSON.stringify(g.files || g.file || g.id)}`);
    const drift = Object.entries(report.actions).filter(([, a]) => !a.mirrorIdentical);
    console.log(`content↔pack 镜像: ${Object.keys(report.actions).length} 个动作可比对，${drift.length} 个不一致`);
    for (const [id, a] of drift) console.log(`  - ${id}: ${a.differingFiles.join(', ')}`);
    const missingBackup = report.provenanceLedger.backupMissingAtRecordedPath;
    console.log(`provenance 台账: ${report.provenanceLedger.entries} 条，backup 不可达 ${missingBackup.length} 条`);
    for (const m of missingBackup) console.log(`  - ${m.entry} → ${m.backupDir}${m.pointsOutsideRepo ? '（指向仓外——s1 时代记录）' : ''}`);
    console.log(report.ok ? 'OK' : 'FAILED');
    return report.ok ? 0 : 1;
  }

  if (cmd === 'index') {
    const index = buildIndex();
    const outArg = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
    const out = outArg || INDEX_OUT;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(index, null, 2));
    console.log(`index written: ${out}`);
    console.log(`  character actions: ${index.counts.characterActions}`);
    console.log(`  office textures (active/archived): ${index.counts.officeTexturesActive}/${index.counts.officeTexturesArchived}`);
    console.log(`  chain gaps recorded: ${index.lostChainSummary.length}`);
    return 0;
  }

  if (cmd === 'lost') {
    console.log('已知链断点（登记 + 运行时复核）：\n');
    for (const t of LOST_TOOLS) {
      const recoverable = t.deletedIn.startsWith('(') ? null : gitObjectExists(`44ed956:${t.tool}`) || gitObjectExists(`2041757^:${t.tool}`);
      console.log(`- ${t.tool}`);
      console.log(`    角色: ${t.role}`);
      console.log(`    影响面: ${t.affected.join(', ') || '—'}`);
      console.log(`    丢失点: ${t.deletedIn}${recoverable === null ? '' : recoverable ? '（git 历史复核：可找回）' : '（git 历史复核：不可找回）'}`);
      for (const r of t.recoverFrom) console.log(`    找回: ${r}`);
      if (t.note) console.log(`    备注: ${t.note}`);
    }
    // 运行时再列一遍资产级断点（not-recorded / lost）
    const index = buildIndex();
    console.log(`\n资产级断点（${index.lostChainSummary.length} 条，详见 index）：`);
    const seen = new Set();
    for (const l of index.lostChainSummary) {
      const key = `${l.step}|${l.tool}|${l.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  - [${l.status}] ${l.step} ${l.tool} — 例: ${l.id}${l.gap ? `（${l.gap}）` : ''}`);
    }
    return 0;
  }

  console.error('usage: asset-provenance.js <report <id> | verify [--json] | index [--out <file>] | lost>');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  LOST_TOOLS,
  sha256File,
  statFile,
  readJson,
  contentProvenanceEntries,
  toolChainStatus,
  reportAction,
  reportOfficeAsset,
  verifyAll,
  buildIndex,
  findEntry,
  ROOT,
  PACK_ROOT,
  CONTENT_ROOT,
  OFFICE_ROOT,
};
