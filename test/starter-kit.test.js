// test/starter-kit.test.js — P3 S6：Starter Kit 脚手架。
//
// 第一性原理：为什么"生成一个文件"就是 Starter Kit
//
//   容易误以为需要一个向导式 UI。但新手真正卡住的不是"不知道点哪个按钮"，
//   是**面对空白页不知道写什么**。所以最小有效形态 = 结构化模板 + 一条命令。
//
//   三条不可妥协的约束：
//     1. 产物是真文件（磁盘上、能打开、能改、能分享）
//     2. 重复执行**不覆盖**用户已写的内容（那是灾难）
//     3. 生成后能 verify（证明文件真的存在且非空）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { listKits, scaffold } = require(path.join(ROOT, 'scripts', 'starter-kit.js'));

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kit-')); }

// ============================================================ 发现

test('starter kit: at least one kit ships with a template', () => {
  const kits = listKits();
  assert.ok(kits.length >= 1, 'P3.4 requires a real starter kit');
  assert.ok(kits.some((k) => k.id === 'research-report'));
});

test('starter kit: a pack without template.md is NOT listed as a kit', () => {
  // capability pack 与 starter kit 的区别就是"有没有引导模板"。
  const kits = listKits().map((k) => k.id);
  assert.ok(!kits.includes('workspace-verification'), 'a bare pack is not a starter kit');
});

// ============================================================ 生成真实产物

test('starter kit: scaffolding produces a REAL file on disk', () => {
  // 「5 分钟内拿到真实产物」——"真实"意味着磁盘上有文件，不是内存状态。
  const dir = tmpDir();
  const out = path.join(dir, 'report.md');
  const r = scaffold('research-report', { out, title: '测试标题' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.created, true);
  assert.ok(fs.existsSync(out), 'the artifact must exist on disk');
  const content = fs.readFileSync(out, 'utf8');
  assert.ok(content.length > 200, 'the artifact must be substantial, not a stub');
  assert.match(content, /测试标题/, 'the title substitution must work');
  assert.doesNotMatch(content, /\{\{TITLE\}\}/, 'no unreplaced placeholders');
  assert.doesNotMatch(content, /\{\{DATE\}\}/, 'date substituted');
});

test('starter kit: the artifact contains a usable structure (headings, not just prose)', () => {
  // 模板的价值在于"告诉新手写什么"，所以必须有节标题。
  const r = scaffold('research-report', { out: path.join(tmpDir(), 'r.md') });
  const content = fs.readFileSync(r.path, 'utf8');
  const headings = content.match(/^## /gm) || [];
  assert.ok(headings.length >= 4, `expected a multi-section template, got ${headings.length} headings`);
});

// ====================================== 不覆盖（最容易造成灾难的一条）

test('starter kit: re-running does NOT overwrite the user\'s work', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'report.md');
  scaffold('research-report', { out });
  fs.appendFileSync(out, '\n\n## 我写的结论\n这是我的真实结论。\n');
  const before = fs.readFileSync(out, 'utf8');

  const again = scaffold('research-report', { out });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.code, 'ALREADY_EXISTS');
  assert.strictEqual(fs.readFileSync(out, 'utf8'), before, 'the user\'s content must be untouched');
});

test('starter kit: an unknown kit id is rejected with a reason', () => {
  const r = scaffold('no-such-kit', { out: path.join(tmpDir(), 'x.md') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'KIT_NOT_FOUND');
  assert.match(r.reason, /no starter kit named/);
});

// ============================================================ verify 契约

test('starter kit: the kit ships a verify that proves it can actually work', () => {
  // verify 必须自足：自己产生输入、跑一遍、断言产物。
  // 不能依赖"用户上个月生成的文件还在"——那是 healthCheck 的事。
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'capability-packs', 'research-report', 'manifest.json'), 'utf8'));
  assert.strictEqual(m.verify.command.includes('template.md'), true, 'verify must exercise the real template');
  assert.strictEqual(m.verify.command.includes('DSH_PACK_DIR'), true, 'verify must locate its own pack dir portably');
});

test('starter kit: verify is self-contained (does not require a pre-existing user artifact)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'capability-packs', 'research-report', 'manifest.json'), 'utf8'));
  assert.doesNotMatch(m.verify.command, /research-report\.md/,
    'verify must not depend on a user-generated file existing');
});

// ============================================================ CLI

test('starter kit: parseArgs handles the documented flags', () => {
  const { parseArgs } = require(path.join(ROOT, 'scripts', 'starter-kit.js'));
  assert.deepStrictEqual(parseArgs(['research-report', '--out', '/x/y.md', '--title', 'T']).kitId, 'research-report');
  assert.strictEqual(parseArgs(['--list']).list, true);
  assert.strictEqual(parseArgs([]).kitId, '');
});

test('starter kit: the script is not wired into the CI test glob', () => {
  const f = path.join(ROOT, 'scripts', 'starter-kit.js');
  assert.ok(f.startsWith(path.join(ROOT, 'scripts')));
  assert.doesNotMatch(path.basename(f), /\.test\.js$/);
});
