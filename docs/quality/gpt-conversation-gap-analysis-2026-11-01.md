# 与 GPT 对话的差距分析（2026-11-01）

> 来源：`/Users/xia/Downloads/ChatGPT_项目发展方向-__20261102-0250.md`（5183 行，**4 轮**问答）
> 方法：逐条提取它的建议 → 用真实代码核对 → 标注"已有/部分/缺失/不可行"
> 原则：**不把它的建议当结论，也不因为它是 GPT 说的就否定**

## 0. 最重要的一件事：它自己推翻了第一版方案

| | 第一版（A1） | 第二版（A2，自我推翻） |
|---|---|---|
| 右栏定位 | **Team Inspector**（团队状态 + 人类介入中心） | **Focus Desk**（人类决策中心） |
| 内容 | Team Overview / Needs Your Attention / Active Tasks / Activity Feed / Quick Ask + 点员工 + 点任务 | Needs Your Attention / Deliverables / Important Activity / 新建任务委托 |
| 可否收起 | 常驻 | **可收起** |

A2 原文（L1295）：

> 「我把 Team Inspector 和任务板作为右侧栏的重要内容，这个方案确实没有充分考虑你的实际情况。
> 你已经做了成员悬停信息，DeepSeek Harness 本身又有 Team 成员列表和共享任务板，
> **再复制一套意义不大**。」

**所以不能用 A1 的清单当验收标准。** 本文以 A2 为准。

## 1. 它最锐利的一句判据

用户自己提的（L1282）：

> 「有用，能高效的解决问题，同时又是在官方 harness 里不好直接做的 / 看不到和展现的。」

它由此推导（L1297）：

> 「虚拟办公室的右侧栏，不应该是 Agent 信息面板，而应该是**人类与 Agent 团队之间的决策交互界面**。」

以及分工（结尾）：

| 界面 | 回答 |
|---|---|
| 办公室 | 团队正在**做什么**？ |
| **右侧栏** | 现在**需要我做什么**？ |
| Workspace | 团队**产出了什么**？ |
| Harness | Agent **如何**执行？ |

**这个分工我完全同意，而且我们上一轮做的待办区正是这个方向。**

## 2. 逐条核对（A2 为准）

### 2.1 已经做到的

| 它的建议 | 我们的实现 | 判断 |
|---|---|---|
| Needs Your Attention 置顶 | 红边框区块 + 风险色竖条 + 可操作 | ✅ **已做，且质量高于它的示意** |
| 待办必须能直接处理 | 允许/拒绝、输入回答 | ✅ |
| 零待办要显式空状态 | 「✓ 团队运行正常」 | ✅（它没提这点，我们自己加的） |
| Since You Were Away | 时间线 + 只列真实事件 | ✅ **已做** |
| 区分"提议"与"已接受"决策 | proposed/接受 视觉区分 | ✅ |
| 单一事实源 | Mission 有 `FORBIDDEN_PERSISTED_FIELDS` | ✅ 比它的建议更严 |
| 不做第二个聊天框 | 没做 | ✅ **同意且已遵守** |
| 不做 Token/状态看板 | 没做 | ✅ |

**结论：A2 的"第一层"（Needs Your Attention）和第二层的核心思路，我们上一轮已经实现了，而且更严。**

### 2.2 缺失但**可做**（有数据，只差 UI/接线）

| 它的建议 | 我们缺什么 | 可行性 |
|---|---|---|
| **结构化提问选项**（`options` / `multiSelect`） | **office.html 已有渲染，右栏没用** | ✅ **高优先** |
| **Plan Review 独立卡片**（官方 `plan-review` intent） | 完全没用 | ✅ 官方支持，值得做 |
| **侧栏可收起** | 没有 | ✅ 简单 |
| Deliverables 视图（带审查状态） | 有产物列表，无审查状态机 | ⚠️ 需要先定义状态 |
| Blocker 卡片 | 无数据源 | ⚠️ 需要业务模型 |

**其中第一条是真正的落差**：官方 `dsh-user-questions` 支持
`options` / `multiSelect` / `intent: plan-review`，`main.js:4475` **已经在保留 options**，
office.html 也**已经在渲染**——但新右栏我做的是自由文本输入框。

> **等于把已有能力退化了。**

### 2.3 缺失且**需要先解决 API**

| 它的建议 | 卡在哪 |
|---|---|
| 新建任务委托 → Lead | `TeamService.sendMessage` 是成员间消息；`session/prompt` 是往某个 Session 排消息。两者都需要拿到 **Lead 的 sessionId** |
| 「在 Harness 中继续」跳转 | 需要 dsh web 的 session URL 格式 |
| 点员工 → 该员工会话 | 需要 `ctx.agentTeams.listMembers()` 或等价通道 |
| Review / 退回 | 需要"验收状态机"，无数据源 |

**这些不能做界面版**——做了就是"点了没反应"，比不做更糟。

### 2.4 不同意 / 需要修正的地方

