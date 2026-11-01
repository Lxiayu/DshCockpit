# 原始需求书 vs 当前实现 —— 完整差距分析

> 日期：2026-11-01
> 对照物：用户提供的《DshCockpit 新阶段项目审计、产品升级与 Agent-First 工程规划》
> （下称"需求书"）
> 方法：逐条核对需求书的**具体可验收项**，用代码 grep 验证，不凭印象

## 0. 一句话结论

**工程地基（A/C/H）超额完成，产品体验层（E/七）是最大缺口。**

需求书列的九大交付物里：
- **已完成 6 项**（A 审计 / B 架构 / C 路线 / D 第三方 / F 路线图 / G Issues / H 规范）
- **部分完成 2 项**（E 交互设计、I 最终建议）
- **最大缺口是「七、虚拟办公室人机交互」的具体实现**

而这几轮我一直在做的是 **P0–P4 的工程债务与验证**，
**需求书里最核心的"Mission Desk 该长什么样"反而没做透**。

## 1. 逐条核对

### A. 项目现状审计 → ✅ 已完成

| 需求书要求 | 证据 |
|---|---|
| 对照表（模块/实现/程度/问题/保留/下一步） | `docs/quality/tech-debt-inventory.md` + `docs/product/gap-inventory.md` |
| 区分「已确认/部分实现/待验证/设计阶段/设想」 | `docs/product/delivery-status.md` 用五态标注 |
| 提供文件路径与代码位置 | 各审计文档均带 `src/xxx.js:NNN` |

### B. 新产品架构 → ✅ 已完成

`docs/product/product-vision.md`（五支柱 + 三层范围）、
`docs/architecture/domain-model.md`、`runtime-bridge.md`、`capability-platform.md`、
`office-runtime.md`、`data-flow.md` 全部存在且互链。

### C. 技术路线设计 → ✅ 已完成（含 Mermaid 图）

`docs/architecture/` 下 19 份文档，含架构图、数据流、时序图。
`runtime-bridge.md` 有完整的 Event Normalizer / 断线重连 / 去重设计。

### D. 第三方项目评估 → ✅ 已完成

`docs/research/capability-providers.md` + `docs/adr/ADR-0006`（Live2D Deferred）。
**但有一处需要修正**：审计已指出早期对 OpenViking 许可证的判断有误（整仓 AGPL → 实际是部分 Apache-2.0），已纠正。

### E. 产品交互与 UX 设计 → ⚠️ **部分完成（最大缺口）**

需求书 **七.1 Mission Desk** 明确列了 8 个要素。逐条核对：

| 要素 | 状态 | 证据 |
|---|---|---|
| Mission Summary | ❌ **缺失** | grep 0 处 |
| 最新的重要变化 | ⚠️ 部分（有 activity 但不聚合） | — |
| Shared Context（Findings/Decisions/Assumptions） | ⚠️ **只有 Decisions** | 见下 §2 |
| Needs Your Attention | ❌ **缺失** | grep 0 处 |
| Deliverables | ✅ | Mission Desk 产物区块 |
| Workstreams | ✅ | Mission Desk 工作流区块 |
| **Welcome Back** | ❌ **缺失** | grep 0 处 |
| 人类决策与方向调整 | ✅ | 决策表单 |

需求书 **七.2 可交互物件**：

| 物件 | 状态 |
|---|---|
| 项目白板 | ✅ |
| 会议桌 | ❌ 缺（但设计文档判定「不做」，见 §3） |
| 员工工位 | ⚠️ 有员工无"工位"交互 |
| 资料架 | ❌ 缺（设计文档判「不做」） |
| 收件箱 | ✅（Human Inbox） |
| 成果展示区 | ❌ 缺（设计文档判「不做物件」） |

需求书 **七.3 Companion Mode 三形态**：

| 形态 | 状态 |
|---|---|
| Full Office | ✅ |
| Companion Mode | ✅（独立常驻小窗） |
| **Quick Panel** | ❌ **缺失** |

