# Brief 跨会话生效验证（P1 最后一项，2026-11-01）

> 探针：`scripts/acceptance/brief-cross-session-acceptance.js`（**8/8 通过**）
> 证据：[`acceptance/brief-cross-session-acceptance-2026-11-01.json`](acceptance/brief-cross-session-acceptance-2026-11-01.json)

## 0. 结论

**P1 的最后一个未验证项已完成。**

写一个随机暗号进 `<workspace>/AGENTS.md`，然后开一次真实 Agent 会话，
问它暗号是什么 —— **模型答对了**。

暗号是 `ZEBRA-<随机 hex>`，不可能从别处推断。答对 ⇒ 它真的读了那个文件。

## 1. 四层证据全部到位

| 层次 | 状态 | 依据 |
|---|---|---|
| Brief 写入正确 | ✅ | 143 项离线测试 + 真实调用 `syncToWorkspace` |
| 官方读 `<root>/AGENTS.md` | ✅ | 源码 `dsh-agent-instructions` |
| 读取时机是会话启动 | ✅ | 同上，有 `session/created` 集成点 |
| **真实模型据此回答** | ✅ **本轮完成** | 8/8 真机验收 |

## 2. 怎么做到的（协议考古）

上一轮我卡在 `session/create` 返回 405。这轮把 0.2.1-rc.5 的协议查清了：

**关键发现 1：unary 与 stream 是两条不同的通道**

```
unary  → HTTP POST /api/<endpoint>    body: {type:'client-request', rpcId, method, payload:{args}}
stream → WS /api/remote.mux           帧: open / item / end / cancel（仅 4 种）
```

我第一版试图用 WS 的 `open` 帧调 `session/list`，服务端明确拒绝：

> "typert gateway: session/list: **unary Remote methods cannot be opened through the stream carrier**"

**关键发现 2：args 必须包 `_request`**

`session/list` 需要 `args: {_request: {}}`。缺了会报
`missing "_request"`。这是 schema 强制的。

**关键发现 3：`session/prompt` 的形状**

从官方 descriptor 的 `jsonSchema` 读出：

```js
{ requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text', text}] }
```

我第一版用的 `{address, prompt}` 是**另一套形状**，会 boundary validation 失败。

**关键发现 4：事件必须走 `session/follow` 流**

`session/page` 只能翻已固化的记录，模型产出的过程事件在 follow 流里。
第一版只轮询 page，永远只能看到 `seq=0` 的初始事件。

## 3. 一个很有代表性的失败

第一次跑通所有步骤时，7 项里 6 项 PASS，只有"模型答对"FAIL。

检查发现：`session/prompt` 被接受、会话被创建、cookie 拿到——
**每一步都成功，但整条链路没通**。

根因：POC 的 `dsh-home` 有 `.credentials.yaml`（key 在），
但**没有 `settings.yaml`**（provider route 声明不在）。
于是没有模型可调用，事件流里只有初始事件。

> 这是"绿了一路但结果是错的"的典型案例。
> 所以探针必须**自己保证前置条件**，而不是假设环境已配好。

## 4. 验收结果（8 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | Brief 写入 AGENTS.md | `sync=true action=appended` |
| 2 | 用户内容不被覆盖 | ok |
| 3 | 隔离 runtime 有可用 provider | `stepfun/step-5-preview` |
| 4 | runtime 启动 | ok |
| 5 | 拿到 session cookie | ok |
| 6 | 在工作区创建会话 | `sessionId=session-25b176…` |
| 7 | prompt 被接受 | ok |
| 8 | **模型答出随机暗号** | **`the model echoed the token`** |

## 5. 顺带确认了两个真实风险

上一轮源码考古时发现的，本轮验证了它们的存在：

1. **项目根判定用 `.git`** —— 探针必须 `mkdir .git`，否则 AGENTS.md 可能不被加载
2. **1 MiB 上限** —— `brief-sync` 已加检查（超限拒绝写入）

`src/mission/brief-sync.js` 已对这两个风险加固：
- `inspectWorkspaceRoot()` 警告没有 `.git`
- 超 1 MiB 返回 `INSTRUCTION_TOO_LARGE`

## 6. 复现方式

```bash
# 需要 ~/.dsh/.credentials.yaml 里有 STEP_API_KEY
# 以及 0.2.1-rc.5 的 POC 环境
node scripts/acceptance/brief-cross-session-acceptance.js
```

## 7. P1 完成度

| 层 | 状态 |
|---|---|
| 纯逻辑 `src/mission/`（9 模块） | ✅ |
| IPC `src/ipc-mission.js`（20 action） | ✅ |
| UI `src/mission-desk.html`（18/20 覆盖） | ✅ |
| Brief 跨会话生效 | ✅ **本轮验证** |
| 真机验收 | 10/10 + 19/19 + **8/8** |

**P1 已无未验证项。**
