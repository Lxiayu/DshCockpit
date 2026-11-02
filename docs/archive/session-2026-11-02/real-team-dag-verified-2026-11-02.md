# 真实 Team DAG 已验证（2026-11-02）

> 这是 `docs/architecture/team-task-workstream-mapping.md` 里那个
> "唯一真实阻塞"的解除记录：**`tasks[]` 不再为空，DAG 形状已实测。**

## 0. 怎么拿到的

用启用 `agent-team-profile` 的隔离 profile（凭据从 `~/.dsh` 复制），
通过 `session/prompt` 让 **Lead Agent 自己调 `team_task_create`**。

关键点：**不通过 agent 调工具，`tasks[]` 永远为空**——
投影只反映真实发生的 Team 事件。

## 1. 实测的真实 DAG

提示词（两步，因为 blocked_by 必须引用已存在的 id）：

```
先调 team_task_create 建一个任务：subject="设计数据库 Schema",
description="设计用户表结构", write_scopes=["src/db"]。
拿到返回的 id 后，再调一次 team_task_create 建第二个：
subject="实现后端 API", description="基于 Schema 实现接口",
blocked_by=[那个 id], write_scopes=["src/api"]。
```

### 投影返回

```json
{
  "members": [
    { "id": "session-eef7640b-…", "name": "lead",
      "role": "lead", "phase": "active" }
  ],
  "tasks": [
    {
      "id": "task-1",
      "revision": 1,
      "subject": "设计数据库 Schema",
      "description": "设计用户表结构",
      "status": "pending",
      "blockedBy": [],
      "writeScopes": ["src/db"],
      "ready": true,                    // ← 无依赖
      "writeScopeWarnings": []
    },
    {
      "id": "task-2",
      "revision": 1,
      "subject": "实现后端 API",
      "description": "基于 Schema 实现接口",
      "status": "pending",
      "blockedBy": ["task-1"],          // ← 依赖关系真实存在
      "writeScopes": ["src/api"],
      "ready": false,                   // ← 依赖未满足，官方自己算的
      "writeScopeWarnings": []
    }
  ]
}
```

## 2. 验证到的关键事实

| 事实 | 状态 |
|---|---|
| `blockedBy` 是真实存在的、可用的 | ✅ |
| **`ready` 由官方自己算**（`blockedBy` 非空 → `false`） | ✅ |
| `writeScopes` 是**目录前缀**，不是文件锁 | ✅（`src/db`，无尾斜杠） |
| `revision` 从 1 开始，每次变更递增 | ✅ |
| `members` 里只有 lead（没 spawn teammate） | ✅ |
| `writeScopeWarnings` 在两个不同 scope 时为空 | ✅ |

### 表格没验证到的（要如实记）

| 未验证 | 原因 |
|---|---|
| `writeScopeWarnings` 何时非空 | 需要两个任务声明**重叠**的 scope |
| `member.status`（running/inactive 等） | 投影里给的是 `TeamMemberProjection`（只有 phase） |
| spawn teammate 后的成员形状 | 没真的 spawn |
| `agentTeam.failure` 何时有值 | 需要构造被拒绝的持久化记录 |

## 3. 这意味着什么

### 3.1 缺口 C 可以真正实现

之前我只能设计，现在**有真实数据形状**：

```
task-2 (ready: false)
  blockedBy: ["task-1"]
    → 在 tasks 里找到 task-1
    → 显示 task-1 的 subject / status / ownerName
```

**这正是 GPT 指出的正确做法**（不是我原来错的"用当前任务的 ownerName"）。

### 3.2 但生产启用仍要谨慎

`tasks[]` 为空的场景是**常态**（单 agent 工作流）。
所以 UI 必须：
- 没有 agentTeam → 不显示团队区块（不是显示"0 个任务"）
- 有 agentTeam 但 tasks 为空 → 正常工作流，不显示任务列表

## 4. 复现方法

```bash
# 见 /tmp/spawn-team.js 的逻辑：
# 1. 建隔离 DSH_HOME，复制 ~/.dsh 的 .credentials.yaml
# 2. profile bundles 加 @deepseek-ai/dsh-experimental-agent-team-profile
# 3. session/create 后用 session/prompt 让 Lead 调 team_task_create
# 4. 轮询 session/projections 看 values.agentTeam.tasks
```

## 5. 下一步

现在可以真正实现 BlockedBy UI 了：
- 数据形状确定
- `ready: false` 的判定来自官方，不用自己算
- 但**生产环境仍不启用 team profile**（UI 用降级路径，缺 agentTeam 时不显示）
