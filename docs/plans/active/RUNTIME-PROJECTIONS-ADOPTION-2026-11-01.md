# 采纳 `session/projections`：一次调用拿到结构化待办

> 状态：**评估完成，建议采纳**（2026-11-01）
> 触发：0.2.1-rc.5 新增 `session/projections` 端点
> 结论：**这解决了我们「右栏缺结构化选项」缺口的根因**

## 1. 发现了什么

`POST /api/session/projections` 的**真实形状**（实测）：

```jsonc
{
  "kind": "sequenced",
  "asOfSeq": 2,
  "values": {
    "title": null,
    "goal": null,
    "tokenUsage": { "uncachedInputTokens": 0, "outputTokens": 0,
                    "cacheReadTokens": 0, "cacheWriteTokens": 0 },
    "contextPressure": {},
    "contextBreakdown": { "systemTokens": 0, "toolsTokens": 0, "messageTokens": 0 },
    "inbox": { "next-turn": [], "next-step": [] },
    "sessionStats": { "turns": 0, "steps": 0, "llmMs": 0, "toolMs": 0,
                      "ttftMs": 0, "ttftSteps": 0, "decodeMs": 0, "decodeTokens": 0 },
    "turnOutline": [],
    "agentPreset": "standard",
    "userQuestions": { "active": [], "settled": [] },   // ← 关键
    "permissions": { ... }
  }
}
```

### 参数形状（实测确认）

```js
POST /api/session/projections  { request: { sessionId } }
```

四种尝试里只有这一种对：
- ✅ `{ request: { sessionId } }`
- ❌ `{ request: { address: { kind:'session', sessionId } } }` → boundary validation 失败
- ❌ `{ sessionId }` → `missing "request"`; `unexpected "sessionId"`
- ❌ `{ request: {} }` → boundary validation 失败

## 2. 为什么这是决定性的：`userQuestions` 投影

从 `dsh-user-questions/lib/types/projection.d.ts`：

```ts
/** Session projection exposing open, continued, and settled timed questions to every Client. */
export const userQuestionProjectionDefinition = {
  key: "userQuestions",
  // ...
};

export interface UserQuestionProjectionView {
  readonly active: readonly PendingUserQuestion[];   // 可回答的
  readonly settled: readonly SettledUserQuestion[];  // 已回答的
}
```

而 `PendingUserQuestion` 里就是：

```ts
export interface PendingUserQuestion {
  readonly callId: ToolCallId;
  readonly questions: readonly AskUserQuestionItem[];
  readonly state: UserQuestionState;
}
```

`AskUserQuestionItem` 包含我们一直缺的：

```ts
id, question, detail?, header?,
options?: AskUserQuestionOption[],
multiSelect?: boolean,
intent?: { kind: 'plan-review'; approve: string }
```

## 3. 这改变了什么

### 之前（我们现在的做法）

```
office 快照 pending[]  →  只有 id/kind/risk/summary/toolName
                      →  detailRef 二次拉取才能拿到 questions
                      →  questions 里我们只保留了 id/question/options(label)
                      →  **右栏 UI 却做成了自由文本框**
```

### 之后

```
session/projections  →  userQuestions.active[].questions[]
                     →  完整 AskUserQuestionItem（含 options / multiSelect / intent）
                     →  右栏可渲染成**结构化选项卡片**
                     →  一次调用还顺带拿到 tokenUsage / turnOutline / permissions
```

**一句话：这不再是"我们从 office 快照里拼凑"，而是"向运行时直接要"。**

## 4. 与我之前差距分析的对应关系

| 我之前列的缺口 | projections 是否解决 |
|---|---|
| 缺口 1：右栏没用结构化选项 | ✅ **根因解决** |
| （未列）Plan Review 卡片 | ✅ `intent.kind === 'plan-review'` 直接可得 |
| （未列）Token/上下文用量 | ✅ `tokenUsage` / `contextBreakdown` 直接可得 |
| （未列）轮次大纲 | ✅ `turnOutline` 直接可得 |
| 缺口 2：Work Receipt | ❌ 不解决（那是业务模型） |
| 缺口 3：Workstream 依赖 | ❌ 不解决（那是业务模型） |

## 5. 风险与不确定

