# Mission Desk MVP 范围 —— 深度分析

> 日期：2026-11-01
> 上游：`docs/quality/mission-desk-ux-audit-2026-11-01.md`（Phase 0 审计）
> 目的：回答"MVP 到底该包含什么"，给出可决策的论证而不是清单

## 0. 先纠正我上一轮的一个错误

我上一轮说「方案 C：侧栏 + 展开全屏，**基础设施现成**，因为 work.html 已有 expandWork」。

**这个判断是错的。** 追到 `main.js:801` 才看清：

```js
function expandWorkView() {
  windowManager.showWorkShellView();   // ← 切换到另一个主视图，不是展开侧栏
  ...
}
```

而且 `workView`（主视图）和 `workDockView`（侧栏）是**两个独立的
WebContentsView 实例**，加载同一个 HTML 文件但**各有独立的 DOM 和滚动状态**。

所以"展开"= **跳转到另一个页面**——用户说得完全对。

我的错误在于：只看到 `action: 'expand'` 就推断"基础设施现成"，
没有追到实际实现。**这正是我反复批评别人的"看名字下结论"。**

## 1. 先回答：MVP 该多大

### 一个反直觉的起点：MVP 越小越好，但必须**闭合**

UX 改造最容易犯的错是"做一半"——三个 tab 都有了，但每个都只有一项内容，
用户点进去发现是空的，**比只做一个视图更糟**。

因为空 tab 传递的信号是"这里有东西但没做好"，而单一完整视图传递的是"这里就是全部"。

所以 MVP 的判据不是"包含多少功能"，而是：

> **每一个出现在界面上的元素，都必须有真实数据和真实操作。**
> 宁可少一个 tab，也不要有一个空 tab。

### 由此推导 MVP 的边界

按"能不能闭合"把候选功能分三类：

| 类别 | 判据 | 处置 |
|---|---|---|
| **A. 数据已就绪 + 操作真实** | 现在就能做出闭合的 | **进 MVP** |
| **B. 数据缺一半** | 需要先补数据模型 | **拆分**：补数据部分进 MVP，UI 延后 |
| **C. 无数据源/无 API** | 做了就是假的 | **不进 MVP**，标 Issue |

## 2. 逐项分类（用代码事实判定）

### A 类：现在就能闭合

| 功能 | 数据来源（已验证） | 操作是否真实 |
|---|---|---|
| **Mission Snapshot** | `missionView()` 的目标/状态 | ✅ 已有 `update` action |
| **Needs Your Attention** | `PENDING_KINDS=['approval','question']` 真实 Harness 事件 | ✅ 已有 `office:pending` 回答通道 |
| **决策列表** | `decision.recorded` | ✅ 已有 `recordDecision` |
| **未决问题** | `question.opened` | ✅ 已有 `openQuestion`/`answerQuestion` |
| **产物列表** | `deliverable.registered` + 真实 sha256 | ✅ 已有 `registerDeliverable`/`verifyDeliverables` |
| **工作流** | `workstream.created` | ✅ 已有 `addWorkstream`/`updateWorkstreamStatus` |
| **Brief 状态** | `briefSyncState` | ✅ 已有 `syncBrief` |
| **Mission 切换** | `list` action 支持多 Mission | ✅ 已有 |

**结论：Mission Desk 独立窗口已有的全部能力，都是 A 类。**

这意味着——**右栏迁移不需要新建任何数据层。**

### B 类：数据缺一半，需要拆分

| 功能 | 缺什么 | 拆分方案 |
|---|---|---|
| **Since You Were Away** | 缺"上次查看时间"的持久化 | ① 加 `lastSeenAtMs` 字段（小）→ ② 聚合"离开后的变化"（需按事件时间过滤）→ ③ UI |
| **Shared Context 的 Findings/Assumptions** | 实体不存在 | ① schema 加两实体 → ② projection → ③ IPC → ④ UI |
| **Welcome Back** | 本质是 Since You Were Away 的简化版 | 一起做 |

**关键判断**：这两项都是"补数据 → 补 UI"两段式。
**数据段必须先做**，否则 UI 无从谈起。

### C 类：无数据源 / 无 API（做了就是假的）

| 功能 | 缺什么 | 处置 |
|---|---|---|
| 委托任务给 Lead | grep `team/spawn`/`sendTeamMessage` → **0** | 需先调研 Harness 有无 team message API |
| 跳转 Harness Session | grep `openSession` → **0** | 需确认 `dsh web` 的 session URL 格式 |
| Conflict 卡片 | 无冲突检测数据 | Deferred |
| Blocker 卡片 | 无 blocker 概念（workstream 有 blocked 状态，但那是人标的） | Deferred |
| Deliverable Review 流程 | 有产物无"审查状态机" | Deferred |
| 会议桌/资料架/成果区 | **用户已确认不做** | 删除 |
| Quick Panel | 三形态之一，非核心 | Deferred |

## 3. 核心判断：MVP 应该是什么

### 方案对比

| 方案 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| **A 最小** | 只做 Mission Snapshot + Needs Your Attention | 一周内可完成，全闭合 | 信息太少，回答不了"上次做到哪了" |
| **B 中等**（推荐） | A + 决策/问题/工作流/产物（即迁移完整 Desk） | **零新建数据层**，全部 A 类 | 缺"跨会话连续性"的体验 |
| **C 大** | B + Finding/Assumption + Since You Were Away | 真正回答检验问题 | 需补两个实体 + 时间基线，2-3 周 |
| **D 提示词全量** | C + 委托 + 跳转 + Conflict + Quick Panel | 功能最全 | 一半是 C 类（做不了/要造假） |

### 我的建议：B + C 的数据部分，分两步

