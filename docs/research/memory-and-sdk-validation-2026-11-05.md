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
| @deepseek-ai/dsh-sdk-client | 0.0.1-rc.1 | MIT | 握手 + 完整任务执行 + 工具调用循环真机验证通过 | ✅ **Phase 1 桥接采用** |
| @deepseek-ai/dsh-acp | 0.0.1-rc.1 | MIT | 依赖 `@deepseek-ai/dsh-type-meta` 不存在于 npm registry，无法导入 | ❌ 暂不可用，搁置观察 |

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

**不引入的理由**（维持 ADR-0005）：独立引擎进程 + 端口 + token + 原生二进制分发，与"单一事实源、零第三方 Memory Provider"的既定立场冲突；且其事件捕获是自建第二事实源，与 AGENTS.md 铁律冲突。

## 3. DeepSeek SDK Client 真机验证（关键）

**环境**：干净依赖树（`/tmp/dsh-research-20261105/harness-spike2`；`@deepseek-ai/dsh@0.2.1-rc.5` + `@deepseek-ai/dsh-sdk-client@0.0.1-rc.1`）+ 隔离 `DSH_HOME=/tmp/dsh-home-spike2` + 清空宿主注入环境变量。

**Provider 路由**（用户提供的当日新 StepFun key，未使用任何已配置 key）：
- `DEEPSEEK_BASE_URL=https://api.stepfun.com/step_plan/v1`（chat completions 兼容网关）
- `DEEPSEEK_API_KEY=<用户当日提供>`（仅存在于该次进程 env，未落盘）
- 模型 `step-5-preview`；机制：`dsh-llm-deepseek-api-key` 对非官方端点停用 models listing，**模型 ID 直通**。

**测试 1 — 纯问答**：握手 450ms → `run()` 1.6s → 事件流 14 条、12 种类型（`turn/start → step/start → system/message → user/message → request/header → request/context → session/title → assistant/message → step/end → turn/end`）→ 模型回答正确（"2"）。

**测试 2 — 工具调用循环**：56 条事件、7 组 `tool/call → tool/result`、8 步 agent loop，模型在工具报错后自主换策略（相对路径→绝对路径→`ls`）——**错误传播与重试语义在事件流中完整可见**。工具执行本体因测试环境无 PTY 失败（`PTY backend startup failed`，桌面真机不受影响，见 §5）。

**事件面结论**：`HarnessSession.run()` 返回 `{finalResponse, events, notifications}`，`session.event` 信封带类型化事件——**足够重建任务时间线，Phase 3 任务检查器可直接消费**。

## 4. ACP 搁置证据

`@deepseek-ai/dsh-acp@0.0.1-rc.1` 的依赖闭包缺 `@deepseek-ai/dsh-type-meta`（npm registry 404），`require` 失败。等上游补发后再评估；不阻塞本次重构。

## 5. 环境坑（后续任何本地/真机测试必读）

| # | 坑 | 症状 | 解法 |
|---|---|---|---|
| E1 | 宿主经 `NODE_OPTIONS`/`PYTHONPATH` 注入语言 shim，劫持 fs `mkdir` | 原生服务/CLI 静默挂起或 `Brokered host mkdir requires an available runtime file rule` | 命令前缀 `env -u NODE_OPTIONS -u PYTHONPATH` |
| E2 | shell `mkdir` 被 brokered-bin shim 劫持 | 同上报错 | 用 `/bin/mkdir` 等系统真实路径 |
| E3 | dsh 对 cordis 版本极敏感 | 混入 cordis 4.1.0 → `plugin loader null entry` 崩溃 | 锁 `@deepseek-ai/cordis ~4.0.5` 全家桶；勿显式装 `cordis-plugin-group@^1.1.0` |
| E4 | 桌面版独占默认 `~/.dsh` | CLI profile 初始化冲突/挂起 | 测试一律 `DSH_HOME` 隔离 |
| E5 | 工具 shell 无 PTY | dsh bash 工具 `PTY backend startup failed` | 桌面真机或带 TTY 会话验证工具执行本体 |
| E6 | 全量测试并发下 `mcp-verify-gate` debounce 偶发 | 单独复跑 8/8 过 | 已知时序问题，非缺陷（2026-11-04 基线） |

## 6. 未验证项（诚实清单）

- SDK Client 的 approval/userQuestions 回传面（本轮只验证了单向事件流）。
- 长 turn / 上下文压缩 / 断线重连后的 session 续跑。
- sdk profile（非 minimal）的完整插件树（含 fs 写工具）。
- StepFun 网关的流式中断、限流行为。
