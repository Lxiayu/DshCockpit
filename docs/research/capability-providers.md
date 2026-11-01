# Capability Provider 评估与选型结论

> 状态：**评估结论（供下一阶段拍板）** · 核查日期 **2026-11-01（Asia/Shanghai）**
> **范围严格限定**：本文只给「**具体候选 Provider 的评估与选型结论**」——谁能解决什么、与官方重叠什么、许可证、推荐度、首选/备选/放弃。
> **不在本文范围**：Provider 抽象接口、Capability Manifest schema、Profile Composer、Plugin Lifecycle 的完整设计——那些归 **`docs/architecture/capability-platform.md`**（Lead 执笔）。本文 §2 只给**设计输入与约束建议**，不另写一份接口设计，避免两份文档互相矛盾。
> 三份专项（`memory-systems.md` / `workspace-isolation.md` / `live2d-evaluation.md`）与总表（`third-party-projects.md`）是本文的证据底座。

---

## 0. 三十秒结论

**下一阶段接的第三方 Provider 数量：0。**
**下一阶段要"接"的官方能力：不是"4 个包"，而是横跨 4 层、共 16 个包。**
**下一阶段我们自己要建的能力：3 个（都不是 Provider）。**

> ⚠️ **勘误（2026-11-01 第二轮）**：本节早期版本写"下一阶段要接的官方能力：**4 个包**"。
> 这是**层级混淆** —— 把 Core Service / Experimental Plugin / Plugin Bundle / Internal 混为一谈。
> 准确结论见 `docs/architecture/official-capability-matrix.md`：
>
> | 能力域 | 真实涉及包数 | 跨层 |
> |---|---|---|
> | 记忆与历史 | 6（goal / compaction×2 / session-query / -sqlite / tool-session-query） | L1 + L2 + L4 |
> | 工作区隔离 | 4（workspace-changes / experimental-worktree / -tool-worktree / fs-observation-policy） | L2 + L3 + L4 |
> | Team | 4（experimental-agent-team / -tool- / -profile / -client-ui-） | L2 + L3 |
> | 检索启用 | 2（experimental-session-search[bundle] → tool-session-query） | L2 + L3 |
> | **合计（去重）** | **16 个包** | **L1–L4 全覆盖** |
>
> **为什么这个区别重要**：`dsh-experimental-session-search` 是 **Bundle**（`kind: package-bundle`，
> 其 index.js 是 `export {}`，只做挂载）。把它叫作"一个插件"会掩盖它实际依赖的 L1 服务 + L4 后端，
> 导致升级评估时漏掉真正的兼容面。

| 能力域 | 首选 | 备选 | 放弃 |
|---|---|---|---|
| 记忆与历史 | **官方栈**（`dsh-goal` + `dsh-compaction*` + `dsh-session-query-sqlite`/`dsh-tool-session-query` + `dsh-agent-instructions`）+ 我们自己的 `AGENTS.md` 编辑器 | `dsh-mnemon`（MIT，有触发条件） | Obelisk（AGPL）、OpenViking（AGPL + 外部服务）、`dsh-memory-evolve`（与 Agent Teams 重复 + private） |
| 工作区隔离 | **官方**：`dsh-workspace-changes`（捕获）+ `dsh-fs-observation-policy`（守卫）+ `dsh-experimental-worktree`（原语）；**我们自己写** allocation/展示/合并/清理 | LayerFS（暂缓，结构性不匹配） | — |
| 知识库 | **不接**（官方 `grep`/`glob`/`fs-search` 足够） | WeKnora + `@wxg-prc-cpg/dsh-weknora`（有触发条件） | — |
| 角色/桌宠 | **现有帧动画 + 程序化**（自有） | 视频直用（自有素材）；Inochi2D（BSD-2，观察） | Live2D（当前阶段明确不做）、`ysyyhhh/dsh-pet`（停更 + fork） |
| Team / 长期任务 / 任务板 | **官方**（`dsh-experimental-agent-team` + `dsh-goal` + `dsh-jobs`） | — | `dsh-memory-evolve` 的 COI 调度 |

---

## 1. 候选 Provider 逐项结论表

