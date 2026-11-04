// test/office-mission-board-stale.test.js — 看板的"可能已过期"标记必须真的会亮。
//
// 第一性原理：两个不同的问题被混成了一个判断
//
//   currentMissionBoard() 里有两个时间概念，它们回答不同的问题：
//     TTL   —— 多久重新读一次盘（性能）
//     stale —— 这份数据对用户来说还新不新（诚实）
//
//   原实现把两者写成了互斥条件：
//     命中条件:  age < TTL
//     stale:     age > TTL
//   —— 于是**只要缓存命中，stale 就必然是 false**。
//
//   后果不是"少一个提示"，而是**说了假话**：
//   office.html 第 1065 行直接用它决定要不要显示"可能已过期"。
//   用户看到的是一份可能很旧的数据，界面却笃定地当作新鲜数据展示，
//   并且**永远不会**提示自己去刷新。
//
//   正确判据是**数据自身的年龄**（与 mission-board.js 的 STALE_AFTER_MS 一致），
//   与"缓存是否命中"无关。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildMissionBoard, STALE_AFTER_MS } = require('../src/office/mission-board.js');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const { stripComments } = require('./helpers/source-scan.js');

test('stale: buildMissionBoard marks fresh data as fresh', () => {
  const r = buildMissionBoard({ projection: { missions: [] }, observedAtMs: 1000, nowMs: 1000 + 1000 });
  assert.equal(r.stale, false);
});

test('stale: buildMissionBoard marks old data as stale', () => {
  const r = buildMissionBoard({ projection: { missions: [] }, observedAtMs: 1000, nowMs: 1000 + STALE_AFTER_MS + 1 });
  assert.equal(r.stale, true);
});

test('stale: the cached branch recomputes stale from DATA AGE, not from the TTL', () => {
  // 这是核心断言。源码级检查：缓存命中分支里必须基于 observedAtMs 计算，
  // 不能出现 "age > TTL" 这种与命中条件互斥的写法。
  const code = stripComments(MAIN);
  const fnStart = code.indexOf('function currentMissionBoard()');
  assert.ok(fnStart !== -1, 'currentMissionBoard must exist');
  const fn = code.slice(fnStart, fnStart + 2000);

  assert.match(fn, /observedAtMs/,
    'the cached branch must compute stale from the data age (observedAtMs)');
  assert.doesNotMatch(fn, /stale:\s*\(now\s*-\s*missionBoardCache\.readAtMs\)\s*>\s*MISSION_BOARD_TTL_MS/,
    'stale must NOT be "age > TTL" — that condition is mutually exclusive with the cache hit '
    + 'and therefore always false');
  // 反向也要查：不能因为"别写成 bug"就干脆写死 false。
  // 上一版只做了 doesNotMatch，于是把 stale 写死 false 的变异完全逃过了。
  assert.doesNotMatch(fn, /stale:\s*false\s*,/,
    'stale must not be hardcoded false — that is the same lie with less code');
  assert.match(fn, /stale:\s*Number\.isFinite\(age\)/,
    'the cached branch must actually COMPUTE stale from the data age');
});

test('stale: the threshold is shared with mission-board.js, not duplicated', () => {
  // 两处各写一个 30_000，迟早漂移；漂移的表现是"看板说过期但实际没过期"。
  const code = stripComments(MAIN);
  assert.match(code, /missionBoardStaleAfterMs/,
    'the stale threshold must come from mission-board.js, not be re-hardcoded');
  const fnStart = code.indexOf('function missionBoardStaleAfterMs()');
  assert.ok(fnStart !== -1);
  const fn = code.slice(fnStart, fnStart + 500);
  assert.match(fn, /STALE_AFTER_MS/, 'it must read STALE_AFTER_MS from mission-board');
});

test('stale: the cache TTL and the stale threshold stay aligned in value', () => {
  const ttl = Number((MAIN.match(/const MISSION_BOARD_TTL_MS = ([\d_]+);/) || [])[1].replace(/_/g, ''));
  assert.equal(ttl, STALE_AFTER_MS,
    `MISSION_BOARD_TTL_MS (${ttl}) should track STALE_AFTER_MS (${STALE_AFTER_MS}); `
    + 'if they diverge, the desk could refetch before data is stale (wasteful) '
    + 'or serve stale data without refetching (dishonest)');
});

test('stale: a read failure reports stale=true (never pretends to be fresh)', () => {
  const code = stripComments(MAIN);
  const fnStart = code.indexOf('function currentMissionBoard()');
  const fn = code.slice(fnStart, fnStart + 2600);
  const failBranch = fn.slice(fn.indexOf('catch'));
  assert.match(failBranch, /stale:\s*true/,
    'a failed read must be reported as stale — claiming freshness would be a lie');
});
