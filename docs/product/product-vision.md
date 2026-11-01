# 产品愿景：The Workspace for AI Teams

> 状态：**现行战略（2026-11-01 立项）** · 本文件是产品层的最高依据，其余产品文档从它派生。
> 上游输入：用户 2026-11-01 战略指令（重新定位、Harness-first 边界、第一性原理要求）。
> 修订纪律：变更定位必须新增 ADR，不得直接改本文件的结论段。

## 0. 一句话

**DshCockpit 是一个以虚拟办公室为核心交互方式的 AI 工作空间：它让用户组织、观察并参与一支 AI Agent 团队，把长期工作真正做完。**

英文定位：*An Opinionated Agent Workspace, Powered by a Living Virtual Office.*

> **⚠️ 战略范围守则（2026-11-01 审查强化）**
> 新架构**不得**把 DshCockpit 缩小为单纯的「跨 Session Mission Manager」。
> Mission Core 是**当前阶段的落地抓手**（因为它填补官方明确的空白），但**不是产品的全部**。
> 完整战略 = **Opinionated Agent Workspace**，长期由五个支柱构成：见 §2.3。

## 0.1 三层范围：North Star / MVP / Deferred

**这是本轮审查新增的关键澄清。** 之前把"当前要做的"与"战略全貌"混在一起，容易导致两种错误：
① 把 DshCockpit 缩小成 Mission 管理器；② 把长期愿景当成当前开发清单。

| 层级 | 定义 | 内容 | 时间尺度 |
|---|---|---|---|
| **North Star** | 产品的终极形态，**不排期、不作为验收标准** | Opinionated Agent Workspace 的五个支柱（§2.3） | 长期 |
| **MVP** | 证明"这个方向成立"的最小闭环 | P0 地基 + P1 Mission Core + P2 Mission Desk/Office（2 个物件）+ P3 一个 Capability Pack | 当前路线图 P0–P3 |
| **Deferred** | 有长期价值，但**明确不现在做** | Live2D 生产接入、LayerFS 生产集成、Knowledge Provider、多 Harness Adapter、Character Pack 市场、Community Hub、跨项目 Team | 触发条件满足时再启 |

**判定规则**：
- 任何"当前要做"的项目，必须能追溯到 MVP 的可验证目标；
- 任何 North Star 支柱，**不得**因为"MVP 没做"就被认为已放弃；
- 任何 Deferred 项，必须写明**重新评估的触发条件**（不是永久删除）。


## 1. 我们为什么必须重新定位

### 1.1 事实（可验证，不是判断）

| # | 事实 | 证据 |
|---|---|---|
| F1 | DeepSeek Harness **官方桌面客户端已存在并持续迭代**，当前 `0.2.1-rc.5` | `/Applications/DeepSeek Harness.app/.../dsh/package.json` → `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.5` |
| F2 | 官方桌面壳已经自带大量"壳级"能力：插件管理、插件市场、技能、调度、workspace、审批、提问、子代理、goal、jobs、session 搜索、自动审查 | asar 内 `dsh/node_modules/@deepseek-ai/` 实测 **308** 个包，含 `dsh-plugin-manager` / `dsh-plugin-market` / `dsh-skill` / `dsh-schedule` / `dsh-goal` / `dsh-jobs` / `dsh-workspace-changes` / `dsh-experimental-session-search` / `dsh-experimental-auto-review` 等 |
| F3 | 官方已提供 **Agent Teams**：隐式 root Team、具名 teammate、直接 inbox 消息、持久共享任务板（任务 DAG、CAS revision、writeScopes 重叠警告）、waitForChange、interrupt | `dsh-experimental-agent-team@0.2.1-rc.5` README（官方中文文档） |
| F4 | DshCockpit 的 `package.json` 仍锁 `runtimeVersion: 0.1.5-rc.2`，即落后官方约一个大版本 | `DshCockpit/package.json:5` |
| F5 | DshCockpit 已自研 Team Runtime v0（Job/Role/WorkerRun/Artifact，固定 researcher→reviewer 链）+ 执行端口 + dsh 后端 | `src/team/runtime/`（10 文件，约 190KB） |
| F6 | DshCockpit 已自研跨会话搜索、MCP 管理、插件市场、技能市场、模型管理、IM 通道、公网远程、Token/成本中心 | `src/session-search.js`, `src/mcp-*.js`, `src/plugin-flow.js`, `src/market.js`, `src/skills.js`, `src/models-manager.js`, `src/channels/`, `src/public-remote.js`, `src/cost.js` |
| F7 | DshCockpit 的虚拟办公室是**真实事件驱动**的独立资产：约 27k 行，有状态机、渲染器、角色 Pack、持久化、隐私脱敏、大量门禁测试 | `src/office/**`、`src/workbench/**`、`test/office-*.test.js`（约 60 个套件） |
| F8 | 官方 0.2.x 为"第三方壳托管 Web UI"提供了**明确扩展点**：shell-held carrier 可通过 `connection.rpc.open` 提供 Remote 流、通过 `fetchBundle()` 分派插件 bundle，无需打开 WebSocket | `dsh-client-connection` / `dsh-client-modules` README（官方中文文档） |

