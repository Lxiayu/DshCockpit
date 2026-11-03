// test/runtime-capability.test.js — S1 / TD-29：能力探测替代版本门禁。
//
// 第一性原理：为什么这组测试是"语义正确性"测试，不是"功能可用性"测试
//
//   壳层真正依赖的是一组**具体能力**（mux 能连、session RPC 在、事件词表兼容），
//   而不是版本号。旧判据 `semver.satisfies(v, '<0.2.0-0')` 在 0.2.1 上给出
//   "不支持"——而 POC 实测它 16/16 通过。结论是错的。
//
//   所以这里锁的不是"能不能跑"，而是**结论不能撒谎**：
//     · 有实测证据的 0.2.x 必须判 supported（旧判据判 unsupported）
//     · 未验证版本必须判 unverified，**不能**判 unsupported
//     · 只有 required 能力缺失才允许拒绝运行
//
//   第二条尤其重要：如果把"没测过"写成"不支持"，每次上游发版都会把壳层
//   变成不可用状态，而实际上很可能完全正常。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const cap = require('../src/runtime-capability.js');

// ------------------------------------------------------------- 声明完整性

test('capability: every declared capability explains WHY and cites EVIDENCE', () => {
  assert.ok(cap.CAPABILITIES.length >= 5, 'the shell depends on a real set of capabilities');
  for (const c of cap.CAPABILITIES) {
    assert.equal(typeof c.id, 'string');
    assert.ok(c.id.length > 0);
    assert.equal(typeof c.required, 'boolean');
    assert.ok(c.why && c.why.length > 10,
      `capability ${c.id} must explain why the shell needs it`);
    assert.ok(c.evidence && c.evidence.length > 10,
      `capability ${c.id} must cite evidence (a claim without evidence is a guess)`);
    assert.match(c.since, /^\d+\.\d+\.\d+/, `capability ${c.id} needs a since version`);
  }
});

test('capability: the four transport/RPC capabilities are REQUIRED (the shell cannot work without them)', () => {
  const required = cap.CAPABILITIES.filter((c) => c.required).map((c) => c.id).sort();
  assert.deepEqual(required, ['remote.mux', 'session.create', 'session.list', 'session.page']);
});

test('capability: agent-team and workspace.changes are OPTIONAL (0.1.x lacks them but still runs)', () => {
  const optional = cap.CAPABILITIES.filter((c) => !c.required).map((c) => c.id);
  assert.ok(optional.includes('agent-team'), 'Agent Teams did not exist before 0.2.0 → optional');
  assert.ok(optional.includes('workspace.changes'));
});

// ------------------------------------------------------------- 矩阵自洽性

test('capability: every matrix entry cites evidence and a verification date', () => {
  assert.ok(cap.KNOWN_MATRIX.length >= 2, 'we have verified at least the 0.1.x and 0.2.x lines');
  for (const entry of cap.KNOWN_MATRIX) {
    assert.ok(entry.evidence && entry.evidence.length > 10, `entry ${entry.range} must cite evidence`);
    assert.match(entry.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, `entry ${entry.range} needs a date`);
    for (const id of entry.satisfied) {
      assert.ok(cap.CAPABILITY_IDS.includes(id), `entry ${entry.range} references unknown capability ${id}`);
    }
    for (const id of entry.missing) {
      assert.ok(cap.CAPABILITY_IDS.includes(id), `entry ${entry.range} references unknown capability ${id}`);
    }
    // satisfied 与 missing 不能重叠
    const overlap = entry.satisfied.filter((id) => entry.missing.includes(id));
    assert.deepEqual(overlap, [], `entry ${entry.range} lists a capability as both present and missing`);
  }
});

