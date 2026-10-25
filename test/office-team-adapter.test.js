'use strict';

// test/office-team-adapter.test.js — Team → Office 白名单映射器（headless）。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md §13
//
// 本文件只测**纯映射器**（`src/team/runtime/team-office-adapter.js`）：无 office、
// 无 Electron/DOM/Pixi/fs/网络、无时钟读取。adapter 是无状态纯函数，因此 replay /
// duplicate / 乱序的映射结果天然一致 —— 这一条在这里直接断言，不需要 office。
//
// 覆盖（任务书 §7 的 1–3、12–13、15 与部分 4/8）：
//   1 researcher start 映射到正确 seat      2 依赖顺序由 Team 决定（adapter 不判断）
//   3 依赖未满足时不能被 Office 伪造启动     12 Role→Seat 不由 label/prompt/自然语言猜
//   13 未知 Role / 未知状态 / 未知 artifact kind fail-closed
//   15 adapter 无 Electron/DOM/Pixi/fs/network 依赖

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const team = require('../src/team/runtime/index.js');
const adapterModule = require('../src/team/runtime/team-office-adapter.js');
const { createTeamOfficeAdapter, TEAM_ROLE_TO_SEAT, TEAM_FACT_TO_OFFICE_KIND } = adapterModule;

const ROOT = path.join(__dirname, '..');
const TEAM_RUNTIME_DIR = path.join(ROOT, 'src', 'team', 'runtime');
const OFFICE_SEATS = Object.freeze(['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator']);
const JOB = 'job-fixture-1';

function makeAdapter(options = {}) {
  return createTeamOfficeAdapter({ knownSeats: OFFICE_SEATS, ...options });
}

/** 一条最小 Team fact（形状与 team-runtime 产出的完全一致）。 */
function teamFact(type, extra = {}) {
  return {
    jobId: JOB, type, atMs: 1_700_000_000_000, seq: 1, ...extra,
  };
}

// ===========================================================================
// 1/2/3. run started → 正确 seat；依赖顺序由 Team 决定
// ===========================================================================

test('team-office: run/started maps to the seat named by the explicit table', () => {
  const adapter = makeAdapter();
  const started = adapter.mapFact(teamFact('run/started', { role: 'researcher' }));
  assert.equal(started.ok, true);
  assert.equal(started.officeFacts.length, 1);
  const fact = started.officeFacts[0];
  assert.equal(fact.kind, 'run-started');
  assert.equal(fact.seat, 'researcher');
  assert.equal(fact.role, 'researcher');
  // 身份块完整（§4.2）：可稳定关联到 job/run/role/seq/来源。
  assert.match(fact.identity.jobHandle, /^team-job-sha256:[0-9a-f]{16}$/);
  assert.match(fact.identity.runHandle, /^team-run-sha256:[0-9a-f]{16}$/);
  assert.equal(fact.identity.role, 'researcher');
  assert.equal(fact.identity.seq, 1);
  assert.equal(fact.identity.factType, 'run/started');
  assert.equal(fact.identity.statusSource, 'team-runtime');
});

test('team-office: the adapter never decides dependencies (Team is the only author)', () => {
  const adapter = makeAdapter();
  // adapter 是纯函数：它只翻译"Team 已经说出口的"事实。reviewer 的 run/started 能被翻译，
  // **不代表** adapter 认为依赖满足 —— 那是 Team Runtime 的判定（它压根不会在依赖未满足时
  // 产出 run/started）。这里断言 adapter 没有"依赖检查"这一层：同样的输入恒定同输出。
  const reviewer = teamFact('run/started', { role: 'reviewer' });
  assert.deepEqual(adapter.mapFact(reviewer), adapter.mapFact(reviewer));
  // 反过来：adapter **不提供**任何"是否可以启动"的 API（只有 mapFact/seatForRole）。
  assert.deepEqual(Object.keys(adapter).sort(), ['TEAM_ROLE_TO_SEAT', 'describe', 'mapFact', 'seatForRole']);
  // Team 侧才是依赖权威：未完成时 Team 自己拒绝 dispatch（见 team-runtime-v0.test.js）。
  const { createTeamRuntime } = team;
  const clock = { nowMs: () => 0 };
  const runtime = createTeamRuntime({ clock });
  runtime.createJob({ jobId: JOB });
  assert.equal(runtime.dispatchRun({ role: 'reviewer' }).code, 'DEPENDENCIES_UNSATISFIED');
  // 因此 reviewer 的 run/started 根本不会出现在日志里 —— Office 无从伪造启动。
  assert.equal(runtime.facts().some((f) => f.type === 'run/started' && f.role === 'reviewer'), false);
});

