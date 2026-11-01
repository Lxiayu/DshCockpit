# 记忆与历史专项评估（2026-11-01）

> 状态：**评估结论（Deferred / Re-evaluation 框架）** · 核查日期 **2026-11-01（Asia/Shanghai）**，许可证复核 **2026-11-01**
> 边界：本文只给「记忆 Provider 该选谁、为什么、不选谁、什么时候重评」。Provider 抽象接口 / Capability Manifest / Profile Composer 的设计归 `docs/architecture/capability-platform.md`（Lead 执笔），本文只给设计输入与约束。
> 方法：本机官方 0.2.1-rc.5 asar 逐包解包 + GitHub API/raw 实抓 + npm registry 实查（含 tarball 解包）。**所有 stars/许可证/版本号均为 2026-11-01 实测**；无法核实的一律标注「无法核实」。
> **本版修订原则**：上一版用「放弃 / 硬拒绝 / 判死」表述三个候选。用户指出结论过绝对。本版改为 **Deferred（暂缓）/ Re-evaluation** 框架，**保留全部实测数据**，只修正结论表述与判定粒度——尤其是 **OpenViking 从"一句话判 AGPL"改为组件级许可证矩阵**。

---

## 0. 一句话结论

**记忆 Provider 首选 = 官方栈（`dsh-goal` + `dsh-compaction*` + `dsh-session-query-sqlite`/`dsh-experimental-session-search`）+ 我们自己的 `AGENTS.md` 编辑器，零第三方。备选 = `dsh-mnemon`（唯一「记忆聚合层」而非「另一种存储」的实现，MIT）。**

**三个此前被"判死"的候选，本版改判如下**：

| 候选 | 上一版结论 | **本版结论** | 一句话理由（**不是永久判决**） |
|---|---|---|---|
| **Obelisk** | 放弃（硬拒绝） | **Deferred / Re-evaluation** | 硬事实只有一条：**AGPL-3.0-only**，不能进 MIT 安装包分发。这约束的是**分发形态**，不是"永远不接触"。用户自装 + 进程隔离是合法路径，只是当前不做 |
| **OpenViking** | 放弃（硬拒绝） | **Deferred（组件级分层：部分可用 / 部分不可用）** | 主项目 AGPLv3、**`crates/ov_cli` 与 `examples/` 是 Apache-2.0**、`sdk/typescript` 声明 Apache-2.0、`examples/hermes-plugin` 是 MIT。**上一版"一句话判 AGPL"是错的**——它是多许可证组件化项目，见 §4.2 组件级矩阵 |
| **dsh-memory-evolve** | 放弃（功能面重复 + 维护风险） | **Deferred / Re-evaluation** | **MIT 已核实**（LICENSE 原文 + GitHub API `spdx_id: MIT` + `package.json` `"license": "MIT"`）。功能重叠（COI ≈ Agent Teams）是**当前不集成的理由之一**，不是永久否决；`private: true` + npm 404 意味着"未发布"，**不等于"质量差"** |

**下一阶段动作不变（零第三方）**：打开官方已关闭的检索 + 扩展我们自己的 `AGENTS.md` 编辑器 + 把官方 `dsh-goal` 接成 Mission 持久层。**但"零第三方"是本阶段的选择，不是对这三个项目的终审。**

---

## 1. 官方能力实测（证据：asar 解包 + `--dump-config`）

### 1.1 包清单事实

| 事实 | 证据 |
|---|---|
| 官方 desktop runtime = **0.2.1-rc.5**，asar 内 `@deepseek-ai` 包 **308 个** | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 头部 JSON 解析 |
| **`grep -i mem` 命中 0 个包**（无 `dsh-memory*`） | 同上，全量包名过滤 |
| 我们本地 pin 的是 **0.1.5-rc.2**，profile 下 `@deepseek-ai` 包 **244 个** | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json` → `"version": "0.1.5-rc.2"`；`ls \| wc -l` = 244 |
| 0.1.5 **已含** `dsh-goal` / `dsh-goal-round-driver` / `dsh-tool-goal` / `dsh-jobs` / `dsh-session-query` / `dsh-session-query-sqlite` / `dsh-compaction` / `dsh-compaction-basic` / `dsh-agent-instructions` / `dsh-persona` / `dsh-workflow` / `dsh-skill` / `dsh-skill-filesystem` / `dsh-user-approval` / `dsh-user-questions` | 本地 244 包名逐条比对 |
| 0.1.5 **缺** `dsh-experimental-session-search` / `dsh-tool-session-query` / `dsh-workspace-changes` / `dsh-experimental-agent-team` / `dsh-experimental-worktree` / `dsh-plugin-manager` / `dsh-plugin-market` / `dsh-experimental-ralph-bundle` | 同上 |

**这意味着两件事**：官方记忆原材料在 0.1.5 就有了（不需要第三方）；但**面向模型的检索入口**（`dsh-tool-session-query`）与**侧栏搜索 UI** 要 0.2.1 才有。

### 1.2 `dsh-goal`（跨轮目标持久）

来源：asar 内 `packages/goal/README.md`（`/dsh/node_modules/@deepseek-ai/dsh-goal/README.md`）

- 「one long-running completion objective persist across turns, session resume, fork, and process restarts」；phase = create/edit/pause/resume/complete/block/clear；**CAS 更新拒绝 stale view**；默认 `maxGoalRounds: 256`。
- 明确边界：「**stores goal state but does not schedule work**」「continuation permission remains process-local rather than durable」。
- **每 session 最多 1 个当前 goal**：未完成必须先 edit/pause/resume/block/clear 才能换。

对照 `WORK-FIRST-V0.7.md` §3.1 的 `WorkItem`：goal 覆盖了 `goal`（用户原话目标）+ 状态机 + 跨重启存活；**不覆盖** `boundaries` / `plan` / `依赖` / Artifact / Evidence。这四项是我们真正需要自己拥有的（§3）。

### 1.3 `dsh-compaction*`（上下文压缩）

来源：asar 内 `compaction/README.md`、`compaction-basic/README.md`

- `dsh-compaction` = 「shared compaction contract」，自身不做压缩；`dsh-compaction-basic` = 自动压缩后端（token 压力驱动 + 溢出后压缩重试 + `/compact` 手动）。
- 关键限制（原文）：「**It cannot reduce the system prompt, tools, or session prefix**, or split one indivisible unit such as a single huge tool call.」
- 压缩后「The shadowed content stays in the session log」，replay 可确定性复现。

**这是上下文层，不是记忆层**：它保证"会话跑得下去"，不保证"下个会话记得住"。

### 1.4 `dsh-session-query` / `dsh-session-query-sqlite` / `dsh-experimental-session-search` / `dsh-tool-session-query`（历史检索）

来源：asar 内四个包的 README

| 包 | 能力 | 0.1.5 有没有 |
|---|---|---|
| `dsh-session-query` | `ctx.sessionQuery` 统一查询服务：`listSessions` / `readSession` / `filterSessions` / `filterEvents` / `readTitleSnapshots` / `listEvents` / `readSurface` / `readEvent` / `traceSession` / **`traceEvent`** / `searchSessions` / `searchEvents` | **有**（0.1.5 的 lib 里已导出 `listSessions`/`filterEvents`/`traceSession`；`searchSessions` 在 sqlite 后端） |
| `dsh-session-query-sqlite` | SQLite **FTS5** 排名检索，独立派生库（不碰 session-persistence 库），`journalMode: wal`，`defaultLimit: 20`，`maxLimit: 100`，`openAt: startup\|first-search\|never` | **有** |
| `dsh-experimental-session-search` | bundle：5 个只读全局工具，进入所有 Agent（含 minimal preset）；惰性 `:memory:` 索引；**默认关闭**（Web/Desktop 都是 switched off） | **没有** |
| `dsh-tool-session-query` | 面向模型的 5 个只读工具：`session_search` / `session_event_search` / `session_trace` / `session_event_read` / …；**跨会话授权只认 cwd 精确相等** | **没有** |

**关键实测（这条直接决定我们自研 `src/session-search.js` 的存亡）**：

```
$ node dsh/lib/bin.js --profile web --dump-config | grep -A6 'id: session-query-sqlite'
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: ':memory:'
    openAt: never
