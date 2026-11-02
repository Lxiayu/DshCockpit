# TeamTask ↔ Workstream 映射设计

> 日期：2026-11-02
> 上游：GPT 第三轮 §二（三层模型）、`docs/quality/team-projection-breakthrough-2026-11-02.md`
> 状态：**设计完成 + 回归已验证**，实现待排期

## 0. 结论先行

| 问题 | 答案 |
|---|---|
| 要不要把 Workstream 改名成 TeamTask？ | **不要**（两者层级不同） |
| 官方 TeamTask 能直接用吗？ | 能，但**默认 profile 里没有**，要启用 experimental 包 |
| 启用后现有功能会坏吗？ | **不会**（回归 10/10 通过） |
| TeamTask 的 ID 能当全局 ID 吗？ | **不能**（Team 内唯一，跨 Team 会撞） |
| 本轮实现吗？ | **不实现**，只落设计与契约 |

## 1. 三层模型（采纳 GPT 的建议，我核对后确认合理）

| 层 | 归属 | 例子 | 生命周期 | 谁写 |
|---|---|---|---|---|
| **Mission** | DshCockpit | 开发个人知识管理应用 | 长期 | 我们 |
| **Workstream** | DshCockpit | 研究 / 开发 / 验证 | 持续的业务分类 | 我们 |
| **TeamTask** | Harness | 「设计数据库 Schema」 | 可领取/执行/完成 | **官方** |

**为什么不能合并**：Workstream 是"阶段/方向"，TeamTask 是"可执行单元"。
把 Workstream 直接变成 TeamTask 会失去"业务分类"这一层，
而把 TeamTask 提升成 Workstream 会让侧栏被大量小任务淹没。

## 2. 关联模型（只存关系，不复制事实）

```ts
/** 官方 TeamTask 的复合标识。taskId 只在 Team 内唯一。 */
interface TeamTaskRef {
  teamRootSessionId: string;   // 哪个 Team（Lead 的 sessionId）
  taskId: string;              // 官方 task id（如 task-1）
  revision: number;            // 官方每次变更递增；用于判断是否同一版本
}

/** Workstream 到 TeamTask 的关联。**这是我们唯一新增的数据。** */
interface WorkstreamTaskLink {
  missionId: string;
  workstreamId: string;
  teamRootSessionId: string;
  taskId: string;
  linkedAt: number;
}
```

### 硬约束（铁律 1：单一事实源）

**不复制**官方的这些字段：「标题 / 状态 / 负责人 / 依赖 / writeScopes」
因为它们的事实作者是 Harness。

**只存**关联关系。展示时按 `TeamTaskRef` 去投影里读。

```ts
// 正确：读投影
const task = agentTeam.tasks.find(t => t.id === link.taskId);

// 错误：把官方字段抄进我们的事件日志
// { taskId, title, status, ownerName } ← 复制即埋雷
```

## 3. 启用条件与回归结果（已实测）

### 3.1 怎么启用

在 profile 的 `dsh.profile.bundles` 里加：

```json
"@deepseek-ai/dsh-experimental-agent-team-profile"
```

我们当前的 profile 是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`。

### 3.2 回归验证结果（10/10 全部通过）

在隔离的 DSH_HOME 里建启用版 profile，跑我们依赖的全部协议：

| 检查 | 结果 |
|---|---|
| runtime 启动 | ✅ |
| cookie（303 流程） | ✅ |
| `session/list` | ✅ |
| `session/create` | ✅ |
| `session/page` | ✅ |
| `session/projections` | ✅ **21 字段**（默认是 20） |
| **`agentTeam` 存在** | ✅ |
| `session/prompt` | ✅ |
| `/api/remote.mux` 流 | ✅ |
| workspace AGENTS.md | ✅ |

**结论：启用后零回归。**

### 3.3 但仍然**不在本轮生产启用**

| 理由 | 说明 |
|---|---|
| experimental 无稳定性保证 | 官方明说 |
| **`tasks[]` 实测始终为空** | 没 spawn 过 teammate，真实 DAG 形状**没验证过** |
| 用户可能不需要 Team | 单 agent 场景下多一个空 Team 概念反而困惑 |

**启用条件（全部满足才考虑）**：
1. 真的 spawn 出 Lead + 2 teammate，观察到 `tasks[]` 的真实内容
2. 契约测试覆盖"投影缺 agentTeam 时回落"
3. 用户明确需要团队功能

## 4. 官方类型的权威形状（照抄，不猜）

```ts
type TeamMemberPhase = 'provisioning' | 'active' | 'failed';

