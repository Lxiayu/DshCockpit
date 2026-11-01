# ADR-0005：记忆与历史采用官方栈，零第三方 Memory Provider

- **状态**：✅ **已接受（用户 2026-11-01 决策：按已记录决策与替代方案继续执行，保留未验证项的 POC 门槛）**
- **日期**：2026-11-01
- **决策者**：用户（待确认）
- **影响范围**：`src/session-search.js`、`src/search-worker.js`、`src/memory-files.js`、Capability Platform 的 `memory` / `history` 能力
- **相关文档**：`docs/research/memory-systems.md`（详细评估）、`docs/architecture/capability-platform.md`、`docs/adr/ADR-0003-capability-packs-not-marketplace.md`

## 1. 背景

新定位要求"跨 Session 的项目连续性"。直觉上这需要一个 Memory Provider（Obelisk / OpenViking / dsh-memory-evolve 等）。

用户提示词同时要求：**不能同时引入多个功能重叠的 Memory Provider**，且必须论证"为什么官方能力不够"。

## 2. 事实核查（2026-11-01 实测）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 官方 0.2.1-rc.5 asar 内 **308 个** `@deepseek-ai` 包，**`grep -i mem` 命中 0** —— 官方**没有** memory 包 | asar 全量包名过滤 |
| F2 | 官方有记忆的**原材料**（4 类），但**没有治理层** | 见下表 |
| F3 | 官方 `dsh-session-query-sqlite` 提供 SQLite FTS5 跨会话/会话内检索 | 包 README + `lib/index.js:480` config schema |
| F4 | **我方当前 web profile 把检索后端配成 `openAt: never`**（能力存在但默认关闭） | 实测 `node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config \| grep -A6 session-query` → `path: ':memory:'`, `openAt: never` |
| F5 | 0.1.5 已含 `dsh-goal` / `dsh-compaction*` / `dsh-session-query*` / `dsh-agent-instructions` | 本地 244 包实测 |
| F6 | 0.1.5 **缺** `dsh-tool-session-query`（面向模型的检索工具）/ `dsh-experimental-session-search`（bundle） | 同上 |
| F7 | 我方 `src/session-search.js` 是**壳侧自研**的跨会话搜索 | 代码存在 |
| F8 | Obelisk 许可证为 **AGPL-3.0**（2026-06 从 MIT 变更） | `docs/research/memory-systems.md`（独立评估，含 LICENSE URL） |
| F9 | OpenViking 主仓 **AGPL-3.0**；npm 插件声称 Apache-2.0 但 tarball 无 LICENSE 文件 | 同上 |
| F10 | dsh-memory-evolve 功能面约 **60% 与官方 Agent Teams 正面重复**，且 private 未发布 npm | 同上 |

### 2.1 官方提供的「记忆原材料」（4 类）

| 能力 | 官方包 | 提供什么 | 不提供什么 |
|---|---|---|---|
| 跨轮目标持久 | `dsh-goal` | 目标跨 turns / resume / fork / 重启存活；CAS 更新；phase 状态机 | **每 Session 至多 1 个**；不跨 Session |
| 上下文压缩 | `dsh-compaction` / `-basic` | token 压力驱动的自动压缩；`/compact` | 只是让会话跑得下去，**不保证下个会话记得住** |
| 历史检索 | `dsh-session-query-sqlite` | SQLite FTS5 跨会话检索（**默认 `openAt: never`**） | 默认关闭；无"记忆治理" |
| 指令加载 | `dsh-agent-instructions` | 加载 `AGENTS.md` 类指令文件 | 只加载，不治理 |

### 2.2 缺口到底在哪

> **官方缺的不是"存储"，是"治理"：准入、去重、冲突、可见、可回溯。**

但这个缺口**不在第三方仓库里** —— 它在 DshCockpit 自己的产品面上。

现有 `src/memory-files.js`（94 行）只管理两个 `AGENTS.md` 文件（白名单 + 原子写），是"原材料"层，不是"治理"层。

## 3. 备选方案

| 方案 | 描述 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **A. 官方栈 + 自研治理层** | 用 `dsh-goal` + `dsh-compaction` + 官方 session-query + 自研 AGENTS.md 治理 | 零许可证风险；零外部依赖；与官方一致 | 需要自研治理层（但这是产品价值所在） | ✅ **采用** |
| **B. Obelisk** | 第三方记忆系统 | 功能完整 | **AGPL-3.0**（2026-06 从 MIT 变更）；MIT 项目无法合规打包；分发毒化 | ❌ 否决 |
| **C. OpenViking** | 火山引擎记忆/上下文 | 大厂背书 | 主仓 **AGPL-3.0**；npm 插件许可证不一致（声称 Apache-2.0 但 tarball 无 LICENSE）；依赖外部服务 | ❌ 否决 |
| **D. dsh-memory-evolve** | 社区记忆进化插件 | 贴合 dsh | 约 60% 功能与官方 Agent Teams 重复；private 未发 npm；不可安装 | ❌ 否决 |
| **E. dsh-mnemon** | MIT，「记忆聚合层」而非另一种存储 | MIT；唯一不重复存储的方案 | 仍引入额外依赖；当前无明确收益证据 | ⚠️ **备选**（有触发条件） |
| **F. 同时上多个** | — | — | **记忆是唯一一类"同时上两个必坏"的 Provider**：并行治理层会与 `dsh-agent-instructions` 加载链冲突，产生两份互相矛盾的"项目事实" | ❌ 严禁 |

