'use strict';

// src/office/runtime/index.js — Harness Runtime Kernel 聚合面（第 0 步工程任务）。
//
// 这个文件是 `src/office/runtime/` 的**唯一聚合入口**，也是"纯内核边界"的
// 机器可读清单：契约文档 docs/specs/HARNESS-RUNTIME-CONTRACT-v0.md §2.3 与本
// 文件必须一致，test/office-runtime-boundary.test.js 强制二者与实际目录集合
// 相等——任何新增模块都必须显式登记，不允许"悄悄多一个文件"。
//
// 边界含义（与契约 §2.2 一致）：
//   - KERNEL_MODULES：无 UI、无 IO、无网络、可测试、可复用的纯模块。不得
//     require electron / pixi.js / DOM / UI 文件 / office-module.js / render/**。
//   - IO_BOUNDARY_MODULES：同属产品代码，但**按契约**拥有明确的 IO 边界
//     （SPEC-08 存储单写者、角色包安装/校验、shell 成本读取）。它们不是纯内核。
//   - GUARDED_SHELL_EDGES：唯一已知的"纯模块 → 壳模块"静态边。登记它而不是
//     假装不存在：门禁持续验证该边的 electron require 仍是惰性 + 容错。
//
// 本文件只做聚合导出与常量声明：不改变任何模块的行为、事件命名或状态枚举。

const KERNEL_SCHEMA_VERSION = 1;
const KERNEL_VERSION = 'harness-runtime-kernel-1';
// 聚合面自身：不属于 KERNEL_MODULES（它是清单的持有者），但参与目录集合校验。
const KERNEL_SURFACE_FILE = 'index.js';

// 纯内核模块（相对本目录的文件名，按字母序冻结）。新增纯模块必须同时更新
// 本清单与契约文档，否则门禁失败。
const KERNEL_MODULES = Object.freeze([
  'animation-controller.js',
  'approval-risk.js',
  'asset-pack.js',
  'behavior-scheduler.js',
  'dialogue-engine.js',
  'employee-profile.js',
  'employee-registry.js',
  'follow-address.js',
  'idle-director.js',
  'movement-controller.js',
  'office-layout-compiler.js',
  'office-layout.js',
  'pending-mirror.js',
  'privacy-redactor.js',
  'queue-controller.js',
  'runtime-adapter.js',
  'runtime-snapshot.js',
  'state-reducer.js',
  'subagent-classifier.js',
  'subagent-wiring.js',
  'tool-phrases.js',
  'transition-controller.js',
  'workstation-layout.js',
]);

// 显式 IO 边界模块：允许 node:fs / node:path（/zlib/crypto），因为它们的职责
// 就是 IO 或校验。usage-snapshot.js 自身只用到纯 billingDayKey，但静态边经
// `../../cost.js` 拖入 shell 的 fs——按"最坏可达性"归类为 IO 边界，而不是假装纯。
const IO_BOUNDARY_MODULES = Object.freeze([
  'character-pack-installer.js',
  'office-persistence.js',
  'usage-snapshot.js',
  'validate-character-pack.js',
]);

// 受保护壳边：**当前为空**。
//
// 第 0 步审计时这里有唯一一条例外：`tool-phrases.js` require `../../i18n.js`
// （后者惰性 require electron）。收尾阶段已把运行时需要的 9 条 zh 短语下沉到
// tool-phrases.js 自身的冻结词表，纯内核因此**静态**不再触达壳的 i18n/Electron
// —— 例外随之删除（契约 §17-1 已闭环）。
//
// 机制保留而不是删掉：如果将来确实必须引入一条"纯模块 → 壳模块"的静态边，
// 它必须显式登记在这里（含 `allows` 裸说明符白名单与理由），否则
// test/office-runtime-boundary.test.js 的闭包门禁会失败。**默认应当是没有例外。**
const GUARDED_SHELL_EDGES = Object.freeze([]);

// ---- 事实链核心模块（按职责分组，避免扁平重名） ------------------------------

