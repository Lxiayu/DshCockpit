# 工作区隔离专项评估（LayerFS vs Git Worktree vs 独立目录）

> 状态：**评估结论（Deferred / Re-evaluation 框架）** · 核查日期 **2026-11-01（Asia/Shanghai）**，LayerFS 状态复核 **2026-11-01**
> 边界：本文只回答「多个 agent 同时写同一个工作区」这个场景该怎么隔离、谁该用哪种。Provider 抽象归 `docs/architecture/capability-platform.md`。
> 方法：官方 0.2.1-rc.5 asar 内 `dsh-workspace-changes` / `dsh-experimental-worktree` / `dsh-fs-observation-policy` README 全文解析 + LayerFS 主仓与 `dsh-layerfs` 插件 README/发布记录/发布策略实抓 + 我方 `src/work/workspace-store.js` 实读。
> **本版修订原则**：上一版 LayerFS 结论写"暂缓"但仍偏否定（含"它自己也说该用 worktree"式的收尾）。本版改为 **Deferred + 明确的 Re-evaluation 触发条件**，并把 LayerFS 的**版本状态 / 许可证 / 持久性 / 平台与 FUSE 限制**四项事实逐条钉死，**保留全部实测数据**。

---

## 0. 一句话结论

**准确说法（不要简化成"官方没解决"）**：

- 官方**解决了"变更捕获"**：`dsh-workspace-changes` 用 git 工作树快照做逐轮 diff（只读观察者）。
- 官方**提供了"隔离原语"**：`dsh-experimental-worktree` + `dsh-experimental-tool-worktree`（0.2.1 新增，默认关闭）能给**单个 Session** 创建隔离 checkout 并 `ctx.workingDirectory.set` 切过去。
- 官方**仍然没有解决的**是：**多个 agent 同时并行写同一工作区的自动协调**——谁分配哪个 worktree、谁负责合并、冲突怎么处理、什么时候回收。`dsh-experimental-agent-team` 的 README 明确写「this package provides **no worktree, remote member, merge, or filesystem lock**」，指的是 **Agent Teams 包本身**不带这套协调；独立的 worktree 包提供的是**手动/模型显式调用**的 per-Session 目录切换，不是并行团队的自动隔离。

**这个区分是决定性的**：
- 因为官方有 worktree 原语 → 我们 T1 层应该**包装官方包**，不要自己实现 worktree（否则就是重复造轮子）。
- 因为官方没有并行协调 → LayerFS 的增量价值主张"并行多分支隔离"在**协议层面仍然成立**。它当前不进入我们的生产路径的理由是**四项可核实的事实**（版本状态 / 持久性 / 平台 FUSE 门槛 / dsh desktop 未测），**不是"它不如 worktree"**。

因此：

- **新手 / 默认路径：普通独立目录（今天就是）。不上任何隔离层。** 理由：新手场景只有一个 agent 在写，隔离是纯成本。
- **高级用户 / 并行多 agent：Git Worktree（官方 `dsh-experimental-worktree` + `dsh-experimental-tool-worktree`，已内置，默认关闭）。**
- **LayerFS：Deferred（暂缓，有写死的重评条件）。** 它解决的"并发 + 大仓库不重装依赖 + 分支合并"是真需求；当前不接，因为**它自己明确写着"不是一个可以直接承载用户唯一数据副本的文件系统"**，且要求每个用户装 Docker/WSL2 + 从源码构建。→ 见 §2.3。

---

## 1. 先把问题收敛准（Lead 要求）

问题不是"要不要文件隔离"，而是：

> **多个 agent 同时写同一个工作区，官方解决到什么程度？**

答案分四层，必须分开说，否则会误判（**这是本评估最容易错的地方：把"Agent Teams 包没有 worktree"误读成"官方没有 worktree"**）：

| 层 | 问题 | 官方解法 | 官方解决程度 |
|---|---|---|---|
| **L0 原语**（能不能隔离） | 能不能给一个 Session 一个隔离目录 | `dsh-experimental-worktree`（service）+ `dsh-experimental-tool-worktree`（模型工具 `create_worktree({name?, from?})`）：建新具名分支 + 新 checkout → `ctx.workingDirectory.set` 切进去；返回 `{path, branch, baseCommit, repositoryRoot}` | **完整解决**（0.2.1 新增；默认关闭，「stays off until selected」） |
| **L1 捕获**（知道改了什么） | 这一轮谁改了哪些文件、逐文件 diff | `dsh-workspace-changes`：turn start/end 各打一次 git 工作树快照（临时 object dir + 仓库 objects 作 read-only alternate）+ 文件工具编辑前后整文件捕获 | **完整解决**（含无 git 环境的降级：只用文件工具捕获） |
| **L2 守卫**（不静默覆盖） | agent A 读了文件，agent B 改了，A 再写 | `dsh-fs-observation-policy`：read-before-edit + **"rejects a mutation when the file has changed since that read"**，返回明确指令让 agent 重读重试 | **单文件级解决**（乐观并发，非锁） |
| **L3 协调**（多 agent 自动并行） | A 和 B 同时改同一个文件/同一工作区，谁分配目录、谁合并、冲突怎么解、何时回收 | **无** | **完全没解决** |

### 1.1 官方两处 README 的分工必须分清（容易被引用错）

**`dsh-experimental-worktree` README 原文**（asar 内 `packages/experimental/worktree/README.md`）：

> 「Create an isolated checkout from a local commit and continue **the same Session** in it. Each operation creates a new named branch and leaves the source checkout intact.」
> 「`ctx.worktrees.create(agent, { name?, from? }, signal?)` creates a new branch and checkout, then enters the canonical checkout directory through `ctx.workingDirectory.set`.」
> 「The default checkout directory is `<current checkout root>/.agents/worktrees/<name>`.」
> 「The service writes a `.gitignore` containing `*` and a trailing newline **only when its allocation creates the pool**; existing files and ignore rules are preserved.」

**`dsh-experimental-agent-team` README 的 Known Limitations 原文**：

> 「**One process and one shared checkout** — members share cwd and observe edits immediately; **this package provides no worktree, remote member, merge, or filesystem lock.**」
> 「**Advisory write scopes** — Bash, formatters, code generators, and direct external writers can bypass filesystem version checks; Leads must coordinate ownership and review the final diff.」

**正确读法**：
- 第一段说的是「**单个 Session 可以手动/模型驱动地换到一个隔离 checkout**」——是**原语**。
- 第二段说的是「**Team 包不会自动给你的 teammates 各分配一个 worktree**」——是**协调缺失**。
- 两段**不矛盾**：官方给了锤子，没给流水线。

