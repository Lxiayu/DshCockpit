#!/usr/bin/env node
'use strict';

// studio/bin/provenance.js — 「素材复现链」CLI（office 工作台 / studio 模块集）。
//
//   node studio/bin/provenance.js report <id>            # 单个资产（角色动作 / office 目录资产）的五段链
//   node studio/bin/provenance.js verify [--json]        # 全量在盘校验
//   node studio/bin/provenance.js index [--out <file>]   # 重建 JSON 索引（默认 studio/build/provenance-index.json）
//   node studio/bin/provenance.js lost [--json]          # 列出无法回溯的环节（含找回锚点）
//   node studio/bin/provenance.js record --action <id> ... # 追加一条生成参数台账（segment 1 的唯一写入口）
//
// 契约：
//   - --json 动词的 stdout 只有 JSON（机器可读）；其余为人读文本。
//   - 退出码：0 = 正常；1 = verify 发现 lost；2 = 用法错误 / 未知 id。
//   - 绝不打印任何 API key / secret：参数台账只存提示词 sha256（除非显式 --store-prompt-text）。
//
// 用法示例见 studio/docs/provenance.md。

const path = require('node:path');
const { createProvenance } = require('../lib/provenance.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const USAGE = `usage:
  provenance.js report <id> [--text]               # 单资产五段链（默认 JSON；--text 人读）
  provenance.js verify [--json]                    # 全量校验（含台账哈希链）
  provenance.js index [--out <file>] [--json]      # 重建索引（默认 studio/build/provenance-index.json）
  provenance.js lost [--json]                      # 断点清单 + 找回锚点
  provenance.js record --action <id> [--kind image|video|frame-sheet]
        [--provider <p>] [--model <m>] [--prompt <text>] [--store-prompt-text]
        [--params <json>] [--seed <n>] [--reference <path>]... [--output <path>]...
        [--command <cmd>] [--tool <name>] [--tool-version <v>] [--agent <id>]
        [--recorded-at <iso>] [--character <id>] [--json]
  global: [--repo <dir>]`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

const REPEATABLE = ['reference', 'output'];

function collectRepeated(argv) {
  const refs = { reference: [], output: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const key = a.startsWith('--') ? a.slice(2) : null;
    if (key !== 'reference' && key !== 'output') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;
    refs[key].push({ path: value });
  }
  return refs;
}

function toLines(report) {
  const lines = [];
  const seg = (id) => report.segments.find((s) => s.id === id) || null;
  lines.push(`id: ${report.id}`);
  if (report.kind === 'action') {
    lines.push(`kind: action (character ${report.characterId} / pack ${report.pack})`);
    lines.push(`animation: ${report.animation.frameCount} frames, loop=${report.animation.loop}, direction=${report.animation.direction}, perCycleMs=${report.animation.perCycleMs}`);
  } else {
    lines.push(`kind: office-asset${report.archived ? ' (archived)' : ''}${report.label ? ` — ${report.label}` : ''}`);
    lines.push(`file: ${report.file.path} (served as ${report.file.servedAs})`);
  }
  lines.push(`segments:`);
  for (const s of report.segments) {
    lines.push(`  ${s.id.padEnd(11)} ${s.status}`);
    for (const n of s.notes) lines.push(`      · ${n}`);
  }
  lines.push(`reproducible: ${report.reproducible}`);
  if (report.findings.length) {
    lines.push('findings:');
    for (const f of report.findings) lines.push(`  [${f.level}] ${f.code}: ${f.message}`);
  }
  const gen = seg('generation');
  if (gen && gen.evidence.ledger) {
    lines.push(`generation ledger: ${gen.evidence.ledger.exists ? `${gen.evidence.ledger.records} record(s) @ ${gen.evidence.ledger.file}` : `absent (${gen.evidence.ledger.reason})`}`);
  }
  // R4: the generation segment answers with the CALL itself — parameters, input
  // and output hashes, the executor, and the one-line reproduce command.
  if (gen && gen.evidence.latestRecord) {
    const record = gen.evidence.latestRecord;
    lines.push('latest generation call:');
    lines.push(`  tool:        ${record.tool}${record.toolVersion ? ` @ ${record.toolVersion}` : ''}`);
    lines.push(`  executed by: ${record.agent || '(not recorded)'}`);
    lines.push(`  at:          ${record.recordedAt}  kind: ${record.kind}${record.model ? `  model: ${record.provider ? `${record.provider}/` : ''}${record.model}` : ''}${record.seed !== null && record.seed !== undefined ? `  seed: ${record.seed}` : ''}`);
    if (record.promptHash) lines.push(`  promptHash:  ${record.promptHash}`);
    lines.push(`  params:      ${JSON.stringify(record.params)}`);
    lines.push(`  inputs:      ${record.inputs} file(s)${record.inputHashes.length ? ` — ${record.inputHashes.slice(0, 3).map((sha) => sha.slice(0, 12)).join(', ')}${record.inputHashes.length > 3 ? ', …' : ''}` : ''}`);
    lines.push(`  outputs:     ${record.outputs} file(s) — ${gen.evidence.matchedOutputs} matched on disk${(gen.evidence.tamperedOutputs || []).length ? `, ${gen.evidence.tamperedOutputs.length} TAMPERED` : ''}`);
    if (gen.evidence.reproduce && gen.evidence.reproduce.command) lines.push(`  reproduce:   ${gen.evidence.reproduce.command}`);
    else lines.push(`  reproduce:   (none recorded — ${gen.evidence.reproduce ? gen.evidence.reproduce.note : 'no command'})`);
  }
  return lines;
}

function run(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const asJson = args.json === true;
  const repoRoot = typeof args.repo === 'string' ? path.resolve(args.repo) : REPO_ROOT;
  const engine = createProvenance({ repoRoot });

  if (cmd === 'help' || cmd === '--help' || args.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (!cmd) { console.error(USAGE); return 2; }

  if (cmd === 'report') {
    const id = args._[1];
    if (!id) { console.error('usage: provenance.js report <id> [--text]'); console.error(`known ids: ${[...engine.actionIds(), ...engine.officeAssets().map((a) => a.asset.id)].sort().join(', ')}`); return 2; }
    const report = engine.report(id);
    if (!report.ok) {
      console.error(`error: ${report.error}`);
      if (report.known && report.known.length) console.error(`known ids: ${report.known.join(', ')}`);
      return 2;
    }
    // default stays machine-readable JSON; --text is the human answer to "这套素材
    // 怎么来的 + 一键复现命令 + 红黄绿"
    if (args.text === true) {
      for (const line of toLines(report)) console.log(line);
      return 0;
    }
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (cmd === 'verify') {
    const result = engine.verify();
    if (asJson) { console.log(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1; }
    console.log(`repo: ${result.repo}  pack: ${result.pack}  catalog: ${result.catalog}`);
    console.log(`counts (per-asset worst link status):`);
    console.log(`  traceable=${result.counts.traceable}  traceable-in-history=${result.counts.traceableInHistory}  lost=${result.counts.lost}  not-recorded=${result.counts.notRecorded}  tampered=${result.counts.tampered}  (total ${result.rows.length})`);
    const chain = result.hashChain;
    console.log(`hash chain: ledgers=${chain.ledgers} records=${chain.records} outputs=${chain.outputsRecorded} matched=${chain.outputsMatched} tampered=${chain.outputsTampered} unresolved=${chain.outputsUnresolved}`);
    console.log(`note: ${result.note}`);
    console.log('rows:');
    for (const row of result.rows) console.log(`  ${row.id.padEnd(28)} ${row.status}${row.tampered ? `  TAMPERED=${row.tampered}` : ''}`);
    console.log(result.ok ? 'OK — no lost links, no tampered ledger outputs' : `FAILED — ${result.counts.lost} lost link(s), ${result.counts.tampered} tampered ledger output(s)`);
    return result.ok ? 0 : 1;
  }

  if (cmd === 'index') {
    const out = typeof args.out === 'string' ? args.out : undefined;
    const result = engine.index({ out });
    const entries = result.entries;
    const summary = {
      ok: result.ok,
      out: result.out,
      entries: entries.length,
      sample: entries.slice(0, 3).map((e) => `${e.id}(${e.kind})`),
      counts: result.index.counts,
      chainGaps: result.index.chainGaps.length,
    };
    if (asJson) { console.log(JSON.stringify(summary, null, 2)); return 0; }
    console.log(`index written: ${result.out}`);
    console.log(`entries: ${entries.length}`);
    console.log(`sample ids: ${summary.sample.join(', ')}`);
    console.log(`counts: ${JSON.stringify(result.index.counts)}`);
    console.log(`chain gaps recorded: ${result.index.chainGaps.length} (entries with a segment that is not traceable)`);
    return 0;
  }

  if (cmd === 'lost') {
    const result = engine.lost();
    if (asJson) { console.log(JSON.stringify(result, null, 2)); return 0; }
    console.log(`断点清单（${result.entries.length} 条；每条都给找回锚点，没有锚点就直说没有）\n`);
    const bySegment = new Map();
    for (const e of result.entries) {
      const key = `${e.status} | ${e.segment}`;
      if (!bySegment.has(key)) bySegment.set(key, []);
      bySegment.get(key).push(e);
    }
    for (const [key, list] of bySegment) {
      console.log(`- [${key}] ${list.length} 项`);
      for (const e of list) {
        console.log(`    ${e.id} (${e.kind}) — ${e.reason.split('\n')[0]}`);
        for (const a of e.anchors) console.log(`      ↳ ${a}`);
      }
    }
    return 0;
  }

  if (cmd === 'record') {
    const actionId = args.action;
    if (!actionId) { console.error('usage: provenance.js record --action <id> [--kind image|video|frame-sheet] [--prompt <text>] [--store-prompt-text] ...'); return 2; }
    let params = null;
    if (typeof args.params === 'string') {
      try { params = JSON.parse(args.params); }
      catch (e) { console.error(`error: --params is not valid JSON: ${e.message}`); return 2; }
    }
    const repeated = collectRepeated(argv);
    const record = {
      actionId,
      kind: typeof args.kind === 'string' ? args.kind : undefined,
      provider: typeof args.provider === 'string' ? args.provider : undefined,
      model: typeof args.model === 'string' ? args.model : undefined,
      prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
      storePromptText: args['store-prompt-text'] === true,
      params,
      seed: args.seed !== undefined ? args.seed : undefined,
      references: repeated.reference,
      outputs: repeated.output,
      command: typeof args.command === 'string' ? args.command : undefined,
      tool: typeof args.tool === 'string' ? args.tool : undefined,
      toolVersion: typeof args['tool-version'] === 'string' ? args['tool-version'] : undefined,
      agent: typeof args.agent === 'string' ? args.agent : undefined,
      recordedAt: typeof args['recorded-at'] === 'string' ? args['recorded-at'] : undefined,
      characterId: typeof args.character === 'string' ? args.character : undefined,
    };
    const result = engine.record(record);
    if (!result.ok) {
      // 密钥形状命中：报错只给指纹与形状码，绝不回显值；stdout 不污染
      console.error(`error: ${result.error}`);
      if (result.code === 'SECRET_SHAPE_REFUSED') console.error('（入账前跑过形状扫描：sk-/Bearer/token=/cookie 命中即拒绝写盘）');
      return 2;
    }
    if (asJson) { console.log(JSON.stringify({ ok: true, file: result.fileRelative || result.file, record: result.record }, null, 2)); return 0; }
    console.log(`ledger appended: ${result.fileRelative || result.file}`);
    console.log(`  actionId: ${result.record.actionId}`);
    console.log(`  kind: ${result.record.kind}`);
    console.log(`  recordedAt: ${result.record.recordedAt}`);
    console.log(`  promptHash: ${result.record.promptHash || '(none)'}`);
    console.log(`  prompt text stored: ${Object.prototype.hasOwnProperty.call(result.record, 'prompt') ? 'YES (--store-prompt-text)' : 'no (hash only)'}`);
    console.log(`  references: ${result.record.references.length}  outputs: ${result.record.outputs.length}`);
    return 0;
  }

  console.error(`unknown command: ${cmd}\n${USAGE}`);
  return 2;
}

// 注意：用 process.exitCode 而不是 process.exit()——大 JSON（index/verify）写在管道上时
// process.exit 会在 flush 前砍掉 stdout（实测 verify --json 丢尾 7KB）。exitCode 让进程
// 自然退场，stdout 一定写完。
if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run, parseArgs, USAGE };