| 它的说法 | 我的判断 |
|---|---|
| 「官方 Team 插件是 experimental，不能当稳定 API」 | ✅ 同意，但我们**已经在用** 0.1.5，且 ADR-0002 有退役约束 |
| 「先做 Host 插件 `@dshcockpit/runtime-bridge`」 | ⚠️ **这是大工程**。我们当前用 API Gateway / mux 已经能拿到需要的数据，先不引入第二个进程 |
| 「SDK JSON-RPC 启动自己的 Runtime 子进程」 | ⚠️ 它与现有 Electron 托管 Runtime **会争抢同一份会话持久化目录**（它自己也警告了）。不做 |
| 「目录结构 `src/runtime/adapters/...`」 | ⚠️ 机械迁移没有收益。我们已有 `src/office/`、`src/mission/`、`src/team/`，职责已分开 |
| 「V1 六件事里包含 Quick Ask」 | ⚠️ Quick Ask 需要"给 Lead 发消息"的能力，当前无 API |

## 3. 它提到但我们容易忽略的三个点

### 3.1 「Idle 不应该直接等同于任务完成」

它的原文强调这点。我们已遵守（`hasRunningAgent` 与 Mission status 分开），
但**右栏没有把"长时间无进展"暴露出来**。

场景 C（团队长时间没进展）我们没有对应设计。

### 3.2 「员工打瞌睡不代表任务停止，敲键盘不代表成功执行」

这是我们的既有原则（任务事实与动画分离）。**它建议上升为项目基础规范**——已在 AGENTS.md。

### 3.3 「不要为了让办公室显得热闹而制造虚假的任务」

已在 `product-principles.md`。

## 4. 我的结论：差距在哪

### 真实差距只有一条，但很关键

**右侧栏没有充分利用官方的结构化交互能力。**

具体：`options` / `multiSelect` / `plan-review intent` 三个字段，
数据层已经在保留，office.html 已经在渲染，**新右栏却退回了自由文本框**。

这不是"没做"，是"做的时候没对齐已有能力"。

### 第二条：侧栏不可收起

它说「没有需要处理的事情时，应该允许收起」。
现在 380px 常驻，用户无法让它彻底让位。

### 第三条：Deliverables 缺审查状态机

它有 6 个状态（Generated/Unverified/Verified/ReviewRequired/Accepted/RevisionRequired），
我们只有"已登记 + digest 校验"。这是**真实的业务模型缺口**。

## 5. 下一步建议（按可完成度排序）

| 优先 | 项 | 为什么现在能做 |
|---|---|---|
| **1** | **右栏用结构化选项渲染提问** | 数据已有、office.html 有参考实现 |
| **2** | **Plan Review 独立卡片** | 官方 `intent: 'plan-review'` 已支持 |
| **3** | **侧栏可收起** | 纯 UI |
| 4 | Deliverables 审查状态机 | 需要定义 schema（可做） |
| 5 | 委托任务 / 跳转 Session | **需先调研 API**，调研完再定 |

## 5.5 后两轮（它反问"还差什么"之后）提出了新方向

前两轮聚焦"右栏放什么"。后两轮用户问「还差了点什么」，
它给出了三类**前两轮没提**的东西：

### 5.5.1 核心抽象从 Agent 换成 Mission

> 「核心抽象应该从 Agent 换成 Mission。」

配套 4 个 TS 模型 + 6 个 `mission.*` 工具名：

```ts
interface Mission { id; workspaceId; title; objective; successCriteria: string[];
  constraints: string[]; status: "planning"|"active"|"paused"|"review"|"completed";
  version: number; activeTeamId?: string; }
interface MissionRecord { id; missionId; type: "finding"|"decision"|"assumption"|"question";
  content; authorId; evidenceRefs: string[];
  status: "proposed"|"verified"|"accepted"|"superseded"; createdAt: number; }
interface Workstream { id; missionId; title; agentId?; runtimeTaskId?; sessionId?;
  dependsOn: string[]; evidenceRefs: string[]; status: string; }
interface Deliverable { id; missionId; title; uri; verification: string[]; status: string; createdAt: number; }
```

**核对结果：我们的 `Mission` 已经覆盖了它建议的绝大部分**，
而且更严（`FORBIDDEN_PERSISTED_FIELDS` 禁了 `running`/`focused` 等）。

**差异 1**：它的 `Mission` 有 `successCriteria: string[]` 和 `version: number`，
我们对应的是 `constraints`（有）+ 无显式 `version`。

**差异 2**：它的 `Workstream` 有 `dependsOn: string[]`（**依赖关系**），我们没有。

它强调（2849）：「传统 Kanban 价值不大……悬停已能解决成员详情与简单状态，
但**解决不了依赖**。」

**这是真实的缺口**：我们的 workstream 只有 `status`，没有 `dependsOn`。
所以画不出依赖图，也判断不了"谁在等谁"。

### 5.5.2 Work Receipt（工作凭证）—— 它认为最有价值的概念

对比：

