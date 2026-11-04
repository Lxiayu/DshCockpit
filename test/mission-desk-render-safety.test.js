// test/mission-desk-render-safety.test.js — 右栏渲染的健壮性门禁（S7）。
//
// 第一性原理：一个可选字段不该让整块 UI 白屏
//
//   本轮实测踩到的真实 bug：`team.writeScopeWarnings` 在投影里可能缺省
//   （队友未启用 team profile 时），渲染代码直接 `.length` →
//   TypeError → **renderTeamTasks 之后的整段右栏都不渲染**。
//
//   表现是"右栏莫名少了一大半"，而控制台之外没有任何提示。
//   用户看到的是一个安静的、缺块的界面 —— 比报错更迷惑。
//
//   这些字段的来源是官方投影，官方也没承诺"永远存在"。
//   所以对每一个可选的数组字段，渲染前都必须做 Array.isArray 检查。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');

/** 投影里**可能缺省**的数组字段（官方未承诺恒存在）。 */
const OPTIONAL_ARRAY_FIELDS = [
  'writeScopeWarnings',
  'writeScopes',
  'blockedBy',
];

test('render safety: optional projection arrays are never read with a bare .length', () => {
  // 只检查**读**（.length / .map / .join / .forEach 直接跟在字段名后），
  // 不检查赋值或 Array.isArray 保护自身。
  const offenses = [];
  for (const field of OPTIONAL_ARRAY_FIELDS) {
    // 匹配 `X.field.` 的读法，其中 X 是 t / task / item 之类
    const re = new RegExp(`\\b\\w+\\.${field}\\s*\\.\\s*(length|map|join|forEach|filter|slice)`, 'g');
    let m;
    while ((m = re.exec(HTML)) !== null) {
      const before = HTML.slice(Math.max(0, m.index - 200), m.index);
      const lineStart = HTML.lastIndexOf('\n', m.index) + 1;
      const line = HTML.slice(lineStart, HTML.indexOf('\n', m.index));
      // 若同一行或前一行已有 Array.isArray 保护，则放行
      if (/Array\.isArray/.test(line)) continue;
      if (/Array\.isArray\(\s*\w+\.\w+\s*\)/.test(before.slice(-120))) continue;
      offenses.push(`${field}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenses, [],
    `optional projection arrays read without a guard — one missing field blanks the whole rail:\n  ${offenses.join('\n  ')}`);
});

test('render safety: writeScopeWarnings is explicitly guarded in the team task renderer', () => {
  // 这是本轮真实踩到的那个字段，单独钉住。
  assert.match(HTML, /Array\.isArray\(\s*t\.writeScopeWarnings\s*\)/,
    'writeScopeWarnings must be guarded: it is absent when the team profile is off');
});

test('render safety: blockedBy is guarded at its source', () => {
  // blockedBy 同样来自官方投影。要求：读取前先归一化成本地数组。
  //
  // 注意判定方式：不是逐行找 .length（那样会把已经安全的局部变量误判），
  // 而是要求存在 `const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy : []`
  // 这样的**归一化语句**，且此后的读都用 `blockedBy` 而不是 `t.blockedBy`。
  assert.match(HTML, /const\s+blockedBy\s*=\s*Array\.isArray\(\s*t\.blockedBy\s*\)\s*\?\s*t\.blockedBy\s*:\s*\[\s*\]/,
    'blockedBy must be normalised into a local array before use');
  // 归一化之后不许再出现对原始字段的直接读
  const after = HTML.slice(HTML.indexOf('const blockedBy = Array.isArray(t.blockedBy)'));
  assert.doesNotMatch(after.slice(0, 2000), /t\.blockedBy\s*\./,
    'after normalisation the raw t.blockedBy must not be dereferenced again');
});

// ---------------------------------------------------------------------------
// 折叠区（§6.2 第 6 块）
// ---------------------------------------------------------------------------
//
// 第一性原理：折叠不是"藏起来"，是**分层**
//
//   右栏 380px，用户 80% 的时候只关心三件事：
//   要我拍板什么、事情做到哪了、谁在做什么。
//   查阅型内容（决策/发现/证据/工作流/产物/Brief/审计）需要时才找。
//
//   但折叠有两条硬约束，否则它会从"分层"退化成"藏起重要东西"：
//     1. **数量必须显示** —— `交付物 · 1` 比 `交付物` 多告诉用户"里面有事"，
//        否则没有动机点开。
//     2. **有内容且是"悬而未决"的必须默认展开** —— 未决问题属于此类。
//        默认关掉它等于把该处理的事藏起来。

test('collapse: the collapsible helper exists and lazily renders', () => {
  const src = HTML;
  assert.match(src, /function collapsibleSection\(\{/,
    'a shared collapsible helper must exist (one implementation, not five copies)');
  // 懒渲染：body 只在展开时构造
  assert.match(src, /let rendered = false;[\s\S]{0,400}if \(rendered\) return;/,
    'collapsible bodies must render lazily — 380px first screen cannot pay for everything');
});

test('collapse: a collapsed body that throws does not blank the whole rail', () => {
  // 与 writeScopeWarnings 那个 bug 同类：一块内容出错不该让整页空掉。
  assert.match(HTML, /catch \(err\)[\s\S]{0,300}coll-error/,
    'the collapsible body must catch render errors and show a local message');
});

test('collapse: review-type blocks are collapsed, but the count is shown', () => {
  for (const title of ['工作流', '关联执行', '交付物', 'Brief 与诊断']) {
    assert.ok(HTML.includes(`title: '${title}',`),
      `${title} must be a collapsible section`);
  }
  // 数量徽标：有 count 的区块必须在标题旁显示它
  assert.match(HTML, /coll-count/);
});

test('collapse: 未决问题 opens by DEFAULT when there are questions', () => {
  // 这一条防的是"把该你决定的事藏起来"。
  assert.match(HTML, /title: '未决问题',[\s\S]{0,200}open: qCount > 0/,
    'unresolved questions must be expanded when non-empty — never hide pending decisions');
});

test('collapse: the team roster is NOT collapsed (it answers "who is doing what")', () => {
  // 团队成员属于用户三大问题之一，不能被收进折叠区。
  // ⚠️ 断言的是**意图**（顶层渲染、不在折叠区里），不是具体写法。
  //    早期钉死 `box.append(renderTeamMembers(m));`，后来为加渲染兜底
  //    改成 `safe('团队成员', () => renderTeamMembers(m));` ——
  //    意图没变，但测试红了。测试锁实现细节会在正确的重构上误报。
  assert.match(HTML, /(box\.append\(|safe\('[^']*', \(\) => )renderTeamMembers\(m\)/,
    'the roster must be rendered at the top level (not inside a collapsible)');
  assert.doesNotMatch(HTML, /title: '团队成员',[\s\S]{0,120}render: \(\) => renderTeamMembers/,
    'the roster must not be wrapped in a collapsible');
});

// ---------------------------------------------------------------------------
// 右栏消费 rail-order 的分层输出（S7 接线）
// ---------------------------------------------------------------------------
//
// 第一性原理：为什么"哪些算需要你"只能有**一个**判断处
//
//   后端 src/mission/rail-order.js 做了严格分层并配了 13 条测试：
//     decision（approval/question/plan-review/conflict）→ 阻塞团队
//     reminder（inbox/permission-risk/blocked/stale-owner）→ 不阻塞
//
//   前端如果也判断一遍，两边规则迟早漂移，而漂移的表现是
//   "某个审批被悄悄归到提醒里"——用户不会发现，团队会一直卡着。
//
//   所以前端只做呈现：用 header 的计数与 tone 决定外观，
//   用 visible 决定首屏放哪几条，用 overflow 决定要不要提示"还有 N 条"。

test('rail: the desk consumes the backend rail field instead of re-deciding', () => {
  assert.match(HTML, /const rail = a\.rail \|\| null;/,
    'the desk must read a.rail (single source of truth for the layering)');
});

test('rail: overflow is ALWAYS stated, never silently truncated', () => {
  // 静默截断是最危险的"省略"：用户会以为就这些，
  // 而漏掉的那条按风险排序可能正是最紧急的。
  assert.match(HTML, /rail\.overflow\.decisions > 0/,
    'when decisions exceed the first screen, the count must be shown');
  assert.match(HTML, /还有 \$\{rail\.overflow\.decisions\} 项待处理/,
    'the hint must state the exact number');
});

test('rail: the unknown tone is handled (absent data must not read as all-clear)', () => {
  // 后端 rail-order 对"数据源缺席"返回 tone: 'unknown'。
  // 前端不能把它渲染成"团队运行正常"。
  assert.match(HTML, /待办状态未知/,
    'the desk must have an explicit "unknown" presentation');
});

test('rail: decision count in the badge comes from the backend, not a re-count', () => {
  // 徽标上的数字必须来自后端 header，否则又出现第二个判断处。
  assert.match(HTML, /rail\.header/,
    'the badge must read rail.header rather than counting items itself');
});
