# Team Runtime v0 — Agent Team / 多代理团队 开源调研报告（第二版）

> **修订说明**：第一版（同日早先）把检索重心错放在"DshCockpit 上游与用户历史里提到的项目"（DeepSeek Harness / ZCode / Autobyteus / PenguinHarness / DIM），方向偏离了本任务真正需要的**Agent Team（代理团队）**生态。本版重做：以 **Agent Team / 多代理团队 / 团队编排 / bot 平台** 为主线，主动检索高 Star 与高架构价值项目，并补充**博客 / 工程文章 / 教程**（用户明确要求的一类证据）。第一版中关于上游 Harness 的部分仍然有效，但只服务 office 内核，见附录 A。
>
> 检索日期：**2026-10-18**。Star / license / 语言 / 最近 push 均为当日通过 GitHub REST API `api.github.com/repos/<owner>/<repo>` 实测；定性结论来自官方文档、README、源码文件与工程文章的**原文抓取**，不是搜索摘要。

---

## 0. 检索范围与方法

**工具**：`deepseek-search`（Search + Fetch 原文）+ GitHub REST API（客观元数据）。二者交叉验证。

**检索主线**（每条都实际执行）：
`agent team`、`multi-agent team framework`、`AI agent crew/team roles`、`multi-agent orchestration`、`agent handoff`、`subordinate agents`、`bot platform`、`agent workflow platform`、`agent team tutorial / best practices / production`。

**实测元数据的仓库总数**：两轮调研合计 **58 个**仓库成功取得元数据（去重后；另有 3 次请求失败/未找到：`motia-dev/motia` 不存在、`microsoft/semantic-kernel` 与 `TransformerOptimus/SuperAGI` 的 API 请求 SSL 中断，均未引用其数值）。其中**满足本任务主线筛选后进入短名单 20 项**（§1），深度对象 6 个（§2），博客/文章/教程 5 篇（§3）。
> 口径说明：**58 = 总检索并成功取数的仓库数**；**20 = 满足"Agent Team / 多代理团队 / bot 平台"主线筛选后的短名单数**。两个数字含义不同，此前版本中"40+/30+"的混用已修正。

**诚实声明**：
- 深度对象读了官方文档/源码/文章**原文**（含 proto 枚举、Go 类型定义、提示词文件、工程文摘要）。
- 短名单其余项只做定位性判断（标注「浅」），不作为设计依据。
- 未能证实存在的项目明确标注，不拿不相关项目凑数。

---

## 1. 候选短名单（20 项，元数据实测于 2026-10-18）

### 1.1 Agent Team / 多代理团队（本次主线）

| # | 项目 | 仓库 | Stars | 语言 | License | 最近 push | 深度 |
|---|---|---|---|---|---|---|---|
| 1 | **CrewAI** | crewAIInc/crewAI | 59,826 | Python | MIT | 2026-10-18 | **深** |
| 2 | **MetaGPT** | FoundationAgents/MetaGPT | 70,905 | Python | MIT | 2026-01-21 | **深**（活跃度落后） |
| 3 | **ChatDev** | OpenBMB/ChatDev | 34,545 | Python | Apache-2.0 | 2026-10-16 | **深** |
| 4 | **AgentScope** | agentscope-ai/agentscope | 33,445 | Python | Apache-2.0 | 2026-10-15 | **深** |
| 5 | **OpenAI Agents SDK** | openai/openai-agents-python | 30,111 | Python | MIT | 2026-10-17 | 浅（handoff 语义） |
| 6 | **Google ADK** | google/adk-python | 21,899 | Python | Apache-2.0 | 2026-10-18 | 浅 |
| 7 | **agent-zero** | agent0ai/agent-zero | 19,503 | Python | NOASSERTION | 2026-10-14 | **深** |
| 8 | **CAMEL** | camel-ai/camel | 17,925 | Python | Apache-2.0 | 2026-10-12 | 浅 |
| 9 | **Microsoft Agent Framework** | microsoft/agent-framework | 14,188 | Python | MIT | 2026-10-18 | 浅 |
| 10 | **Strands Agents** | strands-agents/harness-sdk | 8,855 | Python | Apache-2.0 | 2026-10-17 | 浅 |
| 11 | OpenManus | FoundationAgents/OpenManus | 58,708 | Python | MIT | 2026-09-30 | 浅 |
| 12 | AgentVerse | OpenBMB/AgentVerse | 5,158 | JavaScript | Apache-2.0 | **2024-09-09** | 浅（已停滞） |
| 13 | swarms | kyegomez/swarms | 7,276 | Python | Apache-2.0 | 2026-10-18 | 浅 |

