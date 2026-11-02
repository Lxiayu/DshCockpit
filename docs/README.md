# docs/README.md —— 文档唯一索引

> 规则（机械校验见 `test/docs-index.test.js`）：
> 1. **本文件是唯一索引**——`docs/` 下每个非归档文档都必须在这里登记；未登记 = 测试红。
> 2. **活跃文档入库**（2026-10-27 文档重构起）；`docs/archive/` 是本地历史保险箱（git 忽略），不在此逐一登记。
> 3. 新增/移动/删除文档时同步本表；过时文档移入 `docs/archive/` 并在归档说明里写清原因。
> 4. 文档结构按用途分层：契约（architecture）/ 产品方向（product）/ 研究（research）/
>    决策（adr）/ 设计（design）/ 计划与报告（plans）/ 质量与来源（quality）/ 脚本产物（compat）。
> 5. 仓库地图与开发铁律在根目录 `AGENTS.md`（≤130 行）；新会话先读它。
> 6. **2026-11-01 战略重定位**：产品从「Harness 桌面壳」转为「AI 团队工作空间」。
>    入口：`docs/product/product-vision.md` → `docs/product/product-principles.md` →
>    `docs/architecture/domain-model.md` → `docs/adr/ADR-0001-repositioning-ai-team-workspace.md`。

## 0. 战略与当前主线（2026-11-01 起，新会话先读这 6 份）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/product/product-vision.md` | **现行权威** | 定位、战略边界、单一事实源矩阵、90 天判据 |
| `docs/product/product-principles.md` | **现行权威** | 第一性原理八问 + Harness Engineering 本地化 + 强制化清单 |
| `docs/product/product-roadmap.md` | **草案（待拍板）** | P0–P4 分期、每阶段退出条件、Deferred 清单 |
| `docs/product/delivery-status.md` | **交付状态** | 各阶段交付了什么、证据在哪、还剩什么（P0-P3 历史 + 已知问题） |
| `docs/product/gap-inventory.md` | **规划落差盘点** | 早期规划里还有什么没做（五支柱/Deferred/孤立模块/真实缺口/性能风险） |
| `docs/product/user-journeys.md` | **草案（待拍板）** | 新手初始化/Mission/Desk/办公室物件/Companion 的交互设计 |
| `docs/architecture/domain-model.md` | **设计阶段** | Mission/Workstream/SharedContext/TaskRef/Deliverable 领域模型 |
| `docs/architecture/mission-core.md` | **设计阶段** | Mission Core 实现设计（存储/事件/恢复/边界铁律） |
| `docs/plans/active/P0-AUDIT-AND-P1-MISSION-KICKOFF-2026-11-01.md` | **进行中** | 本轮执行计划（P0 收尾 → P1 启动） |

