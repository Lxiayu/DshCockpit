# 规划落差盘点（Gap Inventory）

> 最后更新：2026-11-01
> 目的：**回答"早期规划里还有什么没做"**，而不仅是 P0–P4 的进度。
> 判定依据：`docs/product/product-vision.md` §0.1 的三层范围（North Star / MVP / Deferred）。
>
> **重要**：本文件列出的"未做"**不都是缺陷**。North Star 支柱与 Deferred 项
> 本来就不排期——把它们当待办清单会误判项目健康度。

## 0. 一句话结论

**MVP 范围内没有遗漏。** 所有"未做"项分两种情况：
- **North Star 支柱**：长期锚点，按设计**不排期**（N2/N4）
- **Deferred 项**：有明确触发条件，未触发（Live2D / LayerFS / Knowledge / Community）

真正值得关注的只有 **3 个具体缺口**（见 §4），都不是"规划被遗忘"，而是"依赖未满足"。

---

## 1. 五支柱现状（North Star，不排期）

| # | 支柱 | 规划状态 | **代码实际状态** | 判定 |
|---|---|---|---|---|
| **N1** | Mission Core | MVP 重点 | ✅ `src/mission/` 9 模块 + IPC + UI + Brief 同步 | **完成** |
| **N2** | Capability Orchestration | 设计完成 | ✅ `src/capability-packs/` 3 模块 + 2 个真实 Pack + 用户入口 | **P3 已落地**（原文档仍标"设计完成"，已过时） |
| **N3** | Starter Kits | 设计完成 | ✅ `research-report` Starter Kit（真实产出 .md） | **P3 已落地**（原文档标"依赖 P1，暂不实现"，已过时） |
| **N4** | Provider 层 | 只抽象 Verification | ✅ 复用 `command-runner.js`，未为其余 4 个造接口 | **按纪律执行**（正确的"不做"） |
| **N5** | Virtual Office 空间化交互 | 已实现核心，物件待建 | ✅ 5 个交互物件全部有真机证据 | **P2 完成** |

**需要修正的文档**：`product-vision.md` §2.3 里 N2/N3 的"当前状态"仍写着
"设计完成"/"不实现"，已与代码不符。应在下次文档维护时更新。

---

## 2. Deferred 项（有触发条件，未触发）

| 项 | 代码存在性 | 重新评估的触发条件 | 当前判定 |
|---|---|---|---|
| **Live2D 生产接入** | 0 个文件 | 静态角色包不足以表达团队状态时 | 未触发（ADR-0006） |
| **LayerFS 生产集成** | 0 个文件 | 多工作区隔离成为真实痛点时 | 未触发 |
| **KnowledgeProvider**（WeKnora） | 0 个文件 | 出现真实用户需求时 | 未触发（ADR-0005） |
| **Character Pack 市场** | 无分发机制 | 有第三方想发布 Pack 时 | 未触发（ADR-0003：不是 marketplace） |
| **Community Hub** | 0 | 用户量支撑社区时 | 未触发 |
| **多 Harness Adapter** | 0 | 第二个 Harness 出现且被需要时 | 未触发（硬边界禁止） |
| **跨项目 Team** | 0 | 单项目 Mission 被验证有效后 | 未触发 |

**判定**：这些是**设计上的"不做"**，不是"忘了做"。把它们当缺口会导致错误投入。

---

## 3. 已识别但零调用方的模块（本轮扫描结果）

**结论：没有真正的孤立模块。**

扫描 `src/*.js` 的 14 个"无 require 调用方"文件，逐一核实：

| 文件 | 为什么看起来孤立 | 实际调用方式 |
|---|---|---|
| `*-preload.js`（7 个） | 不被 require | Electron 按 `webPreferences.preload` **路径**加载 |
| `main.js` | 入口 | `package.json` 的 `main` 字段 |
| `session-worker.js` / `search-worker.js` | 不被 require | `new Worker(path)` 按路径加载 |
| `runtime-install-worker.js` | 不被 require | `path.join(__dirname, ...)` 传给 worker |
| `watchdog.js` | 不被 require | **由 `runtime-supervisor.js` 以 detached 进程方式启动**（硬杀兜底） |

这些都是"按路径加载"的正常模式，不是死代码。

> 对照：P3 期间发现的 `createCapabilityInstaller` 是**真**孤立
> （196 行实现 + 33 项测试 + 0 调用方），已通过 P3.5 接入设置页修复。

---

## 4. 真正的缺口（3 个，都不是"规划被遗忘"）

### ~~缺口 1：`agentTeam` 字段形状未验证（#23）~~ ✅ 已解决

**两个子问题都已解决（2026-11-01）**：

| 子问题 | 状态 | 证据 |
|---|---|---|
| 字段形状是什么 | ✅ | 从官方 `.d.ts` 逐字段比对，5 项 exact match；CI 有形状漂移门禁 |
| Brief 是否真被下次会话读到 | ✅ | 真机 8/8：模型从 AGENTS.md 读出随机暗号 |

**这消除了 P0 的唯一未达成条件，也消除了 P1 的唯一未验证项。**

### 缺口 2：`product-vision.md` §2.3 的 N2/N3 状态过时

文档写"设计完成/不实现"，代码已完整落地。**这是文档落后于实现**，
不是实现落后于规划。

### 缺口 3：Windows 真机验收

路线图要求 mac + win，目前只有 mac。用户已明确：**先打磨 Mac，Windows 后做**。
记录为已知未做，不算缺陷。

---

