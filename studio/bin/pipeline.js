#!/usr/bin/env node
'use strict';

// studio/bin/pipeline.js — the pipeline CLI (S0…S8, QC, cache, providers).
//
//   node studio/bin/pipeline.js qc frames --dir <dir> [--foot 296] [--json]
//   node studio/bin/pipeline.js qc video <file> [--expect-fps 24] [--json]
//   node studio/bin/pipeline.js check <actionId> [--json]        动作帧 QC（走项目路径）
//   node studio/bin/pipeline.js plan <asset|action> [--force] [--only S4,S5] [--dir <delivery>]
//   node studio/bin/pipeline.js run  <asset|action> [--plan] [--force] [--only S4,S5] [--dir <delivery>]
//   node studio/bin/pipeline.js triage list [--action <id>] [--status open|resolved] [--json]
//   node studio/bin/pipeline.js triage show <id> [--json]
//   node studio/bin/pipeline.js triage resolve <id> --note "改了什么" [--by <who>]
//   node studio/bin/pipeline.js matte <png> [--out <png>]         单帧抠像后处理
//   node studio/bin/pipeline.js encode --frames <dir> --out <webm>
//   node studio/bin/pipeline.js cache [stats|list|clear [--stage S4]]
//   node studio/bin/pipeline.js providers                         模型↔密钥与指纹（永不打印密钥）
//
// The generation loop (R4) is `plan`/`run`: intake → QC → triage → normalize → pack,
// content-addressed (改一步只重跑那一段) and ledgered (.params.json). The contract
// lives in studio/docs/generation-loop.md.
//
// Exit codes: 0 ok · 1 blocked/failed · 2 usage.

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');

const qcFramesLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'qc-frames.js'));
const qcVideoLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'qc-video.js'));
const mattingLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'matting.js'));
const { createCache } = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'cache.js'));
const { runPipeline, resolvePlan, stageParamsFor, stageReproduceCommand, inputPathsForRecord, outputPathsForRecord } = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'orchestrate.js'));
const stagesLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'stages.js'));
const intakeLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'intake.js'));
const triageLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'triage.js'));
const paramsLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'params.js'));
const providers = require(path.join(STUDIO_ROOT, 'lib', 'providers.js'));
const { DEFAULT_CHARACTER_ID } = require(path.join(STUDIO_ROOT, 'lib', 'provenance.js'));

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
  pipeline qc frames --dir <dir> [--foot 296] [--json]
  pipeline qc video <file> [--expect-fps 24] [--json]
  pipeline check <actionId> [--json]
  pipeline plan <asset|action> [--force] [--only S4,S5] [--dir <delivery>] [--params <json>]
  pipeline run  <asset|action> [--plan] [--force] [--only S4,S5] [--dir <delivery>]
        [--params <json>] [--max-retries N] [--reference <png>] [--allow-network]
        [--no-publish] [--record-params|--no-record-params] [--agent <id>] [--json]
  pipeline triage list [--action <id>] [--status open|resolved] [--json]
  pipeline triage show <id> [--json]
  pipeline triage resolve <id> --note "改了什么" [--by <who>]
  pipeline matte <png> [--out <png>]
  pipeline encode --frames <dir> --out <webm>
  pipeline cache [stats|list|clear [--stage S4]]
  pipeline providers`;

function framesInDir(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.png')).sort()
    .map((name) => ({ file: name, abs: path.join(dir, name) }));
}

function printFindings(findings, limit = 40, { quiet = false, out = console.log } = {}) {
  if (quiet) return;
  const mark = { red: '✗', yellow: '!' };
  for (const finding of findings.slice(0, limit)) {
    const where = finding.file ? ` ${String(finding.file).split('/').pop()}` : '';
    out(`  ${mark[finding.severity] || '·'} [${finding.severity}] ${finding.code}${where} — ${finding.message}`);
    if (finding.fix) out(`      ↳ ${finding.fix}`);
  }
  if (findings.length > limit) out(`  … ${findings.length - limit} more`);
}

// ---------------------------------------------------------------------------
// the generation loop: intake → stages → triage → ledger
// ---------------------------------------------------------------------------

// The same overrides bin/agent.js honours: point them at a COPY of the tree to
// rehearse a run (and to keep the ledger writes inside the sandbox).
function resolveTrees() {
  const contentDir = process.env.STUDIO_CONTENT_DIR || path.join(REPO_ROOT, 'content');
  const charactersRoot = process.env.STUDIO_CHARACTERS_ROOT || path.join(REPO_ROOT, 'resources', 'characters');
  const repoRoot = process.env.STUDIO_CONTENT_DIR ? path.dirname(path.resolve(contentDir)) : REPO_ROOT;
  return { contentDir: path.resolve(contentDir), charactersRoot: path.resolve(charactersRoot), repoRoot };
}

function stageList(flags, { hasReference }) {
  if (flags.only || flags.stages) {
    return String(flags.only || flags.stages).split(',').map((id) => id.trim().toUpperCase()).filter(Boolean);
  }
  // S1–S3 are the MODEL stages (the handoff path: the user's agent generates, we
  // receive); S7 is opt-in. The default chain is the local one the workbench owns,
  // ending in the pack step (S8) unless --no-publish stops at the normalized frames.
  const local = ['S4', 'S5', 'S6'];
  return [
    ...(hasReference ? ['S0'] : []),
    ...local,
    ...(flags['no-publish'] === true ? [] : ['S8']),
  ];
}

/**
 * 接收 (intake): the delivery door. Strict on naming/type/size/dimensions — the
 * hardened shape from "harden the intake door against hostile delivery names",
 * now a shared library (lib/pipeline/intake.js). Refusals become triage entries
 * and stop the chain; an accepted delivery of PNG frames becomes the chain's
 * input material.
 */
function runIntake({ actionId, dir, flags, trees, queue, asJson }) {
  const report = intakeLib.checkDelivery({ dir });
  const lines = [];
  const refused = report.refused || [];
  if (!report.ok && report.code) {
    return { ok: false, lines: [`接收：${report.code} ${report.message || report.dir}`], report, fatal: true };
  }
  lines.push(`接收：${report.dir} · ${report.entries.length} 个文件通过 · ${refused.length} 个被拒`);
  for (const entry of report.entries) {
    const dims = entry.width ? ` ${entry.width}×${entry.height}` : '';
    const extra = entry.kind === 'video' ? ` ${entry.fps}fps ${entry.durationSec}s` : '';
    lines.push(`  ✓ ${entry.name} (${entry.kind}${dims}${extra}, ${(entry.bytes / 1024).toFixed(0)} KiB)`);
  }
  for (const refusal of refused) {
    lines.push(`  ✗ ${refusal.name}: ${refusal.code} — ${refusal.message}`);
    if (refusal.fix) lines.push(`      ↳ ${refusal.fix}`);
    if (queue) {
      const opened = queue.open({
        stage: 'intake',
        code: refusal.code,
        severity: 'red',
        findings: refusal.findings || [{ severity: 'red', code: refusal.code, message: refusal.message, fix: refusal.fix }],
        attempts: 1,
        maxRetries: 0,
        needsHuman: true,
        reason: refusal.message,
        fix: refusal.fix || 'fix the delivery and hand it over again',
      });
      if (opened.ok) lines.push(`      ↳ 已挂人工分诊：${opened.entry.id}`);
    }
  }
  // the accepted frames become the chain's input material (a frame delivery IS
  // the new take for this action); a video delivery stays a gate — turning it
  // into frames is the generating agent's job (R5 handoff)
  const deliveredFrames = report.entries.filter((entry) => entry.kind === 'image');
  const deliveredVideos = report.entries.filter((entry) => entry.kind === 'video');
  const intakeRecord = path.join(trees.contentDir, 'build', 'intake', `${actionId}.json`);
  try {
    fs.mkdirSync(path.dirname(intakeRecord), { recursive: true });
    fs.writeFileSync(intakeRecord, `${JSON.stringify({ ...report, actionId, at: report.at }, null, 2)}\n`);
    lines.push(`  接收记录：${path.relative(trees.repoRoot, intakeRecord)}`);
  } catch { /* a read-only tree still runs the gate */ }
  if (deliveredVideos.length && !deliveredFrames.length) {
    lines.push('  视频交付只过门禁（绿幕分析见 bin/agent.js intake）；抽帧归生成方，链上段按该动作当前帧继续。');
  }
  return { ok: refused.length === 0, lines, report, frames: deliveredFrames, videos: deliveredVideos };
}

/** Record one ledger call; never throws, never writes a secret. */
function ledgerCall({ trees, actionId, call, enabled }) {
  if (!enabled) return { skipped: 'record-params off' };
  const outcome = paramsLib.recordCall({
    repoRoot: trees.repoRoot,
    characterId: DEFAULT_CHARACTER_ID,
    actionId,
    call,
  });
  if (!outcome.ok) {
    return { refused: true, code: outcome.code || 'LEDGER_REFUSED', error: outcome.error, fingerprints: outcome.fingerprints || [] };
  }
  return { skipped: Boolean(outcome.skipped), file: outcome.file };
}

function commandRun(positional, flags, { planOnly }) {
  // `run <asset|action>` is the new form; `--action <id>` stays accepted (the
  // pre-R4 invocation) so older commands and docs keep working.
  const actionId = positional[1] || (typeof flags.action === 'string' ? flags.action : null);
  if (!actionId) { console.error(USAGE); return 2; }
  const trees = resolveTrees();
  const { createStudioServices } = require(path.join(STUDIO_ROOT, 'lib', 'studio-services.js'));
  const studio = createStudioServices({ repoRoot: trees.repoRoot, contentDir: trees.contentDir, charactersRoot: trees.charactersRoot });
  const bench = studio.actionBench(actionId);
  if (!bench.ok) {
    console.error(`${bench.code}: ${bench.message}`);
    console.error('（生成链按动作跑；office 目录资产没有流水线——它们的来源链见 provenance report <assetId>）');
    return 1;
  }

  const asJson = flags.json === true;
  const lines = [];
  const say = (line) => { if (!asJson) lines.push(line); };

  // ---- 1. 接收 -------------------------------------------------------------
  const deliveryDir = flags.dir
    ? path.resolve(String(flags.dir))
    : (fs.existsSync(path.join(trees.contentDir, 'incoming', actionId)) ? path.join(trees.contentDir, 'incoming', actionId) : null);
  let deliveredFrames = [];
  if (deliveryDir) {
    const queue = triageLib.createTriageQueue({ contentDir: trees.contentDir, actionId });
    const intake = runIntake({ actionId, dir: deliveryDir, flags, trees, queue, asJson });
    lines.push(...intake.lines);
    if (!intake.ok) {
      console.log(lines.join('\n'));
      console.error(`接收被拒：${actionId} 的交付物没有过门禁（分诊队列已更新：${queue.file}）`);
      return 1;
    }
    deliveredFrames = intake.frames || [];
    const recorded = ledgerCall({
      trees, actionId, enabled: recordParamsEnabled(flags),
      call: {
        kind: deliveredFrames.length ? 'frame-sheet' : 'video',
        tool: 'studio/bin/pipeline.js run (intake)',
        command: ['node', 'studio/bin/pipeline.js', 'run', actionId, ...(flags.dir ? ['--dir', String(flags.dir)] : [])].join(' '),
        agent: flags.agent,
        model: flags.model ? String(flags.model) : null,
        prompt: flags['prompt-file'] ? fs.readFileSync(String(flags['prompt-file']), 'utf8') : (flags.prompt ? String(flags.prompt) : null),
        seed: flags.seed === undefined ? null : Number(flags.seed),
        params: { delivery: path.relative(trees.repoRoot, deliveryDir), files: (intake.report.entries || []).map((entry) => entry.name) },
        inputs: (intake.report.entries || []).map((entry) => ({ path: entry.abs, role: entry.kind === 'video' ? paramsLib.ROLES.SOURCE_VIDEO : paramsLib.ROLES.SOURCE_FRAMES })),
        outputs: [],
        note: 'delivery accepted at the pipeline door',
      },
    });
    if (recorded.refused) {
      console.error(`参数入账被拒（${recorded.code}）：${recorded.error}`);
      return 1;
    }
    say(`  参数入账：${recorded.skipped === true ? '同一交付已入账（内容寻址去重）' : (recorded.skipped === 'record-params off' ? '已跳过（真实树默认只读；--record-params 落账）' : path.relative(trees.repoRoot, recorded.file))}`);
  } else {
    say('接收：无交付目录（--dir 或 content/incoming/<action>/ 不存在），直接进入链上段');
  }

  // ---- 2. the stage chain --------------------------------------------------
  const referencePath = flags.reference ? path.resolve(String(flags.reference)) : null;
  const frames = (deliveredFrames.length
    ? deliveredFrames.map((entry) => ({ file: entry.name, abs: entry.abs }))
    : bench.frames.filter((frame) => frame.abs).map((frame) => ({ file: frame.file, abs: frame.abs })));
  if (frames.length === 0) {
    console.error(`${actionId}: 没有可入链的帧（交付目录里没有 PNG，动作也没有在盘帧）`);
    return 1;
  }
  const stageIds = stageList(flags, { hasReference: Boolean(referencePath) });
  const ctx = {
    repoRoot: trees.repoRoot,
    contentDir: trees.contentDir,
    charactersRoot: trees.charactersRoot,
    frames,
    // 内容寻址暂存：<content>/build/pipeline/<action>/<段>-<key12>/ —— 参数不同落不同
    // 目录，入账的输出哈希因此永远对得上自己那一份字节（改文件才会对不上）
    outRoot: path.join(trees.contentDir, 'build', 'pipeline', actionId),
    cleanedDir: path.join(trees.contentDir, 'build', 'pipeline', actionId, 'cleaned'),
    normalizedDir: path.join(trees.contentDir, 'build', 'pipeline', actionId, 'normalized'),
    qcReportPath: path.join(trees.contentDir, 'build', 'qc', `${actionId}.qc.json`),
    label: actionId,
    footLine: bench.declaredFootLine,
    tolerancePx: bench.tolerancePx,
    referencePath,
    allowNetwork: Boolean(flags['allow-network']),
    env: process.env,
    actionId,
  };
  let userParams = {};
  if (flags.params) {
    try { userParams = JSON.parse(String(flags.params)); }
    catch (error) { console.error(`--params 不是合法 JSON：${error.message}`); return 2; }
  }
  const cache = createCache({ repoRoot: trees.repoRoot });
  const maxRetries = flags['max-retries'] === undefined ? 3 : Number(flags['max-retries']);

  if (planOnly || flags.plan) {
    const plan = resolvePlan({ ctx, stageIds, params: userParams, cache, force: Boolean(flags.force) });
    say(`流水线计划 · ${actionId} · 段 ${stageIds.join(',')} · 将跑 ${plan.wouldRun.length} · 命中 ${plan.wouldReuse.length}`);
    for (const entry of plan.stages) {
      const status = { hit: '命中缓存', miss: '将执行', 'stale-upstream': '将执行（上游变更）', 'unknown-stage': '未知段', blocked: '被阻断' }[entry.status] || entry.status;
      say(`  ${String(entry.id).padEnd(3)} ${String(entry.name || '').padEnd(18)} ${status} — ${entry.reason}`);
      if (entry.params && Object.keys(entry.params).length) say(`      参数 ${JSON.stringify(entry.params)}`);
    }
    if (Object.keys(plan.params).length) say(`生效参数：${JSON.stringify(plan.params)}`);
    say('（--plan 只打印计划：不执行、不写缓存、不入账）');
    if (asJson) console.log(JSON.stringify(plan, null, 2));
    else console.log(lines.join('\n'));
    return 0;
  }

  const queue = triageLib.createTriageQueue({ contentDir: trees.contentDir, actionId });
  const outcome = runPipeline({ ctx, stageIds, params: userParams, maxRetries, cache, force: Boolean(flags.force), triage: queue });
  const emit = (line) => lines.push(line);
  say(`流水线 · ${actionId} · ${outcome.ok ? 'PASS' : 'BLOCKED'} · ran ${JSON.stringify(outcome.ran)} · cached ${JSON.stringify(outcome.cachedStages)}`);
  if (stageIds.includes('S8') && outcome.ok) {
    say('  入包：S8 走发布内核（QC 全绿 → 备份 → 写 resources/characters → 记 provenance）；--no-publish 可只到归一化');
  }
  for (const stage of outcome.stages) {
    const verdict = stage.metrics && stage.metrics.verdict ? ` verdict=${stage.metrics.verdict}` : '';
    say(`  ${stage.id} ${stage.status} ${stage.ms}ms attempts=${stage.attempts}${verdict}`);
    printFindings((stage.findings || []).slice(0, 6), 40, { quiet: asJson, out: emit });
    if (stage.autoResolved && stage.autoResolved.length) say(`      ↳ 自动关闭分诊：${stage.autoResolved.join(', ')}`);
  }

  // ---- 3. 参数入账（每次转换调用落一份）------------------------------------
  const recordParams = recordParamsEnabled(flags);
  const recorded = [];
  for (const stage of outcome.stages) {
    if (stage.status !== 'ran' || stage.id === 'S8') continue; // S8 的入账是发布台账自己
    const stageParams = stageParamsFor(stage.id, outcome.params);
    const result = ledgerCall({
      trees, actionId, enabled: recordParams,
      call: {
        kind: 'frame-sheet',
        tool: `studio/lib/pipeline/stages.js#${stage.id}`,
        command: stageReproduceCommand(actionId, stage.id, stageParams),
        agent: flags.agent,
        params: stageParams,
        seed: null,
        inputs: inputPathsForRecord(stage, ctx),
        outputs: outputPathsForRecord(stage, ctx),
        note: `pipeline stage ${stage.id} (${stage.name})`,
      },
    });
    if (result.refused) {
      console.error(`参数入账被拒（${result.code}）：${result.error}`);
      return 1;
    }
    if (!result.skipped || result.skipped === false) recorded.push(stage.id);
  }
  if (recordParams) {
    say(`参数入账：${recorded.length ? `${recorded.join(',')} → ${path.relative(trees.repoRoot, path.join(trees.contentDir, 'characters', DEFAULT_CHARACTER_ID, 'provenance', 'generation', `${actionId}.params.json`))}` : '无新调用（全部命中缓存或已入账）'}`);
  } else {
    say('参数入账：已跳过（真实树默认只读；--record-params 显式落账，沙箱树自动落账）');
  }

  // ---- 4. 分诊与收尾 -------------------------------------------------------
  if (outcome.triage.length > 0) {
    say(`人工分诊（${outcome.queued.length} 项入队）：${path.relative(trees.repoRoot, queue.file)}`);
    for (const id of outcome.queued) {
      const entry = queue.show(id);
      if (!entry) continue;
      say(`  ✗ ${entry.id} · ${entry.stage} ${entry.code} · 已重试 ${entry.attempts}/${entry.maxRetries} · 建议：${entry.fix}`);
    }
    say(`  处理：node bin/pipeline.js triage show <id> → 改素材 → node bin/pipeline.js run ${actionId}`);
  } else {
    say(`人工分诊：无（${path.relative(trees.repoRoot, queue.file)}）`);
  }
  if (asJson) console.log(JSON.stringify({ ...outcome, plan: null, triageFile: queue.file }, null, 2));
  else console.log(lines.join('\n'));
  return outcome.ok ? 0 : 1;
}