### 1.2 团队级工作平台 / bot（用户提到的 bot 方向）

| # | 项目 | 仓库 | Stars | 语言 | License | 最近 push | 深度 |
|---|---|---|---|---|---|---|---|
| 14 | **n8n** | n8n-io/n8n | **207,875** | TypeScript | NOASSERTION | 2026-10-18 | 浅 |
| 15 | **Dify** | langgenius/dify | 158,764 | Python | NOASSERTION | 2026-10-18 | 浅 |
| 16 | **Langflow** | langflow-ai/langflow | 155,792 | Python | MIT | 2026-10-18 | 浅 |
| 17 | **Suna** | kortix-ai/suna | 20,280 | TypeScript | NOASSERTION | 2026-10-18 | 浅 |
| 18 | **Botpress** | botpress/botpress | 14,956 | TypeScript | MIT | 2026-10-13 | 浅 |
| 19 | **Rasa** | RasaHQ/rasa | 21,353 | Python | Apache-2.0 | 2026-07-24 | 浅 |
| 20 | Flowise | FlowiseAI/Flowise | 55,511 | TypeScript | NOASSERTION | 2026-08-13 | 浅 |

**其他实测（未入短名单，定位重叠或价值更低）**：`cline/cline` 70,494（编码 agent）；`openinterpreter/openinterpreter` 68,601；`continuedev/continue` 36,240；`reworkd/AgentGPT` 36,282（push 2025-04-29，停滞）；`huggingface/smolagents` 29,908；`e2b-dev/awesome-ai-agents` 30,494（清单）；`RooCodeInc/Roo-Code` 24,272；`pydantic/pydantic-ai` 20,700；`livekit/agents` 14,811；`OpenBMB/XAgent` 8,549（push 2026-07-31）；`microsoft/semantic-kernel`（本次 API 请求 SSL 中断，未取得数值，故不引用其数字）。

**关于 star 的立场**：star 高只说明**关注度**，不说明设计正确。`n8n`/`Dify`/`Langflow` 的 star 数是本报告最高的一档，但它们是**可视化工作流平台**，其"团队"是**节点图**而不是"有角色、有依赖、有产物交接的代理团队"，因此只作为"边界参考"（见 §4.3），不进入设计依据。

---

## 2. 深度对象（6 个）

### 2.1 CrewAI（59,826★ / Python / MIT / 活跃）——"Crew = 团队"的规范模型

- **核心问题与用户**：把一组有角色/目标的 agent 编成"团队"（Crew）协作完成一组任务（Task）。用户是要快速搭多角色流水线的应用开发者。
- **数据模型**：`Crew(agents, tasks, process)` + `Agent(role, goal, backstory)` + `Task(description, expected_output, context)`。**Crew 就是团队实体**；Task 的 `context` 参数**显式指名"哪些任务的输出作为本任务的上下文"**。
- **执行策略**（官方 Processes 文档原文）：
  - `Process.sequential`：按任务列表顺序执行，**"the output of one task serving as context for the next"**；用 `context` 精确指定上下文来源。
  - `Process.hierarchical`：**"A manager language model (manager_llm) or a custom manager agent must be specified"**，由 manager **规划、委派、校验**，**"Tasks are not pre-assigned"**。
- **可借鉴**：①`Task.context` 的**显式生产者绑定** —— 与本契约的 `ArtifactRef.producerRunId` 同构；②`Process.sequential` 的"上游输出即下游上下文"正是 v0 的固定闭环；③**交接契约写在配置里**。
- **不采用**：`Process.hierarchical` 需要 manager LLM 才能工作 —— 本任务明令禁止 LLM Planner，因此 v0 的 plan 是常量，且**拒绝**任何其它形状（`PLAN_UNSUPPORTED`）。
- **风险**：MIT，无传染风险。不引入依赖。

### 2.2 MetaGPT（70,905★ / Python / MIT / push 2026-01-21）——"结构化产物"而非对话

