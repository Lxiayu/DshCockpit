#!/usr/bin/env node
// scripts/check-official-teams-shape.js — 比对官方 Agent Teams 类型定义与我们的常量。
//
// 第一性原理：为什么"我看过文档"不算验证
//
//   #23 一直挂着"需真实模型调用验证"。但字段形状其实写在官方包的
//   TypeScript 类型定义里——不需要跑模型。
//
//   真正的风险不是"现在形状对不对"，是**官方升级后形状变了而我们不知道**。
//   那时适配层会静默读到 undefined，Office 里少一个员工，没人发现。
//
//   所以这个脚本做形状比对：官方类型定义 → 我们的常量。
//   官方一变，CI 先红。
//
// 用法：
//   node scripts/check-official-teams-shape.js [--runtime-dir <path>]
//
// 退出码：0 = 一致（或没有可比对的官方包，跳过）；1 = 形状漂移

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const shape = require(path.join(ROOT, 'src', 'official-teams-shape.js'));

/** 候选位置：先看参数，再看环境变量，最后看常见的安装位置。 */
function candidateTypesFiles() {
  const out = [];
  const argIdx = process.argv.indexOf('--runtime-dir');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    out.push(path.join(process.argv[argIdx + 1], '@deepseek-ai/dsh-experimental-agent-team/lib/types/types.d.ts'));
  }
  if (process.env.DSH_POC_NODE_MODULES) {
    out.push(path.join(process.env.DSH_POC_NODE_MODULES, '@deepseek-ai/dsh-experimental-agent-team/lib/types/types.d.ts'));
  }
  // 用户 profile（生产运行时）
  out.push(path.join(os.homedir(), '.dsh', 'profiles', 'node_modules',
    '@deepseek-ai/dsh-experimental-agent-team/lib/types/types.d.ts'));
  return out;
}

/** 从 .d.ts 文本里抽出一个 interface 的字段名。 */
function fieldsOfInterface(text, name) {
  const re = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = text.match(re);
  if (!m) return null;
  const body = m[1];
  const fields = [];
  for (const line of body.split('\n')) {
    const f = line.match(/^\s+readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
    if (f) fields.push(f[1]);
  }
  return fields;
}

/** 抽 `export type X = 'a' | 'b';` 的联合值。 */
function unionOf(text, name) {
  const re = new RegExp(`export type ${name}\\s*=\\s*([^;]+);`);
  const m = text.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function compare(name, expected, actual) {
  if (!actual) return { name, status: 'missing', detail: `interface/type not found in official .d.ts` };
  const missing = expected.filter((f) => !actual.includes(f));
  if (missing.length > 0) {
    return { name, status: 'drift', detail: `missing in official: ${missing.join(', ')}` };
  }
  const added = actual.filter((f) => !expected.includes(f));
  return {
    name,
    status: added.length > 0 ? 'added' : 'match',
    detail: added.length > 0 ? `official added: ${added.join(', ')}` : 'exact match',
  };
}

function main() {
  const files = candidateTypesFiles();
  const file = files.find((f) => { try { return fs.existsSync(f); } catch { return false; } });

  if (!file) {
    // 没有官方包 → 跳过（不算失败）。CI 在装了 runtime 的环境里才真正比对。
    console.log('[teams-shape] SKIP — 未找到官方 Agent Teams 类型定义');
    console.log('[teams-shape] 提示：用 --runtime-dir 指向 <runtime>/node_modules，或设置 DSH_POC_NODE_MODULES');
    console.log('[teams-shape] 这**不是**通过，只是没有可比对的对象（Skip 不计作 Pass）');
    process.exit(0);
  }

  const text = fs.readFileSync(file, 'utf8');
  console.log(`[teams-shape] 比对源: ${file}\n`);

  const checks = [
    compare('TeamProjection', [...shape.TEAM_PROJECTION_FIELDS], fieldsOfInterface(text, 'TeamProjection')),
    compare('TeamMemberProjection', [...shape.TEAM_MEMBER_FIELDS], fieldsOfInterface(text, 'TeamMemberProjection')),
    compare('TeamTaskView', [...shape.TEAM_TASK_FIELDS], fieldsOfInterface(text, 'TeamTaskView')),
    compare('TeamMemberPhase', [...shape.TEAM_MEMBER_PHASES], unionOf(text, 'TeamMemberPhase')),
    compare('TeamTaskStatus', [...shape.TEAM_TASK_STATUSES], unionOf(text, 'TeamTaskStatus')),
  ];

  let drift = 0;
  for (const c of checks) {
    const icon = c.status === 'match' ? 'PASS' : (c.status === 'added' ? 'WARN' : 'DRIFT');
    if (c.status === 'drift' || c.status === 'missing') drift += 1;
    console.log(`[teams-shape] ${icon.padEnd(6)} ${c.name.padEnd(22)} ${c.detail}`);
  }

  if (drift > 0) {
    console.error(`\n[teams-shape] FAIL — ${drift} 处形状漂移。更新 src/official-teams-shape.js 并复核适配层。`);
    process.exit(1);
  }
  console.log('\n[teams-shape] PASS — 字段形状与官方一致');
  process.exit(0);
}

main();