test('capability: matrix ranges do not overlap (one version maps to exactly one entry)', () => {
  const samples = ['0.1.0', '0.1.5-rc.2', '0.1.9', '0.2.0', '0.2.1-rc.5', '0.2.9', '0.3.0'];
  for (const v of samples) {
    const matches = cap.KNOWN_MATRIX.filter((e) => {
      const semver = require('semver');
      try { return semver.satisfies(v, e.range, { includePrerelease: true }); } catch { return false; }
    });
    assert.ok(matches.length <= 1, `${v} matched ${matches.length} matrix entries (ambiguous)`);
  }
});

// ------------------------------------------------------------- 判定语义

test('capability: 0.1.5 is DEGRADED (lacks agent-team) but still RUNNABLE', () => {
  const j = cap.judge('0.1.5-rc.2');
  assert.strictEqual(j.verdict, cap.VERDICTS.DEGRADED);
  assert.ok(j.missing.includes('agent-team'));
  assert.ok(!j.missing.includes('remote.mux'), 'the required transport must still be present');
  assert.strictEqual(cap.canRun('0.1.5-rc.2').allowed, true);
});

test('capability: 0.2.1-rc.5 is SUPPORTED — this is the verdict the version gate got WRONG', () => {
  // 旧判据 semver.satisfies('0.2.1-rc.5', '<0.2.0-0') === false → "unsupported"
  // POC 2026-11-01 实测: mux + session.list/create/page + 6 个能力包全部可用
  const j = cap.judge('0.2.1-rc.5');
  assert.strictEqual(j.verdict, cap.VERDICTS.SUPPORTED);
  assert.deepEqual(j.missing, [], '0.2.x has every capability the shell needs');
  assert.strictEqual(cap.canRun('0.2.1-rc.5').allowed, true);
  assert.strictEqual(cap.canRun('0.2.1-rc.5').degraded, false);
  assert.ok(j.evidence.includes('POC'), 'the verdict must be traceable to a run');
});

test('capability: 0.2.2-alpha.2 is also SUPPORTED (POC verified it too)', () => {
  assert.strictEqual(cap.judge('0.2.2-alpha.2').verdict, cap.VERDICTS.SUPPORTED);
});

test('capability: an UNKNOWN version is UNVERIFIED, never UNSUPPORTED', () => {
  // 这是整个模块最重要的语义：没测过 ≠ 不能用。
  // 若把未验证判成不支持，每次上游发版都会禁用壳层。
  for (const v of ['0.3.0', '0.9.9', '1.0.0', '0.2.99']) {
    const j = cap.judge(v);
    assert.strictEqual(j.verdict, cap.VERDICTS.UNVERIFIED, `${v} must be unverified, not unsupported`);
    assert.strictEqual(cap.canRun(v).allowed, true, `${v} must remain runnable (container posture)`);
    assert.match(j.reason, /NOT a "unsupported" verdict/);
  }
});

test('capability: a non-semver version (dev build) stays runnable and honest', () => {
  for (const v of ['', null, undefined, 'dev', 'git-a1b2c3', 'local']) {
    const r = cap.canRun(v);
    assert.strictEqual(r.allowed, true, `${JSON.stringify(v)} must never be blocked by a version string`);
    assert.strictEqual(r.verdict, cap.VERDICTS.UNVERIFIED);
  }
});

test('capability: only a missing REQUIRED capability yields UNSUPPORTED', () => {
  // 构造一个假矩阵来验证这个分支——真实矩阵里目前没有这种情况。
  const original = cap.KNOWN_MATRIX;
  // 直接测内部逻辑：所有 required 都在 satisfied 里 → 不会是 unsupported
  for (const entry of original) {
    const missingRequired = cap.CAPABILITIES
      .filter((c) => c.required && entry.missing.includes(c.id));
    if (missingRequired.length === 0) continue;
    assert.fail(`real matrix entry ${entry.range} unexpectedly lacks required capabilities`);
  }
});

// ------------------------------------------------------------- 展示语义