```

即：**官方在我方当前安装的 web profile 里把检索后端配成了 `openAt: never`——能力存在但默认不启用**。所以「官方没有检索」是错的，「官方有检索但默认关着」是对的。我们的 `src/session-search.js` 是在**替一个默认关闭的官方能力做壳侧实现**。

### 1.5 `dsh-agent-instructions`（记忆的唯一官方写入面）

来源：asar 内 `agent-instructions/README.md`

- 加载链：`$DSH_HOME/AGENTS.md` → `<agentsHome>/AGENTS.md`（`$DSH_AGENTS_HOME` 或 `~/.agents`）→ 项目链（`.git` 标记 root，broad→specific 顺序）。
- 候选文件：`AGENTS.md` / `CLAUDE.md` 为 base，`AGENTS.local.md` / `CLAUDE.local.md` 为 additive overlay。
- **`maxBytes: 65536`（`dsh-base` 默认）** 硬预算：超了先省略更广的文件。
- 刷新语义：「does not watch external edits continuously」；成功 fs 操作会发现新的嵌套文件；**session resume 会 reconcile baseline**。改 cwd 会在下一次请求前重载项目链。
- 去重：内容 trim 后相同则只渲染一次（`CLAUDE.md` 与 `AGENTS.md` 重复不重复注入）。

**这就是官方的"长期记忆"实际形态：一份有字节预算、有加载顺序、有去重、resume 时 reconcile 的 Markdown 链。** 我们 `src/memory-files.js` 管的正是这条链的两个端点（project / global），语义完全对齐（见 §2）。

---

## 2. DshCockpit 已有能力完成度（读源码，不是看 README）

| 模块 | 行数 | 真实能力 | 完成度判定 |
|---|---|---|---|
| `src/memory-files.js` | 94 | 只管 **两** 个 `AGENTS.md`（`<workspace>/AGENTS.md`、`$DSH_HOME/AGENTS.md`）。闭集白名单 `isAllowed`（`path.resolve` 后精确比较）、`MAX_BYTES = 2MiB`（注释说明官方 cap 是 1MiB，留了余量）、原子 `tmp + rename`、缺失视为可创建 | **完成（但只是编辑器，不是记忆系统）** |
| `src/session-search.js` | 87 | 全量遍历 `$DSH_HOME/sessions/<proj>/<sess>/`，`pickSessionFile` 选文件，起 worker 线程，`limit=20` | **完成**（IPC 只有一个：`search:query`，`src/main.js:2664`） |
| `src/search-worker.js` | 74 | `fzstd.decompress` + `toLowerCase` + `indexOf`；每文件跳过错误；首行 JSON 拿 `cwd`/`id`；按 `mtimeMs` 降序 | **完成（但只是 substring 匹配，无排名、无分页、无 token 化）** |
| `test/session-search.test.js` | — | **3 个 test**：`extractText` 抽取、跨会话 substring、以及一个边界 | **薄**：无 FTS、无排名、无中文分词、无大文件性能断言 |

**判定**：`session-search.js` 的能力**严格劣于**官方 `dsh-session-query-sqlite`（FTS5 排名 + 游标分页 + token/phrase 匹配 vs 我们的 substring 扫描）。它唯一的价值是「在 0.1.5 上跑、不依赖 profile 配置」。这个价值随 0.2.1 迁移**必然归零**。

权威记忆文件的实际契约（`memory-files.js` 注释原文）：「dsh (dsh-agent-instructions) reads workspace instructions from `<cwd>/AGENTS.md` plus the global `$DSH_HOME/AGENTS.md` when a session starts」——与我们实测的官方 README 一致，**这部分没有重复造轮子，是壳侧 UI 该做的事**。

---

## 3. 官方三者合起来还缺哪一块（Lead 要求的正面回答）

把官方三件套的语义摊开：

| 缺口 | 官方谁管 | 官方管到什么程度 | 缺的那部分 |
|---|---|---|---|
| **G1 目标跨轮存活** | `dsh-goal` | 单 session 单 goal，phase + CAS + round cap，跨恢复/fork/重启 | **多 goal 并行**（官方明确 skip：「skip it for … parallel objectives」）；**跨 session 的 mission 编排**（哪个 goal 属于哪个 WorkItem） |
| **G2 会话跑得下去** | `dsh-compaction-basic` | token 压力自动压缩 + 溢出重试 + `/compact` | 无（这层官方够用，**不要再自己写**） |
| **G3 历史可检索** | `dsh-session-query-sqlite` + `dsh-tool-session-query` | FTS5 排名、游标分页、`traceSession`/`traceEvent`、cwd 授权 | **默认 `openAt: never`**——需要有人把它打开并给出产品面（UI + 默认策略）。这是壳该做的，不是新 Provider |
| **G4 长期事实的写入/治理** | `dsh-agent-instructions`（只读加载） | 加载链、去重、65KiB 预算、resume reconcile | **写入侧的治理**：准入（谁可以写）、去重（同一事实写两次）、冲突（两条矛盾记忆谁赢）、可见（用户能不能看到/编辑/删除）、可回溯（这条记忆来自哪个 session）。官方**完全不做**，因为它只读文件 |
| **G5 记忆的"进化"** | — | 无 | 从真实会话里抽取候选事实 → 人工确认 → 写入。这是 `dsh-memory-evolve` / `dsh-mnemon` 声称做的事 |

**结论：真正空白的只有 G4（写入侧治理）和 G5（抽取+确认），而且 G4 是 G5 的前置。** G1/G2/G3 官方已覆盖，G3 只差"打开 + 产品面"。

所以第三方 Provider 的位置只有两个候选位：**「G4 治理层」** 或 **「G5 抽取器」**，不可能是"再来一个存储"。

---

## 4. 候选逐项核实（2026-11-01 实测）

### 4.1 Obelisk — **Deferred / Re-evaluation**（上一版：放弃/硬拒绝）

#### 4.1.1 实测数据（全部保留）

| 项 | 实测值 | 证据 |
|---|---|---|
| 仓库 | `tommy0103/obelisk` 存在，活跃 | GitHub API |
| stars / forks / open issues | **756 / 52 / 64**（本版复核；上一版记录 751★，同日内自然增长） | 同上 |
| 语言 | JavaScript（Electron App + CLI） | 同上 |
| **SPDX（确切）** | GitHub API `license.spdx_id = **AGPL-3.0**`；**README 与 `packages/dsh-plugin/package.json` 均写 `AGPL-3.0-only`** | GitHub API `license` 字段；README「License」段；raw `packages/dsh-plugin/package.json` |
| 根 `package.json` | `"license": "AGPL-3.0"`、`"private": true`、`version 0.2.0` | raw `package.json` |
| 许可证变更史（**可引用证据**） | LICENSE 文件的最近提交 = **`b071cf723221`**，2026-06-14T18:48:04Z，message：「**chore: switch license from MIT to AGPL-3.0** and add demo screenshot」 | `GET /repos/tommy0103/obelisk/commits?path=LICENSE`；文件 https://github.com/tommy0103/obelisk/blob/main/LICENSE |
| 插件包许可证 | `packages/dsh-plugin/package.json` → `"name": "@obelisk/dsh-obelisk-plugin"`, `"license": "AGPL-3.0-only"`, `"private": true`, `version 0.1.0` | https://raw.githubusercontent.com/tommy0103/obelisk/main/packages/dsh-plugin/package.json |
| CLI 许可证 | `@obelisk-apps/cli@0.3.1`（npm，2026-10-25 发布）→ `license: AGPL-3.0` | https://registry.npmjs.org/@obelisk-apps%2fcli |
| 最近提交 | **2026-10-31T19:30:36Z**（本版复核；上一版 2026-10-30T02:13:29Z） | GitHub commits API |
| created / pushed | 2026-05-29T18:22:23Z / **2026-10-31T19:30:36Z** | 同上 |
| 能力 | 多 provider（Claude Code / Codex / Copilot / **DeepSeek Harness** / Hermes / Kiro / Kimi Code / OMP / OpenCode / Pi / ZCode）本地历史 → 一个 SQLite；`overview()/sessions()/search()/messages()/memories()/summaries()/sql()`；FTS5；Electron 浏览 App；weekly recap | README |
| **商业授权路径** | **无法核实**：README 的 License 段只写 AGPL-3.0-only + 对衍生作品的要求，**无 dual-license / commercial license / pricing / contact-for-licensing 任何字样**（`grep -inE "commercial|enterprise|pricing|sponsor|dual"` → **0 命中**）。**但 AGPL 项目普遍存在私下商业授权，只是未公开声明** | 本版实测 `README.md`（252 行）全文 grep |
| 仓库目录 | 含 `packaging/`、`install.sh`、`app/`（Electron）、`packages/`、`skills-lock.json` | GitHub contents API |

#### 4.1.2 现状判定

**Deferred**。**硬事实只有一条：它是 AGPL-3.0-only，因此不能作为依赖被 DshCockpit 打包分发给用户**——因为 DshCockpit 是 MIT，把 AGPL 代码编进 Electron 安装包即触发 AGPL 的传染与网络条款，等于要求整个对应部分按 AGPL 开源。**这不是"注意一下"，是"这种分发形态不成立"。**

**但这条硬事实约束的是「分发形态」，不是「这个项目永远不能出现在 DshCockpit 的生态里」。** 上一版把两者划等号（"判死：不做检测、不做集成、不在文档里推荐安装"），结论过强。

#### 4.1.3 风险

| # | 风险 | 说明 |
|---|---|---|
| O-R1 | **分发即传染** | 把 Obelisk 代码（哪怕一次 `require`）打进安装包 → 需按 AGPL 开源 DshCockpit 对应部分。用户已付费/期待的 MIT 授权预期被破坏 |
| O-R2 | **网络条款** | AGPL §13：若 DshCockpit 未来提供网络服务并用 Obelisk 作为组成部分，须向网络用户提供源码。桌面 App 当前不触发，但**云端/Remote 方向（`public-remote.js` 已存在）会触发** |
| O-R3 | **上游单向变更史** | 2026-06-14 从 MIT **单方面**改为 AGPL-3.0。这本身合法（版权人有权），但说明**上游许可证不稳定**——今天 AGPL，明天也可能再变。对依赖管理是负面信号（**这是"风险"，不是"判死理由"**） |
| O-R4 | **能力位重复** | 它的全部价值 ≈ G3（历史检索），而 G3 官方已有（`dsh-session-query-sqlite`），我们本地就有 |
| O-R5 | **产品面撞车** | 它的 App 是第二个桌面 App（Electron 浏览会话 + 记忆 + 统计 + recap），与 DshCockpit 的产品面正面撞车 |

#### 4.1.4 集成边界（如果将来要做）

| 形态 | 是否合规 | 说明 |
|---|---|---|
| **B1 用户自装 CLI + 我们只读其 SQLite 输出** | ✅ **合规** | 用户自己 `npm i -g @obelisk-apps/cli`（他自己成为 AGPL 的被许可人），Obelisk 在自己的进程/自己的数据库里跑；DshCockpit **不 link 任何 AGPL 代码**，只读它生成的 `obelisk.db`（数据不是代码，AGPL 不约束数据） |
| **B2 可选插件 + 进程外调用** | ✅ **合规** | 我们做一个**可选**的"检测到 `obelisk` CLI 存在则调用 `obelisk sql ...` 子进程、解析 stdout"的适配层；**我们自身代码仍是 MIT**（AGPL 的传染以"衍生作品/合并"为界，进程边界 + 命令行接口是业界公认的安全边界） |
| **B3 打包进安装包 / 作为 npm dependency** | ❌ **不合规** | 违反 AGPL 分发义务 |
| **B4 官方商业授权** | ⚠️ **可能（无法核实）** | 若上游提供 dual-license，可谈；**本项目未公开声明 → 无法核实**，只能去问 |
| **B5 fork 其代码到我们仓库** | ❌ **不合规（除非我们也 AGPL）** | 衍生作品须同许可 |

**关键判断：B1/B2 是真实存在的合规路径，不是理论。** 它们被 Deferred 的原因是**产品判断**（G3 官方已覆盖 + 用户要装 AGPL 工具 + 引导成本），不是"法律上不可能"。

#### 4.1.5 Re-evaluation 触发条件（写死）

> 下列**任一**成立，重启 Obelisk 评估：
> **O-T1**（能力侧）官方 `dsh-session-query-sqlite` 在 0.2.x 上仍无法给出可用的多 provider 统一检索（例如我们最终决定支持"同时用 Claude Code + Codex + DSH"的多 runtime 用户——**这与 ADR-0001「不做多 Runtime」冲突，需先改 ADR**）。
> **O-T2**（形态侧）我们决定做 B1/B2（用户自装 + 进程外只读），且有 ≥3 个用户明确提出"想让我以前的 Claude Code/Codex 历史也能在我的工作空间里被检索"。
> **O-T3**（许可侧）Obelisk 上游公开提供 **dual-license / 商业授权**，或**回退到 MIT/Apache-2.0**。
> **O-T4**（依赖侧）我们自己的 `package.json` 若某天改为 AGPL（**当前无此计划**），则 O-R1 消失。
>
> **不得因为"它功能很全"而跳过 B3 的红线。B3 是唯一一条永不变的红线。**

#### 4.1.6 证据（可引用）

- 许可证变更提交：`b071cf723221`（2026-06-14T18:48:04Z）"chore: switch license from MIT to AGPL-3.0 and add demo screenshot"
- LICENSE 原文（AGPL-3.0 全文）：https://github.com/tommy0103/obelisk/blob/main/LICENSE
- README License 段（`AGPL-3.0-only`，**无商业授权声明**）：https://github.com/tommy0103/obelisk/blob/main/README.md
- DSH 插件包显式声明 `AGPL-3.0-only` + `private: true`：https://github.com/tommy0103/obelisk/blob/main/packages/dsh-plugin/package.json
- 依赖的 CLI 也是 AGPL-3.0：https://www.npmjs.com/package/@obelisk-apps/cli （`0.3.1`，`license: AGPL-3.0`）
- GitHub API：`/repos/tommy0103/obelisk` → `license.spdx_id = "AGPL-3.0"`

---

### 4.2 OpenViking — **Deferred（组件级分层）**（上一版：放弃/硬拒绝）

#### 4.2.1 上一版的错误（必须先承认）

上一版写的是：

> 「主仓 AGPL-3.0：self-host 或用它的 SDK 都进 AGPL 域。npm 插件包上写 `Apache-2.0` 但包里没有 LICENSE 文件……这是许可证声明不一致，**不能采信**。按最严口径：AGPL。」

**这句话有两处不准确**：

1. **"用它的 SDK 都进 AGPL 域"是错的。** OpenViking 是**明确的多许可证组件化项目**，README「License」段逐项写明：主项目 AGPLv3、`crates/ov_cli` **Apache 2.0**、`examples/` **Apache 2.0**（其中 `examples/hermes-plugin` 保留 **MIT**）、`integrations/frameworks` 里 LangChain/LangGraph 适配器 AGPLv3 而 Microsoft Agent Framework 适配器 **MIT**。**`sdk/typescript` 的 `package.json` 也声明 `license: Apache-2.0`。** 所以"用它的 SDK 就进 AGPL"是事实错误。
2. **"npm 插件声明 Apache-2.0 但 tarball 无 LICENSE → 按最严判 AGPL"这个推理过强。** 事实是：**`examples/dsh-memory-plugin` 位于 `examples/` 目录下，而 `examples/LICENSE` 是 Apache-2.0 全文**（本版实测：https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/LICENSE ）。也就是说，**该组件的许可证来自目录级 LICENSE 文件，而 npm tarball 只打包 `files` 白名单（不含 LICENSE）**——这是"打包遗漏 LICENSE 文件"，不是"声明与实物不符、应按最严判"。tarball 缺失 LICENSE 是**分发合规缺陷**（Apache-2.0 §4(a) 要求随分发附带许可证副本），但它**不改变该组件的许可证归属**。

#### 4.2.2 实测数据（全部保留）

| 项 | 实测值 | 证据 |
|---|---|---|
| 仓库 | `volcengine/OpenViking` 存在，极活跃 | GitHub API |
| stars / forks / open issues | **41,244 / 3,346 / 1,181** | 同上 |
| 语言 / 主许可证 | Python + Rust / **AGPL-3.0**（主项目） | 同上 |
| 许可证变更史 | LICENSE 提交 = **`ce998873f94d`**，2026-03-30T06:37:42Z，message：「lisence: change the main lisence to **AGPL-3.0** (#1085)」；`examples/LICENSE` 同一个提交；首个 commit `f98dc0ed1c37` 2026-01-29 | `GET /repos/volcengine/OpenViking/commits?path=LICENSE` 与 `?path=examples/LICENSE` |
| created / pushed | 2026-01-05T07:11:17Z / **2026-10-31T18:51:06Z** | GitHub API |
| 能力 | 「Context Database」：`viking://` 虚拟文件系统 + L0/L1/L2 分层摘要 + 目录级语义检索 + session 归档抽取 memory + 技能；benchmark 自报 LoCoMo 80–83%（vs 原生 24–57%） | README |
| 部署 | **必须先起 server**：`uv tool install openviking && openviking-server init`，要 **Python 3.10+ / uv / 一个模型 provider 的 embedding + VLM**；或买 Volcengine 托管服务 | README Quick start |
| 商业版 | **有**：Managed SaaS（Volcano Engine 托管）+ Self-Managed（BYOC / 离线，license key 激活） | README「Commercial editions」 |
| 额外限制（本版新增发现） | README 明写：「any **wholesale rewriting and subsequent re-open-sourcing** of this project is **prohibited**；any request to **translate all or a substantial portion** of the project code into another coding language requires **prior written authorization**」 | README「License」段末 |
| DSH 插件 | `@openviking/dsh-memory-plugin@0.5.31`（2026-10-28），npm 元数据 `license: Apache-2.0`，**tarball 43 个文件内无 LICENSE/ NOTICE**（本版实测 `tar tzf \| grep -i license` → 无命中）；另有 `dsh-mnemon-provider-openviking@0.5.10`（MIT，第三方 `omdsh-dev`）、`dsh-openviking-manager@0.5.1`（MIT，第三方 `xbzbing`） | npm registry + tarball 解包实测 |

