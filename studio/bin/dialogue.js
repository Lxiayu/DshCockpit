#!/usr/bin/env node
'use strict';

// studio/bin/dialogue.js — the dialogue corpus CLI (P7).
//
//   node studio/bin/dialogue.js list [--layer base|character] [--json]
//   node studio/bin/dialogue.js show <topic> [--layer ...] [--json]   两层解析结果（覆盖优先）
//   node studio/bin/dialogue.js validate [--json]                     一致性守卫（红/黄 + 修法）
//   node studio/bin/dialogue.js add --topic <t> --text <台词> [--weight n] [--layer ...]
//   node studio/bin/dialogue.js import --csv <file> [--layer ...]
//   node studio/bin/dialogue.js say <topic> [--seed s]
//   node studio/bin/dialogue.js save --layer <l>                      （不加这个不写盘）
//
// 纪律：守卫有红灯就拒绝保存；写盘前字节备份；无变更不落盘。

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const corpus = require(path.join(STUDIO_ROOT, 'lib', 'dialogue', 'corpus.js'));

const CONTENT = path.join(REPO_ROOT, 'content');
const CHARACTER = 'whale-girl';

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
  dialogue list [--layer base|character] [--json]
  dialogue show <topic> [--layer ...]
  dialogue validate [--json]
  dialogue add --topic <t> --text <台词> [--weight n] [--layer ...] [--save]
  dialogue import --csv <file> [--layer ...] [--save]
  dialogue say <topic> [--seed s]
  dialogue save --layer <l>`;

function loadLayer(layer) {
  return corpus.read({ contentDir: CONTENT, characterId: CHARACTER, layer });
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const layer = flags.layer === 'character' ? 'character' : 'base';

  if (command === 'list') {
    const loaded = loadLayer(layer);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message}`); return 1; }
    const topics = Object.entries(corpus.topicsOf(loaded.doc, layer));
    if (flags.json) { console.log(JSON.stringify({ layer, file: loaded.file, topics: topics.map(([topic, entries]) => ({ topic, entries })) }, null, 2)); return 0; }
    console.log(`${layer} · ${loaded.file.replace(REPO_ROOT + '/', '')} · ${topics.length} 个 topic`);
    for (const [topic, entries] of topics) {
      const weight = entries.reduce((sum, entry) => sum + (entry.weight || 1), 0);
      console.log(`  ${topic.padEnd(14)} ${String(entries.length).padStart(2)} 条 · 总权重 ${weight}`);
    }
    return 0;
  }

  if (command === 'show') {
    const topic = positional[1];
    if (!topic) { console.error(USAGE); return 2; }
    const base = loadLayer('base');
    const character = loadLayer('character');
    const resolved = corpus.resolveTopic({ base: base.doc, character: character.ok ? character.doc : null, topic });
    if (!resolved.ok) { console.error(`unknown topic ${topic}（已知：${resolved.known.join(', ')}）`); return 1; }
    if (flags.json) { console.log(JSON.stringify(resolved, null, 2)); return 0; }
    console.log(`${topic} ← ${resolved.source} 层（${resolved.entries.length} 条）${resolved.fallback ? `；基础库另有 ${resolved.fallback.length} 条作为回落` : ''}`);
    for (const entry of resolved.entries) {
      console.log(`  ${entry.id.padEnd(10)} w${String(entry.weight === undefined ? 1 : entry.weight).padStart(2)} ${entry.if ? JSON.stringify(entry.if) + ' ' : ''}${entry.text}`);
    }
    if (resolved.fallback) {
      console.log(`  —— 基础库回落 ——`);
      for (const entry of resolved.fallback) console.log(`  ${entry.id.padEnd(10)} w${String(entry.weight === undefined ? 1 : entry.weight).padStart(2)} ${entry.text}`);
    }
    return 0;
  }

  if (command === 'validate') {
    const base = loadLayer('base');
    const character = loadLayer('character');
    if (!base.ok) { console.error(`${base.code}: ${base.message}`); return 1; }
    const validation = corpus.validateCorpus({ base: base.doc, character: character.ok ? character.doc : null });
    if (flags.json) { console.log(JSON.stringify(validation, null, 2)); return validation.ok ? 0 : 1; }
    console.log(`语料守卫 · ${validation.ok ? 'PASS（无红灯）' : 'BLOCKED'} · 基础 ${validation.stats.base.entries} 条 / 角色 ${validation.stats.character ? validation.stats.character.entries : 0} 条`);
    for (const finding of validation.findings) {
      console.log(`  ${finding.severity === 'red' ? '✗' : '!'} [${finding.severity}] ${finding.code} ${finding.layer || ''}${finding.topic ? `/${finding.topic}` : ''}${finding.id ? `#${finding.id}` : ''} — ${finding.detail}`);
      console.log(`      ↳ ${finding.fix}`);
    }
    return validation.ok ? 0 : 1;
  }

  if (command === 'add') {
    const topic = flags.topic;
    const text = flags.text;
    if (!topic || !text) { console.error(USAGE); return 2; }
    const loaded = loadLayer(layer);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message}`); return 1; }
    const weight = flags.weight ? Number(flags.weight) : 1;
    const id = `${topic}-${String(Date.now()).slice(-5)}`;
    const outcome = corpus.addEntry({ doc: loaded.doc, layer, topic: String(topic), entry: { id, text: String(text), weight } });
    if (!outcome.ok) { console.error(`${outcome.code}: ${outcome.message}`); return 1; }
    if (!flags.save) {
      console.log(`（试算）${layer}/${topic} += ${id} “${text}” w${weight} — 加 --save 才写盘`);
      return 0;
    }
    const saved = corpus.save({ contentDir: CONTENT, characterId: CHARACTER, layer, doc: outcome.doc, dryRun: false });
    if (!saved.ok) {
      console.error(`保存被拒：${saved.code}`);
      for (const finding of saved.findings || []) console.error(`  ✗ ${finding.code} ${finding.detail} → ${finding.fix}`);
      return 1;
    }
    console.log(`已加入 ${id} “${text}”（${saved.noop ? '无变更' : `备份 ${saved.backup}`}）`);
    return 0;
  }

  if (command === 'import') {
    const file = flags.csv ? path.resolve(String(flags.csv)) : null;
    if (!file || !fs.existsSync(file)) { console.error(USAGE); return 2; }
    const parsed = corpus.parseCsv(fs.readFileSync(file, 'utf8'));
    if (!parsed.ok) { console.error(`${parsed.code}: ${parsed.message}`); return 1; }
    const loaded = loadLayer(layer);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message}`); return 1; }
    const merged = corpus.importRows({ doc: loaded.doc, layer, rows: parsed.rows });
    if (!flags.save) {
      console.log(`（试算）将加入 ${merged.added.length} 条，跳过 ${merged.skipped.length} 条`);
      for (const skip of merged.skipped) console.log(`  跳过 ${skip.topic}/${skip.id}：${skip.code}`);
      return 0;
    }
    const saved = corpus.save({ contentDir: CONTENT, characterId: CHARACTER, layer, doc: merged.doc, dryRun: false });
    if (!saved.ok) { console.error(`保存被拒：${saved.code}（${(saved.findings || [])[0] ? saved.findings[0].detail : ''}）`); return 1; }
    console.log(`已导入 ${merged.added.length} 条${saved.noop ? '（无变更）' : `（备份 ${saved.backup}）`}`);
    return 0;
  }

  if (command === 'say') {
    const topic = positional[1];
    if (!topic) { console.error(USAGE); return 2; }
    const base = loadLayer('base');
    const character = loadLayer('character');
    const resolved = corpus.resolveTopic({ base: base.doc, character: character.ok ? character.doc : null, topic });
    if (!resolved.ok) { console.error(`unknown topic ${topic}`); return 1; }
    const seed = flags.seed ? String(flags.seed) : 'preview-1';
    const picked = corpus.pickEntry({ entries: resolved.entries, seed });
    const limits = base.doc.limits || { bubbleMs: 3200, maxConcurrent: 2, cooldownMs: 30000 };
    console.log(`「${picked.entry.text}」`);
    console.log(`  来自 ${resolved.source} 层 · 权重 ${picked.entry.weight === undefined ? 1 : picked.entry.weight} · 候选池 ${picked.pool}/${picked.eligible} · seed ${seed}`);
    console.log(`  气泡 ${limits.bubbleMs}ms · 冷却 ${limits.cooldownMs}ms · 并发上限 ${limits.maxConcurrent}`);
    return 0;
  }

  if (command === 'save') {
    const loaded = loadLayer(layer);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message}`); return 1; }
    const outcome = corpus.save({ contentDir: CONTENT, characterId: CHARACTER, layer, doc: loaded.doc, dryRun: false });
    if (!outcome.ok) {
      console.error(`保存被拒：${outcome.code}`);
      for (const finding of outcome.findings || []) console.error(`  ✗ ${finding.code} ${finding.detail} → ${finding.fix}`);
      return 1;
    }
    console.log(outcome.noop ? '无变更 — 未写盘（无变更不落盘）' : `已写盘 ${outcome.file}（备份 ${outcome.backup}）`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, main, parseArgs };