## 5. 用户特别关注：性能（Windows 杀毒软件场景）

用户指出：Windows 上杀毒软件/系统服务会让程序变慢，需要**提前设计**而非事后补救。

这是真实的架构级风险。当前代码里已经存在的隐患，按严重性排序：

| # | 隐患 | 位置 | Windows 影响 |
|---|---|---|---|
| **P1** | 同步 fs 调用在热路径 | `models-manager.js` 的 `readText`/`writeSettingsFile`、`installer.js` 的 `readRecord()` 每次 IPC 都读文件 | 杀毒软件会 hook 每次 `readFileSync`，同步阻塞主线程 = UI 卡顿 |
| **P2** | `safeStorage` 解密在每次读取时 | `KeyVault.get()` | Windows DPAPI 调用较慢，频繁调用会明显卡 |
| **P3** | 启动时大量文件扫描 | `availableCapabilityPacks()` 扫目录 + 读每个 manifest | 首次打开的感知延迟 |
| **P4** | 每次快照推送都做全量派生 | `officeModuleInstance.subscribe` → `deriveCompanionState` 遍历全部 employees | 员工多时 CPU 抖动 |

### 设计原则（应写入规范）

1. **主线程不做同步 IO**：热路径一律异步或缓存
2. **缓存优先**：manifest / 安装记录这类"变化很少"的数据必须有内存缓存 + 失效机制
3. **可观测**：加一个启动耗时/主线程阻塞时长的自检，能在真机上量化"是否变慢"
4. **避免频繁全量派生**：增量优于全量；纯函数派生要能跳过无变化输入

**建议**：把这条做成一个独立的 P4 工作包「性能基线」，先建立**测量能力**
（没有测量就没有优化依据），再针对 P1/P2 做优化。

---

## 5.5 一次独立盘点审计的发现（2026-11-01，已全部处置）

一次独立只读审计发现了**比"未做"更严重的一类问题：做了但接不上**。

### 已修复（本轮）

| # | 断线 | 后果 | 修法 |
|---|---|---|---|
| 1 | 白板点击调 `window.dshShell.openMissionDesk()`，但 office 视图只 expose `officeBridge`，且处理器全仓不存在 | 点白板 = **TypeError**；连带 P1 的 Mission Desk 在成品里**没有任何可用入口** | 新增 `office:open-desk`（纯导航，不写状态）+ 抽 `office-desk-nav.js` |
| 2 | `installer.install()` 调 `runVerify` 不传 `cwd`/`DSH_PACK_DIR` | `research-report` 永远安装失败；`workspace-verification` 把文件写进用户 cwd | verify 跑在临时目录 + 注入包目录 |

**共同根因**：验收探针把核心环节 **stub 掉了**——白板验收 11 项没有一项点击，
能力包验收把 install 通道整个替换成计数器。**验收 stub 掉被测对象 = 没验收。**

### 仍未修（按审计结论排序）

| 优先级 | 项 | 说明 |
|---|---|---|
| 高 | Mission Desk 的 7 个 action 无 UI | `recordDecision` / `registerDeliverable` / `addWorkstream` / `updateWorkstreamStatus` / `update` / `openQuestion` / `openDesk`。**V2「跨会话不丢决策」与 V3「产物是真实文件」目前没有可用通道** |
| 高 | TD-03 / TD-05 标记"已修复"但代码没修 | 修复只落在 `settings-store.js`；`work/workspace-store.js` 与 `backup.js` 没接。按"存储已安全"做迁移会丢数据 |
| ~~中~~ | ~~TaskRef 无生产者~~ | ✅ **已修 2026-11-01**：新增 `linkTaskRef`/`listTaskRefs` + Desk UI；`harnessRef` 走隐私派生（不存 sessionId） |
| ~~中~~ | ~~Brief 跨会话验证~~ | ✅ **已真机验证 2026-11-01**（8/8）：模型从 AGENTS.md 读出随机暗号。两处风险也已加固 |
| — | `official-teams-shape.js` 零调用方 | ✅ **已判定为「刻意不接线」**（2026-11-01）：Office 已有 `team-office-adapter`+`team-office-bridge` 一条事实路径，再接一套就是双写（违反铁律 1）。已在模块头声明定位，并加机械门禁防止擅自 require。接线的正确时机是 ADR-0002 R2 等价性验证通过、旧 `team/runtime` 开始退役时**替换**而非并存 |
| — | `RenderBackend` 接缝 | ✅ **已做 2026-11-01**：`src/office/render/render-backend-contract.js`（接缝不是抽象层；20 个方法里只有 3 个技术特有） |
| — | `VerificationProvider` 接口 | ✅ **已评估，决定不做** 2026-11-01：收益（可测试/统一入口）已通过 `runVerify` + 注入 runner 获得；缺的是第二个实现，写代码解决不了。触发条件已写进 ADR-0003 |

## 6. 优先级建议

| 优先级 | 事项 | 理由 |
|---|---|---|
| **1** | 用 step-5-preview 打通 #23 | 解锁 3 个积压项（P0 完整性 / Brief 验证 / #11），现在前置条件已具备 |
| **2** | 性能基线与测量 | 用户明确关注；且"测量"本身能暴露其他问题 |
| **3** | 更新 `product-vision.md` N2/N3 状态 | 文档落后于实现会误导后续决策 |
| **4** | Windows 真机验收 | 用户明确：后做 |

**不建议**：动 North Star 的 N2/N4 或任何 Deferred 项。它们"没做"是设计意图。