## 1. 架构与契约（长期有效，改动需拍板）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/architecture/HARNESS-RUNTIME-CONTRACT-v0.md` | 权威 | Harness→Office 运行时内核边界：journal→渲染事实链、通道冻结 |
| `docs/architecture/TEAM-RUNTIME-CONTRACT-v0.md` | 权威 | Team Runtime v0：Job/Role/WorkerRun/Artifact、事实唯一作者、收敛规则 |
| `docs/architecture/WORKER-EXECUTION-CONTRACT-v0.md` | 权威 | 执行端口契约 + controller 唯一转换 + dsh 后端；§17 记 v0.6 增量 |
| `docs/architecture/MCP-MANAGER-SPEC.md` | 权威 | MCP 管理器 v2（CRUD/双传输/健康检查） |
| `docs/architecture/OFFICE-DESIGN-DISCUSSION.md` | 权威 | 办公室产品决策日志（45 条：角色/四层状态/布局/动画） |
| `docs/architecture/2026-09-23-office-right-panel-spec.md` | 权威 | 右栏数据契约（usage/staff/pending/timeline/detail） |
| `docs/architecture/office-workbench-design.md` | 权威 | 工作台设计原则（内容/引擎分离） |
| `docs/architecture/office-workbench-m0.md` | 权威 | 工作台 M0 边界与已拍板决定（平面 2D） |
| `docs/architecture/2026-08-30-office-spec-00-boundaries.md` | 权威 | 办公室 SPEC-00 边界（冻结词表/文件边界） |
| `docs/architecture/office-asset-naming.md` | 权威（门禁依据） | 素材接入规范：命名/目录/声明面/layer 带宽；E2e/E3a 测试直接读本文 |
| `docs/architecture/2026-08-30-office-development-spec-index.md` | 权威 | 办公室 SPEC 索引（Task→SPEC 映射） |
| `docs/architecture/runtime-bridge.md` | 审计+设计（2026-11-01） | Runtime Bridge：Harness Host→Bridge→Event Normalizer→Office→PixiJS 分层、稳定/实验 API 分级、快照 vs 增量、重连去重 |
| `docs/architecture/data-flow.md` | 审计+设计（2026-11-01） | 端到端数据流：执行事件→controller→Team facts→bridge→office 投影→snapshot→render |
| `docs/architecture/office-runtime.md` | 审计结论（2026-11-01） | Office Runtime 分层、状态所有权矩阵、渲染管线、快照契约、保留/改造/废弃判定 |
| `docs/architecture/architecture-overview.md` | 审计报告（2026-11-01） | 壳层总体架构：进程/窗口模型、IPC 全景、存储层、启动时序 |
| `docs/architecture/domain-model.md` | **设计阶段（2026-11-01，未实现）** | 目标领域模型：Mission / Shared Context / Team / Office |
| `docs/architecture/mission-core.md` | **设计阶段（2026-11-01，未实现）** | Mission Core 架构 |
| `docs/architecture/capability-platform.md` | **设计阶段（2026-11-01，未实现）** | Capability Platform：Provider 抽象、Capability Manifest、Profile Composer、Plugin Lifecycle |
| `docs/architecture/official-capability-matrix.md` | **权威（2026-11-01）** | 官方能力四层分级矩阵（L1 Core Service / L2 Experimental Plugin / L3 Bundle / L4 Internal）；6 个能力边界实证（含 0.1.5↔0.2.1 事件词表 diff：56→62，净增 6、零删除） |

## 1.1 架构决策记录（ADR）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/adr/ADR-0001-repositioning-ai-team-workspace.md` | **已接受（2026-11-01 用户拍板）** | 重新定位为 AI 团队工作空间，放弃「Harness 桌面壳」竞争 |
| `docs/adr/ADR-0002-consume-official-agent-teams.md` | 建议接受（待拍板） | 停止扩张自研 Team Runtime，改为消费官方 Agent Teams |
| `docs/adr/ADR-0003-capability-packs-not-marketplace.md` | 建议接受（待拍板） | Capability 以「验证过的组合」交付，不做插件市场的替代品 |
| `docs/adr/ADR-0004-upgrade-harness-runtime-0.2.md` | 建议接受（待拍板） | 升级 Harness runtime 到 0.2.x 并采用 shell-held carrier |
| `docs/adr/ADR-0005-memory-official-stack.md` | 建议接受（待拍板） | 记忆与历史采用官方栈，零第三方 Memory Provider（依据 `docs/research/memory-systems.md`） |
| `docs/adr/ADR-0006-live2d-deferred.md` | 建议接受（待拍板） | Live2D 当前阶段不接入生产，仅做渲染接口预留（依据 `docs/research/live2d-evaluation.md`） |

