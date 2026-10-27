# WORK-FIRST V0.7 —— 从"看团队"到"用团队工作"

状态：**草案（待拍板）** · 日期：2026-10-27 · 依据：OpenAI《Harness engineering: leveraging Codex in an agent-first world》(2026-02) + 本项目 v0.6 现状

## 0. 一句话

**一等公民从"员工"变成"工作产物"**：团队必须产出落在用户真实工作区里、可打开、可验证、可追溯的工作物；办公室降为这份工作图的氛围投影与状态解释器；工作台成为主交互面。验收标准只有一条——一个新手第一次使用时，5 分钟内拿到一份**真实可用**的产物，而不是看完一场动画。

## 1. 问题陈述（为什么现在是花瓶）

| # | 根源 | 现状证据 | 文章中的对应原则 |
|---|------|----------|------------------|
| 1 | 办公室展示"存在感"而非"工作" | Team fact 有 role/status/kind/phase，没有工作产物本身；快照里看不到任何用户可用的东西 | 输出必须可读；智能体看不到的不存在 |
| 2 | Worker 是单轮文本生成器 | researcher = 一个模板 prompt → 一段 Markdown；reviewer = 一个 prompt → 结论；无工具、无工作区、无自检、无迭代 | harness 循环：执行→自审→评审→迭代→验证 |
| 3 | 产物是死胡同 | materializer 写 `userData/team-artifacts/<jobId>/notes.md`，任务结束后用户拿不到可继续使用的东西 | 知识/产物必须版本化进真实工作区 |
| 4 | 交互只有"输入主题→看状态线" | 无任务清单、无计划确认、无产物检视、无干预点（除"继续"） | 人类掌舵：描述任务、给边界、抽查结果 |

结论：视觉不是主要矛盾。**把工作做真**之后，办公室才有可展示的内容；反之先美化视觉只会更快暴露空洞。

## 2. 设计原则（借自 harness engineering，逐条落到本项目）

1. **人类掌舵，智能体执行**：人负责目标、边界、验收与抽样；执行、自检、迭代交给 team。
2. **工作必须可读**：任何 layer 的产出都要以用户可理解的形式存在（文件、diff、证据、决策记录），不能只有状态词。
3. **机械强制，不微观管理**：边界（能改哪里/不能碰什么/必须过什么验证）用门禁强制；具体怎么做留给模型。
4. **给地图，不给手册**：任务上下文 = 目标 + 地图（相关文件/约束/先例的索引），不是几千字长文。
5. **计划是一级工件**：复杂任务先产出计划（含进度与决策记录），随工作物一起落盘、可审阅。
6. **验证必须来自真实执行**：测试/构建/lint 的退出码与摘要才是证据；模型自述"通过"不算。
7. **为可读性优化环境**：工作区、日志、产物先按"人和智能体都能读懂"设计，再谈自动化。

## 3. Work Product 模型（规范）

### 3.1 对象

```
Workspace  用户选定的真实目录（默认 ~/DshWorkspaces/<workspaceId>/，可指向已有项目）
WorkItem   一次团队任务：goal（用户原话）+ boundaries（不可越界清单）+ plan + 依赖 + 状态
Artifact   工作产物：kind / 工作区相对路径引用 / digest / provenance / verification 状态
Evidence   证据：验证结果（命令、退出码、摘要）、评审 findings、attention 决策记录
Run        一次执行（attempt 维度），归属 WorkItem，由 Team Runtime 记录
```

### 3.2 Artifact 类型（v0.7 第一批）

| kind | 语义 | 来源 |
|------|------|------|
| `research-notes` | 研究笔记（兼容现状；**必须**同时落在工作区） | researcher 会话终稿 |
| `report` | 面向用户的成品文档 | 任一角色 |
| `workspace-patch` | 工作区文件变更集合（git diff 摘要 + 文件清单） | 壳侧 diff 捕获（受信） |
| `workspace-files` | 新增/修改的文件清单与 digest | 壳侧 fs 捕获（受信） |
| `review-findings` | 评审结论（通过/需补充 + 理由） | reviewer 会话终稿 |

扩展规则：`kind` 仍是闭集（adapter/office 两侧白名单同步加）；位置引用规则保持"**opaque ref + 工作区相对路径**"两层——Team fact / Office 快照只拿 opaque ref（`ref:<role>-<kind>`，延续 v0.6 纪律），工作台通过壳侧 Work Product 索引把 ref 映射到绝对路径。**绝对路径永不进入 Team fact / Office 快照。**

### 3.3 Verification（新增：受信验证证据）

