'use strict';

// test/office-snapshot-push-skip.test.js — v0.6 WP4：快照版本化推送。
//
// 背景（2026-10-25 冗余调查）：PUSH_INTERVAL_MS = TICK_MS = 16ms —— 每 tick 全量
// 构建+脱敏+每视图一次结构化克隆 IPC ≈ 62 次/秒，与画面是否变化无关。
// v0.6：内容签名（渲染可见标量的 FNV 哈希）未变 → 跳过构建与推送；心跳兜底。
//
// 审计依据（2026-10-26 对生产包 deepseek-default 逐项核对）：idle/idle-blink/
// idle-lunch/finished/error/offline 全部 frameCount=1（静止场景无可见动画翻转）；
// 多帧只有 walk（15 帧，行走时位置每 tick 变化天然驱动）与 working-back
//（3 帧，按 250ms 动画粒度进签名）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');

const P = path.join(__dirname, '..', 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
}).pack;

function makeOffice() {
  return officeModule.createOfficeModule({
    pack: PACK, seed: 'push-skip-seed',
    config: { resultPresentationMs: 200, workstationAnchorSegmentMs: 120 },
    log: () => {},
  });
}

/** 收集推送（subscribe）。 */
function collector(office) {
  const pushed = [];
  office.subscribe((snapshot) => pushed.push({ simulatedAtMs: snapshot.simulatedAtMs, employees: snapshot.employees.length }));
  return pushed;
}

const anyoneMoving = (office) => office.state().employees.some((e) => e.movement === 'moving');

/** 确定性推进到"全员静止"的窗口（漫游者的 dwell 期；办公室并非总是静止 ——
 *  有人走动时每 tick 推送是**正确**行为，M2 钉的就是它）。 */
function tickUntilStationary(office, maxMs = 240000) {
  const steps = Math.round(maxMs / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    office.tickOnce();
    if (!anyoneMoving(office)) return i + 1;
  }
  return -1;
}

test('push-skip W4: 全员静止窗口跳过推送；位移立即恢复推送', () => {
  const office = makeOffice();
  const settledAt = tickUntilStationary(office);
  assert.ok(settledAt > 0, 'fixture must reach an all-stationary window (dwell period)');
  assert.equal(anyoneMoving(office), false);
  const pushed = collector(office);
  // 静止推进 25 tick（400ms）：签名不变 → 只剩动画粒度（250ms）的极少推送。
  for (let i = 0; i < 25; i += 1) office.debugClockFire();
  const idlePushes = pushed.length;
  assert.ok(idlePushes <= 4, `25 stationary ticks must not push per-tick (got ${idlePushes})`);
  assert.ok(idlePushes >= 1, 'the animation granularity still reaches subscribers');

  // 状态变化（座位绑定）：签名变化 → 立即恢复推送。
  const before = pushed.length;
  const verdict = office.ingestTeamProjectionFact({ kind: 'run-started', identity: { jobHandle: 'team-job-sha256:' + '1'.repeat(16), runHandle: 'team-run-sha256:' + '1'.repeat(16), role: 'researcher', seq: 1, factType: 'run/started', statusSource: 'team-runtime' }, atMs: office.state().simulatedAtMs + 1, seat: 'researcher', role: 'researcher' });
  assert.equal(verdict.ok, true, `ingest failed: ${verdict.code}`);
  // 事件推送由既有的 due 门节流到下一个 tick（PUSH_INTERVAL_MS 语义未变）——
  // 签名已变，随后的 tick 必须把新状态推出去。
  office.debugClockFire();
  office.debugClockFire();
  assert.ok(pushed.length > before, 'a state change must resume pushes on the following tick');
});