- **核心问题与用户**：用 SOP（标准作业程序）把软件公司的角色（产品经理/架构师/项目经理/工程师/QA）串起来，把一句话需求变成可交付代码。用户是研究者与原型开发者。
- **通信模型（关键，来自 IBM 权威条目原文）**：**"MetaGPT differs from most LLM-based multi-agent frameworks because it does NOT use unrestricted natural language as the communication interface, but proposes structured communication."** 例：ChatDev 的 agent 靠**对话**沟通，而 MetaGPT 的 agent 靠**结构化产物（文档、图表）**沟通。
- **发布/订阅池**：全局 message pool，agent 发布结构化消息、透明读取他人消息 —— **"eliminating the need to ask other agents and wait for their responses"**（消除互相等待）。
- **角色流水线与产物交接**：PM 产出 PRD → 交给架构师 → 架构师产出技术规格/接口定义 → 交给项目经理 → 拆任务给工程师。**每一跳都是"文档交接"，不是聊天。**
- **可借鉴**：①**用结构化产物而非对话做跨角色通道**（直接印证本契约"artifact 是唯一跨角色通道、不采用消息传递"）；②消除互相等待（对应我们的"依赖满足即放行"，而不是"互相询问"）；③SOP = 常量流程（对应 `TEAM_V0_PLAN`）。
- **不采用**：其"项目经理把项目拆成任务列表"是**动态拆解**，本任务禁止。
- **风险**：MIT。**活跃度明显落后**（最近 push 2026-01-21，≈9 个月前），故只取其通信模型，不作为活跃生态依赖。

### 2.3 ChatDev（34,545★ / Python / Apache-2.0 / 活跃）——角色成对 + 阶段链

- **核心问题与用户**：让"虚拟软件公司"按阶段（设计→编码→测试→文档）协作产出软件。
- **数据模型**：**chat chain** —— 把开发过程切成阶段，每个阶段由**一对角色**（如 CTO/程序员、评审/测试）按"指令-反馈"对话推进；阶段之间传递**产物**。
- **可借鉴**：①**"评审"是独立角色**（对应 v0 的 reviewer）；②阶段之间的产物交接；③"communicative dehallucination"（让另一方在交接时检查上游产物）—— 这解释了为什么"评审角色"在团队里是刚需，而不是可选装饰。
- **不采用**：其阶段推进靠**对话**（ChatDev 是 MetaGPT 明确点出的对话式反例）；对话式通信在规模上更难控（见 §3 综述结论 4）。
- **风险**：Apache-2.0。

### 2.4 AgentScope（33,445★ / Python / Apache-2.0 / 活跃）——团队/工作流原语 + 状态管理

- **核心问题与用户**：面向多代理应用的**平台**（消息传递、团队编排原语、状态与持久化、可视化）。用户是要做多代理产品的研究/工程团队。
- **数据模型**：`Agent` + 团队/工作流原语（顺序、扇出、消息中心）+ 显式的状态管理服务。
- **可借鉴**：①团队编排原语应当**显式且有限**（顺序/扇出/条件），而不是任意图 —— 与 v0"只实现一条固定链"一致；②状态管理是独立关注点（对应我们的"state = fold(facts)"）。
- **风险**：Apache-2.0。平台体量与我们的单机无 UI 目标不匹配。

### 2.5 agent-zero（19,503★ / Python / NOASSERTION / 活跃）——上级/下级委派与"引用而非复制"

- **核心问题与用户**：一个有"上级代理 + 下级代理"层级的通用代理平台（本地运行、Web UI）。用户是自托管玩家与开发者。
- **委派机制（源码提示词文件原文 `agent.system.tool.call_sub.md`）**：工具 `call_subordinate`，参数 `message`（定义 role/goal/具体任务）、可选 `profile`（下级角色档案，必须精确匹配）、`reset`（首条消息或换档案时用 true，继续用 false）。返回后 **"answer from its result directly… do not repeat the same solving work"**。
- **关键一句**：**"reuse long subordinate output with `§§include(path)` instead of rewriting it"** —— **长产物用引用而不是复制**。
- **可借鉴**：①`profile` = 角色档案（对应 Role 枚举 + 未来的 profile）；②**引用而非复制**（与 Anthropic 的 filesystem-reference 同构，见 §3.1）；③"下级返回后不要重做同样的工作"（对应我们的"终态即收敛，不重跑"）。
- **不采用**：其层级由**上级 agent 自行决定**何时 spawn（LLM 决策），本任务禁止。
- **风险**：**NOASSERTION（无标准 license 文件）** —— 不可复制其代码，只取设计思想。

### 2.6 OpenAI Agents SDK（30,111★ / MIT）+ Google ADK（21,899★ / Apache-2.0）（浅，仅取 handoff 语义）

- 两者都把 **handoff（把控制权连同上下文交给另一个 agent）** 做成一等原语，且都把**会话/状态**与**代理定义**分离；ADK 提供显式的**父子代理层级**。
- **可借鉴**：handoff 是**显式声明**的（不是隐式约定），且**上下文随交接传递**。
- **不采用**：它们的 handoff 常常是"控制权转移 + 对话继续"，仍属对话式；我们的跨角色通道只有 artifact。

