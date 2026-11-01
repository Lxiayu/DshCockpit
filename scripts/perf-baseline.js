#!/usr/bin/env node
// scripts/perf-baseline.js — 在真实数据上测量热路径耗时（P4 性能基线）。
//
// 第一性原理：为什么要在"真实数据"上测
//
//   合成基准（跑一个空循环）只能证明 CPU 快，不能证明**这个应用**快。
//   用户感受到的慢来自具体操作：打开设置页、读凭据、扫能力包目录。
//
//   所以这里直接调真实的模块，在一个临时目录里模拟真实文件布局。
//
// 用法：
//   node scripts/perf-baseline.js            # 人类可读
//   node scripts/perf-baseline.js --json     # CI 用
//
// 退出码：0 = 全部在预算内；1 = 有超预算项（CI 会红）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createPerfCollector, checkBudget } = require(path.join(ROOT, 'src', 'perf-baseline.js'));

// 预算（macOS 基准）。Windows 上有杀毒软件时通常是 2-5 倍，
// 所以这里给的是"macOS 上不该超过"的上限，CI 只挡明显退化。
const BUDGET = {
  'credentials:read': { maxAvgMs: 5 },
  'credentials:write': { maxAvgMs: 20 },
  'settings:patch': { maxAvgMs: 20 },
  'packs:scan-manifests': { maxAvgMs: 30 },
  'packs:installer-list': { maxAvgMs: 10 },
};

function main() {
  const json = process.argv.includes('--json');
  const c = createPerfCollector();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perf-'));

  // ---- 造一个"真实"的凭据文件（含已有的 key 和 records 段）----
  const credFile = path.join(tmp, '.credentials.yaml');
  fs.writeFileSync(credFile, [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '  OPENDESIGN_API_KEY: od-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: cccccccccccccccccccccccc',
  ].join('\n'));

  const mm = require(path.join(ROOT, 'src', 'models-manager.js'));
  const { upsertCredential, readCredential } = mm;

  // 迭代次数：够多才能看出平均值，又不至于让 CI 变慢
  const N = 200;

  for (let i = 0; i < N; i += 1) {
    c.time('credentials:read', () => readCredential(fs.readFileSync(credFile, 'utf8'), 'STEP_API_KEY'));
  }
  for (let i = 0; i < N; i += 1) {
    c.time('credentials:write', () => {
      const text = fs.readFileSync(credFile, 'utf8');
      fs.writeFileSync(credFile, upsertCredential(text, 'STEP_API_KEY', 'sk-perf'));
    });
  }

  // ---- capability packs 的 manifest 扫描 ----
  const PACKS = path.join(ROOT, 'capability-packs');
  const { validateManifest } = require(path.join(ROOT, 'src', 'capability-packs', 'manifest.js'));
  const packDirs = fs.readdirSync(PACKS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (let i = 0; i < 50; i += 1) {
    c.time('packs:scan-manifests', () => {
      for (const name of packDirs) {
        const raw = JSON.parse(fs.readFileSync(path.join(PACKS, name, 'manifest.json'), 'utf8'));
        validateManifest(raw);
      }
    });
  }

  // ---- 安装记录的读取（每次 IPC 都会走）----
  const { createCapabilityInstaller } = require(path.join(ROOT, 'src', 'capability-packs', 'installer.js'));
  const inst = createCapabilityInstaller({ dataDir: path.join(tmp, 'packs'), runner: { run: async () => ({ exitCode: 0 }) } });
  for (let i = 0; i < N; i += 1) c.time('packs:installer-list', () => inst.list());

  const snap = c.snapshot();
  const budgetResult = checkBudget(snap.samples, BUDGET);

  if (json) {
    console.log(JSON.stringify({ samples: snap.samples, budget: budgetResult }, null, 2));
  } else {
    console.log('[perf] 真实数据热路径耗时（macOS 基准）\n');
    console.log('  ' + 'label'.padEnd(26) + 'count'.padStart(7) + 'avg(ms)'.padStart(10) + 'max(ms)'.padStart(10) + 'total(ms)'.padStart(11));
    for (const s of snap.samples) {
      console.log('  ' + s.label.padEnd(26) + String(s.count).padStart(7) + String(s.avgMs).padStart(10) + String(s.maxMs).padStart(10) + String(s.totalMs).padStart(11));
    }
    console.log('');
    if (budgetResult.ok) console.log('[perf] PASS — 全部在预算内');
    else {
      console.log('[perf] FAIL — 超预算项：');
      for (const v of budgetResult.violations) console.log(`  ${v.label} ${v.metric}=${v.actual} > ${v.budget}`);
    }
    console.log('[perf] 注意：Windows + 杀毒实时扫描下通常是这些数字的 2–5 倍。');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(budgetResult.ok ? 0 : 1);
}

main();