test('push-skip W5: 摄入新事实（不在静止签名里）必然触发推送', () => {
  const office = makeOffice();
  tickUntilStationary(office);
  const pushed = collector(office);
  for (let i = 0; i < 20; i += 1) office.debugClockFire(); // 静止
  const before = pushed.length;
  // 事实摄入（座位绑定）走事件路径直接 pushSnapshot —— 签名必然不同。
  const verdict = office.ingestTeamProjectionFact({ kind: 'run-started', identity: { jobHandle: 'team-job-sha256:' + '2'.repeat(16), runHandle: 'team-run-sha256:' + '2'.repeat(16), role: 'researcher', seq: 1, factType: 'run/started', statusSource: 'team-runtime' }, atMs: office.state().simulatedAtMs + 1, seat: 'researcher', role: 'researcher' });
  assert.equal(verdict.ok, true, `ingest failed: ${verdict.code}`);
  assert.ok(pushed.length > before, 'fact ingestion must push through the signature gate');
});

test('push-skip W6: 动画粒度兜底 —— 长时间静止仍有周期性推送（未纳入签名的字段至多 1s 陈旧）', () => {
  // reducedMotion 下移动瞬时完成：定居后是真正的长静止窗（默认模式下办公室
  // 大部分时间总有漫游者在走 —— 那时每 tick 推送是 M2 契约的正确行为）。
  const office = officeModule.createOfficeModule({
    pack: PACK, seed: 'push-skip-seed',
    config: { reducedMotion: true, resultPresentationMs: 200, workstationAnchorSegmentMs: 120 },
    log: () => {},
  });
  tickUntilStationary(office);
  const pushed = collector(office);
  // 推进 5 秒静止（312 tick）：推送次数必须远小于 tick 数，且随时间持续（非一次性）。
  for (let i = 0; i < 312; i += 1) office.debugClockFire();
  const count = pushed.length;
  assert.ok(count < 312 / 4, `5s stationary must stay far below tick count (got ${count}/312)`);
  assert.ok(count >= 5, `animation granularity must keep delivering (~5s → ≥5 pushes, got ${count})`);
});

test('push-skip: 生产包审计钉 —— 静止动画必须单帧（跳过的前提不许被素材悄悄破坏）', () => {
  const manifestRoot = path.join(__dirname, '..', 'resources', 'characters', 'deepseek-default', 'animation', 'animations.json');
  if (!fs.existsSync(manifestRoot)) return; // 素材包不在此环境（CI 精简）时跳过
  const data = JSON.parse(fs.readFileSync(manifestRoot, 'utf8'));
  const anims = data.animations || {};
  // 静止位姿（非移动、非 working-back）必须单帧；否则 contentSignature 会漏推。
  for (const [name, entry] of Object.entries(anims)) {
    if (!/^(walk|working)/.test(name)) {
      const fc = entry.frameCount || (entry.frames ? entry.frames.length : 1);
      assert.equal(fc, 1, `static animation "${name}" must stay single-frame (multi-frame would freeze under push-skip)`);
    }
  }
});

test('push-skip: 座位 phase 变化（teamPhase 在签名里）必须在随后的 tick 推送', () => {
  const office = makeOffice();
  tickUntilStationary(office);
  const pushed = collector(office);
  const runStarted = office.ingestTeamProjectionFact({ kind: 'run-started', identity: { jobHandle: 'team-job-sha256:' + '3'.repeat(16), runHandle: 'team-run-sha256:' + '3'.repeat(16), role: 'researcher', seq: 1, factType: 'run/started', statusSource: 'team-runtime' }, atMs: office.state().simulatedAtMs + 1, seat: 'researcher', role: 'researcher' });
  assert.equal(runStarted.ok, true);
  office.debugClockFire();
  office.debugClockFire();
  const before = pushed.length;
  const progress = office.ingestTeamProjectionFact({ kind: 'run-progress', identity: { jobHandle: 'team-job-sha256:' + '3'.repeat(16), runHandle: 'team-run-sha256:' + '3'.repeat(16), role: 'researcher', seq: 2, factType: 'run/progress', statusSource: 'team-runtime' }, atMs: office.state().simulatedAtMs + 2, seat: 'researcher', role: 'researcher', phase: 'search' });
  assert.equal(progress.ok, true, `progress failed: ${progress.code}`);
  office.debugClockFire();
  office.debugClockFire();
  assert.ok(pushed.length > before, 'a phase change must reach subscribers (toolPhrase update)');
});