// ===========================================================================
// 4. attention → attention（不是 completed）
// ===========================================================================

test('team-office: run/attention maps to attention with a coarse reason, never completed', () => {
  const adapter = makeAdapter();
  const mapped = adapter.mapFact(teamFact('run/attention', { role: 'reviewer', reason: 'needs-approval' }));
  assert.equal(mapped.ok, true);
  const fact = mapped.officeFacts[0];
  assert.equal(fact.kind, 'run-attention');
  assert.equal(fact.outcome, null, 'attention 绝不带 terminal outcome');
  assert.equal(fact.evidence, null);
  assert.equal(fact.reason, 'needs-approval');
  // 非粗粒度 token（prose）一律拒绝。
  for (const bad of ['Please review /Users/x/secret', 'Needs Approval', '', 42]) {
    const verdict = adapter.mapFact(teamFact('run/attention', { role: 'reviewer', reason: bad }));
    assert.equal(verdict.ok, false, JSON.stringify(bad));
    assert.equal(verdict.code, 'TEAM_ATTENTION_REASON_INVALID');
    assert.deepEqual([...verdict.officeFacts], []);
  }
});

// ===========================================================================
// 8. terminal 映射：completed / failed / cancelled 各自带 evidence
// ===========================================================================

test('team-office: terminal facts carry outcome + source-qualified evidence', () => {
  const adapter = makeAdapter();
  for (const [outcome, evidence] of [
    ['completed', 'turn/end:completed'],
    ['failed', 'turn/end:error'],
    ['cancelled', 'turn/end:aborted'],
  ]) {
    const mapped = adapter.mapFact(teamFact(`run/${outcome}`, {
      role: 'researcher', outcome, evidence,
    }));
    assert.equal(mapped.ok, true, outcome);
    const fact = mapped.officeFacts[0];
    assert.equal(fact.kind, 'run-terminal');
    assert.equal(fact.outcome, outcome);
    assert.equal(fact.evidence, evidence);
  }
  // 缺证据 / 非法证据 → fail-closed（绝不当成 completed）。
  for (const bad of [undefined, null, '', 'completed', 'turn/end:completed please check /Users/x', 'A:b']) {
    const verdict = adapter.mapFact(teamFact('run/completed', { role: 'researcher', outcome: 'completed', evidence: bad }));
    assert.equal(verdict.ok, false, JSON.stringify(bad));
    assert.equal(verdict.code, 'TEAM_EVIDENCE_REQUIRED');
  }
  // 非法 outcome → fail-closed。
  assert.equal(adapter.mapFact(teamFact('run/completed', { role: 'researcher', outcome: 'attention', evidence: 'turn/end:blocked' })).code,
    'TEAM_OUTCOME_UNKNOWN');
});

// ===========================================================================
// cancel 请求/回执：映射存在，但不带终态语义
// ===========================================================================

