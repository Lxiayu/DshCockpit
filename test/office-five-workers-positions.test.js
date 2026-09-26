'use strict';

// 2026-09-26 工位位置缺陷回归 — 用户实测"调度员确实进入到了工作状态，但是他
// 进入工作状态的位置不对，不在他的工位上，而是跑到了空地上"。
//
// 本组用真模块 + 真生产布局链 + 真角色包，让 5 个员工（根会话 orchestrator +
// 分类座位 researcher/coder/reviewer + 未分类 FIFO collaborator）同批进入
// 工作态，然后逐人校验最终位置。钉死的不变量：
//   ① 5 名员工同时（同一份快照）进入 transition.phase==='work'；
//      超时或失败时逐人打印 phase/位置/到岗距离/绑定状态。
//   ② 每人最终位置落在其工位节点 0.02 场景单位容差内，且在其工位家具
//      （desk-N-* 的 parts rect 并集）之内——"在工位家具范围内"是本次缺陷的钉子。
//   ③ 不存在"work 相位但离自己工位家具远"的员工（①②的补集断言）。
//
// 修掉的缺陷链（修前本组红：researcher 带着 working 外观冻在聊天座 chat-a，
// coder/reviewer/collaborator 冻在底部走廊互相挡死，位置 540s+ 不动）：
//   A. 聊天座是 task 行为图的死角（chat-a/chat-b 的边只带
//      roaming|chatting|resting）：聊天对散场/绑定落在头上时纯 task 搜索
//      永远 UNREACHABLE → 10s 预算烧完 → 旧逻辑降级"原地工作"（空地假工作）。
//      修复：planTaskRoute 在 task 搜索失败后用全边集兜底重搜（走出聊天座
//      再上 task 走廊）。
//   B. 空座位的工作站预留硬挡过路腿：工位 approach 节点紧贴过道（实测
//      desk-5-approach 距 roam-6>roam-5 走道 0.0009），座位上没人时预留仍以
      // 社交半径挡一切路过者 → 5 人同批开工互相挡死成等待环。
//      修复：movement.step 对无人占座的 workstation 预留只挡"以它为落点"
//      的腿，不再挡纯路过（主人身体到场后仍由 occupant gate 保护）。
//   C. 同一 tick 先后 plan 的两条腿 acquiredAt 相同，yield 规则的严格小于
//      比较双方都拿不出优先权 → 双双 wait。修复：平手时按 owner id 字典序
//      确定性破平，等待图无环。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const layoutCompiler = require('../src/office/runtime/office-layout-compiler.js');
const { createOfficeLayout, validateOfficeLayout } = require('../src/office/runtime/office-layout.js');
const { LAYOUT_ASSETS, DRAFT_WIDTHS, CHARACTER_FOOT_RATIO } = require('../src/office/layout-assets.js');

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const FLAT_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8'));
const ISOMETRIC_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8'));

// 座位表（subagent-classifier 的分类座位 + 根会话 + 未分类 collaborator）。
const SEAT_BY_EMPLOYEE = Object.freeze({
  orchestrator: 'desk-1',
  researcher: 'desk-2',
  coder: 'desk-3',
  reviewer: 'desk-4',
  collaborator: 'desk-5',
});
const POSITION_TOLERANCE = 0.02;
const ALL_IN_WORK_TIMEOUT_MS = 240000;
const WARMUP_MS = 60000;

