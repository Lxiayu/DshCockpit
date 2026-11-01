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
