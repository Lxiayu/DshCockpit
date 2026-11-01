# 第三方项目总评估表 + 桌宠仓库辨析 + 参考项目设计研究

> 状态：**评估结论（Deferred / Re-evaluation 框架）** · 核查日期 **2026-11-01（Asia/Shanghai）**，结论框架修订 **2026-11-01**
> 边界：本文是**总表 + 仓库辨析 + 设计研究**。记忆专项见 `docs/research/memory-systems.md`，隔离专项见 `docs/research/workspace-isolation.md`，Live2D 见 `docs/research/live2d-evaluation.md`。Provider 抽象设计归 `docs/architecture/capability-platform.md`（Lead 执笔）。
> 纪律：**所有 stars / 许可证 / 版本号均为 2026-11-01 实测**（GitHub API + npm registry + raw LICENSE + tarball 解包 + asar 解包）。无法核实的一律标「无法核实（原因）」，**不编造**。
>
> **本版修订（用户直接要求）**：
> > 「对于本阶段不集成的项目，使用 Deferred / Re-evaluation，而不是简单删除技术研究记录。」
>
> 上一版本文用「**判死清单（明确拒绝，不留后路）**」表述 5 个项目，并写「判死的意思不是"暂不考虑"，是"下一阶段不得再有提案"。若有人要重启，必须先推翻本文的实测数据」。**这个框架过强**：它把"当前阶段不采用"和"永久否决"混为一谈，并且把**可失效的工程理由**（未发 npm、平台门槛、维护活跃度）写成了不可推翻的判决。
>
> 本版改为 **Deferred / Re-evaluation 框架**：每一项都写「现状判定 | 风险 | 集成边界（如果将来要做）| Re-evaluation 触发条件 | 证据」，**保留全部实测数据**（一个数字都没删），只修正结论表述。

---

## 0. 三十秒结论

**下一阶段应该接的 Provider：0 个。**

不是"都不够好"，而是：**这一轮候选清单里，没有任何一个能同时通过「官方没覆盖」+「许可证可打包」+「维护成本我们扛得住」三道门。**

- 记忆方向：官方栈已覆盖 G1/G2/G3，缺的 G4/G5 应该我们自己做（见 `memory-systems.md`）。
- 隔离方向：官方已解决捕获层，没解决协调层；解决协调层的第三方（LayerFS）当前门槛不可接受（见 `workspace-isolation.md`）。
- 知识库方向：目标用户当前不需要 RAG（见 §3）。
- 角色方向：Live2D 落在许可高成本区（暂缓生产接入，非永久拒绝）；桌宠三个仓库都是**设计参考**而非集成对象（见 §2）。

**真正该做的是三件"不接第三方"的事**：打开官方的 session 检索、扩展我们自己的 `AGENTS.md` 编辑器、把官方 `dsh-goal` 接成 Mission 持久层。

**但"0 个"是这一阶段的答案，不是终审。** 每一项都带独立的重评触发条件，见 §1 与各专项文档。

---

## 1. 总评估表（全候选，2026-11-01 实测）

**图例（本版新框架）**：

| 标记 | 含义 | 含义边界 |
|---|---|---|
| **★ 采用** | 本阶段采用 | 无 |
| **◐ Deferred** | 本阶段不集成；**有条件重启** | **不是否决**。触发条件写在"重评条件"列与专项文档 |
| **◇ 设计参考** | 不作为代码集成对象，只借设计 | 与许可/门槛无关，是定位判断 |
| **✕ 不适用** | 与我们的产品形态**结构冲突**（不是门槛问题） | 明确说明冲突点 |

> **上一版的 ✕「放弃/判死」已全部不存在。** 原 4 个"判死"对象（Obelisk / OpenViking / dsh-memory-evolve / ysyyhhh-dsh-pet）与本版新增的 Live2D，全部改判为 ◐ Deferred 或 ✕ 不适用，并逐条给出理由。

### 1.1 记忆与历史

| 项目 | 实测（stars / 许可证 / 最近提交） | 解决什么 | 与官方重叠 | 结论 | 重评条件（详见） |
|---|---|---|---|---|---|
| **官方栈**：`dsh-goal` + `dsh-compaction*` + `dsh-session-query-sqlite` + `dsh-agent-instructions` | asar 内 0.2.1-rc.5；我方 0.1.5 已含其中 6 个包 | G1 目标持久 / G2 上下文 / G3 历史检索 / 记忆加载链 | — | **★ 首选（唯一）** | — |
| **DshCockpit 自研扩展**：`memory-files.js` + 打开官方检索 | MIT（自有，`package.json` 实测）；`memory-files.js` 94 行 | G3 产品面 + G4 写入治理 | **互补**（我们做 UI/治理，官方做存储/加载） | **★ 首选的自研部分** | — |
| `dsh-mnemon`（`omdsh-dev`） | **812★** / **MIT** / pushed **2026-10-31** / npm `0.5.37` | G4 记忆治理 + G5 抽取确认；Providers 可插拔 | 部分（它也有 Runtime memory / Project Documents） | **◐ 备选（有明确触发条件）** | `memory-systems.md` §4.4 三条（0.2.x 迁移完成 + 需求可复现 + 自研不够用） |
| `dsh-memory-evolve`（`csyangwen`） | **476★** / **MIT（三重核实）** / pushed **2026-10-29** / **npm 404 + `private: true`** / tests 72 文件 | G4+G5 + **Team 编排（COI 调度）** | **高**（COI≈官方 Agent Teams；会话搜索≈官方 session-query） | **◐ Deferred**（**上一版：放弃**） | `memory-systems.md` §4.3.6 的 M-T1…M-T5 |
| **Obelisk**（`tommy0103`） | **756★** / **AGPL-3.0-only** / pushed 2026-10-31；2026-06-14 **从 MIT 改成 AGPL** | G3（多 provider 历史 → SQLite + FTS5） | **完全重叠**（它就是历史检索） | **◐ Deferred**（**上一版：放弃/硬拒绝**） | `memory-systems.md` §4.1.5 的 O-T1…O-T4（自装+进程外只读形态 / 上游 dual-license / 上游回退宽松许可） |
| **OpenViking**（`volcengine`） | **41,244★** / **主项目 AGPL-3.0，但 `examples/` 与 `crates/ov_cli` 是 Apache-2.0，`examples/hermes-plugin` 是 MIT，`sdk/typescript` 声明 Apache-2.0** / pushed 2026-10-31 | G4/G5 高级形态（L0/L1/L2 分层 + 目录语义检索） | 部分 | **◐ Deferred（组件级分层：宽松组件可用，AGPL 服务端不可打包）**（**上一版：放弃/硬拒绝**） | `memory-systems.md` §4.2.7 的 V-T1…V-T4 |

**这一节最重要的两处修正**：

1. **OpenViking 从"一句话判 AGPL"→ 组件级许可证矩阵。** 上一版写「用它的 SDK 都进 AGPL 域」是**事实错误**：根 README 的 License 段逐组件声明，`examples/`（含 DSH memory plugin）与 `crates/ov_cli` 是 **Apache-2.0**，`examples/hermes-plugin` 保留 **MIT**，`sdk/typescript` 声明 **Apache-2.0**。之后那半句「npm 插件声明 Apache-2.0 但 tarball 无 LICENSE → 按最严判 AGPL」的推理也过强：那个组件在 `examples/` 目录下，**目录级 `examples/LICENSE` 是 Apache-2.0 全文**；tarball 缺 LICENSE 是**分发合规缺陷**（我们打包时须自补），**不改变许可归属**。
2. **dsh-memory-evolve 的 MIT 已三重核实**（GitHub API `spdx_id: MIT` + LICENSE 原文 `Copyright (c) 2026 dsh-external` 1069B + `package.json` `"license": "MIT"`）。并且上一版把它的 CHANGELOG 当作"维护风险"证据，方向下反了——**它的 CHANGELOG 是本轮所有候选里工程记录质量最高的**（逐条根因 + 法证数据 + 「已验证还原修复后测试必失败」），且两次上游破坏性变更（0.2.0-rc.1 / 0.2.1）都在 1 个月内适配完成。真正的风险是"**只有一个人修**"，不是"他修不动"。

### 1.2 并行开发与文件系统隔离

| 项目 | 实测 | 解决什么 | 与官方重叠 | 结论 | 重评条件（详见） |
|---|---|---|---|---|---|
| **官方 `dsh-workspace-changes`** | asar 0.2.1 内；**我方 0.1.5 没有**（`--dump-config \| grep` → 0） | L1 逐轮变更捕获 + 逐文件 diff | — | **★ 采用**（0.2.x 迁移后挂上） | — |
| **官方 `dsh-fs-observation-policy`** | asar 0.2.1 + 0.1.5 都有 | L2 read-before-edit + changed-since-read 拒绝 | — | **★ 采用**（已在 `dsh-base`） | — |
| **官方 `dsh-experimental-worktree` + `-tool-worktree`** | asar 0.2.1；**默认关闭**「stays off until selected」 | L0 分支级 checkout 隔离原语 | — | **★ 采用（T1 高级用户，包装不重写）** | — |
| **LayerFS**（`Ephemeral-AI-Lab/layerfs`） | **2,594★** / **MIT（`spdx_id: MIT` 已核实）** / Rust / **v1.1.0（0.1.x 全线 Developer Preview；1.0.0 首个正式版；1.1.0 带"所有者豁免"）** / pushed 2026-10-31 | 并发 + **依赖不重装** + 分支合并 + 内容去重 | 与官方 worktree 部分重叠（更强） | **◐ Deferred**（**上一版：暂缓但偏否定**） | `workspace-isolation.md` §2.3.7 的 LF-T1…LF-T5 |
| `dsh-layerfs`（dsh 插件） | **42★** / **license 字段 = null（仓库内无 LICENSE 文件）** / pushed 2026-10-27 / **未发 npm** | 上述能力的 dsh UI（Work/History tab） | — | **◐ Deferred**（跟随 LayerFS；**许可未声明是一项独立阻塞**） | 上游补 LICENSE + 提供 dsh desktop 实测 → `workspace-isolation.md` LF-T2 |
| 普通独立目录 | 我方 `src/work/workspace-store.js` **515 行** | 无隔离，就是真实目录 | 与官方 `dsh-workspace` 互补 | **★ 默认路径（T0 新手）** | — |

