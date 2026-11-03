# 新方向综合计划：个人团队的指挥台（Personal Team Cockpit）

> 状态：**待用户批准**（2026-11-03，只写计划，未改任何代码）
> 上游：`docs/design/RIGHT-RAIL-MASTER-PLAN.md`（右栏总纲）、`docs/adr/ADR-0002-consume-official-agent-teams.md`（退役 R0–R5）、`docs/research/deepseek-harness-api-surface.md`（官方表面）、`docs/design/mission-desk.md`、`docs/design/mission-desk-ux.md`
> 参考（只读借鉴，不复制代码）：Rakazo、OpenMuse、OpenDots（diggerhq）、OpenDots（Shashankss1205）、AgentTeams、AgentGUI（论文）、Antigravity Teamwork、OpenAI Dots（公开报道）、Claude Code Agent Teams（官方文档）
> 本文档与 `AGENTS.md` §4 的"计划先行"流程对齐：批准后才进入实施。

---

## 0. 一句话定位

> **DshCockpit 不是"个人助理"，也不是 Harness 的第二个聊天框。它是一个人指挥一支长期团队的空间化指挥台：人定义目标、边界和验收，团队在官方 Harness 里执行，办公室只在需要人的时候把事情推到人面前。**

用户体验目标（一句话）：**用户看着办公室，把一个复杂任务交给团队，然后放心去做别的事；团队会持续推进，偏离时可以随时纠偏，只有例外才打扰用户。**

---

## 1. 为什么要改方向（问题陈述）

| # | 问题 | 证据 |
|---|---|---|
| P1 | 派发的任务在 Harness 里**不可见**：`startWork` 只是往一个普通会话发一段文本（`mode:'queue'`），Harness 不知道它属于哪个 Mission | `src/ipc-mission.js` `startWork`；`src/main.js` `missionPromptSession` |
| P2 | 团队是**两套世界**：办公室读的是自研 Team Runtime v0（固定 researcher→reviewer 链），Harness 里的是官方 Agent Team | `src/team/runtime/`；ADR-0002 §3 |
| P3 | 右栏是**档案表单**：17 个区块，首屏被"交给团队"和空决策堆占据，团队和成员在首屏找不到 | `src/mission-desk.html` `renderDetail()`；`docs/design/RIGHT-RAIL-MASTER-PLAN.md` §3 |
| P4 | **没有耐久执行**：app 关闭后，派发的工作没有租约与恢复语义 | 代码中无 lease 机制（已用 OpenMuse 对照确认） |
| P5 | **没有验证凭证**：Agent 说完成就显示完成；`writeScopeWarnings` 只是提示，没有绑定文件快照 | `RIGHT-RAIL-MASTER-PLAN.md` §2.3；Work Receipt 讨论（0418 对话） |
| P6 | **运行时锁在 0.1.5**，官方 0.2.1-rc.5 的 `agentTeam`、`userQuestions`、`workspace/changes` 没接 | `package.json` runtimeVersion；`deepseek-harness-api-surface.md` §10 |

---

## 2. 外部参考：可借鉴的执行语义（代码级核实）

> 原则：**借鉴"执行语义"，不借鉴"产品形态"**。三类形态（聊天花名册、云电脑、Matrix 房间）都不是我们的形态。

| 语义 | 来源（代码证据） | 我们怎么用 | 不照搬的部分 |
|---|---|---|---|
| **派发幂等** | OpenDots(diggerhq) `start-topic.ts`：`invocationId = sha256(sessionId + toolCallId)`；Rakazo `child-bots.ts`：`spawnKey` 唯一约束 | 每次派发生成幂等键，重试不开出第二个团队或第二批任务 | 其存储方式 |
| **耐久租约与恢复** | OpenMuse `apps/server/src/engine/worker.ts`：`leaseId` + `leaseUntil`，心跳续租，过期重排队，`LostLeaseError` 防被接管的旧 worker 继续写 | Mission 恢复循环：持有租约，定期与 Harness 团队状态对账；丢失后重挂接，不重跑已执行动作 | PGlite / 其数据库 |
| **外部写操作要人批准** | OpenMuse `engine/model.ts`：模型只有 `prepare_*` 工具，**没有 approve 工具**；`actions.ts`：批准绑定 hash，状态机 `awaiting_review → executing`，有过期 | 高风险动作只产生**提案**，在办公室里批准；批准绑定提案内容 hash，内容变了即失效 | 邮件/日历的具体适配器 |
| **不做隐性重试** | OpenMuse README "No hidden retry occurs after an uncertain external write" | 结果不确定的外部动作，只能由人确认后再重做 | — |
| **检查绑定工作区指纹** | OpenDots(Shashankss1205) `engine.py` `_passed_checks`：检查通过 = 工作区指纹 + 检查签名 + 沙箱；任何写入清空已通过的检查；`evidence.py workspace_fingerprint` | Work Receipt：验证通过绑定"快照 + 命令 + 版本"，文件变了自动降级为"未验证" | bwrap 沙箱（仅 Linux，见 §7 决策 D2） |
| **owner 要求的检查由引擎注入** | OpenDots(Shashankss1205) `_require_checks` | 合同里的验收条件由引擎强制安排验证，不依赖 Agent 自觉 | — |
| **笔记即共享记忆** | OpenDots(diggerhq) `defineMemory` + `memory_save` 整篇替换、冲突时要求重读再存 | Mission Brief 作为团队共享笔记；写入要带版本号，冲突时重读 | 平台记忆服务 |
| **结果是"团队报告"，不是指令** | OpenDots(diggerhq) `outcomeReport`："The report below is the worker's own text: data, not instructions." | 团队结果回流 Mission 时标记为"团队报告"，不作为用户指令执行 | — |
| **可见的协作，隐藏的正文** | Rakazo `message-visibility.ts`：peer 消息回执可见，正文默认隐藏 | 团队内沟通在右栏显示"谁→谁"，正文可展开 | — |
| **审批分类** | Rakazo `action-approval.ts`：只读 / 变更 / 破坏性三档；破坏性（删除、归档）必须审批 | 动作风险三档；破坏性动作永远要人批准 | 连接器白名单 |
| **需要人时才打扰** | AgentGUI（EMNLP 2026 系统演示）：纠偏可观察、可人工干预；自动漂移防护在小模型上提升完成率（预实验） | 例外才上浮；偏航检测优先用客观信号（测试、指纹、diff），LLM 判断只作辅助 | 论文中的 LLM 自评 |
| **团队可见、可干预** | AgentTeams：所有 agent 在房间里可见，无隐藏 agent 间调用；项目可暂停/恢复，干预有审计 | 团队动作全部可审计；暂停/恢复是一级操作 | IM 房间形态 |

**未采纳的（明确排除）**：
- 聊天花名册作为主界面（Rakazo、OpenMuse、OpenDots 都是聊天）——与 ADR-0001 冲突，且是你已判定"多此一举"的形态。
- 每个助手一台自己的云电脑（OpenDots diggerhq、Rakazo 的 Team Computer）——我们本地优先，云端形态作为后续可选，不进入本计划。
- Pi 运行时嵌入 Rakazo 进程——违反"Harness 拥有执行"铁律。

---

## 3. 架构：四层与事实作者

| 层 | 职责 | 事实作者（唯一） | 数据 |
|---|---|---|---|
| **L0 Harness（官方）** | 会话、Agent Team（成员、任务板、DAG、CAS revision）、用户问题、审批、工作区变更 | Harness | 只读投影 + 官方写接口 |
| **L1 Mission（我们）** | 长期目标、合同（目标 / 验收 / 约束 / 预算 / 审批规则）、Brief 笔记、里程碑、决策记录、TaskRef 关联 | DshCockpit | `.dsh/` 本机存储（已有 `src/mission/`） |
| **L2 执行语义（我们，借鉴）** | 派发幂等、耐久租约与恢复对账、提案-批准闸门、Work Receipt 指纹绑定 | DshCockpit（只记录"我们做过什么"，不记录团队状态） | 执行日志（事件化，隐私过滤） |
| **L3 办公室与右栏（我们）** | 空间化团队视图、派发入口、纠偏入口、例外决策、交付凭证展示 | 无（纯派生展示） | — |