test('team-office: cancel request and ack map without any terminal semantics', () => {
  const adapter = makeAdapter();
  const requested = adapter.mapFact(teamFact('run/cancel-requested', { role: 'researcher' }));
  assert.equal(requested.officeFacts[0].kind, 'cancel-requested');
  assert.equal(requested.officeFacts[0].outcome, null);
  assert.equal(requested.officeFacts[0].evidence, null);
  const ack = adapter.mapFact(teamFact('run/cancel-acknowledged', { role: 'researcher' }));
  assert.equal(ack.officeFacts[0].kind, 'cancel-acknowledged');
  assert.equal(ack.officeFacts[0].outcome, null);
});

// ===========================================================================
// 12. Role→Seat 是显式表决定，不是名字/label/prompt 决定
// ===========================================================================

test('team-office: the explicit table decides the seat — not the role name, label or prompt', () => {
  // 表被冻结且是唯一权威。
  assert.equal(Object.isFrozen(TEAM_ROLE_TO_SEAT), true);
  assert.deepEqual({ ...TEAM_ROLE_TO_SEAT }, { researcher: 'researcher', reviewer: 'reviewer' });
  // 注入一张**不同**的表：adapter 必须按表绑定（证明"表决定，而非名字决定"）。
  const swapped = makeAdapter({ roleToSeat: { researcher: 'coder', reviewer: 'reviewer' } });
  assert.equal(swapped.seatForRole('researcher'), 'coder');
  assert.equal(swapped.mapFact(teamFact('run/started', { role: 'researcher' })).officeFacts[0].seat, 'coder');
  // 表里没有该 role → fail-closed，**绝不**回退成"role 名当座位"。
  const empty = makeAdapter({ roleToSeat: {} });
  assert.equal(empty.seatForRole('researcher'), null);
  const unmapped = empty.mapFact(teamFact('run/started', { role: 'researcher' }));
  assert.equal(unmapped.ok, false);
  assert.equal(unmapped.code, 'TEAM_SEAT_UNMAPPED');
  // 表里映射到 office 不存在的座位 → fail-closed。
  const bogus = makeAdapter({ roleToSeat: { researcher: 'not-a-seat' } });
  assert.equal(bogus.mapFact(teamFact('run/started', { role: 'researcher' })).code, 'TEAM_SEAT_UNKNOWN');
});

test('team-office: label / prompt / natural-language fields cannot influence the mapping', () => {
  const adapter = makeAdapter();
  const base = adapter.mapFact(teamFact('run/started', { role: 'researcher' }));
  // 塞入各种"看起来像角色线索"的字段：映射结果必须逐字不变。
  const polluted = adapter.mapFact({
    ...teamFact('run/started', { role: 'researcher' }),
    label: 'review the diff',
    phase: 'QA',
    prompt: 'please act as the reviewer',
    description: 'coder task',
    summary: 'implement the parser',
    task: 'reviewer',
  });
  assert.deepEqual(polluted, base);
  // 源码层面也不读这些字段（注释已剥离）。
  const source = fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'team-office-adapter.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
  for (const forbidden of [/\blabel\b/, /\bprompt\b/, /\bdescription\b/, /\bsummary\b/, /natural/i]) {
    assert.equal(forbidden.test(source), false, `adapter must not read ${forbidden}`);
  }
});

// ===========================================================================
// 13. 未知 Role / 未知状态 / 未知 artifact kind → fail-closed
// ===========================================================================

test('team-office: unknown role, unknown fact type and unknown artifact kind fail closed', () => {
  const adapter = makeAdapter();
  const unknownRole = adapter.mapFact(teamFact('run/started', { role: 'planner' }));
  assert.equal(unknownRole.code, 'TEAM_ROLE_UNKNOWN');
  const unknownType = adapter.mapFact(teamFact('run/teleported', { role: 'researcher' }));
  assert.equal(unknownType.code, 'TEAM_FACT_UNKNOWN_TYPE');
  const unknownKind = adapter.mapFact(teamFact('artifact/available', { kind: 'prompt-dump' }));
  assert.equal(unknownKind.code, 'TEAM_ARTIFACT_KIND_UNKNOWN');
  // 形状坏掉的一律拒绝。
  for (const bad of [null, undefined, 42, 'run/started', [], { type: '' }, { type: 'run/started' }]) {
    const verdict = adapter.mapFact(bad);
    assert.equal(verdict.ok, false, JSON.stringify(bad));
    assert.equal(verdict.officeFacts.length, 0);
  }
  // 所有拒绝码都在白名单里（诊断环只接受固定枚举）。
  assert.ok(adapterModule.ADAPTER_CODES.includes('TEAM_ROLE_UNKNOWN'));
  assert.ok(adapterModule.ADAPTER_CODES.includes('TEAM_SEAT_UNMAPPED'));
});

