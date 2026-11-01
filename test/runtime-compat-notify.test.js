// test/runtime-compat-notify.test.js — S1/TD-29：更新时的三态兼容提示。
//
// 第一性原理：为什么"未验证"不能打扰用户
//
//   三种情况的处置必须不同：
//     unsupported → required 能力缺失，这是**真问题**，明确告警
//     degraded    → 可跑但缺可选能力，提示降级
//     unverified  → 没测过，**不等于不能用** —— 只记日志，不发通知
//
//   第三点常被误解成"应该提示用户注意"。但上游每次发版都会产生 unverified，
//   如果每次都弹通知，用户会训练出"忽略提示"的肌肉记忆——那时真正重要的
//   unsupported 告警也会被一起忽略。**噪音是一种会杀死告警的债。**
//
//   这些测试锁住 main.js 里的分派逻辑（用源码断言，因为 main.js 无法在
//   纯 Node 下加载——见 test/ipc-contract.test.js 的说明）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const cap = require('../src/runtime-capability.js');

const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

/** 取出更新检查里处理兼容性的那段代码（从 targetCompat 到 install 前）。 */
function compatBlock() {
  const start = mainSrc.indexOf('const targetCompat = canRunRuntime(report.target);');
  assert.ok(start !== -1, 'main.js must decide compatibility via canRunRuntime');
  const end = mainSrc.indexOf('notify(t(lang(), \'notify.newVersion\')', start);
  assert.ok(end !== -1, 'cannot locate the end of the compat block');
  return mainSrc.slice(start, end);
}

test('compat-notify: unsupported installs anyway but warns the user', () => {
  const block = compatBlock();
  assert.match(block, /verdict === 'unsupported'/);
  assert.match(block, /MISSING REQUIRED CAPABILITIES/);
  // 必须仍然发通知 —— 这是真问题，不能让用户毫不知情
  assert.match(block, /notify\(t\(lang\(\), 'notify\.updateGated'\)/);
});

test('compat-notify: degraded installs with a note', () => {
  const block = compatBlock();
  assert.match(block, /targetCompat\.degraded/);
  assert.match(block, /missing optional capabilities/);
});

test('compat-notify: unverified does NOT notify the user (only logs)', () => {
  // 关键：unverified 分支里不能出现 notify(...)
  const block = compatBlock();
  const uStart = block.indexOf('targetCompat.unverified');
  assert.ok(uStart !== -1, 'an unverified branch must exist');
  const unverifiedBranch = block.slice(uStart);
  assert.doesNotMatch(unverifiedBranch, /notify\(/,
    'an unverified version must not nag the user — upstream releases would create constant noise '
    + 'and train users to ignore the alerts that actually matter');
  assert.match(unverifiedBranch, /log\(/,
    'but it must still leave a trace for post-mortem');
});

test('compat-notify: none of the branches blocks the install (container posture)', () => {
  const block = compatBlock();
  // 不允许任何分支 return / throw 掉安装流程
  assert.doesNotMatch(block, /\breturn\s*\{\s*\.\.\.report/,
    'a compatibility verdict must never abort the install');
  assert.doesNotMatch(block, /throw new Error\(.*compat/);
});

test('compat-notify: the unsupported message names WHICH capability is missing', () => {
  // 只说"不兼容"等于没说。必须列出具体缺什么，否则用户无法判断影响面。
  const block = compatBlock();
  assert.match(block, /judge\.missing\.join/,
    'the diagnostic must enumerate the missing capabilities');
});

test('compat-notify: the verdicts used by main.js exist in the capability module', () => {
  // 防止字符串拼写漂移（'unsupported' vs 'unsupport'）
  for (const v of ['unsupported']) {
    assert.ok(Object.values(cap.VERDICTS).includes(v),
      `main.js compares against "${v}" which must be a real VERDICTS value`);
  }
});

test('compat-notify: applying a pending update logs the compatibility verdict', () => {
  const start = mainSrc.indexOf('async function applyPendingUpdate()');
  assert.ok(start !== -1);
  const block = mainSrc.slice(start, start + 900);
  assert.match(block, /canRunRuntime\(pending\)/,
    'the apply path must also consult capabilities, not just the version range');
  assert.match(block, /compatibility: \$\{compat\.verdict\}/,
    'the log line must state the verdict so a rollback can be attributed');
});
