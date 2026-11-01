// test/capability-packs-gate.test.js — P3 S5：CI 门禁脚本的契约。
//
// 第一性原理：门禁脚本自己也会骗人
//
//   这个项目已经踩过一次"Skip 冒充 Pass"（见 scripts/ci-gate.js 的历史）。
//   同一个坑在 capability-packs 门禁上有三种复现方式：
//
//     1. skipped 被算成通过 → "平台不支持"看起来像"验证过了"
//     2. **全部 skipped 仍然 PASS** → 门禁跑了但什么都没验证
//     3. manifest 读不出来时跳过而不断言 → 坏掉的包悄悄消失
//
//   第 2 条最阴险：它让门禁看起来在工作，实际zero coverage。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-capability-packs.js');
const raw = fs.readFileSync(SCRIPT, 'utf8');
// 断言只看代码（本项目多次因为匹配到注释而误报）
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('packs gate: the script uses the real command runner and validator', () => {
  // 门禁必须与产品同一实现，否则"CI 绿"不代表"产品能用"。
  assert.match(src, /createCommandRunner/);
  assert.match(src, /validateManifest/);
  assert.match(src, /runVerify/);
});

test('packs gate: it verifies in a TEMP dir (never touches the repo)', () => {
  // verify 命令会写文件；在仓库里跑会污染工作区。
  assert.match(src, /mkdtempSync/);
  assert.match(src, /rmSync/);
});

test('packs gate: skipped is reported separately and never counted as passed', () => {
  assert.match(src, /skipped=\$\{counts\.skipped\}/);
  assert.match(src, /NOT counted as passed/);
});

test('packs gate: ALL-skipped is a FAILURE (zero coverage is not success)', () => {
  // 这条是这个门禁最关键的断言。
  assert.match(src, /every pack was skipped, so nothing was actually verified/);
  assert.match(src, /meaningful === 0 && counts\.skipped > 0/);
});

test('packs gate: an unreadable manifest is not silently skipped', () => {
  assert.match(src, /manifest unreadable/);
  assert.match(src, /manifest invalid/);
});

test('packs gate: the four states are reported', () => {
  assert.match(src, /VERIFY_STATES/);
  for (const s of ['passed', 'failed', 'skipped', 'not-verified']) {
    assert.ok(src.includes(`counts.${s}`) || src.includes(`counts['${s}']`), `missing count for ${s}`);
  }
});

test('packs gate: exit code is non-zero on failure', () => {
  assert.match(src, /process\.exit\(1\)/);
});

// -------------------------------------------- 第一个真实 Pack 的存在性

test('packs gate: at least one real pack ships and validates', () => {
  const dir = path.join(ROOT, 'capability-packs');
  assert.ok(fs.existsSync(dir), 'capability-packs/ must exist');
  const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.ok(dirs.length >= 1, 'P3 requires at least one real pack, not just infrastructure');

  const { validateManifest } = require(path.join(ROOT, 'src', 'capability-packs', 'manifest.js'));
  for (const d of dirs) {
    const p = path.join(dir, d.name, 'manifest.json');
    assert.ok(fs.existsSync(p), `${d.name} must ship a manifest.json`);
    const r = validateManifest(JSON.parse(fs.readFileSync(p, 'utf8')));
    assert.strictEqual(r.ok, true, `${d.name} manifest invalid: ${r.errors && r.errors.join('; ')}`);
  }
});

test('packs gate: the first pack declares verify (no unverifiable packs ship)', () => {
  // "没有 verify 的 capability pack 只是文档"——manifest 校验会拒绝，
  // 但这里再从产品角度断言一次。
  const dir = path.join(ROOT, 'capability-packs');
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'manifest.json'), 'utf8'));
    assert.ok(m.verify && typeof m.verify.command === 'string' && m.verify.command.length > 0,
      `${d.name} must declare a verify command`);
  }
});
