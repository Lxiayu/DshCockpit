# 与 GPT 的第二轮交流：我们自动核对了它的三个判断

> 日期：2026-11-02
> 上下文：把 `status-brief-for-gpt-2026-11-02.md` 的四个问题整理后，
> 我先自己动手验证了一遍——**结果推翻了其中两个判断**。
> 这份文档是给 GPT 的回复，也是我们的决策依据。

---

## 回复 1：关于 `agentTeam` —— 你说"未进稳定 API"，字面对，结论过悲观

**你的原文**：
> 「Team 的 `agentTeam` 浏览器投影**未加入稳定 API Proxy**。」

**我最初验证也是这个结论**：grep `dsh-api-session-controller/lib/types/` → 0 次。

### 但我漏了一步

Session 投影的类型定义**不在 session-controller 包里**，分散在各插件包：

```
@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.d.ts
```

里面明明写着：

```ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentTeam: TeamProjectionState;
  }
}
```

而 `session/projections` 是**稳定端点**。

### 实测：启用 profile 后就有了

| profile | 投影字段数 | agentTeam |
|---|---|---|
| 默认 `web` | 20 | ❌ |
| 加 `agent-team-profile` | **21** | ✅ |

实际返回：

```json
{
  "agentTeam": {
    "members": [
      { "id": "session-76581fd8-...", "name": "lead",
        "role": "lead", "phase": "active" }
    ],
    "tasks": []
  }
}
```

### 所以结论是

**不需要 Host 插件。** 你建议的 `@dshcockpit/runtime-bridge` 那条路
现在看不是必需的——现有 HTTP unary 端点就够。

---

## 回复 2：关于 Workstream 依赖 —— 官方已经有现成的，不用自己设计

**我的问题**：Workstream 缺 `dependsOn`，380px 里画不出 DAG。

**你的建议**：学 Retinue 的任务模型。

**我查到的事实**：`TeamTaskSnapshot` 已经包含：

```ts
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId;
  readonly revision: number;
  readonly subject: string;
  readonly description: string;
  readonly status: TeamTaskStatus;        // pending|in_progress|completed|deleted
  readonly ownerId?: SessionId;
  readonly blockedBy: TeamTaskId[];       // ← 依赖关系，现成的
  readonly writeScopes: string[];         // ← 写入范围（防并行冲突）
}
```

而且还有 `TeamTaskView`（运行时增强版）带：

```ts
readonly ownerName?: string;
readonly ready: boolean;                  // ← 是否可开始（依赖已满足）
readonly writeScopeWarnings: string[];    // ← 写入范围冲突警告
```

**这比我们自己设计 DAG 好得多**：
- `blockedBy` 天然就是 DAG 的边
- `ready` 直接告诉我们"能不能开始"
- `writeScopes` 解决并行写冲突

### 所以缺口 C 的方案变了

**不是"我们设计 dependsOn"，而是"我们映射官方的 TeamTask"。**

新的问题变成：
1. Team 的 task 和我们的 Mission/Workstream 是**两个模型**，怎么映射？
   - 一对一？还是 Mission 下有多个 Team？
   - 我们的 Workstream 要不要直接改成 TeamTask 的视图？
2. `ready` 和 `blockedBy` 在 380px 里怎么展示？
   - 我倾向：**不画图，只显示"等待：<ownerName> 的任务"**
   - 加上 `ready: false` 时给个明确的"被阻塞"标记

---

## 回复 3：关于 Work Receipt 的判定权 —— 我还是没答案，想听你的

你说学 Retinue 的"执行凭证"。我理解凭证要包含：

| 项 | 我能拿到的真实来源 |
|---|---|
| 产物 | 文件（有 sha256） |
| 验证方式 | ？ |
| 验证结果 | ？ ← **这里卡住** |
| 执行成员 | `agentTeam.tasks[].ownerId` |
| 时间 | 事件时间戳 |

**卡点**：谁能判定"验证通过"？

我列过三种，都有问题：

1. **Agent 自己说** → 违反我们的"不伪造"铁律
2. **人逐个看** → 成本高，用户不会用
3. **可复现的检查脚本** → 需要脚本本身可信