function recordParamsEnabled(flags) {
  if (flags['record-params'] === true) return true;
  if (flags['no-record-params'] === true) return false;
  // auto: a sandbox tree (the env override) is a rehearsal — record there; the
  // repo's own content tree stays ledger-free until a REAL generation is recorded
  return Boolean(process.env.STUDIO_CONTENT_DIR);
}

// ---------------------------------------------------------------------------
// triage CLI
// ---------------------------------------------------------------------------

function commandTriage(positional, flags) {
  const sub = positional[1];
  const trees = resolveTrees();
  const contentDir = trees.contentDir;
  const actionId = flags.action ? String(flags.action) : null;

  if (sub === 'list') {
    const rows = [];
    const actions = actionId ? [actionId] : listTriageActions(contentDir);
    for (const id of actions) {
      const queue = triageLib.createTriageQueue({ contentDir, actionId: id });
      if (!queue.ok) continue;
      for (const entry of queue.list({ status: flags.status ? String(flags.status) : null })) rows.push(entry);
    }
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (flags.json) { console.log(JSON.stringify({ entries: rows }, null, 2)); return 0; }
    if (rows.length === 0) { console.log('（分诊队列为空）'); return 0; }
    for (const entry of rows) {
      const state = entry.status === 'open' ? '✗' : '✓';
      console.log(`${state} ${entry.id} · ${entry.stage} ${entry.code} · 重试 ${entry.attempts}/${entry.maxRetries} · ${entry.status}`);
      console.log(`    原因：${entry.reason}`);
      console.log(`    建议：${entry.fix}`);
      if (entry.resolution) console.log(`    解析：${entry.resolution.note}（${entry.resolution.by} @ ${entry.resolvedAt}）`);
    }
    return 0;
  }

  if (sub === 'show') {
    const id = positional[2];
    if (!id) { console.error('usage: pipeline triage show <id>'); return 2; }
    const found = findTriageEntry(contentDir, id, actionId);
    if (!found) { console.error(`unknown triage id: ${id}`); return 2; }
    if (flags.json) { console.log(JSON.stringify(found, null, 2)); return 0; }
    console.log(`${found.id} · ${found.stage} ${found.code} · ${found.status}`);
    console.log(`  原因：${found.reason}`);
    console.log(`  建议修法：${found.fix}`);
    console.log(`  已重试：${found.attempts}/${found.maxRetries}（runs=${found.runs}）· 需要人工：${found.needsHuman ? '是' : '否'}`);
    for (const finding of found.findings || []) console.log(`  [${finding.severity}] ${finding.code}: ${finding.message}`);
    if (found.resolution) console.log(`  解析：${found.resolution.note}（${found.resolution.by} @ ${found.resolvedAt}）`);
    else console.log(`  解析：node bin/pipeline.js triage resolve ${found.id} --note "改了什么"`);
    return 0;
  }

  if (sub === 'resolve') {
    const id = positional[2];
    if (!id) { console.error('usage: pipeline triage resolve <id> --note "改了什么"'); return 2; }
    const note = typeof flags.note === 'string' ? flags.note : null;
    const found = findTriageEntry(contentDir, id, actionId);
    if (!found) { console.error(`unknown triage id: ${id}`); return 2; }
    const queue = triageLib.createTriageQueue({ contentDir, actionId: found.actionId });
    const outcome = queue.resolve(id, { note, by: flags.by ? String(flags.by) : (flags.agent ? String(flags.agent) : 'human') });
    if (!outcome.ok) { console.error(`resolve 失败：${outcome.error}`); return 1; }
    if (flags.json) { console.log(JSON.stringify(outcome.entry, null, 2)); return 0; }
    console.log(`已解析 ${id} · ${outcome.entry.stage} ${outcome.entry.code}`);
    console.log(`  注：${outcome.entry.resolution.note}`);
    console.log(`  重新入链：node bin/pipeline.js run ${found.actionId}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

function listTriageActions(contentDir) {
  const dir = path.join(contentDir, 'build', 'triage');
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(triageLib.FILE_SUFFIX)).map((name) => name.slice(0, -triageLib.FILE_SUFFIX.length)).sort();
  } catch { return []; }
}

function findTriageEntry(contentDir, id, actionId) {
  const actions = actionId ? [actionId] : listTriageActions(contentDir);
  for (const action of actions) {
    const queue = triageLib.createTriageQueue({ contentDir, actionId: action });
    if (!queue.ok) continue;
    const entry = queue.show(id);
    if (entry) return entry;
  }
  return null;
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const cache = createCache({ repoRoot: REPO_ROOT });

  if (command === 'qc' && positional[1] === 'frames') {
    const dir = flags.dir ? path.resolve(String(flags.dir)) : null;
    if (!dir) { console.error(USAGE); return 2; }
    const frames = framesInDir(dir);
    const report = qcFramesLib.qcFrames({ frames, label: path.basename(dir), footLine: flags.foot ? Number(flags.foot) : null, expectedSeries: frames.map((frame) => frame.abs) });
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
    console.log(`帧 QC · ${report.label} · ${report.frames.length} 帧 · 判定 ${report.verdict} · 鞋线中位数 ${report.stats.medianFootLine} · 红 ${report.stats.red} / 黄 ${report.stats.yellow}`);
    console.log(`  相邻 dHash 距离：${report.stats.adjacentDistances.join(', ')}（中位数 ${report.stats.adjacentDistanceMedian}）· 质心横向漂移 ${report.stats.centroidSpreadX}px`);
    printFindings(report.findings);
    return report.ok ? 0 : 1;
  }

  if (command === 'qc' && positional[1] === 'video') {
    const file = positional[2];
    if (!file) { console.error(USAGE); return 2; }
    const expect = {};
    if (flags['expect-fps']) expect.fps = Number(flags['expect-fps']);
    if (flags['expect-alpha']) expect.alpha = true;
    const report = qcVideoLib.qcVideo({ file: path.resolve(file), expect });
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
    if (report.verdict === 'unavailable') { console.error(report.message); return 1; }
    console.log(`视频 QC · ${path.basename(file)} · 判定 ${report.verdict} · ${report.probe.codec}/${report.probe.pixFmt} ${report.probe.width}×${report.probe.height} ${report.probe.fps}fps ${report.probe.durationSec}s`);
    printFindings(report.findings);
    return report.ok ? 0 : 1;
  }

  if (command === 'check') {
    const actionId = positional[1];
    if (!actionId) { console.error(USAGE); return 2; }
    const { createStudioServices } = require(path.join(STUDIO_ROOT, 'lib', 'studio-services.js'));
    const trees = resolveTrees();
    const studio = createStudioServices({ repoRoot: trees.repoRoot, contentDir: trees.contentDir, charactersRoot: trees.charactersRoot });
    const bench = studio.actionBench(actionId);
    if (!bench.ok) { console.error(`${bench.code}: ${bench.message}`); return 1; }
    const report = qcFramesLib.qcFrames({
      frames: bench.frames.map((frame) => ({ file: frame.file, abs: frame.abs })),
      label: actionId,
      footLine: bench.declaredFootLine,
      tolerancePx: bench.tolerancePx,
    });
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
    console.log(`帧 QC · ${actionId} · 判定 ${report.verdict} · 红 ${report.stats.red} / 黄 ${report.stats.yellow}`);
    printFindings(report.findings);
    return report.ok ? 0 : 1;
  }

  if (command === 'plan') return commandRun(positional, flags, { planOnly: true });
  if (command === 'run') return commandRun(positional, flags, { planOnly: false });
  if (command === 'triage') return commandTriage(positional, flags);

  if (command === 'matte') {
    const input = positional[1];
    if (!input) { console.error(USAGE); return 2; }
    const out = flags.out ? path.resolve(String(flags.out)) : null;
    const outcome = mattingLib.cleanupFile({ absPath: path.resolve(input), outPath: out });
    if (!outcome.ok) { console.error(`${outcome.code}: ${outcome.message}`); return 1; }
    console.log(`抠像后处理完成 · ${outcome.order.join(' → ')}`);
    for (const step of outcome.steps) console.log(`  ${step.step}: ${JSON.stringify(Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'step')))}`);
    if (out) console.log(`写出：${out}`);
    return 0;
  }

  if (command === 'encode') {
    const dir = flags.frames ? path.resolve(String(flags.frames)) : null;
    const out = flags.out ? path.resolve(String(flags.out)) : null;
    if (!dir || !out) { console.error(USAGE); return 2; }
    const outcome = stagesLib.s7Encode({ frames: framesInDir(dir), outFile: out, fps: flags.fps ? Number(flags.fps) : 24 });
    if (!outcome.ok) {
      console.error(`${outcome.code}: ${outcome.message || ''}`);
      for (const finding of outcome.findings || []) console.error(`  ✗ ${finding.code} — ${finding.message}\n      ↳ ${finding.fix}`);
      return 1;
    }
    console.log(`已编码 ${out} · ${outcome.probe.codec}/${outcome.probe.pixFmt} ${outcome.probe.width}×${outcome.probe.height} ${outcome.probe.fps}fps · alpha 实测 ${outcome.alpha.present ? `存在（${outcome.alpha.transparentPixels} 透明像素）` : '缺失'}`);
    return 0;
  }

  if (command === 'cache') {
    const sub = positional[1] || 'stats';
    if (sub === 'stats') {
      const stats = cache.stats();
      console.log(`缓存目录 ${stats.root}`);
      console.log(`条目 ${stats.entries} · ${(stats.totalBytes / 1024).toFixed(1)} KiB`);
      for (const [stage, entry] of Object.entries(stats.stages)) console.log(`  ${stage}: ${entry.entries} 条 / ${(entry.bytes / 1024).toFixed(1)} KiB`);
      return 0;
    }
    if (sub === 'list') {
      for (const row of cache.list({ stage: flags.stage ? String(flags.stage) : null })) {
        console.log(`${row.createdAt} ${row.stage} ${row.key.slice(0, 12)}… outputs ${row.outputs}${row.note ? ` · ${JSON.stringify(row.note).slice(0, 80)}` : ''}`);
      }
      return 0;
    }
    if (sub === 'clear') {
      const outcome = cache.clear({ stage: flags.stage ? String(flags.stage) : null });
      console.log(`已清理 ${outcome.removed} 条（缓存是消耗品：删掉只花时间，不丢数据）`);
      return 0;
    }
    console.error(USAGE);
    return 2;
  }

  if (command === 'providers') {
    for (const entry of providers.describeRegistry(providers.DEFAULT_REGISTRY, process.env)) {
      console.log(`${entry.name}/${entry.klass} · ${entry.models.join(',')} · key ${entry.keyRef} (${entry.keyStatus}${entry.keyFingerprint ? ` ${entry.keyFingerprint}` : ''}) · ${entry.baseURL || 'baseURL 待确认'}`);
    }
    console.log('（密钥永不打印：只出现引用名与指纹）');
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, main, parseArgs };