> 完整证据（stars / 许可证 / 最近提交 / 条款）在 `memory-systems.md` §4、`workspace-isolation.md` §2、`live2d-evaluation.md` §1、`third-party-projects.md` §1。本表只给结论与一句话理由。

### 1.1 记忆 Provider

| Provider | 许可证（实测） | 解决什么（具体缺口） | 与官方重叠 | 集成方式 | 结论 |
|---|---|---|---|---|---|
| **官方栈 + 自研编辑器** | 随 runtime（0.2.1-rc.5） | G1 目标持久 / G2 上下文 / G3 检索 / 记忆加载链 | — | 挂载 + profile patch | **★ 首选** |
| `dsh-mnemon@0.5.37` | **MIT** | G4 治理 + G5 抽取确认（且是唯一"聚合层"而非"另一种存储"） | 部分 | 可选插件，用户显式装 | **◐ 备选** |
| `dsh-memory-evolve` | **MIT** 但 `private: true`、npm 404 | G4/G5 + Team 编排 | **高**（COI≈Agent Teams） | 只能 `github:` 装 | **✕ 放弃** |
| Obelisk | **AGPL-3.0**（提交 `b071cf723221` 改的） | G3 | **完全重叠** | 不可集成 | **✕ 放弃（硬拒绝）** |
| OpenViking | **AGPL-3.0**（提交 `ce998873f94d` 改的） | G4/G5 高级形态 | 部分 | 需 Python server | **✕ 放弃（硬拒绝）** |

### 1.2 隔离 Provider

| Provider | 许可证 | 解决什么 | 与官方重叠 | 集成方式 | 结论 |
|---|---|---|---|---|---|
| `dsh-workspace-changes` | 随 runtime | L1 变更捕获 | — | 挂载 | **★ 采用** |
| `dsh-fs-observation-policy` | 随 runtime | L2 读后写守卫 | — | 已在 `dsh-base` | **★ 采用** |
| `dsh-experimental-worktree` + `-tool-worktree` | 随 runtime（**experimental**） | L0 隔离原语 | — | 挂载 + 我们包装 | **★ 采用（包装）** |
| LayerFS `v1.1.0` | **MIT** | L3 协调 + 依赖不重装 | 部分 | 进程外 / 用户自装 | **◐ 暂缓（结构不匹配）** |
| `dsh-layerfs` | **license: null（无 LICENSE）** | 上述的 UI | — | 跟随 | **◐ 暂缓** |

### 1.3 知识库 Provider

| Provider | 许可证 | 解决什么 | 与官方重叠 | 集成方式 | 结论 |
|---|---|---|---|---|---|
| `@wxg-prc-cpg/dsh-weknora@0.1.0` | **MIT** | dsh agent 访问外部知识库 | 官方无 RAG | 进程内 client 插件（走 HTTP） | **◐ 暂缓** |
| WeKnora `v0.9.0`（服务端） | **NOASSERTION**（MIT + 长第三方清单） | 企业文档 RAG | — | Docker/K8s 服务端 | **◐ 暂缓（不打包）** |

### 1.4 角色 / 桌宠 Provider

| Provider | 许可证 | 解决什么 | 结论 |
|---|---|---|---|
| 现有帧动画 + 程序化叠加 | 自有 | 角色动效 | **★ 当前唯一路线** |
| 视频直用（VP9-alpha WebM） | 自有素材 | 更高质感、更低成本 | **◐ POC 候选（排在 Live2D 前）** |
| Inochi2D `inochi2d` | **BSD-2-Clause** | 参数驱动 2.5D | **◐ 观察（许可干净但生态薄）** |
| Live2D Cubism | 专有（repo `NOASSERTION`） | 参数驱动 2.5D（最成熟） | **✕ 当前阶段明确不做** |
| `PC2005-cloud/dsh-pet` | 代码 MIT / **素材 CC BY-NC-SA + 禁商用** | 桌宠 + 视频直用配方 | **★ 设计参考（不集成）** |
| `sundusk/dsh-pet` | MIT（素材无声明） | macOS 原生桌宠 | **◐ 暂缓** |
| `ysyyhhh/dsh-pet` | MIT（fork） | Codex pet 包兼容 | **✕ 放弃** |

---

