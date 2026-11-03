// test/mission-presented-collector.test.js — 交付声明的收集与隐私闸门（S5）。
//
// 第一性原理：这组测试守的是 AGENTS.md §2.4 那条铁律
//
//   官方 present 记录的是**绝对路径**。而隐私规则说：
//   "raw sessionId / prompt 正文 / 工具参数原文 / 产物内容 / **绝对路径**
//    不进 Office 快照与事实链"
//
//   所以绝对路径必须在**事件被消费的那一刻**就被削掉 ——
//   不能等到 UI 层才隐藏，那时它已经写进不可篡改的事件日志了，删不掉。
//
//   这组测试的核心断言就是：**输出里绝对不能出现绝对路径的任何部分**
//   （包括用户名、home 目录结构）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pc = require('../src/mission/presented-collector.js');

const WS = '/Users/xia/program/dsh/DshCockpit';

test('privacy: an in-workspace absolute path becomes a relative path', () => {
  const rel = pc.toWorkspaceRelative(`${WS}/src/auth.js`, WS);
  assert.equal(rel, 'src/auth.js');
  // 结果里不能残留用户名或 home 结构
  assert.equal(rel.includes('Users'), false);
  assert.equal(rel.includes('xia'), false);
});

test('privacy: a path OUTSIDE the workspace is refused, never passed through', () => {
  // 外部文件（比如 ~/Downloads/x.pdf）不登记 —— 否则会泄露用户目录结构。
  assert.equal(pc.toWorkspaceRelative('/Users/xia/Downloads/secret.pdf', WS), null);
  assert.equal(pc.toWorkspaceRelative('/etc/passwd', WS), null);
  assert.equal(pc.toWorkspaceRelative('/tmp/out.txt', WS), null);
});

test('privacy: traversal segments are refused, not normalized into safety', () => {
  // 不解析 `..`：可疑路径保持可疑。解析会把它变成"合法"路径，那是在帮倒忙。
  assert.equal(pc.toWorkspaceRelative(`${WS}/src/../../../etc/passwd`, WS), null);
  assert.equal(pc.toWorkspaceRelative(`${WS}/../../x`, WS), null);
});

test('privacy: the workspace root itself is not a file', () => {
  assert.equal(pc.toWorkspaceRelative(WS, WS), null);
  assert.equal(pc.toWorkspaceRelative(`${WS}/`, WS), null);
});

test('privacy: a sibling directory with a similar prefix is not inside the workspace', () => {
  // /proj-evil 不是 /proj 的子目录。天真 startsWith 会误判。
  assert.equal(pc.toWorkspaceRelative('/Users/xia/program/dsh/DshCockpit-evil/x', WS), null);
});

test('extractPresented: only safe files survive; dropped ones are counted', () => {
  const data = {
    turn: 3,
    callId: 'call-1',
    files: [
      { path: `${WS}/src/a.js`, description: '核心改动' },
      { path: '/Users/xia/Downloads/leak.pdf' },   // 越界 → drop
      { path: `${WS}/../outside.txt` },            // 穿越 → drop
      { path: '' },                                // 空 → drop
      null,                                        // 垃圾 → drop
    ],
  };
  const r = pc.extractPresented(data, WS);
  assert.equal(r.turn, 3);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].relPath, 'src/a.js');
  assert.equal(r.files[0].description, '核心改动');
  assert.equal(r.dropped, 4, 'every refused file must be counted, not silently forgotten');
  // 整个结果里不许出现绝对路径片段
  assert.equal(JSON.stringify(r).includes('/Users/'), false);
});

test('extractPresented: a long model description is truncated, not trusted wholesale', () => {
  const r = pc.extractPresented({
    turn: 1,
    files: [{ path: `${WS}/a.js`, description: 'x'.repeat(1000) }],
  }, WS);
  assert.equal(r.files[0].description.length, 300);
});

test('collector: files accumulate per turn and dedupe by relative path', () => {
  const c = pc.createPresentedCollector();
  c.ingest({ turn: 1, files: [{ path: `${WS}/a.js`, description: 'v1' }] }, WS);
  c.ingest({ turn: 1, files: [{ path: `${WS}/a.js`, description: 'v2' }, { path: `${WS}/b.js` }] }, WS);
  const files = c.forTurn(1);
  assert.equal(files.length, 2, 'same path declared twice in one turn counts once');
  assert.equal(files.find((f) => f.relPath === 'a.js').description, 'v2',
    'the later description wins (usually more accurate)');
});