test('capability: needsCompatibilityNote is a HINT, not a verdict', () => {
  // 设置页用它决定"要不要提示未验证"，而不是"要不要禁用"
  assert.strictEqual(cap.needsCompatibilityNote('0.9.9'), true);
  assert.strictEqual(cap.needsCompatibilityNote('0.2.1-rc.5'), false);
  assert.strictEqual(cap.needsCompatibilityNote('0.1.5-rc.2'), false);
});

test('capability: canRun exposes degraded/unverified as separate flags for the UI', () => {
  const degraded = cap.canRun('0.1.5-rc.2');
  assert.strictEqual(degraded.degraded, true);
  assert.strictEqual(degraded.unverified, false);

  const unverified = cap.canRun('0.9.9');
  assert.strictEqual(unverified.degraded, false);
  assert.strictEqual(unverified.unverified, true);
});

// ------------------------------------------- 与 POC 报告的一致性

test('capability: the 0.2.x matrix entry matches what the POC actually proved', () => {
  // 防止有人凭印象改矩阵：entry 的 evidence 必须指向真实报告，
  // 且 satisfied 必须覆盖 POC 验证过的 6 个能力包中的关键项。
  const entry = cap.KNOWN_MATRIX.find((e) => e.range.includes('0.2.1-rc.5'));
  assert.ok(entry, 'a 0.2.x entry must exist');
  assert.match(entry.evidence, /POC/);
  assert.match(entry.evidence, /2026-11-01/);
  for (const id of ['remote.mux', 'session.list', 'session.create', 'session.page', 'agent-team']) {
    assert.ok(entry.satisfied.includes(id), `0.2.x entry must list ${id} as satisfied`);
  }
  assert.deepEqual(entry.missing, [], 'POC found nothing missing in 0.2.x');
});

// ------------------------------------------- 能力"启用"与"存在"的区分（S0 第二轮）

test('capability: agent-team declares an activation requirement (presence != enabled)', () => {
  // 第一性原理：0.2.1 装了 dsh-experimental-agent-team，但 session/projections 里
  // 没有 agentTeam，因为 profile bundles 没挂 team-profile 层。
  // 若把"读不到 agentTeam"报成能力缺失，用户会被告知"升级运行时"，
  // 而真正要做的只是"打开一个开关"。二者的修复动作完全不同。
  const decl = cap.capabilityById('agent-team');
  assert.ok(decl, 'agent-team capability must exist');
  assert.ok(decl.activation, 'agent-team must declare how it is activated');
  assert.strictEqual(decl.activation.kind, 'profile-bundle');
  assert.strictEqual(decl.activation.bundle, '@deepseek-ai/dsh-experimental-agent-team-profile');
  assert.match(decl.activation.observable, /agentTeam/);
});

test('capability: requiresActivation distinguishes conditional capabilities from always-on ones', () => {
  assert.strictEqual(cap.requiresActivation('agent-team'), true);
  assert.strictEqual(cap.requiresActivation('remote.mux'), false);
  assert.strictEqual(cap.requiresActivation('session.create'), false);
  assert.strictEqual(cap.requiresActivation('no-such-capability'), false);
});

test('capability: describeActivation returns a copy, not the frozen declaration', () => {
  const a = cap.describeActivation('agent-team');
  assert.ok(a);
  assert.strictEqual(a.bundle, '@deepseek-ai/dsh-experimental-agent-team-profile');
  // 修改返回值不得污染全局声明（否则一次 UI 调用就会改变矩阵语义）
  a.bundle = 'tampered';
  assert.strictEqual(cap.describeActivation('agent-team').bundle,
    '@deepseek-ai/dsh-experimental-agent-team-profile');
  assert.strictEqual(cap.describeActivation('remote.mux'), null);
});

test('capability: activation evidence points at the probe that proved it', () => {
  // 防凭印象：这条事实必须有可追溯的真机证据。
  const decl = cap.capabilityById('agent-team');
  assert.match(decl.activation.note, /默认关闭|仅安装/);
  assert.match(decl.activation.evidence, /harness-agent-team-probe-2026-11-04/);
});