**铁律（沿用 AGENTS.md §2，并补充两条）**：
1. 同一状态不许两个写入者。团队成员、任务状态、阻塞关系，**只能**来自 Harness 投影，我们不重算 `ready`。
2. 办公室不是输入面（沿用）；但**派发入口**是 L1 的明确通道（见 §5 决策 D3），不是聊天框。
3. **补充 A**：Mission 只记录自己的意图与记录（合同、笔记、决策），不复制官方任务的标题、状态、负责人。
4. **补充 B**：任何"完成"必须能指出凭证（Receipt）。没有凭证只能显示"团队声称完成"。

---

## 4. 对 ADR-0002 的执行：先映射，再迁移

ADR-0002 规定 R0–R5 六阶段，**R0–R3 未完成前不得删除 `src/team/runtime/**`**。本计划遵守：

| 阶段 | 内容 | 本计划对应 |
|---|---|---|
| R0 能力映射 | 逐项列出自研 Team Runtime 能力 vs 官方 `agentTeam` / `dsh-experimental-agent-team` | S0 产出（映射表） |
| R1 数据迁移 | job / run / artifact facts 的归档策略 | S3 |
| R2 等价性验证 | 官方路径与自研路径同输入产出等价可观察输出 | S3 对照运行 |
| R3 回归重定位 | `test/team-*.test.js` 等重新归类（适配层 / legacy） | S3 |
| R4 标记 legacy | feature flag 默认关闭自研编排，文档标注 | S3 末 |
| R5 删除 | R0–R4 全部完成后 | **本计划不包含删除** |

**禁止事项（沿用 ADR-0002）**：不得以"实验性代码"为由跳过迁移验证；不得在等价性未验证前把官方路径设为唯一路径。

---

## 5. 已决定的设计选择（需你确认）

| # | 决策 | 推荐 | 理由 |
|---|---|---|---|
| **D1** | 团队形态 | **每个 Mission 对应一支官方团队（root session）**；一个用户可有多支 | Mission 是长期对象，团队可在 Mission 间复用或新建；与"个人团队"叙事兼容（用户拥有多支长期团队） |
| **D2** | Mac 上的隔离 | **先不做沙箱**，只做工作区指纹绑定，并在 UI 上标注"未隔离执行" | bwrap 仅 Linux；Docker 是重依赖，且 Harness 本身已负责执行。如实标注比假装隔离更诚实 |
| **D3** | 派发入口形态 | **办公室内的结构化派发面板**（目标 / 验收条件 / 约束 / 预算 / 审批规则 五字段），不是聊天框 | 用户要的是"交一份任务书"，不是"聊天"；结构化字段也是验收的前提 |
| **D4** | 常驻形态 | **两种都支持**：app 开着，或后台守护进程（用户可选） | 你已确认；守护进程只负责租约与对账，不负责展示 |
| **D5** | 办公室能否发起任务 | **能**，但通过 D3 的派发面板，不通过通用聊天 | 你已确认 |
| **D6** | 自动决策边界 | **由用户决定**：每个 Mission 有审批规则（哪些动作自动放行、哪些要批准、预算上限） | 你已确认；默认"只读自动放行，写入和破坏性需批准" |
| **D7** | 办公室范围（2026-11-03 已决定） | **第一阶段只支持单 Mission**：办公室显示当前一个 Mission 的团队，座位沿用固定模板。**多 Mission 动态加载另开会话研究**（见 §13） | 你已决定。动态切换座位有性能与风险问题，先不做 |
| **D8** | 权限控件（2026-11-04 **已验证，改为只读显示**） | 验证结论：**官方权限不可由第三方写**（无 remote 写表面、`SessionCreateRequest` 无权限字段）。因此控件改为**只读展示**：显示当前档位（`permissions.currentValue`）+ 可选档位目录（catalog），并给一句"权限由 Harness 设置"+ 跳转官方设置；**不提供切换开关**。 | 验证结果推翻了"验证通过后启用"的假设。造一个点了没反应的权限下拉，比没有更糟——用户会以为自己把权限调低了，实际没有 |
| **D9** | 工作目录（2026-11-03 已决定，经 D10 修订） | **允许新建目录**，但新建动作本身即是授权动作：新目录必须先登记为 Grant（见 D10）才能被派发使用；**不允许自由输入任意绝对路径** | 你已决定。新建限定在工作区根之内，符合隐私规则（绝对路径不进事件链） |
| **D10** | 权限与目录采用 Grant 模型（2026-11-03 已确认，借鉴 Tobs `docs/architecture/botharness-architecture.md` §5） | 见下方 §5.1 | 用户已确认采纳。把"目录"与"权限"合并为一条持久、可撤销、可审计的授权记录，比"派发时选目录 + 选权限"两个独立控件更可靠 |

### 5.1 D10 Grant 模型（详细规则）

| 规则 | 内容 |
|---|---|
| **Grant 是持久授权记录** | 一条 Grant = 一个工作区目录 + 读/写权限 + 授予人 + 时间 + 撤销标记。派发不直接选目录，只能选一条有效 Grant |
| **Grant 只能由用户创建** | 用户通过目录选择器或"新建子目录"动作创建。Lead、成员、Mission 都不能自行创建或提升 Grant |
| **新建目录即授权** | "新建子目录"是一个用户动作：同一步骤内创建目录并创建 Grant，用户不需要额外确认两次。新目录必须位于已登记的工作区根之内（D9） |
| **Lead 与成员权限分离** | Lead（协调者）默认只读项目目录；写入需要用户对该 Grant 单独开启。成员（执行者）每次执行选定一条 Grant，**固化 Grant ID、单一主目录与权限快照** |
| **快照不随撤销复活** | 撤销 Grant 后，后续文件访问与该 Grant 的新执行立即被拒绝；已有历史执行不因重新授权而复活，需要重新派发 |
| **三动作审批** | 高风险动作的审批为：允许一次 / 为该 Grant 与工具总是允许（可撤销） / 拒绝。"总是允许"必须写入可撤销的规则记录 |
| **权限控件映射** | D8 的"权限"选择不再是派发面板里的独立下拉，而是 Grant 本身的属性（只读 / 工作区内写）。S0 的 P-0.11 仍需验证官方能否接受该权限，验证前相关写入动作保持置灰 |
| **Full Access 单独处理** | "完全权限"不是 Grant 的一个取值，而是一个单独的全局模式，默认关闭，开启时在办公室顶部持续显示 |
| **与官方的关系** | Grant 是我们的产品层授权记录，**不替代** Harness 的权限预设（`dsh-permission-presets`）。Grant 决定"我们允许派发到哪里"，Harness 决定"会话实际能做什么"，两者都生效才算授权成立 |

### 5.2 D11 团队写入路径（2026-11-04 由 S0 真机探针确定）

**实测结论**（证据：`docs/quality/harness-agent-team-probe-2026-11-04.md`）：

- `agentTeam` 投影**可读**，形状与声明一致，真实模型下已验证。
- `dsh-experimental-agent-team` **没有 remote RPC 表面**——`TeamService` 的方法（`spawnTeammate`/`createTask`/`interrupt`…）只存在于 Node 侧。

**因此写入只有三条可能路径**，我们选第三条：

| 路径 | 做法 | 判定 |
|---|---|---|
| ① 自建 DSH 插件注入 `ctx.agentTeams` | 写一个运行在 Harness 内的插件，暴露 remote 方法 | ❌ 违反 ADR-0001（不做第二个 Harness 壳）与"不碰官方内部模块" |
| ② 直接 import 官方包 | 在壳进程里 require `dsh-experimental-agent-team` | ❌ 包是 ESM + 依赖 cordis 上下文，且官方明确"实验性、契约可变" |
| ③ **让 Lead 调模型工具** | 通过 `session/prompt` 向 Lead 下达结构化指令，由 Lead 调用 `spawn_teammate`/`team_task_create` | ✅ **采用**。它是官方设计意图（"the model does the rest on request"），且不越界 |

**由此产生的硬约束**：

| 约束 | 内容 |
|---|---|
| **派发 = 一条结构化 prompt** | Mission 层的合同（目标/验收/约束/预算）必须被渲染成 Lead 能理解的指令，但**不生成"业务 prompt"**：我们只渲染用户填写的字段 + 固定模板，不替用户编造任务内容 |
| **写入是异步且非原子的** | prompt 被接受 ≠ 任务已创建。必须轮询 `agentTeam` 投影确认，超时则如实报"未确认" |
| **幂等靠我们自己** | 官方"no send retry guarantee"+ 我们无法直接调 `createTask` → 幂等键必须体现在 prompt 内容与本地记录，靠投影去重 |
| **不能精确指定任务字段** | `blockedBy`/`writeScopes` 依赖 Lead 是否照做。我们必须**校验投影**：Lead 没按要求建依赖时，如实显示"依赖未建立"，不假装 |
| **错误无法直接捕获** | 模型调用失败只表现为"投影没变化"。必须有超时与"未确认"状态 |