### F. 分阶段路线图 → ✅ 已完成

`docs/product/product-roadmap.md` 有 P0–P4 + 退出条件 + 验收标准。

### G. GitHub Issues → ✅ 已完成

40+ Issues，标签齐全（architecture / compatibility / deferred / epic / research / tech-debt）。

### H. 工程规范 → ✅ 已完成

AGENTS.md（130 行上限 + 内聚门禁）、6 份 ADR、Execution Plan 规范、
四态 CI 门禁、真机验收体系。

### I. 最终建议 → ✅ 已完成（但需更新）

## 2. 最大缺口：Shared Context 只实现了 1/3

需求书 **四.1** 要求 9 个领域实体：

| 实体 | 状态 |
|---|---|
| Mission | ✅ |
| Workstream | ✅ |
| Task Reference | ✅（本轮刚接通） |
| Decision | ✅ |
| **Finding** | ❌ **缺失** |
| **Assumption** | ❌ **缺失** |
| Open Question | ✅ |
| **Evidence** | ❌ **缺失** |
| Deliverable | ✅ |

**实现 5/9**（加 openQuestion 是 6/9）。

### 为什么这是最重要的缺口

需求书 **四.2** 说：

> 「重点研究如何让 Agent Team 在跨 Session、上下文压缩和成员更换时**保持工作连续性**。」

当前只有 Decision + OpenQuestion 能跨会话留存。
但真实工作里更重要的是：

- **Finding**（"我们发现 X 在 Y 条件下会崩"）—— 这是团队积累的核心
- **Assumption**（"我们假设用户会先登录"）—— 这是未来会爆炸的地雷
- **Evidence**（"这个结论的依据是 commit abc / 那篇文章"）—— 这是可信度的来源

**没有这三者，Mission 只能记住"决定了什么"，记不住"为什么这么决定"。**

需求书还特别提到 `expiresAtMs`（假设过期）、`confidence`（置信度）、
`evidenceRefs`（证据引用）——这些字段一个都没有。

## 3. 与设计文档的冲突（需要你拍板）

需求书 七.2 要求做「会议桌 / 资料架 / 成果展示区」。
但项目自己的 `docs/design/office-interaction.md` 已经逐条判定：

| 物件 | 设计文档结论 | 理由 |
|---|---|---|
| 会议桌 | **不做** | 没有"会议"这个事实源 |
| 资料架 | **不做** | 没有知识库事实源 |
| 成果区 | **不做物件** | 会与工作坞重复 |

**路线图 P4 与设计文档互相矛盾。** 上一轮我按设计文档砍掉了这三项。

**需要你确认**：是坚持设计文档的判断（不做），还是需求书的清单优先（做）？

## 4. 其他次要差距

| 项 | 需求书要求 | 现状 |
|---|---|---|
| Quick Panel | 三形态之一 | 缺 |
| Welcome Back | Desk 要素 | 缺 |
| Needs Your Attention | Desk 要素 | 缺 |
| 角色桌面随产物增加 | 设计文档建议的微表现 | 缺 |
| Issue 默认标签 | Bug/Feature/Security/Documentation | 用 GitHub 默认，未显式建 |

## 5. 结论与建议

**工程侧已经做得很扎实**，但**产品侧最核心的"让 Agent Team 保持连续性"
只完成了 1/3**。

我建议的优先级：

| 优先 | 项 | 理由 |
|---|---|---|
| **1** | **Finding / Assumption / Evidence 三实体** | 需求书四.1 明确要求；没有它们"工作连续性"是半成品 |
| **2** | **Welcome Back** | 需求书点名；跨会话连续性的**用户体验入口** |
| **3** | Needs Your Attention | Desk 该主动告诉用户"哪里需要你" |
| 4 | Quick Panel | Companion 三形态补齐 |
| 5 | 会议桌等物件 | **需你先拍板**（与设计文档冲突） |
