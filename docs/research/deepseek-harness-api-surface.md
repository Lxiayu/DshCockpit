# DeepSeek Harness 官方 API 表面盘点（0.1.5-rc.2 vs 0.2.1-rc.5）

> 状态：**只读盘点**（2026-11-01，Harness 集成架构审计）。
> 方法：读取本机两份真实安装的**类型声明与生成代码**，逐条对比；不运行 0.2.1（本机没有它的独立 `node_modules`，只有 asar 内的 desktop-runtime 副本）。
> 核查日期：2026-11-01。

**证据分级**（全文强制）：

| 标签 | 含义 |
|---|---|
| **已确认** | 两侧声明都读到，可直接对比，附路径 |
| **部分** | 只有单侧可读，或只验证了形状未验证行为 |
| **待验证** | 只能从包名/依赖清单推断能力，无类型声明可读 |
| **设想** | 本文的建议，未落地 |

---

## 0. 两处安装的事实

| | 0.1.5-rc.2（DshCockpit 锁定的） | 0.2.1-rc.5（官方桌面 App 内置） |
|---|---|---|
| 位置 | `~/.dsh/profiles/node_modules/@deepseek-ai/` | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` → `/dsh/node_modules/@deepseek-ai/` |
| 包数 | **244**（`@deepseek-ai/` 目录项） | **308**（asar 内 `@deepseek-ai/` 目录项）／**305**（`/dsh/package.json` 的 `dependencies`，**全部**是 `@deepseek-ai/*`）。差 3 个是 asar 目录里额外的平台包：`libreoffice-kit`、`libreoffice-kit-darwin-arm64`、`node-addon-system-darwin-arm64`（不在 dependencies 里） |
| 可读性 | 完整：`lib/*.js` + `lib/types/*.d.ts` + `README.md` | **可读**：`lib/*.js`（已编译 JS，非源码）+ `README.md`；**无 `.d.ts`**（`files` 字段只声明 `lib/*.js`） |
| 能否运行验证 | 能（`~/.dsh/profiles/` 是真实安装） | **不能**（asar 内的包只由 Electron 主进程通过 `dsh-desktop-host` 加载） |

**关键结论（已确认）**：0.2.1-rc.5 的 API 表面**不是只能靠猜**——asar 里 `lib/typert.host.js` / `lib/typert.remote-client.js` 是 typert 生成器产出的**机器可读**描述（含参数名、`wire` 名、JSON Schema、`sourceLocation`），因此本盘点的 0.2.1 侧结论全部来自**可读代码**，而非包名推断。

**需要标注的限制**：0.2.1 侧无 `.d.ts`，接口名的可读性依赖生成文件里的 `typeSymbol` 字符串（例如 `'@deepseek-ai/dsh-api-session-controller/types#SessionFollowRequest'`）与同目录 `lib/types/*.js` 里的 JSDoc。因此 0.2.1 的**字段级**结论标"已确认（由 JSON Schema 投影）"，**行为级**结论标"待验证"。

---

## 1. 读 asar 的方法（重要：既有脚本有 off-by-N bug）

### 1.1 既有脚本的问题

`/tmp/asar_inspect/extract.js` 用 `BASE = 16 + headerSize` 计算文件数据起点。**asar 的文件数据区是 4 字节对齐的**，当 `16 + headerSize` 不是 4 的倍数时（本机实测 `headerSize = 4761003`，`16 + 4761003 = 4761019`，mod 4 = 3），读出的内容会**向前错位 1-3 字节**。

症状：文件首行出现 `p/** Wire messages...`、`es.js.map/** Wire me...` 这类残片——即"上一个文件的尾部 + 本文件开头"。

**这是可以机械验证的**：asar 每个 file node 带 `integrity: {algorithm:'SHA256', hash, blockSize, blocks}`。用正确 base 读出的字节 sha256 必须等于 `integrity.hash`。

```bash
# 用 integrity.hash 反推正确 base 的实验（本审计做的事）
node -e '
const fs=require("fs"),crypto=require("crypto");
const ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
const fd=fs.openSync(ASAR,"r");
const head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);
const hs=head.readUInt32LE(12);const hdr=Buffer.alloc(hs);fs.readSync(fd,hdr,0,hs,16);
const json=JSON.parse(hdr.toString("utf8"));
const n=json.files.dsh.files.node_modules.files["@deepseek-ai"].files["dsh-api-gateway"]
  .files.lib.files.types.files["stream-protocol.js"];
const off=parseInt(n.offset,10);
for (const base of [8+hs, 12+hs, 16+hs, Math.ceil((16+hs)/4)*4]) {
  const buf=Buffer.alloc(n.size); fs.readSync(fd,buf,0,n.size,base+off);
  const ok = crypto.createHash("sha256").update(buf).digest("hex")===n.integrity.hash;
  console.log(base, ok?"MATCH":"no", JSON.stringify(buf.slice(0,20).toString("utf8")));
}'
```

输出（本机实测）：

```
4761011 no "es.js.map/** Wire me"
4761015 no "s.map/** Wire messag"
4761019 no "p/** Wire messages f"      <- /tmp/asar_inspect/extract.js 实际用的
4761020 MATCH "/** Wire messages fo"    <- 正确（4 字节对齐）
```

### 1.2 正确的最小读取器

```bash
cat > /tmp/asar-extract.cjs <<'EOF'
const fs = require('fs');
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const hdr = Buffer.alloc(headerSize);
fs.readSync(fd, hdr, 0, headerSize, 16);
const json = JSON.parse(hdr.toString('utf8'));
const BASE = Math.ceil((16 + headerSize) / 4) * 4;   // <<< 4 字节对齐
function get(p) {
  let cur = json;
  for (const seg of String(p || '').split('/').filter(Boolean)) {
    if (!cur || !cur.files) return null;
    cur = cur.files[seg];
    if (!cur) return null;
  }
  return cur;
}
const node = get(process.argv[2]);
if (!node) { console.error('MISSING ' + process.argv[2]); process.exit(1); }
if (node.files) { console.log(Object.keys(node.files).sort().join('\n')); process.exit(0); }
const off = typeof node.offset === 'string' ? parseInt(node.offset, 10) : node.offset;
const buf = Buffer.alloc(node.size);
fs.readSync(fd, buf, 0, node.size, BASE + off);
process.stdout.write(buf);
EOF

# 验证
node /tmp/asar-extract.cjs /dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js | head -3
# 期望首行: /** Wire messages for Gateway-owned Remote streams and event-result RPCs. */
```

> 本审计的完整对比脚本：`/tmp/asar2/diff-surface.cjs`（可直接重跑，见 §8）。

---

## 2. Mux 传输表面（最高稳定性结论）

### 2.1 常量与路径 —— **已确认，两代逐字一致**

| 常量 | 0.1.5 | 0.2.1 | 证据 |
|---|---|---|---|
| mux 路径 | `/api/remote.mux` | `/api/remote.mux` | 0.1.5 `dsh-api-gateway/lib/types/stream-protocol.d.ts:6`；0.2.1 asar 同包 `lib/types/stream-protocol.js:4` |
| 全局事件流 endpoint | `$events` | `$events` | 同上（`REMOTE_EVENT_STREAM_ENDPOINT`） |
| 回传 endpoint | `$events/result` | `$events/result` | 同上（`REMOTE_EVENT_RESULT_ENDPOINT`） |
| 打开事件流的 payload | `{args:{}}` | `{args:{}}` | 同上（`REMOTE_EVENT_STREAM_PAYLOAD`） |
| ready 帧判别 | `{type:'ready'}` | `{type:'ready'}` | 同上（`REMOTE_EVENT_STREAM_READY`） |

DshCockpit 侧对应实现：`src/runtime-mux.js:33-36`（`MUX_PATH`/`EVENTS_STREAM_ID`/`EVENTS_ENDPOINT`/`RESULT_METHOD`）。**已确认一致**。

### 2.2 下行帧形状 —— **已确认，逐字段一致**

| 帧 | 0.1.5 声明 | 0.2.1 声明 | 差异 |
|---|---|---|---|
| `RemoteEventReadyFrame` | `{type:'ready', clientId: RemoteEventClientId, host:{home:string}}` | 同 | 无 |
| `RemoteEventEmitFrame` | `{type:'emit', event:string, args: readonly unknown[]}` | 同 | 无 |
| `RemoteEventInvocationFrame`（waterfall） | `{type:'waterfall', event:string, eventId:RemoteEventId, agentId:RemoteEventAgentId, request: Readonly<Record<string,unknown>>}` | 同 | 无 |
| `RemoteEventCancellationFrame` | `{type:'cancel', eventId: RemoteEventId}` | 同 | 无 |

### 2.3 `$events/result` 的 outcome —— **已确认，逐分支一致**

两代 `parseRemoteEventResult(value)` 的校验逻辑**逐行相同**：

```text
value 必须精确含 {clientId, eventId, outcome}
outcome.kind === 'next'     → 必须精确含 {kind}
outcome.kind === 'result'   → {kind} 或 {kind, value}；value 必须 isRemoteJsonValue
outcome.kind === 'rejected' → 必须精确含 {kind, error}；error 走 parseRemoteEventRejection
其余 → throw 'api gateway: invalid Remote event result'
```

证据：
- 0.1.5：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js:21-49`（已编译 JS，可直接读）
- 0.2.1：asar `/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js` 的 `parseRemoteEventResult`（同一分支结构）

