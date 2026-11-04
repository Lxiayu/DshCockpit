// test/file-size-budget.test.js — 大文件的规模预算（棘轮）。
//
// 第一性原理：为什么"文件多大"值得被测试守着
//
//   AGENTS.md 里写着 `office-module.js 上限 4800（余量 74 行）`，
//   但**没有任何测试守它**。实际查下来：
//     · office-module.js 已经 4798 行 —— 余量只剩 **2 行**
//     · main.js 文档写 6041 行，实际 **7018 行**（超了 977 行，没人发现）
//   也就是说那句"上限"是一句**愿望**，不是约束。
//
//   这不是洁癖问题。单个文件过大时：
//     · 改动的影响面难以估量（改一个函数不知道会不会碰到别处）
//     · 冲突率上升（多人并行时）
//     · 阅读成本高，新人不敢动
//   而"悄悄变大"永远不会有一次性告警 —— 只有当它已经很难改时才被发现。
//
//   所以这里做**棘轮**：
//     · 预算 = 当前实际行数（不是理想值）
//     · 只能往下调，不能往上加
//     · 要调高必须同时改这个文件和注释说明理由 —— 那会出现在 review 里
//
//   为什么不设成"理想值"（比如 800 行）：
//     定为理想值会让门禁立刻全红，然后大家把它关掉。
//     门禁的第一要求是**绿着活下去**，否则它保护不了任何东西。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * 当前预算。数字是**实测值**，不是理想值。
 * 规则：只允许调低；调高必须在 commit message 里说明理由。
 */
const BUDGET = {
  'src/main.js': 7100,              // 实测 7018；是已知债 TD-01，目标是拆分
  // ⚠️ 必须与 test/office-runtime-boundary.test.js 的**总行兜底**一致。
  //   第 47 轮我在这里写了 4850、那边是 4800 —— 同一文件两套约束，
  //   宽松的会让严格的被绕过。第 57 轮起那边的**主判据改成代码行**
  //   （去注释去空行），总行只作可读性兜底。
  'src/office/office-module.js': 5200, // 与 boundary 的总行兜底一致；代码行判据在那边（3400）
  'src/mission-desk.html': 4450,    // 实测 4381；近几轮每轮 +40 左右，需盯住
  'src/ipc-mission.js': 2950,       // 实测 2871
};

function lineCount(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8').split('\n').length;
}

test('size budget: the files it guards still exist', () => {
  // 如果文件被改名/删除，下面所有断言都会变成空气 —— 那是最糟的假绿。
  for (const rel of Object.keys(BUDGET)) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `budgeted file is missing: ${rel}`);
  }
});

test('size budget: no file exceeds its recorded budget', () => {
  const over = [];
  for (const [rel, limit] of Object.entries(BUDGET)) {
    const n = lineCount(rel);
    if (n > limit) over.push(`${rel}: ${n} > ${limit} (+${n - limit})`);
  }
  assert.deepEqual(over, [],
    `these files grew past their budget. Either split them, or raise the budget ON PURPOSE `
    + `and explain why in the commit message:\n  ${over.join('\n  ')}`);
});

test('size budget: the budget does not drift stale (it must stay close to reality)', () => {
  // 预算离实际太远，它就失去了"看守"的意义 —— 从 7100 到 8000 之间有 900 行
  // 的增长是"合法"的，而那时门禁已经形同虚设。
  // 例外：office-module 的总行兜底**故意留宽**。
  //   它的主判据是"代码行"（在 office-runtime-boundary 里守着，3400 硬线），
  //   总行只用于"别膨胀到读不动"。
  //   把兜底也压紧会导致：想加一行注释就红 —— 那正是在惩罚解释，
  //   与第 57 轮改判据的理由直接冲突。
  const INTENTIONALLY_LOOSE = new Set(['src/office/office-module.js']);
  const slack = [];
  for (const [rel, limit] of Object.entries(BUDGET)) {
    if (INTENTIONALLY_LOOSE.has(rel)) continue;
    const n = lineCount(rel);
    const gap = limit - n;
    if (gap > 200) slack.push(`${rel}: ${gap} lines of unused budget`);
  }
  assert.deepEqual(slack, [],
    `the budget has too much slack — tighten it so it actually guards something:\n  ${slack.join('\n  ')}`);
});

test('size budget: no two gates disagree about the same ceiling', () => {
  // 第一性原理：互相矛盾的门禁比没有门禁更糟
  //
  //   第 47 轮我在这个文件里给 office-module 写了 4850，
  //   而 office-runtime-boundary.test.js 一直是 4800 硬上限。
  //   同一个文件两套约束 —— 宽松的那条会让严格的那条被绕过：
  //   改到 4820 时这边绿、那边红，下一个人只会去改那边。
  //
  //   更糟的是它制造了一种错觉："这件事已经被守着了"，
  //   同时把真正的约束变成了可以商量的东西。
  //
  //   这条断言强制：本文件的预算必须与那个硬上限逐字相同。
  const boundary = fs.readFileSync(path.join(ROOT, 'test', 'office-runtime-boundary.test.js'), 'utf8');
  // 读的是**总行兜底**那条（代码行判据由 boundary 自己守，本表不重复）
  const m = boundary.match(/office-module\.js is \$\{lines\} total lines \(ceiling (\d+)\)/);
  assert.ok(m, 'the boundary gate must state its total-line ceiling in a machine-readable way');
  const hardCeiling = Number(m[1]);
  assert.equal(BUDGET['src/office/office-module.js'], hardCeiling,
    `this file budgets ${BUDGET['src/office/office-module.js']} lines but `
    + `office-runtime-boundary.test.js enforces ${hardCeiling} — the looser one silently wins`);
});

test('size budget: the biggest file is acknowledged as known debt', () => {
  // main.js 7100 行是已知债（TD-01）。这里不是要它变小，
  // 而是要求"它很大"这件事**被记录下来** —— 否则下一个人会以为这是正常状态。
  const debt = fs.readFileSync(path.join(ROOT, 'docs', 'quality', 'tech-debt-inventory.md'), 'utf8');
  assert.match(debt, /TD-01/, 'the oversized main.js must stay recorded as TD-01');
});

test('size budget: the documented numbers match reality', () => {
  // AGENTS.md 里写着 main.js 6041 行 / office-module 4726 行 —— 都过时了。
  // 文档写错数字比不写更糟：它让人以为"还好"，而实际已经逼近上限。
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const m = agents.match(/src\/main\.js[^\n]*?(\d+)\s*行/);
  if (m) {
    const documented = Number(m[1]);
    const actual = lineCount('src/main.js');
    const diff = Math.abs(actual - documented);
    assert.ok(diff < 400,
      `AGENTS.md says main.js is ${documented} lines but it is ${actual}. `
      + 'A stale number reads as "it is fine" when it is not.');
  }
  const m2 = agents.match(/office-module\.js[^\n]*?(\d+)\s*行/);
  if (m2) {
    const documented2 = Number(m2[1]);
    const actual2 = lineCount('src/office/office-module.js');
    const diff2 = Math.abs(actual2 - documented2);
    assert.ok(diff2 < 150,
      `AGENTS.md says office-module is ${documented2} lines but it is ${actual2}`);
  }
});
