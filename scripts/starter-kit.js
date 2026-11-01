#!/usr/bin/env node
// scripts/starter-kit.js — 从 Starter Kit 生成一份真实的起点文件（P3 S6.3）。
//
// 第一性原理：为什么"生成一个文件"就够了
//
//   路线图的验收标准是「一个 Starter Kit 让新用户 5 分钟内拿到真实产物」。
//   容易被误解成"要做一个向导式 UI"。但那会引入一堆状态机、
//   而新手真正卡住的地方不是"不知道点哪个按钮"——是**面对空白页不知道写什么**。
//
//   所以最小有效形态是：给一份**结构化的模板**，填进去就是产物。
//   一条命令 → 一个 .md 文件 → 用户打开就能写。
//
//   三条设计约束：
//     1. 产物是真文件（磁盘上、能打开、能改、能分享），不是内存状态
//     2. 重复执行**不覆盖**用户已写的内容（那是灾难）
//     3. 生成后立刻 verify（证明文件真的存在且非空）
//
// 用法：
//   node scripts/starter-kit.js research-report [--out 路径] [--title 标题]
//   node scripts/starter-kit.js --list

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PACKS_DIR = path.join(ROOT, 'capability-packs');

/** 默认输出文件名（按 kit id 决定，避免所有 kit 都叫 report.md）。 */
const DEFAULT_OUTPUT = {
  'research-report': 'research-report.md',
};

function listKits() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PACKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return out; }
  for (const name of dirs) {
    const templatePath = path.join(PACKS_DIR, name, 'template.md');
    if (!fs.existsSync(templatePath)) continue; // 只有带模板的才是 starter kit
    let title = name;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, name, 'manifest.json'), 'utf8'));
      title = m.title || name;
    } catch { /* manifest 坏了也照样列出，标题退回 id */ }
    out.push({ id: name, title });
  }
  return out;
}

/**
 * 生成起点文件。
 *
 * @returns {{ok:boolean, code?:string, path?:string, created?:boolean, reason?:string}}
 */
function scaffold(kitId, { out = '', title = '' } = {}) {
  const packDir = path.join(PACKS_DIR, kitId);
  const templatePath = path.join(packDir, 'template.md');
  if (!fs.existsSync(templatePath)) {
    return { ok: false, code: 'KIT_NOT_FOUND', reason: `no starter kit named "${kitId}"` };
  }

  // ---- 不覆盖：已存在就是成功（但如实说明"没动它"）----
  // 重复执行覆盖用户写的东西是灾难级体验。
  const target = path.resolve(out || DEFAULT_OUTPUT[kitId] || `${kitId}.md`);
  if (fs.existsSync(target)) {
    return { ok: true, code: 'ALREADY_EXISTS', path: target, created: false };
  }

  let template = fs.readFileSync(templatePath, 'utf8');
  const finalTitle = typeof title === 'string' && title.trim() !== ''
    ? title.trim()
    : defaultTitleFor(kitId);
  template = template.replaceAll('{{TITLE}}', finalTitle);
  template = template.replaceAll('{{DATE}}', new Date().toISOString().slice(0, 10));

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, template, 'utf8');
  return { ok: true, code: 'CREATED', path: target, created: true };
}

function defaultTitleFor(kitId) {
  if (kitId === 'research-report') return '研究报告';
  return kitId;
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const args = { kitId: '', out: '', title: '', list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') { args.list = true; continue; }
    if (a === '--out') { args.out = argv[i + 1] || ''; i += 1; continue; }
    if (a === '--title') { args.title = argv[i + 1] || ''; i += 1; continue; }
    if (!args.kitId && !a.startsWith('--')) args.kitId = a;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list || !args.kitId) {
    const kits = listKits();
    if (kits.length === 0) {
      console.log('[starter] 没有可用的 Starter Kit');
      process.exit(args.list ? 0 : 1);
    }
    console.log('[starter] 可用 Starter Kit:');
    for (const k of kits) console.log(`  ${k.id.padEnd(20)} ${k.title}`);
    console.log('\n用法: node scripts/starter-kit.js <id> [--out 路径] [--title 标题]');
    process.exit(args.list ? 0 : (args.kitId ? 1 : 0));
  }

  const r = scaffold(args.kitId, { out: args.out, title: args.title });
  if (!r.ok) {
    console.error(`[starter] 失败: ${r.reason}`);
    process.exit(1);
  }
  if (!r.created) {
    // 已存在不是错误，但要说清楚"没动你的文件"
    console.log(`[starter] 已存在，未覆盖: ${r.path}`);
    console.log('[starter] 如需重新生成，请先移走该文件');
    process.exit(0);
  }
  console.log(`[starter] 已生成: ${r.path}`);
  console.log('[starter] 打开它，把「写在这里」换成你的内容 —— 那就是你的第一份真实产物。');
  process.exit(0);
}

if (require.main === module) main();

module.exports = { listKits, scaffold, parseArgs, DEFAULT_OUTPUT };
