# 交付状态（阶段历史与当前状态）

> 本文件是**唯一**记录「各阶段交付了什么、证据在哪、还剩什么」的地方。
> `AGENTS.md` 只保留当前状态摘要 + 指向本文件的链接——因为它是地图，不是手册。
>
> 最后更新：2026-11-01

## 0. 一句话

P0（地基）7/8 · P1（Mission Core）✅ · P2（Office 落地）✅ · P3（Capability Pack）✅ · P4 未排期。
**唯一未达成的 P0 条件是 `agentTeam` 字段形状需真实模型调用验证**（需 API key，见 Issue #23）。

## 1. 阶段总览

| 阶段 | 状态 | 离线测试 | 真机验收 |
|---|---|---|---|
| P0 地基校准 | ✅ 7/8 | — | — |
| S1 能力探测 | ✅ | 21 | — |
| P1 Mission Core | ✅ | 192 | 10/10 |
| P2 Office 落地 | ✅ 5/5 工作包 | 71 + 551 | 10/10 · 18/18 · 10/10 · 18/18 · 11/11 |
| P3 Capability Pack | ✅ | 68 | 13/13 |
| P4 体验打磨 | ⬜ 未排期 | — | — |

## 2. P0 —— 地基校准（8 项完成条件，7 项达成）

**2026-11-01 完成**：战略重定位（ADR-0001）、四路审计、领域模型、6 份 ADR、第三方评估。

| Issue | 内容 | 证据 |
|---|---|---|
| #21 | 兼容性账本 + 四态结论 + Verified/Fresh 分离 | `docs/quality/compatibility-ledger-spec.md`，22 项测试 |
| #10 | CI 门禁（四态报告，Skip 不计作 Pass） | `.github/workflows/ci.yml`，16 项测试 |
| #14 | 许可证三层检查（直接/传递/分发一致性） | `scripts/check-licenses.js`，15 项测试 |
| #9 | Runtime POC（隔离环境，不碰生产） | `docs/research/runtime-poc-report-2026-11-01.md` |
| #19 | Settings 保护（分层回退 + .bak 链 + 原子写） | `src/settings-persistence.js`，18 项测试 |
| #22 | IPC 安全网（契约快照 + 分域提取） | `test/ipc-contract.test.js` |
| #17 | 符号引用替代会漂移的行号 | `scripts/source-ref.js`，17 项测试 |
| **#23** | **`agentTeam` 字段形状验证** | ❌ **未达成** —— 需真实模型调用 |

## 3. S1 —— Runtime 能力探测（TD-29 已解决）

**2026-11-01 完成**：runtime 兼容层从「版本号比较」改为「能力探测」。

`src/runtime-capability.js` 用能力声明 + 已知矩阵 + 四态判定：

| 版本 | 判定 | 依据 |
|---|---|---|
| `0.2.1-rc.5` | **supported** | POC 实测 16/16 |
| `0.2.2-alpha.2` | **supported** | 同上 |
| `0.1.5-rc.2` | **degraded** | 无 agent-team |
| 未测过的版本 | **unverified 但放行** | 「没测过 ≠ 不能用」 |

## 4. P1 —— Mission Core（四层全部落地）

**2026-11-01 完成**：

| 层 | 交付 |
|---|---|
| 纯逻辑 | `src/mission/`（9 模块：schema / projection / event-log / store / brief / deliverable / migration / harness-reader / brief-sync） |
| IPC | `src/ipc-mission.js`（单通道 `mission:invoke` + 18 action 判别式） |
| UI | `src/mission-desk.html`（首个用户可见界面，三轴分开 + 诚实降级） |
| 持久化 | **Brief 同步进 `<workspace>/AGENTS.md`** |

**最关键的一步是最后一个**：dsh 每次 Session 启动都读 `AGENTS.md`，
所以 Brief 写进去就会在下次会话被 Agent 自动读到——**跨会话记忆真正生效**。

- 192 项离线测试，含端到端（重启后 Brief 字节相同、用户手写内容永不丢失）
- 真机验收 10/10（`docs/quality/mission-desk-acceptance-2026-11-01.md`）
- **唯一未验证**：Brief 是否真被下次会话读到（需 #23）

## 5. P2 —— Office 落地（5 个工作包，全部有真机证据）

**2026-11-01 完成**。路线图要求「办公室的每个交互物件都对应真实数据 + 可执行操作，零装饰性假功能」。

