# ADR-0002：停止扩张自研 Team Runtime，改为消费官方 Agent Teams

- **状态**：**已接受（用户 2026-11-01 决策，附退役硬约束）**
- **日期**：2026-11-01
- **决策者**：用户（待确认）
- **影响范围**：`src/team/runtime/**`、`src/team-shell-transport.js`、`src/team-runtime-host.js`、`src/work/**`、办公室 Team 投影
- **相关文档**：`docs/architecture/TEAM-RUNTIME-CONTRACT-v0.md`、`docs/architecture/WORKER-EXECUTION-CONTRACT-v0.md`、`docs/adr/ADR-0001-repositioning-ai-team-workspace.md`

## 1. 背景

DshCockpit 在 2026-10 自研了 Team Runtime v0（Job / Role / WorkerRun / Artifact，固定 researcher→reviewer 链）+ 执行端口层（ExecutionEvent / ExecutionPort / FakeExecutor / DshExecutionBackend / TeamExecutionController），共约 10 个模块、190KB，并有大量门禁测试保护边界。

同期，官方 DeepSeek Harness 在 0.2.x 中交付了 `dsh-experimental-agent-team` 系列包。

## 2. 问题

**在官方已提供 Agent Teams 的前提下，自研 Team Runtime 应该继续扩张、维持、还是收缩？**

## 3. 事实对比（必须精确，不得含糊）

### 3.1 官方 Agent Teams 提供什么

来源：`dsh-experimental-agent-team@0.2.1-rc.5` 官方中文 README（asar 内实测）

| 能力 | 官方实现细节 |
|---|---|
| Team 身份 | 每个普通运行时 root 是隐式 Team 的 Lead，`TeamId == SessionId`；无创建事件 |
| 成员管理 | `spawnTeammate()`，具名（小写、永不复用）、fresh/fork 两种启动、`provisioning` → `active`/`failed` 对账 |
| Roster 状态 | `running` / `inactive` / `provisioning` / `failed`，`lead` 或 `teammate` 角色 |
| 成员消息 | 直接 inbox 投递，`sendMessage()` 返回 `MessageId`；`steer` 在步骤边界送达并冷恢复；不重试、不去重 |
| 共享任务板 | 任务含 title/details/`dependsOn`/`writeScopes`；`claim` 需全部依赖完成；**每次变更为 CAS（`expectedRevision`）**；删除保留 tombstone |
| 写范围冲突 | `writeScopes` 为规范化 workspace 相对前缀；**重叠只警告，绝不阻止** |
| 等待 | `waitForChange()` 等待下次 roster/task/消息/状态变化，10s–1h，只报告是否超时 |
| 中断 | 仅 Lead 可 `interrupt()`，`keepInbox` 保留排队消息 |
| 持久化 | `team/member`、`team/task` 追加到 Lead 会话日志并 flush；`team/message/*` 仅历史可读 |
| 上限 | `maxMembers=16`、`maxTasks=256`、`maxMessageBytes=64KB`，超限报类型化错误 |
| 明确不支持 | 独立工作目录、跨进程协调、自动释放任务 owner |

### 3.2 自研 Team Runtime 提供什么

来源：`src/team/runtime/*.js` + `docs/architecture/TEAM-RUNTIME-CONTRACT-v0.md`

| 能力 | 自研实现 |
|---|---|
| Job | 显式 plan（`TEAM_V0_PLAN` 常量），researcher → reviewer 固定链 |
| Role | 冻结枚举 `researcher` / `reviewer` |
| WorkerRun | `runId = jobId:role:attempt`，attempt 机制 |
| Artifact | 唯一跨角色通道，opaque ref，digest |
| 事实 | `job/*` `run/*` `artifact/*`，fold 内核，单作者 |
| 执行 | 执行端口 + FakeExecutor + dsh 后端，controller 是唯一转换点 |
| Office 投影 | `team-office-adapter` 白名单映射 |

### 3.3 差异矩阵（这是决策的核心）