## 2. 设计输入与约束建议（给 `capability-platform.md` 的输入，不替代它）

> 以下是**评估过程中发现的硬约束**，Lead 写 Provider 抽象时必须满足。每条都来自实测，不是偏好。

### 2.1 六条硬约束（Must）

| # | 约束 | 来源（为什么是硬约束） |
|---|---|---|
| **K1** | **单写入者：`AGENTS.md` 链的写入者必须唯一** | 官方 `dsh-agent-instructions` 只读加载，`maxBytes: 65536` 硬预算；多写入者 = 静默覆盖（`memory-files.js` 是原子 rename，无 CAS）。见 `memory-systems.md` §5.1 |
| **K2** | **单注入者：每回合记忆类系统提示注入必须唯一来源** | 多来源 = 预算竞争 + 权威冲突（模型无法判定哪份权威）。`dsh-memory-evolve` CHANGELOG 有实证：格式 v4 下插件注入消息会让**接收方整轮失败**，「重启就好、过一阵复发」 |
| **K3** | **Provider ≠ Storage：Provider 只能换后端，不能换语义** | 语义（什么是记忆、谁决定写入）必须由 DshCockpit 拥有，否则换 Provider 就换行为 |
| **K4** | **默认关 + 可一键 disable 且不丢数据** | 官方自己的形态就是范本：`dsh-experimental-session-search`「ships switched off in Web and Desktop」，`dsh-experimental-agent-team-profile`「ships with dsh switched off」 |
| **K5** | **experimental 包必须包一层可关闭的降级** | `dsh-experimental-*` 的 README 原文：「**Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.」→ T1 worktree 层与 Team 层都必须能降级回"普通目录 + 人工切换" |
| **K6** | **第三方 Provider 不得打包 AGPL，不得要求用户运维外部服务** | 详见 §3 判死理由；`product-principles.md` §1.2 反模式表 |

### 2.2 三条建议（Should，供 Lead 权衡）

| # | 建议 | 理由 |
|---|---|---|
| **S1** | **Capability 的粒度按"用户能理解的一件事"划，不按"技术栈"划** | 腾讯 WorkBuddy 用「**连接器**」这个词，用户立刻懂；「Provider」是工程词。`session-search` 与 `memory-files` 是**同一个 Capability（记忆与历史）的两个端点**，不该拆成两个 |
| **S2** | **Provider 必须有"取证字段"**：来源、版本、许可证 SPDX、可否打包 | 本轮评估最大的时间成本就是逐个核实许可证。若 Manifest 里强制带 `license: { spdx, url, packagingAllowed }`，下次评估是分钟级 |
| **S3** | **Starter Kit 比 Provider 抽象更早产生价值** | Claw-Empire 的 **Workflow Pack Profiles**（6 个内置 pack，各自有 routing schema / QA 规则 / 输出模板）是"Starter Kit"的具体形态。用户要的是"选一个包就能干活"，不是"选一个 Provider" |

### 2.3 一条反建议（Don't）

| # | 反建议 | 理由 |
|---|---|---|
| **X1** | **不要在只有一个实现时造 Provider 抽象层** | `product-principles.md` §1.2 明写：「为了扩展性先造抽象：只有一个实现时的抽象是负债」「Harness Adapter 抽象推迟到出现第二个 Adapter」。当前记忆/隔离/知识库**各只有一个实现候选（且都是官方）**——此时造 Provider 接口 = 纯负债。**建议：接口只在"确实出现第二个实现"时提取；现在只写"注册点 + 取证字段"的最小形状。** |

---

## 3. Deferred 清单（当前不集成，但保留再评估路径）

> **框架修订（2026-11-01 第二轮审查）**：本节早期标题为「判死清单」，并把操作定义写成「下一阶段不得出现在提案里」。
> 用户指出这**把可失效的工程理由当成了判决**。已改为 **Deferred / Re-evaluation** 框架。
>
> **判死 vs Deferred 的区别**：
> - ❌ 判死 = "永久不做，不得再提"（把风险变成禁令）
> - ✅ **Deferred = "当前不做，写清什么时候该重新看"**（把风险变成可追踪条件）
>
> 完整逐项修订（含集成边界、触发条件）见：
> `third-party-projects.md` §5 / `memory-systems.md` §附录 / `workspace-isolation.md` §2 / `live2d-evaluation.md` §1.6。
> **下表只保留索引级摘要，权威表述在专项文档。**