---

## 3. 博客 / 工程文章 / 教程（本次新增的一类证据）

> 这一类是用户明确要求补的。以下都是**一手工程文或权威条目**，不是二手摘要。

### 3.1 Anthropic《How we built our multi-agent research system》（2025-06-13，orchestrator-worker 的生产参考）

原文要点（含直接引语）：
- **架构**：lead（orchestrator）制定策略 → 派生并行 subagent 研究不同侧面 → 汇总。
- **收益与代价**：在广度优先研究任务上比单代理 **+90.2%**；**token 消耗约为单代理对话的 15 倍**，且 token 用量解释了约 80% 的方差 → **"only worth it for high-value parallelizable work"**。
- **长产物用引用而不是复制（最关键的一条）**：**"Subagents call tools to store their work in external systems, then pass lightweight references back to the coordinator. This prevents information loss during multi-stage processing and reduces token overhead from copying large outputs through conversation history."**
- **effort scaling 必须写死**：**"Simple fact-finding requires just 1 agent with 3-10 tool calls… complex research might use more than 10 subagents"** —— 预算写在提示词/配置里，**"not left to agent discretion"**。
- **同步是当前的瓶颈**：**"our lead agents execute subagents synchronously, waiting for each set of subagents to complete before proceeding. This simplifies coordination, but creates bottlenecks."** 异步是**已识别但未实现**的下一步。
- **子代理自评估**：**"a self-loop within each subagent — the subagent evaluates its own progress before proceeding, without waiting for the lead agent to review"**（**不阻塞**）。

### 3.2 多代理架构综述（含 MacNet / ChatDev / MetaGPT / OpenClaw 的横向比较，authority=3）

明确写出四条设计教训（原文）：
1. **"Structure matters more than size. A tight 5-role SOP team beats a 50-agent unstructured group."**
2. **"Handoff contracts in writing. Artifacts passed between roles follow a schema."**
3. **"Communicative dehallucination is a cheap, load-bearing pattern."**
4. **"DAGs scale further than chat. When the flow is knowable, encode it."**

以及对 MacNet（ChatDev 的 DAG 扩展，arXiv:2406.07155）的描述：**"Each DAG node is a role specialization; edges encode handoff contracts. The scale is possible because routing is explicit and offline-computable."**

### 3.3 实践者团队模板（CervellaSwarm agent templates，PyPI，authority=4）

一个"打了 17 个 agent、数百次真实开发会话"的团队模板包，给出**角色分类法**与**权限差异**：

| 角色 | 职责 | 能否写代码 |
|---|---|---|
| Coordinator | 路由任务、委派给专家、汇总结果 | 否（只委派） |
| Architect | 规划复杂改动、产出结构化计划 | 否（只读） |
| **Quality Gate** | 审查产出、执行标准、**批准或拒绝** | 是（修） |
| Worker | 在特定领域实现（7 种专业） | 是 |

**可借鉴**：①**角色带权限差异**（只读/可写）—— 与本契约的 `produces`/`consumes` 权限不对称同构；②**"批准或拒绝"是一个独立角色**（= 我们的 reviewer + `attention` 闸）。

### 3.4 MetaGPT 的 SOP 论述（IBM 权威条目）

见 §2.2：**结构化通信取代自由对话** + 发布/订阅消息池消除互相等待。

### 3.5 ChatDev 的 communicative dehallucination（arXiv:2307.07924）

阶段交接时由另一方检查上游产物，显著降低幻觉传播 —— 这是"团队里必须有评审角色"的实证依据。

---

## 4. 比较矩阵

