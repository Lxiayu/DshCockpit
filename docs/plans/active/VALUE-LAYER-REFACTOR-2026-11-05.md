# 价值层重构计划：SDK 桥接 + Mission Memory + 任务检查器（2026-11-05）

> 状态：**已批准（2026-11-05 用户拍板三项决策，见 §2）**
> 上游：`docs/research/memory-and-sdk-validation-2026-11-05.md`（证据底座）、`/Users/xia/Downloads/ChatGPT_重构项目价值定位_20261105-0246.md`（用户与 GPT 的新架构讨论）、`docs/plans/active/NEW-DIRECTION-PERSONAL-TEAM-2026-11-03.md`（新方向总计划，本文是其运行时与记忆层的落地升级）
> 立场继承：`AGENTS.md`（Harness 拥有执行事实；不写第二套事实源）、`docs/adr/ADR-0005-memory-official-stack.md`（零第三方 Memory Provider）
> 本文与 `AGENTS.md` §4 的"计划先行"流程对齐：批准后进入实施。

---

## 0. 一句话定位

> **DshCockpit 的价值不在重复官方桌面壳，而在三件事：项目级持久记忆（Mission Memory）、任务级执行闭环、可检查可回放的工作台（任务检查器）。执行事实永远属于 Harness，DshCockpit 只做记忆、检查与呈现。**

**架构原则（第二轮评审后收紧，作为后续所有实施的判据）**：

1. **Mission Core 是核心资产**——记忆、工作历史、任务关联（Mission / Workstream / TaskRef / events.jsonl）是不可替换的护城河。
2. **SDK / ACP 只是可替换的执行适配层**——它们供应"执行事实"，随时可能因 rc 迭代、协议变更、官方策略调整而更换或并存；任何把执行适配层的细节泄漏进 Mission Core 或 UI 的写法都是技术债。
3. **一条事实一条来源**——执行事实来自 Harness（journal / SDK 事件流），经验事实来自人（Mission Memory）。两者不交叉写入。

---

## 1. 问题陈述（为什么重构）

| # | 问题 | 证据 |
|---|---|---|
| P1 | 任务执行链路依赖 journal 尾随 + 旧 Team Runtime 投影，链路长、脆弱、无推送语义 | `src/runtime-mux.js`、`src/team/runtime/**`；`docs/architecture/data-flow.md` |
| P2 | Mission Core 只有**任务派发事实**（Mission/Workstream/TaskRef），没有**执行经验记忆**（失败尝试、决策、教训），跨会话不可复利 | `src/mission/schema.js` 事件类型盘点；`docs/quality/prompt-gap-analysis-2026-11-01.md`（Shared Context 只做了 1/3） |
| P3 | 单任务没有"检查器"视图：想知道一个任务里 agent 到底做了什么，只能翻原始日志 | 无对应 UI；事件溯源基础已具备但未暴露 |
| P4 | 自研 Team Runtime 与官方 Agent Teams 双轨，维护成本高 | `docs/adr/ADR-0002-consume-official-agent-teams.md` |
| P5 | 官方 SDK Client（stdio JSON-RPC、结构化事件流）已可用而壳未接入 | `docs/research/memory-and-sdk-validation-2026-11-05.md` §3 真机验证 |

## 2. 用户拍板记录（2026-11-05）

| 决策点 | 结论 |
|---|---|
| 记忆引擎 | **自研 Mission Memory**——但设计必须参考 projectmem 与 AgentMemory 的已验证设计（§4.2），不闭门造车；维持 ADR-0005 零第三方立场 |
| 运行时桥接 | **SDK Client 替换 + journal 只读**：新任务全走 SDK 通道，runtime-mux 降级为桌面版事实只读源，可回滚 |
| 真机测试 | 已完成两轮：0.2.1 基线（验证报告 §3）+ 0.2.2 真机执行（验证报告 §4.6：问答 + 工具循环 + 文件写入全部通过）；后续真机验证按需另行申请 key |
| **版本目标（D4）** | **直接上 0.2.2-rc.1**（2026-11-05 用户拍板）：锁 cordis ~4.1.0 全家桶 + 随应用供给 Node ≥24.9 运行时（独立子进程，Electron 主进程 Node 22 不受影响）；一步到位获得计划审阅/目标续跑/操作审批与 ACP 通道 |

