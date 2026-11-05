# Mission Desk UX 审计（Phase 0）

> 日期：2026-11-01
> 上游：用户提供的新提示词《Mission Desk & Virtual Office Interaction Redesign》
> 方法：读真实代码 + 核实数据能力，不凭文档推断

## 0. 三个最重要的事实（先纠正提示词的前提）

### 事实 1：右侧栏不是"Mission Desk 的旧版本"，它就是「工作区任务面板」

```js
// src/window-manager.js:210
workDockView = new WebContentsView({ ... });
workDockView.loadFile(path.join(__dirname, 'work', 'work.html'), { query: { compact: '1' } });
```

右侧栏和 **work 主视图是同一个文件**（`src/work/work.html`，94 行），
只是传了 `compact=1`。它的真实内容是：

- 工作区选择（`wsBlock`）
- 任务输入框 + 开始按钮（`taskForm`）
- 任务列表（`items`）
- 任务详情 + 产物预览（`detail` / `artifacts` / `viewerWrap`）

**它从来没有被设计成 Mission Desk。** 所以"右侧栏相比之前没有明显改变"
不是设计失败，是**这块本来就没做过**。

### 事实 2：Mission Desk 已存在，但是在**独立窗口**里

`src/mission-desk.html` 是一个完整的独立窗口（`auxWindows.openMissionDesk()`），
已经实现了：目标/边界/实时状态/决策/未决问题/工作流/产物/TaskRef/Brief。

**所以现状是两套东西：**
- 独立 Mission Desk 窗口（完整，但用户要专门打开）
- 办公室右侧栏（只是个任务面板）

**提示词说的"重新设计右侧栏"，本质是「把 Mission Desk 搬进办公室右栏」。**
这是个正确的方向——但现在我们知道，工作量不是"改造旧侧栏"，
而是"迁移 + 扩展一个已有界面"。

### 事实 3：提示词要求的 Shared Context 四实体，只有两个

```js
// src/mission/schema.js:28
ENTITY_TYPES = ['mission', 'workstream', 'decision', 'openQuestion', 'deliverable', 'taskRef']
```

提示词 §七 要求：**Findings / Decisions / Assumptions / Open Questions**。

| 实体 | 状态 |
|---|---|
| Decisions | ✅ |
| Open Questions | ✅ |
| **Findings** | ❌ 零代码 |
| **Assumptions** | ❌ 零代码 |

**这是最关键的阻塞**：提示词 §七 的整个 "Shared Context" 视图，
一半的数据源不存在。而且要的字段（`evidenceRefs` / `confidence` / `expiresAtMs`）一个都没有。

## 1. 当前数据能力核实（MVP 可行性）

### ✅ 已有真实数据

| 能力 | 证据 |
|---|---|
| Mission CRUD + 投影 | `src/mission/` 9 模块，2914 项测试 |
| Decision / OpenQuestion / Deliverable | schema 已实现并有 UI |
| TaskRef（关联 Harness 执行） | 本轮接通，含隐私派生 |
| **approval / question 待办** | `PENDING_KINDS = ['approval', 'question']`，真实 Harness 事件 |
| Brief 写进 AGENTS.md | 真机验证模型能读到 |
| 产物 sha256 校验 | `deliverable.registerDeliverable` 真的读文件 |

### ❌ 缺失（提示词要求但无实现）

| 能力 | 影响 |
|---|---|
| **Finding / Assumption / Evidence 实体** | Shared Context 视图一半做不了 |
| **给 Lead 委托任务** | grep `team/spawn`/`sendTeamMessage` → **0** |
| **跳转到 Harness Session** | grep `openSession`/`shell:open-session` → **0** |
| Quick Panel 形态 | 无 |
| Since You Were Away 的基线记录 | 无（需要"上次查看时间"持久化） |

## 2. 对提示词的评价

### 写得好的地方（我同意）

1. **§三 "必须避免的错误设计" 是全篇最有价值的部分**
   - 不做第二个聊天框（避免绕过 Lead Agent 协调）
   - 不做普通 Dashboard（成员信息已有悬停）
   - 不为了填充侧栏而制造内容（"没有需要处理的事"本身是有价值的信息）

   这三条直接对应我们踩过的坑。特别是第一条——我们有 `harness` 主视图，
   再做一个聊天框就是两套历史和两套上下文。

2. **§四 "从 Activity 转向 Meaningful Changes"**
   这是真正的产品洞察。Activity Feed（"Agent A 开始工作"）没有价值，
   因为它需要用户自己从流水账里推断意义。

3. **§十六 最后那个自我检验问题**
   > 「如果用户已经打开了 DeepSeek Harness，他为什么还需要打开 DshCockpit？」

   这个判据非常锐利。它也暴露了一个风险：**如果 Mission Desk 只是
   "更好看的信息展示"，那答案就不成立。**

4. **§十三 的单一事实源与禁止伪造** —— 与我们 repo-map.md 铁律完全一致。

### 需要修正的地方（基于我们的实际情况）

| # | 提示词说 | 实际情况 | 我的修正 |
|---|---|---|---|
| 1 | "重新设计右侧栏" | 右侧栏是 work.html 的 compact 模式 | **不是改造，是迁移**：把 mission-desk.html 的职责搬进右栏 |
| 2 | §七 要求四实体 | 只有 2 个 | **必须先补 Finding/Assumption**，否则该视图做不了 |
| 3 | §十.2 委托任务给 Lead | 无对应 API | 需先调研 Harness 有没有 team message 接口；**没有就标为未接入，不伪造** |
| 4 | §十.3 跳转 Harness Session | 无实现 | 需要找 `dsh web` 的 session URL 格式 |
| 5 | §九.2 会议桌 = Team Knowledge | 设计文档判"不做" | **你已确认不做**，那 §九.2/9.4 的联动要删掉 |
| 6 | §六.2 Needs Your Attention 六类 | 只有 approval/question 两类有真实数据 | Conflict/Blocker/DeliverableReview 需要新建数据源，**放 Deferred** |