## 2. 产品方向

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/product/product-vision.md` | **现行战略（2026-11-01 立项）** | 产品愿景 The Workspace for AI Teams；产品层最高依据 |
| `docs/product/product-principles.md` | **现行（2026-11-01）** | 产品与工程原则：强制八问、反模式表、Harness Engineering 本地化（评审依据） |
| `docs/product/WORK-FIRST-V0.7.md` | **草案（待拍板）** | v0.7 方向：Work Product 一等公民、工作台为主、办公室为氛围层、首跑 5 分钟、P1/P2/P3 分期 |
| `docs/product/product-roadmap.md` | 草案（2026-11-01，待拍板） | 产品路线图与分阶段开发计划 |
| `docs/product/user-journeys.md` | 草案（2026-11-01，待拍板） | 用户旅程与交互设计 |

## 3. 研究（有证据价值，按日期）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md` | 参考 | Harness 原生能力证据（办公室边界事实） |
| `docs/research/TEAM-RUNTIME-OSS-RESEARCH-2026-10.md` | 参考 | Agent-team OSS 调研（58 仓），支撑 Team Runtime 立场 |
| `docs/research/DSH-EXECUTION-BACKEND-COMPAT-2026-10.md` | 参考（已按 v0.6 校正） | dsh 执行后端映射盘点；artifact/crash 缺口已由壳侧物化与 WP1 合成覆盖 |
| `docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md` | 进行中（待真机） | v0.7 P1 报告：工作区/产物/工作台、变异矩阵、真机脚本、已知缺口 |
| `docs/research/WHALE-GIRL-LORE-RESEARCH-2026-10.md` | 参考（长期有效） | 鲸鱼娘社区生态调研：四条硬设定、83 条台词、五类禁用清单、「鱼片」查证结论。**闲聊语料库与内容红线测试的依据** |
| `docs/research/third-party-projects.md` | **评估结论（2026-11-01）** | 第三方项目总评估表 + 三个 dsh-pet 仓库辨析（PC2005/sundusk/ysyyhhh）+ 参考项目设计研究（Pi/Claw-Empire/Agent Canvas/Retinue/WorkBuddy/Kimi Code）+ 判死清单 |
| `docs/research/memory-systems.md` | **评估结论（2026-11-01）** | 记忆与历史专项：官方 0.2.1 无 memory 包实测、G1–G5 缺口分解、Obelisk/OpenViking/memory-evolve/mnemon 逐项核实、**单写入者纪律** |
| `docs/research/workspace-isolation.md` | **评估结论（2026-11-01）** | 工作区隔离专项：官方 L0/L1/L2 已解决 vs L3 缺口、LayerFS 暂缓裁定、T0/T1/T2 分层与「包装官方 worktree 不自研」结论 |
| `docs/research/live2d-evaluation.md` | **评估结论（2026-11-01）** | Live2D 许可与 POC 边界：**Expandable Application 剥夺个人/小微豁免**、Cubism Core 专有二进制、C1–C16 可引用条款清单、当前阶段禁令 |
| `docs/research/capability-providers.md` | **评估结论（2026-11-01）** | Capability Provider 选型结论：各域首选/备选/放弃表、K1–K6 硬约束（给 capability-platform 的输入）、判死清单、"采用"三项必答三问 |
| `docs/research/deepseek-harness-api-surface.md` | 只读盘点（2026-11-01） | 官方 API 表面盘点（0.1.5-rc.2 vs 0.2.1-rc.5）：mux endpoints、RPC 方法、approval 回传、各插件能力与稳定性判定 |
| `docs/research/runtime-poc-report-2026-11-01.md` | **POC 报告（2026-11-01）** | Issue #9 运行级验证：三版本协议探针、隔离环境、16/16 PASS、未验证项诚实清单 |

## 3.1 设计与交互（设计阶段）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/design/character-system.md` | 审计+设计建议（2026-11-01） | Character System：场景移动 / Sprite 动作 / 真实状态 / 日常人格 / 用户互动 五层分离；Sprite vs Live2D 混合渲染接口预留（不实现） |
| `docs/design/office-interaction.md` | 审计+设计建议（2026-11-01） | Office 可交互物件：Mission Board / 白板 / 会议桌 / 资料架 / 收件箱 / 成果区，每物件对应真实数据+可执行操作 |
| `docs/design/mission-desk.md` | **设计阶段（2026-11-01，未实现）** | 用户与团队的主交互面：需要你 / 现在在做什么 / 项目进展 / 上次停在哪 / 产物 / 共识；明确不做第二个聊天窗口 |

