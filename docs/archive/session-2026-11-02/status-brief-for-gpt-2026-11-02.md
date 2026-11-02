# DshCockpit 现状说明 v2（给 GPT 交叉验证用）

> 用途：把这份贴给 GPT，让它基于**真实状态**而不是想象给建议。
> 更新日期：2026-11-02（**运行时已升级到 0.2.1-rc.5**）
> 依据：本仓真实代码 + 2950 项测试 + 5 个真机验收探针（共 73 项检查）

## 0. 先纠正上一版里已经过时的三件事

| 上一版我说的 | 现在的事实 |
|---|---|
| Runtime 是 0.1.5-rc.2 | **已升级到 0.2.1-rc.5** |
| 缺口 1：右栏没用结构化选项 | **已修复**（见 §3.1） |
| 新发现：`session/projections` | **已采纳并验证**（20 个投影字段） |

## 1. 技术底座（请据此修正你的假设）

| 项 | 实情 |
|---|---|
| Runtime | **@deepseek-ai/dsh 0.2.1-rc.5**（npm `latest`） |
| 包数 | 307 个 `@deepseek-ai` 包（0.1.5 是 241） |
| 连接方式 | **Electron WebContentsView + IPC**，不是 Host 插件 |
| 通道 | WS `/api/remote.mux`（stream，帧只有 `open/item/end/cancel`）<br>+ HTTP `POST /api/<endpoint>`（unary，body 是 `{type:'client-request', rpcId, method, payload:{args}}`） |
| 已接 unary | `session/list` `session/create` `session/page` `session/prompt` `session/projections` |
| 已接 stream | `session/follow`、`$events` |
| IPC 通道 | 161 个（office 10 / mission 1 通道 26 action / shell 若干） |
| 测试 | **2950 项**，0 失败，1 skip |
| 真机探针 | 5 个，共 **73 项**检查，全绿 |
| 三视图 | `harness`（内嵌官方 Web UI）/ `work`（半成品，暂议）/ `office`（虚拟办公室 + 右栏 Mission Desk） |

**关键边界**：已放弃与官方桌面壳竞争（ADR-0001）。`harness` 视图只是内嵌官方 Web UI。

## 2. 右栏现在的真实样子

```
Mission Desk                        进行中 1/共 1   [新建 Mission]
┌──────────────────────────────────────────────────────────┐
│ DshCockpit Runtime 集成                              ▼  │
└──────────────────────────────────────────────────────────┘
⚠ 需要你处理                                        (1)     ← L1 置顶
  [提问] 选择研究方法
  风险 中 · 1分钟前
  ┌────────────────────────────────────────────┐
  │ 实证研究：优先收集实验数据                  │
  └────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ 文献综述：优先梳理已有研究                  │
  └────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ 混合研究：两种方法结合                      │
  └────────────────────────────────────────────┘
  [或自定义回答…                    ] [发送]
──────────────────────────────────────────────────────────
✓ 团队运行正常（零待办时）                          ← L2
──────────────────────────────────────────────────────────
你离开期间                          上次查看：3小时前   ← L3
  ● 决策  暂不引入第二套 Harness
  ● 提问  第二页做什么？
  ● 产物  研究报告
──────────────────────────────────────────────────────────
Mission 状态（我们拥有）    [active ▼]
实时状态（Harness 拥有，只读）
  观察到 刚刚 · Agent 在跑：是 · 待审批 1 · 待回答 1
目标 / 边界 / 决策 / 发现 / 假设 / 证据 / 未决问题 / 工作流
```

## 3. 已完成的（你可能以为还没做）

### 3.1 结构化交互（上一版的缺口 1，**已修复**）

**怎么修的**：升级到 0.2.1 后发现新端点 `session/projections`。

实测返回 20 个投影字段：

```
title, goal, tokenUsage, contextPressure, contextBreakdown, inbox,
sessionStats, turnOutline, agentPreset, userQuestions, permissions,
workingDirectory, subagentCatalog, subagentTiming, subagent,
todos, plan, modelSelection, sessionListMetadata, imageLimits
```

其中 `userQuestions`：

```ts
interface UserQuestionProjectionView {
  readonly active: readonly PendingUserQuestion[];   // 可回答
  readonly settled: readonly SettledUserQuestion[];  // 已回答
}
interface PendingUserQuestion {
  readonly callId: ToolCallId;
  readonly questions: readonly AskUserQuestionItem[];  // ← 带 options
  readonly state: UserQuestionState;
}
```

**所以右栏现在真的渲染成选项按钮**，点击把 label 原样送出（真机 10/10 验证）。