### 1.2 推论（这是定位变更的真正理由）

1. **继续做"Harness 桌面壳"是在和官方产品正面对撞，且必输**：F2 表明壳级能力（插件/技能/调度/模型/MCP/审批）官方已有且会继续补齐；我们每补一个，官方下一步就覆盖一个，投入无法沉淀。
2. **但 F3 与 F2 揭示了一个空档**：官方交付的是**能力与执行**，交付的不是**"一支团队在一个长期项目里如何持续工作"的体验**。Agent Teams 有了 roster/task board/消息，但它的呈现是 Web UI 的列表与面板；`dsh-goal` 有了同会话持久目标，但它是**会话级**的，不是**项目级**的。
3. **F7 是我们唯一不可被官方快速复制的资产**：一个有真实事件驱动、有角色、有空间、已被打磨过的虚拟办公室。它的价值不在"可爱"，而在**把多 Agent 的并行状态压缩成一个人能一眼读懂的空间隐喻**。
4. **F8 说明官方并没有打算独占外壳**：它主动为第三方壳提供了托管 Web UI 的扩展点。这意味着"我们保留自己的壳"在技术上是被支持的，问题只在于**我们的壳必须提供官方壳不提供的东西**。

### 1.3 结论

> **官方壳解决"我能用 Agent 干活"。DshCockpit 解决"我和一支 AI 团队一起，把一件长期的事做完"。**

## 2. 产品定义

### 2.1 是什么

一个 AI 工作空间，包含三个不可分割的部分：

| 部分 | 承担什么 | 一句话 |
|---|---|---|
| **Mission Core** | 长期工作的连续性 | 记住"我们为什么做这件事、已经定了什么、还差什么" |
| **Virtual Office** | 团队工作的可读性 | 让人一眼看懂"谁在做什么、卡在哪、需要我什么" |
| **Capability Platform** | 开箱即用的能力组合 | 让新手不用折腾 Memory/Context/Workspace/MCP 就能开始 |

### 2.2 不是什么（同等重要）

- **不是**另一个 Harness 桌面壳（官方已有，且更好）。
- **不是**另一个通用聊天客户端（官方 Web/Desktop 已覆盖）。
- **不是** Agent 框架 / 自研 Agent Loop / 通用 Harness。
- **不是**桌宠应用（鲸鱼娘是状态解释器，不是核心卖点）。
- **不是**多 Runtime 平台（当前只支持 DeepSeek Harness）。
- **不是**插件市场（官方已有 `dsh-plugin-market`；我们做的是**经过验证的组合**，不是"什么都能装"）。
- **不是**单纯的跨 Session Mission Manager（这是当前抓手，不是产品全貌 —— 见 §2.3）。

### 2.3 North Star：Opinionated Agent Workspace 的五个支柱

> **这一节是长期战略锚点。五个支柱都**不**因当前 MVP 未做而放弃；它们是判断"MVP 是否还在正确方向上"的罗盘。**

| # | 支柱 | 解决什么 | 当前状态 | 何时做 |
|---|---|---|---|---|
| **N1** | **Mission Core** | 跨 Session 的项目连续性与共识 | **MVP 重点**（P1） | P1 |
| **N2** | **Capability Orchestration** | 用户看到"能力"，看不到底层依赖复杂性 | 设计完成（`capability-platform.md`） | P3 起步 |
| **N3** | **Starter Kits** | 新手 5 分钟拿到真实产物 | 设计完成（`product-roadmap.md` P3） | P3 |
| **N4** | **Provider 层**（Memory / History / Workspace / Knowledge / Verification） | 能力可替换、可演进 | **仅 Verification 值得抽象**（其余等第二个实现） | 按需 |
| **N5** | **Virtual Office 作为空间化交互** | 多 Agent 并行状态的可读性 | **已实现核心**，交互物件待建 | P2 起步 |

**关键纪律（N2–N4 的解释）**：

| 支柱 | 现在做什么 | 现在**不**做什么 | 为什么 |
|---|---|---|---|
| N2 Capability Orchestration | 写清 Manifest 与 Pack 结构 | 不实现完整 Capability Platform | 没有用户验证前做平台是空转 |
| N3 Starter Kits | 写清设计与验收标准 | 不实现 | 依赖 P1 Mission 模板 |
| **N4 Provider 层** | **只抽象 VerificationProvider** | **不为 Memory/History/Workspace/Knowledge 造接口** | 官方栈已覆盖（`ADR-0005`）；只有一个实现时的抽象是负债（`product-principles.md` §3.4） |