- 壳侧 **Verification Runner**：在工作区内执行任务模板声明的验证命令（如 `npm test`、`npm run build`、自定义命令），有超时、有限输出。
- 结果进入事实链：`execution/verification {kind: test|lint|build|custom, ok, exitCodeBucket, durationMsBucket}`（粗粒度 token；**不携带输出正文**，完整日志落在工作区 `.dsh/runs/<runRef>/verify.log`）。
- Team 事实：`run/verification`（只存最近一次 + 计数）；**gate 语义**：产物交接（reviewer 消费 researcher 产物）可要求"上游 verification 通过"，由 plan 模板声明，不满足则挂起（`HANDOFF_UNVERIFIED`），绝不伪造。
- 与 attention 的关系：验证失败不是终态——进入受控 retry（见 §4.3），超过上限转 attention（人来决定）。

### 3.4 Provenance（来源可追溯）

每个 Artifact 记录：`producerRole`、`runRef`（`exec-run:` 派生）、`attempt`、`backend`（如 `dsh`）、`verification`（最近一次结果）、`createdAtMs`。工作台展示"这是谁、第几次尝试、跑在哪个后端、过没过验证"。

## 4. Team harness 循环（从单轮到真循环）

### 4.1 Worker 工具（经执行后端提供）

| 能力 | v0.7 | 说明 |
|------|------|------|
| 读工作区 | ✅ | 工作区为根的读文件/列目录/搜索 |
| 写工作区 | ✅ | 写文件/编辑（受 boundaries 限制） |
| 跑命令 | ✅（沙箱 + 超时） | 按 plan 声明的验证命令 + 常规工具执行；危险命令（删除/网络/提权）走审批 attention |
| 联网 | 默认关（模板显式开启） | 研究类模板可开只读检索 |
| 跨工作区 | ❌ | 越界即拒（机械强制，不进上下文就算越界） |

实现路径：这些能力由执行后端（当前 dsh）提供；壳侧在 system prompt / 任务文本里给出目标、边界、工作区地图（§2-4）。**不规定步骤**。

### 4.2 循环（受控版 Ralph 循环）

```
plan（模板或 worker 产出，可人工确认）
  → execute（worker 在工作区干活）
  → self-check（worker 自检：跑验证命令、自查清单）
  → verify（壳侧 Verification Runner 拿真实证据）
  → review（reviewer 看 diff + 验证证据 + 计划，出 findings）
  → iterate（受控 retry：attempt+1，最多 N 次；每轮保留证据）
  → gate（verification 通过 + review 通过 + artifacts 齐备）→ completed
  任一步超限/需要人决策 → attention（人在工作台裁决）
```

约束（写进契约）：
- **attempt 有上限**（默认 3，模板可调），每次 attempt 独立 runRef，证据不覆盖。
- **review 必须基于证据**：reviewer 的输入 = 计划 + diff + 验证摘要；不得只看转述文本。
- **gate 不可绕过**：没有 verification 证据 + review findings 的产物不得进入下游（`HANDOFF_UNVERIFIED`）。
- **人工介入点**：计划确认（复杂任务）、危险命令、验证连续失败、越界请求。

### 4.3 与六阶段路线的关系

- 阶段 2（Execution Recovery）→ 本循环的"失败/恢复"底座（v0.6 已完成 resume/crash 基础）。
- 阶段 2.5（本 spec P2）→ 工具循环 + Verification Runner + 受控 retry。
- 阶段 3（Team 模板）→ 模板 = 目标 + 边界 + 工具集 + 验证命令 + 角色分工；**不再规定 1-2-3 步**（参考 Symphony 教训：把智能体当状态机节点会浪费模型能力）。
- 阶段 4（并行）→ 循环内多 work-item 并行，共享 workspace 的写冲突由文件级锁/分区解决。
- 阶段 5（持久化）→ Work Product 索引与 facts 落盘，重启可恢复。

## 5. 交互架构

### 5.1 首跑体验（30 秒–5 分钟，硬指标）

1. 选工作区（新建空目录 / 打开已有项目 / 示例项目）。
2. 一句话任务（模板选择器：研究、代码修改、文档整理…）。
3. 看到 **任务板 + 计划**（复杂任务先确认计划，可编辑边界）。
4. 实时看到"谁在做什么"：工具活动（v0.6 的 phase 继续用）+ 正在写的文件 + 验证进度。
5. 结束：产物列表（可打开/定位/复制路径）、验证证据（命令+结果）、评审结论、下一步建议。
6. 全部内容留在工作区，下次打开仍在。

### 5.2 工作台（主视图）

```
顶部：工作区选择 + 任务输入（模板/自由）+ 运行状态
左：任务板（待办/运行中/待你处理/已完成）
中：任务详情 —— 计划 | 时间线（工具活动+决策） | 产物 | 证据
右：产物查看器（Markdown / diff / 文件预览）+ 操作（打开、定位、导出）
常驻：attention 卡（批准计划/危险命令/失败裁决，就地操作）
```

### 5.3 Office（氛围层，映射规则）

