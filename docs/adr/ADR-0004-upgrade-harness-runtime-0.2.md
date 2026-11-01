# ADR-0004：升级 Harness runtime 到 0.2.x 并采用 shell-held carrier

- **状态**：✅ **已接受（用户 2026-11-01 决策；P0 顺序见 Execution Plan）**
- **日期**：2026-11-01
- **决策者**：用户（待确认）
- **影响范围**：`src/runtime-manager.js`、`src/runtime-mux.js`、`src/harness-rpc.js`、`src/main.js`、全部 Harness 集成面
- **相关文档**：`docs/architecture/runtime-bridge.md`、`docs/research/deepseek-harness-api-surface.md`、`docs/adr/ADR-0002-consume-official-agent-teams.md`

## 1. 背景

DshCockpit 当前 `package.json` 锁定 `runtimeVersion: "0.1.5-rc.2"`。
官方桌面客户端已交付 `0.2.1-rc.5`，且新增了大量对新战略至关重要的能力（Agent Teams、workspace-changes、goal、jobs、plugin-manager）。

## 2. 问题

**是否以及如何升级到 0.2.x？**

## 3. 事实

| # | 事实 | 证据 |
|---|---|---|
| F1 | 本项目锁 `0.1.5-rc.2` | `package.json:5` |
| F2 | 官方现役 `0.2.1-rc.5`，asar 内 308 个 `@deepseek-ai` 包 | asar 实测 |
| F3 | 本机 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh` = `0.1.5-rc.2`，共 244 包 | `node -e "require('.../package.json').version"` |
| F4 | 0.1.5 **不含** `dsh-experimental-agent-team` | `ls ~/.dsh/profiles/node_modules/@deepseek-ai \| grep experimental` → 空 |
| F5 | 0.1.5 **含** `dsh-goal` / `dsh-jobs` / `dsh-schedule` / `dsh-workspace` / `dsh-workflow` | 同上实测 |
| F6 | 0.2.1 提供 shell-held carrier 扩展点（`connection.rpc.open` / `fetchBundle()`） | `dsh-client-connection` / `dsh-client-modules` README |
| F7 | 本项目已实现 0.1.5 的 mux 协议适配（`$events` / `session/follow` / `session/page` / `$events/result`） | `src/runtime-mux.js`、`src/harness-rpc.js` |
| F8 | 本项目有版本兼容层与兼容测试 | `src/compat-status.js`、`docs/compat/`、`test/compat-status.test.js`、`.github/workflows/upstream-compat.yml` |
| **F9** | **CI 已连续约 10 天在 darwin-arm64 + win32-x64 验证 `0.2.1-rc.5` 全绿**（install / dump-config / health-check 三 gate 均 pass） | `gh run view 41187195013 --repo Lxiayu/DshCockpit --log` → `"version":"0.2.1-rc.5","ok":true` ×2 平台；最近 5 次 run 全 success |
| **F10** | **但仓库兼容账本陈旧**：`docs/compat/compat-status.json` 仍写 `latestVerified: "0.1.5-rc.2"` / `updatedAt: 2026-09-16`；`badge.json` 仍写 `"✅ rc.2 verified"`；自动更新 PR #7 自 2026-09-17 起 OPEN 至今 | `grep latestVerified docs/compat/compat-status.json`；`gh pr view 7` → `state: OPEN, createdAt: 2026-09-17` |
| **F11** | **因此 UI 会错误显示"已是最新已验证版本"**：`compat-status.js` 用 `compatible = currentVersion === latestVerified`，而当前锁定版本恰好等于陈旧账本里的值 | `src/compat-status.js:78-81` |

### 3.1 F9–F11 的含义（对本决策的关键修正）

**"我们没升级到 0.2.x 是因为还没验证过" —— 这个判断是错的。**

`0.2.1-rc.5` 从 2026-10-21 前后起已连续约 10 天被 CI 在双平台验证通过。信息链断在：
1. CI 算出 `latestVerified=0.2.1-rc.5`，但不自动写回仓库；
2. 写回走 PR #7，PR #7 卡在 OPEN；
3. 仓库账本停在 0.1.5-rc.2；
4. `compat-status` 的等值比较恰好因为"锁定版本 == 陈旧账本值"而显示为"已是最新"。

**这使 R1 从"未知是否可行"变成"已知可行却被代码挡住"。** 且暴露出一个更优先的问题：**账本陈旧会让所有后续决策失去依据**。

**注意 F9 的覆盖边界（不可夸大）**：CI 三个 gate 是 `install`（arborist 装树）+ `dumpConfig`（`--dump-config` 退出 0）+ `healthCheck`（boot `--profile web` 且 GET 到 200/3xx）。
它**不连 `/api/remote.mux`、不调任何 RPC、不读任何 journal**。所以 F9 证明的是"能装、能 boot、能打印同一格式 URL 行"，**不证明 mux 协议行为一致**。协议行为一致性目前只有**声明级**证据（asar 类型声明 + 编译 JS 对比），仍需 POC 运行级验证。

## 4. 备选方案

| 方案 | 描述 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **A. 继续锁 0.1.5** | 不动 | 稳定、零风险 | 无法使用 Agent Teams / workspace-changes / plugin-manager；新战略落空；官方安全与功能修复拿不到 | ❌ 否决 |
| **B. 直接跳到 0.2.1-rc.5 并移除旧兼容** | 一次性升级 | 最快拿到新能力 | 破坏性变更未知；无回退路径；违反"小步可回退" | ❌ 否决 |
| **C. 分阶段升级 + 双版本兼容窗** | POC → 兼容层 → 默认切换 → 移除旧版 | 可回退；风险可控；符合项目既有兼容测试传统 | 需要维护双版本一段时间；工作量较大 | ✅ **采用** |
| **D. 改用 shell-held carrier 托管官方 Web UI** | 不自己渲染主界面，托管官方 UI + 自建办公室 | 大幅减少 UI 维护；官方 UI 持续变好 | 主界面受官方限制；Mission Desk 需寄生在官方 UI 内或并列 | ⚠️ **部分采用**（见 §6） |

## 5. 决策

### 5.1 核心决策

**采用方案 C（分阶段升级），并在新架构中采用方案 D 的 carrier 能力作为「官方 UI 的承载方式」之一，但不放弃自有 Mission Desk 与 Office 视图。**

### 5.2 分阶段计划

| 阶段 | 目标 | 退出条件 |
|---|---|---|
| **S-1（新增，最高优先）修复兼容账本** | 让 `compat-status` 能识别账本陈旧；修复 PR #7 卡死；CI 结果能回写仓库 | 设置页不再错误显示"已是最新"；账本 `latestVerified` 与 CI 实际一致 |
| **S0（POC，1–2 天）** | 在隔离环境安装 0.2.1-rc.5，验证：① 能否启动（**CI 已证明可行**，此处确认本机环境）；② mux 协议是否仍兼容（**CI 未覆盖，必须做**）；③ `agentTeam` 客户端视图是否可读；④ `workspace/changes` 事件形状 | 4 项都有明确结论（含"不支持"） |
| **S1（兼容层）** | 在 `runtime-bridge` 中引入版本适配（0.1.5 / 0.2.x 双读），默认仍用 0.1.5 | 双版本测试全绿；`compat-status` 能识别 0.2.x |
| **S2（默认切换）** | 默认 0.2.x；0.1.5 保留为显式回退 | 真机全量验收通过；回退路径验证 |
| **S3（移除旧版）** | 删除 0.1.5 专用代码路径 | 无 0.1.5 引用残留；文档同步 |

> **修正（2026-11-01 审计后）**：原计划从 S0 POC 开始。审计发现**必须先修 S-1 账本**，否则：
> ① 决策者看到的是"已是最新"，不会启动升级；
> ② 改了版本锁也没有决策依据（下次仍显示"已是最新"）；
> ③ PR #7 继续累积漂移，账本与 CI 差距持续扩大。
>
> **顺序：S-1 → S0 → S1 → S2 → S3。**


### 5.3 对 shell-held carrier 的采用方式

**采用**：
- 用官方 carrier 托管**官方 Web UI**（作为"完整 IDE 式"视图，`fetchBundle()` + `connection.rpc.open`）。
- 让用户可以在「Office 视图」与「官方 Web 视图」之间切换。

**不采用**：
- **不**把 Mission Desk 放弃、全部寄生官方 UI（那样 Mission 差异化消失）。
- **不**依赖 carrier 的私有细节（只依赖 README 声明的公开面）。

**理由**：
- 官方 UI 的代码编辑、diff、终端、文件树做得比我们好，**没必要重复造**（符合 Harness-first）。
- 我们专注于官方 UI 不做的事：Mission / Office / Capability。
- 同时保留自有 Mission Desk，避免"我们只是个壳里的壳"。

## 6. 决策理由

1. **新战略依赖 0.2.x**：Agent Teams 在 0.1.5 不存在（F4），不升级则 ADR-0002 无法实施。
2. **分阶段可回退**：符合项目"小步提交、每步可回退"纪律；且已有 `compat-status` 与 `upstream-compat.yml` 基础设施可复用。
3. **不重复造 UI**：官方 Web UI 成熟，托管比自研划算；但 Mission/Office 是我们的事。
4. **风险可控**：S0 是纯 POC，不改生产代码；失败也只是 POC 失败。

## 7. 代价

| 代价 | 说明 |
|---|---|
| 双版本维护窗口 | S1–S2 期间需维护两套适配 |
| 大量测试需双跑 | 现有 1935 项测试中 Harness 相关部分需在双版本验证 |
| 不确定性 | 0.1.5 → 0.2.1 的破坏性变更**尚未实测**（这是最大风险） |
| carrier 依赖 | 若官方改变 carrier API，需跟改 |

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **R1 mux 协议破坏性变更** | 中 | 高 | S0 必须先验证；准备 0.1.5 回退 |
| **R2 办公室 ingest 链路失效** | 中 | 高 | S0 验证 journal 事件形状；`main.js` 翻译层需适配 |
| **R3 打包体积/依赖变化** | 中 | 中 | 0.2.x 包数量从 244 → 308，需评估体积 |
| **R4 官方 experimental 包不稳定** | 高 | 中 | 只消费稳定面；experimental 能力做 feature flag |
| **R5 升级期间功能回退** | 中 | 高 | 分阶段 + 真机验收脚本 + 明确回退路径 |

## 9. 前置条件

1. 用户确认可以接受"升级期间可能需要 1–2 个批次不交付新功能"。
2. 备份策略确认（现有 `src/backup.js` + runtime 快照机制可复用）。
3. S0 的 POC 环境隔离方案确认（不污染用户当前 `~/.dsh`）。

## 10. 后续重新评估的触发条件

1. S0 POC 发现 mux 协议有不可调和的破坏性变更（则需重新设计 Bridge，可能是更长的过渡期）。
2. 官方发布 0.3.x（则考虑直接跳到稳定版而非 0.2.1-rc）。
3. shell-held carrier 在实测中不可用（则方案 D 退回纯自有 UI）。

## 11. 验证状态（2026-11-01 POC 后更新）

### 11.1 已运行级验证 ✅

POC（`docs/research/runtime-poc-report-2026-11-01.md`）在**完全隔离环境**中验证：

| 项 | 0.2.1-rc.5 | 0.2.2-alpha.2 |
|---|---|---|
| install / 版本自证 | ✅ | ✅ |
| `--dump-config`（web profile） | ✅ 58ms | ✅ 74ms |
| boot web host + `GET /` | ✅ | ✅ |
| cookie 交换 | ✅ | ✅ |
| **mux `$events` ready** | ✅ **（CI 从未覆盖）** | ✅ |
| **`session/list` / `create` / `page`** | ✅ **（CI 从未覆盖）** | ✅ |
| 6 个关键能力包存在性 | ✅ 全在 | ✅ 全在 |

**结论**：S0 的**协议部分已完成**。原 ADR 中"mux 协议是否兼容"的不确定性**已消除**。

### 11.2 仍未验证 ⚠️

| 项 | 为什么没验证 | 影响 |
|---|---|---|
| Team 成员事件（`team/member`、`team/task` payload） | 需驱动真实 team 会话 | ADR-0002 R0 能力映射缺直接证据 |
| User Question / Approval 往返 | 需真实模型调用与工具调用 | 交互链路未实测 |
| 断线重连与状态恢复 | 需长连接 + 强制断开 | 恢复语义未实测 |
| win32-x64 协议行为 | 本次仅在 darwin-arm64 执行 | 跨平台协议一致性待补 |
| 净增 6 个事件的实际 payload | 需产生对应事件 | 翻译层改造缺字段形状 |

### 11.3 对执行顺序的影响

原 §5.2 的 `S-1（修账本）→ S0（POC）→ S1（兼容层）` 中：
- **S-1 已完成**（Issue #21，commit `ca08f71`）
- **S0 部分完成**（协议层 ✅ / 端到端 ⚠️）

**可以进入 S1（兼容层）**：协议面已证明稳定，可以开始写双版本适配。
但 `supportedLevel` 仍为 `compatible` 而**非** `supported`——因为端到端与 Team 集成未验证，
按四级规则不得越级声称。
