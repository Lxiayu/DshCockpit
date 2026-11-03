// test/mission-grant.test.js — Grant 持久授权记录（D10）。
//
// 第一性原理：Grant 存在的理由
//
//   直觉做法是派发面板里放一个路径输入框。这有三个致命问题：
//     ① 用户每次派发都要重新想"该派到哪"，答案通常不变
//     ② 填错 = 团队在错误目录写文件，**没有记录**说明是谁允许的
//     ③ 无法回答"这个团队被授权访问哪些目录"——而这是用户敢不敢离开屏幕的前提
//
//   Grant 把"授权"从一次性输入变成**有记录、可撤销、可审计的对象**。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const grant = require('../src/mission/grant.js');

function makeGrant(over = {}) {
  return {
    grantId: 'gr-abc123',
    grantedBy: 'user',
    access: 'write',
    workspaceDir: '/Users/xia/program/dsh/DshCockpit',
    createdAtMs: 1000,
    ...over,
  };
}

test('grant: a well-formed grant validates', () => {
  const r = grant.validateGrant(makeGrant());
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('grant: only the USER may grant (Lead/members/Missions cannot escalate)', () => {
  // D10 硬规则：Grant 只能由用户创建。这是整个授权模型的信任根。
  for (const who of ['lead', 'teammate', 'mission', 'model', 'system']) {
    const r = grant.validateGrant(makeGrant({ grantedBy: who }));
    assert.equal(r.ok, false, `${who} must not be able to create a grant`);
  }
});

test('grant: access is a closed two-value set (read | write)', () => {
  assert.deepEqual([...grant.GRANT_ACCESS], ['read', 'write']);
  assert.equal(grant.validateGrant(makeGrant({ access: 'admin' })).ok, false);
  // D10："完全权限不是 Grant 的一个取值，而是单独的全局模式"
  assert.equal(grant.validateGrant(makeGrant({ access: 'full' })).ok, false,
    'full access must never be a Grant value — it is a separate global mode');
});

test('grant: the id format matches the contract.grantId constraint', () => {
  // 两处必须一致，否则派发时会出现"合同说有 Grant、但 Grant 表里找不到"
  assert.equal(grant.validateGrant(makeGrant({ grantId: 'gr-' })).ok, false);
  assert.equal(grant.validateGrant(makeGrant({ grantId: 'abc123' })).ok, false);
  assert.equal(grant.validateGrant(makeGrant({ grantId: 'gr-abc-123' })).ok, true);
});

test('grant: a relative or traversing workspaceDir is refused', () => {
  assert.equal(grant.validateGrant(makeGrant({ workspaceDir: 'relative/path' })).ok, false);
  assert.equal(grant.validateGrant(makeGrant({ workspaceDir: '/x/../../etc' })).ok, false);
});

test('grant: revocation is one-way — a revoked grant is never active again', () => {
  // D10："快照不随撤销复活"。重新授权 = 新建一条 Grant，不是翻回旧的。
  const g = makeGrant({ revokedAtMs: 2000, revokeReason: 'user-revoked' });
  assert.equal(grant.validateGrant(g).ok, true);
  assert.equal(grant.isGrantActive(g), false);
});

test('grant: revokedAtMs cannot precede createdAtMs (impossible history)', () => {
  const r = grant.validateGrant(makeGrant({ revokedAtMs: 500, revokeReason: 'user-revoked' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /precede/.test(e)));
});

test('grant: revoke reason is a closed set (no free text in a security action)', () => {
  assert.equal(grant.validateGrant(makeGrant({ revokedAtMs: 2000, revokeReason: '随便写' })).ok, false);
  for (const r of grant.GRANT_REVOKE_REASONS) {
    assert.equal(grant.validateGrant(makeGrant({ revokedAtMs: 2000, revokeReason: r })).ok, true);
  }
});

test('grant: write access allows write; read access does NOT', () => {
  const w = makeGrant({ access: 'write' });
  assert.equal(grant.checkAccess(w, 'write', '/Users/xia/program/dsh/DshCockpit/a.js').allowed, true);
  assert.equal(grant.checkAccess(w, 'read', '/Users/xia/program/dsh/DshCockpit/a.js').allowed, true);

  const r = makeGrant({ access: 'read' });
  assert.equal(grant.checkAccess(r, 'read', '/Users/xia/program/dsh/DshCockpit/a.js').allowed, true);
  const denied = grant.checkAccess(r, 'write', '/Users/xia/program/dsh/DshCockpit/a.js');
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /read-only/);
});

test('grant: a path OUTSIDE the granted directory is refused', () => {
  const g = makeGrant();
  for (const p of ['/etc/passwd', '/Users/xia/Downloads/x', '/Users/xia/program/dsh/Other/x']) {
    assert.equal(grant.checkAccess(g, 'read', p).allowed, false, p);
  }
});

test('grant: a sibling directory with a similar prefix is NOT inside', () => {
  // 天真 startsWith 会把 /proj-evil 判成 /proj 的子目录。
  const g = makeGrant({ workspaceDir: '/proj' });
  assert.equal(grant.checkAccess(g, 'read', '/proj-evil/x').allowed, false);
  assert.equal(grant.checkAccess(g, 'read', '/proj/x').allowed, true);
});

test('grant: a revoked grant refuses EVERY access immediately', () => {
  // 撤销的意义就在这里：不是"以后新任务不行"，是"现在就不行"。
  const g = makeGrant({ revokedAtMs: 2000, revokeReason: 'user-revoked' });
  assert.equal(grant.checkAccess(g, 'read', '/Users/xia/program/dsh/DshCockpit/a.js').allowed, false);
  assert.match(grant.checkAccess(g, 'read', '/Users/xia/program/dsh/DshCockpit/a.js').reason, /not active/);
});

test('grant: the dispatch snapshot freezes grantId + access, but NOT the directory', () => {
  // 快照要回答"当时它被授权做什么"。目录属于 Grant（可撤销的内部记录），
  // 快照只带 grantId + access —— 这样派发记录本身不含绝对路径（隐私 §2.4）。
  const g = makeGrant();
  const s = grant.snapshotForDispatch(g, 5000);
  assert.equal(s.ok, true);
  assert.equal(s.snapshot.grantId, 'gr-abc123');
  assert.equal(s.snapshot.access, 'write');
  assert.equal(s.snapshot.capturedAtMs, 5000);
  assert.equal(Object.prototype.hasOwnProperty.call(s.snapshot, 'workspaceDir'), false,
    'the snapshot must not carry the directory (privacy)');
});

test('grant: a revoked grant cannot produce a dispatch snapshot', () => {
  const g = makeGrant({ revokedAtMs: 2000, revokeReason: 'user-revoked' });
  const s = grant.snapshotForDispatch(g, 5000);
  assert.equal(s.ok, false);
  assert.match(s.reason, /not active/);
});

test('grant: degenerate input never throws', () => {
  assert.doesNotThrow(() => grant.validateGrant(null));
  assert.doesNotThrow(() => grant.validateGrant([]));
  assert.doesNotThrow(() => grant.checkAccess(null, 'read', '/x'));
  assert.doesNotThrow(() => grant.snapshotForDispatch(null, 1));
  assert.equal(grant.validateGrant(null).ok, false);
  assert.equal(grant.checkAccess(null, 'read', '/x').allowed, false);
});
