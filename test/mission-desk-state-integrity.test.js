// test/mission-desk-state-integrity.test.js — state 字段不许"只读不写"。
//
// 第一性原理：为什么一个永远 undefined 的字段值得被测试守着
//
//   `state.linkSessionId` 曾经存在：它被读取一次（`|| 'manual-link'` 的左边），
//   却**从未被赋值**。功能上无害（永远走 fallback），
//   但它消耗的是**读代码的人的判断力**：
//     · 会以为"有个字段还没接上"，顺着找下去
//     · 会猜它本该由谁填、什么时候填
//     · 最后发现它是个幽灵
//
//   这类"幽灵字段"是重构尾巴上最常见的东西：功能被换掉了，
//   读取点还在，没人删。它不报错、不影响行为，只是持续制造困惑。
//
//   所以这里机械地查：右栏读取的每个 state.X，必须有地方写过它。
//   豁免清单要写理由 —— 否则又会变成"加进清单就没事"。
'use strict';

const { test } = require('node:test');
const { stripComments } = require('./helpers/source-scan.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');

// ⚠️ 必须先剥掉注释再扫描。
//   本次清理的那段注释里**正好写着** `state.linkSessionId`（解释它为何是幽灵字段），
//   不剥的话会把那段说明当成"还在用" —— 我第一版就是这样误报的。
//   （这已经是本项目第四次因为"注释里提到某个词"导致断言误判。）
// 用共享实现（行注释 / 行尾注释 / 块注释 全剔）
const HTML = stripComments(RAW);

/**
 * 允许存在"只读不写"的字段 —— 必须写理由。
 * 空对象是刻意的：目前一个都没有。
 */
const ALLOWED_READ_ONLY = {};

/** 右栏读取的 state 字段。 */
function readFields() {
  const names = new Set();
  for (const m of HTML.matchAll(/state\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/** 是否有地方写过它（赋值 / 属性赋值 / 下标赋值 都算）。 */
function isWritten(field) {
  const patterns = [
    new RegExp(`state\\.${field}\\s*=[^=]`),            // state.x =
    new RegExp(`state\\.${field}\\[[^\\]]+\\]\\s*=[^=]`), // state.x[k] =
    new RegExp(`state\\.${field}\\.[a-zA-Z]+\\s*=[^=]`), // state.x.y =
  ];
  return patterns.some((re) => re.test(HTML));
}

test('state integrity: the scan actually sees a real state object', () => {
  const fields = readFields();
  assert.ok(fields.length >= 10,
    `expected a real state surface, found only: ${fields.join(', ')}`);
});

test('state integrity: no field is read without ever being written', () => {
  const phantoms = readFields().filter((f) => !isWritten(f) && !(f in ALLOWED_READ_ONLY));
  assert.deepEqual(phantoms, [],
    `these state fields are READ but never WRITTEN — they are always undefined, and they make `
    + `readers think a feature is half-finished:\n  ${phantoms.join('\n  ')}`);
});

test('state integrity: the allowance list stays empty (no quiet accumulation)', () => {
  // 如果将来有人往清单里加东西，这条会提醒 review 去看理由。
  const count = Object.keys(ALLOWED_READ_ONLY).length;
  assert.ok(count === 0,
    `ALLOWED_READ_ONLY has ${count} entries. Each needs a reason in this file — `
    + `and "it is convenient" is not one.`);
});

test('state integrity: the "manual-link" placeholder is a literal, not a dead field', () => {
  // 这条锁住本次清理的结果：手工登记执行就是没有真实 sessionId，
  // 应当写死常量并说明，而不是留一个永远 undefined 的字段。
  assert.match(HTML, /sessionId: 'manual-link'/,
    'manual execution registration must use a literal, not a phantom field');
});