**第一步（1 周内，闭环）**：
右栏 = 迁移完整 Mission Desk（B）。**零新建数据层，全部复用已验证能力。**

这一步的价值：**立刻让右栏从"任务面板"变成"Mission Desk"**，
而且所有按钮都能真的用。

**第二步（1-2 周，补连续性）**：
补 `Finding` / `Assumption` 实体 + `lastSeenAtMs` → 做 Since You Were Away 和 Shared Context 视图。

理由：
- Finding/Assumption 是**需求书四.1 明确要求**的，缺了 Shared Context 就只有一半
- "上次做到哪了"是检验问题里**最强的一条**，值得单独一步

**为什么不先做 Finding/Assumption？**
因为它需要 UI 配合才能被用户感知，而数据模型定下来后 UI 才有依据。
但反过来说——**如果先做 UI 后端没有数据，UI 就是假的。**

所以顺序是：**先迁移（证明右栏可行）→ 再补数据 + 新视图**。
迁移这一步能立刻验证"右栏承载 Desk 是否可行"，风险最低。

## 4. 关于第三个页面（work）—— 你的想法更对

你说：「现在的侧栏展开全屏，是点击后跳转到第二个页面，并不算完全展开。
事实上，我觉得我们可以把第二个页面变成更有意义的内容。」

**我同意，而且核实后发现有更强的理由。**

### 现状问题

```
workView（主视图）      ← work.html
workDockView（侧栏）    ← work.html (compact=1)
```

**两个独立 WebContentsView，同一个文件。** 后果：

1. **内存浪费**：同一份 371 行 JS 跑两遍
2. **状态不共享**：两个 DOM，滚动位置、展开状态各自独立
3. **"展开"体验断裂**：用户点了展开，看到的是**重绘后的另一个实例**，
   光标位置、滚动位置都丢了
4. **数据是共享的**（`sendToWorkView` 广播给两个），但**视图是分裂的**

### 三个可选方向

| 方向 | 做法 | 评价 |
|---|---|---|
| ① 真·展开 | 侧栏宽度 380 → 全宽，**同一个 view 实例** | 技术上可行（改 bounds），但 380px 的布局全宽后会很难看 |
| ② 第二页变成别的东西 | 保留两视图，但 work 主视图做**不同**的事 | **你说的方向** ✅ |
| ③ 删掉第二页 | 只保留侧栏 | 最简，但失去大屏空间 |

### 我倾向 ②，但需要明确定义"别的东西"

如果两个视图职责不同，那就要回答：**什么内容需要全屏？**

从第一性原理：**信息密度高的内容需要空间。**

| 内容 | 380px 够吗 | 全屏有价值吗 |
|---|---|---|
| Mission 快照 | ✅ 够 | ❌ 浪费 |
| Needs Your Attention | ✅ 够 | ❌ 浪费 |
| 决策/问题列表 | ✅ 够 | ⚠️ 稍好 |
| **产物预览**（PDF/图片/代码 diff） | ❌ **不够** | ✅ **必要** |
| **Shared Context 全景**（跨 workstream 的证据链） | ❌ 不够 | ✅ 有价值 |
| **Workstream 依赖图** | ❌ 不够 | ✅ 有价值 |

**所以第二页最合理的定位是：Mission Desk 的「深度视图」——**
侧栏放"摘要与行动"，全屏放"需要空间的东西"（产物预览 / 证据链 / 依赖图）。

这与"展开"的区别：**展开是同一个东西变大，深度视图是不同的信息层次。**

### 但你说"暂时再议"，我建议：

**这一轮先不做第二页。** 理由：
1. 它依赖第一页（右栏）先定下来
2. 如果右栏设计变了，第二页的定位也会变
3. 保留 `work.html` 现状（它还能用），不删不改，等下一轮

**唯一要做的**：把"展开"按钮的语义改准确——现在它叫"展开"但实际是"跳转"，
是**误导性文案**。改成"在完整窗口中打开"更诚实。

## 5. 最终建议的 MVP 清单

### 本轮做（Phase 1-4）

| # | 项 | 类型 | 依赖 |
|---|---|---|---|
| 1 | 右栏迁移 Mission Desk（Snapshot + Needs Your Attention + 决策/问题/工作流/产物） | A | 无 |
| 2 | Mission 切换 + 数据隔离 | A | 无 |
| 3 | 侧栏可收起 + 宽度可调（拖宽到 640） | A | 无 |
| 4 | 空状态（"团队运行正常，无需处理"） | A | 无 |
| 5 | 修正误导性文案（"展开" → "在完整窗口中打开"） | A | 无 |

### 下一轮做

| # | 项 |
|---|---|
| 6 | `Finding` / `Assumption` 实体（schema + projection + IPC） |
| 7 | `lastSeenAtMs` 持久化 |
| 8 | Since You Were Away / Welcome Back |
| 9 | Shared Context 视图（基于 6） |

### 明确不做（记 Issue）

| 项 | 原因 |
|---|---|
| 委托任务给 Lead | 无 API，需先调研 Harness |
| 跳转 Harness Session | 需确认 URL 格式 |
| Conflict / Blocker / DeliverableReview 卡片 | 无数据源 |
| 会议桌/资料架/成果区 | 用户已确认不做 |
| Quick Panel | 三形态可后补 |
| **第二个页面的重构** | 用户要求暂议 |

## 6. 为什么这个拆分是"第一性原理"的

不是按"功能重要程度"排，而是按**"能不能闭合"**排：

- A 类：数据和操作都在 → 做了就能用 → **先做**（风险最低，立刻见效）
- B 类：数据缺一半 → **先补数据，再做 UI**（否则 UI 是假的）
- C 类：无数据源 → **不做，否则就是造假**（违反 product-principles）

这个顺序保证：**每一轮交付物的每个元素都是真的。**