#### 4.2.3 **组件级许可证矩阵**（本版核心产出，替代上一版的"一句话判 AGPL"）

| 组件 | 路径 | 许可证（实测） | 证据 | 我们可以怎么用 |
|---|---|---|---|---|
| **主项目（Python server / 核心）** | `/`（`openviking/`, `src/`, `pyproject.toml`） | **AGPL-3.0**（`pyproject.toml` → `license = "AGPL-3.0"`） | root `LICENSE`；`pyproject.toml` L19 | ❌ **不可打包、不可 link**；✅ 可作为**用户自装的独立服务**（进程外 HTTP） |
| **`crates/ov_cli`（Rust CLI）** | `crates/` | **Apache-2.0** | `crates/LICENSE`（实测 Apache 2.0 全文） | ✅ **可打包**（注意：需随分发附 LICENSE 副本，Apache-2.0 §4(a)） |
| **`examples/`（全部示例插件）** | `examples/` | **Apache-2.0**（目录级） | `examples/LICENSE`（实测 Apache 2.0 全文） | ✅ **可打包**（同上附 LICENSE 副本）。**`examples/dsh-memory-plugin` 属此类 → 它是 Apache-2.0，不是 AGPL** |
| **`examples/hermes-plugin`** | `examples/hermes-plugin/` | **MIT**（`Copyright (c) 2025 Nous Research`） | `examples/hermes-plugin/LICENSE` | ✅ **可打包**（最宽松） |
| **`sdk/typescript`** | `sdk/typescript/` | **Apache-2.0**（`package.json` → `"license": "Apache-2.0"`） | raw `sdk/typescript/package.json` | ✅ **可打包**（无目录级 LICENSE 文件 → **分发时须自行附 LICENSE 副本，这是需补的合规动作**） |
| **`npm/cli`** | `npm/cli/` | **Apache-2.0**（`@openviking/cli`，`version: 0.0.0`） | raw `npm/cli/package.json` | ✅ **可打包**（同上） |
| **`sdk/python`** | `sdk/python/` | **`pyproject.toml` 内无 `license` 字段** → **无法核实**（未声明 = 默认保留所有权利） | raw `sdk/python/pyproject.toml`（本版实测无 license 行） | ⚠️ **不可依赖**，除非上游补齐声明 |
| **`sdk/go`** | `sdk/go/` | **`go.mod` 内无许可证声明，目录无 LICENSE** → **无法核实** | raw `sdk/go/go.mod` | ⚠️ **不可依赖** |
| **`integrations/frameworks/langchain`** | `integrations/frameworks/langchain/` | **AGPL-3.0**（README 明写） | root README「License」段 | ❌ **不可打包** |
| **`integrations/frameworks/microsoft-agent-framework`** | 同上 | **MIT**（README 明写） | 同上 | ✅ **可打包** |
| **`third_party/`**（croaring / krl / leveldb-1.23 / rapidjson / spdlog-1.14.1） | `third_party/` | 各自原始许可证（README 明写「Respective original licenses」） | root README | ⚠️ **需逐项审计**才能用 |
| **`web-studio/`** | `web-studio/` | `package.json` **无 license 字段** + `"private": true` → **无法核实** | raw `web-studio/package.json` | ⚠️ **不可依赖** |
| **npm 发布物 `@openviking/dsh-memory-plugin@0.5.31`** | npm tarball | 元数据声明 **Apache-2.0**；**tarball 内无 LICENSE 文件**（这是分发合规缺陷，非许可归属问题） | `tar tzf dsh-memory-plugin-0.5.31.tgz \| grep -i license` → 无命中 | ✅ **许可上可用**（Apache-2.0）；⚠️ **若我们打包它，必须自己补 LICENSE 副本 + NOTICE** |

