# Agent 回复回写到 Mission Desk（2026-11-02）

> 探针：`scripts/acceptance/mission-desk-start-work-acceptance.js`（**24/24**）

## 0. 缺的是什么

上一轮做完「交给团队」后，用户能启动工作了。但还缺一环：

**Agent 干完了，Mission Desk 里看不到它说了什么。**

用户还是得自己切到 Harness 视图翻聊天记录。

## 1. 找到准确的"完成"信号

第一性原理：怎么知道 Agent 真的给出了回复？

### 不能用的信号

| 信号 | 为什么不行 |
|---|---|
| `session/prompt` 返回 ok | 只代表**消息被接收**，不代表处理了 |
| `sessionStats.turns > 0` | 只代表**有轮次结束过**，不代表那一轮有文本产出 |
| `inbox` 为空 | 只代表队列空了，可能是被取消 |

### 官方给的准确信号：`turnOutline[].response`

官方注释（`dsh-session-turn-outline`）：

> "The response **commits at `turn/end`** from a draft of the newest
> text-bearing assistant message"

也就是说：**`response` 非空 ⟺ 那一轮真的结束并且有 assistant 文本。**

这比 `turns > 0` 精确：`turns` 只数边界，`response` 证明有内容。

### 结构

```ts
interface TurnOutlineEntry {
  turn: number;      // 第几轮
  seq: SessionSeq;
  prompt: string;    // 首个人类提示的预览（一轮一行）
  response: string;  // 最终回复的预览（最多三行），turn/end 前是 ''
}
```

## 2. 实现

### 后端 `workStatus` 解析 turnOutline

```js
const outline = values.turnOutline || [];
const last = outline[outline.length - 1];
hasResponse: last.response.length > 0,
lastTurn: last.turn,
lastPromptPreview: last.prompt,
lastResponsePreview: last.response,
```

实测输出：

```json
{ "turns": 2, "steps": 9, "hasRun": true, "hasResponse": true,
  "lastTurn": 2,
  "lastPromptPreview": "第二个任务",
  "lastResponsePreview": "已完成调研，报告在 docs/r.md" }
```

### UI 显示

```
已执行 2 轮 · 9 步
┌──────────────────────────────────────┐
│ 团队最近一次回复（第 2 轮）            │
│ 已完成调研，报告在 docs/r.md          │
│ 回应的是：第二个任务                    │
│ 这是预览（有长度上限），完整内容请      │
│ 在 Harness 里查看。                    │
└──────────────────────────────────────┘
[在 Harness 中查看这个 Mission 的执行 →]
```

## 3. 为什么必须标明"这是预览"

**官方注释说得很清楚**：这个字段是「bounded final-response preview」，
为窄栏卡片设计（"up to three rail-card lines"），**有长度上限**。

如果我们直接当完整回复显示：
- 用户会以为 Agent 只说了这几行
- 长报告会被截断而用户不知道
- 这就是**撒谎**

所以加了一句斜体小字：
> 这是预览（有长度上限），完整内容请在 Harness 里查看。

## 4. 验收（24/24）

原 20 项 + 新增 4 项：

| # | 检查 | 结果 |
|---|---|---|
| 21 | **显示 Agent 的真实回复** | `已完成调研，报告在 docs/r.md` |
| 22 | 标明是第几轮 | `团队最近一次回复（第 2 轮）` |
| 23 | 显示回应的是哪个提示 | `回应的是：先调研 Agent Team` |
| 24 | **诚实标明是预览** | `这是预览（有长度上限）…` |

## 5. 现在用户能看到的完整闭环

```
1. 创建 Mission
2. 写一句话 → 点「交给团队」
3. 看到「已交给团队，还没有完成的轮次。」
4. 等一会儿重新选中 Mission
5. 看到「已执行 2 轮 · 9 步」+ Agent 的原话预览
6. 点「在 Harness 中查看这个 Mission 的执行 →」看完整内容
```

**这是从"能启动"到"能看到结果"的闭环。**

## 6. 还没做到的（如实说）

| 项 | 说明 |
|---|---|
| **不是实时推送** | 打开/切换 Mission 时才查一次。用户在等的时候不会自动刷新 |
| 只显示**最后一轮** | 多轮的历史要切 Harness 看 |
| 不会**自动**变成 Finding/Deliverable | Agent 说了什么，Mission 里不会自动记录成结构化实体 |
| 预览有长度上限 | 长回复被截断（已明确标注） |

### 下一件该做的

**"Agent 说完成的项目自动进入待验收"**——这才是真正的回写：
把 Agent 的产出变成 Mission 里的 Deliverable 条目，让用户能验收。

但那需要 Work Receipt 状态机（缺口 B），而它还没做。