**这一节最重要的修正**：**LayerFS 的版本状态必须写准**。用户要求"明确标注 Developer Preview"。实测结果是分段的：

- **0.1.1 – 0.1.7 全线是官方自称的「Developer Preview」**（0.1.6 手册正文写「LayerFS is for **local evaluation and development**」）；
- **v1.0.0（2026-10-21）官方自称「first official release」**；
- **v1.1.0（当前，2026-10-24）是"所有者豁免"下发布的**：官方 release-policy 原文写它「**breaks 1.0.0 JavaScript SDK code without a new major version**」。

→ 所以**既不能写"LayerFS 是 Developer Preview"（1.0.0 后已不准确），也不能写"它已稳定"（1.1.0 带豁免破坏兼容性）**。准确表述见 `workspace-isolation.md` §2.3.1 事实 2。

另外三项事实已钉死：**MIT 已核实**、**无崩溃/断电持久性（官方 README 逐字：「The Store runs in its **Disposable profile only, with no crash or power-loss durability**」）**、**平台/FUSE 限制（Linux 原生需 `/dev/fuse` + 可写 Docker volumes；macOS 需 Docker Desktop + 密封 bundle；Windows 需 WSL2 + 独立 Linux Docker Engine；FUSE 有意省略 FIFO/socket/device node/set-id bits/独立 atime-ctime；npm 三包全 404）**。

### 1.3 知识库

| 项目 | 实测 | 解决什么 | 与官方重叠 | 结论 | 重评条件 |
|---|---|---|---|---|---|
| **WeKnora**（`Tencent`） | **36,116★** / **许可证 = `NOASSERTION`（实为 MIT + 第三方组件清单）** / Go / **v0.9.0** / pushed 2026-10-30 | 企业文档 RAG + Agent + Wiki | 官方无 RAG（`grep`/`glob` 只读工作区，`web_search` 只读互联网） | **◐ Deferred** | §3.3 四条（企业用户 + 10 万级文档 + 用户自备实例 + 官方仍无检索） |
| `@wxg-prc-cpg/dsh-weknora`（官方 DSH 插件） | **npm `0.1.0`** / **MIT** / 发布 **2026-08-21** | 让 dsh agent 访问 WeKnora 知识库（hybrid 检索 / 全文读 / 带引用的组合答案） | — | **◐ Deferred**（跟随 WeKnora；**许可干净，若采用只装它不装服务端**） | 同上 |

### 1.4 桌宠与角色（三个仓库，不是两个——见 §2）

| 项目 | 实测 | 形态 | 结论 | 重评条件 |
|---|---|---|---|---|
| **`PC2005-cloud/dsh-pet`**（DshCockpit 历史文档引用的是**这个**） | **5,117★** / **代码 MIT + 素材「禁止商用」** / TypeScript / pushed **2026-10-31** | DSH 插件（浏览器 overlay + Electron 双形态） | **◇ 设计参考**（视频直用路线已拆解；**代码许可 MIT 可借鉴，素材绝不使用**） | 素材改为可商用授权 + 我们决定走视频直用路线 |
| **`sundusk/dsh-pet`** | **0★** / **MIT** / **Swift** / pushed **2026-10-28** | **macOS 14+ 原生 SwiftUI App**（非 DSH 插件）+ 桥接插件 `@sundusk/dsh-pet` v0.8.2 | **◐ Deferred**（平台不兼容 + 素材授权缺失） | 出现 Windows 版 + 鲸鱼娘素材许可补齐（或改用自有素材） |
| **`ysyyhhh/dsh-pet`** | **1★** / **MIT** / **TypeScript** / pushed **2026-08-15**（已 2.5 月未动） | DSH Cordis 插件（Web pet + 多宠 overlay），**是 `sereinmono/dsh-desktop-pet` 的 fork** | **◐ Deferred / ✕ 不适用**（**上一版：✕ 放弃**） | **"停更 2.5 月"与"是 fork"都是可失效的**：若它恢复活跃或上移增量（如 Petdex 导入变成我们的需求），可重评。**但"与办公室角色系统正交"这一条是结构性的** → 需产品形态变化才失效 |
| Live2D Cubism | 官方 SDK；仓库 license = **NOASSERTION**；三协议 + Release License 三层 | — | **◐ Deferred（暂缓生产接入）**（**上一版：✕ 当前阶段明确不做**） | `live2d-evaluation.md` §7.3 的 T1…T5 |
| Inochi2D | `inochi2d` **1,832★ / BSD-2-Clause** / pushed 2026-10-03；`inochi-creator` 1,261★ / pushed **2025-06-16** | 开源 puppet 绑骨 | **◐ 观察项**（许可干净，但 web 运行时生态薄弱、Creator 2025-06 停更） | 出现成熟的 web runtime + Creator 恢复更新 |

**这一节最重要的修正**：**`ysyyhhh/dsh-pet` 从"✕ 放弃"改判**。上一版的四条理由里，前三条（停更 2.5 月 / 是 fork / parent 无 LICENSE）**全是可随时间失效的工程事实**，第四条（与办公室角色系统正交）**是唯一结构性的**——而"正交"恰恰意味着**它不构成威胁，只构成"不需要"**。用"放弃"表述一个只因"我们暂时不需要"而不采用的项目，是过强的。

### 1.5 汇总计数（Deferred 框架）

| 结论 | 数量 | 项目 |
|---|---|---|
| **★ 采用** | **6** | 官方 `workspace-changes` / `fs-observation-policy` / `experimental-worktree` / 官方记忆栈 / 我方自研扩展 / 普通独立目录（T0 默认） |
| **◐ Deferred** | **10** | `dsh-mnemon`、`dsh-memory-evolve`、Obelisk、OpenViking、LayerFS、`dsh-layerfs`、WeKnora、`dsh-weknora`、`sundusk/dsh-pet`、`ysyyhhh/dsh-pet` |
| **◇ 设计参考** | **2** | `PC2005-cloud/dsh-pet`、Inochi2D（观察项） |
| **✕ 不适用（结构冲突）** | **1** | Live2D（当前阶段）——但**这是"暂缓生产接入"（Deferred），不是"永久拒绝"**，见 `live2d-evaluation.md` §7 |

**注意：6 个「采用」里 5 个是官方包、1 个是我们自己的代码。0 个第三方。** 这本身就是结论。
**但也要注意：10 个 Deferred 里，每一个都带独立的重评触发条件——没有任何一个被"删除技术研究记录"。**

---

## 2. 桌宠仓库辨析（三个同名/近名仓库必须分清）

**题面给了两个，但实际有三个**，且 DshCockpit 历史文档引用的**是第三个**。这是一次真实的名称混淆风险，必须写清。

### 2.1 三者对照

| 维度 | `PC2005-cloud/dsh-pet` | `sundusk/dsh-pet` | `ysyyhhh/dsh-pet` |
|---|---|---|---|
| stars | **5,117** | **0** | **1** |
| forks | 409 | 0 | 0 |
| 语言 | TypeScript | **Swift**（+ TS 桥接插件） | TypeScript |
| 许可证（仓库） | **MIT**（代码） | **MIT** | **MIT** |
| 许可证（素材） | **「允许开源使用，禁止商用」**（README 许可段原文） | 代码 MIT；素材随 App 附 `ThirdPartyNotices.txt`（**实测 26 行，只涵盖 FishLogo，不涵盖鲸鱼娘**） | 随 `assets/pets/`，**未单独声明素材许可** |
| 创建 | 2026-08-14 | 2026-08-14 | 2026-08-15 |
| 最近推送 | **2026-10-31T13:49:21Z** | **2026-10-28T08:12:10Z** | **2026-08-15T07:12:15Z** |
| 形态 | **DSH 插件**（浏览器 overlay + Electron 桌面双形态） | **macOS 14+ 原生 SwiftUI App**（`DSH Pet.app` v0.8.1）+ 桥接插件 `@sundusk/dsh-pet` v0.8.2（订阅 Agent 事件，提供 HTTP/状态 Socket） | **DSH Cordis 插件**（`@ysyyhhh/dsh-pet` v0.3.0），Web pet console + 多宠 overlay |
| 平台 | **DSH Web**（badge: "platform-DeepSeek Harness Web"） | **仅 macOS 14+**（README 明写） | DSH Web（有 Windows 安装示例 `D:/deepseek-pet`） |
| 素材路线 | **视频直用**：640×360 VP9-alpha WebM + 双 `<video>` 交叉淡入 + 程序化叠加（无骨骼无图集） | **Sprite 图集**：`JingyuniangSprites.png`（**2,884,925 bytes**，51 帧已用）| **Codex pet 包兼容**：`pet.json` + 8×9 或 8×11 sprite sheet；内置 **Petdex** 导入 |
| 鲸鱼娘素材 | **是**（「大肥鱼」社区二创，CC BY-NC-SA 4.0） | **是**（`Resources/Pet/Jingyuniang/JingyuniangSprites.png`；另内置「鲸鱼娘Q版」来自 Codex 同名宠物包） | 通过 Petdex 导入 |
| fork 关系 | 非 fork（原创） | 非 fork | **fork of `sereinmono/dsh-desktop-pet`**（parent 7★，**parent 无 LICENSE 字段**；`ysyyhhh` 的 LICENSE 写 `Copyright (c) 2026 sereinmono and dsh-pet contributors`） |
| 增量（相对另外两个） | 唯一有 **视频直用** 完整配方 + 291KB 提示词库 + 117 段动作 + 程序化叠加层（Q 弹/甩抛/镜像物理，纯函数 + 单测） | 唯一有 **原生 SwiftUI + 菜单栏 + 任务卡片 + 从桌面发消息**（浏览器最小化后仍可用）；有 `DSH_PET_COMMAND_PROTOCOL.md` | 唯一有 **Codex pet 包兼容 + Petdex 导入 + 多宠独立窗口** |