**对 N4 的特别说明**（回应用户提到的五个 Provider）：

| Provider | 现在有实现吗 | 需要抽象吗 | 理由 |
|---|---|---|---|
| MemoryProvider | 官方 `dsh-goal` + `dsh-compaction`（Session 级） | ❌ 否 | 无第二个真实实现；Mission 的 Shared Context 是治理层不是存储层 |
| HistoryProvider | 官方 `dsh-session-query-sqlite`（当前 `openAt: never`） | ❌ 否 | 官方已覆盖，只需启用配置 |
| WorkspaceProvider | 官方 `dsh-workspace-changes` + `dsh-experimental-worktree` | ❌ 否 | 官方已覆盖 L0–L2 |
| KnowledgeProvider | **无**（WeKnora 为 Deferred） | ❌ 否 | 无真实用户需求证据 |
| **VerificationProvider** | **有**（`src/work/command-runner.js`） | ✅ **是** | 已有真实需求 + 天然多实现（shell / 测试框架 / 外部服务） |

**结论**：五个 Provider 是 North Star 的**完整图景**，但当前只对该抽象的那一个动手。
这是"有战略眼光但不过度设计"的平衡点。

## 3. 战略边界（硬约束）

### 3.1 Harness-first

```
DeepSeek Harness  owns execution
DshCockpit        owns experience, continuity, capability orchestration
```

具体含义：

| 维度 | 归属 | 说明 |
|---|---|---|
| Agent Loop | **Harness** | 我们不实现推理/工具循环 |
| Session / Turn / Tool 执行事实 | **Harness** | 我们只观察，不写入 |
| Agent Teams（roster / 消息 / 任务板） | **Harness**（0.2.x+） | 我们消费其状态，不复制一套 |
| Goal（同会话持久目标） | **Harness**（`dsh-goal`） | 我们**不重写** goal 状态机 |
| 文件变更捕获 | **Harness**（`dsh-workspace-changes`） | 我们**不重写** diff 捕获 |
| Provider / 模型 / Key | **Harness** | 我们只读状态、提供更好入口 |
| **Mission（项目级长期工作）** | **DshCockpit** | 跨 Session、跨 Team 的连续性 |
| **Shared Context（团队共识）** | **DshCockpit** | 决策/发现/假设/待答问题 |
| **Office 呈现状态** | **DshCockpit**（派生） | 只从真实事件派生，**不作为执行事实** |
| **Capability 组合与验证** | **DshCockpit** | "哪几个插件组合起来真的能用" |

**反例（明确禁止）**：
- ❌ 在 DshCockpit 里再实现一遍 goal 的 phase 状态机。
- ❌ 在 DshCockpit 里再维护一张"task 表"并与官方 Team 任务板并行写入。
- ❌ 把 Office 的动画状态当作"Agent 正在工作"的证据。

### 3.2 单一事实源矩阵

任何状态**有且只有一个写入者**。跨层只允许"读取 + 派生"。

| 状态 | 唯一写入者 | DshCockpit 的权限 |
|---|---|---|
| Session / Turn / Tool 执行 | Harness Session Log | 只读 |
| Agent 运行状态（running/inactive） | Harness | 只读 |
| Team roster / 任务板 | Harness Agent Teams | 只读 + 通过官方 API 发命令 |
| Goal phase / rounds | Harness `dsh-goal` | 只读 + 调用官方 verbs |
| 文件变更 | Harness `dsh-workspace-changes` | 只读 |
| Approval / Question 结果 | Harness（通道） | 只转发用户决定 |
| **Mission** | DshCockpit | 唯一作者 |
| **Shared Context（Decision/Finding/…）** | DshCockpit | 唯一作者 |
| **Capability 安装状态** | DshCockpit | 唯一作者 |
| Office 动画/位置/活动 | DshCockpit（派生） | 唯一作者，但**必须可追溯到真实事件** |

**判定规则**：如果某状态在 Harness 有写入者，DshCockpit 就**绝不**成为第二写入者 —— 只能做"投影"或"命令转发"。

### 3.3 演进阶段边界

| 阶段 | Harness 支持 | 允许的 Harness-agnostic 设计 |
|---|---|---|
| **现在** | 仅 DeepSeek Harness | 不设计第二个 Adapter；接口只保留"未来可能要"的最小缝 |
| **之后** | 出现真实需求时 | 才引入 Adapter 抽象（见 `docs/architecture/runtime-bridge.md`） |

**纪律**：只有一个实现时，接口保持**具体而简单**；出现第二个实现时再抽象。禁止"为了扩展性先造抽象层"。