**所以 L3 缺口的准确描述是**：官方没有「Team allocation 策略（谁得哪个 worktree）+ 自动合并 + 冲突处理 + 生命周期回收」这一层。`dsh-experimental-agent-team` 要求「Leads must coordinate ownership and review the final diff」——**把协调责任推给了 Lead agent 和用户**。

### 1.2 三层叠加后，真实风险是"丢失部分工作"而不是"数据损坏"

- L2 会挡住**通过文件工具**的 classic lost-update（模型侧会收到重读指令）。
- 挡不住的：**Bash / formatter / codegen / 外部进程**写入（官方明写 "can bypass filesystem version checks"）。
- L1 会留下审计痕迹（逐轮 diff），所以**丢失可被发现**，只是发现得晚。
- L0 只在**有人显式切目录**时生效；两个 agent 共享 cwd 时**等于没有 L0**。

结论：L3 缺口 = **需要产品层的协调机制（谁改哪、什么时候合并）+ 一个把 L0 原语串起来的分配器**，不是需要一个新的文件系统。这是 §4 分层建议的依据。

---

## 2. 候选逐项核实（2026-11-01 实测）

### 2.1 官方 `dsh-workspace-changes`（0.2.1-rc.5 新增，我方 0.1.5 没有）

| 项 | 实测 |
|---|---|
| 存在性 | asar 内 `/dsh/node_modules/@deepseek-ai/dsh-workspace-changes/` 存在 |
| 我方 0.1.5 | **没有**（`ls ~/.dsh/profiles/node_modules/@deepseek-ai/` 无此包；`--dump-config \| grep workspace-changes` → 0 命中） |
| 机制 | 每 turn 开始/结束各一次 `git add --all`（临时 index，`GIT_OBJECT_DIRECTORY` 指向 session 临时目录，`GIT_ALTERNATE_OBJECT_DIRECTORIES` 指仓库 objects 只读）→ `write-tree` → `diff-tree -r -M --numstat`；文件工具编辑的每个目标在首次修改前整文件复制一次、turn 结束再复制一次（按 SHA-1 命名，相同内容只存一次） |
| 输出 | `workspace/changes` session 事件（只带 turn 号）；`ctx.workspaceChanges.summary(sessionId, seq)` / `.diff(sessionId, seq, index, signal)` |
| 限制（原文） | `maxFiles: 500`、`maxFileBytes: 2MiB`、`timeoutMs: 30000`、`diffTimeoutMs: 100`（超时降级 `coarse`）；**subagent Session 不记录**；嵌套仓库/submodule 记为 gitlink 不展开；`/tmp` 下文件排除；**Host 重启后旧 turn 无卡片无对比**；无 git 或 macOS 只有 `/usr/bin/git` dev-tools stub 时只列文件工具编辑 |
| 对 WORK-FIRST-V0.7 的意义 | §3.2 的 `workspace-patch` / `workspace-files` 两类 Artifact，以及 §3.3「受信 Verification 证据」的**变更捕获部分**，官方已经实现 |

**判定：采用（迁移到 0.2.x 后直接挂，不要自研 diff 捕获）。** 我方当前的 `src/work/workspace-store.js` 里 `MANIFEST_MAX_HASHED_FILES = 200` 的 manifest 哈希捕获属于同一能力的手写弱化版，0.2.x 迁移后应**降级为兜底**（无 git 场景），而不是主路径。

### 2.2 官方 `dsh-experimental-worktree` + `dsh-experimental-tool-worktree`（0.2.1 新增）

| 项 | 实测 |
|---|---|
| 存在性 | asar 内两个包都在；`dsh-experimental-worktree` = service，`dsh-experimental-tool-worktree` = bundle（GUI 里 "Plugins → Official → Git Worktrees" 开关） |
| 我方 0.1.5 | **都没有** |
| 默认状态 | 「This optional bundle is installed with Harness and **stays off until selected**」「it is off in every shipped profile」 |
| API | `ctx.worktrees.create(agent, { name?, from? }, signal?)` → `{ path, branch, baseCommit, repositoryRoot }`，并**把 session 的 cwd 切到新 checkout** |
| 默认位置 | `<current checkout root>/.agents/worktrees/<name>`；自动写一个内容为 `*` 的 `.gitignore`（仅当目录由它创建） |
| 依赖的 provider | 需要 `workingDirectory` + `fs` + `subprocess` + `sandbox` + `sandboxPolicy` 同时挂载 |
| 关键限制（原文） | ① **只认本地 commit**（不 fetch、不初始化 submodule、不装依赖、**不复制 uncommitted 文件**）；② **staged/unstaged/untracked/ignored 文件不复制**；③ checkout 时**禁用所有 git clean/smudge/process filter**（防执行仓库配置的程序）；④ LFS pointer / 加密 blob 保持原样不解；⑤ **不删**（离开保留 branch + files，清理归用户）；⑥ 需要 git ≥ 2.45（或指定的 2.39.4/2.40.2/2.41.1/2.42.2/2.43.4/2.44.1 maintenance 版）以支持 `GIT_NO_LAZY_FETCH` |
| 写权限 | 「The existing sandbox governs all writes」「Does not widen write access to the destination or shared Git administration directory」 |

**判定：采用（T1 高级用户路径），且明确"包装官方包"而非"自己实现"。**

理由：它就是 git 原语，零额外依赖，已被官方维护，默认关闭（符合"不打扰新手"）。**自己实现 worktree 管理 = 重复造轮子 + 自己踩 `GIT_NO_LAZY_FETCH` / filter / LFS 这些坑**——官方已经踩过并写进 README 了。

**但必须记录三条产品级坑**（这些是我们必须在 UI 层补的，官方不管）：
1. **未提交的改动不会带过去**。用户如果正在改东西就派并行 agent，新 worktree 拿到的是 `HEAD`，不是"用户眼前这版"。→ UI 必须先提示/先 commit 或先 stash，否则用户会认为"agent 没看见我的改动"。**这是最容易引发用户信任崩塌的一条。**
2. **node_modules 不复制**。每个 worktree 要重装依赖（README 明确"does not … install dependencies"）。对前端项目是分钟级等待。→ 这是 LayerFS 的核心卖点（见 §2.3），也是它的**唯一真实技术优势**。
3. **不清理**。长期使用会堆积 `.agents/worktrees/*` + 一堆 branch。→ 我们需要一个"清理 worktree"的壳侧入口（这属于 DshCockpit 体验层该做的事，不是重复造轮子）。