**S2 的实现形态（据此修订）**：派发面板提交 → 渲染合同指令 → `session/prompt(queue)` → 轮询投影确认 → 记录 `teamRootSessionId` + 观测到的 task id。**验收标准改为"投影中出现对应成员/任务"，而不是"接口调用成功"。**

---

## 6. 右栏视觉设计（重点）

### 6.1 现状问题（基于真实渲染的基线截图 `/tmp/rail-design/baseline-380.png`）

| 问题 | 影响 |
|---|---|
| 首屏被"需要你决策"和一个大的"交给团队"多行框占满 | 团队本身（谁在做什么）在首屏看不到 |
| 目标下面一个孤立的"改"按钮 | 看起来像布局 bug |
| Mission 状态用浏览器原生下拉 | 与深色界面不协调 |
| 提问输入框为白底 | 深色主题里突兀 |
| 用内部术语："我们拥有""Harness 拥有，只读" | 用户看不懂 |
| 下半屏是一串"还没有…"的空表单 | 病 1、病 2（空态堆叠、表单密度过高） |

### 6.2 目标结构（首屏顺序，自上而下，Task-centric）

> 原则（2026-11-03 调整，依据 0914 对话"以任务为中心"）：**用户关心的是目标与任务进展，而不是成员。** 因此进展与目标前置，团队名册后置。

```
┌────────────────────────────────────┐
│ 标题（Mission 名）      团队状态徽标 │  ← 1. 头部：一行标题 + 一个状态
│ 目标：一句话                        │
├────────────────────────────────────┤
│ 需要你 · N                          │  ← 2. 需要你（琥珀/红，永远置顶）
│  [A 提问：问题 + 选项芯片]            │     三类：提问 / 审批 / 执行冲突
│  [B 审批：动作 · 风险 · 来源成员]     │     提问→选项；审批→允许一次/总是允许/拒绝
│  [C 执行冲突：两个成员改了同一文件]    │     冲突→查看差异 / 指定一方 / 暂停
├────────────────────────────────────┤
│ 进展 · 3/7 · 1 阻塞                  │  ← 3. 任务进展（来自任务板，不自己算）
│  按任务列出：完成 / 执行中 / 阻塞      │     每个任务：标题 · 负责成员 · 状态
│  最近 2 条事件（谁 · 做了什么）        │
│  ＋ 交代新任务                       │  ← 4. 派发入口（打开面板，不是输入框）
├────────────────────────────────────┤
│ 团队 · N 人                          │  ← 5. 团队名册（来自官方 agentTeam 投影）
│  调度员  等待你回答…        等你     │     每人一行：角色 · 当前在做什么 · 状态
│  研究员  整理投影字段        工作中   │
│  程序员  等待 npm test 的审批 待审批  │
├────────────────────────────────────┤
│ ▸ 目标与约束                         │  ← 6. 折叠区：交付物、决策、笔记、Brief、记忆
│ ▸ 交付物 · 1                         │
│ ▸ 决策与笔记 · 0                     │
└────────────────────────────────────┘
```

**"需要你"的三类判定**（与 §2.4 的两层分类保持一致，冲突是新增的第三类）：

| 类别 | 判定条件 | 数据来源 | 允许的操作 |
|---|---|---|---|
| **A 提问** | 成员通过官方提问机制请求用户回答 | `userQuestions` | 选项回答 / 自定义回答 |
| **B 审批** | 动作需要批准（写入、破坏性、超出 Grant 的动作） | `approval` 与投影 `permissions` | 允许一次 / 为该 Grant 总是允许 / 拒绝 / 看原因 |
| **C 执行冲突** | 两个成员的最近变更落在同一文件，或同一文件在另一成员读后被改写（乐观并发冲突） | `workspace/changes` + 官方 `dsh-fs-observation-policy` 的拒绝事件 | 查看差异 / 指定保留一方 / 暂停相关成员。**冲突本身不由我们判定正误，只展示事实** |

> 注意：C 类依赖 S0 的 P-0.9（`workspace/changes` 是否含文件清单）。P-0.9 未通过时，C 类降级为"可能冲突"提示，不得写成"已冲突"。

### 6.3 视觉规则（必须执行）

| 规则 | 具体要求 |
|---|---|
| **宽度与字号** | 380px 单列；左右 16px；正文 13px；区块标签 11px 大写灰 |
| **颜色语义** | 琥珀 = 等你决定；蓝 = 工作中；红 = 高风险或阻塞（只有这两种用红）；绿 = 已验证；灰 = 空闲或未知 |
| **未知不显示 0** | 投影不可用时显示"团队状态未连接"；绝不显示"0 人""0 任务" |
| **不可用控件** | 置灰 + 一行原因（如"待 Harness 接口验证"）；不隐藏、不做假按钮 |
| **空态** | 一句话 + 一个动作；不堆叠解释文案 |
| **术语** | 不出现"我们拥有""Harness 拥有"；改为"你的 Mission""团队实际状态" |
| **输入框** | 统一深色；去掉白底 |
| **原生控件** | 下拉框、按钮统一为自绘样式（沿用 `--bg-input` 等 token） |
| **层级** | 靠字号与字重拉开层级，不靠滥用颜色（沿用 P4-UI-POLISH 原则） |
| **"交代新任务"** | 打开结构化面板（D3），不在右栏首屏放大号多行框 |

### 6.4 数据映射（每个可见元素对应的真实来源）

| 元素 | 数据来源 | 不可用时 |
|---|---|---|
| 团队状态徽标 | `agentTeam` 投影 + 运行时 live 状态 | "团队状态未连接" |
| 需要你 · 问题 | `userQuestions`（官方，含 options） | 回落到 office 快照文本，并标注来源 |
| 需要你 · 审批 | `approval` waterfall / 投影 `permissions` | 同上 |
| 团队名册 | `agentTeam.members`（官方） | 不显示名册区块，显示"未连接" |
| 每人"在做什么" | `agentTeam.tasks` 中 ownerName 关联的当前任务 | "暂无任务" |
| 进展 · 3/7 | `agentTeam.tasks` 计数（我们不自算 ready） | 不画进度条 |
| 阻塞数 | 官方 `blockedBy` 原样透传 | 不显示 |
| 最近事件 | `team/member`、`team/task` 事件（version 2） | 空态一句话 |
| 交付物与凭证 | Deliverable + Receipt（见 §7 S5） | "团队声称完成，未验证" |
| 需要你 · C 执行冲突 | `workspace/changes`（P-0.9）+ 文件守卫拒绝事件（`dsh-fs-observation-policy`） | P-0.9 未通过时降级为"可能冲突"提示，不写"已冲突" |
| 进展 · 按任务列出 | `agentTeam.tasks`（状态、ownerName、blockedBy 原样透传） | 不画进度条 |
| 折叠区 · 记忆 | Mission Brief 与 §14 的四层记忆（只显示 Project 层摘要，其余层按权限展开） | "暂无记忆" |

### 6.5 派发面板（D3）

打开后是一个**结构化任务书**，不是聊天框：

```
交代任务
  目标      [一句话，必填]
  验收条件  [可多条；每条选择验证方式：测试命令 / 人工确认 / 文件产出]
  约束      [可多条，例：不改官方代码]
  预算      [token 或时长上限，可留空]
  审批规则  [只读自动放行 · 写入需批准 · 破坏性必批准]（默认值，可改）
              [交给团队]
```

### 6.6 视觉验收方法

- 每个 Sprint 的 UI 改动，必须用 `/tmp`（不入库）或 `docs/quality/` 下的**真实渲染截图**验收，截图用 mock 数据但字段名与真实 IPC 对齐（本次踩过的坑：mock 字段名错导致"(没有摘要)"假象）。
- 验收截图对照本计划 §6.2 结构逐项打勾。
- 截图与设计稿必须分开存放：设计稿不算验收。

---

## 6.9 新增模块的接线状态（诚实表）

> 第一性原理：**库写好了 ≠ 功能接上了**。本项目已经有过"看起来接了、实际一条都没存"
> 的教训（TaskRef 的 append 被 schema 静默 break，见 `ipc-mission.js` 注释）。
> 所以这里逐条标注哪些模块真的被调用，哪些还只是库 —— 避免两周后有人
> 以为"凭证已经能工作了"。