// main.js 的真生产布局入口（saved draft → bundled flat → isometric）。
// 空临时 userData ⇒ 无用户保存稿，两链都应落在 bundled-flat。
function loadProductionLayoutFixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-five-workers-'));
  try {
    const resolved = officeModule.loadRuntimeLayoutFixture({ userDataDir, log: () => {} });
    assert.ok(resolved, 'loadRuntimeLayoutFixture must resolve');
    assert.equal(resolved.source, 'bundled-flat');
    assert.equal(resolved.code, null);
    return resolved.fixture;
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

// 某工位的家具 parts rect 并集（desk-N-back 桌体 + desk-N-chair 座椅 + …）。
// 员工工作的最终位置必须落在自己工位的家具范围内——这是本次缺陷的钉子。
function workstationRects(fixture, deskId) {
  return fixture.furniture
    .filter((item) => item.id.startsWith(`${deskId}-`))
    .map((item) => {
      const rect = item.parts && (item.parts.back || item.parts.front || Object.values(item.parts)[0]);
      return rect ? { id: item.id, x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height } : null;
    })
    .filter(Boolean);
}

function insideRects(rects, position) {
  return rects.some((r) => position.x >= r.x0 && position.x <= r.x1 && position.y >= r.y0 && position.y <= r.y1);
}

function deskNode(fixture, deskId) {
  const node = fixture.nodes.find((candidate) => candidate.id === deskId);
  assert.ok(node, `fixture node ${deskId} must exist`);
  return node;
}

/** 5 人同批开工驱动：根会话 agent/status{running} 绑 orchestrator；其余 4 个走
 * 适配器词汇的原始事件（raw type 是 subagent/start——runtime/subagent-start
 * 是适配器产出的 fact，不是喂给 ingestHarnessEvent 的词）；分类座位走
 * data.role，collaborator 走未分类 FIFO（无 role）。 */
function startFiveWorkers(module, sessionId) {
  let seq = 0;
  const feed = (type, data) => {
    seq += 1;
    const result = module.ingestHarnessEvent({ sessionId, type, seq, time: seq, data });
    assert.equal(result.status, 'accepted', `${type} must be accepted: ${result.code || ''}`);
  };
  feed('agent/status', { status: 'running' });
  for (const role of ['researcher', 'coder', 'reviewer']) {
    feed('subagent/start', { id: `child-${role}`, runId: `run-${role}`, role, mode: 'one-shot', label: role });
  }
  feed('subagent/start', { id: 'child-collab', runId: 'run-collab', mode: 'one-shot' });
}

function perEmployeeState(module, fixture) {
  return module.state().employees.map((employee) => {
    const deskId = SEAT_BY_EMPLOYEE[employee.employeeId];
    const node = deskNode(fixture, deskId);
    const position = employee.position;
    return {
      employeeId: employee.employeeId,
      phase: employee.transition ? employee.transition.phase : '(none)',
      activity: employee.activity,
      bound: employee.binding !== null && employee.binding !== undefined,
      position: { x: Number(position.x.toFixed(4)), y: Number(position.y.toFixed(4)) },
      distanceToDesk: Number(Math.hypot(node.position.x - position.x, node.position.y - position.y).toFixed(4)),
    };
  });
}

function driveFiveWorkersToWork(seed) {
  const fixture = loadProductionLayoutFixture();
  const module = officeModule.createOfficeModule({
    pack: PACK,
    seed,
    layout: fixture,
  });
  try {
    // 开工前的真实办公室生活：本地行为（漫游/聊天/小憩）先跑 60s——缺陷正是
    // 在"绑定落在任意一个常态位置（含聊天座、走廊）"时触发的。
    for (let i = 0; i < Math.round(WARMUP_MS / officeModule.TICK_MS); i += 1) module.tickOnce();

    startFiveWorkers(module, `session-five-${seed}`);

    // ① 5 人同时进入 work 相位（同一份快照内全员 work）。
    const steps = Math.round(ALL_IN_WORK_TIMEOUT_MS / officeModule.TICK_MS);
    let allWork = false;
    for (let i = 0; i < steps; i += 1) {
      module.tickOnce();
      const employees = module.state().employees;
      if (employees.length >= 5
        && employees.every((employee) => employee.transition && employee.transition.phase === 'work')) {
        allWork = true;
        break;
      }
    }
    assert.ok(
      allWork,
      `all 5 employees must enter work phase within ${ALL_IN_WORK_TIMEOUT_MS}ms sim; per-employee state:\n`
      + perEmployeeState(module, fixture).map((s) => JSON.stringify(s)).join('\n'),
    );

    // ② ③ 逐人位置校验（同一份全员 work 的快照）。
    const state = module.state();
    assert.equal(state.employees.length, 5);
    for (const employee of state.employees) {
      const deskId = SEAT_BY_EMPLOYEE[employee.employeeId];
      assert.ok(deskId, `unexpected employee ${employee.employeeId}`);
      const node = deskNode(fixture, deskId);
      const position = employee.position;
      const distance = Math.hypot(node.position.x - position.x, node.position.y - position.y);
      assert.ok(
        distance <= POSITION_TOLERANCE,
        `${employee.employeeId} must sit at ${deskId} (±${POSITION_TOLERANCE}); `
        + `distance=${distance.toFixed(4)} position=(${position.x.toFixed(4)},${position.y.toFixed(4)}) `
        + `node=(${node.position.x.toFixed(4)},${node.position.y.toFixed(4)})`,
      );
      const rects = workstationRects(fixture, deskId);
      assert.ok(rects.length >= 2, `${deskId} furniture must declare its parts`);
      assert.ok(
        insideRects(rects, position),
        `${employee.employeeId} must work INSIDE its own workstation furniture (${deskId}-*); `
        + `position=(${position.x.toFixed(4)},${position.y.toFixed(4)}) rects=${JSON.stringify(rects)}`,
      );
      assert.ok(
        employee.binding !== null && employee.binding !== undefined,
        `${employee.employeeId} must still be bound while in work phase`,
      );
    }
    return state.employees.map((employee) => ({
      employeeId: employee.employeeId,
      desk: SEAT_BY_EMPLOYEE[employee.employeeId],
      x: Number(employee.position.x.toFixed(4)),
      y: Number(employee.position.y.toFixed(4)),
    }));
  } finally {
    module.destroy();
  }
}

test('layout source chain: module and renderer resolve the SAME bundled-flat fixture (single source)', () => {
  const moduleFixture = loadProductionLayoutFixture();

  // 渲染器链（office.html boot）：resolveRuntimeLayout({ savedDraft: undefined,
  // flatFixture, isometricFixture, validateLayout }) —— 与模块链同一编译入口。
  const rendererResolution = layoutCompiler.resolveRuntimeLayout({
    savedDraft: undefined,
    flatFixture: FLAT_FIXTURE,
    isometricFixture: ISOMETRIC_FIXTURE,
    validateLayout: (fixture) => validateOfficeLayout(fixture),
    assets: LAYOUT_ASSETS,
    draftWidths: DRAFT_WIDTHS,
    characterFoot: CHARACTER_FOOT_RATIO,
  });
  assert.equal(rendererResolution.ok, true);
  assert.equal(rendererResolution.source, 'bundled-flat');
  assert.deepEqual(rendererResolution.layout, moduleFixture, 'renderer chain and module chain must serve the identical fixture');

  // 编译产物内部一致：workstation 座位锚点 === 工位节点坐标（渲染的家具
  // rect 与仿真的落座点同源）。
  const layout = createOfficeLayout(moduleFixture);
  for (const deskId of ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6']) {
    const instance = layout.workstation(deskId);
    const node = layout.nodeById(deskId);
    assert.ok(instance && node, `${deskId} workstation instance and node must exist`);
    assert.deepEqual(instance.seat.position, { x: node.position.x, y: node.position.y });
  }
});

test('five workers enter work state simultaneously and each sits INSIDE its own workstation furniture (seed five-a)', () => {
  const summary = driveFiveWorkersToWork('office-five-a');
  assert.equal(summary.length, 5);
});

test('five workers converge to their own desks across seeds (five-b, five-c)', () => {
  for (const seed of ['office-five-b', 'office-five-c']) {
    const summary = driveFiveWorkersToWork(seed);
    assert.equal(summary.length, 5);
  }
});