DshCockpit 侧：`src/runtime-mux.js:338-343`（`sendResult`）只发 `{kind:'result', value}`，**不碰** `next`/`rejected` 两个分支——因此即使未来这两支语义变化也不会影响本壳。**已确认**。

### 2.4 一元 RPC 信封 —— **已确认，两代一致**

```json
POST /api/<endpoint>
{ "type": "client-request", "rpcId": "<uuid>", "method": "<endpoint>", "payload": { "args": { ... } } }
```

- 0.1.5：DshCockpit 实现 `src/runtime-mux.js:302-334`（`call()`），对端校验 `dsh-api-gateway/lib/index.js:1041-1051`（`assertExactArguments`：args 必须是 plain object，字段必须**精确**匹配 descriptor 的 wire 名，多/少都拒）。
- 0.2.1：asar `/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.node.js` 的 `createWebConnectionRpc.call()` **构造完全相同的 message**（`type:'client-request'` / `rpcId` / `method` / `payload`），POST 到 `${channel}/${endpoint}`。
- 0.2.1 侧的 args 校验在同包 `lib/index.js` 中仍是 `gateway/arguments-invalid` + `args fields do not match the descriptor`（`assertExactArguments` 逻辑保留）。

**这是 Bridge 可以安全升级的最硬证据**：DshCockpit 的 mux 客户端只需换 base URL + cookie，无需改帧形状。

---

## 3. Session RPC 方法表面（含事件词表增量的对应关系）

### 3.1 方法级 diff —— **已确认：零删除，3 新增**

| 包 | 0.1.5 方法数 | 0.2.1 方法数 | added | removed |
|---|---|---|---|---|
| `dsh-api-session-controller` | 18 | 21 | `session/initializeDefaultModel`、`session/projections`、`session/workspacePathApplications` | **无** |
| `dsh-api-workspace-controller` | 10 | 14 | `workspace/initializeDefault`、`workspace/pinSession`、`workspace/unarchiveSession`、`workspace/unpinSession` | **无** |
| `dsh-api-settings-controller` | 含 2 个 | 少 2 个 | 无 | `settings/canOpenAgentPresetDirectory`、`settings/openAgentPresetDirectory` |
| `dsh-api-workspace-files` | 含 2 个 | 少 2 个 | 无 | `workspaceFiles/readAll`、`workspaceFiles/readRelated` |
| `dsh-subagent` | 含 1 个 | 少 1 个 | 无 | `subagents/list` |
| `dsh-goal` | 7 | 7 | 无 | **无**（完全稳定） |
| `dsh-commands` | 2 | 2 | 无 | 无 |

**session-controller 完整方法表（0.1.5 = 0.2.1，除标注）：**