| 工作包 | 离线测试 | 真机验收 | 报告 |
|---|---|---|---|
| P2.1 Mission Desk | 192 | 10/10 | `mission-desk-acceptance-2026-11-01.md` |
| P2.2 Human Inbox | 551 | 18/18 | `office-inbox-acceptance-2026-11-01.md` |
| P2.3 项目白板 | 71 | 10/10 | `office-board-acceptance-2026-11-01.md` |
| P2.3 办公室收件箱 | （同上 551） | 18/18 | 同上 |
| P2.4 Companion Mode | 39 | 11/11 | `companion-acceptance-2026-11-01.md` |

### Companion Mode 的设计要点

独立常驻小窗（220×44、frameless、alwaysOnTop），**不加载 PixiJS**。
只显示两个数字（待办数 / 运行数）——因为用户不打开完整办公室时，
只关心「有没有需要我处理的事」。

**产品纪律**：0 待办绝不亮红。一个永远亮红点的常驻图标，
用户两天内就学会无视它——那时真正的告警也就失效了。

### 真机验收在此阶段抓到的缺陷（离线测试全绿）

| 缺陷 | 根因 |
|---|---|
| office 页对用户不可达 | `PAGES` 白名单漏了 `'office'`（**既有缺陷**） |
| 白板撑出 220px 空白 | `.setting-info` 的 `flex-basis` 在 column 容器里变成 height |
| 状态写进错误的页面 | 两个页面共用 `id="packs-status"` |

这三类都是**静态断言查不到**的运行时属性。

## 6. P3 —— Capability Pack（含第一个 Starter Kit）

**2026-11-01 完成**。先查官方 `@deepseek-ai/**` 确认无 capability-pack 类包（只有通用 cordis plugin）。

### 核心判断：verify 是核心，不是附属

一个 capability pack 如果没有 verify，它退化成**一段文档**——
用户装完不知道成功没有，我们也不知道它坏了没有。

### 交付

| 层 | 内容 |
|---|---|
| 库 | `src/capability-packs/{manifest,verify,installer}.js` |
| Pack | `capability-packs/workspace-verification` + `research-report`（Starter Kit） |
| 用户入口 | 设置页「能力包」页 + 4 个 IPC 通道 |
| CI 门禁 | `scripts/verify-capability-packs.js` |

### 三个设计决定

1. **manifest 字段少而硬**：只允许 8 个顶层字段，未知字段一律拒绝——这是「加字段必须先改校验器」的强制提醒。
2. **安装 = 记录，不是复制**：包没有需要复制的文件，所以卸载 = 删记录。这让「卸载无残留」**可验证**。
3. **verify 四态**：`passed` / `failed` / `skipped` / `not-verified`。
   「平台不支持」记成 false 会像坏了，记成 true 就是 **Skip 冒充 Pass**。

### Starter Kit：`research-report`

一条命令产出真实 `.md`（1172 字节、6 小节）：
```bash
node scripts/starter-kit.js research-report --title "我的第一份研究"
```
重复执行**不覆盖**用户已写内容。

### 真机验收抓到的缺陷

| 缺陷 | 根因 |
|---|---|
| 点击后看不到任何反馈 | `loadCapabilityPacks()` 无条件清空状态 |
| 页面显示成角色包的文案 | i18n key 撞车（都用 `packs_desc`） |
| 状态写进角色包页面 | DOM id 撞车（都用 `packs-status`） |

## 7. 技术债现状

### 已消除

TD-02/03/05（#19 Settings）· TD-04（索引上限+归档）· TD-08/09（窗口加固）·
TD-10（CI 门禁）· TD-15（复核不成立）· TD-17（符号引用）· TD-29（能力探测）·
TD-32（IM 准入）

### 仍存在

| 债 | 说明 |
|---|---|
| TD-01 | `main.js` 过载（#22 已提取 29 个 handler，107→60） |
| TD-06/07 | IPC 无完整冻结（契约快照已覆盖通道集合，未覆盖 payload） |

详见 `docs/quality/tech-debt-inventory.md`。

## 8. 已知问题（如实记录）

| 问题 | 状态 |
|---|---|
| `test/runtime-mux.test.js` 的 `reconnect re-opens every registered stream` 并发下偶发失败 | **已知偶发**，单独重跑与全量重跑均通过。P2.4 与 P3 各出现一次。若 CI 再次出现，请优先排查该用例的时序假设 |
| Brief 是否真被下次会话读到 | **未验证**，需真实模型调用（#23） |
| `capability-packs` 的 Windows 真机验收 | **未做**（路线图要求 mac + win） |

## 9. 当前基线

```
CI=1 npm test  →  2719 passed / 0 failed / 1 skipped
```
唯一 skip 是 E5a-R1 真机探针（需图形会话）——**Skip 不计作 Pass**。

门禁：账本 / 许可证 / docs-index / capability-packs，全部 PASS。