## 4. 决策

**采用方案 A。**

1. **不引入任何第三方 Memory Provider。**
2. 记忆相关能力全部建立在官方栈之上 + DshCockpit 自研的**治理层**（即 Mission Core 的 Shared Context）。
3. **让官方检索能力可用**：把 `session-query-sqlite` 从 `openAt: never` 改为可用配置（通过 profile patch，属于 Capability Pack 的职责）。
4. **重新评估自研 `src/session-search.js`**：
   - 若官方检索可用，**优先消费官方**（`ctx.sessionQuery`），自研降级为 UI 层。
   - 但**不立即删除**（0.1.5 没有 `dsh-tool-session-query`，且官方默认关闭）。
5. **`dsh-mnemon` 列为备选**，触发条件见 §8。

## 5. 决策理由

1. **许可证是硬门槛**：Obelisk / OpenViking 均为 AGPL-3.0，而 DshCockpit 是 MIT。AGPL 的分发条款与 MIT 项目不兼容（不能直接打包进 MIT 安装包）。这不是偏好问题，是法律问题。
2. **官方原材料已足够**：四类原材料覆盖了"目标持久 / 上下文不溢出 / 历史可检索 / 指令可加载"。缺的是治理，而治理必须在产品层做（因为治理规则与 Mission 语义强绑定）。
3. **避免自研记忆系统**（用户明确警告）：我们不建自己的记忆存储，我们用官方存储 + 自研**索引与共识层**。
4. **避免并行治理层**：任何第三方记忆插件都会往 `AGENTS.md`/`SKILL.md` 语义上加第二个治理层，与官方加载链冲突。
5. **AGPL 的传染风险必须记录**：即使只"运行时依赖"而非链接，AGPL 的网络交互条款也可能触发。

## 6. 代价

| 代价 | 说明 |
|---|---|
| 需要自研治理层 | Mission Core 的 Shared Context 就是这个治理层（已在 P1 规划中） |
| 官方检索需启用配置 | 需要写 profile patch，且不同版本配置项可能变化 |
| `src/session-search.js` 存亡需决策 | 短期保留、长期可能让位官方 |
| 无法用成熟第三方记忆方案 | 失去"开箱即用的复杂记忆"能力 |

## 7. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **官方检索能力不稳定/被移除** | 低 | 中 | 保留 `src/session-search.js` 作为降级路径 |
| **治理层变成"另一个记忆系统"** | 中 | 高 | Mission Core 边界铁律：只做跨 Session 索引与共识，不做存储引擎 |
| **`dsh-goal` 语义变化** | 中 | 中 | 只读消费，不写；feature-detect |
| **用户仍想要"AI 自动记住一切"** | 中 | 中 | 用 Brief + Shared Context 提供"有结构的记忆"，而非"无结构的全量记忆" |

## 8. 后续重新评估的触发条件

1. 官方提供 memory 治理层（如 memory 准入/去重/冲突）。
2. `dsh-goal` 支持跨 Session（则 Mission 的 goal 部分可能让位）。
3. 出现 MIT/Apache 许可的、真正补充官方缺口的 Memory Provider（如 `dsh-mnemon` 成熟）。
4. 用户明确需要 RAG 式知识检索（则重新评估 KnowledgeProvider，而非 MemoryProvider）。

## 9. 与 `src/session-search.js` 的处置建议（分阶段）

| 阶段 | 处置 |
|---|---|
| 现在（0.1.5） | **保留**（官方无 `dsh-tool-session-query`，且默认关闭） |
| 升级到 0.2.x 后 | 用官方能力做后端，自研退为 UI/降级；跑一次能力对比 |
| 若官方能力等价 | 删除自研，减少维护面（记 Tech Debt Issue） |

## 10. 未验证声明

> ⚠️ 本 ADR 中关于第三方的许可证与功能描述来自 `docs/research/memory-systems.md` 的独立评估（含 GitHub API / npm registry 实测，2026-11-01）。
> 关于"官方 session-query 在 0.2.1 的默认配置"**仅在本机 0.1.5 的 web profile 上实测**（F4）；0.2.1 的默认值**未验证**。
> 关于 `dsh-tool-session-query` 的能力描述来自 asar 内 README，**未运行验证**。