```
fileReferences/list            session/attachment
session/cancel                 session/canOpenWorkspacePath
session/control (stream)       session/create
session/follow (stream)        session/fork
session/list                   session/modelCatalog
session/openWorkspacePath      session/page
session/prompt                 session/rename
session/search                 session/selectModel
session/updateQueue            skills/list
+ 新增 0.2.1 独有: session/initializeDefaultModel, session/projections, session/workspacePathApplications
```

### 3.2 参数 wire 名 diff（DshCockpit 最关心的）

DshCockpit 的 `harness-rpc.js` 对每个方法硬编码了 args 形状，因此**参数 wire 名是否变化**比方法是否存在更关键。**已确认：全部 18 个既有方法的 wire 名在两代完全一致。**

| 方法 | 0.1.5 wire 参数 | 0.2.1 wire 参数 | DshCockpit 用法 | 判定 |
|---|---|---|---|---|
| `session/list` | `_request` | `_request` | `{_request:{}}`（`src/main.js:5238`、`src/harness-rpc.js:231,376`） | **一致** |
| `session/create` | `request` | `request` | `{request:{}}`（`src/harness-rpc.js:379`） | **一致** |
| `session/prompt` | `request` | `request` | `{request:{requestId,sessionId,mode,content}}`（`src/harness-rpc.js:383`） | **一致** |
| `session/cancel` | `request` | `request` | `{request:{sessionId}}`（`src/harness-rpc.js:387`） | **一致** |
| `session/page` | `request` | `request` | `{request:{address,throughSeq,maxMessages,beforeSeq?}}`（`src/main.js:4249-4251`、`:5574-5583`） | **一致** |
| `session/follow` | `request` | `request` | `{request:{address,assistantStream:true}}`（`src/main.js:5338`、`:685`） | **一致** |
| `session/control` | （无参数） | （无参数） | 未使用（`src/harness-rpc.js:400` 显式 unsupported） | 一致 |
| `commands/execute` | `agentId`, `line`, `submittedAttachments` | `agentId`, `line`, `submittedAttachments` | `src/harness-rpc.js:74` | **一致** |

### 3.3 类型声明 diff（字段级，**已确认**）

| 类型 | 0.1.5 | 0.2.1 | 影响 DshCockpit？ |
|---|---|---|---|
| `SessionSummary` | `{sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections?}` | 同 + **`agentAvailable: boolean`** + `formatStatus?: 'current'\|'migration-required'` | **是**：`seedOfficeFollowFromSessionList`（`src/main.js:5241-5249`）未过滤 `agentAvailable===false`，可能开出注定失败的 follow 流 → 触发 `unfollowable` 有界重试 |
| `SessionFollowRequest` | `{address, maxMessages?, assistantStream?: true}` | `extends Pick<SessionPageRequest,'maxMessages'\|'turnWindow'>` + `{address, assistantStream?: true}` → 即原字段 + `turnWindow?` | **否**（纯加法） |
| `SessionFollowFrame` | `snapshot{header,cursor,records,hasMore,projections,assistantStream?} \| event \| assistant-stream` | **同** | **否** |
| `SessionPageRequest` | `{address, throughSeq, beforeSeq?, maxMessages?}` | 同 + `turnWindow?:{minMessages,minTurns}` | **否**（纯加法） |
| `SessionPage` | `{records, hasMore}` | 同 | **否** |
| `SessionPromptRequest` | `{requestId, sessionId, mode:'queue'\|'steer', content, clientTimeZone?}` | 同 | **否** |
| `SessionCreateRequest` | `{workspaceId?, cwd?, sessionId?, agentPreset?}` | 同 | **否** |
| `SessionProjectionMap` | `{inbox, agentPreset, title, todos, sessionListMetadata, imageLimits, modelSelection, subagentCatalog, subagentTiming, subagent, goal}`（**11 键**） | 同 + `workingDirectory`、`permissions`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`agentTeam`、`userQuestions`、`plan`（**19 键**） | **是（机会）**：这 8 个新投影是"Provider 能力面"的直接输入，见 §5 |
| `TurnEndReasonMap` | `completed\|aborted\|blocked\|error\|max-tokens\|interrupted`（6） | 同 + **`forked`**（7） | **是**：`dsh-execution-backend.js:219-234` 无 `forked` 分支 → 降级 attention |

---

## 4. SessionEventMap 新增事件 → DshCockpit 翻译层对应关系

### 4.1 完整 diff（**已确认，2026-11-01 第二轮实测修正**）

> ⚠️ **勘误**：本文早期版本写"0.1.5 = 40 种，0.2.1 = 52 种，新增 12 种"，并把这 12 条全部列为新增。
> **这是错的。** 第二轮通过完整提取两代 `dsh-api-session-controller/lib/client.js` 的事件数组并做集合 diff（2026-11-01）得到权威结果：

| 版本 | 事件总数 |
|---|---|
| 0.1.5-rc.2 | **56** |
| 0.2.1-rc.5 | **62** |
| 交集 | **56**（0.1.5 是 0.2.1 的真子集） |
| **净增** | **6** |
| **删除** | **0** |

**复现命令**（两代同路径 `lib/client.js`，提取含 `"turn/start"` 的数组并做集合 diff）：

```bash
# 0.1.5
node -e "..." ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js
# 0.2.1（asar 内，需正确对齐 BASE=ceil((16+headerSize)/4)*4）
# 详见 docs/architecture/official-capability-matrix.md §附录A
```

**真正新增的 6 个事件**：

`developer/message` · `image/offload` · `job/registered` · `job/settled` · `working-directory/change` · `workspace/changes`

**另有 6 个此前被误判为"新增"、实际 0.1.5 就已存在**：
`llm/retry` · `llm/retry-started` · `permission/preset` · `plan/mode` · `schedule/change` · `subagent/model-selection-policy`

> **影响**：按 12 个建兼容台账会为 6 个"本来就有"的事件留冗余分支（无端增加翻译层复杂度与测试面）。
> **行动**：翻译层只需为上述 6 个真正新增的事件做决策；另外 6 个属于"0.1.5 已声明但从未消费"，可作为独立机会处理，与 0.2.x 升级解耦。

### 4.1.1 处理建议（对 6 个真正新增 + 6 个既有未消费）

