// test/office-presentation-allowlist.test.js — 展示字段白名单必须覆盖前端真正读的字段。
//
// 第一性原理：白名单是隐私闸门，但它同时是"漏一个就显示错误"的闸门
//
//   office-module 的 redactSnapshot 只透传 PRESENTATION_ALLOWLIST 里的字段，
//   其余一律丢弃（这是隐私设计，正确）。但副作用是：
//   **字段在 buildSnapshot 里构造得再完整，只要不在白名单里，前端就永远读到 undefined。**
//
//   本轮实测到的那个：
//     artifacts 被完整构造（只含 count + 闭集 kinds，不含 id/路径/内容），
//     但不在白名单 -> 前端
//       employee.artifacts ? String(employee.artifacts.count) : '0'
//     **永远走 else** —— 成员卡上的「产物」一直是 0。
//
//   它不报错、不告警，只是一个**永远正确的错误数字**。
//   这类缺陷比崩溃更危险：崩溃会被发现，错误数字会被相信。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULE = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8');
const { stripComments } = require('./helpers/source-scan.js');

/** 白名单里的字段。 */
function allowlist() {
  const m = MODULE.match(/const PRESENTATION_ALLOWLIST = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'PRESENTATION_ALLOWLIST must exist');
  return [...m[1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((x) => x[1]);
}

/** buildSnapshot 里实际构造到 employee 上的字段（取 `xxx:` 形式）。 */
function builtEmployeeFields() {
  const i = MODULE.indexOf('artifacts: Object.freeze({');
  assert.ok(i !== -1, 'the employee construction block must be findable');
  // 向前后各取一段，收集 `name:` 形式的键
  const block = MODULE.slice(Math.max(0, i - 3000), i + 3000);
  const names = new Set();
  for (const m of block.matchAll(/^\s{8}([a-zA-Z][a-zA-Z0-9]*):/gm)) names.add(m[1]);
  return [...names];
}

test('allowlist: it is a real, non-empty gate', () => {
  const list = allowlist();
  assert.ok(list.length >= 8, `expected a real allowlist, found: ${list.join(', ')}`);
});

test('allowlist: artifacts is allowed through (it was silently dropped)', () => {
  // 单独钉住这一条：它是真实漏掉过的那个。
  assert.ok(allowlist().includes('artifacts'),
    'artifacts is built in the snapshot but must be allowlisted, otherwise the member card '
    + 'always shows 0 artifacts');
});

test('allowlist: every employee field the HTML reads is allowlisted', () => {
  // 这条才是真正要紧的：**前端读到的字段必须在白名单里**。
  //
  // 第一版写的是"buildSnapshot 构造的每个字段都要么在白名单、要么在内部清单里" ——
  // 那需要手工维护一份内部字段名单，而名单永远追不上代码（实测连续漏了 14 个）。
  // 手写清单的问题不是"列不全"，而是**它把判断责任放在了最容易过时的地方**。
  //
  // 现在改成从 office.html 反查：它读了 employee.X，X 就必须在白名单里。
  // 这直接对应真实故障模式 —— 读了但被丢掉 => 永远是 undefined。
  const html = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8'));
  const read = new Set(
    [...html.matchAll(/\bemployee\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]),
  );
  assert.ok(read.size >= 2, `expected office.html to read some employee fields, found: ${[...read].join(', ')}`);
  const allowed = new Set(allowlist());
  const missing = [...read].filter((f) => !allowed.has(f));
  assert.deepEqual(missing, [],
    `office.html reads these employee fields but they are NOT allowlisted, `
    + `so it always gets undefined:\n  ${missing.join('\n  ')}`);
});

test('allowlist: nothing privacy-sensitive is allowlisted', () => {
  // 白名单是隐私闸门，加错东西比漏加更严重。
  const FORBIDDEN = ['sessionId', 'prompt', 'content', 'text', 'path', 'absPath', 'cwd', 'args', 'toolArgs'];
  const leaked = allowlist().filter((f) => FORBIDDEN.includes(f));
  assert.deepEqual(leaked, [],
    `these fields must never cross the snapshot boundary:\n  ${leaked.join('\n  ')}`);
});

test('allowlist: artifacts carries only counts and closed-set kinds (no paths/ids/content)', () => {
  const code = stripComments(MODULE);
  const i = code.indexOf('artifacts: Object.freeze({');
  assert.ok(i !== -1);
  const shape = code.slice(i, i + 300);
  assert.match(shape, /count:/, 'artifacts must carry a count');
  assert.match(shape, /kinds:/, 'and a per-kind count map');
  // 这三个一旦出现在 artifacts 里就是隐私事故
  assert.doesNotMatch(shape, /\b(path|relPath|absPath|digest|content)\s*:/,
    'artifacts must never carry a path, digest or content — only counts');
});

test('allowlist: the UI field it feeds is actually read by office.html', () => {
  // 反过来确认这条白名单项不是"加了但没人用"。
  const html = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8'));
  assert.match(html, /employee\.artifacts/,
    'office.html must read employee.artifacts — otherwise the allowlist entry is pointless');
});
