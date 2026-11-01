#!/usr/bin/env node
// scripts/verify-capability-packs.js — 在 CI 里跑所有 Capability Pack 的 verify（P3 S5）。
//
// 第一性原理：为什么这个脚本必须存在
//
//   路线图验收标准 4：「verify 脚本在 CI 可跑（不需要真机）」。
//
//   如果 verify 只能在真机上跑，它就不是门禁，只是"偶尔想起来跑一下"。
//   CI 跑不了 = 坏了没人知道 = verify 变成装饰。
//
//   所以这个脚本：
//     · 用真实的 command-runner（与产品同一实现）
//     · 用真实的 manifest 校验
//     · 在临时目录里跑（不污染仓库）
//     · 四态输出，skipped 不计作 passed
//
// 用法：
//   node scripts/verify-capability-packs.js [--json]
//
// 退出码：0 = 全部 passed（skipped 不算失败但也**不算通过**，会单独列出）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PACKS_DIR = path.join(ROOT, 'capability-packs');

const { validateManifest } = require(path.join(ROOT, 'src', 'capability-packs', 'manifest.js'));
const { runVerify, VERIFY_STATES } = require(path.join(ROOT, 'src', 'capability-packs', 'verify.js'));
const { createCommandRunner } = require(path.join(ROOT, 'src', 'work', 'command-runner.js'));

async function main() {
  const jsonOut = process.argv.includes('--json');
  const runner = createCommandRunner();
  // 每个 Pack 在独立的临时目录里验证——verify 会写文件，不能污染仓库
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-verify-'));
  const results = [];

  let packDirs = [];
  try {
    packDirs = fs.readdirSync(PACKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch { /* 目录不存在 → 零个 Pack，不算失败 */ }

  for (const name of packDirs) {
    const manifestPath = path.join(PACKS_DIR, name, 'manifest.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      results.push({ id: name, state: 'not-verified', reason: `manifest unreadable: ${error.message}` });
      continue;
    }
    const validated = validateManifest(raw);
    if (!validated.ok) {
      results.push({ id: name, state: 'not-verified', reason: `manifest invalid: ${validated.errors.join('; ')}` });
      continue;
    }
    // 注入包目录：verify 命令不能靠相对路径（CI 在临时目录里跑），
    // 必须能定位到自己的包。这是 verify 可移植的关键。
    const verify = await runVerify(validated.value, {
      runner,
      cwd: workDir,
      env: { DSH_PACK_DIR: path.join(PACKS_DIR, name) },
    });
    results.push({ id: validated.value.id, version: validated.value.version, ...verify });
  }

  fs.rmSync(workDir, { recursive: true, force: true });

  if (jsonOut) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) {
      const label = r.state === 'passed' ? 'PASS' : r.state.toUpperCase();
      console.log(`[packs] ${label.padEnd(12)} ${r.id}${r.version ? `@${r.version}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
    }
    if (results.length === 0) console.log('[packs] no capability packs found');
  }

  const counts = VERIFY_STATES.reduce((acc, s) => { acc[s] = results.filter((r) => r.state === s).length; return acc; }, {});
  // 四态报告：skipped 明确列出来，不让它悄悄通过
  if (!jsonOut) {
    console.log(`[packs] passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} not-verified=${counts['not-verified']}`);
    if (counts.skipped > 0) {
      console.log('[packs] NOTE: skipped packs are NOT counted as passed (platform-limited)');
    }
  }

  // 有 failed / not-verified 就失败。skipped 不算失败，但也不算通过——
  // 如果**全部**都是 skipped，说明这个门禁什么都没验证，应当失败。
  const meaningful = counts.passed + counts.failed + counts['not-verified'];
  if (counts.failed > 0 || counts['not-verified'] > 0) {
    console.error('[packs] FAIL');
    process.exit(1);
  }
  if (meaningful === 0 && counts.skipped > 0) {
    console.error('[packs] FAIL — every pack was skipped, so nothing was actually verified');
    process.exit(1);
  }
  console.log('[packs] PASS');
  process.exit(0);
}

main().catch((e) => { console.error('[packs] crashed:', e && e.stack || e); process.exit(1); });