### 一个提示词没考虑到的根本问题

提示词假设"右侧栏宽度够放三个视图 + 多个区块"。

当前 `WORK_DOCK_WIDTH = 380px`。380px 放三视图 tab + 六类卡片 + Workstream 图，
**会非常挤**，而且提示词自己也要求"不能严重压缩办公室主体"（§十二.9）。

**这是需要第一性原理拆解的核心矛盾**：
- 办公室是视觉中心（占主体）
- 但 Mission Desk 需要足够空间才能承载信息

## 3. 第一性原理：用户打开 DshCockpit 是为了什么

提示词的检验问题（§十六）必须先回答，否则设计没有锚点。

### 用户已有的替代方案

| 需求 | 用 Harness 能做到吗 |
|---|---|
| 看 Agent 在干什么 | ✅ 原生 UI |
| 读对话 | ✅ 原生 UI |
| 改代码 | ✅ 原生 UI |
| 看 token 用量 | ✅ 原生 UI |

**所以"执行"和"观察"都不是 DshCockpit 的差异点。**

### 只有 DshCockpit 能做的事

推导：用户在长时间（多天、多个 session）的工作里，真正痛苦的时刻是：

1. **"上次做到哪了？"** —— Harness 的 session 是散的，没有项目概念
2. **"为什么当初这么决定的？"** —— 决策淹没在对话里
3. **"现在需要我做什么？"** —— 要翻多个 session 才知道
4. **"这东西真的完成了吗？"** —— Agent 说 completed 不等于产物可用
5. **"团队整体在往哪走？"** —— 单个 session 看不到全局

**这五件事全部是「跨 session 的时间维度」，而 Harness 是按 session 组织的。**

所以答案是：

> **DshCockpit 的价值是把"按 session 组织的执行"重组成"按项目组织的连续性"。**

这才是那个检验问题的答案，也应该是 Mission Desk 的设计锚点。

## 4. 由此推导：右栏该放什么，不该放什么

| 该放（只有我们能给） | 不该放（Harness 已经有） |
|---|---|
| 上次离开后发生了什么 | Agent 实时对话 |
| 为什么这么决定（决策+理由） | 工具调用日志 |
| 现在需要你做什么 | token 统计 |
| 产物凭什么可信 | 成员列表（已有悬停） |
| 团队往哪走（workstream 结构） | 单次任务执行进度 |

**"实时状态"应该极简**——一行"3 个 Agent 在跑"就够，详细去看 Harness。

## 5. 从外部调研学到的（LukeW 2025 agent management patterns）

调研了 [Agent Management Interface Patterns](https://www.lukew.com/ff/2106/agent-management-interface-patterns)，
它对四种模式的评价很关键：

| 模式 | LukeW 的评价 | 对我们的含义 |
|---|---|---|
| Kanban | 用户会期望"拖动卡片"→ 对 Agent 意味着什么不明确 | ❌ 不做 workstream 看板 |
| **Dashboard** | "**很难同时把握全局和细节**" | ❌ 不做指标面板 |
| **Inbox** | "**量一大就失控**"（所以在 Bench 迭代到这） | ⚠️ 只用于 Needs Your Attention |
| Task List | 结构化但可能牺牲简洁 | ✅ 用于 workstream 摘要 |

**这印证了提示词 §三 的判断**，也支持我的设计：
**右栏应该是"简报 + 收件箱"的混合，不是 Dashboard。**

## 6. 结论：MVP 应该是什么

基于以上，我建议的 MVP **比提示词小**，但**更能回答那个检验问题**：

### 必须做（Phase 1）

| 项 | 为什么 |
|---|---|
| **补 Finding / Assumption 实体** | Shared Context 的前提；也是"为什么这么决定"的载体 |
| **右栏 = Mission Desk（迁移，非新建）** | 复用已完成的 mission-desk.html |
| **Since You Were Away** | 直接命中"上次做到哪了" |
| **Needs Your Attention** | 直接命中"现在需要我做什么"（数据已有：approval/question） |
| **Mission Snapshot** | "团队往哪走" |
| **收起/展开** | 380px 不够，需要能临时扩宽 |

### 延后（Phase 2+）

| 项 | 原因 |
|---|---|
| Deliverables 视图 | 独立窗口已有产物区块，先复用 |
| 委托任务给 Lead | **无 API**，需先调研 |
| 跳转 Harness Session | 需先确认 URL 格式 |
| Conflict / Blocker 卡片 | 无数据源 |
| 会议桌/资料架联动 | 你已确认不做 |
| Quick Panel | 三形态可后续补 |

### 一个必须先解决的设计矛盾

**380px 装不下三视图 + 多区块。**

三个可选方案（需要拍板或我做 POC 验证）：

| 方案 | 做法 | 代价 |
|---|---|---|
| A | 侧栏可拖宽（380 → 640），默认 380 | 挤办公室，但用户可控 |
| B | 单视图纵向滚动（不分 tab），信息分层折叠 | 不需 tab，但深内容要"展开" |
| C | 侧栏保持 380 + "展开到全屏"按钮（work.html 已有 `expandWork`） | **已有基础设施** ✅ |

我倾向 **C**：`work.html` 里已有 `expandWork` 按钮的先例（compact 模式显示），
说明"侧栏 + 全屏切换"这个模式项目里已经用过。
