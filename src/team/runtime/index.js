'use strict';

// src/team/runtime/index.js — Team Runtime v0 聚合面。
//
// 与 src/office/runtime/index.js 同一模式：版本常量 + 冻结清单 + 分组导出。
// 边界（契约 §10）：Team Runtime 是**无 UI、纯 Node** 的独立层 —— 不 import
// office-module、不写 office 状态、不使用 Electron/DOM/Pixi/fs/网络/LLM。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md

const schema = require('./team-schema.js');
const runtime = require('./team-runtime.js');
const officeAdapter = require('./team-office-adapter.js');
const officeBridge = require('./team-office-bridge.js');
// v0.6（WP5）：team-office-demo.js / team-executor-demo.js 已归档到
// archive/team-demos/（真实入口覆盖其用途；见 docs/specs/HARNESS-V0.6-PLAN）。
const executionSchema = require('./execution-schema.js');
const executionPort = require('./execution-port.js');
const fakeExecutor = require('./fake-executor.js');
const executionController = require('./team-execution-controller.js');
const dshBackend = require('./dsh-execution-backend.js');

// Team 运行时的文件清单（相对本目录）。新增文件必须显式登记 —— 与 office 内核
// 门禁同一纪律，test/team-runtime-v0.test.js 会校验集合相等。
const TEAM_SURFACE_FILE = 'index.js';
const TEAM_MODULES = Object.freeze([
  'dsh-execution-backend.js',
  'execution-port.js',
  'execution-schema.js',
  'fake-executor.js',
  'team-execution-controller.js',
  'team-office-adapter.js',
  'team-office-bridge.js',
  'team-runtime.js',
  'team-schema.js',
]);

module.exports = {
  // 版本与清单
  TEAM_SCHEMA_VERSION: schema.TEAM_SCHEMA_VERSION,
  TEAM_RUNTIME_VERSION: runtime.TEAM_RUNTIME_VERSION,
  TEAM_SURFACE_FILE,
  TEAM_MODULES,

  // 分组命名空间
  schema,
  runtime,
  officeAdapter,
  officeBridge,
  executionSchema,
  executionPort,
  fakeExecutor,
  executionController,
  dshBackend,

  // 常用入口
  createTeamRuntime: runtime.createTeamRuntime,
  // 第二阶段第 5 项：Team → Office 白名单映射与驱动桥（纯模块）
  createTeamOfficeAdapter: officeAdapter.createTeamOfficeAdapter,
  createTeamOfficeBridge: officeBridge.createTeamOfficeBridge,
  // Worker Execution Contract v0：执行端口 + 确定性 FakeExecutor + 唯一窄转换层。
  EXECUTION_SCHEMA_VERSION: executionSchema.EXECUTION_SCHEMA_VERSION,
  EXECUTION_EVENT_TYPES: executionSchema.EXECUTION_EVENT_TYPES,
  EXECUTION_CODES: executionSchema.EXECUTION_CODES,
  validateExecutionEvent: executionSchema.validateExecutionEvent,
  evidenceForExecutionEvent: executionSchema.evidenceForExecutionEvent,
  execJobRefFor: executionSchema.execJobRefFor,
  executionRefFor: executionSchema.executionRefFor,
  assertExecutorPort: executionPort.assertExecutorPort,
  assertExecutionHandle: executionPort.assertExecutionHandle,
  createFakeExecutor: fakeExecutor.createFakeExecutor,
  FAKE_SCENARIOS: fakeExecutor.SCENARIOS,
  createTeamExecutionController: executionController.createTeamExecutionController,
  TEAM_EXECUTION_CONTROLLER_VERSION: executionController.CONTROLLER_VERSION,
  // 阶段 5：DeepSeek dsh 执行后端最小适配骨架（形状 + 注入 transport，默认无网络）。
  createDshExecutionBackend: dshBackend.createDshExecutionBackend,
  createInjectedTransport: dshBackend.createInjectedTransport,
  DSH_EXECUTION_MAPPING: dshBackend.DSH_EXECUTION_MAPPING,
  DSH_BACKEND_GAPS: dshBackend.DSH_BACKEND_GAPS,
  TEAM_ROLE_TO_SEAT: officeAdapter.TEAM_ROLE_TO_SEAT,
  OFFICE_FACT_KINDS: officeAdapter.OFFICE_FACT_KINDS,
  TEAM_FACT_TO_OFFICE_KIND: officeAdapter.TEAM_FACT_TO_OFFICE_KIND,
  fold: runtime.fold,
  convergedJobStatus: runtime.convergedJobStatus,
  derivedJobStatus: runtime.derivedJobStatus,
  initialJobState: runtime.initialJobState,

  // 冻结词表 / 常量
  ROLES: schema.ROLES,
  RUN_STATUSES: schema.RUN_STATUSES,
  JOB_STATUSES: schema.JOB_STATUSES,
  TERMINAL_RUN_STATUSES: schema.TERMINAL_RUN_STATUSES,
  TERMINAL_JOB_STATUSES: schema.TERMINAL_JOB_STATUSES,
  TERMINAL_OUTCOMES: schema.TERMINAL_OUTCOMES,
  ARTIFACT_KINDS: schema.ARTIFACT_KINDS,
  FACT_TYPES: schema.FACT_TYPES,
  ERROR_CODES: schema.ERROR_CODES,
  TEAM_V0_PLAN: schema.TEAM_V0_PLAN,
  TEAM_V0_BUDGET: schema.TEAM_V0_BUDGET,
  FACTS_MAX: schema.FACTS_MAX,
  EVIDENCE_MAX_CHARS: schema.EVIDENCE_MAX_CHARS,

  // 身份派生
  runIdFor: schema.runIdFor,
  artifactIdFor: schema.artifactIdFor,
  digestFor: schema.digestFor,
  dedupeKeyFor: schema.dedupeKeyFor,
  planMatchesV0: schema.planMatchesV0,
};