## 2.5 0.2.2-rc.1 增补发现（2026-11-05 下午，用户提示后验证）

验证报告 §4.5 的关键事实对本计划的影响：

1. **ACP 解封**：0.2.2 的 ACP 依赖闭包完整，`dsh --profile acp` 协议冒烟通过——§6 中"ACP 缺依赖不纳入"的前提已失效；D4 已拍板升 0.2.2，ACP 进入 Phase 4 评估。
2. **cordis 约束反转**：0.2.2 要求 cordis ~4.1.0（0.2.1 是 ~4.0.5）。§3.3 按 D4 锁 `~4.1.0`。
3. **Node ≥24.9 硬要求**：D4 已拍板，Harness 子进程随应用供给独立 Node 24 运行时（隔离环境已用 Node 24.22.2 验证整套可行）。
4. **新能力与计划直接对齐**：SDK 计划审阅/目标续跑/操作审批回调 ↔ Phase 1 任务闭环；Session API 快照/事件日志/运行状态/投影分别订阅 ↔ Phase 3 检查器数据源。
5. **官方边界移动**：0.2.2 把「自动化任务」升级为宿主级统一管理——DshCockpit 不复刻官方任务管理 UI，差异化锚定"记忆 + 检查 + 呈现"（§0 定位不变，且更有必要）。

## 2.6 第二轮评审修订（2026-11-05 傍晚，用户转达 GPT 反馈 + 本机实测）

GPT 认可四阶段框架不推翻，但指出若干"未钉牢的边界"；本机实测（验证报告 §4.6）也推翻了计划初稿的两处技术假设。**全部采纳**，具体改动如下。

**事实修正（已实测/源码确认）**：

| 初稿表述 | 实测事实 | 影响 |
|---|---|---|
| 0.2.2 "无桌面安装包" | 有 ZIP/asar 构建产物，无签名安装器 | 文档措辞已改；分发不依赖官方安装包 |
| `run()` 提供推送语义 | `run()` = 订阅 + 聚合成败；实时须走 `onNotification` | Phase 1 拆"实时态"与"回放态"两套取数 |
| provider 走 `DEEPSEEK_BASE_URL` 直通 | 0.2.2 的 `dsh-llm-deepseek` **只支持 Messages 协议**，且 `baseURL` 仅信任特定层 | 自定义 OpenAI 兼容网关必须走 `dsh-llm-pi-ai`（§3.1 重写） |
| `launch: {args}` 传 `--patch` | 0.2.2 **忽略 `launch`**，须用 `patches`/`dshHome`/`profile` 具名选项 | Phase 1 适配层必须锁 0.2.2 选项面 |
| "SDK 单通道可做主通道" | SDK **无会话级取消**（`cancelRequest` 出现 0 次）；ACP 才有请求中止 → `cancelled` | 新增 R7；主通道保留但中断能力需另设路径 |

**结构性修订（采纳 GPT 建议）**：

1. **新增 Phase 0.5 契约验证**——"握手通过 ≠ 生产能力"，先把 0.2.2 的契约（事件形状、审批回调、续跑、Electron 进程内集成）固化成 fixture 与失败模式清单，再谈切换。
2. **Phase 1 拆 Shadow → Canary → Primary 三段**，不再是"一次切换"；`bridgeMode` 拆成**两个正交开关**（派发通道 / 观察来源），因为"SDK 派发 + journal 只读观察"本来就该并存。
3. **Task Inspector 重定义**：不是"单 Session 工具调用列表"，而是**跨多次 Execution 的长期工作历史**，且需要持久化与历史读取契约（`HarnessHistoryReader`），不是纯前端增量。
4. **Mission Memory 补齐生命周期**（Draft → UserConfirmed → Superseded / NeedsReview）、**内容级脱敏**（字段黑名单不够）、**真删除机制**、**中文检索测试集**。
5. **cordis 用独立 Runtime Lockfile 锁定**，不用根目录 `~4.1.0` 范围（`~` 允许补丁漂移）。
6. **旧 Team Runtime 退役延后**到验收之后，先标 `legacy` adapter。
7. **产品定位**按 §0 架构原则收紧：Mission Core 是核心资产，SDK/ACP 是可替换执行适配层。

---

## 2.7 契约验证（Phase 0.5，新增前置门槛）

