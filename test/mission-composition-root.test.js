// test/mission-composition-root.test.js — main.js 组合根的注入完整性。
//
// 第一性原理：main.js 不能单测，但它是**最容易静默失效**的地方
//
//   registerMissionIpc 有一批可选注入（projectionsOf / seqOfTurn /
//   changesSummaryOf / cancelSession / promptSession / ensureSession）。
//   每一个都是 `= null` 默认值，所以**忘了注入不会报错** ——
//   功能只是安静地降级成 "not wired"。
//
//   实际发生过的例子：
//     · cancelSession 没注入 → 用户点暂停，界面显示 paused，团队还在跑
//     · seqOfTurn 没注入    → 凭证永远停在 claimed，用户等不到"可复核"
//
//   这两个在当时都表现成"功能没做完"，而根因只是 main.js 少了一行。
//   所以这里做**源级断言**：每个注入点都必须在 main.js 里真的接上。
//
//   这不是替代真实测试，而是补上"组合根无法被单测"这个结构性盲区。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const IPC = fs.readFileSync(path.join(ROOT, 'src', 'ipc-mission.js'), 'utf8');

/** 从 ipc-mission 里找出所有可选注入的名字（形如 `name = null,`）。 */
function optionalInjections() {
  const names = [];
  const re = /^\s{2,4}([a-zA-Z][a-zA-Z0-9]*)\s*=\s*null,\s*(?:\/\/.*)?$/gm;
  let m;
  while ((m = re.exec(IPC)) !== null) names.push(m[1]);
  return [...new Set(names)];
}

test('composition: every optional injection is actually wired in main.js', () => {
  const names = optionalInjections();
  assert.ok(names.length >= 5, `expected a real injection surface, found: ${names.join(', ')}`);

  const missing = [];
  for (const name of names) {
    // 在 main.js 里必须出现 `name:`（对象字面量的键），后面跟一个函数或表达式
    const re = new RegExp(`\\b${name}\\s*:\\s*[^,\\n]`);
    if (!re.test(MAIN)) missing.push(name);
  }
  assert.deepEqual(missing, [],
    `these injections are declared but never provided by main.js — the feature will silently degrade:\n  ${missing.join('\n  ')}`);
});

test('composition: the two historically-missing injections are present', () => {
  // 这两个都真实踩过，单独钉住以免回归。
  assert.match(MAIN, /cancelSession\s*:/,
    'without cancelSession, "pause" shows paused while the team keeps running');
  assert.match(MAIN, /seqOfTurn\s*:/,
    'without seqOfTurn, receipts can never become verified');
  assert.match(MAIN, /changesSummaryOf\s*:/,
    'without changesSummaryOf, the receipt has a coordinate but cannot read it');
});

test('composition: the turn-seq tracker is declared BEFORE the function that uses it', () => {
  // 函数声明会提升，const 不会。虽然实际调用发生在事件回调里（那时已初始化），
  // 但"靠时序巧合能跑"和"顺序正确"是两件事 —— 前者会在重构时炸掉。
  const declAt = MAIN.indexOf('const turnSeqTracker = turnSeqTrackerModule.createTurnSeqTracker()');
  const useAt = MAIN.indexOf('function seqForMissionSession');
  assert.ok(declAt !== -1 && useAt !== -1, 'both must exist');
  assert.ok(declAt < useAt,
    'the tracker const must be declared before the function that references it (no TDZ reliance)');
});

test('composition: the presented collector is declared before its use', () => {
  const declAt = MAIN.indexOf('const presentedCollector = presentedCollectorModule.createPresentedCollector()');
  const useAt = MAIN.indexOf('presentedCollector.ingest(');
  assert.ok(declAt !== -1 && useAt !== -1, 'both must exist');
  assert.ok(declAt < useAt, 'declaration must precede use');
});

test('composition: deliverables/presented is intercepted before the office ingest', () => {
  // 隐私：这条事件带绝对路径，必须在进入 office module 之前分叉。
  const fnAt = MAIN.indexOf('function ingestOfficeJournalEvent');
  const body = MAIN.slice(fnAt, fnAt + 4000);
  const branchAt = body.indexOf("event.type === 'deliverables/presented'");
  const modAt = body.indexOf('mod.ingestHarnessEvent(');
  assert.ok(branchAt !== -1, 'the presented branch must exist');
  assert.ok(modAt === -1 || branchAt < modAt, 'the branch must come before the office ingest');
});
