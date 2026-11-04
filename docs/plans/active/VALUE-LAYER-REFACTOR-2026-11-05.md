# 价值层重构计划：SDK 桥接 + Mission Memory + 任务检查器（2026-11-05）

> 状态：**已批准（2026-11-05 用户拍板三项决策，见 §2）**
> 上游：`docs/research/memory-and-sdk-validation-2026-11-05.md`（证据底座）、`/Users/xia/Downloads/ChatGPT_重构项目价值定位_20261105-0246.md`（用户与 GPT 的新架构讨论）、`docs/plans/active/NEW-DIRECTION-PERSONAL-TEAM-2026-11-03.md`（新方向总计划，本文是其运行时与记忆层的落地升级）
> 立场继承：`AGENTS.md`（Harness 拥有执行事实；不写第二套事实源）、`docs/adr/ADR-0005-memory-official-stack.md`（零第三方 Memory Provider）
> 本文与 `AGENTS.md` §4 的"计划先行"流程对齐：批准后进入实施。

---

## 0. 一句话定位

> **DshCockpit 的价值不在重复官方桌面壳，而在三件事：项目级持久记忆（Mission Memory）、任务级执行闭环（SDK 桥接）、可检查可回放的工作台（任务检查器）。执行事实永远属于 Harness，DshCockpit 只做记忆、检查与呈现。**

---

## 1. 问题陈述（为什么重构）

| # | 问题 | 证据 |
|---|---|---|
| P1 | 任务执行链路依赖 journal 尾随 + 旧 Team Runtime 投影，链路长、脆弱、无推送语义 | `src/runtime-mux.js`、`src/team/runtime/**`；`docs/architecture/data-flow.md` |
| P2 | Mission Core 只有**任务派发事实**（Mission/Workstream/TaskRef），没有**执行经验记忆**（失败尝试、决策、教训），跨会话不可复利 | `src/mission/schema.js` 事件类型盘点；`docs/quality/prompt-gap-analysis-2026-11-01.md`（Shared Context 只做了 1/3） |
| P3 | 单任务没有"检查器"视图：想知道一个任务里 agent 到底做了什么，只能翻原始日志 | 无对应 UI；事件溯源基础已具备但未暴露 |
| P4 | 自研 Team Runtime 与官方 Agent Teams 双轨，维护成本高 | `docs/adr/ADR-0002-consume-official-agent-teams.md` |
| P5 | 官方 SDK Client（stdio JSON-RPC、结构化事件流）已可用而壳未接入 | `docs/research/memory-and-sdk-validation-2026-11-05.md` §3 真机验证 |

## 2. 用户拍板记录（2026-11-05）

| 决策点 | 结论 |
|---|---|
| 记忆引擎 | **自研 Mission Memory**——但设计必须参考 projectmem 与 AgentMemory 的已验证设计（§4.2），不闭门造车；维持 ADR-0005 零第三方立场 |
| 运行时桥接 | **SDK Client 替换 + journal 只读**：新任务全走 SDK 通道，runtime-mux 降级为桌面版事实只读源，可回滚 |
| 真机测试 | 已完成（StepFun step-5-preview，证据见验证报告 §3）；后续实施阶段的真机验证按需另行申请 key |

---

## 3. Phase 1 —— SDK 桥接（先打地基）

**目标**：任务执行从"journal 尾随"切换为"进程内 SDK 事件流推送"，投影层零改动。

### 3.1 新增 `src/harness/sdk-bridge.js`

- 封装 `DeepSeekHarness`（`@deepseek-ai/dsh-sdk-client`）：
  - launch spec：`dsh --profile sdk-minimal`（或后续切 `sdk` 全量 profile），**隔离 `DSH_HOME`**（不与桌面版共享 profile 目录）。
  - provider 配置：默认走 `DEEPSEEK_BASE_URL` 环境变量（任何 chat completions 兼容网关直通，模型 ID 不经目录校验——真机已验证）。
  - 生命周期：握手重试（SDK 自带 fresh-subprocess 重试）、优雅关闭梯子（SDK 已内置 stdin EOF → SIGTERM → SIGKILL）。
