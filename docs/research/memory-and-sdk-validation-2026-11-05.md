# 记忆层与 SDK 桥接验证报告（2026-11-05）

> 状态：**已完成（证据固定）**
> 上游：`/Users/xia/Downloads/ChatGPT_重构项目价值定位_20261105-0246.md`（用户与 GPT 的新架构讨论）、`docs/adr/ADR-0005-memory-official-stack.md`（零第三方 Memory Provider 立场）、`docs/research/memory-systems.md`
> 下游：`docs/plans/active/VALUE-LAYER-REFACTOR-2026-11-05.md`（正式重构计划，本文是它的证据底座）
> 测试环境：`/tmp/dsh-research-20261105/`（隔离目录；未触碰任何已配置的 API key；真机测试使用用户当日提供的新 StepFun key）

---

## 0. 结论一览

| 候选 | 版本 | 许可 | 验证结果 | 判定 |
|---|---|---|---|---|
| projectmem | 0.3.5 | MIT | 378/378 测试通过；CLI 记忆闭环可用；MCP stdio 可用 | ✅ **作为设计参考**（不作为依赖引入） |
| AgentMemory | 0.9.32 | Apache-2.0 | 4432 通过 / 5 失败 / 6 跳过（失败全部是引擎二进制真实下载用例，属沙箱网络限制）；引擎手动安装后服务可用 | ✅ **作为设计参考**（不作为依赖引入） |
| @deepseek-ai/dsh-sdk-client | 0.2.1-rc.5 搭 0.0.1-rc.1 | MIT | 握手 + 完整任务执行 + 工具调用循环真机验证通过 | ✅ **Phase 1 桥接采用** |
| @deepseek-ai/dsh-acp | 0.2.1-rc.5 搭 0.0.1-rc.1 | MIT | 依赖 `@deepseek-ai/dsh-type-meta` 不存在于 npm registry，无法导入 | ❌ 该版本不可用（0.2.2 已修复，见 §4.5） |
| @deepseek-ai/dsh 全家 | **0.2.2-rc.1**（next tag） | MIT | ACP 依赖闭包完整；ACP 协议握手/建会话冒烟通过；SDK 握手通过；**真机任务执行通过（问答 + 工具循环 + 文件写入）**；**Node ≥24.9 硬要求** | ✅ 可用但需 Node 24 运行时（见 §4.5、§4.6） |

用户拍板（2026-11-05）：**记忆层自研 Mission Memory**（参考 projectmem 与 AgentMemory 的设计，不闭门造车）；**运行时桥接采用 SDK Client 替换 + journal 只读**。

---

## 1. projectmem 验证记录（Python，本地无 key）

**安装**：`uv venv`（Python 3.13.13）+ `uv pip install -e ".[dev]"`，依赖仅 typer / mcp / watchdog。

**测试**：`pytest tests -q` → **378/378 通过**（须 `PYTHONPATH=` 清空宿主注入，见 §5 环境坑）。

**功能冒烟**（`/tmp/pjm-smoke/demo-app`）：
- `pjm init`：生成 `.projectmem/`（`events.jsonl` / `summary.md` / `plan.md` / `PROJECT_MAP.md` / `config.toml` / `AI_INSTRUCTIONS.md`）+ `AGENTS.md`/`CLAUDE.md` 桥接块 + git hooks（post-commit/post-merge/pre-commit 自动捕获）。
- `pjm log "login page crashes on Safari" --at "src/login.ts:42"` → issue #0001。
- `pjm attempt "..." --failed/--worked` → 失败/成功尝试入账。
- `pjm brief` → 会话启动简报：**"⚠ src/login.ts — 2 failed attempts"**（失败尝试警告，核心价值点验证通过）。
- `pjm search Safari` → 子串/正则事件检索可用。
- MCP stdio（`pjm-mcp`）：`initialize` + `tools/list` 握手成功，工具面完整。

**对 Mission Memory 的可借鉴设计**：
1. **事件类型学**：issue / attempt(worked/failed/partial) / fix / decision / note——比 Mission 现在的派发事件多了"经验层"类型。
2. **brief（会话启动简报）**：警告 + 开放问题 + 近期决策 + 陈旧记忆 + 预防评分，一屏。与现有 `brief-sync.js`（写 AGENTS.md）同构但内容更丰富。
3. **失败尝试警告**：派发/提交前按 `file:line` 命中历史失败尝试，防止重复踩坑。
4. **`export` 命令**：把活记忆（决策/坑/失败方法）编译进 CLAUDE.md，让无 MCP 的 agent 继承判断力——与 AGENTS.md 桥接思路一致。
5. **staleness（陈旧检测）**：记忆对应的代码位置变了要标记/修复。