| 模块 | 接入点 | 状态 |
|---|---|---|
| `src/mission/receipt.js` | `ipc-mission.js` 的 `workStatus` 返回 `receipt` | ✅ **已接线**（集成测试 2 条） |
| `src/mission/reconcile.js` | `ipc-mission.js` 的 `storeFor` 加载时对账 | ✅ **已接线**（集成测试 3 条） |
| `src/mission/intervention-audit.js` | 无 | ⚠️ **库就绪，未接线**：需要 S6 的干预 action 才能调用 |
| `src/mission/dispatch-strategy.js` | `ipc-mission.js` 的 `renderDispatchInstruction` | ✅ **已接线**：派发指令里带【执行规模】段 |
| `src/mission/approval-gate.js` | 无 | ⚠️ **库就绪，未接线**：需要 S5 的"需要你批准"UI 与 IPC action |
| `src/mission/rail-order.js` | `ipc-mission.js` 的 `attention()` 返回 `rail` | ✅ **已接线**（集成测试 7 条）：`items` 保持全量给老 UI，`rail` 分层+截断给新 UI |
| `src/mission/dispatch-confirm.js` | `ipc-mission.js` 的 `confirmDispatch` action；`startWork` 返回 `dispatchKey` | ✅ **已接线**（集成测试 7 条） |

**接线的前提**（都与待决策项相关）：
- `dispatch-strategy` → 需要派发面板 UI（S7 视觉落地的一部分）
- `approval-gate` → 需要"需要你批准"区块 + 批准交互（右栏 S7）
- `intervention-audit` → 需要 S6 的干预动作入口（暂停/停止/发消息的按钮）

**这三个不是没做完，而是"等 UI 定稿再接"** —— 先接线但没有 UI 调用点，
会变成死代码 + 假测试。它们各自的纯逻辑与负向断言已完备，
接线时应补集成测试（参照 receipt/reconcile 的做法）。

---

## 7. 分阶段路线（给 DeepSeek 执行）

> 每阶段独立可验收；前一阶段不过，不进入下一阶段。S0 是唯一必须真机完成的阶段，其余依赖它的结论。

### S0 地基：真机探针（解 #23）【**已完成第一轮**（2026-11-04）】

**目标**：确认官方 Agent Team 在真实模型下的行为，回填 ADR-0002 §9 与 `deepseek-harness-api-surface.md` §9。

> **第一轮结果**：`docs/quality/harness-agent-team-probe-2026-11-04.md`。
> 环境：隔离 POC（0.2.1-rc.5 + stepfun 真实模型），未触碰生产 profile。
> 总览：无模型探针 25 pass / 1 fail（架构事实）/ 10 needs-model；真实模型探针 **10 pass**。

| 探针 | 状态 | 实测结论 |
|---|---|---|
| P-0.1 团队创建与投影 | ✅ **PASS** | 真实模型下 `probehelper` 出现在 `agentTeam.members` |
| P-0.2 `agentTeam` 字段形状 | ✅ **PASS** | 与声明逐字段一致；`TeamMemberProjection` 只有 id/name/role/phase，**无"正在做什么"** |
| P-0.3 readiness / blockedBy | ⚠️ **部分** | 拿到 `ready:true`/空 `blockedBy`；有依赖的 DAG 未测 |
| P-0.4 成员 inbox 消息 | ✅ **已验证（第二轮，U-1）** | `send_message` 发出的暗号真实出现在会话历史里（用 follow cursor 读 page 验证）。机制成立 |
| P-0.5 任务修改/重分配 | ✅ **CAS 已验证（第五轮）** | 过期 revision 更新被拒绝，状态完全不变（revision 1→3 后仍为 3）。8 种 action 存在；reassign 的实际效果未单独测 |
| P-0.6 停止成员 | ⚠️ **接口已验证，效果需细化（U-2）** | `interrupt_agent` 被接受，但成员的 `phase` 仍是 `active` —— **phase 不反映 turn 级中断**。右栏必须区分"成员生命周期"与"turn 运行状态" |
| P-0.7 提问回流 | ✅ **文档级确认（第六轮）** | 官方 README 逐字：只 admit **runtime root**，"A live child cannot open a human interaction"。→ 提问只能来自 Lead；成员要请求决策必须经 Lead 转发。未做实测（文档已给出确定答案，实测只会重复它） |
| P-0.8 Brief 跨会话（#23） | ✅ **PASS（第三轮，8/8）** | 暗号法：随机 token 写入 AGENTS.md -> 新会话问暗号 -> 模型答对，证明真的读了文件。**#23 可关闭**。限制：需 git 仓库；仅验证启动时读到 |
| P-0.9 `workspace/changes` | ✅ **PASS（第二轮）** | 事件存在（payload 只有 `{turn}`）；文件清单经 `GET /api/changes.summary?sessionId=&seq=` 读取，实测 200 并返回 `{turn,files[],total,added,deleted}` |
| P-0.10 `session/create` 的 cwd | ✅ **PASS（部分）** | `cwd` 参数被接受并创建成功；**未验证会话真的在该目录读写** |
| P-0.11 权限预设 | ✅ **已查明（第四轮）：不可写** | `SessionCreateRequest` 只有 `{workspaceId?,cwd?,sessionId?,agentPreset?}`，**无权限字段**；`typert.host.js` 只注册 `permissionPresets/catalog`（只读）；试 set/select/apply 全 404 |
| P-0.12 `permission/preset` 事件 | ✅ **已查明：常规不产生** | 普通 turn 中不出现（官方注释：仅在预设被选择/变更时写）。我们既不能触发也不能主动制造 → 右栏只能快照式显示 |
| **新增 P-0.13** 团队功能启用条件 | ✅ **PASS** | 必须把 `dsh-experimental-agent-team-profile` 加入 profile bundles；仅装包不生效（20 键 → 21 键） |
| **新增 P-0.14** 团队写入路径 | ✅ **PASS（架构事实）** | agent-team **无 remote 表面**；写入只能经 `session/prompt` 让 Lead 调工具（见 D11） |

**产出**：`docs/quality/harness-agent-team-probe-2026-11-04.md`（已产出）。

**谁执行**：探针脚本由 DeepSeek 已执行；U-1～U-9 需要你在图形会话里配合确认（AGENTS.md §4：真机分层）。

**第二轮待办**（不阻塞 S1/S2，但阻塞 S5/S6）：U-1～U-9 逐项补齐，脚本骨架已在 `scripts/poc/s0-model-probe.js`。

### S1 升级运行时到 0.2.x（能力探测）【**部分完成（2026-11-04）**】

- ~~解除 `runtimeVersion` 锁（`src/runtime-manager.js`），改为能力探测。~~
  **已完成（更早）**：`src/runtime-capability.js` 早已用能力矩阵取代版本号判决。
  实测 `judge('0.2.1-rc.5') === 'supported'`、`canRun(...).allowed === true`。
  **结论：版本锁不是门禁**。`package.json` 的 `runtimeVersion` 只是打包默认值，
  是否把它切到 0.2.1 属于**发布决策**（用户拍板），不是代码阻塞。
- ~~补映射：`forked` turn 结束原因~~ **已完成（2026-11-04）**：
  `src/team/runtime/dsh-execution-backend.js` 新增 `case 'forked'` → `execution/cancelled`（reason 保留 `forked`）。
  依据官方原文（`dsh-session/types.d.ts`）："Only fork seeds carry this marker — the loop never emits it"。
  修复前它落到 default → `attention(unknown-reason)`，把一次 fork 误报成"需要你处理"。
  测试：`test/dsh-execution-backend.test.js`（3 条），变异验证 DETECTED。
- **`agentAvailable === false` 过滤：评估后判定为"不需要改"**。
  理由：`officeFollowSyncTick` 只对**办公室绑定台账**里的会话开 follow（不是 session list 全量），
  且已有 `OFFICE_FOLLOW_MAX_REOPENS = 3` + `officeFollowUnfollowable` 阻止无限重试。
  `agentAvailable` 的语义是"当前是否拥有活跃 Agent"（闲置会话也为 false），
  拿它当过滤条件会**误伤闲置会话**。保留现状，在诊断里报数即可。