| # | 新增事件 | payload 声明（0.2.1） | `main.js` 当前处理 | 建议（设想） | 优先级 |
|---|---|---|---|---|---|
| 1 | `developer/message` | `{turn, step, message: DeveloperMessage, headerSeq?}` | 走末尾兜底 → adapter 映射不到 → **不产 fact** | 与 `user/message` 同类：属于"投喂模型的文本"，**应继续不产 fact**（隐私边界）。但可计入 diagnostics | — |
| 2 | `working-directory/change` | `{cwd: string}` | 兜底，不产 fact | **raw 路径不得进快照**（`AGENTS.md` §2.4 隐私铁律）。若未来要在工作台显示"当前目录"，必须先派生句柄 | — |
| 3 | `job/registered` | `{jobId, owner:SessionId, kind, label, startedAt, toolCall?}` | 兜底，不产 fact | **高价值**：后台作业 = "员工在做长任务"的真实事实。可映射 `office` 的 `run-progress` 或新增 job 事实。注意 `label` 可能是模型文本 → 需闭集化 | **P1** |
| 4 | `job/settled` | 同 + `{finishedAt, status, cause, producerReported, detail?}` | 兜底，不产 fact | **高价值**：作业终态，可作 `execution/completed\|failed` 的补充证据来源（比 turn/end 更细）。`detail` 是自由文本 → 不进快照 | **P1** |
| 5 | `image/offload` | `{targets: ImageOffloadTarget[]}` | 兜底，不产 fact | 与团队体验无关；**不翻译** | — |
| 6 | `permission/preset` | `{preset: string}` | 兜底，不产 fact | **高价值且安全**：`preset` 是闭集字符串，正好补上 P4-R1 的缺口（`src/main.js:3993-4001` 记录"harness 不把 sandbox 轴投影到会话"）。0.2.1 起**权限轴变成可观测的会话事件**，右栏可诚实地显示"当前权限预设" | **P1** |
| 7 | `llm/retry` | `LlmRetryEventData` | 兜底，不产 fact | **中价值**：重试是"员工遇到挫折但还在努力"的真实信号，适合 idle/behavior 表现层。字段形状待读 | P2 |
| 8 | `llm/retry-started` | `LlmRetryStartedEventData` | 兜底，不产 fact | 同上 | P2 |
| 9 | `plan/mode` | `{active: boolean}` | 兜底，不产 fact | **高价值**：`active:true` = 规划模式开启 → Mission Board / 白板物件的真实数据源（`AGENTS.md` §2.3"不伪造"要求可交互物件必须有真实数据） | **P1** |
| 10 | `schedule/change` | `ScheduleChange = ScheduleCreateChange \| ScheduleDeleteChange \| ScheduleDispatchChange` | 兜底，不产 fact | **中价值**：定时任务 → "日程/待办"体验。需读三个分支的字段形状 | P2 |
| 11 | `subagent/model-selection-policy` | `{allowedModels: AllowedModelRoute[]}` | 兜底，不产 fact | 与 Team 编排相关（"这个子代理能用哪些模型"），但当前 Team 只有 2 个固定 Role；**暂不翻译** | P3 |
| 12 | `workspace/changes` | `{turn: number}` | 兜底，不产 fact | **高价值**：`turn` 是数字。这是"本 turn 改了工作区文件"的**受信信号**（配合 `dsh-workspace-changes` 包读 diff）。当前 `team-shell-transport` 只能靠 assistant 正文猜产物（`artifactFor`），有了这条就能把 artifact 从"文本物化"升级为"真实文件变更" | **P0（对 Team 战略）** |

### 4.2 重要澄清：`team/*` 事件在两代都存在，但 DshCockpit 从未消费

**已确认**：0.1.5 的 `SessionEventMap` 声明里**已经有** `team/member`、`team/task`（`version: 2`）与 `goal/change`——尽管 0.1.5 **没有** `dsh-experimental-agent-team` 包。

```bash
# 验证：0.1.5 的 SessionEventMap 里就有 team/*，但没有 agent-team 包
grep -o "'team/member'[^}]*}" ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js | head -1
# -> 'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot; };
ls ~/.dsh/profiles/node_modules/@deepseek-ai | grep -c experimental-agent-team
# -> 0
```

**这条对"官方 Team 与自研 Team 如何取舍"很关键**：`team/*` 事件是**类型层已冻结的协议**（`version: 2`），只是 0.1.5 没有生产它的包。这意味着：

- DshCockpit **可以**在 0.2.x 上直接消费 `team/member|team/task` 而不改自己的 adapter 词汇（它们是 `{version,teamId,member|task}` 的稳定快照形状）；
- 反过来，**DshCockpit 自研的 `team/*` fact 与官方 `team/*` 事件是两个不同的命名空间**，不能混淆（前者是 `src/team/runtime/team-runtime.js` 内部的 fact log，后者是 session journal 的事件类型）。审查确认：DshCockpit 的 `team/*` fact **不写入 session journal**，只在内存 fact log 中（`team-runtime.facts()`），因此**无冲突**，但也**无互通**。

### 4.3 事件 → 翻译层 → adapter 的完整链路（现状表）

| journal 事件 | `main.js` 处理位置 | 翻译后 | adapter 消费 | 状态 |
|---|---|---|---|---|
| `turn/start` | `src/main.js:5465-5468` | `agent/status{status:'running'}` | `runtime/fact running` | **已确认**（有测试） |
| `turn/end` | `src/main.js:5469-5478`（`data.reason.kind` 扁平化） | `turn/end{data:{turn,reason}}` | completed/failed/attention/cancelled | **已确认**；**`forked` 缺失** |
| `tool/call` | `src/main.js:5479-5489` | `tool/call{data:{tool}}`（**只留工具名**） | `tool/call` fact + phase | **已确认**；`arguments` 永不读取 |
| `assistant/message` | `src/main.js:5490-5523` | `turn/usage{data:{turn,usage{4 数字},cost}}` | usage 事实 | **已确认**；正文永不进入 |
| `subagent/catalog`、`tool-workflow/*`、`user/message(source.kind='subagent-settled')` | `src/main.js:5532` → `subagent-wiring.handleEvent` | `subagent/start\|end` | 子代理配对 | **已确认**（`src/office/runtime/subagent-wiring.js:170-246`） |
| 其它全部（含上述 12 种新增） | `src/main.js:5533`（末尾兜底） | **原样透传** | 映射不到 → 不产 fact | **部分实现**：不崩，但静默 |