| 风险 | 说明 |
|---|---|
| **投影插件可能未启用** | `userQuestions` 是**投影插件**提供的。如果该插件未加载，`values` 里就没有这个 key。**必须做"缺 key 时降级"处理** |
| 端点参数可能再变 | 0.2.1 是 RC。参数形状（`request.sessionId`）需在契约测试里钉死 |
| 与现有 `session/page` 的关系 | 目前不确定 projections 是否完全覆盖 page 的信息。**不能贸然删掉 page 路径** |

### 必须遵守的落地原则

1. **保留 office 快照路径作为降级**——projections 缺 key 时回落到现状
2. **不在 UI 里假设 projections 一定有**——所有读取都走 `?.` 且显式处理 undefined
3. **先做只读展示，再做写入**——回答仍走现有 `office:pending` 通道（已验证可用）

## 6. 建议的实施顺序

| 步 | 内容 | 风险 |
|---|---|---|
| S1 | 加一个 `mission:invoke` 只读 action `sessionProjections`，透传 projections | 低 |
| S2 | 在投影里检测 `userQuestions` 是否存在，不存在时返回 `available:false` | 低 |
| S3 | 右栏待办卡片：优先用 projections 的 options 渲染结构化按钮；拿不到时回落到自由文本 | 中 |
| S4 | 真机验收：造一个真实提问，验证选项能点、答案能送回 | 中 |
| S5 | 用真实 plan-review 提问验证 plan-review 卡片 | 中 |

## 7. 不做什么

- ❌ 不删掉 `session/page` 路径（还不确定 projections 覆盖它的全部信息）
- ❌ 不把 tokenUsage 做成新面板（用户明确不要 Token 看板）
- ❌ 不在第一版就接 `multiSelect`（先用单选验证链路，再多选）


---

# 8. 追加发现（2026-11-02）：`agentTeam` 也能从 projections 拿到

## 8.1 修正一个错误结论

之前我 grep `dsh-api-session-controller/lib/types/` 找 `agentTeam` → 0 次，
据此认为"未进稳定 API"。

**漏了一步**：Session 投影类型分散在各插件包里，不在 session-controller。

```
@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.d.ts
  → declare module '@deepseek-ai/dsh-session-projection/types' {
      interface SessionProjectionStateMap { agentTeam: TeamProjectionState }
    }
```

## 8.2 实测对比

| profile | 投影字段数 | agentTeam |
|---|---|---|
| 默认 `web`（我们当前用） | 20 | ❌ |
| 加 `agent-team-profile` | **21** | ✅ |

启用后实测返回：

```json
{"agentTeam": {
  "members": [{"id":"session-…","name":"lead","role":"lead","phase":"active"}],
  "tasks": []
}}
```

## 8.3 `TeamTaskSnapshot` 直接命中了缺口 C

```ts
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId;
  readonly revision: number;
  readonly subject: string;
  readonly description: string;
  readonly status: 'pending'|'in_progress'|'completed'|'deleted';
  readonly ownerId?: SessionId;
  readonly blockedBy: TeamTaskId[];     // ← 依赖关系（我们缺的）
  readonly writeScopes: string[];       // ← 写入范围（防并行冲突）
}
export interface TeamTaskView extends TeamTaskSnapshot {
  readonly ownerName?: string;
  readonly ready: boolean;              // ← 依赖已满足？
  readonly writeScopeWarnings: string[];
}
```

**所以缺口 C 的方案变了**：不是"自己设计 dependsOn"，
而是"映射官方 TeamTask"。

## 8.4 但本轮**不在生产启用**

决策：**保持默认 profile（不含 agent-team）**，理由：

| 理由 | 说明 |
|---|---|
| experimental 无稳定性保证 | 官方明说 |
| 尚未验证回归 | 启用后现有功能是否受影响未测 |
| `tasks[]` 实测为空 | 真实 DAG 形状还没见过 |
| 不需要急 | 当前 20 个投影字段已够用 |

**启用条件**（满足才考虑）：
1. 用启用版 profile 跑通我们全部 5 个真机验收探针
2. 真的 spawn 一个 Lead + 2 teammate，观察到 `tasks[]` 的真实形状
3. 契约测试能覆盖"投影缺 key 时回落"

## 8.5 下一步（不在本轮）

| # | 任务 |
|---|---|
| 1 | 用启用版 profile 跑 5 个验收探针（回归验证） |
| 2 | spawn Lead + 2 teammate，观察 `agentTeam.tasks[]` |
| 3 | 设计 TeamTask ↔ Mission/Workstream 映射 |
| 4 | `ready:false` 在 380px 的表达（不画图，用"等待：X"） |