- ✅ **新事件不再静默透传（2026-11-04 已完成）**：
  `src/main.js` 新增 `officeUnmappedEventStats` + `noteOfficeUnmappedEvent()`，
  对**没有专门翻译分支**的 journal 事件按 type 计数（只记事件名与次数，
  绝不记 payload —— 隐私铁律）。`OFFICE_TRANSLATED_EVENT_TYPES` 白名单显式列出
  当前已翻译的 10 个类型，防止"既翻译又计数"导致数字失真。
  计数进入诊断包 `office-diagnostics.json` 的 `unmappedJournalEvents`
  （上限 32 行，`MAX_UNMAPPED_EVENT_ROWS`），README 字段清单同步更新。
  用途：升级后判断"workspace/changes / permission/preset 到底发没发事件"，
  而不是靠猜。测试：`test/diagnostics-bundle.test.js`（4 条），变异验证 DETECTED。
- ✅ **运行时激活探测（2026-11-04 已完成）**：
  `src/main.js` 新增 `probeOfficeTeamActivation()` —— 读一次 followed session 的
  `session/projections`，看 `values` 里有没有 `agentTeam`，返回
  `enabled | not-activated | runtime-offline | unknown` 四态（结果缓存，
  mux ready 时失效重探）。
  **为什么不猜**：没有 followed session 时返回 `unknown` 而不是
  `not-activated` —— 什么都没跑的时点报"未启用"，会让用户去翻一个没问题的设置。
  结论进入诊断包 `environment.json` 的 `teamActivation`
  （只有 state / projectionKeys / reason，无 session id、无路径）。
  测试：`test/diagnostics-bundle.test.js`（3 条），变异验证 DETECTED。
- 验收：CI `upstream-compat` 绿；`CI=1 npm test` 全绿（当前基线 **3009 passed / 0 failed / 1 skipped**）。

### S2 合同化派发（D3）【**部分完成（2026-11-04）**】

**已完成（纯逻辑层，可离线验证）：**
- ✅ **合同数据模型**（`src/mission/schema.js`）：
  - `contract` 是 Mission 的可选字段（老 Mission 无合同仍有效 —— 升级不是迁移）。
  - `acceptance[]` **至少一条**，否则拒绝："a contract with no acceptance test
    cannot decide when the work is done"。
  - `kind` 是闭集 `command|artifact|manual`；`command` 必须带 `command`，
    `artifact` 必须带 `artifactRef`（只写 kind 等于没有验证方式）。
  - `budget.maxTokens/maxWallMs` 可空（空=不限），0 合法，负数/NaN 拒绝。
  - `grantId` 必须是 `gr-<opaque>`（**永远不是路径**）。
  - `status` 闭集 `draft|dispatching|active|ended`；`strategy` 闭集
    `single|sequential|parallel`。
  - 测试：`test/mission-schema.test.js`（11 条），变异验证 DETECTED。
- ✅ **顺带修复一个失效的隐私防线**：`PRIVACY_FORBIDDEN_FIELDS` 此前
  **只定义未使用**（`cwd` / `absolutePath` 从未被真正拦截）。
  新增 `collectPrivacy()` 并在 `validateMission` 中执行。语义与
  `collectForbidden` 分开（前者=敏感数据，后者=事实作者唯一）。
- ✅ **派发指令渲染**（`src/ipc-mission.js` 的 `renderDispatchInstruction`）：
  - 幂等键在**固定首行** `[mission-dispatch:<key>]`，`parseDispatchKey` 往返可验。
  - 验收条件逐条渲染，并写明验证方式（command 显示要跑的命令、
    artifact 显示产物路径、manual 标明由人确认）。
  - 有合同时要求 Lead 用 `team_task_create` 把验收条件落板
    （只在对话里承诺 = 右栏与 Harness 都读不到）。
  - 无合同时输出与旧行为一致（除首行幂等键）——**老 Mission 派发不受影响**。
  - 测试：`test/mission-agent-team.test.js`（7 条），变异验证 DETECTED。

**仍未完成（需要更多设计或真机）：**
- ✅ **派发确认的判定逻辑已完成**（`src/mission/dispatch-confirm.js`）：
  四态 `pending / confirmed / unconfirmed / rejected`，判据是**投影里有没有我们那个 key**。
  关键措辞约束：`unconfirmed` 绝不说成"失败"（那会让用户重复派发、凭空多出团队）；
  只有运行时**明确拒绝**才算 `rejected`。测试 11 条，变异 DETECTED ×2。
- ✅ **`confirmDispatch` action 已实现（2026-11-04）**：
  `startWork` 返回 `dispatchKey`（不返回 raw sessionId，隐私规则），
  UI 拿它调 `confirmDispatch` 轮询确认。四态与措辞约束见 `dispatch-confirm.js`。
  集成测试 7 条，变异 DETECTED ×2。
  **不持久化 dispatchKey 的理由**：派发确认是"一次尝试的短期状态"，不是 Mission 长期事实；
  持久化要扩展 schema（TaskRef 还要求 workstreamId 必填），成本远大于收益。
- ⬜ 右栏 UI 调用 `confirmDispatch`（S7）。
- ⬜ 派发面板 UI（右栏结构化表单）。
- ⬜ Grant 存储与 `grantId` 的实际创建/撤销流程。
- ✅ **派发策略的确定性判定（2026-11-04 已完成）**：`src/mission/dispatch-strategy.js`
  - 五条规则，**约束优先、机会最后**：
    ① 预算只允许 1 人 → 单成员（硬约束最高优先）
    ② 有共享写入范围 → 单成员（冲突代价 >> 并行收益）
    ③ 有依赖 → 顺序链（能拆但不能同时跑）
    ④ 多个独立验收条件 → 并行（**唯一**适合并行的形状）
    ⑤ 其余 → 单成员
  - **默认必须保守**：无预算声明时 `memberBudget` 默认 1，所以空输入得到
    `single-budget` 而不是并行。猜错的代价不对称（多起成员=浪费+冲突）。
  - `resolveStrategy()` 允许用户覆盖，但标记 `source:'user'` ——
    事后必须能区分"系统判的单成员"和"用户改成单成员"，否则无法评估规则准度。
  - 测试：`test/mission-dispatch-strategy.test.js`（12 条），变异验证 DETECTED ×2
    （默认预算放大 / 忽略共享范围）。

- 新增 Mission 合同模型（目标、验收条件、约束、预算、审批规则），schema 放 `src/mission/schema.js`。
- 派发面板替换 `startWork` 的"发一段文本"路径。
- **派发路径按 D11 修订**：**不能**直接调用 `createTask`（无 remote 表面）。实际路径是
  `合同字段 → 渲染为结构化指令 → session/prompt(queue) → 轮询 agentTeam 投影确认 → 记录观测到的 task id`。
  接口调用"成功"不算派发成功，**投影出现对应成员/任务**才算。
- 派发带幂等键（借鉴 OpenDots `invocationId`）：键写入 prompt 的固定首行标记（如 `[mission-dispatch:<key>]`），
  确认阶段用该标记匹配已存在的任务，避免重复派发。
- **失败语义**：prompt 被拒绝 → 明确失败；prompt 被接受但超时未出现在投影 → 显示"已下达，未确认"，
  不显示"已派发"。这是模型不可控带来的真实状态，必须如实呈现。
- **工作目录接线（D9）**：派发面板的"目录"控件，选已有目录或在工作区根下新建子目录；路径在 Mission 绑定时解析为工作区相对路径，会话创建时传入 `SessionCreateRequest.cwd`（依 P-0.10）。绝对路径不进事件链。
- **权限控件（D8）**：面板保留"权限"选择（只读 / 工作区内写 / 完全权限）。在 P-0.11 通过前置灰，并写明"待 Harness 权限接口验证"；通过后再启用并传入会话创建参数。
- **派发策略（2026-11-03 新增）**：派发前先判断任务结构，**不默认起多个成员**。规则：
  - 任务可拆分且子任务相互独立 → 允许并行多成员；
  - 子任务存在先后依赖，或修改同一组文件 → 单成员顺序执行，或拆成有依赖的任务链；
  - 简单问答或单点修改 → 单成员，不建团队。
  - 判断由**确定性规则**完成（依据任务描述中的依赖标注、Grant 覆盖的文件集合），而非再交给一个 LLM 决定。LLM 判断只能作为建议显示，用户可改。
  - 依据：Google Research 180 配置实验的结论（**按博客摘要引用**：并行任务上集中式多 Agent 相对单 Agent 提升明显，顺序推理任务上反而下降）。全文未核实，不作为定量依据，只作为设计假设。
  - 验收：同一任务在"单成员 / 多成员"两种策略下的 token 与完成情况有对照记录（S4 之后做，作为默认策略是否启用的依据）。
