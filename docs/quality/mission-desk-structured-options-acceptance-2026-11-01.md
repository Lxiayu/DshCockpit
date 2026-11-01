# 结构化选项真机验收（2026-11-01）

> 探针：`scripts/acceptance/mission-desk-structured-options-acceptance.js`（**10/10**）

## 0. 背景：这是升级 0.2.1 的直接收益

升级前我列的「缺口 1」是：**右栏没用官方的结构化交互能力**。
官方 `AskUserQuestionItem` 支持 `options` / `multiSelect` / `intent(plan-review)`，
而我们做成了自由文本输入框——等于把已有能力退化了。

升级到 0.2.1-rc.5 后发现新端点 `session/projections`，
它一次性返回 `userQuestions.active[].questions[]`，
**里面就带完整的 `options`**。

所以这个缺口现在能真正解决了。

## 1. 发现：projections 返回 20 个投影字段

实测 `POST /api/session/projections` 的参数形状必须是
`{ request: { sessionId } }`（其它三种写法都被拒绝）。

返回的 `values` 包含：

```
title, goal, tokenUsage, contextPressure, contextBreakdown, inbox,
sessionStats, turnOutline, agentPreset, userQuestions, permissions,
workingDirectory, subagentCatalog, subagentTiming, subagent,
todos, plan, modelSelection, sessionListMetadata, imageLimits
```

其中 `userQuestions` 的结构（来自官方 `projection.d.ts`）：

```ts
interface UserQuestionProjectionView {
  readonly active: readonly PendingUserQuestion[];   // 可回答的
  readonly settled: readonly SettledUserQuestion[];  // 已回答的
}
interface PendingUserQuestion {
  readonly callId: ToolCallId;
  readonly questions: readonly AskUserQuestionItem[];
  readonly state: UserQuestionState;
}
```

## 2. 改了什么

### 2.1 新增只读 action `sessionProjections`

`src/ipc-mission.js` 里加了 action，通过注入的 `projectionsOf` 访问运行时
（ipc-mission 保持纯 Node 可测）。

**隐私边界的处理**：Mission 按规则**不存 raw sessionId**（只存派生句柄
`sess-h-*`），所以右栏拿不到 sessionId。解法是：

```js
// 不传 sessionId 时，由 main 侧取"当前被 follow 的会话"
// —— office 模块本来就持有这个运行时事实（它是 follow 流的 key）
```

**这是唯一不破坏隐私边界的位置。**

### 2.2 右栏：结构化选项优先，自由文本兜底

```
有 projections.userQuestions.options  →  渲染成按钮（互斥样式）
                                      +  保留"或自定义回答"输入
没有（投影插件未启用/未接线）        →  回落到自由文本 + "回答"按钮
```

### 2.3 匹配策略（不猜）

投影里的 `active[].callId` 对应 office 快照 pending item 的 `id`：

1. 先按 id 精确匹配
2. 匹配不到但只有**唯一**一个 active 问题时用它（常见情形）
3. 都不满足 → 返回 null → 回落自由文本，**绝不瞎猜**

## 3. 验收结果（10 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | 选项渲染成**按钮**（不是文本框） | 3 个按钮 |
| 2 | 选项文案来自运行时投影 | `实证研究：优先收集实验数据` 等 |
| 3 | 选项可见 | ✅ |
| 4 | 仍保留自定义输入（官方允许自由输入） | ✅ |
| 5 | **点击选项把 label 作为答案送出** | `{action:'answer', id:'call-1', value:'文献综述：优先梳理已有研究'}` |
| 6 | 仍用真实的 `office:pending` payload 形状 | ✅ |
| 7 | **投影不可用时回落到自由文本** | `hasOptions:false, hasInput:true` |
| 8 | 回落时保留主按钮 | ✅ |
| 9 | 双主题截图 | ✅ |
| 10 | 无致命错误 | ✅ |

## 4. 截图确认

深色主题下的问题卡片：

```
⚠ 需要你处理                                        (1)
  [提问] 选择研究方法
  风险 中 · 1分钟前
  ┌────────────────────────────────────────┐
  │ 实证研究：优先收集实验数据              │
  ├────────────────────────────────────────┤
  │ 文献综述：优先梳理已有研究              │
  ├────────────────────────────────────────┤
  │ 混合研究：两种方法结合                  │
  └────────────────────────────────────────┘
  [或自定义回答…              ] [发送]
```

**这已经是提示词里描述的"结构化决策卡片"形态。**

## 5. plan-review 的处置（有意留白）

官方 `intent: { kind: 'plan-review', approve: string }` 的语义是：

> 「The option label that approves the plan; every other option declines it.
> **Named rather than positional** so no UI infers the verdict from option order.」

所以我们**不按选项顺序推断"哪个是批准"**，只把 label 原样送出，
判定交给运行时。这符合官方设计。

**独立渲染 plan-review 卡片（含 `detail` 长文本）留到下一轮**——
那需要在 380px 里解决长文本展示问题。

## 6. 复现

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-structured-options-acceptance.js
```
