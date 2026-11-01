// test/theme-tokens.test.js — 主题 token 完整性守门。
//
// 第一性原理：这次踩的坑是"假 token"
//
//   CSS 里写 `var(--bg-2, #22252c)` 看起来很正常——有变量、有兜底。
//   但 `--bg-2` **在 theme.css 里根本不存在**，于是永远走兜底值。
//   后果不是报错，是**浅色主题下变成深底深字，几乎看不见**。
//
//   兜底值是最危险的那种 bug：它让错误看起来像正常工作。
//
//   所以本文件断言：
//     1. 页面里引用的每个 token 都必须在 theme.css 定义
//     2. 两种主题都要定义同一套 token（否则切换主题就漏）
//     3. 页面里不允许硬编码颜色（除了少数明确的例外）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const THEME = fs.readFileSync(path.join(ROOT, 'src', 'theme.css'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');

/** 从 theme.css 的某个块里取定义的 token 名。 */
function tokensIn(block) {
  const out = new Set();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) out.add(m[1]);
  return out;
}
// 取"块"要按大括号配对，不能按下一个 /* 切——
// 浅色块内部自带注释，按 /* 切会把整块切没（第一版就是这么错的）。
function blockAt(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}
const DARK = tokensIn(blockAt(THEME, ':root {'));
const LIGHT = tokensIn(blockAt(THEME, '[data-theme="light"] {'));

test('theme: every token referenced by mission-desk is actually DEFINED', () => {
  // 只查 CSS 部分；JS 里的字符串不算样式引用
  const styleStart = DESK.indexOf('<style>');
  const styleEnd = DESK.indexOf('</style>');
  const css = DESK.slice(styleStart, styleEnd).replace(/\/\*[\s\S]*?\*\//g, '');
  const used = new Set();
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
  const undefinedTokens = [...used].filter((t) => !DARK.has(t));
  assert.deepEqual(undefinedTokens, [],
    `these tokens have no definition in theme.css — the fallback silently wins (dark bg in light theme): ${undefinedTokens.join(', ')}`);
});

test('theme: dark and light define the SAME token set (no theme-only gaps)', () => {
  // 如果某个 token 只在深色定义，浅色主题就会继承深色值 → 浅底浅字。
  const onlyDark = [...DARK].filter((t) => !LIGHT.has(t));
  // legacy 别名与 accent 是有意共享/差异的，排除后应为空
  const EXEMPT = new Set(['--radius', '--ease', '--mono',
    '--acc', '--acc-hover', '--acc-active', '--acc-soft',
    '--bg', '--panel', '--line', '--text', '--dim']);
  const real = onlyDark.filter((t) => !EXEMPT.has(t));
  assert.deepEqual(real, [],
    `these tokens exist only in the dark theme — light mode would inherit dark values: ${real.join(', ')}`);
});

test('theme: the file that motivated this guard has no hard-coded colours left', () => {
  // 允许的例外：纯黑半透明遮罩（dialog::backdrop），它与主题无关。
  const styleStart = DESK.indexOf('<style>');
  const styleEnd = DESK.indexOf('</style>');
  const css = DESK.slice(styleStart, styleEnd).replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)]
    .map((m) => m[0])
    .filter((c) => !/^rgba?\(0,\s*0,\s*0/.test(c));
  assert.deepEqual(hits, [],
    `hard-coded colours bypass the theme (invisible in one of the two themes): ${hits.join(', ')}`);
});

test('theme: the semantic attention tokens exist in BOTH themes', () => {
  // 待办区的颜色是"有语义"的（风险等级），必须两套主题都有。
  for (const t of ['--att-bad-fg', '--att-warn-fg', '--att-info-fg', '--att-ok-fg',
    '--att-idle-fg', '--tl-fg', '--tl-line']) {
    assert.ok(DARK.has(t), `${t} missing from dark theme`);
    assert.ok(LIGHT.has(t), `${t} missing from light theme`);
  }
});