| 维度 | 官方 Agent Teams | 自研 Team Runtime | 官方是否覆盖 |
|---|---|---|---|
| 多成员动态人数 | ✅ ≤16，运行时可创建 | ❌ 固定 2 角色 | ✅ 覆盖且更强 |
| 成员间通信 | ✅ inbox + steer | ❌ 只有 artifact | ✅ 覆盖且更强 |
| 任务依赖 | ✅ 任意 DAG + CAS | ❌ 固定线性链 | ✅ 覆盖且更强 |
| 任务持久化 | ✅ 会话日志 flush | ⚠️ 内存 + 部分落盘 | ✅ 覆盖 |
| 写范围声明 | ✅ writeScopes + 重叠警告 | ❌ 无 | ✅ 覆盖 |
| 等待/中断 | ✅ waitForChange / interrupt | ⚠️ 部分 | ✅ 覆盖 |
| Artifact 一等公民 | ❌ 无显式 artifact 概念 | ✅ artifact/* 是核心 | ❌ **官方不覆盖** |
| 执行端口抽象（可换后端） | ❌ 耦合 Cordis 运行时 | ✅ 端口契约 | ❌ **官方不覆盖** |
| 纯 Node 可测（无 Electron/Cordis） | ❌ 依赖 Cordis 上下文 | ✅ 零依赖 + FakeExecutor | ❌ **官方不覆盖** |
| 隐私脱敏投影到 Office | ❌ 无 | ✅ 专用 adapter | ❌ **官方不覆盖** |

**结论**：官方覆盖了「编排与协作」，**没有覆盖**「产物一等公民 / 可替换执行后端 / 纯 Node 可测 / 隐私投影到 Office」。

但这四项中，**只有最后一项（投影到 Office）真正是 DshCockpit 的产品价值**。前三项是实现手段，不是用户价值。

## 4. 备选方案

| 方案 | 描述 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **A. 继续扩张自研 Team Runtime** | 补齐 DAG、成员通信、任务板 | 完全可控 | 追赶官方；与官方语义冲突；维护成本高；用户无感 | ❌ 否决 |
| **B. 完全删除自研，只用官方** | 直接消费官方 Agent Teams | 维护成本最低 | 丢失 artifact 一等公民、丢失 Office 隐私投影层、丢失离线可测能力 | ❌ 否决（过于激进） |
| **C. 冻结自研，转为「官方 Team 的适配层」** | 保留 artifact/投影/端口契约的**设计**，但编排交给官方；自研层从"编排者"退为"观察者+投影者" | 保留 Office 价值；不与官方冲突；大幅减少维护面 | 需要改造（非重写）；`team-execution-controller` 的编排职责需移除 | ✅ **建议采用** |
| **D. 双轨并行** | 官方负责 A、自研负责 B，按场景选 | 灵活 | 两套事实作者；语义漂移；用户困惑 | ❌ 否决（违反单一事实源铁律） |

## 5. 决策（已接受 2026-11-01）

**采用方案 C：冻结自研 Team Runtime 的编排能力，转为官方 Agent Teams 的适配与投影层。**

### 5.0 退役硬约束（用户 2026-11-01 明确要求）

> **旧 Team Runtime 不允许直接删除。**

这是本决策的**前置门槛**。自研 Team Runtime 只能按以下顺序逐步退役，任一环节未完成不得进入下一环节：

| 阶段 | 要求 | 验收证据 | 状态 |
|---|---|---|---|
| **R0 能力映射** | 逐项列出自研 Team Runtime 的每个能力，标注官方是否有等价实现 | 映射表（能力 / 官方对应 / 差异 / 处置）| ⬜ 未开始 |
| **R1 数据迁移** | 已有 Team 执行数据（job/run/artifact facts）如何迁移或归档 | 迁移脚本 + 迁移前后一致性验证 | ⬜ 未开始 |
| **R2 功能等价性验证** | 官方 Team 路径能产出与自研路径**等价**的结果（同输入 → 同可观察输出） | 等价性测试（对照运行） | ⬜ 未开始 |
| **R3 回归测试** | 现有 `test/team-*.test.js` / `test/worker-execution*.test.js` 全部重定位并绿 | 测试迁移清单 + `CI=1 npm test` 全绿 | ⬜ 未开始 |
| **R4 标记 legacy** | 旧路径默认禁用，代码保留，文档标注 | feature flag + 文档 | ⬜ 未开始 |
| **R5 逐步退役** | R0–R4 全部完成后，才可删除代码 | 删除 commit + 无引用残留 | ⬜ 未开始 |

**禁止事项**：
- ❌ 不得在 R0–R3 完成前删除 `src/team/runtime/**` 任何文件
- ❌ 不得在等价性未验证前把官方路径设为唯一路径
- ❌ 不得以"反正是实验性代码"为由跳过迁移验证

**当前状态**：R0 未开始。本决策的**实施**依赖 Issue #9（runtime POC）先行，因为 0.1.5 没有 Agent Teams 包，无法做能力映射的实证。

具体：

1. **`src/team/runtime/team-runtime.js`（编排内核）→ 停止扩张，标记 legacy**
   - 不再新增 Job/Role 能力。
   - 保留 fold 内核作为"离线测试与历史事实"用途。
2. **`src/team/runtime/dsh-execution-backend.js` + `execution-port.js` → 保留**
   - 它们是"可替换执行后端"的抽象，仍有价值（POC、离线测试、未来第二后端）。
   - 但**不再是生产主路径**。
3. **`src/team/runtime/team-office-adapter.js` + `team-office-bridge.js` → 保留并成为核心**
   - 这是"官方 Team 事实 → Office 隐私投影"的唯一转换层。
   - 需扩展为消费官方 `agentTeam` 客户端视图（roster + task board），而非仅自研 facts。
4. **`src/work/work-controller.js` + `workspace-store.js` → 保留并升级为 Mission Core 底座**
   - 它已经有"无产物不算完成"的机械门，符合新方向。
5. **新增 `src/team/official-teams-adapter.js`（待建）**
   - 从官方 `ctx.agentTeams` / `agentTeam` 客户端视图读取 roster 与 task 状态。
   - 输出统一的 Team 事实投影给 Office。
   - **不写**官方状态。

## 6. 决策理由

1. **避免两套编排**：官方与自研同时编排必然产生两个事实作者（违反 `product-principles.md` §3.1）。
2. **保留真正有价值的部分**：Office 隐私投影层是产品差异化，官方不会有；artifact 一等公民在 Mission Core 中仍需要（Deliverable）。
3. **不浪费已有投入**：适配层、端口契约、fold 内核、测试都可复用；不是删除，是**改变角色**。
4. **降低维护面**：不再追赶官方的编排功能演进。

## 7. 代价

| 代价 | 说明 |
|---|---|
| 改造工作量 | `team-execution-controller` 的编排职责需移除；Office 投影需接官方视图 |
| 测试调整 | 大量 `test/team-*.test.js`、`test/worker-execution*.test.js` 需重新定位（哪些测适配层、哪些测 legacy） |
| 依赖官方稳定性 | 官方包标记 `experimental`，API 可能变 |
| 失去"完全可控" | 编排行为受官方约束 |

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **官方 experimental 包 API 破坏性变更** | 高 | 中 | 只通过**客户端视图 + 事件**消费，不 import 内部模块；版本兼容层（见 `runtime-bridge.md`） |
| **官方 Agent Teams 尚未在 0.1.5 存在** | 确定 | 高 | 必须先完成 runtime 升级到 0.2.x 的 POC（见 ADR-0004 / 路线图 P0） |
| **改造期间两套并存** | 高 | 中 | 明确"官方路径为唯一写入者"；自研编排标记 legacy 且默认不启用 |
| **Office 投影依赖官方视图字段** | 中 | 中 | 投影层做字段白名单 + 缺字段优雅降级（不伪造） |

## 9. 前置条件（必须先满足才能实施）

1. **官方 0.2.x runtime 升级 POC 通过**（当前锁 0.1.5，官方已 0.2.1-rc.5）。
2. **确认官方 Agent Teams 在 desktop profile 中可用**（`~/.dsh/profiles/desktop/package.json` 已挂 `dsh-experimental-agent-team-profile`，需实测）。
3. **确认 agentTeam 客户端视图的字段形状**（需在 0.2.x 上实测，本机 0.1.5 无此包 → **当前无法验证**）。

## 10. 后续重新评估的触发条件

1. 官方 Agent Teams 提供 artifact 一等公民概念（则自研 artifact 层也可退场）。
2. 官方 Agent Teams 支持跨 Session 的 Team 持久化（则与 Mission Core 边界需重划）。
3. runtime 升级 POC 失败（则本决策需重新考虑，可能回到方案 A 的缩小版）。

## 11. 未验证声明（诚实标注）

> ⚠️ 本 ADR 对官方 Agent Teams 的能力描述**全部来自官方 0.2.1-rc.5 的 README 文档**，**未经过运行验证**。本机安装的是 0.1.5-rc.2，不含该包。
> 在实施前必须在 0.2.x 上完成实测，并将结果回填至本 ADR §9。