- 座位状态 ← 工作图节点的运行态（working/attention/idle），**不自行编造**。
- 桌面/墙面显示当前任务的产物缩略与进度（真实数据投影）。
- 鲸鱼娘 = 状态解释器：用叙事解释"现在在干什么、卡在哪、需要你做什么"，文案由工作图事实驱动（模板化，不让模型自由发挥状态）。
- **办公室不是输入面**：所有控制（启动、批准、继续、取消）= 工作台或卡片上的明确按钮。办公室可点击跳转到工作台对应任务。
- 视觉重构（绑定式角色、场景代码化）在 P3 进行，**前提是 §5.1 已成立**。

## 6. 可读性、可观测与隐私

- 工作日志：每个 run 的 `.dsh/runs/<runRef>/` 下保存 verify.log、工具活动摘要（工具名 + 结果码，不含参数原文）。
- Team fact 与 Office 快照的隐私纪律**不放松**：raw sessionId / prompt / 正文 / 绝对路径不进 fact 与快照；工作台需要的文件路径由壳侧 Work Product 索引提供。
- 事实链可导出（诊断包），供用户和后续 agent 读取（为"智能体可读的仓库"打基础：工作区里的 `.dsh/` 是本地事实，可被下一次任务作为上下文地图引用）。

## 7. 验收与分期

### P1（v0.7）：产物与工作台 —— 先让"有用"成立
- Workspace 配置与选择（空目录/已有项目）。
- Artifact kinds 扩展（report / workspace-patch / workspace-files）+ 壳侧 diff 捕获 + Work Product 索引。
- 工作台：任务板、任务详情（计划/时间线/产物/证据）、产物查看器；首跑 6 步流程。
- Office 映射最小集（座位 ← 工作图；桌面显示产物缩略）。
- 验收：首跑 5 分钟内产出真实文件；任务完成时必有可打开产物 + 来源；无产物不得显示"完成"（机械门）。

> **实施口径修正（2026-10-27，见 `docs/plans/active/HARNESS-V0.7-P1-PLAN-2026-10-27.md`）**：
> ① `report` / `workspace-patch` / `workspace-files` 需要 worker 的工作区写能力与受信 diff（P2），
> P1 只用现有 `research-notes` / `review-findings`，但**落到真实工作区**并进入索引；
> ② 任务板 P1 = 单活动任务 + 历史列表（并行/排队 P2）；
> ③ 办公室 P1 = 座位级产物计数标记（闭集 kind），缩略渲染放 P3。

### P2（v0.8）：工具循环与验证
- Worker 工具集（读写/命令/沙箱策略）+ Verification Runner + `execution/verification` / `run/verification` 事实。
- 受控 retry（attempt ≤ N）+ review 基于 diff/证据。
- 验收：一次真实代码修改任务，验证命令真实执行且 gate 生效；证据链完整（谁/哪次/过没过）。

### P3（v0.9）：模板与视觉重构
- Team 模板（目标+边界+工具+验证，不规定步骤）；并行 work-item。
- 办公室渲染架构更新（绑定式角色 Live2D/Spine 或程序化；场景代码化；渲染侧连续时间）。
- 验收：模板可复用、可解释；视觉重构不改变呈现契约（快照仍是纯投影）。

每题均沿用现有纪律：先计划后动工、变异测试、真机验收脚本、独立 commit。

## 8. 风险与开放问题

| 风险/问题 | 说明 | 缓解 |
|-----------|------|------|
| dsh 后端的工具能力边界 | 工具由 dsh 会话提供，工作区访问需确认其权限模型与沙箱行为 | P2 前做一次能力探针；不够则用第二后端（进程内 loop，您已有 hebox/DashScope/tu-zi key） |
| 写冲突 | 多 work-item 并行写同一工作区 | 文件级锁/分区；P2 先串行 |
| token 成本 | 真循环会显著增加调用 | 模板控制 attempt 上限与上下文地图粒度；成本进证据 |
| 危险命令 | 破坏用户工作区 | 默认沙箱 + 危险命令审批；工作区外一律拒绝（机械强制） |
| 迁移成本 | 现有 dsh materializer 只取终稿文本 | 保留旧路径作为 fallback；新路径失败不得伪造产物 |
| 视觉重构过早 | 又会回到花瓶 | P3 硬门槛：P1 验收通过 |

## 9. 与既有契约/文档的关系

- 执行事实：`docs/architecture/WORKER-EXECUTION-CONTRACT-v0.md`（本 spec 在其上增加 artifact kinds 与 verification 事件/事实）。
- Team 事实：`docs/architecture/TEAM-RUNTIME-CONTRACT-v0.md`（增加 `run/verification`、`HANDOFF_UNVERIFIED`）。
- 运行时边界：`docs/architecture/HARNESS-RUNTIME-CONTRACT-v0.md`。
- 办公室边界：`docs/architecture/2026-08-30-office-spec-00-boundaries.md`（SPEC-00 冻结词表/文件边界）。
- 文档索引与开发流程：仓库根 `AGENTS.md` 与 `docs/README.md`。