- 验收：端到端 — 面板提交 → Harness 团队中可见对应任务 → 重复提交不产生第二份任务；目录新建后，会话的读写确实落在该目录（P-0.10）。

### S3 映射与投影（解决"不互相孤立"）

- Mission ↔ 官方 Team root session 映射（复合键 `teamRootSessionId + taskId + revision`，沿用 `task-ref.js`）。
- 办公室读 `agentTeam` 投影；移除"只读自研 facts"的依赖。
- **单 Mission 座位（D7）**：办公室仍使用固定座位模板（`EMPLOYEE_IDS` / `RESIDENT_EMPLOYEE_IDS`），但座位的"成员身份与状态"改由官方 `agentTeam.members` 填充；成员数超过模板座位时，多出的成员进入"名册列表"（右栏），不硬塞进办公室。座位动态化不在本阶段范围。
- 自研 Team Runtime 按 ADR-0002 R0–R4 处理（映射表、数据归档、等价性对照、测试重定位、标记 legacy）。
- 验收：办公室与 Harness 两侧团队状态一致（对照截图 + 投影快照）。

### S4 耐久恢复【**纯逻辑层已完成（2026-11-04）**】

> **结论：不采用 OpenMuse 的 lease 模型 —— 我们的场景里没有抢占。**

**为什么不照搬租约（第一性原理）**：

OpenMuse 的 `leaseId` + `leaseUntil` + `LostLeaseError` 解决的是一个具体问题：
**多个 worker 进程抢同一个任务**，所以必须保证同一时刻只有一个执行者。

我们的场景不成立：
- 执行者是 Harness（官方），我们不调度、不重试、不重跑。
- 没有两方抢任务，就不会有"被接管的旧 worker 继续写"的窗口。
- 照搬 lease 只会引入一堆永远走不到的分支（心跳、续租、接管、LostLease 处理）。

**真实问题只有一个**：进程在中间态崩溃后，那个中间态永远卡住。
例如合同 `status='dispatching'`（正在派发确认）时进程被杀 ——
它既没成功（没有 taskRef），也不会继续（等待循环在内存里，已随进程消失）。

**已实现**（`src/mission/reconcile.js`，纯函数 + 一处接线）：
- `reconcileContract()`：把**唯一**不可能再推进的状态 `dispatching` 回退为 `draft`，
  并写入 `interruptedAtMs` / `interruptedReason`（没有这行痕迹，用户会以为是自己改的）。
- **`active` 永不降级**：合同进入 active 后推进责任在 Harness；重启只让我们失去观测，
  不等于工作停了。因为自己看不见就宣布失败，是拿失明当别人的过错。
- `dispatchProgress()`：运行期兜底 —— 派发超时返回 `unconfirmed` 而**不是 failed**
  （说"失败"会让用户重复派发、制造重复任务）。
- 接线：`ipc-mission.js` 的 `storeFor()` 在 store 刚建好时跑一次（进程生命周期里唯一
  确定"上个进程已死"的时点）；失败不阻断（对账是修复，不是使用前提）。

**测试**：`test/mission-reconcile.test.js`（15 条，含 3 条走真实 `registerMissionIpc`
的集成测试 —— 防止"纯函数对了但没接上"，本项目有过 TaskRef 静默失效的教训）。
变异验证 DETECTED ×3（active 加入中断列表 / 回退成 active / 摘掉接线钩子）。

**✅ 团队状态的持久性已实测（2026-11-04 第六轮，U-9 9/9）**：
杀掉运行时后用同一 DSH_HOME 重启，roster（含 `phase`）与任务板（含 subject/status/ready）
**全部还在**，session 也仍在 `session/list` 里。
→ 我们**不需要自建团队持久化**，官方 jsonl persistence 已覆盖。
边界：同机同 HOME；跨机器迁移未验证；重启时正在跑的 turn 未验证。

**仍未完成**：
- ⬜ 守护进程形态（D4）本身：当前对账在 app 启动时执行；后台守护是独立工程。
- ⬜ 团队侧对账（把 Mission 合同与 Harness `agentTeam` 状态比对）依赖 S3。
- 验收（部分达成）：模拟卡住的 dispatching → 重载后自动回退为 draft 且内容不丢。

### S5 凭证与审批闸门【**部分完成（2026-11-04）**】

> **S0 第二轮实测把这里的关键假设推翻了：不需要自建文件变更捕获，也不要自建指纹。**
> 证据：`docs/quality/harness-agent-team-probe-2026-11-04.md` §9.3。

**已确认的官方路径（实测 200）**：
- 每个 top-level turn 结束会 append 一条 `workspace/changes` 事件，payload **只有 `{turn}`**。
- 文件清单在 Host 端按事件 `seq` 索引，客户端通过认证路由读：
  `GET /api/changes.summary?sessionId=&seq=` → `{turn, files[], total, added, deleted}`
  `GET /api/changes.diff?sessionId=&seq=&index=` → 单文件 unified diff
- 实测响应：`{"turn":1,"files":[{"path":"probe-s5.txt",...,"added":1,"deleted":0}],"total":1,"added":1,"deleted":0}`

**凭证设计（据此修订）**：
- 凭证坐标 = `{sessionRef(派生句柄), seq, turn}` —— **不是文件指纹**。
  用坐标去问 Host，得到官方算的清单；我们不重算 diff（否则是第二个事实作者）。
- 三态：`claimed`（团队声称，无可复核坐标）/ `verified`（坐标可复核且 Host 仍能读）
  / `stale`（曾经有坐标，现在读不到）。**没有 `done`** —— 完成是人的判断。
- 已实现纯函数层：`src/mission/receipt.js`
  （`buildReceiptCoordinate` / `isReceiptAddressable` / `deriveReceiptState` / `describeReceipt`）。
  测试 `test/mission-receipt.test.js`（10 条），变异验证 DETECTED
  （把 stale 合并成 verified → 2 条失败）。
- **限制**：清单仅保留到 Session dispose，Host 重启后 404。
  → 凭证必须在 turn 结束后**立即落盘**，不能事后再查。这一条决定实现顺序。

**显式交付（官方已有，不重造）**：
- `dsh-tool-present` 提供 `present({files:[{path,description?}]})`，
  模型用它声明最终产物；记录路径与描述、**不复制内容**。
- 我们的 Deliverable 应消费 `present` 的声明（"团队说这是交付物"）
  + `changes.summary` 的事实（"这次确实改了这些"），两者互补，缺一不可。

**仍未完成**：
- ✅ **提案-批准闸门（2026-11-04 已完成）**：`src/mission/approval-gate.js`
  - 三个漏洞分别封堵：① 批准必须提交**内容 hash**（"模型提议了 A，人正在读，
    模型又提了 B，人点批准"→ 批准的是哪份？）；② TTL 30 分钟，
    过期是**记录下来的状态**而非每次推算；③ 幂等键让重试不产生第二张卡片。
  - 动作种类闭集 6 种（`command.run` / `file.write` / `file.delete` /
    `message.send` / `task.create` / `member.spawn`）。
  - 本模块**不执行**任何动作 —— 执行是 Harness 的事。
  - 测试：`test/mission-approval-gate.test.js`（13 条），
    变异验证 DETECTED ×2（摘掉 hash 校验 / 摘掉过期校验）。
- ⬜ 凭证落盘与失效检测（依赖 turn 事件订阅）。
- ⬜ `present` 声明与 Deliverable 登记的对接。
- 验收（未达成）：修改一个文件后，旧凭证自动降级为 stale。

### S6 纠偏与干预【**审计层已完成（2026-11-04）**】

- ✅ **干预审计**（`src/mission/intervention-audit.js`，纯函数 + 有界环形缓冲）：
  - 动作闭集 9 种：`mission.paused/resumed/stopped`、`member.messaged/interrupted`、
    `task.reassigned/rewritten`、`contract.dispatched/revoked`。
  - 原因闭集 7 种（`user-request` / `drift-suspected` / `conflict` /
    `budget-exceeded` / `blocked` / `correctness` / `other`）。
  - **故意没有自由文本字段**：一旦有 `note`，迟早有人把 prompt/任务描述塞进去，
    审计日志本身就成了泄露面。闭集牺牲表达力，换来"审计永不泄露正文"的硬保证。
  - 环形缓冲 200 条，超出计数 `dropped`（不静默丢弃）。
  - 测试：`test/mission-intervention-audit.test.js`（11 条，含"自由文本不得被存下"
    和"reason 不接受任意字符串"两条负向断言），变异验证 DETECTED ×2。