**目标**：把"能握手"升级为"契约已知"。凡是后续阶段要依赖的 SDK 行为，先在本阶段以**可重放的 fixture + 明确的失败模式**固定下来，避免在 Phase 1 里边写边猜协议。

**范围（全部无 UI 改动，纯脚本 + fixture）**：

1. **事件契约 fixture**：以真机两跑（问答 / 工具循环，验证报告 §4.6）为基线，固定 `turn|step|tool|message|request|session` 六族事件的字段形状与顺序约束，落成 `test/fixtures/harness/0.2.2/*.jsonl`；写契约测试断言"字段缺失/改名即红"。
2. **审批回调面**：`approvalRequests` / `userQuestions` 的双向交互（本轮未触发）。至少要摸清：什么条件下触发、拒绝后的事件走向、超时语义。
3. **续跑与中断**：`resumeSession` 在"进程被杀"后的行为；SDK 无 cancel 时的**降级中断方案**（kill 子进程 → `resumeSession` 续跑，或以 ACP 请求中止替代）——这条直接决定 Phase 1 的 UI 是否能有"停止"按钮。
4. **Electron 集成面**：主进程（Node 22）加载 `@deepseek-ai/dsh-sdk-client` 是否可行（该包未声明 `engines`，属推断，须实测）；子进程 Node 24 的路径解析与打包后 asar 环境下的可执行性。
5. **Provider 路由固化**：把"`dsh plugin add` + `insert` 数组补丁 + `tool-fs` 显式开启"这条已验证路径写成脚本化 provisioner，供打包环境复用（验证报告 §4.6）。

**退出条件**：上述五项各有一份"通过 / 失败 / 明确 Deferred"的结论；事件 fixture 进 CI；中断方案二选一定稿。

---

## 3. Phase 1 —— SDK 桥接（三段式，先打地基）

**目标**：任务执行从"journal 尾随"切换为"SDK 事件流"，投影层零改动；切换过程可观测、可回滚。

### 3.1 新增 `src/harness/sdk-bridge.js`（执行适配层）

- 封装 `DeepSeekHarness`（`@deepseek-ai/dsh-sdk-client@0.2.2-rc.1`），**只暴露 DshCockpit 自己的窄接口**（`start` / `prompt` / `onEvent` / `resume` / `close`），SDK 类型不外溢：
  - **客户端选项必须用 0.2.2 具名面**：`profile` / `patches` / `dshHome` / `env`。**不得使用 `launch`**（0.2.2 静默忽略，验证报告 E7）。
  - **profile 供给**：`sdk-minimal` + 补丁（`tool-fs` 开启读写 + `llm-pi-ai` 路由声明）。补丁内容由 `RuntimeProfileManager`（3.3）生成，不硬编码。
  - **provider 配置**：**不走 `DEEPSEEK_BASE_URL`**（0.2.2 的 `dsh-llm-deepseek` 只支持 Messages 协议，StepFun 等 chat-completions 网关无法接入）。自定义网关一律声明 `@deepseek-ai/dsh-llm-pi-ai` 的 `providers` 路由（`api: openai-completions` + `baseURL` + 自声明 `models`），且插件必须由 `dsh plugin --profile <name> add` 装进 profile（否则静默不激活，验证报告 E8）。
  - **生命周期**：握手重试（SDK 自带 fresh-subprocess 重试）、优雅关闭梯子（stdin EOF → SIGTERM → SIGKILL，SDK 已内置）。
- **事件 adapter**：`session.event`（wire 信封）→ `ingestHarnessEvent` 所需事实格式。**只做翻译，不做第二投影**。字段映射表以 Phase 0.5 的 fixture 为准，协议变更只允许改这一个文件。
- **双取数路径**（对应 `run()` 的实测语义）：
  - **实时态**：`onNotification` / `subscribeSessionTree` 逐条推送 → office 投影 + 检查器活动流。
  - **回放态**：`run()` 的聚合 `events` → 落库与事后对账。两者共用同一 adapter，但**不得互相替代**（验证报告 §4.6 语义修正 2）。
- **幂等**：以 `(sessionId, eventSeq)` 去重，与现有 `seqForMissionSession` 对齐。
- **中断**：按 Phase 0.5 定稿方案实现（SDK 无 cancel，验证报告 §4.6 语义修正 3）；UI 的"停止"要么走进程级中断 + 续跑，要么暂不提供——**不允许假装有取消**。

### 3.2 接线与降级（两个正交开关，非互斥）