**还缺一条最重要的（L3 协调）**：官方 worktree 是「一个 Session 换到一个 checkout」，**没有**「Team 有 N 个 teammate，自动给每个分配一个 worktree」的分配器。`dsh-experimental-tool-worktree` 是**模型调用**的工具——意味着要由 Lead agent 自己决定给谁开 worktree，且 `ctx.workingDirectory.set` 影响的是**调用者自己的 Session cwd**，不是别人的。→ **多人并行时，每个 teammate 要各自调用一次 `create_worktree`，没有集中分配、没有冲突预防、没有合并责任归属。**

### 2.3 LayerFS（`Ephemeral-AI-Lab/layerfs`）— **Deferred**

#### 2.3.1 四项必须钉死的事实（用户明确要求）

##### 事实 1：**许可证 = MIT（已核实，无争议）**

| 项 | 实测 |
|---|---|
| GitHub API `/repos/Ephemeral-AI-Lab/layerfs` → `license.spdx_id` | **`MIT`**（`key: mit`, `name: MIT License`） |
| `LICENSE` 文件原文首行 | 「MIT License / **Copyright (c) 2026 Ephemeral-AI**」 |
| 主仓 stars / forks / open issues | **2,594 / 138 / 57** |
| 语言 / created / pushed | Rust（+ JS SDK 在 `api/`）/ 2026-08-10 / **2026-10-31T18:23:24Z** |

**结论：主仓 MIT 是干净的。** 上一版没有疑问，本版复核确认。

##### 事实 2：**版本状态 —— "Developer Preview" 标签的准确归属（这条必须写准，不能含混）**

用户要求"明确标注 Developer Preview 状态"。实测发现**这件事比一句话复杂，必须写准**：

| 版本 | GitHub Releases 实测 | 官方文档对它的称呼 | 标签 |
|---|---|---|---|
| v0.1.1 / v0.1.2 / v0.1.3 | 各自 2026-09-02 / 09-03 / 09-08 | **「LayerFS 0.1.x Developer Preview」** | **明确的 Developer Preview** |
| v0.1.4 | 2026-09-09 | 「LayerFS v0.1.4 — storage efficiency **Developer Preview**」 | **Developer Preview** |
| v0.1.5 | 2026-09-12 | release-policy 称「owner-authorized **v0.1.5 Developer Preview**」 | **Developer Preview** |
| v0.1.6 | 2026-09-16 | `docs/versioned/0.1.6/limitations.md` 标题：「LayerFS 0.1.6 **Developer Preview** manual」，正文「LayerFS is for **local evaluation and development**」 | **Developer Preview** |
| v0.1.7 | 2026-10-15 | release notes 标题：「**LayerFS 0.1.7 Developer Preview**」 | **Developer Preview** |
| **v1.0.0** | **2026-10-21**，`prerelease: false` | release 名：「**LayerFS v1.0.0 — first official release**」 | **官方称"首个正式发布"** |
| **v1.1.0**（当前） | **2026-10-24**，`prerelease: false` | README Status：「LayerFS **1.1.0**, **released as source**」；release-policy：「LayerFS 1.1.0 is an **owner-waived exception** (2026-10-24): it **breaks 1.0.0 JavaScript SDK code without a new major version**」 | **正式版本，但带"所有者豁免"** |

**准确表述（这是本版的修正要点）**：

> **LayerFS 的 0.1.x 全线是明确的「Developer Preview」（官方自己这么叫，且 0.1.6 手册正文写「for local evaluation and development」）。到 v1.0.0（2026-10-21）官方才自称"首个正式发布"，当前 v1.1.0 是正式版本——但 v1.1.0 是在"所有者豁免"下发布的，官方自己记录它"破坏了 1.0.0 的 JS SDK 代码却不升 major 版本"。**
>
> **所以不能简单写"LayerFS 是 Developer Preview"（1.0.0 之后这句已不准确），也不能写"它已稳定"（1.1.0 带着豁免破坏兼容性）。准确表述是：0.1.x 为 Developer Preview，1.0.0 起官方宣称正式，1.1.0 兼容性承诺被所有者豁免，且其发布策略原文写明「Pre-1.0 releases may evolve quickly. Any compatibility promise must still be stated explicitly in that release's manual; **silence is not a promise**」。**

**并且（关键）**：**v1.1.0 依然是"源码发布"，不提供预编译产物**。`docs/versioned/0.1.7/README.md` 原文：「The release is **source-only** … **No npm package, prebuilt executable or public runtime image is published.**」本版实测这条**到 1.1.0 仍然成立**：

| 检查项 | 实测 |
|---|---|
| npm `@layerfs/agent` | **`{"error":"Not found"}`** |
| npm `@layerfs/backend` | **`{"error":"Not found"}`** |
| npm `layerfs` | **`{"error":"Not found"}`** |

→ **所以"必须从源码构建"这条门槛到今天没有变化。** "它是正式版本"与"你能双击装上它"是两件事。

##### 事实 3：**无崩溃 / 断电持久性保证（官方自述原文，逐字保留）**

**主仓 README Status 段原文（2026-11-01 抓取）**：

> 「**The Store runs in its Disposable profile only, with no crash or power-loss durability**: use LayerFS for agent work and its history, **not as the only copy of data you cannot rebuild.**」

**README「Prior art」段末原文（它自己说什么时候该用别的）**：

> 「**Use something else** if you need crash or power-loss durability (the Store runs in its Disposable profile only), **full POSIX node types**, or **top sequential I/O bandwidth**. For a few long-lived checkouts on one machine, **Btrfs snapshots or Git worktrees may be all you need.**」

**`docs/versioned/0.1.6/limitations.md` 补充原文（更细）**：

> 「LayerFS is for **local evaluation and development**. **Keep independent copies of important data**; it is **not a backup service or a hostile-code security boundary**.」
> 「**Process-crash, OS-crash, power-loss and disaster-recovery guarantees are outside the MEMORY-journal/synchronous-OFF profile.** Filesystem fsync and bounded fsync batching **do not upgrade database durability**.」
> 「**Kernel-dirty shared mmap is still not captured by a Commit.** A write made through a shared `mmap` that the kernel has not written back is not part of the published snapshot.」
> 「**Automatic object garbage collection and deletion are outside this release.**」

**结论**：这不是我们推断的，是**官方 README 与手册逐字写的**。对一个托管**用户真实工作产物**的文件系统，这条事实本身就把"直接承载用户唯一副本"的可能性排除了。

##### 事实 4：**平台与 FUSE 限制（逐平台实证）**

