// test/verification-profile.test.js — 验证定义的可信模型
//
// 第一性原理：这个模块存在的唯一理由是**防止"验证"变成谎言**
//
//   最危险的失败模式不是"验证失败"，而是"验证通过但什么都没证明"：
//     · Agent 把 test 脚本改成 echo ok → npm test 返回 0
//     · 用 /bin/sh -c 拼接任意命令
//     · 环境变量、绝对路径、.. 逃出项目
//     · 代码改了之后，旧的"通过"还在显示
//
//   所以本文件断言的都是"**拒绝**"而不是"接受"。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../src/mission/verification-profile.js');

const BASE = {
  profileId: 'vp-1', name: '单元测试', executable: 'npm', args: ['test'],
  expectedExitCodes: [0], timeoutMs: 60_000, trustLevel: 'user_approved',
};
const withBase = (over) => ({ ...BASE, ...over });

// ============================================ 拒绝：命令注入

test('rejects an executable that is a PATH (prevents /bin/sh injection)', () => {
  const r = v.validateProfile(withBase({ executable: '/bin/sh', args: ['-c', 'rm -rf /'] }));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /bare command name/);
});

test('rejects an executable containing shell metacharacters', () => {
  for (const exe of ['sh -c', 'npm;rm', 'a|b', 'x$(id)', 'a&b']) {
    const r = v.validateProfile(withBase({ executable: exe }));
    assert.strictEqual(r.ok, false, `${exe} must be rejected`);
  }
});

test('rejects -c / --command in args (that turns an arg back into a command)', () => {
  const r = v.validateProfile(withBase({ args: ['-c', 'echo ok'] }));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /turns an argument back into a shell command/);
});

test('rejects a single command STRING instead of args[]', () => {
  const r = v.validateProfile(withBase({ args: 'npm test' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /must be an array/);
});

// ============================================ 拒绝：路径逃逸

test('rejects absolute workingDirectory', () => {
  const r = v.validateProfile(withBase({ workingDirectory: '/etc' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /stay inside the workspace/);
});

test('rejects .. in workingDirectory', () => {
  const r = v.validateProfile(withBase({ workingDirectory: '../outside' }));
  assert.strictEqual(r.ok, false);
});

test('rejects Windows absolute workingDirectory', () => {
  const r = v.validateProfile(withBase({ workingDirectory: 'C:\\Windows' }));
  assert.strictEqual(r.ok, false);
});

// ============================================ 拒绝：不合理的执行参数

test('rejects an unbounded timeout (no process should run forever)', () => {
  const r = v.validateProfile(withBase({ timeoutMs: 24 * 3600 * 1000 }));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /timeoutMs must be between/);
});

test('rejects an empty expectedExitCodes (it would prove nothing)', () => {
  const r = v.validateProfile(withBase({ expectedExitCodes: [] }));
  assert.strictEqual(r.ok, false);
});

// ============================================ 信任级别

test('agent_proposed definitions are NOT executable', () => {
  // 这是核心防线：Agent 提议的验证可能是绕过验证的尝试。
  assert.strictEqual(v.EXECUTABLE_TRUST.includes('agent_proposed'), false);
  const st = v.deriveState({ trustLevel: 'agent_proposed', exitCode: 0, expectedExitCodes: [0] }, {});
  assert.strictEqual(st, 'not-executable');
});

test('platform and user_approved definitions ARE executable', () => {
  assert.ok(v.EXECUTABLE_TRUST.includes('platform'));
  assert.ok(v.EXECUTABLE_TRUST.includes('user_approved'));
});

// ============================================ stale：最关键的一条

test('a passed run becomes STALE when the source snapshot changes', () => {
  // Agent 改了源码 → 之前"测试通过"不能再显示为通过。
  const run = { sourceDigest: 'src-A', definitionDigest: 'def-1', exitCode: 0, expectedExitCodes: [0] };
  assert.strictEqual(v.deriveState(run, { sourceDigest: 'src-A', definitionDigest: 'def-1' }), 'passed');
  assert.strictEqual(v.deriveState(run, { sourceDigest: 'src-B', definitionDigest: 'def-1' }), 'stale');
});

test('a passed run becomes STALE when the DEFINITION changes', () => {
  // 验证脚本被改（比如 test 成了 echo ok）→ 旧结果也不作数。
  const run = { sourceDigest: 'src-A', definitionDigest: 'def-1', exitCode: 0, expectedExitCodes: [0] };
  assert.strictEqual(v.deriveState(run, { sourceDigest: 'src-A', definitionDigest: 'def-2' }), 'stale');
});

test('stale is a distinct state, not "unknown"', () => {
  assert.ok(v.VERIFY_STATES.includes('stale'));
  assert.notStrictEqual(v.deriveState({ sourceDigest: 'a', definitionDigest: 'd' }, { sourceDigest: 'b', definitionDigest: 'd' }), 'not-run');
});

// ============================================ 摘要

test('definitionDigest ignores display-only fields', () => {
  const a = v.definitionDigest(BASE);
  const b = v.definitionDigest(withBase({ profileId: 'other', name: '改名了' }));
  assert.strictEqual(a, b, 'id/name changes must not invalidate a verification definition');
});

test('definitionDigest CHANGES when execution semantics change', () => {
  const a = v.definitionDigest(BASE);
  assert.notStrictEqual(a, v.definitionDigest(withBase({ args: ['test', '--watch=false'] })));
  assert.notStrictEqual(a, v.definitionDigest(withBase({ executable: 'pnpm' })));
  assert.notStrictEqual(a, v.definitionDigest(withBase({ expectedExitCodes: [0, 1] })));
  assert.notStrictEqual(a, v.definitionDigest(withBase({ timeoutMs: 90_000 })));
});

test('definitionDigest is order-insensitive for arg lists that are sets', () => {
  // expectedExitCodes 是集合语义：顺序不该影响摘要
  assert.strictEqual(
    v.definitionDigest(withBase({ expectedExitCodes: [0, 2] })),
    v.definitionDigest(withBase({ expectedExitCodes: [2, 0] })),
  );
});