## 4. 计划与报告

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/plans/active/P0-AUDIT-AND-P1-MISSION-KICKOFF-2026-11-01.md` | **进行中** | P0 地基校准 → P1 Mission Core 启动；负责人 Lead，用户最终拍板 |
| `docs/plans/active/P0-ENGINEERING-EXECUTION-2026-11-01.md` | **进行中（P0 唯一执行依据）** | P0 工程实施：#21→#10→#14→#9，并行 #22/#19；含完成条件与工程纪律 |
| `docs/plans/active/P2-OFFICE-OBJECTS-2026-11-01.md` | **P2.3 执行计划** | 办公室交互物件（项目白板）的第一性原理分解与实施步骤 |
| `docs/plans/active/P2-COMPANION-MODE-2026-11-01.md` | **P2.4 执行计划** | Companion Mode 的第一性原理分解（澄清 rail≠Companion、三种形态、状态保持） |
| `docs/plans/active/P3-CAPABILITY-PACKS-2026-11-01.md` | **P3 执行计划** | Capability Pack 的第一性原理分解（verify 是核心、安装=记录、四态结果） |
| `docs/plans/active/P4-MISSION-DESK-WRITE-PATHS-2026-11-01.md` | **P4 Desk 写入入口计划** | 为什么"只读 Desk 不叫 Desk"；含治理漏洞修复 |
| `docs/plans/active/P4-TASKREF-WIRING-2026-11-01.md` | **TaskRef 接线计划** | Mission↔Harness 唯一连接点；含隐私派生规则 |
| `docs/plans/active/P4-DESK-ACTION-PARITY-2026-11-01.md` | **Desk action 全覆盖计划** | 20 个 action 逐条核对；真缺口只有 2 个 |
| `docs/plans/active/P4-RENDER-BACKEND-SEAM-2026-11-01.md` | **RenderBackend 接缝计划** | 为什么做接缝而不是抽象层；20 个方法里只有 2 个是技术特有 |
| `docs/plans/active/P4-VERIFICATION-PROVIDER-DECISION-2026-11-01.md` | **VerificationProvider 决策** | 结论：不做接口（收益已获得，ADR 时机判断有误） |
| `docs/plans/active/P4-EXPERIENCE-POLISH-2026-11-01.md` | **P4 体验打磨计划** | 先砍掉与设计文档冲突的"更多物件"；空状态 > 错误粒度 |
| `docs/plans/active/P4-COMPANION-INFORMATION-2026-11-01.md` | **Companion 信息增强计划** | 小窗该回答"要不要现在看"；紧急度必须真实派生 |
| `docs/plans/active/P4-ATTENTION-AND-ABSENCE-2026-11-01.md` | **待办+离开期间+前端打磨计划** | 待办是排序机制；lastSeenAtMs 属 UI 偏好；37 处硬编码色须 token 化 |
| `docs/plans/active/P4-UI-POLISH-AND-ENTITIES-2026-11-01.md` | **UI 打磨 + 三实体计划** | 层级靠 scale/weight 不靠颜色；先修引导重复 bug |
| `docs/plans/active/RUNTIME-UPGRADE-0.2.1-2026-11-01.md` | **Runtime 升级 0.2.1-rc.5** | 10 条破坏性变更清单 + 10 个复查点 |
| `docs/plans/active/RUNTIME-PROJECTIONS-ADOPTION-2026-11-01.md` | **采纳 session/projections** | 一次调用拿到结构化 userQuestions（含 options/plan-review） |
| `docs/plans/completed/HARNESS-V0.6-PLAN-2026-10-25.md` | 已完成 | v0.6 五工作包计划（续跑/过程可见/首帧/推送/归档） |
| `docs/plans/completed/HARNESS-V0.6-REPORT-2026-10-26.md` | 已完成 | v0.6 完成报告：变异矩阵、真机脚本、遗留 |
| `docs/plans/completed/2026-08-30-virtual-office-runtime-implementation.md` | 已完成 | 办公室运行时 Task 0–9（历史记录；路径按当时结构） |
| `docs/plans/completed/OFFICE-V3-INTERACTION-STAGE-REPORT-2026-10-30.md` | 已完成 | 互动层阶段报告：6 个缺陷修复、左右站位回退、语料调研、高内聚拆分、5 条遗留规则 |

| `docs/plans/active/HARNESS-V0.7-P1-PLAN-2026-10-27.md` | **进行中** | v0.7 P1 实施：工作区/产物落地/工作台/门禁；含与上位文档的偏差声明 |
| `docs/plans/active/HARNESS-V0.7-P1.5-DOCK-PLAN-2026-10-27.md` | **进行中** | P1.5：工作坞并入办公室（右栏收成浮动待办）、角色悬停卡与暂停呈现 |
| `docs/plans/active/HARNESS-V0.7-P2-PLAN-2026-10-27.md` | **进行中** | P2：专用 Team runtime（cwd=工作区）、变更捕获、Verification Runner、受控 retry |
| `docs/plans/active/OFFICE-V3-VISUAL-PLAN-2026-10-27.md` | **进行中** | P3 视觉重构：呈现时钟、代码环景、伪 3D 生成布局、dsh-pet 式交互（P3.0/P3.1/P3.3/P3.4 已落地） |
| `docs/plans/active/OFFICE-V3-ISOMETRIC-PLAN-2026-10-27.md` | **I0 完成，待评审 I1** | 等轴测投影：投影数学、画家算法遮挡、命中测试、I0–I4 分阶段与回退 |
| `docs/plans/active/OFFICE-V3-CODED-2.5D-PLAN-2026-10-27.md` | **进行中（互动层已收口）** | 2.5D 代码化家具 + §21 走路系统重构 + §22 互动层打磨（拖拽/交互区/闲聊朝向/语料）。视觉细化仍可继续 |

进行中的计划放 `docs/plans/active/`；完成的移入 `completed/`。

## 5. 质量与来源

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/quality/2026-09-26-asset-provenance.md` | 参考（脚本配套） | 素材来源链说明；`scripts/asset-provenance.js` 输出 `docs/quality/2026-09-26-asset-provenance-index.json` |
| `docs/quality/tech-debt-inventory.md` | 审计报告（2026-11-01） | 壳层技术债清单（编号/位置/证据/影响/优先级/是否阻塞新方向） |
| `docs/quality/prompt-gap-analysis-2026-11-01.md` | **原始需求书差距分析** | 九大交付物逐条核对；最大缺口是 Shared Context 只做了 1/3 |
| `docs/quality/mission-desk-ux-audit-2026-11-01.md` | **Mission Desk UX 审计（Phase 0）** | 三个关键事实 + 对提示词的修正 + MVP 建议 |
| `docs/quality/mission-desk-mvp-analysis-2026-11-01.md` | **Mission Desk MVP 深度分析** | 按"能否闭合"分类；纠正我上一轮的错误判断 |
| `docs/design/mission-desk-ux.md` | **Mission Desk 右栏设计（Phase 1）** | 信息架构/数据映射/状态矩阵/MVP 范围 |
| `docs/quality/mission-desk-dock-acceptance-2026-11-01.md` | **右栏改造验收（2026-11-01）** | 14/14；右栏从任务面板变成 Mission Desk |
| `docs/quality/mission-desk-attention-acceptance-2026-11-01.md` | **待办+离开期间+双主题验收** | 19/19；两主题对比度全部 ≥AA |
| `docs/quality/mission-desk-shared-context-acceptance-2026-11-01.md` | **三实体+UI层级验收** | 17/17；层级靠 scale/weight 不靠颜色 |
| `docs/quality/mission-desk-structured-options-acceptance-2026-11-01.md` | **结构化选项验收** | 10/10；升级 0.2.1 直接解决缺口 1 |
| `docs/quality/mission-desk-attention-layers-acceptance-2026-11-02.md` | **待办两层分类验收** | 16/16；红框只给"必须决策"，警报疲劳 |
| `docs/quality/mission-desk-team-blocked-acceptance-2026-11-02.md` | **团队任务+BlockedBy 验收** | 15/15；阻塞者查表而非自己 owner |
| `docs/quality/mission-desk-plan-review-acceptance-2026-11-02.md` | **plan-review 折叠视图验收** | 15/15；approve 不按位置推断 |
| `docs/quality/gpt-conversation-gap-analysis-2026-11-01.md` | **与 GPT 对话的差距分析** | 它自我推翻第一版；真实差距=右栏没用官方结构化交互 |
| `docs/quality/status-brief-for-gpt-2026-11-01.md` | **给 GPT 的现状说明** | 可直接贴回做交叉验证；列出 3 个真实缺口 |
| `docs/quality/status-brief-for-gpt-2026-11-02.md` | **给 GPT 的现状说明 v2（0.2.1）** | 可直接贴回；四个待讨论问题 |
| `docs/quality/team-projection-breakthrough-2026-11-02.md` | **突破：agentTeam 可从稳定端点拿到** | 启用 profile 后 session/projections 含 agentTeam（members+tasks） |
| `docs/quality/gpt-dialogue-round2-2026-11-02.md` | **与 GPT 第二轮交流** | 推翻它的两个判断；TeamTask 已含 blockedBy/writeScopes |
| `docs/quality/gpt-dialogue-round3-analysis-2026-11-02.md` | **GPT 第三轮回复分析** | 纠正我们 2 处错误；三层模型/Verification Profile 采纳 |
| `docs/architecture/team-task-workstream-mapping.md` | **TeamTask↔Workstream 映射设计** | 三层模型；只存关联不复制事实；回归 10/10 |
| `docs/quality/real-team-dag-verified-2026-11-02.md` | **真实 Team DAG 已验证** | blockedBy/ready/writeScopes 实测；解除设计阻塞 |
| `docs/quality/product-gap-critical-2026-11-02.md` | **严重问题：产品是记录器不是发生器** | 29 个 action 零个能启动工作 |
| `docs/quality/product-gap-fixed-start-work-2026-11-02.md` | **修复：Mission 能启动工作了** | 新增 startWork；16/16 真机 |
| `docs/quality/startwork-real-chain-verified-2026-11-02.md` | **交给团队 真实链路验证** | 6/6；真实 Agent 3 秒产出 turn |
| `docs/quality/testing-strategy.md` | 审计报告（2026-11-01） | 测试体系盘点：137 个套件真实构成、门禁类型、变异纪律、缺口与改进建议 |
| `docs/quality/quality-gates.md` | **现行（2026-11-01）** | 质量门禁与 CI 策略："什么算通过"的定义 |
| `docs/quality/compatibility-ledger-spec.md` | **规范草案（2026-11-01，待拍板）** | 兼容性账本 v2：Installed/Healthy/Compatible/Supported 四级分离、通道策略、回写机制（修复 Issue #21 根因） |
| `docs/quality/test-tiers-and-baseline.md` | **现行（2026-11-01）** | 测试三级分类（C 核心 / I 集成 / E 环境专项）与正式基线：`CI=1 npm test` → 1935/1935/0 fail |
| `docs/quality/mission-desk-acceptance-2026-11-01.md` | **真机验收（2026-11-01）** | Mission Desk 10/10 通过；三轴分开、诚实降级、窗口加固的运行时证据 |
| `docs/quality/brief-cross-session-verification-2026-11-01.md` | **Brief 跨会话验证** | 四层证据逐层标注；两层源码级已证，端到端未完成（附最省力完成方式） |
| `docs/quality/brief-cross-session-verification-2026-11-01.md` | **Brief 跨会话真机验收** | 8/8 通过：真实模型从 AGENTS.md 读出随机暗号 |
| `docs/quality/character-pack-acceptance-2026-11-01.md` | **角色包验收（2026-11-01）** | 7/7 通过；抓到两个离线全绿的缺陷（office 页不可达 + flex-basis 泄漏） |
| `docs/quality/office-board-acceptance-2026-11-01.md` | **项目白板验收（2026-11-01）** | 10/10 通过；含一次错误诊断的纠正与 4 层探针缺件记录 |
| `docs/quality/office-inbox-acceptance-2026-11-01.md` | **办公室收件箱验收（2026-11-01）** | 18/18 通过；补上纯逻辑测试测不到的视觉与交互证据 |
| `docs/quality/companion-acceptance-2026-11-01.md` | **Companion 验收（2026-11-01）** | 11/11 通过；常驻小窗的四状态色彩与产品纪律实测 |
| `docs/quality/companion-urgency-acceptance-2026-11-01.md` | **Companion 紧急度验收（2026-11-01）** | 13/13；三态文案/颜色实测不同，尺寸不变 |
| `docs/quality/capability-packs-acceptance-2026-11-01.md` | **能力包验收（2026-11-01）** | 13/13 通过；抓到三个离线全绿的缺陷（状态清空、i18n 撞车、DOM id 撞车） |
| `docs/quality/mission-desk-write-acceptance-2026-11-01.md` | **Desk 写入验收（2026-11-01）** | 11/11 通过；真实点击写入、sha256、状态切换全部实测 |
| `docs/quality/mission-desk-empty-acceptance-2026-11-01.md` | **Desk 空状态验收（2026-11-01）** | 13/13 通过；空状态给起点、错误保留 code |

## 6. 脚本产物（由脚本生成/更新，不要手改）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/compat/2026-08-23-0.1.1-rc.2.md` | 自动生成 | 上游兼容报告 |
| `docs/compat/discussion-body.md` | 自动生成 | 兼容报告对应的 Discussion 模板 |
| `docs/compat/2026-11-01-0.2.1-rc.5.md` | **0.2.1-rc.5 兼容验证** | 7/7 协议全通；agentTeam 仍未进稳定 API |

## 7. 历史（归档）

`docs/archive/`（本地保险箱，git 忽略）：2026-08～10 的旧计划/报告/设计/s1 时代笔记与 legacy 快照，
含用户拍板记录与决策追溯；**不作为新设计依据**。详见 `docs/archive/README.md`（本地）。
2026-09-16 的"docs/ 不跟踪"决定已由 2026-10-27 重构覆盖（活跃文档入库，归档保持本地）。

## 8. 维护

- 文档园丁（每次批次收尾）：核对本索引、移动过期文档、修正与代码矛盾的描述。
- 与代码矛盾的文档**优先修正或归档**，不允许带着错误描述留在活跃区（2026-10-27 审计发现的矛盾点已全部处理，见提交 `d50f198`）。