| 对象 | 当前结论 | 核心理由 | Re-evaluation 触发条件（摘要） |
|---|---|---|---|
| **Obelisk** | **Deferred** | AGPL-3.0-only（2026-06-14 从 MIT 变更）；能力被官方 session-query 覆盖；是第二个桌面 App | 出现商业授权；或用户自装 + 只读其 SQLite 的合规边界被确认（见 `memory-systems.md` O-B1…B4） |
| **OpenViking** | **Deferred（组件级分层）** | **不是"整仓 AGPL"**：`examples/` 与 `crates/` 是 Apache-2.0，`examples/hermes-plugin/` 是 MIT；主仓与 sdk/python、sdk/go、web-studio 无声明 | 需要 `examples/` 下 Apache-2.0 组件单独集成；或提供预编译分发包（见 `memory-systems.md` 14 组件矩阵） |
| **dsh-memory-evolve** | **Deferred** | MIT 已核实；与官方 Agent Teams 约 60% 功能重叠；`private: true` 未发 npm（**是可控性问题，不是质量问题**） | 官方 Team 出现无法满足的场景；或它发布 npm 且与官方版本对齐（见 M-T1…T5） |
| **ysyyhhh/dsh-pet** | **Deferred** | 停更 2.5 月；是 fork 且 parent 无 LICENSE；与办公室角色正交 | 恢复维护 + 上游补 LICENSE；或我们明确需要同形态参考实现 |
| **Live2D** | **Deferred（暂缓生产接入）** | Cubism Core 专有；Expandable Application 授权边界复杂 | **先向 Live2D 取得书面定性**（`live2d-evaluation.md` §P-0）；或找到无许可风险的等价方案 |

**Deferred 的操作定义**：当前不集成，**但保留全部技术研究记录**。
重启条件写在各专项文档的 `Re-evaluation` 表中，**不是重新讨论"要不要"，而是检查"触发条件是否已满足"**。

> 对 Live2D 的特别说明：早期表述「Expandable 免费项目原则上不给批」「未获批发布 = 须销毁全部派生作品」
> 经第二轮条款原文复核，**两处都过强**。准确表述见 `live2d-evaluation.md` §1.6（两条责任链分离）。

---

## 4. "采用"三项的必答三问（Lead 的口径要求）

对每一个「★ 采用」，回答：**为什么官方能力不够？为什么必须是这个？维护成本谁承担？**

### 4.1 官方 `dsh-workspace-changes`（变更捕获）

| 问题 | 答案 |
|---|---|
| **为什么官方能力不够？** | **它够。** 这不是"官方不够"，是"我们 0.1.5 上没有，而它已经解决了我们 `WORK-FIRST-V0.7` §3.2/§3.3 的变更捕获问题"。采用它是**为了删掉我们自己的弱实现**（`workspace-store.js` 只哈希 200 个文件） |
| **为什么必须是这个？** | 因为它是我方缺口（`workspace-patch` / `workspace-files` Artifact + 受信 Verification 证据）的**官方唯一实现**，且设计比我们的手写 manifest 严格得多（临时 object dir 不污染仓库、无 git 时降级到文件工具捕获、逐文件 diff + `coarse` 降级） |
| **维护成本谁承担？** | **官方**。我们只承担"挂载 + 消费 `workspace/changes` 事件 + 渲染 UI"。迁移风险在 0.2.x 迁移（task-1）里一次性支付 |

### 4.2 官方 `dsh-experimental-worktree`（隔离原语）

| 问题 | 答案 |
|---|---|
| **为什么官方能力不够？** | **L3 协调不够**：官方没有"Team 有 N 个 teammate，自动分配 worktree"的分配器，也没有合并责任归属。但它**提供了正确的原语**，不够的是协调层 |
| **为什么必须是这个？** | 因为**自己实现 worktree 管理会重踩官方已文档化的全部坑**：`GIT_NO_LAZY_FETCH`（git ≥2.45）、filter 禁用、LFS pointer 不解、不复制 uncommitted、`.gitignore` 的 `*` 池管理。这些坑我们踩了不会写文档 |
| **维护成本谁承担？** | **混合**：原语维护归官方；**allocation / 展示 / 合并 / 清理归我们**（这是 L3 中我们真正拥有的那部分）。且因为它是 `dsh-experimental-*`（**contracts can change freely**），我们必须包一层可关闭的降级（K5） |