| 维度 | CrewAI | MetaGPT | ChatDev | AgentScope | agent-zero | Anthropic(文) | 综述/模板 | 对 Team v0 的结论 |
|---|---|---|---|---|---|---|---|---|
| 团队实体 | `Crew` | 虚拟公司 | chat chain | 团队原语 | 上级+下级 | orchestrator-worker | 团队/角色表 | **Job（团队实例）成立** |
| 角色 | `Agent(role,goal)` | 固定 SOP 角色 | 成对角色 | `Agent` | `profile` | lead + workers | Coordinator/Architect/QualityGate/Worker | **Role 枚举成立** |
| 跨角色通道 | Task.context（**显式**） | **结构化文档** | 对话 | 消息 | **引用(§§include)** | **轻量引用** | **schema 化产物** | **ArtifactRef = 引用 + 生产者绑定（4 处独立印证）** |
| 流程 | sequential / hierarchical | 固定 SOP | 固定阶段 | 顺序/扇出 | LLM 决定 | 固定两阶段 | **"flow 可知就编码成 DAG"** | **常量 plan + 显式 dependsOn** |
| 规划 | manager_llm（**需 LLM**） | PM 动态拆解 | 固定 | — | 上级自决 | lead 自决 | — | **不采用（本任务禁止 LLM Planner）** |
| 产物内容 | 任务输出文本 | 文档/图表 | 对话+文件 | 消息 | 文件 | 文件（外部系统） | schema | **只传引用，不传内容** |
| 审批/闸 | human input | — | 评审角色 | — | — | — | Quality Gate 批准/拒绝 | **attention（阻塞审批闸）** |
| 自评估 vs 阻塞 | — | — | — | — | 下级自评 | **self-loop（不阻塞）** | — | **v0 用阻塞闸；与 self-loop 明确区分** |
| 同步/异步 | 顺序 | 顺序 | 顺序 | 支持扇出 | 层级 | **同步（瓶颈已知）** | — | **v0 同步；异步列入不承诺** |
| 成本 | — | — | — | — | — | **15× tokens** | 结构 > 规模 | **预算写成常量** |
| Team↔UI | 解耦 | 解耦 | 解耦 | 平台 | Web UI | 解耦 | — | **Team Runtime 无 UI** |

### 4.1 直接借鉴的思想
1. **跨角色只走"带生产者绑定的轻量产物引用"**（CrewAI `Task.context` + Anthropic 的 lightweight references + agent-zero 的 `§§include` + MetaGPT 的结构化文档 —— **四处独立印证**）。
2. **流程可知就编码成常量**（综述教训 4 + MacNet 的"explicit and offline-computable" + CrewAI sequential）。
3. **交接契约写成 schema**（综述教训 2）→ 本契约把 `plan.produces/consumes` 当交接 schema 并**双向强制**。
4. **评审/质量闸是独立角色**（ChatDev 评审角色 + CervellaSwarm Quality Gate + communicative dehallucination）。
5. **effort budget 写死**（Anthropic）→ `TEAM_V0_BUDGET` 常量 + plan 形状断言。
6. **结构 > 规模**（综述教训 1）→ v0 只做 2 角色 1 边。
7. **同步优先**（Anthropic 明确"同步简化协调但有瓶颈"，异步未实现）→ v0 同步 + 异步进不承诺清单。
8. **角色权限不对称**（CervellaSwarm 只读/可写）→ `produces`/`consumes` 即权限声明。

### 4.2 需要改造的思想
1. **CrewAI `Task.context` 的粒度**：它指名"哪个 task 的输出"；我们 v0 用 role→role + kind→kind（更粗但无歧义，因为每角色一 run、每产物一槽位）。v1 若扇出需回到具体 artifactId 绑定。
2. **Anthropic 的"子代理自评估"**：不阻塞；我们的 `attention` 是阻塞审批闸。保留两者语义差异并显式文档化，防止第二阶段混淆。
3. **MetaGPT 的消息池**：我们**不引入**共享消息池（会带进内容），只用"依赖满足即放行"替代"互相询问"。

### 4.3 不采用的思想
1. **LLM Planner / manager agent / 动态拆解**（CrewAI hierarchical、MetaGPT PM 拆任务、agent-zero 自决 spawn）—— 本任务明令禁止。
2. **对话式 handoff**（ChatDev 式、AutoGen 式）—— 综述结论 4 明确"chat 不如 DAG 可扩展"，且对话内容会击穿隐私边界。
3. **共享消息池 / 上下文共享**（MetaGPT）—— 同上。
4. **可视化节点图即"团队"**（n8n / Dify / Langflow / Flowise）—— 它们是工作流编排器，"团队"是节点图，没有角色/产物交接/终态证据语义；只在需要"给人看的编排 UI"时才有参考价值，而本任务不做 UI。
5. **平台化基础设施**（AgentScope 平台、Dify 的 LLMOps、n8n 的集成生态）—— 与单机 Electron 壳不匹配。

---

## 5. 与当前仓库的对照（已有 / 缺失 / 冲突）