**这张矩阵的结论**：

> **OpenViking 不是"一个 AGPL 项目"，而是"一个 AGPL 主项目 + 若干宽松许可的周边组件"的项目。`examples/`（含 DSH memory plugin）、`crates/ov_cli`、`sdk/typescript`、`npm/cli` 都是 **Apache-2.0**；`examples/hermes-plugin` 是 **MIT**。上一版"一句话判 AGPL"把一个多许可证项目压成了单一结论，这是不准确的。**

#### 4.2.4 现状判定

**Deferred**——但**不是"整仓不可用"，而是"分组件、分层级"**：
- **服务端（AGPL）**：不可打包；只能作为**用户自装的独立服务**（进程外 HTTP，合规）。
- **DSH 插件与 SDK（Apache-2.0）**：**许可上可用**。当前不用的理由是**产品与运维理由**，不是许可理由。

#### 4.2.5 风险

| # | 风险 | 说明 | 与许可的关系 |
|---|---|---|---|
| V-R1 | **外部服务依赖违反"本地优先"** | 要求用户先装 Python 3.10+ / uv、起常驻 server、配 embedding + VLM。这不是"集成一个库"，是"要求用户运维一个后端"。**对"首跑 5 分钟拿到产物"是灾难** | **无关**（纯产品判断） |
| V-R2 | **能力位错配** | L0/L1/L2 分层摘要确实是真本事（优于纯 FTS），但那是 G4/G5 的**高级形态**——我们现在连基础的 G4（写入治理 UI）都没有 | **无关**（纯工程判断） |
| V-R3 | **主项目 AGPL 的分发边界** | 若我们打包服务端 = 传染 | **许可**（可通过组件分层规避） |
| V-R4 | **宽松组件的 LICENSE 分发缺陷** | `examples/`、`sdk/typescript`、`npm/cli` 在 npm tarball 里不带 LICENSE 副本 → 我们若打包，**必须自己补**（Apache-2.0 §4(a)） | **许可（可修复）** |
| V-R5 | **部分组件许可证无法核实** | `sdk/python` / `sdk/go` / `web-studio` 无许可证声明 → 默认保留所有权利 | **许可（需上游澄清）** |
| V-R6 | **额外使用限制**（本版新增） | README 明写禁止 wholesale rewriting + re-open-sourcing，且"翻译大部分代码成另一种语言"需事先书面授权。**这是合同限制而非版权许可限制，但同样有约束力** | **许可/合同**（对我们的使用形态无影响——我们不打算重写或翻译它） |

