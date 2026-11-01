# Runtime 升级 0.1.5-rc.2 → 0.2.1-rc.5

> 状态：执行中（2026-11-01）
> 触发：用户要求升级到最新版（"一些依赖、内容等只有最新版支持"）
> 目标版本：**0.2.1-rc.5**（npm `latest` 标签）
> 备选：0.2.2-alpha.2（`alpha` 标签）——**不选**，理由见 §1

## 1. 为什么选 0.2.1-rc.5 而不是 0.2.2-alpha.2

| 版本 | dist-tag | 判断 |
|---|---|---|
| **0.2.1-rc.5** | `latest` / `next` | ✅ **选它**。RC 系列最后一个，已稳定 |
| 0.2.2-alpha.2 | `alpha` | ❌ 不选。alpha 且只隔一个 rc，稳定性未知 |

## 2. 环境前提

| 项 | 实际 | 要求 | 判断 |
|---|---|---|---|
| Node | v24.16.0 | 0.2.2 要求 ≥24.9 | ✅ 满足 |
| 当前 runtime | 0.1.5-rc.2 | — | 待升级 |
| 平台 | darwin arm64 | — | ✅ |

## 3. 官方发布说明里对我们有**破坏性影响**的条目

这是本次升级的核心风险清单。逐条标注我们需要改动什么。

### 3.1 必然影响我们的（按风险排序）

| # | 官方变更 | 我们的影响 | 严重度 |
|---|---|---|---|
| **1** | 「Agent Team 消息改为**直接投递目标 Inbox**，移除独立 outbox、自动重试和重发去重；相关配置与结果字段需迁移」 | 如果用了 team 消息，字段会变 | ⚠️ 中（我们未深度用） |
| **2** | 「移除运行时 invariant 插件及各包的 `./invariant` 导出」 | 若引用会失败 | ⚠️ 待查 |
| **3** | 「子路径插件不再读取独立 `package.json`，显示文本和图标须通过对应子路径导出」 | 影响 capability-packs | ⚠️ 待查 |
| **4** | 「第三方插件版本兼容性优先按 `engines.dsh` 判断」 | capability manifest 可能需要加字段 | ⚠️ 中 |
| **5** | 「输入区统计扩展拆为 `activity` 和 `usage` 两个独立入口；覆盖旧 `stats` 整行的插件需要更新注册 ID」 | 若我们注入了 stats | ⚠️ 待查 |
| **6** | 「移除工具展示的 `both` 混合模式，仅保留 native 和 ptc」 | 若配置里有 `both` 会报错 | ⚠️ 待查 |
| **7** | 「移除 agent-instructions 插件逐行 `dshHome` 配置，指令目录改从 `DSH_HOME` 读取」 | **直接影响我们的 Brief 同步**（写 AGENTS.md） | 🔴 高 |
| **8** | 「API Key 读取优先级变更：Web/桌面优先用已保存凭据；headless 改用环境变量」 | 影响模型配置 | ⚠️ 中 |
| **9** | 「`azure-openai-responses` 改名为 `azure`」 | 我们没用 azure | ✅ 无 |
| **10** | 「PTC Node 控制通道改用 birpc；SSH 协议 2→3」 | 我们没用 PTC/SSH | ✅ 无 |

### 3.2 对我们**有利**的变更（值得利用）

| 变更 | 对我们的价值 |
|---|---|
| **Session API 新增独立接口**：分别读取快照、持续订阅事件日志、运行状态、事件投影 | 🔴 **高**。这可能解决我们 `session/page` 只能轮询的问题 |
| 「全局与项目 AGENTS.md 分别使用 maxBytes 预算」 | 🔴 **高**。我们 Brief 写入 AGENTS.md 的 1MiB 上限需重新对齐 |
| 「SDK 提供与 Web 模式一致的文件交付、问答、调度、技能和上下文能力，支持问答回调与操作审批」 | 中 |
| 「支持**多选问题**多个推荐选项全部预选」 | 🔴 **高**。正是我们缺的结构化交互 |
| 「已回答的问题批次以消息气泡显示」 | 中 |
| 「自定义插件需迁移到**异步会话投影句柄**」 | ⚠️ 若我们写插件需改 |
| 「新增实验性 `working_directory` 工具 + SDK API」 | 中 |
| 「新增 Git Worktrees 插件」（我们曾评估 LayerFS） | 中 |

## 4. 执行步骤

| 步 | 内容 | 验收 |
|---|---|---|
| S1 | 用现有 runtime-manager 安装 0.2.1-rc.5 | `installed` 里有该版本 |
| S2 | 激活并冒烟测试（`smokeTest`） | 进程起来、URL 拿到 |
| S3 | **全量契约检查**：协议/通道/字段 | 见 §5 |
| S4 | 修复破坏性变更 | 测试全绿 |
| S5 | 真机验收（每个视图 + 双主题） | 截图 |
| S6 | 在新版本视角重看 Mission Desk 差距分析 | 更新文档 |

## 5. 必须复查的接线点

| # | 检查点 | 方法 |
|---|---|---|
| 1 | mux stream 协议是否变了 | 连 `/api/remote.mux` 发 `open` 帧 |
| 2 | unary HTTP 形状是否变了 | `POST /api/session/list` |
| 3 | `session/follow` 是否还在 | 订阅 |
| 4 | `session/page` 是否还在 | 调用 |
| 5 | **新增的 Session API 独立接口是什么** | 读 `dsh-api-session-controller` types |
| 6 | AGENTS.md 的 maxBytes 新预算 | 读 `agent-instructions` |
| 7 | 多选问题字段 | 读 `dsh-user-questions` types |
| 8 | `agentTeam` 投影是否进稳定 API | 读 types |
| 9 | 我们用的 308 个 `@deepseek-ai` 包里哪些没了/改名了 | 对比包列表 |
| 10 | capability manifest 是否需要 `engines.dsh` | 读插件加载逻辑 |

## 6. 回滚方案

`runtime-state.json` 有 `previousVersion` 字段。
`manager.activate(previousVersion)` 可回退。**升级前先确认这个路径可用。**

## 7. 非目标

- ❌ 不升级到 0.2.2-alpha.2
- ❌ 不重构现有 Office/Mission 代码（除必要的接线修复）
- ❌ 不引入 PTC / SSH / Worktrees