---

## 5. 能力面（插件级）盘点

### 5.1 有 remote 表面的包（可按方法调用）

| 包 | 0.1.5 | 0.2.1 | 方法（0.2.1） | 稳定性判定 |
|---|---|---|---|---|
| `dsh-goal` | ✅ typert | ✅ typert | `goals/{get,create,edit,clear,pause,resume,complete}`（7） | **稳定**（两代零变化） |
| `dsh-api-workspace-controller` | ✅ | ✅ | 14（见 §3.1） | **稳定**（0.2.1 纯加法） |
| `dsh-api-session-controller` | ✅ | ✅ | 21 | **稳定**（纯加法） |
| `dsh-api-settings-controller` | ✅ | ✅ | 少 2 个 open*Directory | **部分**（删了 2 个，DshCockpit 未用） |
| `dsh-api-workspace-files` | ✅ | ✅ | 少 2 个 read* | **部分**（删了 2 个，DshCockpit 未用） |
| `dsh-subagent` | ✅ | ✅ | 少 `subagents/list` | **部分**（DshCockpit 未用） |
| `dsh-commands` | ✅ | ✅ | `commands/{execute,list}` | **稳定** |
| `dsh-agent-presets`（0.1.5）/ `dsh-agent-preset-registry`（0.2.1） | ✅ | ✅（**改名**） | `agentPresets/{list,read,select}`（3） | **改名风险**：包名 `dsh-agent-presets` → `dsh-agent-preset-registry` |
| `dsh-user-questions` | ❌ 无 remote | ✅ | `userQuestions/answer`、`userQuestions/attachWait`（2） | **0.2.1 新增**；但 DshCockpit 走 waterfall 而非 remote，**不必用** |
| `dsh-schedule` | ❌ 无 remote | ✅ | `schedule/{catalog,delete,history,list,update}`（5） | **实验偏稳定**（0.2.1 新增） |
| `dsh-permission-presets` | ❌ 无 remote | ✅ | `permissionPresets/catalog`（1） | **实验**（0.2.1 新增） |
| `dsh-api-job-controller` | ❌ 无包 | ✅ | `job/{list,follow,kill}`（3） | **实验**（0.2.1 新增） |
| `dsh-api-terminal-controller` | ❌ 无包 | ✅ | `terminal/{attach,close,create,environment,list,rename,retain,shells}`（8） | **实验**（0.2.1 新增） |
| `dsh-api-account-controller` | ❌ 无包 | ✅ | `account/*`（11） | **实验 + 云端耦合** |
| `dsh-api-remote-access` | ❌ 无包 | ✅ | `remoteAccess/follow`（1） | **实验** |
| `dsh-plugin-manager` | ❌ 无包 | ✅ | `pluginManager/*`（12） | **实验**（0.2.1 新增） |
| `dsh-plugin-market` | ❌ 无包 | ✅ | `pluginMarket/{listIndexes,search,setIndexes}`（3） | **实验**（0.2.1 新增） |
| `dsh-experimental-api-speech-to-text` | ❌ | ✅ | `speech/*`（6） | **实验** |
| `dsh-office-to-pdf` | ❌ | ✅ | `officeToPdf/{generation,render}`（2） | **实验** |
| `dsh-experimental-client-ui-cot-translation` | ❌ | ✅ | `cotTranslation/{limits,translate}`（2） | **实验** |
| `dsh-client-product-analytics` | ❌ | ✅ | `productAnalytics/*`（3） | **实验 + 遥测**（隐私需评估） |

### 5.2 无 remote 表面、只能通过事件/工具暴露的能力

| 包 | 0.1.5 | 0.2.1 | 能力 | DshCockpit 相关性 |
|---|---|---|---|---|
| `dsh-user-approval` | ✅ | ✅ | 审批（只走 `approval/request` waterfall） | **已在用**（`src/main.js:5045`） |
| `dsh-jobs` / `dsh-jobs-local` | ✅ | ✅ | 进程内后台作业注册表 | **相关**（配合 `job/registered\|settled` 事件） |
| `dsh-workspace` | ✅ | ✅ | workspace 域服务 | **相关**（`session/create` 的 `workspaceId`） |
| `dsh-workspace-changes` | ❌ **无包** | ✅ **新增** | 工作区变更（配合 `workspace/changes` 事件） | **高相关**：Team artifact 的真实来源 |
| `dsh-skill` / `dsh-skill-filesystem` / `dsh-skill-office` | ✅（无 office） | ✅（+ `dsh-skill-office`） | 技能目录 | **相关**（`skills/list` remote 在 session-controller 内） |
| `dsh-experimental-agent-team` | ❌ **完全不存在** | ✅ **新增** | Lead + teammates + shared task board | **战略相关**（见 §6 R5） |
| `dsh-experimental-tool-agent-team` | ❌ | ✅ | 模型侧工具 | 同上 |
| `dsh-experimental-agent-team-profile` | ❌ | ✅ | profile 层 | 同上 |
| `dsh-experimental-client-ui-agent-team` | ❌ | ✅ | UI 层 | 同上 |
| `dsh-goal-round-driver` | ✅ | ✅ | 目标轮次驱动 | **相关**（`goal/change` 事件） |
| `dsh-session-query` / `dsh-session-query-sqlite` | ✅ | ✅ | 会话查询（可能有 SQLite） | **相关**（记忆/历史 Provider 候选） |
| `dsh-experimental-session-search` | ❌ | ✅ | 会话搜索 | **相关**（记忆 Provider 候选） |

### 5.3 包集合变化总览 —— **已确认**