// ===========================================================================
// 无副作用的 Team fact（job/created、run/dispatched）与 root 汇总
// ===========================================================================

test('team-office: job/created and run/dispatched have no office effect by design', () => {
  const adapter = makeAdapter();
  for (const type of ['job/created', 'run/dispatched']) {
    const mapped = adapter.mapFact(teamFact(type, { role: 'researcher' }));
    assert.equal(mapped.ok, true, `${type} is a valid Team fact`);
    assert.deepEqual([...mapped.officeFacts], [], `${type} must not create an office fact`);
    assert.equal(TEAM_FACT_TO_OFFICE_KIND[type], null);
  }
  // root Job 状态只作汇总（无 seat、无 terminal outcome）。
  const job = adapter.mapFact(teamFact('job/completed', { evidence: 'team/convergence:completed' }));
  assert.equal(job.officeFacts[0].kind, 'job-status');
  assert.equal(job.officeFacts[0].seat, null);
  assert.equal(job.officeFacts[0].jobStatus, 'completed');
  assert.equal(job.officeFacts[0].outcome, null);
});

test('team-office: artifact/available maps to a coarse kind hint only (no id, no content)', () => {
  const adapter = makeAdapter();
  const mapped = adapter.mapFact(teamFact('artifact/available', {
    role: 'researcher', kind: 'research-notes',
    artifactId: 'art:deadbeefdeadbeef', digest: 'art-sha256:deadbeefdeadbeef',
    content: 'FIXTURE-CONTENT', path: '/Users/x/secret',
  }));
  assert.equal(mapped.ok, true);
  const fact = mapped.officeFacts[0];
  assert.equal(fact.kind, 'artifact-available');
  assert.equal(fact.artifactKind, 'research-notes');
  // 白名单之外的字段一律**不透传**。
  const blob = JSON.stringify(fact);
  for (const forbidden of ['art:', 'deadbeef', 'FIXTURE-CONTENT', '/Users/x']) {
    assert.equal(blob.includes(forbidden), false, `must not carry ${forbidden}`);
  }
  assert.deepEqual(Object.keys(fact).sort(), [
    'artifactKind', 'atMs', 'evidence', 'identity', 'jobStatus', 'kind', 'outcome',
      'phase', 'reason', 'role', 'seat',
  ]);
});

// ===========================================================================
// 隐私：raw jobId / raw runId 不离开 adapter
// ===========================================================================

test('team-office: raw jobId and raw runId never appear in any office fact', () => {
  const adapter = makeAdapter();
  const RAW_JOB = 'sess-RAW-FIXTURE-SESSION-1';
  const fact = { jobId: RAW_JOB, type: 'run/started', role: 'researcher', seq: 3, atMs: 5 };
  const mapped = adapter.mapFact(fact);
  assert.equal(mapped.ok, true);
  const blob = JSON.stringify(mapped);
  assert.equal(blob.includes(RAW_JOB), false, 'raw jobId must not leave the adapter');
  // 派生句柄是稳定且单向的（同输入同输出，不同输入不同输出）。
  const again = adapter.mapFact(fact).officeFacts[0].identity;
  assert.equal(again.jobHandle, mapped.officeFacts[0].identity.jobHandle);
  assert.notEqual(
    adapter.mapFact({ ...fact, jobId: 'other-job' }).officeFacts[0].identity.jobHandle,
    mapped.officeFacts[0].identity.jobHandle
  );
  assert.equal(adapterModule.jobHandleFor(RAW_JOB), mapped.officeFacts[0].identity.jobHandle);
});