test('collector: turns are kept separate and latest() points at the newest', () => {
  const c = pc.createPresentedCollector();
  c.ingest({ turn: 1, files: [{ path: `${WS}/a.js` }] }, WS);
  c.ingest({ turn: 2, files: [{ path: `${WS}/b.js` }] }, WS);
  assert.deepEqual(c.forTurn(1).map((f) => f.relPath), ['a.js']);
  assert.deepEqual(c.forTurn(2).map((f) => f.relPath), ['b.js']);
  assert.equal(c.latest().turn, 2);
});

test('collector: the buffer is bounded (a long session cannot grow it forever)', () => {
  const c = pc.createPresentedCollector({ cap: 3 });
  for (let t = 1; t <= 6; t += 1) c.ingest({ turn: t, files: [{ path: `${WS}/f${t}.js` }] }, WS);
  const s = c.stats();
  assert.equal(s.turns, 3, 'only the newest 3 turns survive');
  assert.equal(c.forTurn(1).length, 0, 'evicted turns are gone');
  assert.equal(c.latest().turn, 6);
});

test('collector: an event without a turn number is refused (cannot be attributed)', () => {
  // 没有 turn 就无法回答"这是哪一轮交付的"，登记了也没用。
  const c = pc.createPresentedCollector();
  const r = c.ingest({ files: [{ path: `${WS}/a.js` }] }, WS);
  assert.equal(r.accepted, false);
  assert.equal(c.stats().turns, 0);
});

test('collector: stats expose no paths at all', () => {
  const c = pc.createPresentedCollector();
  c.ingest({ turn: 1, files: [{ path: `${WS}/secret-name.js` }] }, WS);
  const s = c.stats();
  assert.deepEqual(Object.keys(s).sort(), ['cap', 'dropped', 'files', 'turns']);
  assert.equal(JSON.stringify(s).includes('secret-name'), false);
});

test('collector: degenerate input never throws', () => {
  const c = pc.createPresentedCollector();
  assert.doesNotThrow(() => c.ingest(null, WS));
  assert.doesNotThrow(() => c.ingest({}, null));
  assert.doesNotThrow(() => c.ingest({ turn: 1, files: 'nope' }, WS));
  assert.doesNotThrow(() => pc.extractPresented(null, WS));
  assert.deepEqual(c.forTurn(99), []);
});

// ---------------------------------------------------------------------------
// 两道防线必须能**分别**被验证
// ---------------------------------------------------------------------------
//
// 变异测试发现：把"遍历检查"去掉后所有测试仍然通过 —— 因为边界检查
// （startsWith workspace + '/'）恰好也能拦住 `${WS}/src/../../../etc/passwd`
// （它不以 workspace 开头... 实际上它以，所以是穿越检查在起作用）。
//
// 这种"两道防线互相掩盖"的情况会让其中一道静默失效而无人察觉。
// 所以下面用**同一前缀 + 穿越**构造只可能被穿越检查拦住的输入，
// 让两道防线各自可测。

test('traversal: a path that DOES start with the workspace but escapes via .. is refused', () => {
  // 这个输入同时"以 workspace 开头"且"穿越出界"。
  // 只有穿越检查能拦住它 —— 边界检查看到前缀会放行。
  const escaping = `${WS}/sub/../../../../etc/passwd`;
  assert.equal(pc.toWorkspaceRelative(escaping, WS), null,
    'a path that starts with the workspace but climbs out must be refused');
});

test('traversal: the relative result itself is never allowed to contain ..', () => {
  // 即使绝对路径检查漏了，最终相对的 relPath 也不许带 ..
  const r = pc.toWorkspaceRelative(`${WS}/a/../b.js`, WS);
  // 这一条是"合法"的（最终还是工作区内），但结果里不该出现 ..
  if (r !== null) {
    assert.equal(r.split('/').includes('..'), false,
      'the emitted relative path must not carry traversal segments');
    assert.equal(r, 'a/../b.js');
  }
});
