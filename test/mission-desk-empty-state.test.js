// test/mission-desk-empty-state.test.js — P4 体验打磨：空状态与错误提示。
//
// 第一性原理：空状态不是"占位文案"
//
//   用户放弃一个工具通常发生在三个时刻，其中第一个就是
//   **"第一次打开，不知道从哪开始"**。
//
//   五个"还没有记录决策 / 还没有工作流 / …" 就是一个典型的死路：
//   它准确（确实没有），但**不告诉你下一步做什么**。
//
//   所以本文件断言的不是"有没有文案"，而是：
//     · 空状态是否给出了**具体动作**
//     · 是否一次只给**一个**最关键的动作（给五个等于没给）
//     · 错误是否**保留了 code**（那是排查的唯一线索）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DESK = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');
const code = DESK.replace(/<script>[\s\S]*?<\/script>/g, ''); // CSS/HTML
const script = (DESK.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const js = script.replace(/\/\*[\s\S]*?\*\//g, '');
// 注意：不要把 `//` 行注释也剥掉再去断言"包含 ERROR_HINTS"——
// ERROR_HINTS 是个对象字面量，它的条目会被误删。查存在性用原始 script。
const jsRaw = script;

// ============================================ 空状态

test('empty state: the zero-mission case offers a CONCRETE next action', () => {
  // 不是"还没有 Mission"，而是"创建第一个 Mission"。
  assert.match(js, /创建第一个 Mission/, 'it must offer the concrete first action');
  assert.match(js, /从这里开始/, 'and frame it as the starting point');
});

test('empty state: it EXPLAINS what a Mission is (not just "none yet")', () => {
  // 新用户不知道 "Mission" 是什么。空状态是唯一能免费解释它的地方。
  assert.match(js, /一个 Mission 就是/, 'it must explain the concept');
});

test('empty state: it gives exactly ONE primary action (five choices = no choice)', () => {
  // 空状态里塞多个按钮 = 用户更难决定。
  const block = js.slice(js.indexOf('还没有 Mission') >= 0 ? 0 : 0);
  const emptySection = js.slice(js.indexOf('state.missions.length === 0'), js.indexOf('state.missions.length === 0') + 1400);
  const buttons = (emptySection.match(/el\('button'/g) || []).length;
  assert.ok(buttons <= 1, `the zero-state must offer at most one primary button, found ${buttons}`);
  void block;
});

test('empty state: the detail pane distinguishes "no missions" from "none selected"', () => {
  // 原来只有一句"选择一个 Mission"——但如果一个都没有，这个指令无解。
  assert.match(js, /还没有选中任何 Mission/, 'the no-missions case needs its own copy');
  assert.match(js, /先在左边创建你的第一个 Mission/, 'and a way out');
});

test('empty state: the detail pane explains what selecting gives you', () => {
  assert.match(js, /目标、决策、工作流和产物/, 'it must say what the user will see');
});

test('empty state: the empty block is styled as a start point, not a placeholder', () => {
  // .empty-lead 是标题（第一步），.empty-body 是解释（这是什么）。
  assert.match(code, /\.empty-lead\s*\{/, 'a lead line must be styled');
  assert.match(code, /\.empty-body\s*\{/);
  assert.match(code, /\.empty button\.primary/, 'the primary action must look actionable');
});

// ============================================ 错误提示

test('errors: every failure keeps its CODE (the only debugging clue)', () => {
  // 只给"操作失败"没法排查；只给 code 用户看不懂。必须两者都有。
  //
  // 关键：不能只断言"代码里出现过 ${code}"——那只证明某个分支有，
  // 不证明**所有分支**都有。所以这里真跑一遍函数，检查每种输入的结果。
  assert.match(jsRaw, /function explainFailure/, 'there must be one shared translator');

  // 用一个受控环境取出 explainFailure 的行为（它只依赖 ERROR_HINTS 与 code）
  const sandbox = { ERROR_HINTS: {
    DELIVERABLE_INVALID: '产物路径不对', DESK_UNAVAILABLE: '窗口还没接上',
  } };
  const fnSrc = jsRaw.slice(jsRaw.indexOf('function explainFailure'), jsRaw.indexOf('function explainFailure') + 900);
  // 找到函数结尾（第一个独占一行的 }）
  const endIdx = fnSrc.indexOf('\n}');
  const body = fnSrc.slice(0, endIdx + 2);
  const run = new Function('ERROR_HINTS', `${body}; return explainFailure;`)(sandbox.ERROR_HINTS);

  // 1) 有映射的 code：人话 + code
  const mapped = run({ code: 'DELIVERABLE_INVALID' });
  assert.match(mapped, /产物路径不对/, 'mapped failures get a human hint');
  assert.ok(mapped.includes('DELIVERABLE_INVALID'), 'and STILL keep the code for debugging');

  // 2) 无映射但有 code：通用人话 + code
  const unmapped = run({ code: 'SOME_NEW_CODE' });
  assert.ok(unmapped.includes('SOME_NEW_CODE'), 'unmapped failures must still keep the code');

  // 3) 没有 code 但有 reason：直接用 reason
  const reasonOnly = run({ reason: '文件不存在' });
  assert.match(reasonOnly, /文件不存在/);

  // 4) 什么都没有：给一句可重试的话，不能是空串
  const nothing = run({});
  assert.ok(nothing.length > 0, 'never return an empty message');
});

test('errors: user-actionable failures get an actionable hint', () => {
  // 用户能处理的问题，要告诉他怎么处理。
  const hints = ['DELIVERABLE_INVALID', 'WORKSTREAM_ID_REQUIRED', 'MISSION_ID_REQUIRED'];
  for (const h of hints) {
    assert.ok(jsRaw.includes(h), `${h} must have a human-readable hint`);
  }
});

test('errors: failures the user CANNOT fix still get plain language + code', () => {
  // 这类不该假装可操作，但也不能只说 code。
  assert.ok(jsRaw.includes('DESK_UNAVAILABLE'), 'internal failures must be mapped too');
  assert.match(jsRaw, /还没接上|操作失败/, 'with plain language');
});

test('errors: the seven duplicated failure handlers are now one function', () => {
  // 之前 7 处都是 `'失败：' + ((r && (r.reason || r.code)) || '未知错误')`。
  // 重复的错误格式化必然会漂移（有一处改了别处没改）。
  const raw = DESK.match(/失败：' \+ \(\(r && \(r\.reason \|\| r\.code\)\)/g) || [];
  assert.strictEqual(raw.length, 0, 'the old duplicated form must be gone');
  const uses = (jsRaw.match(/explainFailure\(/g) || []).length;
  assert.ok(uses >= 5, `explainFailure should be used in the write paths, found ${uses}`);
});