#### 4.2.6 集成边界（如果将来要做）

| 形态 | 是否合规 | 说明 |
|---|---|---|
| **V-B1 用户自装 server + 我们只做客户端**（走 HTTP） | ✅ **合规** | 这是**当前就应该记下的正确形态**：用户自己 `uv tool install openviking` + 起 server；DshCockpit 只装 `@openviking/dsh-memory-plugin`（Apache-2.0）或自研 HTTP 客户端。**不打包服务端、不 link AGPL 代码** |
| **V-B2 打包 `@openviking/dsh-memory-plugin`** | ✅ **合规（需补 LICENSE/NOTICE）** | Apache-2.0；需随分发附 LICENSE 副本 + 保留 NOTICE |
| **V-B3 打包 `examples/` 里其他插件** | ✅ **合规（需补 LICENSE/NOTICE）** | Apache-2.0 目录级 |
| **V-B4 打包 Python 服务端** | ❌ **不合规** | AGPL 传染 |
| **V-B5 打包 `sdk/python` / `sdk/go` / `web-studio`** | ⚠️ **不可依赖** | 无许可证声明 → 保留所有权利 |
| **V-B6 用 LangChain/LangGraph 适配器** | ❌ **不合规** | AGPL-3.0（但我们也不需要它） |

#### 4.2.7 Re-evaluation 触发条件（写死）

> 下列**任一**成立，重启 OpenViking 评估：
> **V-T1**（产品侧）DshCockpit 明确要服务"**已有本地 OpenViking server 的高级用户**"，且该用户群 ≥3 人可复现（此时做 V-B1 客户端插件，成本极低）。
> **V-T2**（能力侧）我们的 G4（写入治理）**已经建好**，且被证明"纯 FTS + 手写治理"不够——即到了要 G4/G5 **高级形态**的时候（L0/L1/L2 分层摘要才有对价）。
> **V-T3**（许可侧）上游为 `sdk/python` / `sdk/go` / `web-studio` 补齐许可证声明，或在 npm 分发里补上 LICENSE/NOTICE。
> **V-T4**（部署侧）上游提供"单文件 / 零依赖 / 内嵌模型"的本地模式（不再需要用户起 Python server + 配 embedding/VLM）。
>
> **不得在我们这边写任何"一键部署 OpenViking server"的引导**（这条不变：那是把用户变成运维）。

#### 4.2.8 证据（可引用）

- 主仓 LICENSE（AGPL-3.0 全文）：https://github.com/volcengine/OpenViking/blob/main/LICENSE
- **`examples/LICENSE`（Apache 2.0 全文）**：https://github.com/volcengine/OpenViking/blob/main/examples/LICENSE
- **`crates/LICENSE`（Apache 2.0 全文）**：https://github.com/volcengine/OpenViking/blob/main/crates/LICENSE
- **`examples/hermes-plugin/LICENSE`（MIT）**：https://github.com/volcengine/OpenViking/blob/main/examples/hermes-plugin/LICENSE
- **根 README「License」段（逐组件声明）**：https://github.com/volcengine/OpenViking/blob/main/README.md
- 许可变更提交：`ce998873f94d`（2026-03-30）"lisence: change the main lisence to AGPL-3.0 (#1085)"
- GitHub API：`/repos/volcengine/OpenViking` → `license.spdx_id = "AGPL-3.0"`
- **npm 分发缺陷证据**：https://www.npmjs.com/package/@openviking/dsh-memory-plugin （元数据 `license: Apache-2.0`，`tar tzf dsh-memory-plugin-0.5.31.tgz` → **43 个文件内无 LICENSE/NOTICE**）
- `pyproject.toml` → `license = "AGPL-3.0"`：https://github.com/volcengine/OpenViking/blob/main/pyproject.toml
- `sdk/typescript/package.json` → `"license": "Apache-2.0"`：https://github.com/volcengine/OpenViking/blob/main/sdk/typescript/package.json

---

### 4.3 dsh-memory-evolve — **Deferred / Re-evaluation**（上一版：放弃）

#### 4.3.1 MIT 许可证核实（用户明确要求）

**核实结论：MIT，已三重验证。**

| 验证途径 | 结果 |
|---|---|
| GitHub API `/repos/csyangwen/dsh-memory-evolve` → `license` | `{'key': 'mit', 'name': 'MIT License', 'spdx_id': 'MIT'}` |
| `raw.githubusercontent.com/.../main/LICENSE` 全文 | 「MIT License / **Copyright (c) 2026 dsh-external**」+ 完整 MIT 条文（1069 字节，`sha: a2078e705ad7307cf0f5d20085a5c264895829b5`） |
| `package.json` 的 `"license"` 字段 | `"license": "MIT"` |

**同时核实：`private: true` 与 npm 404 都属实。**

| 项 | 实测 |
|---|---|
| `package.json` | `"private": true`、`"version": "0.1.0"`、`"name": "dsh-memory-evolve"`、`"license": "MIT"`、`"type": "module"` |
| npm | `registry.npmjs.org/dsh-memory-evolve` → `HTTP 404` / `{"error":"Not found"}` |
| 装法 | 只能从 git：`dsh plugin --profile web add github:csyangwen/dsh-memory-evolve`（README 明写） |

**关键认知修正：`private: true` + npm 404 = "未发布"，不等于"质量差"。** 这是作者的分发选择（插件从 GitHub 直接装，不走 registry），在 DSH 插件生态里是常见形态。它的真实代价是**我们无法固定版本、无法在 CI 里复现、升级只能追 main**——这属于**工程可控性**问题，不属于**质量**问题，更不属于**永久否决理由**。

#### 4.3.2 实测数据（全部保留）

| 项 | 实测值 | 证据 |
|---|---|---|
| 仓库 | `csyangwen/dsh-memory-evolve` 存在 | GitHub API |
| stars / forks / open issues | **476 / 52 / 33** | 同上 |
| 许可证 | **MIT**（`Copyright (c) 2026 dsh-external`，1069 B） | raw LICENSE + GitHub API + package.json |
| 语言 | JavaScript（DSH Cordis 插件） | GitHub API |
| created / pushed | 2026-08-05T06:53:09Z / **2026-10-29T14:45:44Z** | 同上 |
| 最近提交 | **`44b6b3eb65`** 2026-10-29T14:43:31Z：「fix(skills-manager): 适配 DSH 0.2.1 技能目录 scope 分层 + 运行时技能无 source 崩溃」；此前 `e6f6b84c56`/`db83f84bff` 2026-09-28 两笔「适配 DSH 0.2.0-rc.1」 | GitHub commits API |
| 发布 | **未发布 npm**（404）；`package.json` `"private": true`，`version: "0.1.0"` | npm registry + raw package.json |
| 测试规模 | **`tests/` 目录 72 个测试文件**（`advisor-*` / `aliases` / … 等） | GitHub contents API |
| CI | `.github/workflows` → **`Not Found`**（无 CI workflow） | GitHub contents API |
| 能力 | 五轨记忆（用户档案/全局事实/项目关键记忆/项目日志/每日日志）、git 分支感知、回合内自我审查、技能自我进化 + 技能管理、四轨待办、**COI 调度（拉起多个会话组成房间 + 派单给 kimi/codex/grok/hermes 外部 CLI）**、会话广播、会话搜索、提示词管理、便签 | README |
| 装法 | `dsh plugin --profile web add github:csyangwen/dsh-memory-evolve`（README：bundle patch 自动注册） | README |