| 平台 | 支持形态（官方原文） | 具体限制 |
|---|---|---|
| **Linux** | 原生 | Store 必须在**本地 Linux 文件系统**（ext4 / xfs / btrfs）；**FUSE 需要 `/dev/fuse` 与文档所述权限**；**Store 装在 Docker volumes 目录下（默认 `/var/lib/docker/volumes`），Docker 保留 root 权限 → 必须以能写该目录的用户跑，或给该用户一个他拥有的 `home`**，否则 Init 直接失败（`Unsupported`）；native addon 需本机 Cargo 1.85.1 构建 |
| **macOS** | 「macOS **via DSH**」 | **Mac 本身不执行任何 Store 调用**；`@layerfs/runtime` 为每个 LayerFS home 起一个**长期运行的 Linux 容器**（worker，`--restart unless-stopped`）承载全部 Store 调用；**必须有 Docker Desktop**；需要**sealed bundle**（`manifest.json` 逐文件校验）；需要**runtime Docker image**（官方用的是 Node 24.21 / Debian bookworm + pnpm/yarn corepack + git/python3/gcc/make）；冷构建约 **65s–2.5min**（arm64 Mac / 8 CPU / `-j 6` vs `-j 2`） |
| **Windows** | 「Windows **via WSL2**」 | **需要 WSL2 里的独立 Linux Docker Engine**（**不使用** Docker Desktop 的 Windows named pipe）；需要 `/dev/fuse`、Node ≥ 22.19、**sealed Linux bundle**；默认 Linux home 在 `/var/lib/dsh-layerfs-windows`；Windows 路径与 Linux 路径需分别配置 |
| **FUSE 语义缺口** | — | **FUSE 视图有意省略 FIFO、socket、device node、set-id bits、独立的 atime/ctime**（`pjdfstest` 证据）；**kernel-dirty shared mmap 不被 Commit 捕获** |
| **性能** | — | 顺序写 **0.31×**、顺序读 **0.81×**、随机写 **0.40×**（**比 libfuse passthrough 慢**）；fs-bench 1.71× 快；157 快照 100.1MB vs Btrfs+zstd 1994.6MB（19.9× 小） |
| **系统要求（dsh-layerfs 插件）** | — | Node **≥ 22.19**、**pnpm**、**Docker（macOS 用 Docker Desktop）**、网络；**从源码构建 `layerfs-daemon` + native addon**；**build 一个 runtime Docker image**；Windows 还要 WSL2 + Linux Docker Engine |

**关键补充（上一版已记录，本版保留）**：

- **`dsh-layerfs` 只支持 dsh web**：「**Only dsh web is supported. dsh desktop serves the same web client but was not tested.**」→ 我们全部用户在 desktop。
- **`dsh-layerfs` 插件仓库无 LICENSE 字段**：GitHub API `license: null`，仓库内无 LICENSE 文件（README 的 MIT badge 指向 `layerfs` 主仓）→ **按最严口径：视为未声明，不可依赖**（这条不变）。
- **安装插件要 6 步**，且要**新建独立 DSH_HOME**（不能用 `~/.dsh`）→ 与我们现有用户数据布局冲突。

#### 2.3.2 实测数据汇总表（全部保留）

| 项 | 实测值 | 证据 |
|---|---|---|
| 主仓 | `Ephemeral-AI-Lab/layerfs` 存在 | GitHub API |
| stars / forks / open issues | **2,594 / 138 / 57** | 同上 |
| 许可证 | **MIT**（`Copyright (c) 2026 Ephemeral-AI`） | raw LICENSE + GitHub API `spdx_id: MIT` |
| 语言 / created / pushed | Rust（+ JS SDK 在 `api/`）/ 2026-08-10 / **2026-10-31T18:23:24Z** | GitHub API |
| 当前版本 | **1.1.0**（v1.0.0 首个正式版 2026-10-21；v1.1.0 2026-10-24） | GitHub Releases API |
| 版本标签 | 0.1.x 全线 **Developer Preview**；1.0.0 「first official release」；1.1.0 「owner-waived exception」 | release notes + release-policy.md |
| 形态 | ① **Rust daemon + FUSE** 提供 Workspace 视图；② Store = **一个 SQLite 文件**（每 daemon/SDK 进程直接打开，无 DB server）；③ Content-addressed chunk 去重；④ Branch / Commit / Layer / Conflict / `.lww`（last-write-wins 名单）；⑤ JS SDK 三包 `@layerfs/agent` / `@layerfs/backend` / `@layerfs/runtime` + `layerfs` CLI | README + `api/README.md` |
| **持久性（致命限制，原文）** | 「**The Store runs in its Disposable profile only, with no crash or power-loss durability**: use LayerFS for agent work and its history, **not as the only copy of data you cannot rebuild.**」 | layerfs README Status 段 |
| **自身承认不该用的场景（原文）** | 「**Use something else** if you need crash or power-loss durability … or top sequential I/O bandwidth. **For a few long-lived checkouts on one machine, Btrfs snapshots or Git worktrees may be all you need.**」 | layerfs README "Prior art" 段末 |
| 性能自报 | fs-bench 1.71× 快；157 快照 100.1MB vs Btrfs+zstd 1994.6MB（19.9× 小）；pjdfstest 8798 断言 0 unexpected failure；**fio 顺序写 0.31× / 顺序读 0.81× / 随机写 0.40×（慢）** | README Results 表 |
| DSH 插件 | `Ephemeral-AI-Lab/dsh-layerfs`：stars **42**、forks 6、issues 4、**无 license 字段**、JS、created 2026-10-23、pushed 2026-10-27 | GitHub API |
| 插件形态 | 「a plugin bundle for dsh. **It changes no dsh code.**」给会话加 Work / History 两个 tag；**只支持 dsh web**（原文：「Only dsh web is supported. **dsh desktop serves the same web client but was not tested.**」） | dsh-layerfs README |
| 插件安装 | 6 步，需要：LayerFS checkout（pin 在 `layerfs.json` 的 commit）、**已构建的 deepseek-harness checkout**、Docker、pnpm；要 `pnpm install && pnpm run build` 两边都跑；要**新建独立 DSH_HOME**（不能用 `~/.dsh`） | dsh-layerfs README Install |
| npm | `@layerfs/agent` / `@layerfs/backend` / `layerfs` → **全部 404 Not found**（未发布，只能从源码构建） | npm registry 实测 |

#### 2.3.3 现状判定

**Deferred（暂缓）**。**不是"永久不采用"，不是"它不好"。** 准确含义：

> **在当前四项事实（0.1.x 才是 Developer Preview、1.1.0 带兼容性豁免、无崩溃/断电持久性、平台需 Docker/WSL2 + 源码构建且 dsh desktop 未测）同时成立时，不进入生产路径。任一事实被上游改变，触发 Re-evaluation。**

#### 2.3.4 **先承认它的真实增量（不贬低）**