| 调研做法 | 现有实现 | 判定 |
|---|---|---|
| 团队实体 + 角色 + 依赖 | 无（office 只有座位/绑定/单 FIFO） | **缺失 → 本阶段补齐** |
| 带生产者绑定的产物引用 | 无 | **缺失 → `ArtifactRef`** |
| 交接契约双向强制 | 无 | **缺失 → 本阶段补上（含完整性方向）** |
| 有界账本 / 预算 | adapter dedupe 4096 / buffer 64 / wiring ledger 256 / diagnostics ring 100 | **已有纪律 → 复用到 Team** |
| 显式终态证据、请求≠终态、单一终态 | `employee-registry` 的 `TERMINAL_STOP_REASONS` / `NON_TERMINAL_EVIDENCE` / `verifyRunId`；evidence 单前缀 | **已有 → Team 同构复用** |
| 事实身份（session/seq/eventId） | adapter 的 canonical envelope + Phase B 的 identity 关联 | **已有 → Team 复用同一纪律** |
| 状态 = 事实折叠 | `state-reducer` 纯函数 + Team 的 `fold` | **已有** |
| 审批闸 | office `pending` / `answerRequest` / `approval-risk` | **部分已有 → Team 的 attention 独立语义** |
| Team↔UI 解耦 | `render/**` 与 `office-page.js` 只消费快照（门禁强制） | **已有范式 → Team 同样无 UI** |

**与隐私/事实权威边界冲突、必须拒绝的**：①artifact 带内容或路径（Anthropic/REAPI 存文件、CrewAI 传任务文本）→ 我们只传引用；②对话/消息池（ChatDev/MetaGPT）→ 正文会进事实层；③把 Team 状态写进 office 的 `runtime` 枚举（本任务禁止）。

**命名冲突（已在契约 §1.1 列出）**：①Harness 已占用 `team/*` 事件域 → DshCockpit 的 Team 事实用 `job/*`、`run/*`、`artifact/*`；②Role（任务角色）vs Seat（办公室座位）显式区分；③`src/team/` 原本不存在，可安全新建。

---

## 6. 对 `Job / WorkerRun / ArtifactRef` 的结论（是否调整设计）

**结论：骨架保留，新增两处必要加固（均由本次调研直接触发）。**

保留的依据：`Job` ≈ CrewAI `Crew` / Anthropic 的一次编排；`WorkerRun` ≈ CrewAI `Task`（一次执行）/ agent-zero 的一次 subordinate 调用；`ArtifactRef` ≈ CrewAI `Task.context` 指向的产物 / MetaGPT 的文档 / Anthropic 的 lightweight reference。

**加固 1（来自综述教训 2"handoff contracts in writing"）：交接契约双向强制。**
原实现只校验"给的产物都在允许范围内"（生产者归属），**没校验"该消费的都给全了"** —— 于是"依赖已满足"可以靠只消费一部分来伪造。现已补上方向二：plan 声明的每个 `consumes` kind 必须真的被消费，否则 `HANDOFF_INCOMPLETE`。

**加固 2（来自 Anthropic 的 effort scaling + 15× 成本 + 综述"结构>规模"）：effort budget 写成常量。**
新增 `TEAM_V0_BUDGET = { maxRuns: 2, maxArtifacts: 2, maxFacts: 4096 }`，并由测试断言它与 plan 形状一致 —— **plan 变宽而不改预算会让测试失败**。

**明确不做的调整**：不引入 DAG/Graph 类型（v0 一条边，`dependsOn` 数组足够）；不引入共享消息池；不引入内容寻址 CAS（只借用"引用带生产者 + 摘要形状"）；不引入 retry（`attempt` 保留恒为 1，并有测试钉住）。

---

## 7. 风险与结论

**结论**：Team v0 的契约应采用 **"常量 plan（= handoff schema）+ 显式 dependsOn + 带生产者绑定的轻量产物引用 + 阻塞式审批闸 + 显式终态证据 + 有界预算"**。这一组合的每一部分都能在**至少两个独立来源**里找到实证（CrewAI / MetaGPT / ChatDev / Anthropic / agent-zero / 综述 / 实践模板），且**不需要引入任何外部依赖、服务端、CAS、消息池或 LLM**。

**License / 依赖 / 平台风险**：深度对象为 MIT / Apache-2.0（agent-zero 例外，**NOASSERTION，已排除复制代码**）；平台级项目（n8n/Dify 等）为 NOASSERTION 或商业条款，**均不采用**。本报告只取架构原则，**不复制代码、不引入依赖**，因此无 license 传染与平台绑定风险。

**社区与维护风险**：深度对象中 MetaGPT 活跃度落后（≈9 个月）、AgentVerse 已停滞（2024-09）——均已标注，只取其被多方复述的设计思想。主线项目（CrewAI / ChatDev / AgentScope / agent-zero / Anthropic 文）均活跃。

---

## 附录 A：第一版中仍然有效的部分（上游 Harness）