#### 4.3.3 现状判定

**Deferred**。**功能重叠（COI 调度 ≈ 官方 Agent Teams）是当前不集成的理由之一，不是永久否决。**

同时必须准确承认它的**真实工程质量信号**（上一版只写了负面，这是偏差）：
- **72 个测试文件**，覆盖 advisor / skills / sync / client-compat 等模块。
- **CHANGELOG 极其诚实且具体**：逐条记录根因、法证数据（例如「4 个损坏文件的干净版本里，损坏字符起始字节偏移为 **32766 / 32767 / 32766 / 81913** —— 前三个**恰好跨越字节 32768**」，定位到 `String(chunk)` 分块解码 bug），并写明「已验证『还原修复后测试必失败』」。**这是高于平均水平的工程记录，不是"质量差"的表现。**
- **及时跟进上游**：0.2.0-rc.1 与 0.2.1 两次破坏性变更都在 1 个月内适配完成。

**上一版把这些 CHANGELOG 内容当作"维护风险"的证据（"每次官方 minor 升级都要等作者修"），这个推理方向是对的，但结论下反了：一个能在 1 个月内适配 2 次上游破坏性变更、并且每次都有明确根因分析的单一维护者项目，恰恰是"活跃且有能力"的信号。真正的风险不是"他修不动"，而是"只有他一个人修"。**

#### 4.3.4 风险（重新表述）

| # | 风险 | 说明 | 是否永久 |
|---|---|---|---|
| M-R1 | **功能面 60% 与官方 Agent Teams 正面重复** | **COI 调度 = 拉起会话组队 + 派活 + 状态广播 + 写冲突警告**。官方 `dsh-experimental-agent-team` 提供「具名 teammate + 直接 inbox + 持久共享任务板 + writeScopes 重叠警告 + waitForChange + interrupt」+ **CAS revision、task DAG、只 Lead 能创建/打断、TeamId = Lead SessionId**。装 memory-evolve 等于在我们的产品里再塞一套第二 Team 运行时 | **否**——若官方 Agent Teams 长期不满足某需求，重叠会变成互补 |
| M-R2 | **会话搜索与官方重复** | `dsh-session-query-sqlite`（FTS5）已覆盖；我们的 `src/session-search.js` 也在做 | **否**——官方检索默认 `openAt: never`，若长期不打开，它的实现反而有价值 |
| M-R3 | **单维护者 + 未发 npm + 只能 git 装** | 无法固定版本、无法审计更新、无法在 CI 里复现。**这是可控性问题** | **否**——作者发 npm 或我们 fork 后自建 registry 即消失 |
| M-R4 | **多写入者污染 `AGENTS.md` 语义链** | 它写入 `~/.agents/skills` + 自己的记忆文件 + 会话注入消息（`plugin:dsh-memory-evolve` source kind）。官方 `dsh-agent-instructions` 加载链只有 65KiB 预算，且 resume 时 reconcile | **是（结构性）**——但这与本文 §5.2「单写入者原则」是同一条铁律，**它约束的是一切第三方记忆插件，不是 memory-evolve 独有** |
| M-R5 | **注入类故障面**（上一版引用的实证） | CHANGELOG 记录过「会话格式 v4 下插件注入消息会让接收方那一轮整轮失败」（issue #68，阻塞级）；根因是 `source.kind` 不合法 → 修复方式是统一 `PLUGIN_SOURCE_KIND = 'plugin:dsh-memory-evolve'` | **部分**——已被修复，但暴露"注入型插件的故障面是整轮失败"这一结构性风险 |

#### 4.3.5 集成边界（如果将来要做）

| 形态 | 评价 | 说明 |
|---|---|---|
| **M-B1 完整装它** | ❌ **不做（当前）** | 会引入第二套 Team 运行时 + 第二套记忆写入通道 → 违反 §5.2 单写入者/单注入者 |
| **M-B2 只借鉴「五轨记忆」分层设计，不取代码** | ✅ **现在就可以** | 用户/全局/项目/git-branch/每日 五轨分层**设计是对的**；我们在自己的 G4 设计里可以完全借鉴概念 |
| **M-B3 只取「技能自我进化」子模块** | ⚠️ **需评估** | 但该模块与 `dsh-skill` / `dsh-plugin-manager` 的边界需先确认 |
| **M-B4 COI 调度** | ❌ **不做** | 与官方 Agent Teams 正面重复；且我们用官方 roster/inbox/task board |
| **M-B5 fork + 裁剪（MIT 允许）** | ⚠️ **可能** | MIT 允许 fork/改/不发布。若将来要 M-B2+M-B3 的具体实现，fork 一个裁剪版（去掉 COI、去掉会话搜索）是**合规且可能更划算**的路径——**这是上一版完全没提的选项** |

#### 4.3.6 Re-evaluation 触发条件（写死）

> 下列**任一**成立，重启 dsh-memory-evolve 评估：
> **M-T1**（治理侧）我们自己的 G4 写入治理设计定稿，且发现「五轨记忆分层」里的某一轨（尤其 **git-branch 轨**）确实是我们没设计到的。
> **M-T2**（技能侧）我们决定做"技能自我进化"，而官方 `dsh-skill` / `dsh-plugin-manager` 明确不覆盖，且 M-B3 的边界已确认。
> **M-T3**（Team 侧）官方 `dsh-experimental-agent-team` 长期（≥2 个 minor 版本）不满足某条我们的硬需求，而 COI 调度恰有——**此时它是"备选 Team 运行时"候选，需与 ADR-0002 一起评估**。
> **M-T4**（发布侧）作者发布 npm 版本（M-R3 消失）。
> **M-T5**（fork 侧）决定走 M-B5，fork 裁剪版。
>
> **无论如何不变的一条**：**不装它的完整形态**（因为 M-R4 + M-B1 与 §5.2 铁律冲突）。这不是许可问题，是我们的架构纪律。

#### 4.3.7 证据（可引用）

- LICENSE（MIT，1069 B，`sha a2078e705ad7`）：https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/LICENSE
- GitHub API：`/repos/csyangwen/dsh-memory-evolve` → `license.spdx_id = "MIT"`
- `package.json`：`"license": "MIT"`、`"private": true`、`"version": "0.1.0"`
- npm：`registry.npmjs.org/dsh-memory-evolve` → HTTP 404
- CHANGELOG（工程诚实度证据）：https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/docs/CHANGELOG.md
- `tests/` 72 个测试文件：GitHub contents API

---

### 4.4 dsh-mnemon — **备选（唯一值得考虑的第三方，结论不变）**

