// test/mission-deliverable-signal.test.js — 交付物的两个信号合并（S5）。
//
// 第一性原理：这组测试守的是"不要用一个信号冒充两个"
//
//   关于"团队产出了什么"我们有两种信息，可信度完全不同：
//     ① present 声明（deliverables/presented 事件）—— "团队认为这是交付物"
//     ② workspace/changes          —— "这次确实动了这些文件"
//
//   只信 ① → 模型可以宣告一个它没写过的文件
//   只信 ② → 一次调试改 20 个文件全算交付物，噪音淹没真交付
//
//   所以这里锁的是：**只有两者都有，才算"有据可查"**。
//   只有声明没有变更的，必须如实标成 claimed，不许替模型圆场。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ds = require('../src/mission/deliverable-signal.js');

test('signal: a file both declared and changed is the strongest evidence', () => {
  const presented = ds.normalizePresentedFiles([
    { path: '/Users/x/proj/src/auth.js', description: 'JWT 改造' },
  ]);
  const changed = [{ path: 'src/auth.js', added: 12, deleted: 3 }];
  const r = ds.mergeDeliverableEvidence({ presented, changed });

  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].evidence, 'both');
  assert.equal(r.items[0].added, 12);
  assert.equal(r.items[0].deleted, 3);
  assert.equal(r.items[0].description, 'JWT 改造');
  assert.equal(r.both, 1);
});

test('signal: absolute vs relative paths still match (tail comparison)', () => {
  // present 记绝对路径，changes 给相对路径。相等比较永远失败，
  // 必须按尾部路径段匹配 —— 否则"有据可查"会永远为 0。
  const presented = ds.normalizePresentedFiles([
    { path: '/Users/someone/project/docs/report.md' },
  ]);
  const changed = [{ path: 'docs/report.md', added: 5, deleted: 0 }];
  const r = ds.mergeDeliverableEvidence({ presented, changed });
  assert.equal(r.items[0].evidence, 'both');
});

test('signal: a declared-but-unchanged file is "claimed", never "both"', () => {
  // 模型宣告了一个本次没动过的文件（可能是上次的、或它记错了）。
  // 如实标 claimed，不替它圆场。
  const presented = ds.normalizePresentedFiles([{ path: '/x/proj/src/ghost.js' }]);
  const r = ds.mergeDeliverableEvidence({ presented, changed: [{ path: 'src/real.js', added: 1, deleted: 0 }] });
  assert.equal(r.items[0].evidence, 'claimed');
  assert.equal(r.items[0].added, null, 'no line counts can be invented for an unmatched file');
  assert.equal(r.claimedOnly, 1);
});

test('signal: changed-but-undeclared files are counted, NOT listed as deliverables', () => {
  // 一次调试改 20 个文件，不代表 20 个都是交付物。
  const presented = ds.normalizePresentedFiles([{ path: '/x/proj/a.js' }]);
  const changed = [
    { path: 'a.js', added: 1, deleted: 0 },
    { path: 'b.js', added: 2, deleted: 0 },
    { path: 'c.js', added: 3, deleted: 0 },
  ];
  const r = ds.mergeDeliverableEvidence({ presented, changed });
  assert.equal(r.items.length, 1, 'only declared files appear as deliverables');
  assert.equal(r.changedOnly, 2);
});

test('signal: a bare change path matches when the tail is identical', () => {
  // 早期版本要求变更侧至少两段路径，理由是"防止裸名误配"。
  // 但实测发现那会把 present('/abs/proj/a.js') + changes('a.js') 这种
  // **完全正常**的场景判成不匹配 —— 项目根下的文件在 changes 里本来就是裸名。
  //
  // 所以现在允许单段匹配，误配风险由"团队必须显式声明过它"兜住：
  // 我们不是拿一个裸名去猜，而是拿团队宣告过的路径去对账。
  const presented = ds.normalizePresentedFiles([{ path: '/deep/nested/dir/report.md' }]);
  const r = ds.mergeDeliverableEvidence({ presented, changed: [{ path: 'report.md', added: 1, deleted: 0 }] });
  assert.equal(r.items[0].evidence, 'both',
    'the tail is identical, and the team explicitly declared this path');
});

test('signal: with several candidate matches, the most specific wins', () => {
  // 声明 a/b/report.md 时，若 changes 同时有 b/report.md 与 report.md，
  // 应该配到更具体的那个（段更多），而不是任意一个。
  const presented = ds.normalizePresentedFiles([{ path: '/root/a/b/report.md' }]);
  const r = ds.mergeDeliverableEvidence({
    presented,
    changed: [
      { path: 'report.md', added: 1, deleted: 0 },
      { path: 'b/report.md', added: 9, deleted: 9 },
    ],
  });
  assert.equal(r.items[0].evidence, 'both');
  assert.equal(r.items[0].added, 9, 'the more specific path (b/report.md) must win');
});

test('signal: wording never says "delivered" for a claimed-only item', () => {
  const item = { rawPath: '/x/proj/src/ghost.js', evidence: 'claimed', added: null, deleted: null };
  const text = ds.describeDeliverable(item);
  assert.match(text, /声明交付/);
  assert.match(text, /没有检出/);
  assert.doesNotMatch(text, /已交付|已验证/);
});

test('signal: "both" wording cites the real line counts', () => {
  const item = { rawPath: '/x/src/a.js', evidence: 'both', added: 7, deleted: 2 };
  const text = ds.describeDeliverable(item);
  assert.match(text, /确有变更/);
  assert.match(text, /\+7/);
  assert.match(text, /−2/);
});

test('signal: dot-dot paths are not normalized into safety', () => {
  // 不解析 `..`：可疑路径保持可疑，不"修正"成合法路径。
  const presented = ds.normalizePresentedFiles([{ path: '/x/proj/../../etc/passwd' }]);
  assert.ok(!presented[0].key.includes('..') === false, 'the .. must remain visible in the key');
  assert.ok(presented[0].key.includes('..'), 'we must not silently resolve traversal segments');
});

test('signal: degenerate input never throws and yields an empty result', () => {
  assert.doesNotThrow(() => ds.mergeDeliverableEvidence());
  const r = ds.mergeDeliverableEvidence();
  assert.deepEqual(r.items, []);
  assert.equal(r.both, 0);
  assert.doesNotThrow(() => ds.normalizePresentedFiles(null));
  assert.doesNotThrow(() => ds.describeDeliverable(null));
  assert.deepEqual(ds.normalizePresentedFiles([null, {}, { path: '' }]), []);
});

test('signal: the evidence vocabulary is closed', () => {
  assert.deepEqual([...ds.DELIVERABLE_EVIDENCE], ['claimed', 'changed', 'both']);
  assert.equal(ds.DELIVERABLE_EVIDENCE.includes('verified'), false,
    'verification is a human judgment (receipt.js), not a data signal');
});