## 2. AgentMemory 验证记录（Node + 原生 iii-engine）

**构建/测试**：`tsdown` 构建 3.9s（须清 NODE_OPTIONS，否则挂起）；`vitest run --exclude test/integration.test.ts` → **4432 通过 / 5 失败 / 6 跳过**。5 个失败全部位于 `engine-install.test.ts`（引擎二进制真实下载/SHA-256 校验用例，沙箱网络受限所致，逻辑层用例全绿）。

**引擎安装**：按官方手动命令安装 iii-engine v0.25.0（`curl` + `sha256sum -c` + `tar`），校验通过，`iii --version` → 0.25.0。

**功能冒烟**：
- 服务启动：Compose 守护进程 + REST `:3111` + Viewer `:3113` + engine `ws://49134`。
- `agentmemory demo`：种子 6 条观察跨 3 会话，关键词检索命中（"jwt auth middleware" 3 hits）；语义检索需 `EMBEDDING_PROVIDER`（本地方案存在）。
- REST 捕获：`POST /agentmemory/session/start` + `POST /agentmemory/observe`（Bearer token 于 `~/.agentmemory/secret`），观察入账返回 `eventId/observationId/durableAfterMs`。
- DSH 集成面（`connect dsh --dry-run`）：往 `$DSH_HOME/cordis.patch.yml` 写 mcp-client 行 → 工具以 `mcp__agentmemory__*` 暴露；`--with-hooks` 可加装原生捕获插件。

**对 Mission Memory 的可借鉴设计**：
1. **捕获→压缩→检索管线**：观察先入 spool（离线可恢复），压缩成结构化记忆（concepts/facts/files/importance），再进检索面。
2. **隐私过滤**（`src/functions/privacy.ts`）：入账前脱敏。与 Mission schema 的 `PRIVACY_FORBIDDEN_FIELDS` 同思路，可对照补强。
3. **smart-search 分层**：lessons（跨会话教训）与 results（观察命中）分列返回。
4. **单写入者纪律**：与 `docs/research/memory-systems.md` 的结论一致，Mission Memory 必须保持唯一写入者。
5. **agent-id 隔离/项目隔离**：检索按 project + agent 限定，防止串台。

**不引入的理由**（维持 ADR-0005）：独立引擎进程 + 端口 + token + 原生二进制分发，与"单一事实源、零第三方 Memory Provider"的既定立场冲突；且其事件捕获是自建第二事实源，与 repo-map.md 铁律冲突。

## 3. DeepSeek SDK Client 真机验证（关键）

**环境**：干净依赖树（`/tmp/dsh-research-20261105/harness-spike2`；`@deepseek-ai/dsh@0.2.1-rc.5` + `@deepseek-ai/dsh-sdk-client@0.0.1-rc.1`）+ 隔离 `DSH_HOME=/tmp/dsh-home-spike2` + 清空宿主注入环境变量。

**Provider 路由**（用户提供的当日新 StepFun key，未使用任何已配置 key）：
- `DEEPSEEK_BASE_URL=https://api.stepfun.com/step_plan/v1`（chat completions 兼容网关）
- `DEEPSEEK_API_KEY=<用户当日提供>`（仅存在于该次进程 env，未落盘）
- 模型 `step-5-preview`；机制：`dsh-llm-deepseek-api-key` 对非官方端点停用 models listing，**模型 ID 直通**。

**测试 1 — 纯问答**：握手 450ms → `run()` 1.6s → 事件流 14 条、12 种类型（`turn/start → step/start → system/message → user/message → request/header → request/context → session/title → assistant/message → step/end → turn/end`）→ 模型回答正确（"2"）。

**测试 2 — 工具调用循环**：56 条事件、7 组 `tool/call → tool/result`、8 步 agent loop，模型在工具报错后自主换策略（相对路径→绝对路径→`ls`）——**错误传播与重试语义在事件流中完整可见**。工具执行本体因测试环境无 PTY 失败（`PTY backend startup failed`，桌面真机不受影响，见 §5）。

**事件面结论**：`HarnessSession.run()` 返回结构化结果与类型化事件——**足够重建任务时间线，Phase 3 任务检查器可直接消费**。⚠️ 注意 0.2.2 起 `run()` 的语义是"订阅 + 聚合成败"而非实时推送，实时态须走 `onNotification`（详见 §4.6 语义修正）。