interface TeamMemberView {          // 运行时增强版（投影里给的是这个）
  id: SessionId;
  name: string;
  role: 'lead' | 'teammate';
  status: 'running' | 'inactive' | 'provisioning' | 'failed';
  description?: string;
  provider?: string;
  context?: 'fresh' | 'fork';
  model?: string;
  diagnostics: string[];
}

type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

interface TeamTaskView {            // 运行时增强版
  id: TeamTaskId;
  revision: number;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  blockedBy: TeamTaskId[];
  writeScopes: string[];
  ownerName?: string;
  ready: boolean;                   // ← 依赖是否已满足
  writeScopeWarnings: string[];     // ← 写入范围可能重叠
}

interface TeamProjection {
  members: TeamMemberView[];        // 注意：投影给的是 View 还是 Projection？
  tasks: TeamTaskView[];
  failure?: string;                 // ← 投影异常时必须显示，不能标为实时
}
```

> ⚠️ **一处待实测确认**：`TeamProjection.members` 的类型，
> 官方 `types.d.ts` 里写的是 `TeamMemberProjection[]`（只有 id/name/role/phase），
> 但实测返回的成员对象也是这个形状。
> **`TeamMemberView`（含 status/model/diagnostics）可能在另一条路径上**，
> 需要真实 spawn 后才确认投影里给的是哪个。

## 5. 展示策略（380px，不画 DAG）

### 5.1 `ready: false` 时

**我原来的错误**（GPT 指出）：显示「等待：`ownerName`」——
`ownerName` 是**当前任务**的负责人，不是阻塞任务的。

**正确做法**：
1. 读当前任务 `blockedBy`（taskId 列表）
2. 在 `agentTeam.tasks` 里找对应任务
3. 取每个阻塞任务的 `subject` / `status` / `ownerName`

**展示**：

单阻塞：
```
实现后端 API              (被阻塞)
等待：数据库 Schema 设计   研究员 · 进行中
```

多阻塞：
```
实现后端 API              (被阻塞)
等待 2 项前置任务                    [展开]
  ├ 数据库 Schema 设计   研究员 · 进行中
  └ 接口协议确定         Lead · 未开始
```

### 5.2 `writeScopeWarnings` 时

**必须区分两个概念**（GPT 指出）：

| 字段 | 含义 | 文案 |
|---|---|---|
| `ready: false` | 依赖未满足 | 「等待 N 项前置任务」 |
| `writeScopeWarnings` | 写入路径可能重叠 | 「**可能**存在文件修改范围冲突」 |

❌ **不能写**「文件已锁定」——官方明确说 `writeScopes` 只是提示性路径前缀，**不是锁**。

### 5.3 `agentTeam.failure` 有值时

官方注释：
> 「`failure` names the first rejected persisted Team record;
> **members and tasks then stay at the last valid state**。」

**所以必须**：显示"投影异常，数据可能停留在最后一次有效状态"，
**不能继续把陈旧任务列表标为实时**。

## 6. 跨 Team 依赖（第一版不做）

官方 `blockedBy` **只在单个 Team 内有效**，不能跨 Team 引用。

如果将来需要跨 Workstream 依赖，应该由 **Mission Core 自己建更高层依赖**，
而不是去改官方 TeamTask。

**第一版明确不做跨 Team DAG。**

## 7. 不实现的部分与本轮交付

### 本轮交付（本轮 = 设计 + 回归）

- ✅ 本文档（映射模型、类型权威形状、展示策略）
- ✅ 回归验证结果（10/10）
- ✅ 启用条件与风险清单

### 不实现

- ❌ TeamTask 写入（官方拥有，我们只读）
- ❌ blockedBy UI（等真实 DAG 数据）
- ❌ 跨 Team 依赖
- ❌ 在生产 profile 启用 team 包

## 8. 下一步的真实阻塞

**唯一阻塞**：`tasks[]` 始终为空，没观察到真实 DAG。

**怎么解**：需要真实跑一次 Agent Team（spawn Lead + 2 teammate，
让 Lead 创建带 `blockedBy` 的任务）。这需要：
1. 启用 team profile 的 runtime
2. 一个能驱动 Lead 调 `team_task_create` 的 prompt
3. 有可用的模型凭据

**这是下一轮该做的验证，而不是继续写设计。**