- 事件 adapter：`session.event`（wire 信封）→ `ingestHarnessEvent` 所需的 office 事实格式。**只做翻译，不做第二投影**。
- 幂等：以 `(sessionId, eventSeq)` 去重，与现有 `seqForMissionSession` 对齐。

### 3.2 接线与降级

- `missionPromptSession`（`src/main.js`）改为经 sdk-bridge 派发；`run()` 的 `events` 数组按序入 office 投影。
- `runtime-mux` 保留但降级：**只读**消费桌面版 journal（共存模式事实源），不再承担派发；入口开关 `bridgeMode: 'sdk' | 'journal-readonly'`，可回滚。
- 旧 Team Runtime（`src/team/runtime/**`）在本阶段完成后进入退役流程（对齐 ADR-0002）。

### 3.3 依赖与门禁

- `package.json` 新增 `@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh-sdk-protocol`；**锁死 cordis 版本约束**（`@deepseek-ai/cordis ~4.0.5` 全家桶，禁止显式引入会拉 4.1.x 的包——验证报告 E3 崩溃证据）。
- 新增 CI 检查：依赖树中 cordis 版本一致性（失败即红）。
- rc 版本隔离：所有 SDK 类型经 adapter 层收窄，协议字段变化只允许改 adapter 一处。

### 3.4 退出条件

1. 隔离环境（无 key）握手冒烟进 CI。
2. 真机（StepFun 或用户申请的 key）：问答 + 工具循环事件流与现有 office 投影对账一致。
3. `bridgeMode` 双模切换可用，journal 只读模式无回归（现有测试全绿）。

---

## 4. Phase 2 —— Mission Memory（核心价值层）

**目标**：Mission Core 从"任务派发事实源"扩展为"项目经验记忆中心"，跨会话复利。

### 4.1 不做什么（边界）

- **不复制执行事实**：Harness journal 仍是执行事实唯一来源；Mission Memory 只存**经验层**（人的判断、派生结论、失败教训），全部带来源引用（sessionId/TaskRef）。
- **不引入第三方引擎**：不装 projectmem/AgentMemory/iii-engine；不加新进程、端口、token。
- **不做向量库**：第一版检索用轻量方案（见 4.3），语义检索 Deferred。

### 4.2 事件模型扩展（参考两家，自研落地）

`src/mission/schema.js` 新增事件类型（沿用 append-only `events.jsonl` + 投影）：

| 事件 | 参考 | 字段要点 |
|---|---|---|
| `memory/attempt` | projectmem `attempt` | issueRef、描述、`worked/failed/partial`、位置（`file:line` 或模块名）、来源 TaskRef |
| `memory/decision` | projectmem `decision` | 决策内容、可退役旧决策（`retires`）、理由、上下文引用 |
| `memory/lesson` | AgentMemory lessons | 跨会话教训、适用条件、置信度 |
| `memory/gotcha` | projectmem gotchas | 项目坑位、触发条件、规避方法 |

配套投影与查询（`src/mission/`）：
- **Brief 增强**（参考 projectmem `brief`）：`brief-sync.js` 写入 AGENTS.md 时带上"失败尝试警告 + 开放问题 + 近期决策"（警告按位置命中，防止重复踩坑——projectmem 已验证的核心价值）。
- **派发前检查**：`confirmDispatch` 时按任务描述/目标文件命中历史失败尝试，在 UI 提示（不阻断，只提醒）。
- **捕获纪律**（参考 AgentMemory 单写入者 + 隐私过滤）：attempt/lesson 的产生只有两个入口——用户在 UI 显式记录、任务收尾时由**最终 assistant 消息 + 人工确认**派生草稿；绝不自动从中间事件抓取。`PRIVACY_FORBIDDEN_FIELDS` 规则同样适用于记忆事件。
- **陈旧检测**（参考 projectmem staleness）：记忆引用的位置/文件变更时标记 stale，Brief 中降权展示。