## 4. 用户与场景

### 4.1 用户角色

| 角色 | 特征 | 他们真正的问题 |
|---|---|---|
| **新手探索者**（主要目标） | 听过 Agent，没搭过环境；怕折腾 | "我想让 AI 帮我把事做完，但我不想先学 20 个概念" |
| **独立开发者/研究者** | 有真实项目，反复用 Agent | "同一个项目我要开很多次会话，每次都要重新交代背景" |
| **AI 团队重度用户** | 已在用 Team/多 Agent | "我看不出团队到底在干什么，也不知道该在哪干预" |
| **高级玩家** | 要换 provider/插件/工作流 | "别替我决定，但请把选项做好" |

### 4.2 三个核心场景（按优先级）

**场景 A：第一次就把事做完（5 分钟硬指标）**
> 用户下载 → 选一个 Starter Kit（如"帮我做一份调研报告"）→ 一句话描述任务 → 5 分钟内拿到**真实可用的产物文件**（不是一段聊天记录）→ 打开就能用。

**场景 B：一个项目持续两周**
> 用户有一个真实项目。每天打开 DshCockpit，看到 Mission 的当前状态、上次停在哪、哪些决策已定、哪些问题还没答。新增工作接续在同一个 Mission 上，而不是从零开始交代背景。

**场景 C：团队卡住了，我需要介入**
> 办公室显示某个成员在 attention 状态。用户点开工位 → 看到"它在等我决定 X"→ 就地做决定 → 团队继续。全过程不需要读日志或翻 JSON。

### 4.3 反场景（明确不做）

- ❌ 用户想在这里"聊天" → 引导到 Harness 官方 UI，我们不做第二聊天窗口。
- ❌ 用户想在这里"写代码" → 我们提供 Mission/Office/产物视图，编辑器交给系统默认应用或官方 UI。
- ❌ 用户想在这里"管理 20 个 provider" → 官方已有；我们只做"Recommended"组合。

## 5. 价值主张（可验证的承诺）

我们不承诺"功能更多"。我们承诺四件**官方不承诺**的事：

| # | 承诺 | 如何验证 |
|---|---|---|
| V1 | **30 秒内理解团队现状** | 新用户打开应用，不读文档，能说出"谁在做什么/谁需要我" |
| V2 | **跨会话不丢项目上下文** | 关闭应用一周后重开，Mission 的状态/决策/产物仍完整可用 |
| V3 | **产物是真实文件，不是聊天记录** | 每个完成的 Mission 都有落在用户工作区里的可打开文件 + 可追溯来源 |
| V4 | **新手不用懂底层设施** | Starter Kit 安装后直接可用，用户不需要知道 LayerFS/MCP/RAG 是什么 |

## 6. 与旧定位的关系

| 旧资产 | 新定位下的处置 |
|---|---|
| Runtime 安装/更新/回滚/看门狗 | **保留**（Harness-first 的必需底座，官方壳之外的用户仍需要可靠的 runtime 管理） |
| Token/成本/余额中心 | **保留**（真实用户价值，官方未提供同等深度） |
| 虚拟办公室 | **保留并升级为主交互面**（核心差异化） |
| Team Runtime v0 | **重新评估**（官方已有 Agent Teams；见 ADR-0002） |
| 自研 session search | **重新评估**（官方已有 `dsh-experimental-session-search`） |
| 自研插件/技能市场 | **降级/让位**（官方已有 market；我们改为做"验证过的组合"） |
| IM 通道 / 公网远程 | **保留**（真实差异化，官方未覆盖） |
| MCP 管理 | **保留但简化**（官方有 mcp-client；我们做更好的 UI 与验证） |

## 7. 成功判据

**90 天判据**（可测量）：
1. 新用户首次运行到拿到真实产物 < 5 分钟（P50）。
2. 存在 ≥ 1 个真实的、跨 ≥ 7 天、跨 ≥ 5 次会话的 Mission 被用户实际使用。
3. 办公室中任意一个"可交互物件"都能追溯到真实数据源（零装饰性假功能）。
4. 至少 1 个 Capability Pack 经过完整"安装→使用→卸载"验证。

**失败信号**（出现即需重新审视定位）：
- 用户主要用 DshCockpit 来看 Token 数字和动画，不用它工作。
- 我们的功能清单变成官方 changelog 的子集。
- Mission 数据模型与 Harness goal/team 语义产生持续冲突。

## 8. 相关文档

- 工程原则：`docs/product/product-principles.md`
- 路线图：`docs/product/product-roadmap.md`
- 用户旅程：`docs/product/user-journeys.md`
- 领域模型：`docs/architecture/domain-model.md`
- Runtime Bridge：`docs/architecture/runtime-bridge.md`
- 关键决策：`docs/adr/`（ADR-0001 起）