## 4. ACP 搁置证据（0.2.1 基线，已被 §4.5 部分推翻）

`@deepseek-ai/dsh-acp@0.0.1-rc.1` 的依赖闭包缺 `@deepseek-ai/dsh-type-meta`（npm registry 404），`require` 失败。

## 4.5 dsh 0.2.2-rc.1 增补验证（2026-11-05 下午，用户指出上游已发 0.2.2）

**版本事实**（npm registry + 官方 GitHub `deepseek-ai/deepseek-harness` release 页）：
- `@deepseek-ai/dsh@0.2.2-rc.1`（2026-11-04 发布，dist-tag `next`；`latest` 仍为 0.2.1-rc.5）。**桌面构建产物存在**：`dsh-tauri/deepseek-harness-pkg` 同日发布 0.2.2-rc.1 构建（macOS/Linux/Windows 共 14 个 assets），但**均为 ZIP / asar.zip 归类包，无签名的 DMG/EXE/MSI 安装器**——准确表述是"有 ZIP 构建产物、无正式签名安装包"（§4.5 初稿写"无桌面安装包"，已按 GPT 指正修正）。
- **cordis 约束反转**：0.2.2 要求 `@deepseek-ai/cordis ~4.1.0`（0.2.1 是 ~4.0.5）——E3 红线方向翻转，两代不可混装。
- **Node ≥24.9 硬要求**（engines `node >=24.9.0`）。本机 Node 22.22.2 / brew node 23.11 均不满足；已下载独立 Node 24.22.2 到 `/tmp/dsh-research-20261105/node24/` 完成隔离验证。**DshCockpit 若升 0.2.2，Harness 子进程必须配 Node 24 运行时**（Electron 主进程 Node 22 不受影响，两者是独立进程）。

**验证环境**：`/tmp/dsh-research-20261105/harness-spike3`（Node 24.22.2 + dsh/sdk-client/acp 全 0.2.2-rc.1 + cordis 4.1.0）+ 隔离 `DSH_HOME=/tmp/dsh-home-spike3`。

**测试 1 — SDK 握手**：`DeepSeekHarness` → `dsh --profile sdk-minimal`，冷启动握手 1391ms，`CLOSED_OK`。✅

**测试 2 — ACP 端到端**（0.2.1 时代的搁置项）：
- `@deepseek-ai/dsh-acp@0.2.2-rc.1` 依赖闭包**完整**（不再需要 `dsh-type-meta`；`dsh-brand`/`dsh-llm`/`dsh-agent`/`dsh-session`/`dsh-attachment`/`dsh-mcp-client`/`dsh-token-meter`/`dsh-user-approval`/`dsh-session-persistence` 均 0.2.2-rc.1 在册）。
- `dsh --profile acp` 协议冒烟：`initialize`（706ms，agentInfo `deepseek-harness-acp`）→ `session/new`（981ms，返回 sessionId + configOptions 模型选择器）→ `session/list`（OK）。✅
- 注意：ACP 是 cordis 插件形态（exports: Config/apply/inject/name），经 profile bundle 加载，不做独立库 import。

**测试 3 — 0.2.2 SDK 能力面**：`DeepSeekHarness` 新增 `resumeSession/record/matchesReceipt/result/run`；`run()` 内部改用 `subscribeSessionTree`（事件树订阅）。官方 release 说明确认 TS/Python SDK 补齐**计划审阅、目标续跑、操作审批**回调——与 Phase 1 任务闭环、Phase 3 检查器直接对齐。

**0.2.2 对本重构计划的其他关键影响**：
1. 官方把「自动化任务」升级为**宿主级统一管理**（手动创建/编辑/复用或新建会话执行）——与 Mission Workstream 语义部分重叠。DshCockpit 的差异化须更聚焦"记忆 + 检查 + 呈现"，避免复刻官方任务管理 UI。
2. Session API 新增独立接口：快照、事件日志、运行状态、事件投影**分别订阅**——Phase 3 检查器的数据源更干净。
3. 迁移注意：headless 默认只读环境变量/.env（不读已保存密钥）；PTC SSH 协议 2→3；`apply_patch` 默认关闭；自定义插件需适配异步 Session Projection。

## 4.6 dsh 0.2.2-rc.1 真机执行验证（2026-11-05 傍晚，用户提供的 StepFun key，仅注入测试进程）