const privacy = require('./privacy-redactor.js');
const snapshot = require('./runtime-snapshot.js');
const adapter = require('./runtime-adapter.js');
const reducer = require('./state-reducer.js');
const registry = require('./employee-registry.js');
const queue = require('./queue-controller.js');
const transitions = require('./transition-controller.js');
const classifier = require('./subagent-classifier.js');
const wiring = require('./subagent-wiring.js');
const profiles = require('./employee-profile.js');

module.exports = {
  // 版本与边界清单
  KERNEL_SCHEMA_VERSION,
  KERNEL_VERSION,
  KERNEL_SURFACE_FILE,
  KERNEL_MODULES,
  IO_BOUNDARY_MODULES,
  GUARDED_SHELL_EDGES,

  // 分组导出（完整命名空间，避免 TERMINAL_OUTCOMES / SCHEMA_VERSION 之类重名）
  privacy,
  snapshot,
  adapter,
  reducer,
  registry,
  queue,
  transitions,
  classifier,
  wiring,
  profiles,

  // 事实链常用入口（扁平别名，便于组合根/探针/测试直接取用）
  createPrivacyRedactor: privacy.createPrivacyRedactor,
  createRuntimeAdapter: adapter.createRuntimeAdapter,
  deriveRunProxy: adapter.deriveRunProxy,
  canonicalJson: adapter.canonicalJson,
  createOfficeState: reducer.createOfficeState,
  reduceOfficeState: reducer.reduceOfficeState,
  createEmployeeRegistry: registry.createEmployeeRegistry,
  createQueueController: queue.createQueueController,
  createTransitionController: transitions.createTransitionController,
  classifySubagent: classifier.classifySubagent,
  createSubagentWiring: wiring.createSubagentWiring,
  settlementStopReason: wiring.settlementStopReason,
  listResidentProfiles: profiles.listResidentProfiles,
  getCollaboratorProfile: profiles.getCollaboratorProfile,

  // 契约里被反复引用的冻结常量（测试与门禁共用同一份，避免各处重复字面量）
  ADAPTER_VERSION: adapter.ADAPTER_VERSION,
  EPOCH_PREFIX: adapter.EPOCH_PREFIX,
  SNAPSHOT_SCHEMA_VERSION: snapshot.SCHEMA_VERSION,
  SNAPSHOT_FACT_KEYS: snapshot.SNAPSHOT_FACT_KEYS,
  SNAPSHOT_RUNTIME_VALUES: snapshot.SNAPSHOT_RUNTIME_VALUES,
  RESYNC_RETRY_SCHEDULE_MS: snapshot.RESYNC_RETRY_SCHEDULE_MS,
  RESYNC_MAX_ATTEMPTS: snapshot.RESYNC_MAX_ATTEMPTS,
  RESYNC_REQUEST_TTL_MS: snapshot.RESYNC_REQUEST_TTL_MS,
  RESYNC_REQUEST_TYPE: snapshot.RESYNC_REQUEST_TYPE,
  SNAPSHOT_TYPE: snapshot.SNAPSHOT_TYPE,
  RUNTIME_STATES: reducer.RUNTIME_STATES,
  SYNC_STATES: reducer.SYNC_STATES,
  ACTIVITY_STATES: reducer.ACTIVITY_STATES,
  LOCAL_ACTIVITIES: reducer.LOCAL_ACTIVITIES,
  MOVEMENT_STATES: reducer.MOVEMENT_STATES,
  BINDING_STATES: reducer.BINDING_STATES,
  CONTROL_STATES: reducer.CONTROL_STATES,
  QUEUE_STATES: reducer.QUEUE_STATES,
  PRESENCE_STATES: reducer.PRESENCE_STATES,
  DEFAULT_CAPABILITIES: reducer.DEFAULT_CAPABILITIES,
  BINDING_SOURCES: registry.BINDING_SOURCES,
  TERMINAL_STOP_REASONS: registry.TERMINAL_STOP_REASONS,
  NON_TERMINAL_EVIDENCE: registry.NON_TERMINAL_EVIDENCE,
  CLASSIFIED_SEATS: classifier.CLASSIFIED_SEATS,
  TASK_START_PHASES: transitions.TASK_START_PHASES,
  TASK_END_PHASES: transitions.TASK_END_PHASES,
};
