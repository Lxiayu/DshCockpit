# DshCockpit 现状说明（给 GPT 交叉验证用）

> 用途：把这份贴给 GPT，让它基于**真实状态**而不是想象给建议。
> 依据：本仓真实代码 + 2950 项测试 + 多次真机验收

## 0. 一句话

我们**已经按你说的方向做了**（Mission 抽象、右侧栏=决策中心、
Since You Were Away、Shared Context 三实体），
现在缺的是三件具体的东西：**结构化交互选项、Work Receipt 状态机、Workstream 依赖关系**。

## 1. 技术底座（你可能需要修正的假设）

| 项 | 实情 |
|---|---|
| Runtime 版本 | **0.1.5-rc.2**（不是 0.2.1/0.2.2）。`dsh-user-questions` 在这个版本存在 |
| 连接方式 | **Electron WebContentsView + IPC**，不是 Host 插件 |
| 与 Harness 的通道 | WS `/api/remote.mux`（stream）+ HTTP `POST /api/<endpoint>`（unary），带 cookie 认证 |
| 已接 | `session/list` `session/create` `session/prompt` `session/follow` `session/page` |
| IPC 通道数 | **161 个**（office 10 / mission 1 通道 26 action / shell 若干） |
| 测试 | **2950 项**，0 失败，1 skip |
| 桌面壳形态 | 左 rail 三视图：`harness`（官方 Web UI 内嵌）/ `work`（半成品）/ `office`（虚拟办公室）+ 右栏 Mission Desk |

**关键**：我们已经**放弃与官方桌面壳竞争**（ADR-0001）。
`harness` 视图只是内嵌官方 Web UI，不是重做。

## 2. 右栏现在到底是什么

**不是 Team Inspector**（你 A1 版建议的），而是接近你 A2 版的 **Focus Desk**：

```
Mission Desk                        进行中 1/共 1   [新建 Mission]
┌──────────────────────────────────────────────────────────┐
│ DshCockpit Runtime 集成                              ▼  │
└──────────────────────────────────────────────────────────┘
⚠ 需要你处理                                        (2)     ← L1 置顶
  [审批] 执行 rm -rf build          风险高 · 2分钟前
         [拒绝] [允许]
  [提问] 要继续吗？                 风险低 · 1分钟前
         [输入回答…] [回答]
──────────────────────────────────────────────────────────
✓ 团队运行正常（零待办时）                             ← L2
──────────────────────────────────────────────────────────
你离开期间                        上次查看：3小时前    ← L3
  ● 决策  暂不引入第二套 Harness
  ● 提问  第二页做什么？
  ● 产物  研究报告
──────────────────────────────────────────────────────────
Mission 状态（我们拥有）    [active ▼]
实时状态（Harness 拥有，只读）
  观察到 刚刚 · Agent 在跑：是 · 待审批 1 · 待回答 1
目标 / 边界 / 决策 / 发现 / 假设 / 证据 / 未决问题 / 工作流
```

**已经有的（你可能以为还没有）**：
- ✅ Needs Your Attention 置顶 + 可操作（允许/拒绝、输入回答）
- ✅ 零待办显式空状态（「✓ 团队运行正常」）
- ✅ Since You Were Away（时间线，只列真实事件）
- ✅ Shared Context 三实体（Finding / Assumption / Evidence）**已实现且有写入口**
- ✅ 决策区分 proposed / accepted
- ✅ 双主题（深/浅）全 token 化，对比度全部 ≥ AA
- ✅ 单一事实源（`FORBIDDEN_PERSISTED_FIELDS` 禁 `running`/`focused`/`sessionId`）

## 3. 我们缺什么（请你针对这三条给建议）

### 缺口 1：右栏没用官方的结构化交互能力

官方 `dsh-user-questions` 支持：
```ts
interface AskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskUserQuestionOption[];   // ← 多个可选答案
  multiSelect?: boolean;               // ← 多选
  intent?: { kind: 'plan-review'; approve: string };  // ← 计划审查
}
```

**我们的数据层已经在保留 `options`**（`main.js:4475`），
`office.html` 也**已经在渲染**它们（一键选项 + 自定义输入）。

**但新右栏做成了自由文本输入框** —— 等于把已有能力退化了。

请针对以下给建议：
1. `plan-review` intent 应该怎么在右栏呈现？（现在完全没用）
2. `multiSelect` 的场景是什么？我们没有对应 UI
3. `detail`（长文本，比如计划 markdown）在 380px 里怎么放？

### 缺口 2：Work Receipt（我们只有产物，没有"凭什么可信"）

我们现在 `Deliverable` 有：`label` / `relPath` / `digest(sha256)` / `registeredAtMs`。

**没有**：验证方式 / 验证结果 / 审查状态 / 执行成员。

你建议的 6 状态（Generated/Unverified/Verified/ReviewRequired/Accepted/RevisionRequired）
我们一个都没有。

请给建议：
1. 这 6 个状态能不能再简化？（我们倾向于状态机越简单越好）
2. "验证结果"是让 Agent 自己填，还是从某个真实来源读？
   （我们坚持「不伪造」，Agent 说通过了不算通过）
3. 审查动作（通过/要求修改）的后果应该是什么？改 Deliverable 状态？还是发消息给 Agent？

### 缺口 3：Workstream 没有依赖关系

你说「传统 Kanban 价值不大……解决不了依赖」——**我们同意，而且我们确实没有 `dependsOn`。**

我们现在 `Workstream` 只有 `status: active|blocked|done|dropped`。

请给建议：
1. `dependsOn` 应该是 workstream 之间的 DAG 吗？环怎么处理？
2. 380px 里怎么展示依赖图？（我们怀疑画不出来，可能只能用"谁在等谁"的文字）
3. 依赖和"阻塞"（blocked）是两件事还是一件事？

## 4. 我们明确不做的事（请不要建议这些）

| 不做 | 原因 |
|---|---|
| 右栏第二个聊天框 | 同意你的判断；且我们有 `harness` 视图 |
| Host 插件 `@dshcockpit/runtime-bridge` | 大工程；当前 API Gateway 已够用 |
| SDK JSON-RPC 自启 Runtime | 会与 Electron 托管的 Runtime 争同一份会话目录（你也警告过） |
| 会议桌 / 资料架 / 成果展示架 | 用户已确认不做（无事实源，做了是装饰性谎言） |
| 多 Harness 并列（Pi 等） | 同意你的判断：不采用 |
| `src/runtime/adapters/` 目录迁移 | 机械迁移无收益；现有 `office/`+`mission/`+`team/` 职责已分开 |
| Live2D 现在替换 Sprite | 已在 ADR-0006 Deferred；**渲染接缝已做好** |

## 5. 我们的开发流程（供你判断建议可行性）

- 每个功能必须有**真机验收脚本**（Electron 实跑 + 截图 + 对比度实测）
- 有**四态 CI 门禁**：compat-ledger / licenses / capability-packs / perf-baseline
- **变异验证**：加一个功能要能"故意改坏 → 测试变红"，否则视为假测试
- 拒绝「离线全绿但真机不可用」——已经踩过三次这个坑

## 6. 最想听你回答的三个问题

1. **右栏在 380px 里，怎么同时容纳"结构化选项 + detail 长文本 + plan-review"？**
   我们怀疑三者不能共存。
2. **Work Receipt 的"验证结果"如果不信任 Agent 自述，那数据从哪来？**
   我们能想到的：文件 sha256（已有）、测试命令退出码、真实 diff。
3. **Workstream 依赖图在 380px 到底能不能画？**
   如果不能，用什么文字替代？