官方给了 L0 原语（per-Session 换目录），但**没有给 L3 协调**。LayerFS 提供的正是「一个项目、多个 Branch、每个 agent 一个 Workspace、提交即 commit、冲突显式拒绝、合并/发布有语义」——**这是完整的一套并行协调协议**，官方确实没有。所以它的增量**不是零**，是：

| 它的真实增量 | 为什么官方替代不了 |
|---|---|
| **L3 协调协议**（Branch / Commit / Conflict / merge） | 官方 worktree 只给原语，不给分配器、不给冲突语义、不给合并责任归属 |
| **依赖不重装**（内容寻址 mount 视图，含 `node_modules`、ignored 文件、build 产物） | 官方 worktree 明确「does not … install dependencies」「不复制 untracked/ignored 文件」；**这是唯一不可能自己补的一项** |
| **每次 tool call 一次 commit 的细粒度历史** | 官方 `workspace-changes` 是 turn 级快照 + 只读观察，不产生可 branch 的对象 |
| **内容去重**（157 快照 19.9× 小于 Btrfs+zstd） | 官方无 |

#### 2.3.5 当前不接的理由（按"会不会失效"分层）

**会失效的反对理由（上游改进即可推翻）**：

1. **源码发布 + 必须 Docker/cargo 构建** → 无 npm、无预编译二进制、无公开 runtime image（本版实测三包全 404）。**若发布预编译 macOS arm64 + Windows 二进制则失效。**
2. **无崩溃/断电持久性**（官方自述 Disposable profile only）→ **若提供 durability 则失效。**
3. **dsh desktop 未测**（原文 `dsh desktop … was not tested`）→ **若提供 desktop 实测则失效。**
4. **1.1.0 的兼容性豁免**（官方自述打破 1.0.0 JS SDK 却不升 major）→ **若后续版本恢复严格 semver 则失效。**

**结构性理由（长期成立，不随上游改进失效）**：

5. **它要求把用户真实工作区搬进一个"store"**。这违背 DshCockpit「Workspace = 用户选定的真实目录」（`WORK-FIRST-V0.7.md` §3.1）——用户要能用 Finder/VS Code 直接打开那个目录。LayerFS 的 Workspace 是 FUSE 挂载视图，卸载后写入进 commit，**不是用户可以直接双开编辑的普通目录**（除非一直挂着）。**而它自己的 README 也把这点当成"不是替代品"来提示：`Use something else if you need … full POSIX node types`。**
6. **它的价值与"单机少 agent"成反比**。它的 benchmark 全是「157 个快照 / 5 个 agent / 4 并发进程」这种规模。我们的目标用户首跑是 1 个 agent。
7. **它是另一套版本控制语义**（Branch/Commit/Conflict/`.lww`），与 git 并存会造成"两套历史，哪个是真的"的产品级困惑。而这恰恰是我们已经在 git 上解决的问题。

#### 2.3.6 集成边界（如果将来要做）

| 形态 | 评价 | 说明 |
|---|---|---|
| **LF-B1 用户自装 LayerFS + 用户自装 `dsh-layerfs`** | ✅ **合规（MIT），但当前不做** | 这是"T2 极端/大型仓库"层的正确形态：只在文档写"高级用户可选自装"，**我们不打包、不默认、不做安装器**。**注意 `dsh-layerfs` 插件本身无 LICENSE 文件 → 若将来要打包须先取得上游许可声明** |
| **LF-B2 我们打包 LayerFS daemon / 二进制** | ⚠️ **当前不可行** | 无预编译产物（npm 全 404）、需 Docker + cargo 构建、runtime image 需自建 → 等于把用户变成 Kernel/Docker 工程师 |
| **LF-B3 我们实现 L3 分配器（不引入 LayerFS）** | ✅ **现在就该做** | 官方 worktree 原语 + 我们的 allocation/展示/清理 = L3 里我们真正拥有的那部分（见 §4.1.1） |
| **LF-B4 把用户工作区迁进 LayerFS Store** | ❌ **不做** | 违反"真实目录"定位 + 官方自述无持久性保证 |
| **LF-B5 用 LayerFS 只做"临时并行沙箱"，真实目录仍是主副本** | ⚠️ **可讨论的折中** | 这条**上一版没提**：如果 LayerFS 只承载"可丢弃的并行实验"，而用户真实目录仍是唯一权威副本，则持久性缺陷不再是关键缺陷。**但当前仍不做，因为平台门槛（Docker/WSL2）不因此消失** |

#### 2.3.7 Re-evaluation 触发条件（写死）

> 当且仅当以下**任一**成立，重启 LayerFS 评估（**不需要全部满足**——上一版要求"全部"过于严苛，本版改为"任一 + 组合判断"）：
>
> **条件组 A（发布与平台门槛下降，任一）**
> - **LF-T1** LayerFS 提供 **npm 上可安装的预编译产物**（macOS arm64 + Windows），用户无需 Docker / cargo；
> - **LF-T2** `dsh-layerfs` 提供 **dsh desktop 官方实测记录**，且仓库补上 LICENSE 声明。
>
> **条件组 B（数据安全性提升）**
> - **LF-T3** LayerFS 提供**崩溃/断电持久性**（不再只有 Disposable profile），或明确给出"承载用户唯一副本"的合规配置。
>
> **条件组 C（需求侧成立）**
> - **LF-T4** 出现**可量化的用户抱怨**：并行 worktree 重装依赖的等待时间被用户明确投诉（≥3 个独立用户，或 ≥1 个付费场景）；
> - **LF-T5** 我们的用户画像从"单机少 agent"变成"大型仓库 + 高并发团队"（**这是唯一能让结构性理由 5/6 失效的条件**）。
>
> **组合判断规则**：
> - **A 组任一条 + C 组任一条同时成立** → 启动 POC（LF-B5 折中形态优先，不迁主副本）。
> - **只有 B 组成立** → 仍需 A 或 C，因为"数据安全了"不等于"用户装得上"或"用户需要"。
> - **只有 C 组成立**（需求真出现了但平台门槛没降）→ **不做 LayerFS，做 LF-B3（自己的 allocation 层）**。
>
> **不得因为"技术上很酷"而提前接。** 但也**不得因为它当前门槛高就把它从候选里划掉**——它是"依赖不重装"这一项的唯一候选，见 §4.4。

---

### 2.4 普通独立目录（当前默认路径）

