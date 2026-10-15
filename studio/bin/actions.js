#!/usr/bin/env node
'use strict';

// studio/bin/actions.js — the action/review CLI (the headless form of the 审片台).
//
//   node studio/bin/actions.js list [--json]
//   node studio/bin/actions.js show <id> [--json]
//   node studio/bin/actions.js bench <id> [--json]        逐帧几何 + 批注 + 播放事实
//   node studio/bin/actions.js gaps [--json]             能力缺口检查
//   node studio/bin/actions.js migrate [<id>|--all]      v1 → v2（先备份）
//   node studio/bin/actions.js publish <id>              真发布内核（写 resources/**）
//   node studio/bin/actions.js notes <id> [--json]
//   node studio/bin/actions.js annotate --action <id> --frame <n> --text <t> [--severity note|fix|praise]
//   node studio/bin/actions.js export-notes <id> [--out <file>]
//
// Exit codes: 0 ok · 1 refused/failed · 2 usage.

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const { createActionServices } = require(path.join(STUDIO_ROOT, 'lib', 'actions', 'service.js'));
const publisher = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-publisher.js'));

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
  actions list [--json]
  actions show <id> [--json]
  actions bench <id> [--json]
  actions gaps [--json]
  actions migrate <id>|--all
  actions publish <id>
  actions notes <id> [--json]
  actions annotate --action <id> --frame <n> --text <t> [--severity note|fix|praise]
  actions export-notes <id> [--out <file>]`;

function services() {
  return createActionServices({
    repoRoot: REPO_ROOT,
    contentDir: path.join(REPO_ROOT, 'content'),
    charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
    publisher,
  });
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const studio = services();

  if (command === 'list') {
    const listed = studio.list();
    if (flags.json) { console.log(JSON.stringify(listed, null, 2)); return 0; }
    console.log(`${listed.actions.length} action(s)`);
    for (const row of listed.actions) {
      const schema = row.hasDoc ? `v${row.schemaVersion}` : 'pack-only';
      const notes = row.openNotes ? ` · 批注 ${row.openNotes} 开${row.staleNotes ? `/${row.staleNotes} 失效` : ''}` : '';
      console.log(`  ${row.id.padEnd(14)} ${schema.padEnd(9)} ${String(row.frames).padStart(2)}f ${String(row.direction).padEnd(5)} `
        + `${row.loop ? 'loop' : 'once'}${row.pingPong ? '+pp' : '   '} ${String(row.totalMs === null ? '' : `${row.totalMs}ms`).padEnd(8)} `
        + `${row.inPack ? 'in-pack' : 'NOT-in-pack'}${row.tags && row.tags.length ? ` tags=${row.tags.join('+')}` : ''}${notes}`);
    }
    return 0;
  }

  if (command === 'show') {
    const id = positional[1];
    if (!id) { console.error(USAGE); return 2; }
    const shown = studio.show(id);
    if (!shown.ok) { console.error(`${shown.code}: ${shown.message}`); return 1; }
    if (flags.json) { console.log(JSON.stringify(shown, null, 2)); return 0; }
    const s = shown.summary;
    console.log(`${s.id} · schema v${s.schemaVersion} · ${s.direction} · ${s.frames} 帧 · ${s.totalMs}ms${s.pingPong ? ` · ping-pong 周期 ${s.cycleMs}ms` : ''}`);
    console.log(`标签：${s.tags.join(', ') || '（无）'} · 事件：${s.events.map((event) => `#${event.frame}:${event.name}`).join(', ') || '（无）'}`);
    console.log(`运行时：${shown.runtime.runtimeSafe ? '编译安全' : '存在无法编译的字段'} · 与包${shown.runtime.inSync ? '一致' : '**不一致（需发布）**'}`);
    for (const drop of shown.runtime.dropped) console.log(`  ↓ 运行时无法表达：${drop.field} — ${drop.reason}`);
    for (const event of s.events) console.log(`  @${event.frame} ${event.name} → ${event.file}`);
    if (shown.notes.length) {
      console.log(`批注 ${shown.notes.length}：`);
      for (const note of shown.notes) {
        console.log(`  #${note.frame} [${note.severity}]${note.resolved ? '（已解决）' : ''}${note.stale ? '（帧序已变，失效）' : ''} ${note.text}`);
      }
    }
    return 0;
  }

  if (command === 'bench') {
    const id = positional[1];
    if (!id) { console.error(USAGE); return 2; }
    const bench = studio.bench(id);
    if (!bench.ok) { console.error(`${bench.code}: ${bench.message}`); return 1; }
    if (flags.json) { console.log(JSON.stringify(bench, null, 2)); return bench.redFrames === 0 ? 0 : 1; }
    console.log(`${bench.actionId} · ${bench.frames.length} 帧 · 鞋线中位数 ${bench.medianFootLine}（声明 ${bench.declaredFootLine}，容差 ±${bench.tolerancePx}px）· 红帧 ${bench.redFrames}`);
    for (const frame of bench.frames) {
      const mark = frame.ok && Math.abs(frame.footLineDelta || 0) <= bench.tolerancePx ? '·' : '✗';
      const notes = bench.notes.filter((note) => note.frame === frame.index && !note.resolved).map((note) => `「${note.text}」`).join('');
      console.log(`  ${mark} #${String(frame.index).padStart(2)} ${frame.file.split('/').pop().padEnd(24)} `
        + `鞋线 ${String(frame.footLine ?? '-').padStart(3)} Δ${String(frame.footLineDelta ?? '-').padStart(4)} `
        + `高 ${String(frame.visibleHeight ?? '-').padStart(3)} 宽 ${String(frame.visibleWidth ?? '-').padStart(3)} ${notes}`);
    }
    return bench.redFrames === 0 ? 0 : 1;
  }

  if (command === 'gaps') {
    const report = studio.gapReport();
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
    console.log(`能力缺口检查 · 必需项${report.ok ? '齐备' : '**有缺口**'} · 素材动作 ${report.inventory.count}`);
    for (const row of report.capabilities) {
      const mark = row.status === 'complete' ? '✔' : row.status === 'partial' ? '~' : '✗';
      console.log(`  ${mark} ${row.label.padEnd(16)} ${row.status.padEnd(13)} ${row.required ? '[必需]' : '[可选]'} `
        + `${row.present.map((entry) => `${entry.id}${entry.frames !== undefined ? `(${entry.frames}f)` : ''}`).join(' ') || '—'}`);
      if (row.how) console.log(`      ↳ ${row.how}`);
    }
    return report.ok ? 0 : 1;
  }

  if (command === 'migrate') {
    const id = positional[1];
    if (flags.all || !id) {
      const outcome = studio.migrateAll();
      console.log(`迁移完成：${outcome.migrated.length} 个 → v2${outcome.migrated.length ? `（${outcome.migrated.join(', ')}）` : ''}`);
      const already = outcome.skipped.filter((entry) => entry.code === 'ALREADY_V2').length;
      if (already) console.log(`已在 v2：${already} 个（无变更不落盘）`);
      for (const skipped of outcome.skipped.filter((entry) => entry.code !== 'ALREADY_V2')) console.log(`  跳过 ${skipped.actionId}：${skipped.code}`);
      return 0;
    }
    const outcome = studio.migrate(id);
    if (!outcome.ok) { console.error(`${outcome.code}: ${outcome.message}`); return 1; }
    console.log(outcome.noop ? `${id} 已是 v2（无变更不落盘）` : `${id} → v2（备份 ${outcome.backup}）`);
    return 0;
  }

  if (command === 'publish') {
    const id = positional[1];
    if (!id) { console.error(USAGE); return 2; }
    const outcome = studio.publish(id);
    if (!outcome.ok) {
      console.error(`发布被拒绝：${outcome.code}`);
      for (const violation of outcome.violations || []) console.error(`  ✗ ${violation.file} ${violation.check} ${violation.detail}`);
      return 1;
    }
    if (outcome.noop) { console.log('无变更 — 未写入（无备份、无 provenance）'); return 0; }
    console.log(`已发布 ${id} ✓ · 备份 ${outcome.summary.backupDirRelative} · provenance ${outcome.summary.provenancePath}`);
    for (const drop of outcome.runtime.dropped || []) console.log(`  ↓ 运行时未携带：${drop.field}`);
    return 0;
  }

  if (command === 'notes') {
    const id = positional[1];
    if (!id) { console.error(USAGE); return 2; }
    const listed = studio.listNotes(id);
    if (!listed.ok) { console.error(`${listed.code}: ${listed.message}`); return 1; }
    if (flags.json) { console.log(JSON.stringify(listed, null, 2)); return 0; }
    console.log(`${id}: ${listed.notes.length} 条批注（${listed.open} 未解决，${listed.stale} 因帧序变化失效）`);
    for (const note of listed.notes) {
      console.log(`  #${note.frame} [${note.severity}]${note.resolved ? '（已解决）' : ''}${note.stale ? '（失效）' : ''} ${note.text}`);
    }
    return 0;
  }

  if (command === 'annotate') {
    const actionId = flags.action;
    const frame = Number(flags.frame);
    const text = typeof flags.text === 'string' ? flags.text : '';
    if (!actionId || !Number.isInteger(frame) || !text) { console.error(USAGE); return 2; }
    const outcome = studio.addNote({ actionId: String(actionId), frame, text, severity: flags.severity ? String(flags.severity) : 'note' });
    if (!outcome.ok) { console.error(`${outcome.code}: ${outcome.message}`); return 1; }
    console.log(`已记录 ${actionId} #${frame} [${outcome.note.severity}] ${outcome.note.text}（共 ${outcome.total} 条）`);
    return 0;
  }

  if (command === 'export-notes') {
    const id = positional[1];
    if (!id) { console.error(USAGE); return 2; }
    const exported = studio.exportNotes(id);
    if (!exported.ok) { console.error(`${exported.code}: ${exported.message}`); return 1; }
    if (flags.out) {
      const target = path.resolve(String(flags.out));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(exported, null, 2)}\n`);
      console.log(`已导出 ${exported.notes.length} 条批注 → ${target}`);
      return 0;
    }
    console.log(JSON.stringify(exported, null, 2));
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, main, parseArgs };