- ⬜ 对具体成员发消息（U-1 已验接口可读层面，但发消息的**产品动作**未接 UI）。
- ⬜ 暂停 / 恢复 Mission；停止成员（U-2 已验证 `interrupt_agent` 接口存在）。
- ⬜ 改写任务描述或重新分配（U-4 未验 CAS 冲突）。
- ⬜ 审计落盘（当前是内存缓冲；落盘涉及格式版本/轮转/隐私扫描，属独立工程）。
- 验收（未达成）：真机纠偏探针 + 审计记录可查。

### S7 右栏视觉落地【**数据层已备（2026-11-04）**】

- ✅ **"需要你"的分级与排序抽成纯函数**（`src/mission/rail-order.js`）：
  - 现状问题：排序规则内联在 `attention()` 与 `mission-desk.html` 里，
    导致三条关键判断**无法被测试**——哪些属于"需要你"、同层谁先谁后、空态说什么。
    这三条恰恰是"红色泛滥 → 用户学会无视红色"的病根。
  - **两层严格分开**：`decision`（阻塞团队：approval / question / plan-review /
    conflict）vs `reminder`（不阻塞：inbox / permission-risk / blocked / stale-owner）。
    提醒**不进决策计数**，否则第一层被稀释。
  - 层内排序：风险高 → 等得久 → kind 优先级。**缺失风险按 medium 处理**，
    不把未知当低风险（那是拿猜测当事实）。
  - 首屏最多 3 条决策，`overflow` 给出被隐藏数量（不静默丢弃）。
  - **最危险的空态已处理**：数据源缺席返回 `tone:'unknown'` 而不是 `calm`。
    运行时没连上时显示"团队运行正常"会让用户以为一切安好，实际我们什么都没看到。
  - 测试：`test/mission-rail-order.test.js`（13 条），变异验证 DETECTED ×2。
- ⬜ 右栏 UI 改造（`mission-desk.html`，2395 行）—— 需要用户先确认视觉方案。
- ⬜ 把 `renderAttention` / `renderTeamTasks` 改为消费 `rail-order` 的输出。


- 按 §6 实施：首屏结构、颜色语义、术语、派发面板、空态、未连接状态。
- 验收：真实渲染截图逐项对照 §6.2 与 §6.3；mock 字段与 IPC 对齐。
- **S7 可以与 S2–S3 并行开始**（只依赖投影形状，S0 给出后即可）。

### 阶段依赖

```
S0 ──┬── S1 ── S2 ── S3 ── S4 ── S5 ── S6
     │                    └──────────── S7（与 S2–S3 并行）
```

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 官方 `agentTeam` 字段与声明不符 | 中 | 高 | S0 先行；投影层字段白名单 + 缺字段降级，不伪造 |
| 官方 experimental API 破坏性变更 | 高 | 中 | 只通过客户端视图与事件消费，不 import 内部模块（ADR-0002 §8） |
| 两套团队并存期间状态不一致 | 高 | 中 | 明确官方路径为唯一写入者；自研编排默认关闭 |
| 团队 token 消耗高，常驻放大成本 | 高 | 高 | 每个 Mission 有预算上限（D6）；超限暂停并通知 |
| LLM 判断偏航误报，用户学会无视 | 中 | 高 | 偏航优先用客观信号（测试、指纹、diff）；LLM 只作辅助，标注置信度 |
| Mac 上无沙箱，团队可改任意文件 | 中 | 高 | D2：如实标注"未隔离"；写入需批准；工作区限定在 Mission 目录 |
| 右栏视觉回退到档案表单 | 中 | 中 | §6.6 截图验收；设计稿不算验收 |
| 借鉴的代码许可证问题 | 低 | 高 | 只借鉴语义，不复制代码；引入任何代码前过 `check:licenses` |

---

## 9. 验收标准（整体）

1. **可见性**：派发的任务在 Harness 的团队里可见（同一 teamRootSessionId）。
2. **可决策**：提问与审批在办公室可回答，回答回到 Harness。
3. **可修改/停止**：纠偏与停止有真机证据（S0 产出），失败项如实列出。
4. **耐久**：关闭 app 再开，团队与 Mission 仍然一致。
5. **可信**：每个"完成"都能指出凭证，或明确标注"未验证"。
6. **可读**：右栏首屏按 §6.2 结构，无空态堆叠；截图逐项通过。
7. **不伪造**：任何未连接的数据显示"未连接"，不显示假数字。
8. **门禁**：`CI=1 npm test` 全绿；docs-index 测试通过；ADR-0002 R0–R4 有证据。

---

## 10. 需要你拍板的事项

| # | 问题 | 我的推荐 | 你的选择 |
|---|---|---|---|
| 1 | 批准本计划，进入 S0 | 批准 | ⬜ |
| 2 | D1 团队形态：每 Mission 一支团队 | 同意 | ⬜ |
| 3 | D2 Mac 无沙箱：先标注未隔离 | 同意 | ⬜ |
| 4 | D3 派发用结构化面板，不用聊天框 | 同意 | ⬜ |
| 5 | D4 常驻：app 开着 + 可选守护进程 | 同意 | ⬜ |
| 6 | D6 审批默认：只读放行，写入/破坏性需批准 | 同意 | ⬜ |
| 7 | 右栏视觉 §6 作为 S7 的验收依据 | 同意 | ⬜ |
| 8 | S0 真机探针由你在图形会话里确认 | 同意 | ⬜ |
| 9 | D7 办公室范围：第一阶段只支持单 Mission | **已决定（用户 2026-11-03）：单 Mission** | ✅ |
| 10 | D8 权限控件：保留，S0 验证前置灰 | **已决定（用户 2026-11-03）** | ✅ |
| 11 | D9 工作目录：允许新建（限工作区根之内） | **已决定（用户 2026-11-03）** | ✅ |
| 12 | D10 Grant 模型替代"派发时选目录 + 选权限" | **已确认（用户 2026-11-03）** | ✅ |
| 13 | Tobs 作为正式参考对象：深入研究设计，复制代码前过 `check:licenses` | **已确认（用户 2026-11-03）** | ✅ |
| 14 | 首屏 Task-centric 调整、"执行冲突"第三类、派发策略、§14–§17 | 已写入计划（2026-11-03）；随计划一并批准 | ⬜ |

> 注：第 2 项"每 Mission 一支团队"与 D7 并不冲突：团队是按 Mission 建的，但第一阶段办公室只呈现当前这一个 Mission 的团队。

---

## 11. 本计划的局限（诚实标注）

- **官方 agent-team 行为未运行验证**：本计划所有依赖 Agent Team 的条目都标在 S0 之后。ADR-0002 §11 同样标注。
- **三个开源项目只读分析**：分析基于代码阅读，未运行。`elie222/rakazo` 克隆失败，实际读的是 `shuv1337/rakazo` 副本（README 一致）。
- **OpenAI Dots、Grok Bot、Antigravity Teamwork 的细节来自公开资料**，部分无法直接核实官方文档（Antigravity 的 `teamwork.md` 已核实；Dots 来自 VentureBeat 报道）。
- **视觉稿是静态渲染**：`/tmp/rail-design/` 中的截图为 mock 数据，不代表真实运行效果。
- **未修改任何代码**：本计划仅新增本文件。`docs/README.md` 索引需同步登记（见 §12）。

---

## 12. 文档与执行约定

- 本计划登记于 `docs/README.md` §4 "计划与报告"。
- 批准后，S0 的探针报告放 `docs/quality/`，并登记索引。
- 每阶段完成后更新 `docs/product/delivery-status.md`（唯一进度来源）。
- 任何代码改动遵守 AGENTS.md §4（计划先行、变异纪律、真机分层）与 §6（Git 安全，禁止 `git add -A`）。
- 计划批准前，DeepSeek 不得开始实施 S1 及以后的阶段。

---

## 13. 延后研究项：多 Mission 动态加载（另开会话）

> 状态：**延后**（2026-11-03 用户决定：第一阶段只做单 Mission，动态加载另开会话研究）。