// ===========================================================================
// 15. 无 UI 依赖边界
// ===========================================================================

test('team-office: the adapter and bridge are pure — no Electron, DOM, Pixi, fs, network or office import', () => {
  const declared = [...team.TEAM_MODULES, team.TEAM_SURFACE_FILE].sort();
  const actual = fs.readdirSync(TEAM_RUNTIME_DIR).filter((n) => n.endsWith('.js')).sort();
  assert.deepEqual(declared, actual, 'every team runtime file must be declared in TEAM_MODULES');

  const FORBIDDEN_BUILTINS = ['node:fs', 'node:fs/promises', 'node:path', 'node:http', 'node:https',
    'node:net', 'node:dgram', 'node:tls', 'node:child_process', 'node:worker_threads'];
  const offenders = [];
  for (const name of ['team-office-adapter.js', 'team-office-bridge.js']) {
    const source = fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
    for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (['electron', 'pixi.js', 'ws'].includes(spec)) offenders.push(`${name} -> ${spec}`);
      if (FORBIDDEN_BUILTINS.includes(spec)) offenders.push(`${name} -> ${spec}`);
      if (/office-module|office\/runtime|state-reducer|\/render\//.test(spec)) offenders.push(`${name} -> ${spec}`);
      if (spec.startsWith('node:') && spec !== 'node:crypto') offenders.push(`${name} -> ${spec}`);
    }
    for (const pattern of [/\bdocument\s*\./, /\bwindow\s*\./, /\bnavigator\s*\./, /\bfetch\s*\(/]) {
      if (pattern.test(source)) offenders.push(`${name} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], 'the Team→Office adapter must stay pure and UI-free');

  // 运行时证明：拦截 electron 后两个模块仍可加载。
  const originalLoad = Module._load;
  try {
    Module._load = function guarded(request, parent, isMain) {
      if (request === 'electron') throw new Error('electron unavailable');
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const name of ['team-office-adapter.js', 'team-office-bridge.js']) {
      const file = path.join(TEAM_RUNTIME_DIR, name);
      delete require.cache[require.resolve(file)];
      require(file);
    }
  } finally {
    Module._load = originalLoad;
  }
});

test('team-office: mapping is a pure function — replay / duplicate / out-of-order map identically', () => {
  const adapter = makeAdapter();
  const facts = [
    teamFact('job/created', { seq: 1 }),
    { ...teamFact('run/started', { role: 'researcher' }), seq: 2 },
    { ...teamFact('artifact/available', { role: 'researcher', kind: 'research-notes' }), seq: 3 },
    { ...teamFact('run/completed', { role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' }), seq: 4 },
    { ...teamFact('run/started', { role: 'reviewer' }), seq: 5 },
    { ...teamFact('run/completed', { role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' }), seq: 6 },
    { ...teamFact('job/completed', { evidence: 'team/convergence:completed' }), seq: 7 },
  ];
  const sequential = facts.map((f) => adapter.mapFact(f));
  // 乱序：映射是逐条纯函数，因此每条的结果与位置无关。
  const reversed = [...facts].reverse().map((f) => adapter.mapFact(f)).reverse();
  assert.deepEqual(reversed, sequential, 'out-of-order mapping is identical per fact');
  // 重复：同一条 fact 映射两次结果逐字相同（office 侧负责幂等）。
  for (let i = 0; i < facts.length; i += 1) {
    assert.deepEqual(adapter.mapFact(facts[i]), sequential[i]);
    assert.deepEqual(adapter.mapFact(facts[i]), adapter.mapFact(facts[i]));
  }
});