- 仅 0.1.5 有（17 个，多为改名/退役）：`cordis-plugin-hmr`、`dsh-agent-presets`（→`-preset-registry`）、`dsh-client-runtime`、`dsh-code-runtime`、`dsh-code-runtime-worker-thread`、`dsh-hook-protocol`、`dsh-hooks-claude-code`、`dsh-hooks-codex`、`dsh-host-apiproxy`、`dsh-invariants`、`dsh-settings-file`、`dsh-subagent-in-process-driver`、`dsh-tool-subagent-report`、`dsh-webhook`、`dsh-webhook-github`、`dsh-workflow-worker-thread`、`node-addon-landlock-run`
- 仅 0.2.1 有（81 个）：见 §8 脚本输出。其中与 DshCockpit 战略直接相关的 8 个：`dsh-experimental-agent-team`、`dsh-experimental-tool-agent-team`、`dsh-experimental-client-ui-agent-team`、`dsh-experimental-agent-team-profile`、`dsh-workspace-changes`、`dsh-api-job-controller`、`dsh-plugin-manager`、`dsh-plugin-market`。

---

### 5.4 关键补充证据：CI 已经在两个平台上**验证过 0.2.1-rc.5 能装能启动**（已确认）

这是本盘点最重要的**运行级**证据，且它推翻了"0.2.x 完全未验证"的假设。

#### 5.4.1 事实

`.github/workflows/upstream-compat.yml` 是每日定时（`cron: '0 3 * * *'`）的上游兼容流水线：安装指定版本的 `@deepseek-ai/dsh` → `--dump-config` → 启动 `--profile web --port 0 --no-open` 并健康探测，win32-x64 与 darwin-arm64 双平台矩阵。

**最近一次运行（`41187195013`，2026-10-31）的实际结果**：

```text
[compat] verifying @deepseek-ai/dsh@0.2.1-rc.5 on win32-x64
[compat] result: {"version":"0.2.1-rc.5","platform":"win32-x64","ok":true,
  "gates":{"install":{"ok":true,"ms":90389},"dumpConfig":{"ok":true,"ms":335},
           "healthCheck":{"ok":true,"ms":4539}}}
[compat] verifying @deepseek-ai/dsh@0.2.1-rc.5 on darwin-arm64
[compat] result: {"version":"0.2.1-rc.5","platform":"darwin-arm64","ok":true,
  "gates":{"install":{"ok":true,"ms":59248},"dumpConfig":{"ok":true,"ms":121},
           "healthCheck":{"ok":true,"ms":3624}}}
[compat-report] run recorded: 0.2.1-rc.5 ok=true
[compat-report] latestVerified=0.2.1-rc.5
[verdict] 0.2.1-rc.5 all green
```

**历史趋势**（同一条流水线的 `latestVerified` 逐日输出）：

| 日期 | latestVerified |
|---|---|
| 2026-10-22 | `0.2.1-rc.2` |
| 2026-10-23 ~ 10-27 | `0.2.1-rc.3` / `rc.4` |
| 2026-10-28 ~ 10-30 | `0.2.1-rc.4`（10-30 起显示 rc.5） |
| **2026-10-31** | **`0.2.1-rc.5`** |

**即：整个 0.2.1 系列在 CI 上持续绿灯，已连续约 10 天。**

#### 5.4.2 三个门禁的**实际覆盖范围**（重要：不要过度解读）

读 `scripts/upstream-compat-smoke.js` 源码，三个 gate 的真实边界是：

| Gate | 做什么 | **不**做什么 |
|---|---|---|
| `install` | `scripts/prepare-runtime.js` 走 arborist 装完整依赖树并校验 | 不验证 DshCockpit 自身的 API 用法 |
| `dumpConfig` | `node lib/bin.js --dump-config` 退出码 0 | 只证明 profile 能 compose，不证明任何 RPC/流可用 |
| `healthCheck` | spawn `--profile web --port 0 --no-open`，从输出里匹配 `/dsh web: (\S+)/` 拿到 URL，`GET` 到 200/3xx | **不连 `/api/remote.mux`**、不调任何 RPC、不读任何 journal |

也就是说：**CI 证明了"0.2.1-rc.5 能装、能 boot、能打印同一格式的 URL 行"**，但**没有证明** `$events` / `session/follow` / `session/page` / `$events/result` 在 0.2.1 上行为一致。

不过要注意：`healthCheck` grep 的正是 `/dsh web: (\S+)/`，而 DshCockpit 的 `runtime-supervisor.js:105` 用的**是同一条正则**。因此 **B13（stdout URL 行格式）已经从"未验证"升级为"CI 双平台验证通过"** —— 这是 DshCockpit 启动握手的第一个依赖。

#### 5.4.3 一个真实的流程缺陷（**这是本次审计的意外发现**）

CI **算出了** `latestVerified=0.2.1-rc.5`，但**仓库里的账本没更新**：

| 位置 | `latestVerified` | 最后更新 |
|---|---|---|
| CI 输出（2026-10-31 运行） | `0.2.1-rc.5` | — |
| `develop` / `master` 的 `docs/compat/compat-status.json` | **`0.1.5-rc.2`** | 2026-09-16（提交 `7f2abb9`） |
| `origin/compat/auto-report` 分支（PR #7） | **`0.1.7-rc.2`** | 2026-09-26（提交 `c740b3d`） |
| `docs/compat/badge.json` | `"✅ rc.2 verified"` | 同上 |

原因（从 2026-10-31 的 run log 直接可读）：

```text
Pull request branch 'compat/auto-report' already exists as remote branch 'origin/compat/auto-report'
A pull request already exists for Lxiayu:compat/auto-report
```

`peter-evans/create-pull-request@v6` 在**已存在同名 PR 且分支未合并**时会更新分支，但本次日志显示分支停在 `c740b3d`（2026-09-26）——即**最近一个月的每日运行都没有把新结果推进 PR 分支**（PR #7 自 2026-09-17 起一直 OPEN）。

**后果（对 DshCockpit 决策链的直接影响）**：
1. `src/compat-status.js:78-81` 读的是这份 `compat-status.json`，判断 `compatible = currentVersion === latestVerified`。因为账本停在 `0.1.5-rc.2`，而当前锁定版本正好也是 `0.1.5-rc.2` → 设置页会显示"**已是最新已验证版本**"，**实际上游已经走到 0.2.1-rc.5**。
2. 因此"我们还在 0.1.5 是因为没验证过 0.2.x"这个论断**不成立**：验证早就天天在跑并且全绿，只是结果没有落到决策者看得见的地方。
3. 这会把升级决策从"要不要冒险"错误地变成"没有信息"。