| 项 | 实测值 | 证据 |
|---|---|---|
| 仓库 | `omdsh-dev/dsh-mnemon` 存在 | GitHub API |
| stars / forks | **812 / —**（forks 未记录在此次查询） | 同上 |
| 许可证 | **MIT**（`Copyright (c) 2026 dsh-external contributors`） | raw LICENSE |
| 语言 / 最近提交 | TypeScript / **2026-10-31T17:10:42Z**；created 2026-08-10 | GitHub API |
| 发布 | npm `dsh-mnemon@0.5.37`（2026-10-29），**MIT** | npm registry |
| DSH 兼容 | **明示支持 `0.2.0-rc.2` / `0.2.1-rc.1..0.2.x`**；0.1.5 需要降级到 0.5.16；**兼容表在 CI 里跑**（`tests/dsh-host-compatibility.spec.ts`） | `dsh-mnemon` 仓内 `docs/en/reference/compatibility.md` |
| 能力 | **不存自己的记忆格式**，而是「记忆聚合层」：Sources（Runtime memory=USER.md/MEMORY.md、Project Documents、Memory Spaces）+ Strategies（Layered/General/AutoCapture/LightContext/Scoped）+ Core 校验成不可变 View；Providers 可插拔（Native/OpenViking/Honcho/Mem0/Hindsight/Holographic/RetainDB/ByteRover/Supermemory）；**每回合可看见读了/写了什么**；一键存记忆到指定 Memory Space；技能版本化 + 自进化 + backtest | README |
| 关键许可证声明 | `THIRD_PARTY_NOTICES.md`：「**This package does not bundle provider SDKs or provider services**」；Honcho server 是 AGPL 但「does not copy or bundle that server」，走 HTTP；OpenViking 等「remain separate products」 | raw THIRD_PARTY_NOTICES.md |

**为什么是唯一候选**：它做的正是 **G4 + G5**（不是"再来一个存储"，而是"记忆的可见治理 + 抽取确认 + 可换后端"），并且**许可证干净（MIT）、不 bundle 任何 AGPL 服务、明确声明走进程外 HTTP**。它的 MIT 也意味着我们可以 fork / 改 / 不发布。

**为什么仍然只是"备选"而非"首选"**：

1. **它自己就是一套完整的 UI 面**（Memory System 页面、每回合记忆条、brain mark、Skills 页、插件页）。装进 DshCockpit = 在我们的产品里嵌一套**别人的**产品界面，与「Harness owns execution; DshCockpit owns experience」的体验主导权冲突。
2. **它的体积/复杂度相当大**（0.5.x 有 19+ 包：3 Sources + 5 Strategies + 9 Providers + Core），对我们"首跑 5 分钟"的目标是负资产。
3. **它要求的官方版本是 0.2.0+，我们 pin 0.1.5**。要用它必须先进 0.2.x 迁移——那是独立的大工程（见 task-1）。
4. **触发条件未满足**：我们还没有 G4 的需求证据。当前缺口清单（`AGENTS.md` §7：bind-attention 取消、blocked-turn steer 续跑、crash 受信来源、durable store）里**没有一条是记忆**。
5. **它的 OpenViking provider 仍指向 AGPL 服务端**（见 §4.2）——虽然它不 bundle，但用户若启用该 provider 就要自己运维 AGPL server。

**采用条件（写死在文档里，避免以后拍脑袋）**：
> 当且仅当同时满足以下三条，才启动 dsh-mnemon 集成评估：
> (a) DshCockpit 已完成 0.2.x 迁移并稳定运行 ≥1 个版本周期；
> (b) 用户侧出现**可复现的记忆诉求**（例：同一决策被用户重复解释 3 次以上，或"上次那个结论在哪"成为高频问题）；
> (c) 我们自己的 `memory-files.js` 已扩展出多文件/多 scope 编辑 + 至少一个"记忆准入"UI 原型，被证明不够用。
> 三条缺一，一律「Deferred」。届时正确集成形态是**可选插件 + 用户显式安装 + 不打包进安装包 + 进程内但可 disable**。

### 4.5 其它被扫到但不在题目清单内的候选（记录，全部 Deferred）

| 名称 | 实测 | 判定 |
|---|---|---|
| `dsh-context@0.78.2`（`bowenliang123/dsh-context`） | Apache-2.0，2026-10-30 | 上下文可视化，官方 `dsh-session-telemetry`/`compaction` 已覆盖大部分；**Deferred** |
| `dsh-mnemon-provider-openviking@0.5.10` | MIT，第三方，2026-10-26 | 它是 mnemon 的 Provider 子件；底层仍是 AGPL OpenViking server。若 mnemon 都不上，它更不上；**Deferred** |
| Obelisk 的 `@obelisk/dsh-obelisk-plugin` | `AGPL-3.0-only` + `private: true` + 未发 npm | 同 §4.1：**Deferred**（分发形态受限，非永久否决） |

**无法核实项**：各仓库的 issue 活跃度（GitHub API 的 `open_issues_count` 我能拿到，但"回复速度/关闭率"需要 GraphQL + 认证，本次未查）。上述"活跃度"判断仅基于**最近提交时间**与 **commit 频率**，不基于 issue 质量。

---

## 5. 为什么绝对不能同时上多个记忆方案（这是本文最重要的工程结论，结论不变）

不是"会重复"，而是**会产生不可判定的写入冲突**，且冲突**不可观测**。

### 5.1 机理

官方的记忆写入面**只有一个**：`AGENTS.md` 链（`dsh-agent-instructions`，只读加载，`maxBytes: 65536`）。所有"记忆插件"最终都要落到以下三类之一：

| 落地形态 | 冲突表现 |
|---|---|
| 写 `AGENTS.md` / `CLAUDE.md` / `.local.md` | **两个写入者互相覆盖**（`memory-files.js` 是原子 rename，无 CAS、无版本；后写的赢，且先写的内容静默消失） |
| 写自己的 Sidecar 文件 + 往会话注入消息 | **注入竞争 + 预算挤占**：官方 65KiB 预算被两份提示词瓜分，两份都表达"这是你的长期记忆"，模型无法判定哪份权威 → 行为不可预测（不是崩溃，是**答错但看起来正常**） |
| 写外部服务（OpenViking/Mem0） | 加上"本地记忆 vs 远端记忆哪个新"的**跨存储因果序问题**，在离线/网络抖动时出现不可复现的"昨天记住的今天忘了" |

第二种最危险：`dsh-memory-evolve` 的 CHANGELOG 里就有实证——「会话格式 v4 下插件注入消息会让接收方那一轮整轮失败」，症状是「重启就好、过一阵复发」，根因是注入的 `source.kind` 不合法。**多插件注入 = 多倍的同类故障面**。

### 5.2 纪律（建议写进 capability-platform 的硬约束）

1. **单写入者原则**：`AGENTS.md` 链的写入者**必须唯一**。当前唯一写入者是 `src/memory-files.js`。任何第三方记忆 Provider 若也要写这条链 → **直接否决，不看别的条件**。
2. **单注入者原则**：每回合的系统提示注入（记忆类）**必须唯一来源**。多来源 = 预算竞争 + 权威冲突。
3. **Provider ≠ Storage**：Provider 只能换**后端**（存在哪），不能换**语义**（什么是记忆、谁决定写入）。语义必须由 DshCockpit 拥有。
4. **可开关且默认关**：任何第三方记忆组件必须能一键 disable 且不丢数据（官方 `dsh-experimental-session-search` 就是这个形态：bundle 默认 off，界面里可开）。

### 5.3 由此推出的架构约束（给 Lead 的设计输入，不替代他的设计）

- 记忆能力应表达为 **一个** Capability，内部可有多 Provider，但**对外只有一条 `AGENTS.md` 写入通道 + 一条注入通道**。
- `src/session-search.js` 与 `src/memory-files.js` 是**同一 Capability 的两个端点**（检索 + 写入），不要拆成两个 Capability。
- 若将来接 mnemon，它是「后端 Provider」，不是「第二个记忆系统」——它的 UI 必须被我们的 UI 替换，不能整页嵌入。
- 这条纪律**与具体项目无关**：它同时解释了为什么 Obelisk/OpenViking/memory-evolve 即便许可没问题也不能"整个装进来"。

---

## 6. 选型结论表（Deferred / Re-evaluation 框架）