| 项 | 实测 |
|---|---|
| 现状 | 我方 `src/work/workspace-store.js`(515 行) 已经是"用户选定真实目录 + `.dsh/` 索引 + `.dsh/artifacts/`" |
| 全部写入范围 | 注释原文：「只写 `<workspace>/.dsh/**`，永不写用户工作区的其他位置（P1 边界）」 |
| 索引内容 | 只存**工作区相对路径**；绝对路径只在返回值里供壳使用，"绝不进入 ExecutionEvent / Team fact / Office 快照" |
| 原子性 | 临时文件 + rename；读到损坏索引 **fail-closed**（不静默重建） |
| 变更捕获（自研） | `MANIFEST_MAX_FILES: 5000`、`MANIFEST_MAX_HASH_BYTES: 2MiB`、`MANIFEST_MAX_HASHED_FILES: 200`、排除 `node_modules/.git/dist/build/...` |
| 隔离能力 | **零**（就是同一个真实目录） |

**判定：作为默认路径保留。** 它与官方 `dsh-workspace`（workspace 实体注册表）/`dsh-workspace-changes` 是**互补关系**，不是重复：官方管"分组 + 变更"，我们管"`.dsh/` 索引 + Artifact 事实"。

### 2.5 四种方案横向矩阵

| 维度 | 普通独立目录 | Git Worktree（官方） | LayerFS | Btrfs/ZFS 快照 |
|---|---|---|---|---|
| 用户装什么 | 无 | 无（git 自带） | **Docker + cargo build + WSL2** | 换文件系统 |
| 隔离粒度 | 无 | 分支级 checkout | 每次 tool call 一次 commit | 快照级 |
| 依赖（node_modules）是否复制 | 就是原目录 | **否**（要重装） | **是**（从 commit 树挂载） | 是（reflink） |
| 未提交改动 | 就是原目录 | **不带过去**（重大坑） | 取决于 init 时扫描 | 带 |
| 变更捕获 | 我方自研 manifest（弱） | 无（但可叠官方 `workspace-changes`） | 内建 Branch/Commit 历史 | 无 |
| 合并/冲突 | 无 | git merge（成熟） | Branch + `Conflict` + `.lww` | 无 |
| **崩溃持久性** | 有（真实 FS） | **有**（真实 FS + git objects） | **无（官方自述 Disposable profile only）** | 有 |
| **FUSE 语义完整性** | 有（真实 FS） | 有（真实 FS） | **有意省略 FIFO/socket/device node/set-id bits/独立 atime-ctime** | 有 |
| **版本状态** | — | 官方 experimental（默认关） | **0.1.x Developer Preview；1.0.0 起正式；1.1.0 兼容性被所有者豁免** | 内核正式特性 |
| **许可证** | 自有 MIT | 随 runtime | **MIT（主仓）；`dsh-layerfs` 插件无 LICENSE** | — |
| 跨平台 | 全 | 全（git ≥2.45 更稳） | **Linux 原生 / macOS 需 Docker Desktop + 密封 bundle / Windows 需 WSL2 + 独立 Docker Engine** | 按平台 |
| 运维成本 | 0 | 低（会堆 worktree/branch，需清理） | **高** | 中（需换 FS） |
| 适合谁 | 新手、单人、单 agent | **高级用户、并行多 agent** | 大型仓库 + 频繁并行 + 已有 Docker 环境 | 高级用户、追求极致快照 |

---

## 3. 为什么**不**把 LayerFS 作为当前首选（把反对理由写到能复盘）

如果只写"门槛高"，将来有人会说"门槛会降"。所以把它**逻辑上可失效**的部分与**逻辑上不会失效**的部分分开（§2.3.5 已列）。这里补一条方法论说明：

**§3 的目的不是"给 LayerFS 判死"，而是"把它的重评条件精确化"。** 上一版的写法（"暂缓 = 不是等它改好了就用，而是除非用户画像变了否则不启动"）**过强**——因为"预编译产物发布"这一条确实是可失效的，而且历史上很多工具都走完了这条路。本版把这一条明确列进 **LF-T1**，作为**独立的重评触发条件**（不需要用户画像变）。

**保留不变的一条结构性判断**：

> **它要求把用户真实工作区搬进一个 "store"，这与 DshCockpit「Workspace = 用户选定的真实目录」的定位冲突。** 这条不随 LayerFS 的工程改进失效——除非我们改产品定位（LF-T5）。**但注意：§2.3.6 的 LF-B5（只承载可丢弃的并行实验、真实目录仍是主副本）可以在不改定位的前提下部分绕开它。** 上一版没提这个折中，是一处遗漏。

---

## 4. 分层建议（明确表态）

### 4.1 三层，不是一个开关

| 层 | 谁 | 默认 | 隔离手段 | 我们（壳层）要补什么 |
|---|---|---|---|---|
| **T0 新手 / 单任务** | 首跑用户、单人开发 | **默认** | **普通独立目录**，一个 agent | 什么都不做。**不要出现"worktree"这个词** |
| **T1 高级 / 并行** | 明确开了"并行团队"的用户 | 用户显式开启 | **包装官方 Git Worktree**（`dsh-experimental-worktree` + `-tool-worktree`），**不自研** | ① 派单前检测未提交改动并提示 commit/stash；② 显示"每个 worktree 要重装依赖，预计 X 分钟"；③ 提供清理入口（列 worktree + 一键删 branch/files）；④ **写一个 allocation 策略**（谁得哪个 worktree）——这是官方 L3 空缺，但只做"分配 + 记账 + 展示"，**不做文件系统** |
| **T2 极端 / 大型仓库** | 有 Docker、有巨大依赖树、真正高并发 | **不提供**（用户自装） | LayerFS（用户自己装 `dsh-layerfs`）—— **Deferred，等 §2.3.7 触发** | 只在文档里写"高级用户可选自装"，**不打包、不默认、不做安装器**。**当前连文档推荐都先不做**（因为 `dsh-layerfs` 无 LICENSE 声明 + dsh desktop 未测） |

**一句话：新手和高级用户必须分层，而且分层的分界线是"用户有没有显式打开并行模式"，不是"用户是不是高手"。**

### 4.1.1 T1 到底是"包装官方 worktree"还是"自己实现"？（Lead 明确要求回答）

**答：包装官方包，只补 allocation + 展示 + 清理三件事。不自研 worktree 管理。**

| 职责 | 归属 | 理由 |
|---|---|---|
| 建分支 + 建 checkout + 切 cwd + `.gitignore` 管理 | **官方 `dsh-experimental-worktree`** | git 语义细节多（`GIT_NO_LAZY_FETCH`、filter 禁用、LFS pointer、submodule、git 版本下限 2.45）；官方已踩过坑并写进 README |
| 模型侧工具入口 `create_worktree` | **官方 `dsh-experimental-tool-worktree`** | 已被官方注册进工具目录，自动跟随模型协议 |
| **Allocation（谁得哪个 worktree）** | **我们** | 官方没有：`ctx.worktrees.create` 是"调用者给自己开"，Team 场景需要"Lead 给 teammate 开"或"每个 teammate 自己开 + 集中记账" |
| **未提交改动的拦截提示** | **我们** | 官方 README 只说"不复制"，没说怎么提示用户 |
| **合并 / 冲突处理的责任归属** | **我们 + 人** | 官方 README 把这条推给"Lead must coordinate"；产品上必须显式化（谁合并、什么时候、失败了怎么办） |
| **清理 / 回收** | **我们** | 官方明确「removal, pruning, and branch deletion belong to the user or another consumer」 |
| **依赖重装的预估与告知** | **我们** | 官方不管；这是用户等待时间的主要来源 |