- `bridgeMode` 拆为两个独立开关，可任意组合：
  - `dispatchChannel: 'sdk' | 'legacy'` —— 新任务从哪条通道派发。
  - `observationSource: 'sdk' | 'journal' | 'both'` —— 投影/检查器从哪取执行事实。
  - 典型组合：**SDK 派发 + journal 只读观察**（桌面版共存期默认）、SDK 派发 + sdk 观察（自管任务）、legacy 派发 + journal 观察（回滚态）。
- `missionPromptSession`（`src/main.js`）在 `dispatchChannel='sdk'` 时经 sdk-bridge 派发；`runtime-mux` 仅在 `observationSource` 含 `journal` 时消费桌面版 journal，**只读**。
- 旧 Team Runtime（`src/team/runtime/**`）**本阶段不删**，标记为 `legacy` adapter 并加弃用注释，退役留到 Phase 4 验收之后（§6）。

### 3.3 运行时供给与依赖锁定

- **`RuntimeProfileManager`（新增）**：负责
  1. Harness 子进程的 **Node ≥24.9 运行时**解析（随包分发的 Node 24 或启动时探测，R6）；
  2. 隔离 `DSH_HOME` 的创建与 profile provision（含 `dsh plugin add` 幂等检查）；
  3. 生成 `--patch` 补丁文件（`insert` 数组语法、`tool-fs` 开关、provider 路由）；
  4. 版本/一致性自检（cordis 树版本、profile 依赖、插件是否真的激活）。
- **独立 Runtime Lockfile**：cordis 与 Harness 全家版本不在根 `package.json` 用 `~4.1.0` 范围锁定（`~` 允许补丁漂移），改为**独立的运行时 lockfile**（`runtime/harness.lock.json` 或等价物）+ 生成脚本；`npm test` 前的一致性检查直接比对该 lockfile 的绝对版本。两代约束相反（0.2.1 `~4.0.5` / 0.2.2 `~4.1.0`），混装即崩（验证报告 E3）。
- **rc 版本隔离**：所有 SDK 类型经 adapter 收窄；升级走独立的升级计划流程（不夹带在功能 PR 里）。

### 3.4 三段式推进（Shadow → Canary → Primary）

| 段 | 做法 | 通过标准 | 回滚 |
|---|---|---|---|
| **Shadow** | SDK 通道与现有链路**并行跑**同一批任务（不生效，仅比对）：SDK 事件流 vs journal 投影逐条对账 | 对账差异全部有解释（非缺陷）；零伪影 | 关开关即可（不进生产路径） |
| **Canary** | 少量 Mission 走 SDK 派发（`dispatchChannel='sdk'`，可用白名单/比例控制），其余仍 legacy | 连续 N 个任务无人工干预完成；检查器可查；无重复事实 | 单任务级切回 legacy |
| **Primary** | 默认 `dispatchChannel='sdk'`；`runtime-mux` 仅作桌面版共存观察源 | 现有测试全绿；一周观察期无 P1/P2 缺陷 | 全局开关 + `observationSource='journal'` 兜底 |

### 3.5 退出条件

1. Phase 0.5 的事件 fixture 契约测试进 CI（无 key 可跑）。
2. Shadow 对账通过；Canary 达标记数；Primary 观察期无 P1/P2。
3. 两个开关的四种组合均有自动化测试覆盖（尤其 `legacy` 回滚路径）。
4. 隔离环境（无 key）握手冒烟进 CI；真机项按需申请 key。
5. 中断行为与 Phase 0.5 的定稿方案一致（有则可用、无则 UI 不展示）。


---

## 4. Phase 2 —— Mission Memory（核心价值层）

**目标**：Mission Core 从"任务派发事实源"扩展为"项目经验记忆中心"，跨会话复利。

### 4.1 不做什么（边界）

- **不复制执行事实**：Harness journal 仍是执行事实唯一来源；Mission Memory 只存**经验层**（人的判断、派生结论、失败教训），全部带来源引用（sessionId/TaskRef）。
- **不引入第三方引擎**：不装 projectmem/AgentMemory/iii-engine；不加新进程、端口、token。
- **不做向量库**：第一版检索用轻量方案（见 4.3），语义检索 Deferred。

### 4.2 事件模型扩展（参考两家，自研落地）

