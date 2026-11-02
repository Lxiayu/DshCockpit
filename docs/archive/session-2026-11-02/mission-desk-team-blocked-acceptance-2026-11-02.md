# 团队任务 + BlockedBy 验收（2026-11-02）

> 探针：`scripts/acceptance/mission-desk-team-blocked-acceptance.js`（**15/15**）
> **fixture 用的是 2026-11-02 真实实测到的 DAG 形状，不是编的。**

## 0. 前提：先拿到了真实 DAG

详细记录见 `docs/quality/real-team-dag-verified-2026-11-02.md`。

方法：用启用 `agent-team-profile` 的隔离 profile（凭据从 `~/.dsh` 复制），
`session/prompt` 让 **Lead Agent 自己调 `team_task_create`**。

实测返回：

```json
{
  "tasks": [
    { "id": "task-1", "subject": "设计数据库 Schema", "status": "pending",
      "blockedBy": [], "writeScopes": ["src/db"], "ready": true },
    { "id": "task-2", "subject": "实现后端 API", "status": "pending",
      "blockedBy": ["task-1"], "writeScopes": ["src/api"], "ready": false }
  ]
}
```

**`blockedBy` 真实生效，`ready` 由官方自己算。**

## 1. 这个区块最容易犯的两个错

### 错误 1：把"缺 agentTeam"当成"空团队"

五种情况都会让 `agentTeam` 不存在：

- profile 没启用 Team 插件（**我们的默认情况**）
- session 不属于 Team
- 投影尚未加载
- 读取失败
- 投影存在但确实没成员/任务

如果一律显示"0 个任务 / 没有成员"，用户会以为团队坏了。

**我们的做法**：没有 key → **完全不显示团队区块**。

### 错误 2：用当前任务的 `ownerName` 显示阻塞者

**这是我原来的错，GPT 第三轮指出。**

`ownerName` 是**被阻塞的那个任务**的负责人，不是阻塞它的任务的。

正确做法：

1. 读当前任务 `blockedBy`（taskId 数组）
2. 在 `tasks` 里查表找对应任务
3. 取那个任务自己的 `subject` / `status` / `ownerName`

**实现里就是 `byId` Map 查表。**

## 2. 验收结果（15 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | 渲染真实任务 | 2 个 |
| 2 | 任务标题来自投影 | `设计数据库 Schema` / `实现后端 API` |
| 3 | 状态显示 | `pending` |
| 4 | 被阻塞任务有阻塞区 | ✅ |
| 5 | **显示的是真正的阻塞者** | `等待：设计数据库 Schema · 研究员 · 未开始` |
| 6 | **不是被阻塞任务自己的负责人** | 程序员没出现在"等待"里 |
| 7 | 未阻塞任务没有阻塞区 | ✅ |
| 8 | **缺 agentTeam → 完全不显示** | ✅ |
| 9 | 页面从不出现"0 个任务/没有成员" | ✅ |
| 10 | 只有 lead 无任务 → 也不显示 | ✅ |
| 11 | `writeScopeWarnings` 显示为**可能**冲突 | `可能存在文件修改范围冲突：…` |
| 12 | **从不声称文件已锁定** | ✅ |
| 13 | `failure` 有值时明说数据可能不实时 | `团队状态可能不是最新的（投影异常：…）` |
| 14 | 双主题截图 | ✅ |
| 15 | 无致命错误 | ✅ |

## 3. 关键区分

| 字段 | 含义 | 我们的文案 |
|---|---|---|
| `ready: false` | 依赖未满足 | 「等待：<真正阻塞者的 subject>」 |
| `writeScopeWarnings` | 写入路径可能重叠 | 「**可能**存在文件修改范围冲突」 |
| `failure` | 投影异常，数据停在最后有效状态 | 「团队状态可能不是最新的」 |

❌ **绝不写**「文件已锁定」——官方明确说 `writeScopes` 只是提示性前缀，不是锁。

## 4. 截图

```
✓ 团队运行正常
  没有需要你处理的事。有新情况时会出现在这里。

团队任务                                              2
  [未开始] 设计数据库 Schema
           研究员
  ─────────────────────────────────────
  [未开始] 实现后端 API
           程序员
           等待：设计数据库 Schema · 研究员 · 未开始
```

**注意**："等待"里是**研究员**（阻塞者的负责人），
不是**程序员**（被阻塞任务自己的负责人）。这就是修对的地方。

## 5. 生产启用策略（本轮仍不启用）

| 项 | 状态 |
|---|---|
| 数据形状 | ✅ 已实测 |
| UI 降级 | ✅ 缺 agentTeam 时完全不显示 |
| **生产 profile** | ❌ **仍不启用**（experimental） |

**原因**：UI 已经能在两种情况下正确工作，
启用与否是**用户/产品的选择**，不是技术阻塞。

## 6. 复现

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-team-blocked-acceptance.js
```