```
普通产品：Task Completed ✅
它的设计：程序员已完成接口实现 (待验收)
          ├ 接口实现 Diff（产物）
          ├ 单元测试 24/24 通过（验证）
          ├ 接口设计文档（文档）
          └ 审查员反馈：还有一个问题…（审查）
```

Work Receipt 关联 6 项：产物 / 来源 / 验证方式 / 验证结果 / 执行成员 / 时间记录。

它的判据（Retinue 项目启发）：
> 「Agent 说自己完成了，**不代表它真的完成了**。」

**核对结果：这是我们的真实缺口。**

我们有 `Deliverable`（含 sha256 digest 校验），
但**没有"验证方式 / 验证结果 / 审查状态"这三个字段**。

现在用户看到"产物已登记"，但无法回答"它凭什么可信"。

### 5.5.3 Capability Platform（这是用户自己的想法，它做了深化）

用户原话（L3780）：

> 「deepseek harness 的核心思想是一切皆插件，那么我们可不可以通过**内置的、优秀的相关管理**
> 来帮助新手用户，让他们聚焦他们想做的应用的核心功能而不是繁琐的
> 如**数据保存、跨上下文管理**这样的繁琐内容。」

它深化为 **Capability Packs**：

| 概念 | 内容 |
|---|---|
| 用户看到 | 「持久记忆」「安全并行开发」「知识工作区」「代码验证」四个**能力**，不是插件 |
| 底层 | 5 个 Provider：Memory / History / Workspace / Knowledge / Verification |
| 关键句 | 「用户看到的是**能力**，而不是底层依赖的复杂性」 |

**核对结果：我们的 `src/capability-packs/` 已经有 manifest + verify + installer 三件套**，
且 verify 是四态（passed/failed/skipped/not-verified）。
但**没有 Provider 抽象**（它建议的 `MemoryProvider` 接口）。

而且我们在 ADR-0003 里**已经论证过不抽象**——理由见该 ADR 的复核附注。

### 5.5.4 Live2D 与角色系统

用户问「是不是可以考虑 Live2D，或者看看 dsh-pet」。

它的结论：**可考虑但不要现在取代**，走**混合渲染**：
- 场景 A 移动 → Sprite
- 场景 B 工位特写 → Live2D

并警告 `Cubism 5 SDK for Web` 的 **Expandable Application 许可证风险**
（直接关联"角色市场"能不能做）。

**核对结果：我们在 ADR-0006 已经做了同样判断（Deferred）**，
而且上一轮**已经把 `RenderBackend` 接缝做好了**——
它的"混合渲染"设想，我们已经把接缝标出来了。

### 5.5.5 办公室交互物件（六个）

`项目白板·Mission Board` / `会议桌·Team Knowledge` / `员工工位·Workstream` /
`资料架·Knowledge Library` / `收件箱·Human Inbox` / `成果展示架·Delivery Center`

它的诊断很锐利（4461）：
> 「花架子的根源 = **交互对象是 Agent 而不是 Agent 正在做的工作**。」

**核对结果：用户已确认本轮不做会议桌/资料架/成果架**（设计文档判定无事实源）。
白板和收件箱已有（右侧栏承担）。

## 5.6 它自己在原文里的 6 处不一致（子代理发现）

这些说明**它的建议不能整体照抄**：

| # | 不一致 |
|---|---|
| 1 | 场景 A 要「记录 Brief 修改前后的版本」，但 `interface Mission` 只有 `version: number`，无历史快照字段 |
| 2 | `MissionRecord.status` 有 `verified`，但决策又要求人类确认——两种状态没分开 |
| 3 | `Workstream.status` / `Deliverable.status` 是裸 `string`，界面却在用固定标签 |
| 4 | 场景 B 的 `Conflict` 实体只在 mermaid 出现，没进模型列表 |
| 5 | Change Log 的四个分类（已完成/新增发现/出现阻塞/已记录）无对应字段 |
| 6 | `Needs Your Attention` 与 `Human Inbox` 是同一诉求的两种界面形态，未统一 |

**这说明它给的是"设计草图"，不是"可实现的规格"。用它做输入，不能用它做规格。**

## 6. 需要向 GPT 反馈的"它不知道的实情"

如果要把现状回传给 GPT 做交叉验证，应该说清：

1. **我们用的是 0.1.5-rc.2（不是它调研的 0.2.1/0.2.2）**，
   但 `dsh-user-questions` 在这个版本也存在
2. 我们的 dock 是 **Electron WebContentsView + IPC**，不是 Host 插件
3. 已经有 **20+ 个 mission action**、161 个 IPC 通道、2950 项测试
4. 已经有 **Needs Your Attention / Since You Were Away**（它以为还没做）
5. 我们的**桌面壳不是"另一个 Harness"**，而是：左侧 rail 三视图
   （harness 官方 Web UI / work 半成品 / office 办公室）+ 右侧 Mission Desk
6. 已经**放弃了与官方桌面壳竞争**（ADR-0001），office 是主视图