**隐私边界的处理**（这是个设计难点）：Mission 按规则不存 raw sessionId
（只存派生句柄 `sess-h-*`），所以右栏拿不到 sessionId。
解法是由 main 侧取"当前被 follow 的会话"——office 模块本来就持有这个
运行时事实（它是 follow 流的 key）。

### 3.2 其他已完成项

| 项 | 状态 |
|---|---|
| Needs Your Attention 置顶 + 可操作 | ✅ 真机 19/19 |
| 零待办显式空状态（"✓ 团队运行正常"） | ✅ |
| Since You Were Away（只列真实事件） | ✅ |
| Shared Context 三实体（Finding/Assumption/Evidence） | ✅ 含写入口，真机 17/17 |
| 决策 proposed / accepted 区分 | ✅ |
| 单一事实源（黑名单禁 `running`/`focused`/`sessionId`） | ✅ 比你的建议更严 |
| 双主题全 token 化（对比度全部 ≥AA） | ✅ |
| 视觉层级（scale + weight，不靠颜色） | ✅ 实测标签 11px/650/uppercase |

## 4. 仍然缺的三件事（想听你的意见）

### 缺口 A：plan-review 在 380px 里怎么放？

官方 `intent: { kind: 'plan-review', approve: string }` 的 `detail` 是
**计划的完整 markdown**（可能几千字）。

- 380px 侧栏放不下
- 我们目前只把 label 原样送出，**没有独立卡片**
- 官方明确说 approve 是"named rather than positional"，
  所以我们不按选项顺序推断结论

**可选方案**：展开抽屉？弹窗？跳第二页（用户对第二页暂议）？

### 缺口 B：Work Receipt 的"验证结果"数据从哪来？

我们坚持"Agent 说通过了不算通过"。能想到的真实来源：

- 文件 sha256（**已有**，`Deliverable.digest`）
- 测试命令的退出码
- 真实 git diff

**但这些是"执行证据"，不是"验收判断"。**

问题：**谁做"通过/不通过"的判定？**
- Agent 自己 → 违反"不伪造"
- 人 → 那就要人逐个看，成本高
- 可复现的检查脚本 → 需要脚本本身可信

这直接决定 schema 怎么设计（我们要不要加 `verificationScript` 字段？）。

### 缺口 C：Workstream 依赖图在 380px 能不能画？

我们已有 `Workstream { status }`，缺 `dependsOn: string[]`。

- 380px 里画 DAG 现实吗？
- 如果不能，用什么文字替代（"等待：研究员的任务"）？
- **依赖**和**阻塞**（blocked）是两件事还是一件事？

## 5. 我们不做的（请不要再建议）

| 不做 | 原因 |
|---|---|
| 右栏第二个聊天框 | 同意你的判断 |
| Host 插件 `@dshcockpit/runtime-bridge` | 当前 API Gateway 已够用 |
| SDK 自启 Runtime | 会与 Electron 托管的 Runtime 争同一份会话目录 |
| 会议桌 / 资料架 / 成果展示架 | 用户已确认不做（无事实源） |
| 多 Harness 并列（Pi 等） | 同意你的判断 |
| 目录机械迁移到 `src/runtime/adapters/` | 无收益 |
| Live2D 现在替换 Sprite | 已 Deferred，**渲染接缝已做好** |
| Token 用量面板 | 用户明确不要 |

## 6. 我们新发现的、想请你判断的一件事

`session/projections` 里还有几个我们没探索的字段：

- `todos`
- `plan`
- `subagent`
- `subagentTiming`
- `subagentCatalog`

**我的猜测**：`subagent` 可能是 Team 能力的**稳定替代入口**——
因为它在 `projections` 里（稳定 API），而 `agentTeam` 投影在两个版本
（0.1.5 / 0.2.1）里都**没有**进稳定 API types。

**这是不是一条绕过 `agentTeam` 不稳定的路？**
如果是，Team 成员状态可能不需要 Host 插件也能拿到。

---

## 7. 我们最想听你回答的四个问题（按优先级）

1. **`subagent` / `subagentCatalog` 投影能否替代 `agentTeam` 拿到团队状态？**
   （这决定我们要不要做 Host 插件）
2. **Work Receipt 的判定权该给谁？** 有没有"可复现且不需人逐个看"的方案？
3. **plan-review 的长文本在窄侧栏怎么处理？**
4. **Workstream 依赖在窄侧栏用什么形式表达？**

## 8. 我们的开发流程（供你判断建议可行性）

- 每个功能必须有**真机验收脚本**（Electron 实跑 + 截图 + 对比度实测）
- 四态 CI 门禁：compat-ledger / licenses / capability-packs / perf-baseline
- **变异验证**：加功能要能"故意改坏 → 测试变红"，否则视为假测试
- 拒绝"离线全绿但真机不可用"——已踩过四次这个坑