第一版关于 **DeepSeek Harness**（252,672★ / MIT / 活跃）的结论对本任务的 **office 内核**仍然成立、且已被采纳：其架构决策记录明确"**session/* 是 durable、可重放的事实日志**；`agent/*` 是 live 信号；一个事实只有一个真相来源（边界镜像事件已删除）"。这正是本仓库 Phase B（event identity 关联）要消灭"位置性关联"的依据。但它服务的是 **office 内核**，不是 Team 团队模型，故本版把它移到附录。

第一版对 AutoByteus（1★/停滞/无 license）、PenguinHarness（方向不同）、ZCode（名称歧义）、DIM（未能证实）的核实结论不变：**不作为设计依据**。这些是"用户历史里提到的项目"，不是本任务的调研目标。

---

## 8. Sources（一手来源索引）

> 检索日期统一为 **2026-10-18**。Star / license / 语言 / 最近 push 的获取方式：`GET https://api.github.com/repos/<owner>/<repo>`（公开 REST API，未使用 token），读取字段 `stargazers_count` / `license.spdx_id` / `language` / `pushed_at`。定性内容均通过 `deepseek-search` 的 Search/Fetch 取得**原文**（下表标注 URL）。凡镜像/非稳定链接均已注明。

### 8.1 深度对象（6）

**CrewAI** — 59,826★ / Python / MIT / push 2026-10-18
- 仓库：https://github.com/crewAIInc/crewAI
- 官方文档（Processes，本文引用 sequential / hierarchical 原文）：https://docs.crewai.com/v1.15.27/en/concepts/processes
- 引用要点：`Process.sequential` 的"output of one task serving as context for the next"、`Task.context` 显式上下文来源、`Process.hierarchical` **必须**提供 `manager_llm`/`manager_agent`

**MetaGPT** — 70,905★ / Python / MIT / push 2026-01-21（活跃度落后，已标注）
- 仓库：https://github.com/FoundationAgents/MetaGPT （旧 owner `geekan/MetaGPT` 重定向到同一仓库）
- 权威条目（结构化通信 + 发布/订阅池 + SOP 流水线原文）：https://www.ibm.com/think/topics/metagpt （实际抓取的是同一内容的阿拉伯语 locale 路径 `https://www.ibm.com/sa-ar/think/topics/metagpt`，正文相同）
- 论文：MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework（arXiv:2308.00352）

**ChatDev** — 34,545★ / Python / Apache-2.0 / push 2026-10-16
- 仓库：https://github.com/OpenBMB/ChatDev
- 论文（chat chain / 角色成对 / communicative dehallucination）：https://arxiv.org/abs/2307.07924
- 其 DAG 扩展 MacNet：https://arxiv.org/abs/2406.07155

**AgentScope** — 33,445★ / Python / Apache-2.0 / push 2026-10-15
- 仓库：https://github.com/agentscope-ai/agentscope

**agent-zero** — 19,503★ / Python / **NOASSERTION** / push 2026-10-14
- 仓库：https://github.com/agent0ai/agent-zero
- 关键源码文件（`call_subordinate` 提示词，本文引用 `§§include(path)` 原文）：https://github.com/agent0ai/agent-zero/blob/baadd0dd/prompts/agent.system.tool.call_sub.md
- ⚠️ license 为 NOASSERTION（无标准 license 文件）→ **仅取设计思想，不复制代码**

**OpenAI Agents SDK / Google ADK**（浅，仅取 handoff 语义）
- https://github.com/openai/openai-agents-python （30,111★ / MIT）
- https://github.com/google/adk-python （21,899★ / Apache-2.0）

### 8.2 博客 / 工程文章 / 教程（5）

1. **Anthropic《How we built our multi-agent research system》**（2025-06-13，Jeremy Hadfield / Barry Zhang 等）
   - 原文（官方）：https://www.anthropic.com/engineering/multi-agent-research-system
   - 实际抓取的镜像（含逐条要点与直接引语，本文引用均出自此处）：
     - https://raw.githubusercontent.com/tim-kaa-py/ai-wiki/f1291d9707416754d7d5cafecb5c94018a45a985/summaries/2025-06-13_anthropic_multi-agent-research-system.md
     - https://raw.githubusercontent.com/EndogenAI/dogma/ca61303ef706db14400d633d0fefd06824075308/docs/research/sources/anthropic-com-engineering-multi-agent-research-system.md （注：该文件在后续 commit 中已 404，仅作为当时抓取的来源记录）
   - 引用要点：orchestrator-worker；+90.2%；**15× tokens**；"pass lightweight references back to the coordinator"；"effort scaling rules… not left to agent discretion"；"execute subagents synchronously… creates bottlenecks"；"a self-loop within each subagent… without waiting for the lead agent to review"