`src/mission/schema.js` 新增事件类型（沿用 append-only `events.jsonl` + 投影）：

| 事件 | 参考 | 字段要点 |
|---|---|---|
| `memory/attempt` | projectmem `attempt` | issueRef、描述、`worked/failed/partial`、位置（`file:line` 或模块名）、来源 TaskRef |
| `memory/decision` | projectmem `decision` | 决策内容、可退役旧决策（`retires`）、理由、上下文引用 |
| `memory/lesson` | AgentMemory lessons | 跨会话教训、适用条件、置信度 |
| `memory/gotcha` | projectmem gotchas | 项目坑位、触发条件、规避方法 |

配套投影与查询（`src/mission/`）：
- **Brief 增强**（参考 projectmem `brief`）：`brief-sync.js` 写入 AGENTS.md 时带上"失败尝试警告 + 开放问题 + 近期决策"（警告按位置命中，防止重复踩坑——projectmem 已验证的核心价值）。
- **派发前检查**：`confirmDispatch` 时按任务描述/目标文件命中历史失败尝试，在 UI 提示（不阻断，只提醒）。
- **捕获纪律**（参考 AgentMemory 单写入者 + 隐私过滤）：attempt/lesson 的产生只有两个入口——用户在 UI 显式记录、任务收尾时由**最终 assistant 消息 + 人工确认**派生草稿；绝不自动从中间事件抓取。`PRIVACY_FORBIDDEN_FIELDS` 规则同样适用于记忆事件。
- **陈旧检测**（参考 projectmem staleness）：记忆引用的位置/文件变更时标记 stale，Brief 中降权展示。

### 4.2.1 记忆生命周期（新增，必需）

一条记忆不是"写进去就永远对"。状态机：

```
Draft ──用户确认──> UserConfirmed ──被新记忆退役──> Superseded
  │                     │
  │                     └── 来源位置漂移/证据失效 ──> NeedsReview ──复核──> UserConfirmed | Superseded
  └── 丢弃 ──> Deleted（软删，保留墓碑）
```

- **Draft**：派生的草稿（如任务收尾自动生成），**不进检索结果、不进 Brief**，只在"待确认"列表可见。
- **UserConfirmed**：唯一进入检索与 Brief 的状态。
- **Superseded**：被新决策/新教训替代，保留但降权，历史可追溯（`retires` / `supersededBy` 双向引用）。
- **NeedsReview**：来源变了（文件行号漂移、引用的 task 已废弃），标记待复核，Brief 中明确提示"此条可能过时"。
- **Deleted**：见 4.2.2。

### 4.2.2 真删除与内容级脱敏（新增，必需）

- **真删除**：`PRIVACY_FORBIDDEN_FIELDS` 是**字段级**黑名单，挡不住"把密钥写进 description 的自由文本"。因此需要：
  1. 写入前的**内容级脱敏**（正则/熵检测识别 token、私钥块、连接串、邮箱等），命中即替换为 `<redacted:kind>`；
  2. **删除请求**要能真正抹掉内容：append-only 日志不允许改写，故采用"墓碑事件 + 物理压实"（compaction）两步——墓碑事件记录 `deletedEventId`，压实任务重写 `events.jsonl` 并同步清理投影索引；
  3. 删除必须可从 UI 触发（按记忆条目 / 按任务 / 按时间范围），并留下审计记录（谁、何时、范围，不含被删内容）。
- **导出即泄露检查**：Brief 写入 `AGENTS.md` 前再跑一次脱敏扫描（AGENTS.md 会进入 git）。

### 4.3 检索（第一版）

- 子串/词法检索直接复用 event-log 扫描（projectmem `search` 同级能力）。
- 排序 = 时间新近度 × importance（AgentMemory 字段思路）× 命中位置权重 × **状态权重**（`NeedsReview` 降权、`Superseded` 更低）。
- **中文检索测试集（新增）**：中文没有空格分词，子串检索对"登录页崩溃"这类查询容易漏。必须建立一组**中文查询用例**（≥20 条，覆盖中英混排、标识符、路径、短查询），作为检索层的回归基线；分词/ngram 策略由这组用例决定，而不是凭感觉。
- 语义检索（BM25/向量）Deferred：等真实使用量证明词法不够再立项，避免为想象中的需求引入依赖。

### 4.4 退出条件