**为什么不自研 worktree 管理**：`dsh-experimental-worktree` 的 README 里那些限制（只认本地 commit、禁 filter、LFS 不解、git 2.45 下限）**每一条都是我们自己实现时会踩的坑**，而且我们踩了不会写文档。重复造轮子的代价在这里是**具体的、可枚举的**——所以结论明确。

**同时必须承认**：官方 worktree 包是 **experimental**（包名前缀 `dsh-experimental-`），「its contracts can change freely while it incubates」是这类包的共同声明（agent-team README 明写了这句）。→ **T1 层必须做成可关闭的**，且官方包 API 变更时要能降级回"纯普通目录 + 人工切换"。

### 4.2 为什么不是"按用户等级自动切换"

自动判断"这是高级用户"必然出错（按项目大小？按历史行为？），出错代价是**用户的工作区被悄悄换成了 worktree 或 FUSE 挂载**，而他不知道文件在哪。**隔离方式的切换必须由用户显式触发，且必须在 UI 上可见"我现在在哪个目录"**。

### 4.3 T1 的关键产品缺口（官方不管，我们必须补）

官方 `dsh-workspace-changes` + `dsh-experimental-worktree` 合起来仍缺三件事，这三件是 DshCockpit 该做的：

1. **"我的改动会不会丢"的提示**：worktree 从 `HEAD` 开，不复制 uncommitted。→ 派单前必须拦截。
2. **"哪个 agent 在哪个目录"的可视化**：官方 worktree README 说 `repositoryRoot` 返回、cwd 会切，但没有多 worktree 的总览。→ 这是 Office/工作台该呈现的（`docs/design/office-interaction.md` 的 Mission Board 候选）。
3. **清理**：官方明确「removal, pruning, and branch deletion belong to the user or another consumer」。→ 我们要提供，否则用户的 `.agents/worktrees/` 会无限增长。

### 4.4 对 LayerFS「增量价值」的最终裁定（Deferred 版）

把 L3 缺口摊开，逐项问「官方有没有 / LayerFS 有没有 / 我们能不能自己补」：

| L3 的子能力 | 官方 worktree 包 | LayerFS | 我们自己补的成本 | 裁定 |
|---|---|---|---|---|
| 隔离原语（建 checkout） | **有** | 有（更强：不需要 git） | 不必补 | 官方够 |
| 分配（谁得哪个 worktree） | **没有** | 有（Branch 一开就是） | **低**（一个 allocation 表 + UI） | **自己补** |
| 未提交改动的处置 | **没有**（不复制） | 有（从 commit 树挂载，但只含已提交内容） | **低**（UI 拦截 + 提示） | **自己补** |
| 逐文件冲突检测 | **没有** | 有（`Conflict` + `.lww`） | 中（但官方 `fs-observation-policy` 已覆盖文件工具路径） | 官方 + 自己补够用 |
| 合并 | **没有** | 有（Branch merge） | **低**（git merge 是现成的；人批准后跑一条命令） | **自己补** |
| 依赖不重装 | **没有** | **有（唯一不可替代的优势）** | **不可能自己补**（这就是要一个内容寻址文件系统） | **只有 LayerFS 能给** |
| 崩溃持久性 | 有（真实 FS） | **没有（官方自述）** | — | 官方更好 |
| 跨平台 | 全 | Linux 原生 / mac+win 经 Docker worker | — | 官方更好 |

**结论（一句话）**：

> **LayerFS 唯一不可替代的增量，是「依赖不重装」（内容寻址的 mount 视图）。L3 的其他六项，官方 worktree + 我们自己补一部分，成本都远低于引入 LayerFS。而它唯一不可替代的那一项，恰好对应我们用户群当前最低频的痛点（只有 node_modules 巨大的仓库才明显）。**

**所以 "Deferred" 的准确含义（修正上一版）**：

> **不是"它就永远不行了"，而是**：
> **(a) 当前阶段（T0/T1 都刚起步）不启动；**
> **(b) 它的门槛清单里，有四条是可失效的（见 §2.3.5 第 1–4 条），已全部写成**独立的**重评触发条件（LF-T1…LF-T4）；**
> **(c) 它唯一不可替代的能力（依赖不重装）对应的是我们当前最低频的痛点，所以即使门槛下降，也要需求侧同时成立才值得做。**
>
> **上一版写的"除非我们的用户画像变了，否则不启动"过强——因为"发行预编译产物"这一条单独成立就足以让我们重新评估。本版把这条修正。**

---

## 5. 与 `dsh-workspace` / `dsh-workspace-changes` 的边界（避免重复造轮子）

| 能力 | 官方包 | 我方现状 | 0.2.x 后该做什么 |
|---|---|---|---|
| workspace 实体列表（项目分组 + 会话归属） | `dsh-workspace`（`ctx.workspaceRegistry`，需 session-persistence + storage 后端；「invisible to models，adds no prompt cost」） | 无（我方 `workspace-store.js` 是工作区内的 `.dsh/index.json`，语义不同） | **挂官方**，我方只做 UI 呈现 |
| 逐轮变更捕获 + 逐文件 diff | `dsh-workspace-changes`（`workspace/changes` 事件 + `summary()`/`diff()`） | `workspace-store.js` 的 manifest 哈希（`MANIFEST_MAX_HASHED_FILES: 200`，**只哈希 200 个文件**） | **官方为主路径**；我方 manifest 降级为"无 git / 无 subprocess 时的兜底" |
| 文件读后写守卫 | `dsh-fs-observation-policy`（read-before-edit + changed-since-read 拒绝） | 无 | **挂官方**。注意它默认在 `dsh-base` 里，我们的 `src/main.js` 不要自己实现同类守卫 |
| 并行 checkout 原语 | `dsh-experimental-worktree` + `-tool-worktree`（**experimental，API 可变**） | 无（`grep -rn worktree src/` → 0 命中） | **T1 包装它**，不自己写；包一层可关闭的开关 |
| worktree 分配 / 展示 / 合并 / 清理 | **无** | 无 | **我们自己写**（这是 L3 中我们真正拥有的那部分） |
| 用户真实目录 + Artifact 索引 | 无 | `src/work/workspace-store.js`(515) | **保留自研**（这是产品差异化，不是重复） |