2. **多代理架构综述（含 MacNet / ChatDev / MetaGPT / OpenClaw 横向比较）**，authority=3
   - 抓取来源：GitHub release-assets 的签名 URL（**非稳定链接**，签名已于 2026-08-05 过期，无法作为长期引用）
   - 因此本文只引用其**可独立核验**的下游一手来源：MacNet 论文 https://arxiv.org/abs/2406.07155 （"Each DAG node is a role specialization; edges encode handoff contracts… routing is explicit and offline-computable"）
   - ⚠️ **诚实标注**：该综述的四条教训（结构>规模 / 交接契约 / communicative dehallucination / 流程可知就编码成 DAG）来自这份 PDF；由于链接不稳定，本文在 §3.2 保留其表述，同时用 MacNet 论文与 ChatDev 论文作为可核验的对应来源。若需长期引用，建议以 MacNet + ChatDev + MetaGPT 三篇论文为准。

3. **CervellaSwarm agent templates**（实践者团队模板，17 agent / 数百次真实会话）
   - https://pypi.org/project/cervellaswarm-agent-templates/0.1.0/ （authority=4）

4. **MetaGPT SOP 论述** — 见 §8.1 的 IBM 条目。

5. **ChatDev communicative dehallucination** — 见 §8.1 的 arXiv:2307.07924。

### 8.3 office 内核相关（附录 A，来自第一版）

**DeepSeek Harness** — 252,672★ / TypeScript / MIT / push 2026-10-17
- 仓库：https://github.com/deepseek-ai/deepseek-harness
- 关键架构决策记录（session 事实域 / agent live 域 / 边界镜像事件删除）：
  https://github.com/deepseek-ai/deepseek-harness/blob/1da466a0a6eb5c78b687bfb6d04aca953753c665/.agents/notes/implemented/architecture/2026-06-30-event-domain-semantics.md

**office 内核其他深度对象（第一版，仍然有效）**
- Temporal — https://github.com/temporalio/temporal （23,792★ / Go / MIT）；事件与历史：https://docs.temporal.io/workflow-execution/event
- Argo Workflows — https://github.com/argoproj/argo-workflows （17,039★ / Go / Apache-2.0）；核心概念：https://argo-workflows.readthedocs.io/en/latest/workflow-concepts/ ；增强依赖语义：https://argo-workflows.readthedocs.io/en/release-4.1/enhanced-depends-logic/ ；`NodePhase` 枚举（Go 类型定义）：https://pkg.go.dev/github.com/argoproj/argo-workflows/v3@v3.3.0-rc7/pkg/apis/workflow/v1alpha1#NodeStatus
- LangGraph — https://github.com/langchain-ai/langgraph （43,438★ / Python / MIT）；中断：https://docs.langchain.com/oss/python/langgraph/interrupts ；检查点：https://docs.langchain.com/oss/python/langgraph/checkpointers
- OpenHands — https://github.com/OpenHands/OpenHands （91,175★ / TypeScript / MIT）；安全/审批（`SecurityAnalyzer` + `confirmation_mode`）README：https://github.com/OpenHands/OpenHands/blob/main/openhands/security/README.md （实际抓取的是同一文件在 Hugging Face 的镜像 `.../Backup-bdg/OpenHands/blob/51ff9e56.../openhands/security/README.md`）
- Bazel Remote Execution API — https://github.com/bazelbuild/remote-apis （454★ / Proto / Apache-2.0）；`ExecutionStage` 枚举（proto 原文）：https://android.googlesource.com/platform/external/bazelbuild-remote-apis/+/6a2083e26767209665e81f5d909a8fbef1d19b2a/build/bazel/remote/execution/v2/remote_execution.proto

**已核实但不采用（第一版结论不变）**
- AutoByteus — https://github.com/AutoByteus/autobyteus （**1★** / NOASSERTION / push 2026-05-22，已停滞）
- PenguinHarness — https://github.com/Prism-Shadow/penguin-harness （2,818★ / Apache-2.0；方向为自进化 harness，非团队编排）
- ZCode（同名仓库）— https://github.com/zmccyy/ZCode--CLI--agent （**6★**；单代理 CLI，与 Team 无关；用户所指若为 ZCode 客户端则无公开设计文档）
- DIM — **未能证实存在**（检索最接近项为机器人 OS `rooksec-security-lab/dimos`，与 Team 无关）