1. schema 扩展 + 投影 + 隐私门禁测试全绿（含 `FORBIDDEN_PERSISTED_FIELDS` 扩展）。
2. **生命周期状态机**测试全绿：Draft 不进检索、Superseded 降权、NeedsReview 可复核回正、Deleted 物理压实后不可恢复且审计可查。
3. **内容级脱敏**测试全绿：构造含 token / 私钥块 / 连接串的自由文本，写入与导出（AGENTS.md）两侧都不泄漏。
4. **中文检索用例**（≥20 条）通过率达标（目标：无关中文查询零误命中、相关查询首页命中）。
5. Brief 跨会话真机验证：新会话 agent 能从 AGENTS.md 读出失败尝试警告（复用既有 brief 验收方法）。
6. 记忆事件全部可溯源（无来源引用的写入被 schema 拒绝）。


---

## 5. Phase 3 —— 任务检查器与工作历史（重新定义）

**目标修正（第二轮评审）**：检查器不是"单 Session 的工具调用列表"，而是**跨多次 Execution 的长期工作历史**——回答"这件事从头到尾经历了什么：谁派的、跑了几次、每次改了什么、哪里失败过、结论是什么"。

### 5.1 概念模型

```
Mission (长期目标)
  └─ Workstream (工作线)
       └─ Execution (一次派发 → 一个 Harness session)   ← 可多次
            └─ Turn
                 └─ Step
                      └─ tool/call → tool/result
```

- **Execution** 是新增的一等概念：`TaskRef` 已能派生 `{sessionId, turn}`，但需要提升为**持久化实体**（`missionId / workstreamId / executionId / sessionId / 通道来源 / 起止时间 / 结果`），否则"跨执行历史"无处挂载。
- 通道来源（`sdk` / `journal`）必须记在 Execution 上——同一工作线可能一部分任务走 SDK、一部分是桌面版 journal 记录。

### 5.2 持久化与历史读取契约（`HarnessHistoryReader`）

检查器**不能只读内存里的事件数组**——进程重启后历史必须还在。定义的契约：

| 能力 | 说明 |
|---|---|
| `listExecutions(missionId/workstreamId)` | 按工作线列出历次执行（含失败的、被中断的） |
| `readEvents(executionId, {afterSeq, limit})` | 分页读事件流（不一次性全量加载） |
| `readSummary(executionId)` | 起止时间、工具调用计数、失败定位、最终结论 |
| `resolveSource(executionId)` | 该执行的原始事实在哪（SDK 落库路径 / journal 文件 + 偏移） |

- SDK 通道：事件由 DshCockpit 落库（或以 Harness session 存储为准 + 索引）。
- journal 通道：只读 `journal` 文件 + 偏移量（不复制事实，只建索引）。
- **不为检查器造第二套执行事实**：它只做索引与视图，源永远是 Harness。

### 5.3 UI

- Mission Desk 详情区新增"检查器"页签：
  - 顶部：工作线时间轴（多次执行并排，失败/中断用明确标记）；
  - 中部：选中执行的三泳道（步骤 / 工具 / 消息），支持 `tool/call ↔ tool/result` 配对与耗时；
  - 右侧：单事件详情（原始 JSON 可折叠）+ 首个错误高亮定位；
  - 底部：结论区（最终 assistant 消息 + 人工记录的经验，二者分列，不混）。
- **只读**，不提供"编辑历史"。
- Office 场景保持状态总览定位，不做逐事件渲染（渲染带宽铁律不变）。

**退出条件**：真机跑一个含工具调用、且中途失败一次的任务，检查器能跨多次执行展示完整历史，事件与落库内容逐条对账一致；进程重启后历史仍可读。

## 6. Phase 4 —— 清理（退役延后，先标 legacy）

**修正（第二轮评审）**：旧 Team Runtime 不在 Phase 1 结束时删，**等 Phase 1–3 全部验收之后**再退役；过渡期先做三件事：

1. `src/team/runtime/**` 标记 `legacy` adapter（弃用注释 + 单一入口收敛），新增调用点禁止直连；
2. 补一组"legacy 路径仍可工作"的回归测试，确保过渡期不因 SDK 演进被打断；
3. 明确退役判据：**SDK 通道连续运行无回归 + 无外部依赖 legacy 投影**，两者同时满足才删。

