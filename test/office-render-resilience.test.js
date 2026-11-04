// test/office-render-resilience.test.js — 办公室面板：一块坏了不许吃掉整页。
//
// 第一性原理：与右栏第 38 轮是同一个缺陷
//
//   mission-desk 曾经把 9 个渲染块裸串联。任何一个抛错，
//   后面的全部不执行 —— 表现是"面板莫名少了几块"，
//   而控制台之外没有任何提示。
//
//   第 38 轮在右栏修掉了（加了 safe() 逐块渲染）。
//   但办公室侧（office.html 的 renderAll）**从未修过**：
//   9 个渲染调用、零 try/catch。
//
//   这不是"两处都写了同样的 bug"，而是
//   **修了一处就以为同类问题都解决了**。
//   所以这个文件的断言要能挡住"新加一个渲染块但忘了保护"。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { stripComments } = require('./helpers/source-scan.js');

const RAW = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
const CODE = stripComments(RAW);

/** 取 renderAll 的函数体（按花括号配平）。 */
function renderAllBody() {
  const i = CODE.indexOf('function renderAll()');
  assert.ok(i !== -1, 'renderAll must exist in office.html');
  const start = CODE.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < CODE.length; j += 1) {
    if (CODE[j] === '{') depth += 1;
    else if (CODE[j] === '}') {
      depth -= 1;
      if (depth === 0) return CODE.slice(start, j + 1);
    }
  }
  throw new Error('unbalanced braces in renderAll');
}

test('office resilience: renderAll wraps every block in a guard', () => {
  const body = renderAllBody();
  assert.match(body, /safeRender/, 'renderAll must use a per-block guard');
  assert.match(body, /try\s*\{/, 'the guard must actually try');
  assert.match(body, /catch/, 'the guard must actually catch');
});

test('office resilience: NO block is rendered bare (every call goes through the guard)', () => {
  // 这是最关键的断言：新增一个渲染块时，如果直接写 renderXxx(snapshot)
  // 而不是 safeRender('x', () => renderXxx(snapshot))，就会漏出保护网。
  const body = renderAllBody();
  // 去掉 safeRender(...) 包裹后，函数体里不应再有顶格的 renderXxx( 调用
  const withoutGuarded = body.replace(/safeRender\([^,]+,\s*\(\)\s*=>\s*render[A-Za-z]+\([^)]*\)\)/g, '');
  const bare = [...withoutGuarded.matchAll(/render[A-Z][A-Za-z]*\s*\(/g)].map((m) => m[0]);
  assert.deepEqual(bare, [],
    `these render calls are NOT wrapped in the guard, so a throw there blanks everything after it:\n  ${bare.join('\n  ')}`);
});

test('office resilience: the guard count matches the number of rendered blocks', () => {
  // 只数 safeRender 出现次数不足以说明"每个块都被保护了" ——
  // 但如果数量少于已知的区块数，说明有块被漏掉了。
  const body = renderAllBody();
  const guarded = [...body.matchAll(/safeRender\(/g)].length;
  assert.ok(guarded >= 8,
    `expected every render block to be guarded, found only ${guarded} guard calls`);
});

test('office resilience: a failure is logged, never silently swallowed', () => {
  // 静默失败比空白更糟：出问题时连线索都没有。
  const body = renderAllBody();
  assert.match(body, /console\.error/,
    'a failed block must leave a trace — silence is worse than a blank area');
});

test('office resilience: the null-snapshot path is guarded too', () => {
  // 没有快照时的两个调用同样可能抛错（比如桥还没就绪）。
  const body = renderAllBody();
  const nullBranch = body.slice(0, body.indexOf('const snapshot') === -1 ? body.length : body.length);
  assert.match(nullBranch, /safeRender\('details'/,
    'the no-snapshot branch must be guarded as well');
});

test('office resilience: mission-desk uses the same pattern (no divergence)', () => {
  // 两个界面应当用同一套思路。如果一个有保护、另一个没有，
  // 下一个人改动时很容易照抄没有的那个。
  const desk = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8'));
  assert.match(desk, /const safe = \(name, fn\)/, 'the desk must keep its per-block guard');
  assert.match(desk, /safe\(\s*'/, 'and must actually use it');
});