> 对 GPT 第二轮意见的正面回应：握手通过 ≠ 生产能力。本节把"真实模型调用 / 文件读写 / 工具循环 / 事件流 / 取消面"全部实测，并用真实事件样本替代推断。

**环境**：`/tmp/dsh-research-20261105/harness-spike3`（Node 24.22.2 + dsh/sdk-client 0.2.2-rc.1）+ `DSH_HOME=/tmp/dsh-home-spike3` + 工作目录 `/tmp/dsh-research-20261105/spike3-workdir`；`DEEPSEEK_API_KEY=<用户当日提供>` 仅在该进程 env 中，未落盘、未写入任何配置。原始事件流保存在 `results/*.jsonl`，脱敏样本见 `results/session-event-sample-022.md`。

**测试 1 — 纯问答（无工具）** ✅

| 指标 | 值 |
|---|---|
| 握手 | 334 ms（冷启动，含 profile 组装） |
| 端到端 | 2 152 ms |
| 通知 / 事件 | 15 / 13 |
| finishReason | `completed` |
| finalResponse | `"2"` |
| 事件序列 | `agent/inbox/spliced → turn/start → agent/inbox/spliced → step/start → system/message → user/message ×2 → request/header → request/context → session/title → assistant/message → step/end → turn/end` |

**测试 2 — 工具循环 + 文件读写** ✅

| 指标 | 值 |
|---|---|
| 端到端 | 7 159 ms |
| 通知 / 事件 | 25 / 23 |
| 工具调用 | **2 组** `tool/call → tool/result`（`read` secret-note.txt → `write` result.txt） |
| agent loop | 3 个 `step` |
| finishReason | `completed` |
| 副作用实证 | 磁盘上 `result.txt` 内容为 `BANANA_42`，与模型回答一致 |

**事件信封实测结构**（Phase 3 检查器的直接输入）：

```json
{ "type": "tool/call", "seq": 11, "time": 1793872345320,
  "data": { "turn": 1, "step": 1, "callId": "chatcmpl-tool-…",
            "name": "read", "arguments": "{\"file_path\":\"…/secret-note.txt\"}" } }
```

- `tool/result` 与 `tool/call` 通过 `callId` 关联，天然可做调用配对与耗时计算。
- `request/header` 携带 `config.provider` / `config.model` / `maxTokens` 与**完整工具清单**（名称 + description + JSON Schema）——模型实际可见的能力面在事件流里可审计。
- `step/start` / `step/end` 构成可嵌套的时间轴，`turn/start` / `turn/end` 给出轮次边界；`session.status`（running/idle）是独立的通知方法，**不是** `session.event`。

**0.2.2 SDK 语义修正（三条，均实测/源码确认，推翻本文早期表述）**：

1. **`launch` 选项在 0.2.2 已被忽略**。`DeepSeekHarness` 现在只认具名选项：`profile` / `patches` / `dshHome` / `env` / `dshBin`（客户端侧）+ `cwd` / `provider` / `model` / `reasoningEffort` / `maxTokens` / `approvalRequests`（会话侧）。照抄 0.2.1 的 `launch: { args: [...] }` 会**静默丢弃 `--patch`**，表现为"provider 未注册"而非报错——排查耗时极长（本次实测踩中）。
2. **`run()` 不是推送，是聚合**。`run()` 内部 `subscribeSessionTree(id)` 后等 `session.query.completed`，把该区间的事件聚合成 `{finalResponse, finishReason, events}` 返回；**实时性必须走 `onNotification` / `subscribeSessionTree`**。因此 Phase 1 的 UI 实时态与 Phase 3 的回放态要用两套取数方式，不能混为一谈。
3. **SDK Client 无会话级取消**。`@deepseek-ai/dsh-sdk-client@0.2.2-rc.1` 源码中 `cancelRequest` / `$/cancel` 出现次数为 **0**；可用的 JSON-RPC 方法只有 `command/run`、`command/done`、`session/prompt`、`session/query`、`session/resume`。ACP 侧则通过 **JSON-RPC 请求中止**实现取消（`requestSignal` abort → `cancelPrompt` → `stopReason: "cancelled"`）。**结论：若"中断正在执行的任务"是硬需求，SDK 单通道不足，需要 ACP 或自建中断路径（进程级 kill + 会话恢复）。**

**0.2.2 自定义 provider 路由（踩坑后确认的唯一可行路径）**：