其他清理项：
- `runtime-mux` 最终形态确认（只读 or 完全移除，视桌面版共存需求与 `observationSource` 的实际使用）。
- **ACP 定位**：0.2.2 已解封（协议冒烟通过，验证报告 §4.5）。定位为**自动化/外部宿主通道候选**，不做主执行通道；Phase 4 评估两件事——①它是否是"中断任务"的替代路径（SDK 无 cancel，ACP 有请求中止，验证报告 §4.6）；②与 SDK 通道并存时的会话身份归属。


---

## 7. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | rc 版本 API 不稳（0.2.2-rc.1 本身是 rc，且 0.2.1→0.2.2 已出现选项面破坏性变化） | adapter 层收窄协议面；版本写死不用范围；升级走独立升级计划流程 |
| R2 | cordis 版本污染导致启动崩溃（已实证，且两代约束相反） | **独立 Runtime Lockfile**（绝对版本，不用根 `~` 范围）+ CI 比对门禁 + 禁引清单注释 |
| R3 | SDK 通道与桌面版 Harness 的会话双轨（两套 session 事实） | Mission 侧以 TaskRef 统一引用；桌面版任务走 journal 只读投影，UI 标注来源通道 |
| R4 | 记忆层膨胀成第二事实源 | §4.1 边界 + 事件必须带来源引用 + 隐私门禁测试 |
| R5 | 测试环境伪影（PTY/网络/shim，验证报告 §5） | 环境坑清单进 AGENTS 附录；真机验收项明确标注所需环境 |
| R6 | 0.2.2 的 Node ≥24.9 运行时分发与 Harness 子进程管理 | D4 已拍板：随应用打包独立 Node 24 运行时或启动时探测（Electron 主进程 Node 22 不受影响）；隔离环境已验证（验证报告 §4.6） |
| R7 | **SDK 无会话级取消**（已实测：`cancelRequest` 出现 0 次） | Phase 0.5 定稿降级方案（进程级中断 + `resumeSession` 续跑 / ACP 请求中止）；**UI 不为"假取消"买单**——拿不到可靠中断就不展示停止按钮 |
| R8 | 检查器把"索引"做成第二套执行事实 | `HarnessHistoryReader` 只建索引不复制事实；对账测试（落库 vs 源）进 CI |
| R9 | 自定义 provider 路由脆弱（插件须装进 profile、`launch` 选项被忽略、`tool-fs` 默认关闭） | `RuntimeProfileManager` 把 provision 过程脚本化 + 自检（插件是否真的激活、路由是否注册）；环境坑 E7–E10 进 AGENTS 附录 |
| R10 | 记忆内容级泄露（字段黑名单挡不住自由文本） | 写入前脱敏 + 导出（AGENTS.md）前二次扫描 + 真删除（墓碑 + 压实） |

## 8. 测试策略

- **契约测试（Phase 0.5 产物）**：以真机事件流为 fixture（`test/fixtures/harness/0.2.2/*.jsonl`），断言事件字段与顺序约束；字段改名即红，**无 key 可跑**。
- **单元**：sdk-bridge adapter 事件映射；memory schema/生命周期状态机/投影/内容级脱敏/中文检索用例。
- **集成（无 key）**：隔离 `DSH_HOME` 握手冒烟进 CI；`RuntimeProfileManager` 的 provision 自检（插件激活、路由注册、补丁语法）。
- **对账测试**：Shadow 阶段的 SDK 事件流 vs journal 投影逐条对账，差异必须显式归因（新测试类别）。
- **真机（需 key，另行申请）**：问答、工具循环、检查器跨执行历史、Brief 跨会话、中断降级路径。
- **回归**：`legacy` 路径在过渡期保持绿（退役前不得红）。
- **门禁不变**：`CI=1 npm test` 全绿基线 + 运行时 lockfile 一致性检查（替代根目录范围声明）。

## 9. 明确不做（本期）

- 不做向量/语义检索。
- 不引入任何第三方记忆引擎或其运行时分发。
- 不做记忆自动抓取（只有人工确认派生 + 显式记录两个入口）。
- ACP 不做主执行通道（主通道定 SDK Client；ACP 仅作自动化/中断替代候选评估）。
- 不复刻官方 0.2.2 的宿主级自动化任务管理 UI（差异化锚定记忆/检查/呈现）。
- 不改 Office 渲染管线与素材规范。
- **不在检查器里做"编辑/重放执行"**——只读历史，重跑是新建 Execution。