| 候选 | 许可证（实测） | 解决问题 | 与官方重叠 | **结论（本版）** | 上一版结论 | 重评触发条件 |
|---|---|---|---|---|---|---|
| **官方栈**（`dsh-goal` + `dsh-compaction*` + `dsh-session-query-sqlite` + `dsh-agent-instructions`） | 随 runtime 分发（0.2.1-rc.5 内） | G1/G2/G3 | — | **★ 首选（唯一）** | 同 | — |
| **DshCockpit 自研**：`memory-files.js` 扩展 + 打开官方检索 | MIT（我们自己的，`package.json` 实测 `license: MIT`） | G3 产品面 + G4 写入治理 | 与官方**互补** | **★ 首选的自研部分** | 同 | — |
| **`dsh-mnemon`** | **MIT**（npm 0.5.37 实测） | G4 + G5 | 部分 | **◐ 备选（有明确触发条件，见 §4.4）** | 同 | §4.4 三条 |
| **`dsh-memory-evolve`** | **MIT（三重核实）**，`private: true`、未发 npm | G4 + G5 + **Team 编排** | **高**（COI ≈ 官方 Agent Teams；会话搜索 ≈ 官方 session-query） | **◐ Deferred**（**不是放弃**） | ✕ 放弃 | §4.3.6 的 M-T1…M-T5 |
| **Obelisk** | **AGPL-3.0-only**（2026-06-14 从 MIT 改） | G3 | **完全重叠** | **◐ Deferred**（分发形态受限；B1/B2 合规路径存在） | ✕ 放弃（硬拒绝） | §4.1.5 的 O-T1…O-T4 |
| **OpenViking** | **主项目 AGPL-3.0；`examples/` 与 `crates/ov_cli` Apache-2.0；`examples/hermes-plugin` MIT；`sdk/typescript` Apache-2.0；`sdk/python`/`sdk/go`/`web-studio` 无声明** | G4/G5 高级形态 | 部分 | **◐ Deferred（组件级分层：宽松组件可用，AGPL 服务端不可打包）** | ✕ 放弃（硬拒绝） | §4.2.7 的 V-T1…V-T4 |

**下一阶段接哪个 Provider？答：一个都不接。** 记忆方向的动作是「打开官方已有关闭的检索 + 扩展我们自己的 `AGENTS.md` 编辑器 + 把官方 `dsh-goal` 接成 Mission 的持久层」，不是接第三方。

**但这句话的准确含义是**：
> **不是"这三个项目被否决了"，而是"这一轮（G4/G5 都还没建、0.2.x 还没迁）不适合接任何 Provider"。** 三个项目的许可证事实已经被本版精确定格；它们的重评条件已经写死在各自小节。**任何一个条件被触发，都可以重新拿起来评估——不需要推翻本文的任何实测数据。**

---

## 7. 待验证 / 无法核实清单（诚实边界）

| 项 | 状态 | 原因 |
|---|---|---|
| 各仓库 issue 响应质量 | **无法核实** | GitHub REST 只能拿 `open_issues_count`，评质量需 GraphQL + token |
| **Obelisk 是否提供商业授权（dual-license）** | **无法核实** | README 全文 grep 无任何 commercial/dual/pricing 字样；AGPL 项目普遍有私下商业授权但未公开声明 |
| Obelisk 在 DSH 0.2.1 上的实际可用性 | **未验证** | 其 `packages/dsh-plugin` 为 `private: true` 且未发 npm；README 只给 git 安装路径。本次未安装（避免污染环境；且判定为 Deferred 后无必要） |
| **OpenViking `sdk/python` 的许可证** | **无法核实** | `pyproject.toml` 无 `license` 字段，目录无 LICENSE 文件 → 默认保留所有权利 |
| **OpenViking `sdk/go` 的许可证** | **无法核实** | `go.mod` 无声明，目录无 LICENSE 文件 |
| **OpenViking `web-studio` 的许可证** | **无法核实** | `package.json` 无 `license` 字段 + `"private": true` |
| **OpenViking `third_party/` 五项（croaring / krl / leveldb / rapidjson / spdlog）** | **未逐项审计** | README 只写"Respective original licenses"；采用前必须逐项核查 |
| **OpenViking 的 npm 分发缺 LICENSE 是否影响我们对 `@openviking/dsh-memory-plugin` 的使用** | **已结论（可用，需自补）** | Apache-2.0 允许我们分发，但 §4(a) 要求随分发附许可证副本 → 我们若打包，须自己补 LICENSE + NOTICE |
| `dsh-mnemon` 与本项目 UI 的兼容性 | **未验证** | 它要求 0.2.0+，我们 pin 0.1.5；本次不装 |
| 官方 0.2.1 的 `dsh-tool-session-query` 提升到 0.2.x 后是否默认挂载 | **未验证** | `dsh-experimental-session-search` README 明确「ships switched off」，但 0.2.1 的 web profile 是 asar 内模板，未 boot 验证 |
| `dsh-compaction` 与 `dsh-goal` 在长 goal（256 轮）下的实际交互 | **未验证** | 需真机长跑；属 task-1（Runtime Bridge）与真机验收范围 |
| **`dsh-memory-evolve` 在 0.2.1-rc.5 上的实际可用性** | **未验证** | 它最近一次提交（2026-10-29）就是适配 0.2.1，但本机 pin 0.1.5；未安装验证 |

---

## 8. 证据索引（全部为 2026-11-01 实测）

- 官方 asar：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（header JSON 解包，18,237 文件，308 个 `@deepseek-ai` 包）
- 官方 README（asar 内）：`dsh-goal`、`dsh-compaction`、`dsh-compaction-basic`、`dsh-session-query`、`dsh-session-query-sqlite`、`dsh-experimental-session-search`、`dsh-tool-session-query`、`dsh-agent-instructions`、`dsh-persona`、`dsh-workspace`、`dsh-workspace-changes`、`dsh-experimental-agent-team`、`dsh-experimental-worktree`、`dsh-experimental-tool-worktree`、`dsh-experimental-ralph-bundle`、`dsh-workflow`、`dsh-jobs`
- 本地 0.1.5 包清单：`~/.dsh/profiles/node_modules/@deepseek-ai/`（244 个）+ `dsh/package.json` version
- profile 组合：`node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config`
- 我方代码：`src/memory-files.js`(94)、`src/session-search.js`(87)、`src/search-worker.js`(74)、`src/main.js:2664`、`test/session-search.test.js`(3 test)、`package.json`（`license: MIT`）
- GitHub API：`/repos/{tommy0103/obelisk, volcengine/OpenViking, csyangwen/dsh-memory-evolve, omdsh-dev/dsh-mnemon, Ephemeral-AI-Lab/layerfs}`
- npm registry：`@obelisk-apps/cli@0.3.1`、`@openviking/dsh-memory-plugin@0.5.31`（含 tarball 解包）、`dsh-mnemon@0.5.37`、`dsh-memory-evolve`(404)
- **组件级许可证文件直抓（本版新增）**：
  - `https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/LICENSE` → Apache-2.0
  - `https://raw.githubusercontent.com/volcengine/OpenViking/main/crates/LICENSE` → Apache-2.0
  - `https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/hermes-plugin/LICENSE` → MIT
  - `https://raw.githubusercontent.com/volcengine/OpenViking/main/sdk/typescript/package.json` → `"license": "Apache-2.0"`
  - `https://raw.githubusercontent.com/volcengine/OpenViking/main/npm/cli/package.json` → `"license": "Apache-2.0"`
  - `https://raw.githubusercontent.com/volcengine/OpenViking/main/pyproject.toml` → `license = "AGPL-3.0"`
  - `https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/LICENSE` → MIT
- 原始 URL：
  - https://github.com/tommy0103/obelisk
  - https://github.com/volcengine/OpenViking
  - https://github.com/csyangwen/dsh-memory-evolve
  - https://github.com/omdsh-dev/dsh-mnemon
  - https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/compatibility.md
  - https://github.com/omdsh-dev/dsh-mnemon/blob/main/THIRD_PARTY_NOTICES.md