### 2.2 鲸鱼娘素材的授权真相（这条**限制**两个仓库的素材可用性，但不否决其代码/设计价值）

`PC2005-cloud/dsh-pet` README 许可段原文（2026-11-01 抓取）：

> - 代码：MIT
> - 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
> - **形象出处**：宠物形象为社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），**非 DeepSeek 官方形象**；原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 版（女仆鲸鱼娘）设计出自 B 站 [@ZipZipPipe](https://space.bilibili.com/4168597)
> - **形象授权**：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)（署名 · **非商业** · 相同方式共享），[声明原文](https://www.bilibili.com/opus/1247156596114456581)：「大肥鱼是遵守CC BY-NC-SA 4.0协议的形象，**不可以以任何形式商业化**。」

`sundusk/dsh-pet` 的 `Resources/ThirdPartyNotices.txt` 实测只有 **26 行**，内容仅涵盖：
- DeepSeek Harness FishLogo artwork（MIT，`Copyright (c) 2026 DeepSeek`）
- **`grep -icE "jingyuniang|鲸鱼|whale"` → 0 命中**

即：**sundusk 仓库里那份 2.8MB 的鲸鱼娘精灵图，没有任何素材授权声明。** 它在 README 里写的是「素材来源与许可随 App 一同附在 `ThirdPartyNotices.txt` 中」——**而该文件并不包含它**。这是**声明与实际不符**。

### 2.3 判定（Deferred 框架）

| 仓库 | 判定 | 理由 | **重评触发条件** |
|---|---|---|---|
| `PC2005-cloud/dsh-pet` | **◇ 设计参考（已采用其路线研究，不集成代码/素材）** | ① **视频直用路线**已被完整拆解并写入 `docs/archive/strategy/2026-09-27-dsh-pet-teardown.md`（8 条 TL;DR，逐条带文件证据）；② **素材 CC BY-NC-SA 4.0 + "不可以以任何形式商业化"** → 我们的 MIT 项目/未来商业化**绝不能打包它的素材**；③ **代码 MIT 可以借鉴**（但它用 PixiJS 6/7，与我们 8.5.2 不同代） | ① 素材换成可商用授权（约稿买断）后，其视频直用配方可直接落地；② 我们决定走 B 路线（视频直用）时，其配方是一等输入 |
| `sundusk/dsh-pet` | **◐ Deferred（平台不兼容 + 素材授权缺失）** | ① **仅 macOS 14+**，DshCockpit 要 win + mac 双平台；② **Swift 原生 App**，我们无法复用其 UI 代码（Electron/JS）；③ **鲸鱼娘素材授权缺失**（`ThirdPartyNotices.txt` 不含它）；④ 唯一可借鉴的是其仓内 `docs/DSH_PET_COMMAND_PROTOCOL.md`（状态 Socket / 用户命令 Socket 的协议形状） | ① 出现 Windows 版（或我们只需要 macOS 形态）；② **鲸鱼娘素材许可补齐**；③ 它的 `DSH_PET_COMMAND_PROTOCOL.md` 在"外部桌宠伴侣"方向成为需求 |
| `ysyyhhh/dsh-pet` | **◐ Deferred / ✕ 不适用** | ① **pushed 2026-08-15，已 2.5 个月未动**（**可失效**）；② **是 fork**，parent `sereinmono/dsh-desktop-pet` 7★ 且**无 LICENSE**（**可失效**：可改用上游或它补上许可链）；③ 功能（Codex pet 包兼容 + Petdex 导入 + 多宠 overlay）与我们的办公室角色系统**正交**（我们是场景内绑定式角色，它是桌面 overlay）（**结构性**）；④ 增量（Petdex 导入）对我们的用户**当前**无价值 | ①② 恢复活跃 / 补上许可链；③ **只有当我们决定做"桌面 overlay 形态的宠物"（与办公室形态并存）时，正交性才消失**——那是一个产品决策，不是工程决策 |

**为什么这一节要改判**：上一版把 `ysyyhhh/dsh-pet` 写进"判死清单（不留后路）"，但它的问题**全部是"当前不需要"或"当前不够好"**，没有一条是"永远不可能"。**用"判死"表述"当前不需要"，会让下一个人不敢重新提——而它恰恰可能在我们做桌面 overlay 时变成一等候选。**

### 2.4 可借鉴清单（只借设计，不借代码/素材）

| 来源 | 借鉴什么 | 落到哪 |
|---|---|---|
| `PC2005-cloud` | **素材学纪律**：「首尾帧=标准正面站立」「道具无→有→无闭环」「画幅 10% 安全边距」 | 我们的 `gen-*` 动作配方模板 |
| `PC2005-cloud` | **程序化叠加层**：Q 弹挤压（scaleY 0.55/220ms/overshoot）、镜像转向、位移由 `video.currentTime` 驱动、过阻尼弹簧拖拽 | 角色控制器「手感层」，与素材解耦 |
| `PC2005-cloud` | **六档工作状态映射 + 跨会话优先级聚合**（waiting 60 > error 50 > working 40 > thinking 30 > result 25 > success 20） | 办公室状态投影（**这个我们已有类似实现，需比对**） |
| `PC2005-cloud` | **收尾轮判定**：goal 中间轮完成→不庆祝，只有收尾轮 `complete→success` | 防「任务没完成却播成功」——与我们的「不伪造」铁律一致 |
| `sundusk` | **状态 Socket / 用户命令 Socket 分离**（`DSH_PET_COMMAND_PROTOCOL.md`） | 若将来做外部桌宠伴侣，这是协议形状参考 |
| `PC2005-cloud` | **归一化细节**：水平中心取非透明像素 x 的**中位数**（防道具拉偏 bbox）；全帧内容并集断言「任何帧任何部位不裁剪」；`check_alpha.py`（min<100/max>200） | 我们的 `normalize-character.py` + validate 链 |

**⚠️ 关键提醒**：我们**已经有** `docs/archive/strategy/2026-09-27-dsh-pet-teardown.md` 做了这件事（8 条 TL;DR + 逐节证据 + 本地 clone 副本）。本节的价值是**补上"三个仓库混淆"这个此前没写清的辨析**，以及**把素材授权风险显式化**。**不要重复调研视频直用路线。**

---

## 3. 知识库 / WeKnora 专项（先判断用户是否需要 RAG）

### 3.1 WeKnora 实测

| 项 | 值 |
|---|---|
| 仓库 | `Tencent/WeKnora` |
| stars / forks / open issues | **36,116 / 4,909 / 749** |
| 许可证 | GitHub API `spdx_id: NOASSERTION`；`LICENSE` 文件实际内容 = 「WeKnora is licensed under the **MIT** except for the third-party components listed below」+ 完整 MIT 文本 + 长串 Apache-2.0 等第三方清单 |
| 语言 / 版本 | Go；README badge **v0.9.0** |
| created / pushed | 2025-07-22 / **2026-10-30T13:53:32Z** |
| 部署形态 | **Docker Compose / Kubernetes**（「Deploy with Docker or Kubernetes」）；或腾讯云 Lighthouse 模板；或微信对话开放平台（托管）。**没有"npm 装一下就能用"的形态** |
| 能力 | 企业文档 RAG（hybrid 检索 + 多模态解析 + 引用）+ Agent（多步推理 + skills + **Docker/E2B/Cube 沙箱** + 浏览器 + MCP）+ Wiki（知识图谱 + 回滚）；29 家模型供应商；**多 workspace RBAC（四角色）+ 审计日志**；Feishu/Confluence/GitLab/Notion/语雀/钉钉等数据源同步 |
| DSH 集成 | `@wxg-prc-cpg/dsh-weknora@0.1.0`，**MIT**，npm 发布 **2026-08-21**，代码在 `packages/dsh-weknora`；需 `WEKNORA_BASE_URL` + `WEKNORA_API_KEY` + 可选 `WEKNORA_KNOWLEDGE_BASE_IDS` |
| 插件自述（关键句） | 「**dsh ships no retrieval, embedding or knowledge-base capability of its own** — its search tools (`grep`, `glob`) read the workspace, and `web_search` reads the internet. This plugin fills that gap with **your organization's documents**.」 |

### 3.2 DshCockpit 的目标用户**当前**真的需要 RAG 知识库吗？——**当前不需要**

先看目标用户的定义（`docs/product/WORK-FIRST-V0.7.md` §7 验收标准原文）：

> 「一个**新手**第一次使用时，**5 分钟内**拿到一份**真实可用**的产物」

再看当前缺口清单（`AGENTS.md` §7 原文）：「bind-attention 取消入口、blocked-turn steer 续跑、crash 受信来源、durable store」。**没有一条是"找不到资料"。**

三条独立理由：

1. **RAG 解决的是"组织文档太多找不到"**，而我们的用户是**个人开发者 / 小团队**，文档规模在几百到几千文件量级——`grep` + `glob` + 官方 `dsh-tool-fs-search` + `dsh-experimental-session-search` 已经够。RAG 的收益曲线在 10 万+ 文档才明显。
2. **部署成本直接杀死"5 分钟首跑"**：WeKnora 要 Docker Compose 起一整套（Go 服务 + 向量库 + 存储 + 模型供应商 key）。这不是"装个插件"，是"运维一个后端"。对首跑用户是**硬否决**。
3. **它的 Agent 部分与官方正面撞车**：WeKnora 的 Agent 有**自己的** skills / 沙箱 / 浏览器 / MCP / 记忆。把它接进来 = 在我们的 App 里跑**第二个 agent runtime**。这与「Harness owns execution」的铁律冲突（`AGENTS.md` §2.1：四层事实作者不得冒充）。

### 3.3 判定：**◐ Deferred**，并写死触发条件

> 当且仅当以下**任一**成立（**本版从"全部满足"放宽为"任一"，因为上一版"全部"等于永不重启**）：
> **(a)** 出现**明确的企业/团队用户**（不是个人）且有可复现的「文档检索不准/找不到」诉求；
> **(b)** 用户的文档规模 ≥ 10 万级，或文档类型包含大量 PDF/扫描件（`grep` 物理失效）；
> **(c)** 用户**自己已经有** WeKnora 实例（我们只做 client 插件，不做部署引导）；
> **(d)** 官方 DSH 到那时**仍无** workspace 级检索能力（目前官方明确"无 retrieval"，但 `dsh-session-query` 的 FTS5 路线可能扩展到 workspace 文档）。
>
> **附加约束（不变）**：**不得在我们这边写任何"一键部署 WeKnora"的引导。**

**若将来采用，正确形态**：只装 `@wxg-prc-cpg/dsh-weknora` 这个 **client 插件**（MIT，进程内，走 HTTP），**不打包 WeKnora 服务端**。这样许可证干净、体积为 0、用户自备后端。

---

## 4. 参考项目设计研究（只做设计研究，不做集成结论）

> 目的：看它们在 **Team / 长期任务 / 记忆 / 任务依赖 / 工作区隔离 / 人机协作** 上的设计取舍，为 DshCockpit 的 Capability Platform 提供借鉴。
> 纪律：**这些项目我们一个都不集成**。下面只写"值得学的设计"和"不要学的坑"。

### 4.1 核实结果（2026-11-01 实测）

| 项目 | 仓库 | 实测 | 许可证 |
|---|---|---|---|
| **Pi** | `earendil-works/pi` | **119,164★** / TypeScript / pushed **2026-10-31** / created 2025-08-09 | **MIT** |
| **Claw-Empire** | `GreenSheep01201/claw-empire` | **1,436★** / TypeScript / **pushed 2026-03-16（已 7.5 月停更）** / created 2026-02-18 | **Apache-2.0** |
| **OpenHands Agent Canvas** | `OpenHands/agent-canvas` | **233★** / **`license: null`（无 LICENSE 文件）** / **pushed 2026-07-27（已 3 月未动）** | **无法核实（无 LICENSE）** |
| **Retinue**（众卿） | `jklthinking/retinue` | **115★** / Python / pushed 2026-10-22 / created 2026-08-13 | **AGPL-3.0** |
| 腾讯 WorkBuddy | 闭源商业产品（`codebuddy.cn`） | 无法核实源码 | 商业 |
| Kimi Code | `MoonshotAI/kimi-code`（文档站 `moonshotai.github.io/kimi-code`） | 仅核实文档（自定义 sub-agent、`wire.jsonl`、`tasks/` 生命周期状态） | **无法核实** |
| Codex | 闭源（OpenAI） | — | 商业 |
| Claude Code | 闭源（Anthropic） | 已知：subagent + skill + MCP + hook | 商业 |

**注**：题面提到的 `badlogic/pi-mono` 已重定向到 `earendil-works/pi`（GitHub API 自动跟随）。题面的 `ClawEmpire/Claw-Empire`、`All-Hands-AI/openhands-canvas`、`Retinue/retinue` 三个原始 URL **均 404**，正确仓库见上表——**这是本次核实纠正的三处引用错误**。

**关于 Retinue 的 AGPL**：它是**只做设计研究、不集成**，所以 AGPL 不构成阻塞（我们连一行都不取）。上一版把它写在"不要学：AGPL-3.0（同 Obelisk/OpenViking 的问题，不可打包）"里——**这个类比不准确**：Obelisk/OpenViking 是我们**考虑集成**的候选，Retinue 从一开始就只做设计研究。**不集成的东西不需要许可证干净。**

### 4.2 逐个：值得学的 + 不要学的

#### Pi（MIT，119k★）——「最小 harness + 一切皆扩展」

**值得学**：
- **明确的"不做"清单**：README 原文「Pi ships with powerful defaults but **skips features like sub-agents and plan mode**. Ask Pi to build what you want, or install a package that does it your way.」——**主动放弃内置复杂能力，交给扩展**。这是 DshCockpit「Harness-first，不自研通用 Harness」的同构判断。
- **包分层清晰**：`@earendil-works/chord`（typed host runtime + hot-reload 插件 + replicated state + JSON RPC）/ `pi-durable`（durable conversation, task, document runtime）/ `pi-agent-core` / `pi-ai`（统一多 provider LLM API）/ `pi-coding-agent` / `pi-tui`。**`durable` 单独成包**这一点值得注意：它把"长期任务的状态持久"当成独立基础设施。
- **权限模型的诚实**：README 原文「Pi **does not include a built-in permission system** for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.」+ 给出三种容器化方案（Gondolin micro-VM / plain Docker / OpenShell）。**承认边界而不是假装安全**。

**不要学**：无内置权限系统对桌面 App 不可接受（我们已有 sandbox 层）。

**对 DshCockpit 的启示**：**`durable` 与 `agent-core` 分离**是我们该有的形态——我们的 `src/team/runtime/**`（纯 Node 零 fs）与 `src/work/workspace-store.js`（有 fs）已经是这个分离，需保持。

#### Claw-Empire（Apache-2.0，1,436★，**已停更 7.5 月**）——「虚拟公司 + 像素办公室」

**值得学**：
- **Kanban 六态生命周期**：`Inbox → Planned → Collaborating → In Progress → Review → Done`。注意中间有 **Collaborating**（协作中）——这是"多个 agent 正在协同"的显式状态，我们的 Team Runtime 目前只有 `phase`，**缺一个"协作中"的一等状态**。值得借鉴。
- **Worktree 隔离 + 只在 CEO（人）批准时合并**：「Each agent works in isolated git branches, **merged only on CEO approval**」。**人掌舵的具体机制**——合并是一个需要人类批准的动作。这与 `WORK-FIRST-V0.7.md` §2.1「人负责目标、边界、验收」一致，且给出了**可执行的落地点**。
- **Workflow Pack Profiles**：6 个内置 workflow pack（`development` / `report` / `web_research_report` / `novel` / `video_preprod` / `roleplay`），每个 pack 有自己的 **routing schema、QA 规则、输出模板**。这是 **Starter Kit** 的具体形态——比"抽象 Provider 接口"更有价值。
- **Stale `working` 自动恢复**：「lifecycle startup and interval sweeps now reset agents that are still marked `working` without a live `in_progress` task」。**这正是我们 `AGENTS.md` §7 缺口里的「crash 受信来源」**——它用的是"startup + 周期 sweep + 检查是否有 live task"三件套。

**不要学**：**Agent XP / 等级 / 排行榜 / 会议系统**（游戏化过头，与"工作产物一等公民"冲突）；**600+ skills 库**（堆量，我们不要）。

**对 DshCockpit 的启示**：**「协作中」状态 + 「合并需人批准」+ 「stale 恢复 sweep」三件套**是我们可以立刻借鉴的、成本极低的三个机制。特别是 stale 恢复——它对应我们已列出的真实缺口。

**注**：它停更 7.5 月，但**设计研究价值不受影响**（我们读的是设计，不是代码）。**不要因为它停更就不用它的设计。**

#### OpenHands Agent Canvas（**无 LICENSE**，233★，已 3 月未动）——「always-on 工程团队」

**值得学**：
- **"从聊天升级为自动化"的产品叙事**：「turns your coding agents into a self-hosted, **always-on** engineering team … like **generating reports that publish to Slack** or **automatically decomposing GitHub issues into tasks**」。**触发式（trigger-based）任务**：不是用户说话，而是事件（新 issue / 定时）驱动。这是 DshCockpit 目前完全没有的形态（我们只有用户输入 → 任务）。
- **本地 → 云的路径**：「Start locally, connect your tools, and automate workflows」→「OpenHands Cloud / Enterprise give you the path to **always-on execution**」。本地优先但给出升级路径。

**不要学**：**无 LICENSE 文件** → 法律上默认"保留所有权利"，**不可参考代码，只能参考概念**。且已 3 月未动。

**对 DshCockpit 的启示**：**事件触发任务**是值得记入 roadmap 的一个能力位（但当前不做——我们连手动任务闭环都还没验收完）。

#### Retinue（AGPL-3.0，115★）——「人和 AI 共用的任务板」

**值得学**：
- **核心洞察**：「a self-hosted, local-first task board and orchestration hub where **a mixed team of people and AI agents work the same cards**」。**人和 agent 是同一张卡片上的协作者**——不是"人下命令 agent 执行"，而是"人和 agent 都被分配卡片"。
- **per-task graphs / device/model timelines / progress receipts / source-aware usage**：README 描述的四件：每个任务一张图（依赖关系）、设备/模型时间线、进度回执、按来源计费。
  - **progress receipts**（进度回执）——这个概念值得直接借：agent 完成一步要**产出可验证的回执**，不是自己说"做完了"。与我们「不伪造」铁律一致。
  - **source-aware usage**（按来源计费）——我们有 `cost.js` / `token-stats.js`，但没做到"按 agent/任务归属"。

**不要学**：无（我们只借鉴概念，不取代码）。**注意：AGPL 在这里不构成阻塞**——我们是"读它的设计"，不是"打包它的代码"。**上一版把它写成"不要学：AGPL-3.0（同 Obelisk/OpenViking 的问题，不可打包）"，这个类比不成立**：Obelisk/OpenViking 是被**考虑集成**的对象，Retinue 从来不是。

**对 DshCockpit 的启示**：**「progress receipts」应该成为我们 Artifact/Evidence 模型的一等概念**。当前 `WORK-FIRST-V0.7.md` §3.3 的 Verification 是"跑命令拿退出码"，**回执**更进一步：每一步都留可审计的凭据。

#### 腾讯 WorkBuddy（闭源商业）——「本地 AI 工作台」

**已核实的事实**（来自公开报道/官方文档，非源码）：
- 定位：「腾讯出品的**全场景 AI 办公工作台**，覆盖日常办公、代码开发与设计创意。用户以**自然语言下达任务**」
- 有「**新建任务栏**（本地 AI 工作台）」：支持任务创建、任务配置、多种输入方式、**连接器**（第三方应用接入，自然语言调用）
- 整合腾讯文档/ima/设计，**统一账号、统一积分池、统一数据池**，产出**多模态内容**（文档/设计/图片），「再由**团队共同修改、验收和沉淀**」

**值得学**：
- **「统一积分池」**：把多模型的成本抽象成用户可理解的单一额度。我们的 `balance.js` / `cost.js` / `token-stats.js` 目前是**技术指标**（token 数、费用），不是**用户可预期的额度**。这是一个产品级洞察。
- **「连接器」的抽象**：第三方应用接入后"用自然语言调用对应服务"——**连接器 = 我们说的 Capability Provider 的用户语言版本**。命名上「连接器」比「Provider」对用户更友好。

**不要学**：闭源无法核实实现；「全场景」的广度对一个开源项目是陷阱。

#### Kimi Code（闭源，仅文档）——「sub-agent 目录 + wire.jsonl」

**已核实的事实**（官方文档站）：
- 自定义 sub-agent 用 **Agent File Format**（Markdown + frontmatter），主 agent 定制可引用 `${base_prompt}`
- **每个 sub-agent 实例有自己的目录**，内含 `wire.jsonl` **按时间序记录 prompts / 消息历史 / 最终状态**
- **后台 sub-agent 通过 `tasks/` 子目录暴露生命周期状态**

**值得学**：
- **`wire.jsonl` per-agent 的落盘形态**：每个 agent 一个 append-only 日志文件，人可直接读。**这比数据库更容易调试、更容易被 agent 自己读**。我们的 `dsh-session-persistence-jsonl` 是同一路线（官方选择正确）。
- **`tasks/` 目录暴露生命周期**：文件系统即 API。我们的 `.dsh/runs/<runRef>/` 同构。

**不要学**：无（信息不足）。

#### Codex / Claude Code（闭源）

**已知的公开事实**（无需调研，属于常识层，仅记录对设计的启示）：
- 都是**单 agent + subagent** 模型，**没有持久 Team**。
- Claude Code 的 subagent 是**一次性**的（task 完成即销毁），**没有 roster、没有 inbox、没有共享任务板**。
- 这反证了一件事：**官方 DSH 的 Agent Teams（roster + inbox + durable task board + CAS revision + writeScopes）在开源/商业产品里都是领先形态**。→ **这直接支持"DshCockpit 不要自研第二套 Team Runtime"的结论**（见 §1.1 与 `memory-systems.md`）。

### 4.3 横向对比表（六维度）

| 维度 | Pi | Claw-Empire | Agent Canvas | Retinue | WorkBuddy | Kimi Code | **官方 DSH 0.2.1** |
|---|---|---|---|---|---|---|---|
| **Team** | 不做（用户自己扩展） | 部门 + 团队负责人 + 会议 | always-on 团队 | 人机同板 | 团队协作 | sub-agent（一次性） | **roster + inbox + durable task board + CAS + writeScopes + interrupt** |
| **长期任务** | `pi-durable` 独立包 | Kanban 六态 | 自动化 workflow | per-task graph | 任务栏 + 连接器 | `tasks/` 状态 | **`dsh-goal`（phase + round cap + 跨重启）** |
| **记忆** | 不做 | 无（靠 AGENTS.md） | — | — | 有（跨任务沉淀） | 会话历史 | **无 memory 包**（原材料：agent-instructions + compaction + session-query） |
| **任务依赖** | — | Kanban + 会议商讨 | workflow 编排 | **per-task graph（显式）** | — | — | **task DAG + `blocked_by`** |
| **工作区隔离** | 容器化（用户自选 3 种） | **git worktree + 人批准合并** | — | — | 本地文件 | 每 sub-agent 独立目录 | **worktree 包（默认关）+ workspace-changes（捕获）**；**不做并发协调** |
| **人机协作** | 权限靠容器 | CEO 桌 + 会议 + 批准合并 | 本地→云 | **同一张卡片** | 自然语言任务栏 | — | **user-approval + user-questions + approval 回传** |

**读表结论**：
1. **官方 DSH 0.2.1 在 Team / 长期任务 / 任务依赖 / 人机协作四个维度上，已经是这张表里最完整的。** 这不是恭维，是逐格比对。
2. **唯一官方明确空白的格子是「记忆」**——但空白的是"治理层"，不是"存储层"（见 `memory-systems.md` §3）。
3. **唯一"别人有、官方没有、且我们也确实缺"的格子是 Claw-Empire 的「合并需人批准」+「stale 恢复 sweep」**——这两个成本极低，建议直接吸收进我们的 Team Runtime 设计。

---

## 5. Deferred / Re-evaluation 清单（替代上一版的"判死清单"）

> **框架说明（本版核心变化）**：
> 上一版这里是「**判死清单（明确拒绝，不留后路）**」，并写「判死的意思不是"暂不考虑"，是"下一阶段不得再有提案"。若有人要重启，必须先推翻本文的实测数据」。
>
> **本版改为**：每一项都写「**现状判定 | 风险 | 集成边界 | Re-evaluation 触发条件 | 证据**」。**判定的对象是"当前阶段不集成"，不是"这个项目永远不行"。**

### 5.1 逐项（每项五行，五行齐全）

#### D1. Obelisk

| 维度 | 内容 |
|---|---|
| **现状判定** | **Deferred**。硬事实一条：**AGPL-3.0-only**（GitHub API `spdx_id: AGPL-3.0`；README 与 `packages/dsh-plugin/package.json` 均写 `AGPL-3.0-only`），不能作为依赖被 MIT 的 DshCockpit 打包分发。 |
| **风险** | ① **分发即传染**（AGPL §5/§13）；② 网络条款在我们走向 remote/云端时触发（`public-remote.js` 已存在）；③ **上游许可证不稳定**（2026-06-14 从 MIT 单方改为 AGPL）；④ 能力完全被官方 `dsh-session-query-sqlite` 覆盖；⑤ 它的 Electron App 与我们的产品面撞车。 |
| **集成边界（如果将来要做）** | ✅ **B1 用户自装 CLI + 我们只读它生成的 SQLite**（数据不是代码）；✅ **B2 可选插件 + 进程外调用**（命令行接口 = 公认安全边界，我们自身仍 MIT）；❌ **B3 打包进安装包 / 作为 npm dependency**（唯一永不变的红线）；⚠️ **B4 官方商业授权**（**无法核实**：README 全文无 commercial/dual 字样）；❌ **B5 fork 其代码**（除非我们也 AGPL）。 |
| **Re-evaluation 触发条件** | **O-T1** 官方检索长期无法满足多 provider 统一检索（**需先改 ADR-0001「不做多 Runtime」**）；**O-T2** 决定做 B1/B2 且有 ≥3 用户明确诉求；**O-T3** 上游公开 dual-license 或回退宽松许可；**O-T4** 我们自己的 `package.json` 改为 AGPL（当前无计划）。 |
| **证据** | 变更提交 `b071cf723221`（2026-06-14「chore: switch license from MIT to AGPL-3.0」）；LICENSE https://github.com/tommy0103/obelisk/blob/main/LICENSE ；`packages/dsh-plugin/package.json`（`AGPL-3.0-only` + `private: true`）；`@obelisk-apps/cli@0.3.1`（`license: AGPL-3.0`）；README 全文 grep 无 commercial 字样（**无法核实商业授权**）。详见 `memory-systems.md` §4.1。 |

#### D2. OpenViking

| 维度 | 内容 |
|---|---|
| **现状判定** | **Deferred（组件级分层）**。**不是"整仓 AGPL"**：主项目 AGPLv3；**`examples/`（含 `examples/dsh-memory-plugin`）与 `crates/ov_cli` 是 Apache-2.0**；`examples/hermes-plugin` 是 **MIT**；`sdk/typescript` / `npm/cli` 声明 **Apache-2.0**；`sdk/python` / `sdk/go` / `web-studio` **无许可证声明（无法核实）**。 |
| **风险** | ① **要求用户运维 Python server + embedding/VLM**，与"首跑 5 分钟"直接冲突；② **能力位错配**（L0/L1/L2 是 G4/G5 高级形态，我们连基础 G4 都没有）；③ 主项目 AGPL 不可打包（可绕）；④ **宽松组件在 npm tarball 里不带 LICENSE/NOTICE**（分发合规缺陷，我们打包须自补）；⑤ 部分组件许可证无法核实；⑥ README 附加合同限制（禁止整体重写后重开源、翻译需授权——对我们无影响）。 |
| **集成边界（如果将来要做）** | ✅ **V-B1 用户自装 server + 我们只做 HTTP 客户端**（**这是当前就该记下的正确形态**）；✅ **V-B2 打包 `@openviking/dsh-memory-plugin`**（Apache-2.0，须补 LICENSE+NOTICE）；✅ **V-B3 打包 `examples/` 其他插件**（同上）；❌ **V-B4 打包 Python 服务端**（AGPL）；⚠️ **V-B5 `sdk/python` / `sdk/go` / `web-studio`**（无声明，不可依赖）；❌ **V-B6 LangChain/LangGraph 适配器**（AGPL）。 |
| **Re-evaluation 触发条件** | **V-T1** 要服务"已有本地 OpenViking server 的高级用户"（≥3 人可复现）；**V-T2** 我们的 G4 已建好且证明纯 FTS 不够（到要高级形态的时候）；**V-T3** 上游补齐 `sdk/python`/`sdk/go`/`web-studio` 许可声明 + npm 分发补 LICENSE；**V-T4** 上游提供"单文件 / 零依赖 / 内嵌模型"的本地模式。 |
| **证据** | `examples/LICENSE`（Apache-2.0 全文）；`crates/LICENSE`（Apache-2.0）；`examples/hermes-plugin/LICENSE`（MIT）；`sdk/typescript/package.json`（`"license": "Apache-2.0"`）；`npm/cli/package.json`（Apache-2.0）；`pyproject.toml`（`license = "AGPL-3.0"`）；根 README License 段逐组件声明；变更提交 `ce998873f94d`（2026-03-30）。详见 `memory-systems.md` §4.2（含完整组件级矩阵）。 |

#### D3. dsh-memory-evolve

| 维度 | 内容 |
|---|---|
| **现状判定** | **Deferred**。**MIT 已三重核实**（GitHub API `spdx_id: MIT` + LICENSE 原文 `Copyright (c) 2026 dsh-external` 1069B + `package.json` `"license": "MIT"`）。`private: true` + npm 404 属实，但**"未发布"≠"质量差"**。 |
| **风险** | ① **功能面 60% 与官方 Agent Teams 正面重复**（COI 调度 = 组队+派活+广播+写冲突警告）；② 会话搜索与官方重复；③ **单维护者 + 未发 npm + 只能 git 装** → 无法固定版本/审计/CI 复现（**可控性问题，非质量**）；④ **多写入者污染 `AGENTS.md` 语义链**（**结构性，且这是"一切第三方记忆插件"共有的问题，非它独有**）；⑤ 注入类故障面（CHANGELOG 有 issue #68 实证，已修复）。 |
| **集成边界（如果将来要做）** | ❌ **M-B1 完整装它**（会引入第二套 Team 运行时 + 第二套记忆写入通道）；✅ **M-B2 只借鉴「五轨记忆」分层设计**（现在就可以）；⚠️ **M-B3 只取技能自我进化子模块**（需先确认与 `dsh-skill`/`dsh-plugin-manager` 的边界）；❌ **M-B4 COI 调度**；⚠️ **M-B5 fork + 裁剪（MIT 允许）** —— 去掉 COI 与会话搜索的裁剪版是**合规且可能更划算**的路径（**上一版完全没提这个选项**）。 |
| **Re-evaluation 触发条件** | **M-T1** G4 设计定稿后发现「五轨」某轨（尤其 git-branch 轨）我们没设计到；**M-T2** 决定做技能自我进化且官方不覆盖；**M-T3** 官方 Agent Teams 长期（≥2 minor）不满足硬需求，COI 恰有（**需与 ADR-0002 一起评估**）；**M-T4** 作者发布 npm；**M-T5** 决定走 M-B5 fork。 |
| **证据** | LICENSE https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/LICENSE （MIT，1069B，`sha a2078e705ad7`）；GitHub API `license.spdx_id = "MIT"`；`package.json`（`"license": "MIT"`, `"private": true`, `0.1.0`）；npm 404；`tests/` 72 个测试文件；CHANGELOG https://raw.githubusercontent.com/csyangwen/dsh-memory-evolve/main/docs/CHANGELOG.md 。详见 `memory-systems.md` §4.3。 |

#### D4. LayerFS

| 维度 | 内容 |
|---|---|
| **现状判定** | **Deferred**。**MIT 已核实**（GitHub API `spdx_id: MIT`；LICENSE `Copyright (c) 2026 Ephemeral-AI`）。**版本状态分段**：0.1.1–0.1.7 全线官方自称 **Developer Preview**（0.1.6 手册：「for **local evaluation and development**」）；**v1.0.0（2026-10-21）首个正式版**；**v1.1.0（2026-10-24）在"所有者豁免"下发布，官方自述「breaks 1.0.0 JavaScript SDK code without a new major version」**。 |
| **风险** | ① **无崩溃/断电持久性**（官方 README 逐字「The Store runs in its **Disposable profile only, with no crash or power-loss durability**」）；② **平台门槛**：Linux 原生需 `/dev/fuse` + 可写 Docker volumes；macOS 需 **Docker Desktop + 密封 bundle + 自建 runtime image**；Windows 需 **WSL2 + 独立 Linux Docker Engine**；③ **npm 三包全 404**，只能源码 cargo build；④ **`dsh-layerfs` 插件仓库无 LICENSE 文件**（`license: null`，视为未声明）；⑤ **dsh desktop 未测**（原文「Only dsh web is supported. dsh desktop … was not tested.」）；⑥ **FUSE 有意省略 FIFO/socket/device node/set-id bits/独立 atime-ctime**；⑦ 顺序写 0.31×/顺序读 0.81×/随机写 0.40×（慢）；⑧ 与「Workspace = 用户选定真实目录」定位冲突；⑨ 另一套版本控制语义与 git 并存。 |
| **集成边界（如果将来要做）** | ✅ **LF-B1 用户自装 LayerFS + 用户自装 `dsh-layerfs`**（合规但当前不做；**插件无 LICENSE，打包前须先取得声明**）；⚠️ **LF-B2 我们打包 daemon/二进制**（当前不可行：无预编译产物）；✅ **LF-B3 我们实现 L3 分配器**（**现在就该做**，不引入 LayerFS）；❌ **LF-B4 把用户工作区迁进 Store**；⚠️ **LF-B5 只用 LayerFS 承载"可丢弃的并行实验"，真实目录仍是主副本**（**上一版没提的折中，能绕开持久性缺陷**）。 |
| **Re-evaluation 触发条件** | **A 组（发布与平台，任一）**：**LF-T1** 发布 npm 预编译产物（macOS arm64 + Windows）；**LF-T2** `dsh-layerfs` 提供 dsh desktop 实测 + 补 LICENSE。**B 组（数据安全）**：**LF-T3** 提供崩溃/断电持久性或"承载唯一副本"的合规配置。**C 组（需求侧，任一）**：**LF-T4** ≥3 用户投诉 worktree 重装依赖等待；**LF-T5** 用户画像变成大型仓库 + 高并发团队。**组合规则**：A 任一 + C 任一 → 启动 POC（优先 LF-B5）；只有 B → 仍需 A 或 C；只有 C → **不做 LayerFS，做 LF-B3**。 |
| **证据** | README Status 段（Disposable profile）；README Prior art 段末（「Use something else if you need crash or power-loss durability … full POSIX node types」）；`docs/general/release-policy.md`（1.1.0 owner-waived exception；「silence is not a promise」）；`docs/versioned/0.1.7/README.md`（source-only，无 npm/无预编译）；`docs/versioned/0.1.6/limitations.md`（Developer Preview + 持久性 + mmap + 无 GC）；GitHub Releases（v1.0.0「first official release」/ v1.1.0）；npm 三包 404。详见 `workspace-isolation.md` §2.3。 |

#### D5. Live2D（**当前阶段：暂缓生产接入**）

| 维度 | 内容 |
|---|---|
| **现状判定** | **Deferred（暂缓生产接入）**。**不是永久拒绝。** 三条支撑理由全部**可被独立推翻**：① 素材成本（现有资产是成品帧图，无分层源文件）；② 许可成本（按文义高概率为 Expandable，需书面定性；免费形态原则上不利但有官方脚注例外）；③ 技术依赖（v8 生态最优候选仅 81★ 且要求 pixi 8.13.1+，我们是 8.5.2）。 |
| **风险** | **R1** 被判 Expandable 且未获批 → 违约（§6.3）+ **Live2D 有权解除**（§8.1.1）+ **解除后**销毁（§8.4）+ 并存赔偿（§12/§8.3）；**R2** 未签 Publication License 即发布；**R3** 把 Cubism Core **以 MIT 名义**发布/修改（硬红线：§5.3.2 / Open §5.6）；**R4** 鲸鱼娘社区素材 CC BY-NC-SA 4.0「不可商业化」；**R5** Editor 授权；**R6** sample 素材仅限内部评估/培训；**R7** 商标误认；**R8** 签约后被 Live2D 公开为案例；**R9** 协议单方变更（不可锁定）；**R10** 判定权单方归属（§1.5/§1.6「sole discretion」）。 |
| **集成边界（如果将来要做）** | **P-0 书面定性**（**新增，所有路径的前置**）；**P-1 用户自装渲染器**（我们只留注册点，不含任何 Live2D 内容；**确定合规**）；**P-2 官方签约出版**（含 Redistributable Code 须逐条满足 §5.2.1–5.2.4）；**P-3 换 Inochi2D（BSD-2）**。**"明确不做"（与许可无关的红线）**：以 MIT 名义分发 Cubism 代码 / 用社区鲸鱼娘素材 / 用 sample 素材 / 修改或反向工程 Core / 未定性前宣称"支持 Live2D"。**从"永远不做"改为"暂缓"**：在仓库放 `.moc3` / 安装包放 Redistributable Code —— 走通 P-0 + P-2 后**按 §5.2 条件可以**。 |
| **Re-evaluation 触发条件** | **T1**（许可侧）Live2D 书面答复我们**不构成** Expandable，或书面确认免费/开源形态可获批；**T2**（资产侧）角色美术进入约稿买断且合同含「分层源文件 + Live2D 演绎权 + 制作方自备合法 Editor」；**T3**（产品侧）A 路线（帧+程序化）与 B 路线（视频直用）都证明到顶，且 Inochi2D 经 POC 被否决；**T4**（生态侧）出现 ≥500★、peer `pixi.js ^8.5`、近 6 个月有提交、MIT/Apache-2.0 的 v8 渲染器；**T5**（商业侧）出现可支撑签约的真实收入模型。 |
| **证据** | Proprietary v2.1 §1.5/§1.6/§2.1/§2.2/§4.2/§5/§5.3.2/§6.2/§6.3/**§8.1/§8.4**/§8.3/§12/§16/§17；Open v1.4 §2.3/§5.6/**§7.1/§7.4**；**SDK Release License 页「License only required upon releasing your content. Not during trial or development.」**；Expandable 专页（含**免费获批例外脚注**）；VTuber 授权页（年销 2000 万日元门槛）；`CubismWebSamples/LICENSE.md`（三段许可 + 8 个免费模型）。详见 `live2d-evaluation.md` §1（含 C1–C21 条款清单）。 |

### 5.2 **"我们之前哪几句话是不准确的"**（本版直接承认）

| # | 上一版原话 | 为什么不准确 | 本版修正 |
|---|---|---|---|
| **1** | 「OpenViking：主仓 AGPL-3.0…**self-host 或用它的 SDK 都进 AGPL 域**」 | **事实错误**。它是多许可证组件化项目：`examples/`（含 DSH 插件）与 `crates/ov_cli` 是 **Apache-2.0**，`examples/hermes-plugin` 是 **MIT**，`sdk/typescript` 声明 **Apache-2.0**。用它的 SDK **不必然**进 AGPL 域 | 组件级许可证矩阵（`memory-systems.md` §4.2.3） |
| **2** | 「OpenViking：npm 插件声称 Apache-2.0 但 tarball 无 LICENSE → **按最严判 AGPL**」 | **推理过强**。该组件位于 `examples/`，**目录级 `examples/LICENSE` 是 Apache-2.0 全文**。tarball 缺 LICENSE 是**分发合规缺陷**（我们打包须自补），**不改变许可归属** | 改为"Apache-2.0，需自补 LICENSE/NOTICE" |
| **3** | 「**Live2D 最危险的单一陷阱**：…未获批就发布 = 违约，**Live2D 有权要求销毁全部派生作品**」 | **混淆了两个法律环节**。§8.4 的销毁义务前提是「**If this Agreement is terminated pursuant to Section 8.1**」——即 Live2D **先行使解除权**，**才**产生销毁义务。未获审批出版是**违约事实**，它构成解除的**理由**，并直接产生**赔偿责任（§12）+ 禁令风险（§4.2）**，但**不自带销毁义务** | 两条责任链分开写（`live2d-evaluation.md` §1.6）：链路一「违约 → 可解除 → 解除后销毁」；链路二「违约 → 赔偿/禁令」 |
| **4** | 「Expandable 专页审查条件：**免费项目原则上不给批**」 | **漏了紧接的一行原文**：「**Approval may be granted to fully free-of-charge Expandable Applications in some cases if separately specified conditions are met.**」→ 「as a general rule」是**一般规则**，不是绝对排除 | 补记该脚注，改为"免费形态显著降低获批概率，但协议未封死" |
| **5** | 「**绝不 bundle** Cubism Core；若必须用，走 §5.2.4 原样 + §5.2.1…」 | **自相矛盾**。Proprietary **§5.1/§5.2 正是"允许再分发"的正面授权**，§6.2 的禁止也带「**Except as expressly permitted in this Agreement**」限定。准确事实是：**Redistributable Code 可以随派生作品分发，前提是满足 §5.2.1–5.2.4**；不能做的是**以 MIT 名义**分发或修改它 | 改为"能分发，但有条件；不能当作 MIT 开源件" |
| **6** | 「Obelisk / OpenViking / dsh-memory-evolve = **判死（放弃、硬拒绝）**，`判死的意思不是"暂不考虑"，是"下一阶段不得再有提案"`」 | **框架过强**。把"当前阶段不采用"写成"永久否决"，并把**可失效的工程理由**（未发 npm / 平台门槛 / 维护活跃度）当成判决。用户明确要求用 **Deferred / Re-evaluation** | 全部改为 ◐ Deferred + 独立重评触发条件（§5.1） |
| **7** | 「dsh-memory-evolve：`private: true` + 未发 npm → **放弃（维护风险）**」 | **"未发布"被当成"质量差"**。而且它的 CHANGELOG 是本轮候选里工程记录质量最高的（逐条根因 + 法证数据 + 「已验证还原修复后测试必失败」），两次上游破坏性变更都在 1 个月内适配。**真正的风险是"只有一个人修"** | 改为"未发布 = 可控性问题，非质量问题"；风险重述为 M-R1…M-R5 |
| **8** | 「LayerFS：暂缓。**准确含义是：不是"等它改好了就用"，而是"除非我们的用户画像变了，否则不启动"**」 | **过强**。"发布预编译产物"这一条**单独成立**就足以让我们重新评估，不需要用户画像变化。而且上一版把它写进"§3 为什么不要把 LayerFS 作为首选"，语气是**否定**而非**暂缓** | 改为 A/B/C 三组独立触发条件（`workspace-isolation.md` §2.3.7），任一成立即可重评 |
| **9** | 「LayerFS **暂缓**」（未区分版本状态） | **不够精确**。0.1.x 才是 Developer Preview，1.0.0 起官方自称正式版，1.1.0 带"所有者豁免"。简单说"暂缓"或简单说"Developer Preview"都不准确 | 分段写清（`workspace-isolation.md` §2.3.1 事实 2） |
| **10** | 「ysyyhhh/dsh-pet：**✕ 放弃**」（列在"判死清单"里） | 它的四条理由里**前三条全是可随时间失效的工程事实**（停更 / 是 fork / parent 无 LICENSE），第四条（与办公室角色正交）意味着"不需要"而**不是"不可能"** | 改为 **◐ Deferred / ✕ 不适用** + 重评条件 |
| **11** | 「Retinue：**不要学：AGPL-3.0（同 Obelisk/OpenViking 的问题，不可打包）**」 | **类比不成立**。Obelisk/OpenViking 是我们**考虑集成**的候选，Retinue 从一开始就只做**设计研究**。**不集成的东西不需要许可证干净** | 改为"无不要学的点；AGPL 在纯设计研究下不构成阻塞" |
| **12** | 「Live2D：**✕ 当前阶段明确不做**，不是"暂缓"，是"当前阶段明确不做"」 | 与用户要求的 Deferred 框架冲突；且"明确不做"掩盖了三条理由都可被推翻的事实 | 改为 **◐ Deferred（暂缓生产接入）** + T1…T5 触发条件 |

---

## 6. 下一阶段建议动作（按 ROI 排序，全部不接第三方）

| # | 动作 | 成本 | 收益 | 依赖 |
|---|---|---|---|---|
| **A1** | **0.2.x 迁移**（从 0.1.5-rc.2 → 0.2.1-rc.5+），拿到 `workspace-changes` / `session-search` / `tool-session-query` / `plugin-manager` / `plugin-market` / `agent-team` | 大（task-1 在评估） | **一步解锁 5 个官方能力**，是所有后续动作的前置 | 无 |
| **A2** | **打开官方 session 检索**：当前 web profile 是 `session-query-sqlite.openAt: never`；改成 `first-search` 或 `startup` + 给出 UI 入口 | 小 | 直接替代我方 `session-search.js` 的弱实现 | A1 |
| **A3** | **扩展 `memory-files.js`**：从 2 个 `AGENTS.md` 扩到多 scope（项目/用户/`AGENTS.local.md` overlay），加版本与 diff | 中 | 建立 G4 的基础（写入治理），**不引入任何第三方** | 无 |
| **A4** | **把 `dsh-goal` 接成 Mission 持久层**（`WorkItem.goal` → `dsh-goal`，plan/boundaries 留在我们侧） | 中 | 跨轮/跨重启目标存活，官方已实现，我们只做映射 | A1 |
| **A5** | **吸收 Claw-Empire 三件套**：① Kanban 加「协作中」状态；② 合并需人批准（人掌舵的落地点）；③ stale `working` 恢复 sweep（对应我们已列缺口） | 小-中 | 三个都是低成本高价值 | 无 |
| **A6** | **预留角色渲染后端接口**（Sprite / Video / Parametric 位），**不实现** | 极小 | 将来换 Inochi2D 不用改架构 | 无 |
| **A7（新增）** | **对 Live2D 走 P-0：向官方咨询形态定性**（拿到书面答复或"无答复"记录） | 极小（一封咨询） | **把 Live2D 的 Deferred 从"凭我们自己的解释"变成"有官方依据"**——这是最低成本的去风险动作 | 无 |
| **A8（新增）** | **T1 层的 L3 分配器（LF-B3）**：只做 allocation + 展示 + 清理，不做文件系统 | 小-中 | 这是官方 L3 空缺里我们真正拥有的那部分，且不引入 LayerFS | A1 |

**明确不做（本轮）**：任何第三方记忆 Provider 的**完整集成**、LayerFS 打包、WeKnora 服务端、Live2D 生产代码、dsh-pet 集成。
**注意措辞**：是"本轮不做完整集成"，不是"这些项目被否决"——见 §5.1 各自的重评条件。

---

## 7. 待验证 / 无法核实清单（诚实边界）

| 项 | 状态 | 原因 |
|---|---|---|
| 各仓库 issue 响应质量 / 关闭率 | **无法核实** | GitHub REST 只给 `open_issues_count`；评质量需 GraphQL + 认证 token |
| **Obelisk 是否提供商业授权（dual-license）** | **无法核实** | README（252 行）全文 grep 无 commercial/enterprise/pricing/sponsor/dual 字样；AGPL 项目普遍有私下商业授权但未公开声明 |
| **OpenViking `sdk/python` 许可证** | **无法核实** | `pyproject.toml` 无 `license` 字段，目录无 LICENSE |
| **OpenViking `sdk/go` 许可证** | **无法核实** | `go.mod` 无声明，目录无 LICENSE |
| **OpenViking `web-studio` 许可证** | **无法核实** | `package.json` 无 `license` 字段 + `"private": true` |
| **OpenViking `third_party/`（croaring/krl/leveldb/rapidjson/spdlog）** | **未逐项审计** | README 只写"Respective original licenses"；采用前必须逐项核查 |
| `OpenHands/agent-canvas` 的许可证 | **无法核实** | 仓库**无 LICENSE 文件**，GitHub `license: null` → 法律上默认保留所有权利 |
| `MoonshotAI/kimi-code` 的许可证与实现 | **无法核实** | 仅核实到文档站（`moonshotai.github.io/kimi-code`），未定位到源码仓库 |
| 腾讯 WorkBuddy 实现 | **无法核实** | 闭源商业产品，仅有公开报道与官方文档 |
| Codex / Claude Code 实现细节 | **无法核实（不言自明）** | 闭源 |
| **`dsh-layerfs` 插件许可证** | **无法核实** | GitHub `license: null`，仓库内无 LICENSE；README 的 MIT badge 指向 `layerfs` 主仓 |
| **LayerFS 是否会发布预编译产物 / 恢复严格 semver** | **无法核实（尚未发生）** | 本版实测 npm 三包全 404；1.1.0 是"owner-waived exception"；路线图未逐项抓取 |
| LayerFS 实际性能/稳定性 | **未验证** | 需 Docker + cargo 构建；判定 Deferred，未安装 |
| **我们的 Live2D 形态是否被判 Expandable** | **无法核实（需官方书面答复）** | 定义含「significant expandability」门槛 + Live2D 单方裁量；无公开判定标准 → **A7/P-0** |
| **免费 Expandable 的获批条件**（"separately specified conditions"） | **无法核实** | 官方未公开；只能通过正式申请得知 |
| `sundusk/dsh-pet` 鲸鱼娘素材的权利人 | **无法核实** | `ThirdPartyNotices.txt`（26 行）不含该素材；README 声称"随 App 附"但实际不符 |
| `PC2005-cloud/dsh-pet` 鲸鱼娘素材的完整授权链 | **部分核实** | 仅确认其 README 声明 CC BY-NC-SA 4.0 与"不可商业化"；未向权利人（B 站 @上善无形 / @ZipZipPipe）直接核实 |
| WeKnora 的 `NOASSERTION` 是否等于纯 MIT | **部分核实** | `LICENSE` 正文写「MIT except for the third-party components listed below」+ 长清单；**采用前需逐项审计第三方清单** |
| 官方 0.2.1 的 `dsh-plugin-manager` / `dsh-plugin-market` 是否可直接被 DshCockpit 复用 | **未验证** | 属 task-1（Runtime Bridge）范围 |

---

## 8. 证据索引（2026-11-01 实测）

**GitHub API 实查（stars / license / pushed_at）**
- `PC2005-cloud/dsh-pet`：5,117★ / MIT / TS / created 2026-08-14 / pushed 2026-10-31
- `sundusk/dsh-pet`：0★ / MIT / Swift / created 2026-08-14 / pushed 2026-10-28
- `ysyyhhh/dsh-pet`：1★ / MIT / TS / fork of `sereinmono/dsh-desktop-pet`(7★, license null) / pushed 2026-08-15
- `Tencent/WeKnora`：36,116★ / NOASSERTION / Go / v0.9.0 / pushed 2026-10-30
- `earendil-works/pi`：119,164★ / MIT / TS / pushed 2026-10-31（`badlogic/pi-mono` 已重定向至此）
- `GreenSheep01201/claw-empire`：1,436★ / Apache-2.0 / TS / pushed 2026-03-16
- `OpenHands/agent-canvas`：233★ / **license null** / pushed 2026-07-27
- `jklthinking/retinue`：115★ / **AGPL-3.0** / Python / pushed 2026-10-22
- `Inochi2D/inochi2d`：1,832★ / BSD-2-Clause / pushed 2026-10-03
- `Ephemeral-AI-Lab/layerfs`：2,594★ / **MIT（`spdx_id: MIT`）** / Rust / pushed 2026-10-31
- `Ephemeral-AI-Lab/dsh-layerfs`：42★ / **license null** / JS / created 2026-10-23 / pushed 2026-10-27
- `tommy0103/obelisk`：756★ / **AGPL-3.0** / JS / created 2026-05-29 / pushed 2026-10-31
- `volcengine/OpenViking`：41,244★ / **AGPL-3.0（主项目）** / Python / created 2026-01-05 / pushed 2026-10-31
- `csyangwen/dsh-memory-evolve`：476★ / **MIT** / JS / created 2026-08-05 / pushed 2026-10-29
- `omdsh-dev/dsh-mnemon`：812★ / MIT / TS / pushed 2026-10-31

**npm 实查**
- `@wxg-prc-cpg/dsh-weknora@0.1.0` / MIT / 2026-08-21
- `dsh-mnemon@0.5.37` / MIT / 2026-10-29
- `dsh-memory-evolve` → **404 Not found**
- `@obelisk-apps/cli@0.3.1` / AGPL-3.0 / 2026-10-25
- `@openviking/dsh-memory-plugin@0.5.31` / 声明 Apache-2.0 / **tarball 43 文件无 LICENSE**（分发合规缺陷）
- `@layerfs/agent` / `@layerfs/backend` / `layerfs` → **全部 404**

**许可证文件直抓（本版新增/复核）**
- Obelisk `LICENSE`（AGPL-3.0 全文）+ `packages/dsh-plugin/package.json`（`AGPL-3.0-only`）+ `README.md`（License 段，无商业授权声明）
- OpenViking `LICENSE`（AGPL）+ `examples/LICENSE`（**Apache-2.0**）+ `crates/LICENSE`（**Apache-2.0**）+ `examples/hermes-plugin/LICENSE`（**MIT**）+ `sdk/typescript/package.json`（**Apache-2.0**）+ `npm/cli/package.json`（**Apache-2.0**）+ `pyproject.toml`（AGPL-3.0）
- dsh-memory-evolve `LICENSE`（**MIT**，1069B）
- LayerFS `LICENSE`（**MIT**）+ `docs/general/release-policy.md` + `docs/versioned/0.1.6/limitations.md` + `docs/versioned/0.1.7/README.md` + `docs/release-notes/1.1.0/README.md` + GitHub Releases
- `ephemeral-AI-Lab/dsh-layerfs` `package.json`（`"license": "MIT"` 但仓库无 LICENSE 文件）

**我方代码/文档实读**
- `package.json`（`pixi.js: 8.5.2`、`runtimeVersion: 0.1.5-rc.2`、`license: MIT`）
- `LICENSE`（MIT）
- `src/memory-files.js`(94) / `src/session-search.js`(87) / `src/search-worker.js`(74) / `src/work/workspace-store.js`(515)
- `resources/characters/deepseek-default/{LICENSE,NOTICE,manifest.json}`
- `docs/archive/strategy/2026-09-27-dsh-pet-teardown.md`（PC2005 仓库拆解，8 条 TL;DR）
- `docs/product/product-principles.md` / `docs/product/WORK-FIRST-V0.7.md` / `AGENTS.md`

**URL**
- https://github.com/PC2005-cloud/dsh-pet
- https://github.com/sundusk/dsh-pet
- https://github.com/ysyyhhh/dsh-pet
- https://github.com/Tencent/WeKnora
- https://www.npmjs.com/package/@wxg-prc-cpg/dsh-weknora
- https://github.com/earendil-works/pi
- https://github.com/GreenSheep01201/claw-empire
- https://github.com/OpenHands/agent-canvas
- https://jklthinking.github.io/retinue/
- https://moonshotai.github.io/kimi-code/en/customization/agents.html
- https://github.com/tommy0103/obelisk
- https://github.com/volcengine/OpenViking
- https://github.com/csyangwen/dsh-memory-evolve
- https://github.com/Ephemeral-AI-Lab/layerfs
- https://github.com/Ephemeral-AI-Lab/dsh-layerfs