### 4.3 官方记忆栈 + 自研 `AGENTS.md` 编辑器

| 问题 | 答案 |
|---|---|
| **为什么官方能力不够？** | 官方**没有 memory 包**（`grep -i mem` = 0），且 `dsh-session-query-sqlite` 在 web profile 里被配成 `openAt: never`（能力在、默认关）。所以"官方有"是**能力有、产品面没有**。缺的是 G3 产品面 + G4 写入治理 |
| **为什么必须是这个？** | 因为**所有第三方记忆方案都会违反 K1/K2**（单写入者 / 单注入者）。而官方原材料（goal 的 CAS + compaction 的确定性 replay + session-query 的 FTS5 + agent-instructions 的去重加载链）**已经覆盖了记忆的存储与加载**，我们只需要做治理 UI。——对比之下，Obelisk/OpenViking 是"另一套存储"，mnemon 是"另一套治理"，都会引入双写入 |
| **维护成本谁承担？** | **我们**（`memory-files.js` 扩展）。这是本轮唯一"我们承担维护成本"的采用项，也是唯一"必须我们做"的——因为它就是产品差异化 |

---

## 5. 「备选」的启动条件（写死，避免以后拍脑袋）

| 备选 | 启动条件（**全部**满足才启动） |
|---|---|
| **`dsh-mnemon`** | (a) 已完成 0.2.x 迁移并稳定 ≥1 个版本周期；(b) 出现可复现的记忆诉求（同一决策被重复解释 ≥3 次，或"上次那个结论在哪"成为高频问题）；(c) 我方 `memory-files.js` 已扩到多 scope 且被证明不够用 |
| **LayerFS** | (a) ≥3 个用户投诉并行 worktree 重装依赖的等待；(b) LayerFS 发布 npm 可装的**预编译二进制**（mac arm64 + win，无需 Docker/cargo）；(c) 提供**崩溃持久性**；(d) 有 dsh desktop 的官方实测记录 |
| **WeKnora / `dsh-weknora`** | (a) 出现明确企业/团队用户（非个人）；(b) 文档 ≥10 万级或大量 PDF/扫描件；(c) 用户**自备** WeKnora 实例；(d) 官方仍无 workspace 文档检索 |
| **Inochi2D** | (a) 帧 + 视频路线被证明到顶；(b) 找到可用的 **web 运行时**（本次未找到成熟仓库）；(c) `inochi-creator` 恢复活跃（当前 2025-06 停更） |
| **`sundusk/dsh-pet`** | (a) 我们需要 macOS 原生菜单栏常驻形态；(b) **素材授权可核实**（当前 `ThirdPartyNotices.txt` 不含鲸鱼娘） |

---

## 6. 下一阶段动作（按 ROI 排序，全部不接第三方）

| # | 动作 | 依赖 | 承担的维护成本 | 解锁什么 |
|---|---|---|---|---|
| **A1** | **0.2.x 迁移**（0.1.5-rc.2 → 0.2.1-rc.5+） | 无 | 一次性（task-1 评估） | **一步解锁 5 个官方能力**：`workspace-changes`、`session-search`、`tool-session-query`、`plugin-manager/market`、`agent-team` |
| **A2** | **打开官方检索**：`session-query-sqlite.openAt: never` → `first-search` + UI 入口 | A1 | 极小 | 替代 `src/session-search.js` 的 substring 弱实现 |
| **A3** | **扩展 `memory-files.js`**：2 个 `AGENTS.md` → 多 scope（project / global / `.local.md` overlay）+ 版本 + diff | 无 | **我们**（长期） | G4 写入治理的基础 |
| **A4** | **`dsh-goal` 接成 Mission 持久层**（`WorkItem.goal` ↔ `dsh-goal`；plan/boundaries 留我们侧） | A1 | 我们（映射层） | 跨轮/跨重启目标存活 |
| **A5** | **吸收 Claw-Empire 三件套**：① Kanban 加「协作中」状态 ② 合并需人批准 ③ stale `working` 恢复 sweep | 无 | 我们 | 三个低成本高价值机制（③ 直接对应 `AGENTS.md` §7 的「crash 受信来源」缺口） |
| **A6** | **T1 worktree 包装**：allocation + 未提交改动拦截 + 清理入口 | A1 | 我们（L3 协调层） | 并行多 agent 的安全落地 |
| **A7** | **预留角色渲染后端接口**（Sprite / Video / Parametric），**不实现** | 无 | 极小 | 将来换 Inochi2D 不改架构 |