- `dsh-llm-deepseek` 在 0.2.2 已是**只支持 Messages 协议**的适配器，源码明确拒绝 `protocol` 覆盖（"protocol is not configurable; remove it and use a Messages-compatible baseURL"），默认端点为 `https://api.deepseek.com/anthropic`。StepFun 这类 **chat-completions 兼容网关无法用它接入**。
- 正确路径是 `@deepseek-ai/dsh-llm-pi-ai`：`api: openai-completions` + `baseURL` + 自声明 `models`。
- 该插件**必须先用 `dsh plugin --profile <name> add @deepseek-ai/dsh-llm-pi-ai` 装进 profile**（写入 profile 的 `dependencies` 并由 pnpm 建独立 `node_modules`）；只写 `--patch` 插入行会因解析不到包而**静默不激活**（无任何 stderr 输出）。
- `--patch` 的 `insert` 字段是**数组**（`insert: [ {id,name,config} ]`），写成映射会抛 `patch.insert?.forEach is not a function`。
- `sdk-minimal` 的 `tool-fs` 默认 `read/write/edit: false`——**文件工具默认关闭**，做写文件任务必须在补丁里显式打开。


## 5. 环境坑（后续任何本地/真机测试必读）

| # | 坑 | 症状 | 解法 |
|---|---|---|---|
| E1 | 宿主经 `NODE_OPTIONS`/`PYTHONPATH` 注入语言 shim，劫持 fs `mkdir` | 原生服务/CLI 静默挂起或 `Brokered host mkdir requires an available runtime file rule` | 命令前缀 `env -u NODE_OPTIONS -u PYTHONPATH` |
| E2 | shell `mkdir` 被 brokered-bin shim 劫持 | 同上报错 | 用 `/bin/mkdir` 等系统真实路径 |
| E3 | dsh 对 cordis 版本极敏感，且**两代约束相反** | 0.2.1 混入 cordis 4.1.0 → 崩溃；0.2.2 要求 cordis ~4.1.0 | 0.2.1 锁 `~4.0.5` 全家桶 / 0.2.2 锁 `~4.1.0`；两代依赖树不得混装 |
| E4 | 桌面版独占默认 `~/.dsh` | CLI profile 初始化冲突/挂起 | 测试一律 `DSH_HOME` 隔离 |
| E5 | 工具 shell 无 PTY | dsh bash 工具 `PTY backend startup failed` | 桌面真机或带 TTY 会话验证工具执行本体 |
| E6 | 全量测试并发下 `mcp-verify-gate` debounce 偶发 | 单独复跑 8/8 过 | 已知时序问题，非缺陷（2026-11-04 基线） |
| E7 | 0.2.2 SDK 忽略 `launch` 选项 | `--patch` 被静默丢弃，报 `no adapter registered for provider "stepfun"` | 用 0.2.2 具名选项：`profile` / `patches` / `dshHome` / `env` |
| E8 | 自定义 LLM 插件未装进 profile | `--patch` 插入行静默不激活（stderr 全空） | `dsh plugin --profile <name> add <pkg>`，再看 `--dump-config` 是否含该行 |
| E9 | `--patch` 的 `insert` 写成映射 | `TypeError: patch.insert?.forEach is not a function`（启动即崩） | `insert` 必须是数组 |
| E10 | `sdk-minimal` 的 `tool-fs` 默认只读 | 模型无 `read`/`write`/`edit` 工具，任务跑偏 | 补丁里显式 `read/write/edit: true` |
| E11 | 会话 artifact 压缩模式不匹配 | `session.v4.jsonl.zstd uses .jsonl.zstd, but this backend is configured for compression "none"` | 换独立 `DSH_HOME` 或清理旧 `sessions/` 目录 |

## 6. 未验证项（诚实清单）

- SDK Client 的 approval/userQuestions 回传面（0.2.2 官方已支持操作审批回调，本次未触发交互式审批路径）。
- **任务执行中的中断**：SDK 无会话级取消（§4.6），"进程级 kill + `resumeSession` 续跑"这条降级路径未实测。
- 长 turn / 上下文压缩 / 断线重连后的 session 续跑（`resumeSession` 只做了 API 存在性确认）。
- ACP 的 `session/prompt` 真机执行（本轮只验证到 `session/new` / `session/list`，未消耗模型调用）。
- StepFun 网关的流式中断、限流行为（本次两次真机调用均一次成功）。
- 0.2.2 转正（进 `latest` tag）后的最终迁移面；rc 期间 API 仍可能变化。