---

## 6. 待验证 / 无法核实清单

| 项 | 状态 | 原因 |
|---|---|---|
| LayerFS 在 macOS arm64 桌面上的**实测**性能与稳定性 | **未验证** | 需要 Docker + cargo 构建，本次评估为"判定 Deferred"故未安装（避免污染环境且结论已定） |
| LayerFS 的 FUSE 挂载在 Electron/Chromium 下的**文件监听**行为 | **未验证** | 同上；这是潜在重大坑（chokidar 对 FUSE 的事件支持未知） |
| 官方 `dsh-experimental-worktree` 在 0.2.1-rc.5 的**真实可开启性** | **未验证** | asar 内是 desktop runtime，未 boot 一个 0.2.1 profile 实测（本机 profile 是 0.1.5） |
| `ctx.worktrees.create` 是否能给**别人的 Session** 开（而非只给调用者自己） | **未验证** | README 只说 `create(agent, …)` 然后 `ctx.workingDirectory.set`；Team 场景下"Lead 给 teammate 开"是否可行需实测。**这条直接决定 T1 allocation 策略的形态** |
| `dsh-workspace-changes` 的 `workspace/changes` 事件在 DshCockpit mux 里是否能拿到 | **未验证** | 属 task-1（Runtime Bridge）范围 |
| LayerFS 的 `.lww` 冲突规则在真实多人场景下的表现 | **未验证** | 需真实使用 |
| **`dsh-layerfs` 插件的许可证** | **无法核实** | GitHub API `license: null`；README 里有 MIT badge 指向 `layerfs` 主仓 LICENSE，但**仓库自身无 LICENSE 文件**。按最严口径：视为**未声明**，不可依赖（**这条不变，是本版明确指出的一项真实阻塞**） |
| LayerFS v1.1.0 之后是否恢复严格 semver | **无法核实（尚未发生）** | release-policy 明确 1.1.0 是 "owner-waived exception"；下次发布是否回归正常 semver 未知 |
| LayerFS 是否会发布预编译产物 | **无法核实（尚未发生）** | 本版实测三个 npm 包全 404；官方路线图本次未逐项抓取 |

---

## 7. 证据索引（2026-11-01 实测）

- **asar 内官方 README**：`dsh-workspace-changes`、`dsh-experimental-worktree`、`dsh-experimental-tool-worktree`、`dsh-fs-observation-policy`、`dsh-workspace`、`dsh-experimental-agent-team`（全文解析，含 Known Limitations 原文）
- **asar 内包名全量**：308 个 `@deepseek-ai` 包（`grep -i worktree` → `dsh-experimental-worktree` / `dsh-experimental-tool-worktree` 两个）
- **我方代码**：`src/work/workspace-store.js`(515)、`src/work/work-controller.js`、`grep -rn worktree src/` → 0
- **profile 实测**：`node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config | grep -c workspace-changes` → `0`
- **GitHub API**：`Ephemeral-AI-Lab/layerfs`（2594★ / **MIT（`spdx_id: MIT`）** / Rust / pushed 2026-10-31）、`Ephemeral-AI-Lab/dsh-layerfs`（42★ / **license null** / JS / created 2026-10-23 / pushed 2026-10-27）
- **GitHub Releases API（版本状态，本版新增）**：`v1.1.0`（2026-10-24, prerelease:false）、`v1.0.0`（**2026-10-21, "first official release"**）、`v0.1.7`（2026-10-15, "**Developer Preview**"）、`v0.1.6`/`v0.1.5`/`v0.1.4`/`v0.1.3`/`v0.1.2`/`v0.1.1`（全线 Developer Preview 标签）
- **LayerFS 官方文档直抓（本版新增）**：
  - README Status 段：「**The Store runs in its Disposable profile only, with no crash or power-loss durability**」
  - README "Prior art" 段末：「**Use something else** if you need crash or power-loss durability … full POSIX node types … **For a few long-lived checkouts on one machine, Btrfs snapshots or Git worktrees may be all you need.**」
  - `docs/general/release-policy.md`：「Pre-1.0 releases may evolve quickly. Any compatibility promise must still be stated explicitly in that release's manual; **silence is not a promise.**」；「LayerFS 1.1.0 is an **owner-waived exception** (2026-10-24): it **breaks 1.0.0 JavaScript SDK code without a new major version**」
  - `docs/versioned/0.1.7/README.md`：「The release is **source-only** … **No npm package, prebuilt executable or public runtime image is published.**」
  - `docs/versioned/0.1.6/limitations.md`：标题「LayerFS 0.1.6 **Developer Preview** manual」；「LayerFS is for **local evaluation and development**. **Keep independent copies of important data**; it is not a backup service or a hostile-code security boundary」；「**Process-crash, OS-crash, power-loss and disaster-recovery guarantees are outside the MEMORY-journal/synchronous-OFF profile**」；「**Kernel-dirty shared mmap is still not captured by a Commit**」；「**Automatic object garbage collection and deletion are outside this release**」
  - `docs/release-notes/1.1.0/README.md`：1.1.0 拆成 `@layerfs/agent` / `@layerfs/backend` / `@layerfs/runtime`；macOS/Windows 走 worker（Linux 容器 / WSL2 进程）
  - `docs/release-notes/0.1.7/README.md`：标题「**LayerFS 0.1.7 Developer Preview**」；「released … **with waivers**」
- **`dsh-layerfs` README 直抓（平台限制原文）**：「**Only dsh web is supported. dsh desktop serves the same web client but was not tested.**」；Linux 需 `/dev/fuse` + 能写 Docker volumes 目录；macOS 需 Docker Desktop + sealed bundle + runtime image；Windows 需 WSL2 + 独立 Linux Docker Engine + sealed bundle；Node ≥ 22.19、pnpm、Docker
- **npm**：`@layerfs/agent` → **404**；`@layerfs/backend` → **404**；`layerfs` → **404**（均未发布）
- **URL**：
  - https://github.com/Ephemeral-AI-Lab/layerfs
  - https://github.com/Ephemeral-AI-Lab/dsh-layerfs
  - https://layerfs.ai/docs/integrations/dsh/
  - https://github.com/Ephemeral-AI-Lab/layerfs/blob/main/docs/general/release-policy.md
  - https://github.com/Ephemeral-AI-Lab/layerfs/blob/main/docs/versioned/0.1.6/limitations.md
  - https://github.com/Ephemeral-AI-Lab/layerfs/releases