**明确不做（本轮）**：任何第三方记忆 Provider、LayerFS、WeKnora 服务端、Live2D、dsh-pet 集成、任何"Provider 抽象接口"的完整实现（见 X1）。

---

## 7. 与 Lead 的 `capability-platform.md` 的分工

| 内容 | 归属 |
|---|---|
| 候选 Provider 评估 / 许可证 / 推荐度 / 判死 | **本文（本文已给完）** |
| Provider 抽象接口形状 | `capability-platform.md`（Lead） |
| Capability Manifest schema | `capability-platform.md`（Lead）——本文只给 S2 的"取证字段"建议 |
| Profile Composer | `capability-platform.md`（Lead） |
| Plugin Lifecycle | `capability-platform.md`（Lead） |
| **硬约束 K1–K6** | **`capability-platform.md` 必须满足**（本文给输入） |
| 记忆专项证据 | `memory-systems.md` |
| 隔离专项证据 | `workspace-isolation.md` |
| Live2D 条款清单 | `live2d-evaluation.md` |
| 总表 + 桌宠辨析 + 参考项目 | `third-party-projects.md` |

---

## 8. 待验证 / 无法核实清单

| 项 | 状态 | 原因 |
|---|---|---|
| 各候选的 issue 响应质量 | **无法核实** | GitHub REST 只给 `open_issues_count`；评质量需 GraphQL + 认证 |
| `dsh-mnemon` 与本项目 UI 的兼容性 | **未验证** | 它要求 0.2.0+，我们 pin 0.1.5；本次不装 |
| 官方 0.2.1 的 `dsh-tool-session-query` 是否默认挂载 | **未验证** | `dsh-experimental-session-search` README 说「ships switched off」，但我未 boot 0.2.1 profile 实测 |
| `ctx.worktrees.create` 能否给**别人的 Session** 开 worktree | **未验证** | 直接影响 T1 allocation 形态（"Lead 代开" vs "各自开 + 记账"） |
| `dsh-workspace-changes` 的 `workspace/changes` 事件能否在 DshCockpit mux 拿到 | **未验证** | 属 task-1 范围 |
| LayerFS 实测性能 / FUSE 下 chokidar 行为 | **未验证** | 判定暂缓，未安装 |
| WeKnora `NOASSERTION` 是否等于纯 MIT | **部分核实** | `LICENSE` 写「MIT except for the third-party components listed below」+ 长清单；采用前需逐项审计 |
| `dsh-layerfs` 许可证 | **无法核实** | 仓库无 LICENSE，GitHub `license: null` |
| Cubism Core 的 `RedistributableFiles.txt` 具体内容 | **无法核实** | 需注册下载 SDK（接受 EULA） |

---

## 9. 证据索引

本文不重复列证据——四份专项文档末尾各有一节完整索引。关键入口：

- 官方包清单与 `--dump-config`：`memory-systems.md` §1.1、§1.4
- 许可证条款（Live2D）：`live2d-evaluation.md` §1.7（C1–C16 表，含 URL）
- AGPL 判定依据（commit hash）：`memory-systems.md` §4.1、§4.2
- LayerFS 平台/持久性限制：`workspace-isolation.md` §2.3
- 桌宠三仓辨析 + 素材授权：`third-party-projects.md` §2
- 参考项目设计研究（Pi / Claw-Empire / Agent Canvas / Retinue / WorkBuddy / Kimi Code）：`third-party-projects.md` §4
