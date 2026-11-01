# ADR-0001：产品重新定位为 AI 团队工作空间，放弃「Harness 桌面壳」竞争

- **状态**：✅ **已接受（用户 2026-11-01 拍板；2026-11-01 第二轮审查再次确认）**
- **日期**：2026-11-01
- **决策者**：用户
- **影响范围**：产品定位、路线图、全部后续架构决策
- **相关文档**：`docs/product/product-vision.md`、`docs/adr/ADR-0002-mission-core-scope.md`

## 1. 背景

DshCockpit 创立时的定位是「DeepSeek Harness 的桌面控制程序」，解决 Harness 的桌面启动、Runtime 管理、Token 监控、会话管理等问题。随后投入大量精力开发 PixiJS 虚拟办公室、角色动画与 Agent 状态展示。

现在情况发生变化，需要重新判断定位。

## 2. 问题

### 2.1 核心问题

**继续把 DshCockpit 定位为「另一个 Harness 桌面壳」是否仍然成立？**

### 2.2 事实依据（可验证）

| # | 事实 | 证据路径 |
|---|---|---|
| F1 | 官方已有独立桌面客户端，且版本领先 DshCockpit 锁定的 runtime 约一个大版本 | 官方 `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.5`（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar!/dsh/package.json`）vs 本项目 `package.json:5` `runtimeVersion: "0.1.5-rc.2"` |
| F2 | 官方已自带 308 个 `@deepseek-ai` 包，覆盖插件管理、插件市场、技能、调度、workspace、审批、提问、子代理、goal、jobs、session 搜索、自动审查 | asar 内 `dsh/node_modules/@deepseek-ai/` 目录实测计数 |
| F3 | 官方已提供完整 Agent Teams（roster / inbox 消息 / 持久共享任务板 / CAS revision / waitForChange / interrupt） | `dsh-experimental-agent-team@0.2.1-rc.5` 官方 README |
| F4 | 官方已提供 shell-held carrier 扩展点，明确支持第三方壳托管其 Web UI | `dsh-client-connection` README：「由 shell 持有的组合通过 `connection.rpc.open` 提供等价的 Remote 流…不打开 WebSocket」；`dsh-client-modules`：「由 shell 持有的载体则通过 `fetchBundle()` 分派完全相同的 bundle 响应」 |

### 2.3 问题的本质

DshCockpit 现有能力清单（runtime 管理、成本中心、插件市场、技能市场、模型管理、MCP、调度、Quick Ask、IM 通道、远程控制）中，**大部分已被官方覆盖或即将覆盖**（F2）。

继续在这条线上投入，产出的每一项都会变成官方 changelog 的子集，**投入无法沉淀为护城河**。

但同时 F2/F3 揭示了一个空档：官方交付的是**能力与执行**，没有交付**「一支团队在一个长期项目里如何持续工作」的体验**。

## 3. 备选方案

| 方案 | 描述 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **A. 继续做桌面壳** | 与官方桌面正面竞争，靠功能更多取胜 | 路径熟悉、已有积累 | 官方每版覆盖一部分；维护成本线性增长；无护城河 | ❌ 否决 |
| **B. 转做 Harness 插件/皮肤** | 不再做壳，做官方生态里的一个插件 | 借力官方分发 | 放弃已有 Electron 壳与办公室资产；受官方 API 限制；无法做跨 Session 的 Mission 连续性 | ❌ 否决 |
| **C. 转做 AI 团队工作空间** | 保留壳作为承载，核心价值转向 Mission + Office + Capability | 与官方互补而非竞争；办公室资产是唯一官方难复制的东西；官方扩展点（F4）支持该路线 | 需要重新定义大量功能；Mission Core 是全新建设；有定位模糊风险 | ✅ **采用** |
| **D. 转做通用多 Agent 编排平台** | 自研 Harness，支持多 Provider | 想象空间大 | 直接违反用户明确的 Harness-first 边界；工作量爆炸 | ❌ 否决（用户明确禁止） |

## 4. 决策

**采用方案 C。**

DshCockpit 重新定位为：

> **The Workspace for AI Teams** — 以虚拟办公室为核心交互方式的 AI 工作空间，组织、管理、观察并参与 AI Agent 团队的工作。

战略边界（硬约束）：

```
Harness owns execution
DshCockpit owns experience, continuity, capability orchestration
```

- **不**自研 Agent Loop / 通用 Harness / 第二套 Runtime。
- **不**与官方桌面竞争桌面壳功能。
- **不**把 Pi 或其他项目作为并列执行引擎。
- **要**做 Mission Core（跨 Session 项目连续性）、Virtual Office（团队可读性）、Capability Platform（开箱即用的能力组合）。

## 5. 决策理由

1. **避免正面对撞**：官方壳的功能是"必然会被补齐"的，与其竞争是负期望值的投入。
2. **聚焦不可复制资产**：虚拟办公室（约 27k 行、真实事件驱动、有角色与空间隐喻）不是官方会在短期内做的事。
3. **填补真实空档**：用户真正的问题是"长期项目跨会话丢上下文"（R1–R5，见 `docs/architecture/domain-model.md` §0.2），官方明确不提供（`dsh-goal` 是同会话级，Agent Teams 是单 Team 生命周期）。
4. **技术路线可行**：官方 F4 明确提供第三方壳托管 Web UI 的扩展点，说明"保留自有壳"是被支持的。
5. **已有资产不浪费**：runtime 管理、成本中心、IM 通道、公网远程仍有真实价值，作为底座保留。

## 6. 代价

| 代价 | 说明 |
|---|---|
| 部分功能让位 | 自研插件市场、技能市场需重新评估（官方已有 `dsh-plugin-market` / `dsh-skill`），可能改为"验证过的组合"而非"通用市场" |
| 自研 Team Runtime 需重新定位 | 官方 Agent Teams 已覆盖大部分语义；自研 v0 的价值需重新论证（见 ADR-0002） |
| Mission Core 是全新建设 | 需要新的数据模型、存储、UI、验证体系 |
| 定位沟通成本 | 用户与贡献者需要理解"我们不是壳" |

## 7. 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| **R-A 定位模糊**：用户仍把我们当壳，Mission 无人用 | 中 | 高 | 用 90 天判据硬验证（`product-vision.md` §7）；首跑 5 分钟拿到真实产物作为唯一验收标准 |
| **R-B Mission Core 变成第二个 Harness** | 中 | 高 | 领域模型铁律：只做跨 Session 记忆与索引；每个实体必须有"为什么官方不够"的论证 |
| **R-C 办公室被当作装饰** | 中 | 中 | 每个交互物件必须对应真实数据 + 可执行操作；零装饰性假功能 |
| **R-D 官方补齐 Mission 语义** | 低 | 高 | 关注官方 `dsh-goal` 演进；我们的差异化在"跨 Session + 项目级 + 多 Mission" |
| **R-E 转型期资源分散** | 高 | 中 | 路线图强制串行；P0 未完成不启动 P1 |

## 8. 后续重新评估的触发条件

满足**任一**条件时，重新审视本决策：

1. 官方桌面客户端开始提供**跨 Session 的项目级连续性**（如 project-scoped goal / cross-session memory）。
2. DshCockpit 的 90 天判据连续两个周期未达成。
3. 用户主力使用场景实际仍是"看 Token 和动画"，而非"用团队工作"。
4. 官方关闭 shell-held carrier 扩展点（F4 不再成立），导致自有壳路线技术上不可行。

## 9. 证据记录

```bash
# F1/F2：官方包清单与版本（2026-11-01 实测）
node /tmp/asar_inspect/extract.js /dsh/package.json
# → version: "0.2.1-rc.5", dependencies 305 项
# → asar 内 dsh/node_modules/@deepseek-ai/ 共 308 个包

# F3：Agent Teams 能力（官方中文 README 原文）
node /tmp/asar_inspect/extract.js /dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/README.zh.md

# F4：shell-held carrier
node /tmp/asar_inspect/extract.js /dsh/node_modules/@deepseek-ai/dsh-client-connection/README.zh.md
node /tmp/asar_inspect/extract.js /dsh/node_modules/@deepseek-ai/dsh-client-modules/README.zh.md

# 本项目锁定版本
grep runtimeVersion /Users/xia/program/dsh/DshCockpit/package.json
```