### 4.3 检索（第一版）

- 子串/词法检索直接复用 event-log 扫描（projectmem `search` 同级能力）。
- 排序 = 时间新近度 × importance（AgentMemory 字段思路）× 命中位置权重。
- 语义检索（BM25/向量）Deferred：等真实使用量证明词法不够再立项，避免为想象中的需求引入依赖。

### 4.4 退出条件

1. schema 扩展 + 投影 + 隐私门禁测试全绿（含 `FORBIDDEN_PERSISTED_FIELDS` 扩展）。
2. Brief 跨会话真机验证：新会话 agent 能从 AGENTS.md 读出失败尝试警告（复用既有 brief 验收方法）。
3. 记忆事件全部可溯源（无来源引用的写入被 schema 拒绝）。

---

## 5. Phase 3 —— 任务检查器与回放

**目标**：单任务全事件时间线 UI——"这个任务里 agent 到底做了什么"一屏可查。

- 数据源：Phase 1 SDK `events` 数组（已含 `tool/call`、`tool/result`、`assistant/message`、`step/start|end`、`turn/*` 全系）+ journal 只读回放（桌面版共存任务）。
- UI：Mission Desk 详情区新增"检查器"页签：时间线（步骤/工具/消息三泳道）、单事件详情、失败定位（第一个 `tool/result` 错误高亮）。
- 复用 `TaskRef.deriveHarnessRef` 作为回放键；**只读**，不提供"编辑历史"。
- Office 场景保持状态总览定位，不做逐事件渲染（渲染带宽铁律不变）。

**退出条件**：真机跑一个含工具调用的任务，检查器时间线与 `events` 数组逐条对账一致。

## 6. Phase 4 —— 清理

- 旧 Team Runtime（`src/team/runtime/**`）退役删除；相关契约文档移入归档并注明原因。
- `runtime-mux` 最终形态确认（只读 or 完全移除，视桌面版共存需求）。
- ACP（`@deepseek-ai/dsh-acp`）持续观察 npm 依赖完整性（缺 `dsh-type-meta`），可用后再评估是否作为自动化通道，当前不纳入。

---

## 7. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | rc 版本 API 不稳（dsh 0.2.1-rc.5 / sdk-client 0.0.1-rc.1） | adapter 层收窄协议面；锁版本；升级走 RUNTIME-UPGRADE 计划流程 |
| R2 | cordis 版本污染导致启动崩溃（已实证） | CI 一致性门禁 + 禁引清单注释写进 package.json |
| R3 | SDK 通道与桌面版 Harness 的会话双轨（两套 session 事实） | Mission 侧以 TaskRef 统一引用；桌面版任务走 journal 只读投影，UI 标注来源通道 |
| R4 | 记忆层膨胀成第二事实源 | §4.1 边界 + 事件必须带来源引用 + 隐私门禁测试 |
| R5 | 测试环境伪影（PTY/网络/shim，验证报告 §5） | 环境坑清单进 AGENTS 附录；真机验收项明确标注所需环境 |

## 8. 测试策略

- **单元**：sdk-bridge adapter 事件映射（wire 样本固定为 fixture）；memory schema/投影/隐私门禁。
- **集成（无 key）**：隔离 DSH_HOME 握手冒烟进 CI（验证报告已验证可行性）。
- **真机（需 key，另行申请）**：问答、工具循环、检查器对账、Brief 跨会话。
- **门禁不变**：`CI=1 npm test` 全绿基线 + 新增 cordis 一致性检查。

## 9. 明确不做（本期）

- 不做向量/语义检索。
- 不引入任何第三方记忆引擎或其运行时分发。
- 不做记忆自动抓取（只有人工确认派生 + 显式记录两个入口）。
- 不接 ACP。
- 不改 Office 渲染管线与素材规范。