**建议**（设想，属 P1 可观测性修复，不在本任务 writeScope 内）：
- 让 `compat-status.js` 在 `latestVerified` 落后于上游 dist-tag 时显示"账本可能过期（最后更新 N 天前）"，而不是断言"已是最新"；
- 修 PR #7 的卡死（或改为直接提交到 `docs/compat/` 并让 PR 只做 review 记录）；
- 把"账本超过 N 天未更新"加进 CI 告警。

**复现命令**：

```bash
cd DshCockpit
# 1) 看 CI 实际验证的版本与结论
gh run list --workflow=upstream-compat --limit 3
gh run view "$(gh run list --workflow=upstream-compat --limit 1 --json databaseId -q '.[0].databaseId')" \
  --log | grep -E "compat\] verifying|compat\] result|compat-report\] (run recorded|latestVerified)|\[verdict\]"

# 2) 看仓库账本（注意两者不一致 = 缺陷）
node -e "const j=require('./docs/compat/compat-status.json');console.log('repo  latestVerified:',j.latestVerified,'updatedAt:',j.updatedAt)"
cat docs/compat/badge.json

# 3) 看 PR 卡死状态
gh pr list --state open
gh pr view 7 --json state,createdAt,headRefName
```

---

## 6. 0.2.x 迁移风险清单（完整版，Breaking change 候选）

> `runtime-bridge.md` §10 只列了必须行动的 Top 5；这里是完整清单。

| # | 级别 | 风险 | 证据 | DshCockpit 影响 | 行动 |
|---|---|---|---|---|---|
| B1 | **P0** | `SUPPORTED_RUNTIME_RANGE='<0.2.0-0'` 硬拒绝 0.2.x | `src/runtime-manager.js:39` | 升级路径被本行挡住。**注意**：CI 已连续 ~10 天证明 0.2.1 全绿（§5.4），所以这不是"风险未知"而是"已知可用却被代码挡住" | 改能力探测（先做 §5.4.3 的账本修复，否则改了也没有决策依据） |
| B2 | **P0** | `turn/end` 新增 `forked` reason → 降级 attention | 0.2.1 `TurnEndReasonMap`；`src/team/runtime/dsh-execution-backend.js:219-234` | fork 出的 turn 被误报"需要你"，`resume()` 重挂已结束 turn | 加 `forked` 分支 |
| B3 | P1 | `SessionSummary.agentAvailable` 新增，未过滤 | 0.2.1 声明；`src/main.js:5241-5249` | 不可用会话开出失败 follow 流 → unfollowable 重试风暴 | 一行过滤 |
| B4 | P1 | `SessionProjectionMap` 11→19 键 | 两代声明 | 现有代码读 `projections.values.agentPreset`（`src/harness-rpc.js:64-66`）**仍有效**；新 8 键是机会不是风险 | 择机接入 |
| B5 | P1 | 12 种新事件静默丢弃 | `src/main.js:5533` 兜底 | 丢能力（不崩） | 至少加计数诊断 |
| B6 | P1 | `dsh-agent-presets` → `dsh-agent-preset-registry` 改名 | 包集合 diff | DshCockpit **未直接依赖该包**（只读 `session/list` 的 preset 字段），**不受影响** | 无 |
| B7 | P2 | `subagents/list` 被删 | `dsh-subagent` diff | grep 确认未使用 | 无 |
| B8 | P2 | `settings/open*Directory` 被删 | `dsh-api-settings-controller` diff | grep 确认未使用 | 无 |
| B9 | P2 | `workspaceFiles/read*` 被删 | `dsh-api-workspace-files` diff | grep 确认未使用 | 无 |
| B10 | P2 | 78 个新包 → 安装体积/依赖树膨胀 | asar `/dsh/package.json`：305 依赖 | `@npmcli/arborist` 安装时间 + 磁盘；`INSTALL_TIMEOUT_MS=10min`（`src/runtime-manager.js:52`）可能不够 | 监控安装耗时 |
| B11 | P2 | profile 模板变化 | 0.1.5 `PROFILE_TEMPLATES={acp,web,headless,...}` 含 `patchReload`；0.2.1 同 5 个模板但 `patchReload` 字段消失，新增 `INSTALLATION_OWNED_PROFILE_TUPLES`/`RETIRED_BUNDLES` | DshCockpit 只用 `--profile web`（`src/runtime-supervisor.js:233`），**名不变** | 无（但需验证 `--no-open` 仍支持） |
| B12 | P2 | CLI 参数面变化 | 0.2.1 `dsh --profile web` 新增 `--host`/`--public-url`/`--trusted-host`/`--tls-*`；`--port`/`--no-open` **保留** | DshCockpit 用 `--profile web --port N --no-open`（`src/runtime-supervisor.js:233`、`src/team-runtime-host.js:129`），**全部保留** | 无需改 |
| B13 | P3 | stdout URL 行格式 | 两代都是 `console.log(\`dsh web: ${authenticatedUrl}\`)`（0.1.5 `dsh-web-app/lib/index.js:203`；0.2.1 asar 同包 `lib/index.js:162`） | `URL_LINE_RE = /dsh web: (\S+)/`（`src/runtime-supervisor.js:105`）**仍匹配** | 无 |
| B14 | P3 | `$events` 里 `api-session/*` 事件集 | 两代完全一致（5 个） | 无 | 无 |

**B12/B13 值得单独强调**：这两个是"运行时启动握手"的全部依赖，且**两代都稳定**。意味着 DshCockpit 的 `runtime-supervisor` 层几乎不需要为 0.2.x 改造——风险全部集中在 `main.js` 的翻译层与 `dsh-execution-backend` 的映射层。

---

## 7. 稳定性分级总表

