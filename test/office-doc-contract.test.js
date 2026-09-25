// test/office-doc-contract.test.js — Task 0 / SPEC-00 documentation contract gate.
// Freezes the approved Virtual Office vocabulary: sections whose header is
// explicitly marked historical are not implementation input, and no active
// section may claim Harness natively provides adapter-derived fields.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readDoc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const SUPERSEDED_HEADER =
  /(Superseded|取代|历史候选|历史评估|历史盘点|历史示例)/;

function activeText(doc) {
  let suppressed = false;
  const lines = [];
  for (const line of doc.split('\n')) {
    if (/^#{1,6}\s/.test(line)) suppressed = SUPERSEDED_HEADER.test(line);
    if (!suppressed) lines.push(line);
  }
  return lines.join('\n');
}

const master = readDoc('总纲.md');
const discussion = readDoc('docs/specs/OFFICE-DESIGN-DISCUSSION.md');
const research = readDoc('docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md');
const plan = readDoc(
  'docs/superpowers/plans/2026-08-30-virtual-office-runtime-implementation.md'
);
const spec00 = readDoc(
  'docs/superpowers/specs/2026-08-30-office-spec-00-boundaries.md'
);
const specIndex = readDoc(
  'docs/superpowers/specs/2026-08-30-office-development-spec-index.md'
);

const activeMaster = activeText(master);
const activeDiscussion = activeText(discussion);

test('SPEC-00 freezes the canonical state dimension vocabulary', () => {
  assert.match(spec00, /presence: present/);
  assert.match(spec00, /sync: healthy \| stale \| resyncing/);
  assert.match(
    spec00,
    /runtime: unbound \| idle \| running \| attention \| completed \| failed/
  );
  assert.match(
    spec00,
    /activity: roaming \| chatting \| resting \| sleeping \| working \| thinking \| waiting \| celebrating/
  );
  assert.match(spec00, /movement: stationary \| moving \| arriving \| leaving/);
  assert.match(
    spec00,
    /control: none \| dispatchPending \| cancellationPending \| preemptPending/
  );
  assert.match(spec00, /binding: unbound \| pending \| bound \| releasing/);
  assert.match(spec00, /queue: empty \| queued/);
  assert.match(discussion, /### 决策 16：Agent 状态采用四层模型/);
  assert.match(activeDiscussion, /movement=moving/);
});

test('four residents, one collaborator and the 2x3 layout stay frozen', () => {
  assert.match(discussion, /### 决策 1：第一版采用 4 名常驻员工/);
  assert.match(discussion, /### 决策 5：并发任务使用一个动态“协作者”席位/);
  assert.match(discussion, /### 决策 8：六工位向右下方小幅偏移/);
  assert.match(
    spec00,
    /`orchestrator`、`researcher`、`coder`、`reviewer`；一个动态 collaborator/
  );
  assert.match(spec00, /2x3 六工位/);
  assert.match(activeMaster, /orchestrator/);
  assert.match(activeMaster, /collaborator/);
});

test('flat orthographic projection stays the frozen scene contract', () => {
  assert.match(discussion, /### 决策 32：第一版采用扁平 Marvis 式 2D 正交办公室/);
  assert.match(discussion, /### 决策 33：扁平 2D 场景使用固定层级和局部前景遮挡/);
  assert.match(activeMaster, /扁平 2D 正交/);
});

test('local sleep stays a local activity and offline stays removed', () => {
  assert.match(discussion, /### 决策 21：常驻员工不使用 offline，长时间空闲进入睡眠行为/);
  assert.match(activeDiscussion, /activity=sleeping/);
  assert.match(activeMaster, /第一版不把 `offline` 作为常驻员工状态/);
});

test('eventId/sessionEpoch stay adapter-derived and never Harness-native', () => {
  assert.match(discussion, /是 Adapter 派生字段，不是 Harness 原生字段/);
  assert.match(research, /没有原生 `eventId` 或 `sessionEpoch`/);
  assert.match(research, /sequenceSource=adapter/);
  assert.match(plan, /derive adapter `eventId\/sessionEpoch` with source markers/);
  const docs = [
    ['总纲.md', activeMaster],
    ['OFFICE-DESIGN-DISCUSSION.md', activeDiscussion],
    ['HARNESS-RUNTIME-EVIDENCE-2026-08.md', research],
  ];
  for (const [name, doc] of docs) {
    for (const line of doc.split('\n')) {
      if (/eventId|sessionEpoch/.test(line) && /Harness/.test(line)) {
        assert.match(
          line,
          /不|非|没有|均属于|假定|Adapter|适配|派生|derived/i,
          `${name} claims Harness-native event identity: ${line.trim()}`
        );
      }
    }
  }
});

test('control matrix stays explicit: pause/resume unsupported, preempt is queue policy', () => {
  assert.match(research, /未发现原生 pause RPC\/事件/);
  assert.match(research, /未发现与 pause 配对的原生 resume/);
  assert.match(discussion, /当前 Harness 未提供 pause\/resume，第一版 UI 不暴露这两个控制/);
  assert.match(plan, /Do not expose pause\/resume or native preempt/);
  assert.match(spec00, /pause\/resume\/preempt UI/);
  assert.match(activeMaster, /pause\/resume 不支持/);
});

test('office snapshot schema, storage ownership and feature flags stay canonical', () => {
  assert.match(plan, /office:runtime-resync-request/);
  assert.match(plan, /office:runtime-snapshot/);
  assert.match(plan, /eventsSince/);
  assert.match(discussion, /`eventId\/sessionId\/sessionEpoch\/sequence\/eventType\/payload` 信封/);
  assert.match(plan, /办公室设置的唯一持久化来源是新文件 `userData\/office-state\.v1\.json`/);
  // 2026-09-17 M4 修订：计划文档保留原文 + 修订注记（officeRuntimeEnabled 翻转），
  // 总纲 §0 的同款修订由下方 activeMaster 断言锁定
  assert.match(plan, /`officeRuntimeEnabled`（默认 `false`，生产开关）/);
  assert.match(plan, /修订（2026-09-17，用户拍板 M4 直启动）\*\*：`officeRuntimeEnabled` 默认值改为 `true`/);
  assert.match(plan, /`officePlaygroundEnabled` 保持 `false`/);
  assert.match(activeMaster, /office-state\.v1/);
  assert.match(activeMaster, /officeRuntimeEnabled/);
  assert.match(activeMaster, /officePlaygroundEnabled/);
});

test('historical undecided sections are marked Superseded', () => {
  assert.match(discussion, /## 动画方案评估（2026-08-29，历史评估，Superseded/);
  assert.match(discussion, /## 总纲差距盘点（2026-08-29，历史盘点，Superseded/);
  assert.match(master, /## 0\. 实现词汇冻结（Task 0，2026-08-30）/);
  assert.match(master, /### 6\.1 历史角色示例（Superseded/);
  assert.match(master, /### 7\.1 历史映射示例（Superseded/);
  assert.match(master, /### 8\.1 历史状态清单（Superseded/);
  assert.match(master, /### 8\.3 历史扩展词（Superseded/);
  assert.match(master, /### ③ 历史状态枚举（Superseded/);
  assert.match(master, /# 38\. 下一阶段工作要求（历史阶段门禁，Superseded/);
  assert.doesNotMatch(activeMaster, /第一阶段至少定义以下状态/);
  assert.doesNotMatch(activeMaster, /Frontend Developer/);
  assert.doesNotMatch(activeMaster, /Runtime = Working/);
  assert.doesNotMatch(activeMaster, /01-product-spec\.md/);
});

test('GitHub character-pack import is explicitly post-MVP in the master outline', () => {
  assert.match(master, /后续阶段（post-MVP）从 GitHub 导入/);
  assert.match(master, /后续阶段（post-MVP）从社区市场获取/);
  assert.match(activeMaster, /仅限内置角色、本地文件夹和本地 ZIP/);
  assert.match(plan, /GitHub import remains post-MVP/);
});

test('plan and index keep the Task->SPEC map and the source-of-truth table', () => {
  assert.match(plan, /Task 0 -> SPEC-00/);
  assert.match(plan, /Task 9 -> SPEC-09/);
  assert.match(specIndex, /## 状态来源原则/);
  assert.match(specIndex, /\| Harness Runtime \|/);
  assert.match(specIndex, /\| Local Scheduler \|/);
  assert.match(specIndex, /2026-08-30-office-spec-00-boundaries\.md/);
  assert.match(specIndex, /2026-08-30-office-spec-09-acceptance\.md/);
});

test('renderer size contract stays frozen', () => {
  assert.match(plan, /visibleHeight = clamp\(64px, sceneHeight \* 0\.11, 180px\)/);
  assert.match(discussion, /visibleHeight = clamp\(64px, sceneHeight \* 0\.11, 180px\)/);
});