第一阶段办公室只呈现当前一个 Mission 的团队。以下问题留待单独研究，**本计划不包含其实施**：

| # | 研究问题 | 为什么延后 |
|---|---|---|
| R-1 | 切换 Mission 时，办公室座位与角色如何替换，是否需要整屏重建 | 动态替换有加载与状态丢失风险 |
| R-2 | 多个团队同时在线时的渲染与内存成本（PixiJS 场景数、角色动画数） | 性能风险，需实测 |
| R-3 | 切换期间正在运行的团队是否保持运行、是否需要后台保活 | 与 D4 常驻形态相关 |
| R-4 | 多 Mission 的导航形态（门牌、分层、标签页）与 380px 右栏的关系 | 视觉与信息架构需单独设计 |
| R-5 | 座位数量是否按成员动态生成，与固定模板如何共存 | 影响 `EMPLOYEE_IDS` 的契约 |

研究产出应是一份独立设计文档，经用户批准后再排入实施阶段。

---

## 14. 记忆分层（2026-11-03 新增，依据 0914 对话 §四·2）

> 原则：记忆不能全部塞进同一个上下文。每一层有**明确的作用域、权限和生命周期**。

| 层 | 内容 | 作用域 | 生命周期 | 谁可写 | 在本计划中的对应 |
|---|---|---|---|---|---|
| **Personal** | 用户偏好、习惯、长期目标 | 跨所有 Mission | 长期，用户可删 | 用户；Lead 只能提议 | 暂不实现（§16 的研究项） |
| **Project** | Mission 背景、已确认决策、技术方案 | 单个 Mission 内所有成员可读 | 与 Mission 同生命周期 | 用户；Lead 可记录"已确认事实"，需用户确认后生效 | **Mission Brief**（S2/S3 已有基础） |
| **Agent** | 某类工作积累的经验（如某构建问题的解法） | 同一成员身份内 | 可过期、可清空 | 该成员；用户可查看与删除 | 暂不实现，记入 §16 |
| **Execution** | 真正执行过什么、产生什么结果（命令、测试、审查记录） | 只追加，不改写 | 永久审计，但可按 Mission 归档 | 系统自动记录（只读给人与成员） | **Work Receipt 与执行记录**（S5） |

**关键约束**（沿用 AGENTS.md 的"事实作者唯一"）：
- Execution 层是唯一由系统写入的层，它是"交付凭证"的依据，不能由成员自我声明覆盖。
- Project 层的"已确认决策"只能由用户确认生效，不得因 Lead 的推断自动升级。
- 成员读取 Project 层时只读 Brief 的摘要，不读其他成员的 Agent 层；Agent 层不跨成员共享。
- 上下文注入的范围由层级决定：成员启动时只注入 Project 层 + 自己的 Agent 层；Execution 层按需查询，不常驻上下文。

**与 P-0.8 的关系**：S0 的 P-0.8（Brief 是否在新会话启动时被读到）直接决定 Project 层是否真实有效。P-0.8 未通过前，Project 层只能显示为"已写入，未验证被读取"。

---

## 15. 竞争与差异化（2026-11-03 新增）

> 原则：DshCockpit 不与个人助理产品比"谁的对话更好"，而是在"谁能让一支团队可靠地完成项目"上建立差异。

| 项目 | 形态 | 与 DshCockpit 的关系 | 我们借鉴什么 | 我们不做什么 |
|---|---|---|---|---|
| **Tobs（BotHarness/DeepSeekBot）** | DSH 插件，MIT；多 Bot 身份、Git 记忆、Assignment 委派、群聊、定时任务、Bot 市场、IM 接入 | **最直接的竞争者与参考对象**。同样建立在 DSH 之上 | Workspace Grant 模型（D10）、Orchestrator/Assignment 分离、Git 记忆的可审阅性、三动作审批 | 不做 IM 接入、不做 Bot 市场、不做多平台身份 |
| **Rakazo** | 自托管 Grok Bot 平替，TS；Pi 运行时，多 Provider 沙箱 | 个人助理形态，不建立在 DSH 上 | 派发幂等（spawnKey）、共享/私有电脑的隔离模型 | 不嵌入自己的运行时（违反 ADR-0002） |
| **OpenMausBot** | 桌面端，聊天花名册，Claude/Codex CLI | 聊天形态 | 统一的执行事件流（不同引擎共用一套界面） | 不做聊天主界面（ADR-0001） |
| **Overtime** | 独立计算机与浏览器，面向代码 Agent 集群，强调可见的执行步骤与代码差异 | 与我们的"可见执行"目标最接近 | 执行步骤、代码差异、实时屏幕的呈现思路 | 不做 Claude Code / Codex 的直接绑定，不做终端 UI |
| **Paperclip** | 组织结构、目标、预算、任务协调；把多 Agent 当"公司"管理 | 治理视角 | 预算硬上限（超过自动暂停）、目标与任务的对齐 | 不做组织架构图作为主界面 |
| **OpenDots（diggerhq）** | 协调者 + 主题 Worker，笔记与对话分离 | 委派模型 | 笔记与对话分离（Project 层与 Execution 层） | 不依赖云端计算机作为默认 |
| **OpenMuse / OpenDots（Shashankss1205）** | 耐久执行、审批闸门、指纹绑定 | 执行语义参考 | 见 §2 | 不照搬其运行时 |

**DshCockpit 的差异化边界（四条，缺一不可）**：
1. **桌面工作空间**：以项目与目录为中心，不以聊天为中心。
2. **项目级任务治理**：目标、验收、预算、Grant 与审批规则属于 Mission，不属于某个 Bot。
3. **真实执行可见**：每个状态来自 Harness 投影或执行记录，不来自动画或自我声明。
4. **成果可验证**：交付凭证（Receipt）绑定文件快照与命令，而不是"Agent 说完成了"。

**风险提示**：Tobs 的文档量与工程成熟度都远超本项目，且已有 DSH 0.2.x 支持。我们若只做"多 Bot 管理界面"，会直接与其重叠。因此 DshCockpit 的第一阶段（S0–S7）必须坚持四条差异化边界，不得扩展到 IM 接入与 Bot 市场。

---

## 16. 个人助理作为长期入口（Phase 0 之后的独立研究项，不进入 S0–S7）

> 状态：**延后研究**（2026-11-03）。来源：0914 对话"个人助理 → 个人团队"的判断。

**问题**：用户是否需要一个长期存在的"主入口"（个人助理），用来理解目标、记住偏好、决定派发给哪支团队？还是直接由办公室承担入口？

**为什么不进 S0–S7**：
- 个人助理作为入口，会引入一个新的长期身份实体（Personal 层记忆 + 主动提醒 + 主对话），与 D3（派发面板而非聊天框）和 ADR-0001（不做通用聊天客户端）存在张力。
- 在没有验证"派发—执行—验证"闭环之前，增加入口层只会扩大范围。

**研究问题**（独立设计文档产出，经用户批准后再排期）：

| # | 问题 |
|---|---|
| A-1 | 入口是"办公室里的一个固定角色"（Lead 即助理），还是独立于团队的个人对象？ |
| A-2 | 助理与 Lead 的边界：谁负责"理解目标"，谁负责"组织执行"？ |
| A-3 | 主动推进（定时、事件触发）是否属于助理，还是属于 Mission？ |
| A-4 | 助理的 Personal 层记忆如何与 §14 的 Project 层隔离？ |
| A-5 | 与 Tobs 的 Orchestrator 对比：是否重复造一个 Orchestrator？ |

**进入排期的前提**：S0 完成，S2（派发）与 S5（Work Receipt）已可用，且真实用户反馈表明"派发—验证"闭环是瓶颈。

---

## 17. 对 13 节 R 表的补充：固定团队 vs 动态团队的判断标准

0914 对话提出"固定团队 / 动态团队共存"。在 §13 的研究中，判断一个任务应使用固定还是动态团队，依据以下确定性条件（**不由 LLM 决定**）：

| 条件 | 倾向 |
|---|---|
| 同一 Mission 内反复出现相同角色的工作（如每次都要审查） | 固定角色（长期成员） |
| 一次性的并行子任务（如调研 N 个独立方案） | 动态成员（任务结束即释放） |
| 需要跨多次执行保持上下文 | 固定成员，并保留其 Agent 层记忆（§14） |
| 子任务之间有依赖 | 单成员顺序或依赖链，不做并行成员 |

该判断属于 §13 R-5 的输入，不改变 S0–S7 的范围。