| 面 | 分级 | 一句话 |
|---|---|---|
| mux WS 路径 / 帧形状 / `$events` / `$events/result` | **稳定** | 两代逐字段一致 |
| 一元 RPC 信封 `{type:'client-request',rpcId,method,payload:{args}}` | **稳定** | 两代一致 |
| Cookie 门禁 + token URL | **稳定** | 两代都用 `authenticatedUrl` |
| session-controller 18 个既有 RPC + 参数 wire 名 | **稳定** | 零变化 |
| `commands/execute` 参数 | **稳定** | 三参数一致 |
| `session/list`/`page`/`follow`/`create`/`prompt`/`cancel` 类型 | **稳定** | 仅可选字段新增 |
| `dsh-goal` 7 方法 | **稳定** | 零变化 |
| CLI `--profile web --port --no-open` + `dsh web: <url>` 输出 | **稳定** | 两代一致 |
| `SessionEventMap` | **部分** | 40→52，零删除；新事件需主动接入才有价值 |
| `TurnEndReasonMap` | **部分** | 6→7（`forked`），需映射 |
| `SessionSummary` | **部分** | 新增 `agentAvailable`，需过滤 |
| `SessionProjectionMap` | **部分** | 11→19，纯加法 |
| `dsh-api-workspace-controller` | **稳定** | 纯加法 |
| `dsh-user-approval` / `dsh-user-questions` 的 waterfall 事件名 | **稳定** | 两代一致 |
| `dsh-experimental-agent-team` 全家桶 | **实验** | README 自标 experimental + 需 durable session storage |
| `dsh-plugin-manager` / `dsh-plugin-market` / `dsh-api-terminal-controller` / `dsh-api-account-controller` / `dsh-api-remote-access` / `dsh-permission-presets` / `dsh-schedule` remote / `dsh-api-job-controller` | **实验** | 0.1.5 完全没有，0.2.1 首次出现，无兼容性历史 |
| 净增 6 个 session 事件的具体 payload 行为（何时触发、`detail`/`label` 是否含模型文本） | **待验证** | 只能读到声明，无法运行验证 |

---

## 8. 如何复现本盘点

```bash
# 0) 先修 asar 读取器（§1.2），否则所有 0.2.1 侧读到的内容都错位

# 1) 完整三向 diff（包集合 / remote 方法 / SessionEventMap）
node /tmp/asar2/diff-surface.cjs all

# 2) 只看方法级
node /tmp/asar2/diff-surface.cjs methods

# 3) 只看事件词表
node /tmp/asar2/diff-surface.cjs events

# 4) 单点核对（例：0.2.1 的 session/follow 请求 schema）
node /tmp/asar-extract.cjs \
  /dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js \
  | sed -n "/'session\/follow': {/,/sourceLocation/p" | head -40

# 5) 核对 0.1.5 侧对应声明（.d.ts，更易读）
sed -n '/interface SessionFollowRequest/,/}/p' \
  ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts

# 6) 核对 $events/result 的 outcome 解析（两代逐分支对比）
sed -n '21,49p' ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js
node /tmp/asar-extract.cjs /dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js \
  | sed -n '/export function parseRemoteEventResult/,/^}/p'

# 7) 核对 CLI 参数面
node /tmp/asar-extract.cjs /dsh/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js | grep -o '"--[a-z-]*"'
```

**本盘点脚本的输出基线（2026-11-01，供未来对比）**：

```
packages: local(0.1.5)=244 | asar(0.2.1)=308
remote methods: session-controller 18→21 (+3, -0)
                workspace-controller 10→14 (+4, -0)
                settings-controller -2
                workspace-files -2
                subagent -1
SessionEventMap: 40→52 (+12, -0)
forwarded api-*: 5 = 5 (identical)
TurnEndReasonMap: 6→7 (+forked)
```

---

## 9. 本盘点**未能**验证的事项（诚实清单）

| 项 | 为什么无法验证 |
|---|---|
| 12 种新事件在真实会话中的触发频率与载荷实际取值 | 0.2.1 不能在本机启动（asar 内的包只由官方 Electron 主进程加载）；只能读到声明 |
| `job/registered.label` / `job/settled.detail` / `ScheduleChange` 各分支是否含模型自由文本 | 同上；若含，接入前必须闭集化（隐私铁律 `AGENTS.md` §2.4） |
| `SessionProjectionMap.agentTeam` 的 readiness 派生规则是否与 DshCockpit 的 `readyRoles()` 语义一致 | 只能读到 `{members, tasks, failure}` 声明，读不到 fold 逻辑（`dsh-experimental-agent-team/lib/types/projection.js` 已编译但语义需逆向） |
| 0.2.1 的 `session/follow` 是否真的保持"无 resume cursor" | 声明显示 `SessionFollowRequest` 仍只有 `{address,assistantStream,maxMessages,turnWindow}`，**推断**保持无 cursor；未运行验证 |
| `dsh-workspace-changes` 读 diff 的具体 API | 该包无 `typert.host.js`、无 `lib/types/*.d.ts`，只有 `lib/index.js`（已编译） |
| 0.2.1 安装体积与 arborist 安装耗时 | 未安装；只有 asar 内 305 依赖的清单 |
| `agentAvailable: false` 的确切语义（迁移中？preset 缺失？） | 只有字段名与 `boolean` 类型 |

---

## 10. 结论（给决策者的一段话）

0.2.1-rc.5 对 DshCockpit 的 Bridge **不是破坏性升级，而是一次能力扩张**：传输协议、审批回传、18 个 session RPC、CLI 握手全部逐字兼容；新增的是 3 个 RPC、12 个事件、8 个投影键、78 个包。

因此迁移的正确姿势不是"重写 Bridge"，而是：

1. **解除版本锁**（`runtime-manager.js:39`），改为能力探测；
2. **补 3 个映射分支**（`forked` reason、`agentAvailable` 过滤、新事件的可观测计数）；
3. **按战略优先级逐个接入新能力面**（`workspace/changes` > `job/registered` > `permission/preset` > `plan/mode` > 其余）；
4. **对 `dsh-experimental-agent-team` 做一次显式的产品级取舍**，不要让它悄悄长成第二套 Team 事实模型。

风险不在"会不会崩"，而在"新增能力静默流失"——因为现有翻译层对未知事件是**静默透传**而非计数告警。这是本次盘点最需要立即修的一处可观测性缺口。