**第 3 条看起来最有希望**，但需要你们确认一个设计：

> 如果我们让 Mission 记录一条 `verification: { command, expectedExitCode }`，
> 然后在用户点"验证"时**真的跑这个命令**、把真实退出码存下来——
> 这算不算"可验证"？

我的顾虑：命令本身可能是错的（`echo ok`）。**但至少它是可复现的、
用户能看见的，而不是"Agent 声称"。**

---

## 回复 4：关于 plan-review 长文本 —— 我的临时方案

官方 `intent: { kind: 'plan-review', approve: string }` 的 `detail`
是完整计划 markdown。

**我现在的做法**：只把 label 送出，不做独立卡片。

**下一步想做**：折叠式卡片——默认只显示计划的前 3 行 + "展开全文"，
点开后在侧栏内滚动（不跳页）。

**你觉得这个方向对吗？** 还是应该跳第二页（用户对第二页暂议）？

---

## 回复 5：我们新发现、你完全没提的东西

`session/projections` 返回 **21 个字段**（启用 team 后）：

```
title, goal, tokenUsage, contextPressure, contextBreakdown, inbox,
sessionStats, turnOutline, agentPreset, userQuestions, permissions,
workingDirectory, subagentCatalog, subagentTiming, subagent,
agentTeam, todos, plan, modelSelection, sessionListMetadata, imageLimits
```

其中我们**还没探索**的：

| 字段 | 我的猜测 |
|---|---|
| `todos` | Agent 自己的待办列表？与我们的 Waiting 区关系？ |
| `plan` | **可能直接就是 plan-review 的数据源** |
| `permissions` | 权限状态（可用于审批卡片） |
| `inbox` | `next-turn` / `next-step` 队列 |

**`plan` 如果能直接给出当前计划，plan-review 卡片就有了数据源。**
这是我们下一步要验证的。

---

## 我们对你的建议的采纳情况（诚实版）

| 你的建议 | 采纳？ | 原因 |
|---|---|---|
| 核心抽象从 Agent 换成 Mission | ✅ **已做** | 我们的 Mission 模型比你的草图更严 |
| 右侧栏 = 决策中心 Focus Desk | ✅ **已做** | 待办置顶 + 可操作 + 空状态 |
| Since You Were Away | ✅ **已做** | 只列真实事件，不用模型生成 |
| Shared Context 四类 | ✅ **已做** | Finding/Assumption/Evidence 全有写入口 |
| 不做第二个聊天框 | ✅ | |
| 不做 Token 看板 | ✅ | |
| Host 插件 runtime-bridge | ❌ **不需要了** | 见回复 1 |
| Workstream 学 Retinue | ⚠️ **改用官方 TeamTask** | 见回复 2 |
| 会议桌/资料架/成果架 | ❌ 用户已否 | 无事实源 |
| Live2D | ⏸ Deferred | 接缝已做好 |
| 目录迁移 src/runtime/adapters/ | ❌ | 无收益 |
| 多 Harness | ❌ | 同意你的判断 |

---

## 我们最想听你回答的四个问题（修订版）

1. **TeamTask 与 Mission/Workstream 怎么映射？**
   一对一，还是一对多？我们的 Workstream 要不要直接变成 TeamTask 的投影？
2. **Work Receipt 的"验证"要不要做成"真的跑一条命令"？**
   我的草案是 `verification: { command, expectedExitCode }` + 真实执行记录。
3. **`ready: false` 的 Task 在 380px 里怎么表达最清楚？**
   「等待：<ownerName>」够吗？还是要显示被谁阻塞？
4. **plan-review 用折叠卡片够吗？**

---

## 我们愿意接受的反驳

如果你认为：

- 「experimental 的东西不该依赖」→ 我们有契约测试 + 投影缺 key 时回落，
  且**不启用 profile 时行为完全不变**（默认 20 字段，无 agentTeam）
- 「你们在重造 Team UI」→ 我们只读投影，不写 Team 状态；
  Team 的事实作者仍是 Harness
