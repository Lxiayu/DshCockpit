# 官方 Agent Team 真机探针报告（S0）

> 日期：2026-11-04（Asia/Shanghai）
> 运行时：`@deepseek-ai/dsh@0.2.1-rc.5`（隔离安装在 POC_ROOT，未触碰 `~/.dsh` 生产 profile 与仓库锁定的 0.1.5）
> 模型：`stepfun/step-5-preview`（真实调用，POC 独立凭据）
> 上游：`docs/plans/active/S0-PROBE-TASKS-2026-11-03.md`、`docs/adr/ADR-0002-consume-official-agent-teams.md` §9、`docs/research/deepseek-harness-api-surface.md` §9
> 探针脚本：`scripts/poc/s0-probe.js`（无模型部分）、`scripts/poc/s0-model-probe.js`（真实模型部分）

---

## 0. 一句话结论

**官方 Agent Team 在 0.2.1-rc.5 上可以被我们"读全"、但不能被我们"直接写"。**

- 读：`agentTeam` 会随 `session/projections` 下发，形状与 `.d.ts` 声明完全一致（**真实模型下已验证**）。
- 写：`dsh-experimental-agent-team` **没有 remote RPC 表面**。我们只能通过 `session/prompt` 让 Lead 调用模型工具（`spawn_teammate` / `team_task_create` …）间接写。

这条结论直接决定 S2/S3 的实现方式，已作为决策 D11 写入主计划。

---

## 1. 环境（T0）

| 项 | 结果 |
|---|---|
| 隔离方式 | `scripts/poc/runtime-poc.sh setup 0.2.1-rc.5`，全部 IO 在 POC_ROOT |
| 运行时版本 | `0.2.1-rc.5`（`--version` 自报，与安装一致） |
| web host | 可启动，`--port 0` 自动分配，token URL 可换 cookie |
| mux | `$events` ready 帧正常，unary RPC 可用 |
| provider | `llm-pi-ai` + stepfun，真实模型调用成功 |
| 能力包 | 8 个相关包全部随该版本安装（见 §2） |

**启用团队的前置条件（实测发现，文档未显式写在显眼位置）**：
- profile 的 `dsh.profile.bundles` 必须包含 `@deepseek-ai/dsh-experimental-agent-team-profile`。
- 该 bundle **默认关闭**；仅"包已安装"不会让 `agentTeam` 出现。
- 官方 README 说"Enable Agent Teams on the Web or Desktop Plugins page"；在无 UI 的 profile 上等价于直接编辑 profile `package.json` 的 bundles。

> 实测对比：bundles 只有 `dsh-base` + `dsh-web-app` 时，`session/projections` 返回 20 个键、**无 `agentTeam`**；加入 team-profile 后返回 **21 个键、含 `agentTeam`**。这是"包在 ≠ 功能开"的直接证据。

---

## 2. 静态表面（读 `.d.ts`，不猜）

`node_modules/@deepseek-ai/` 下与本项目相关的包（全部存在）：

```
dsh-experimental-agent-team            团队领域：roster / 消息 / 任务板
dsh-experimental-tool-agent-team       模型侧工具
dsh-experimental-agent-team-profile    bundle（默认关闭）
dsh-experimental-client-ui-agent-team  官方 Web UI
dsh-user-questions                     向人提问
dsh-user-approval                      审批
dsh-workspace-changes                  逐 turn 文件变更捕获
dsh-permission-presets                 权限预设
dsh-fs-observation-policy              读后写守卫
```

### 2.1 `agentTeam` 投影的真实形状（已确认）

```ts
interface TeamProjection {
  readonly members: TeamMemberProjection[];   // { id, name, role: 'lead'|'teammate', phase, error? }
  readonly tasks: TeamTaskView[];             // 见下
  readonly failure?: string;
}
interface TeamTaskView {
  readonly id; readonly revision; readonly subject; readonly description;
  readonly status: 'pending'|'in_progress'|'completed'|'deleted';
  readonly blockedBy: TeamTaskId[]; readonly writeScopes: string[];
  readonly ownerName?: string; readonly ready: boolean;
  readonly writeScopeWarnings: string[];
}
```

**关键限制**：`TeamMemberProjection` **只有** `id/name/role/phase`，**没有** "正在做什么"。
运行时富化版 `TeamMemberView`（含 `status: running|inactive|provisioning|failed` 与 `diagnostics`）只存在于 Node 侧 `TeamService.listMembers()`，**不下发到客户端**。

→ 因此右栏名册的"每人在做什么"必须由 **任务板的 `ownerName` + 会话状态** 推导，不能指望投影直接给。

### 2.2 `TeamService` 方法表面（已确认，但 Node 侧）

`spawnTeammate` · `sendMessage` · `createTask` · `getTask` · `listTasks` · `updateTask` · `waitForChange` · `interrupt` · `listMembers` · `membership` · `tryMembership`

### 2.3 模型侧工具名（已确认）

`spawn_teammate` · `send_teammate`（消息）· `team_task_create` · `team_task_get` · `team_task_list` · `team_task_update` · `interrupt`

---

## 3. 无模型部分（`s0-probe.js`）

```
counts: {"pass":25,"fail":1,"skipped":1,"needs-model":10}
```

| 检查 | 状态 | 说明 |
|---|---|---|
| 运行时/能力包/类型表面 | PASS ×13 | 全部就位 |
| `agentTeam` 出现在投影 | **PASS** | 启用 bundle 后 keys=21，含 `agentTeam` |
| `TeamService` 方法表面 | PASS | 8 个方法名全部存在 |
| **agent-team 是否有 remote 表面** | **FAIL（关键）** | 无 typert/remote 机制 → 壳不能直接调用 |

> 该 FAIL 不是缺陷，是**架构事实**。它被记录为 D11 的输入，而非"要修的 bug"。

---

## 4. 真实模型部分（`s0-model-probe.js`）

```
counts: {"pass":10}
```

**探针动作**：对 Lead 发一条 prompt，要求它 `spawn_teammate`（名 `probehelper`，fresh 上下文）+ `team_task_create`（subject `probe-task-alpha`）；随后轮询 `session/projections` 直到出现。

**实际观测到的投影（原样记录，这是 ADR-0002 §9 缺的证据）**：

```json
{
  "members": [
    { "name": "lead",        "role": "lead",     "phase": "active" },
    { "name": "probehelper", "role": "teammate", "phase": "active" }
  ],
  "tasks": [
    { "id": "task-1", "revision": 1, "subject": "probe-task-alpha",
      "status": "pending", "ready": true, "blockedBy": [], "writeScopeWarnings": [] }
  ]
}
```

| 探针 | 状态 | 备注 |
|---|---|---|
| P-0.1 团队创建与投影 | **PASS** | teammate 真的出现在 `agentTeam.members` |
| P-0.2 `agentTeam` 字段形状 | **PASS** | 与声明逐字段一致；`tasks[].ready` 直接给出 |
| P-0.4 成员 inbox 消息 | 未验证 | 本轮未测 `sendMessage`（见 §6） |
| P-0.6 停止成员 | 未验证 | `interrupt` 需运行中的 teammate，本轮未测 |
| P-0.3 readiness/blockedBy | 部分 | 拿到 `ready:true` 与空 `blockedBy`；**有依赖的 DAG 未测** |

**`session/page` 返回 `records=0`**：turn 结束后读历史拿到 0 条记录。原因未查明（可能是 `throughSeq` 语义或 turn 尚未落盘）。**这是 S5"结果回写"的前置风险，已在 §6 登记为未验证项。**

---

## 5. 官方自述的团队限制（摘自包 README，影响我们的设计）

| 限制 | 对我们的影响 |
|---|---|
| **一个进程、一个共享 checkout** | 成员共享 cwd，**官方不提供 worktree/隔离**。印证 D2（先不做沙箱）不是偷懒而是官方现状 |
| **写入范围是劝告性的** | Bash/格式化/外部写入可绕过文件版本检查 → 冲突必须靠 Lead 协调 + 审查最终 diff。印证 S5 的"执行冲突"不能由我们判定正误 |
| **整视图广播** | 每次名册/任务变更都向所有已连接浏览器推送完整名册与任务板。**380px 右栏高频刷新时要防抖** |
| **名册扁平不可变** | 只有 Lead 能建直接 teammate；不能嵌套团队、不能重命名/删除、名字不复用。→ 与 Windows 座位模型（`EMPLOYEE_IDS`）的映射要按"名字即身份"处理 |
| **无自动释放任务归属** | 成员失效后任务仍挂着 owner → 右栏必须显示"归属可能失效"，不能显示成"正在做" |
| **无发送重试保证** | 消息不重试、不去重 → 派发必须自带幂等键（与计划 D3 一致） |
| **实验性，无稳定性承诺** | 契约可变 → 只通过投影与事件消费，不 import 内部模块 |

---

## 6. 未验证项（如实登记，不写成通过）

| # | 项 | 为什么没验证 | 阻塞什么 |
|---|---|---|---|
| U-1 | ~~`sendMessage`~~ → **✅ 已解决（第二轮）** | 暗号经 `send_message` 发出后真实出现在会话历史 | 无（已解除） |
| U-2 | ~~`interrupt`~~ → **✅ 接口已验证（效果需细化）** | `interrupt_agent` 被接受；但 `phase` 不反映 turn 中断 → 右栏必须区分生命周期与 turn 状态 | S6 的显示逻辑 |
| U-3 | ~~带依赖的 `blockedBy`/`ready`~~ → **✅ 已解决（第二轮）** | 实测 B 依赖 A：`ready=false`；A 完成 → B `ready=true`；rev 1→3 | 无（已解除） |
| U-4 | `updateTask` 的 CAS 与**重分配** | 第二轮验证了 update（completed，rev 1→3），但**未测 CAS 冲突与 reassign** | S3 任务修改 |
| U-5 | `userQuestions` 由 teammate 发起时的行为 | 需要模型主动提问 | 右栏"需要你" |
| U-6 | `workspace/changes` 事件 payload | 需要真实文件改动 | S5 凭证、冲突检测 |
| U-7 | `permission/preset` 事件 | 需要权限切换 | D8 控件启用 |
| U-8 | ~~`session/page` 在 turn 后返回 0 条记录~~ → **已解决（2026-11-04 第二轮）** | ~~原因未查明~~ **根因是探针用错参数**：`throughSeq` 必须来自 `session/follow` 的 opening cursor，不能传 `1e9` | 无（已解除） |
| U-9 | 跨会话团队恢复（durable storage 重启后） | 未测 | S4 耐久恢复 |

---

## 7. 对计划的回填

1. **ADR-0002 §9** 三个前置条件：①②已满足（0.2.x 可运行、desktop profile 已挂 team-profile bundle）；③ `agentTeam` 字段形状 **已实测**（本报告 §4）。
2. **ADR-0002 §11** 的"未验证声明"已可降级：`agentTeam` 形状从"未验证"变为"已验证"。
3. **`deepseek-harness-api-surface.md` §9** 中"`SessionProjectionMap.agentTeam` 的 readiness 派生规则是否一致"：**部分解决**——投影直接给出 `ready`，我们原样透传即可，不需要复刻派生逻辑。
4. **主计划**新增 D11（写入路径）与相关约束，见 `NEW-DIRECTION-PERSONAL-TEAM-2026-11-03.md` §5.2。

---

## 8. 复现

```bash
# 1) 隔离环境
bash scripts/poc/runtime-poc.sh setup 0.2.1-rc.5

# 2) 启用团队 bundle（等价于 UI 的 Plugins 页开关）
#    编辑 $POC_ROOT/dsh-home/profiles/web/package.json 的 dsh.profile.bundles，
#    加入 @deepseek-ai/dsh-experimental-agent-team-profile

# 3) 配置 provider（POC 独立凭据，勿用生产）
#    $POC_ROOT/dsh-home/settings.yaml 写 llm-pi-ai.providers.<name>；
#    $POC_ROOT/dsh-home/.credentials.yaml 的 refs 段写入对应 key

# 4) 无模型探针（快，验证表面与投影存在）
node scripts/poc/s0-probe.js --root "$POC_ROOT"

# 5) 真实模型探针（慢，验证 spawn/task 真的生效）
node scripts/poc/s0-model-probe.js --root "$POC_ROOT" --timeout 300000
```

**清理**：`bash scripts/poc/runtime-poc.sh teardown 0.2.1-rc.5`（只删 POC_ROOT，生产环境不受影响）。

---

## 9. 第二轮补充验证（2026-11-04 凌晨）

### 9.1 U-8 已解决：`session/page` 的正确读法

**结论：不是官方缺陷，是探针参数错误。**

`SessionPageRequest.throughSeq` 的 `.d.ts` 文档原文是：

> "Inclusive log cut obtained from the corresponding follow opening frame."

也就是说它**必须**来自 `session/follow` 首帧的 `cursor`。第一轮探针传了 `1e9`，返回 `records=0`。

实测对照（`scripts/poc/s0-verify-u8.js`，10/10 pass）：

| 用法 | 结果 |
|---|---|
| `session/follow` 首帧 | `cursor=21 records=22 hasMore=false projections=21` |
| `session/page` + `throughSeq=<follow cursor>` | **`records=22`**，且能读到 prompt 里的随机 token |
| `session/page` + `throughSeq=1e9`（对照组） | `records=null`，复现第一轮的假象 |

生产代码本来就是对的（`src/main.js:4544` 用 `officeFollowCursors`），是**探针**抄错了。

**教训（写入本报告以防重犯）**：当"官方行为看起来不对"时，先查自己的参数形状是否符合 `.d.ts` 的注释语义，再判定为官方缺陷。第二轮若未复查，S5 的"结果回写"会被误判为不可实现。

**对计划的影响**：S5 的结果回写路径**可行**。实现时必须：
1. 先 `session/follow` 拿 cursor；
2. 再用该 cursor 做 `session/page`；
3. 不得使用大数或自造的 seq。

### 9.2 第二轮：U-1 / U-2 / U-3 已解决

脚本：`scripts/poc/s0-verify-u123.js`（12/12 pass，真实模型）。

| 项 | 结论 | 证据 |
|---|---|---|
| **U-1 send_message** | ✅ **通过** | 暗号 `MSG-XXXX` 通过 `send_message` 发出后，**真实出现在会话历史里**（用 follow cursor 读 page 验证） |
| **U-2 interrupt_agent** | ✅ **接口通过 / 效果部分** | `interrupt_agent` 被接受，成员未消失、`phase` 仍为 `active`。**`phase` 不反映 turn 级中断**，需要从会话状态或事件判断（见下） |
| **U-3 blockedBy / ready** | ✅ **完全通过** | 实测：B `blockedBy=["task-1"]` 且 `ready=false`；A `ready=true`；A 完成后 B `ready=true`；revision 1→3 |

**U-3 的实测快照（关键证据）**：

```json
{
  "members": [
    { "name": "lead",    "role": "lead",     "phase": "active" },
    { "name": "probeu",  "role": "teammate", "phase": "active" }
  ],
  "tasks": [
    { "id": "task-1", "subject": "probe-task-A-c68d", "status": "completed",
      "ready": false, "blockedBy": [],           "revision": 3 },
    { "id": "task-2", "subject": "probe-task-B-2953", "status": "pending",
      "ready": true,  "blockedBy": ["task-1"],   "revision": 1 }
  ]
}
```

**结论**：官方 `ready` 是**可信的派生结果**，我们的"不重算 ready、原样透传"（计划 §3 铁律 1）**成立且有实测支撑**。

**U-2 的重要细节**：`interrupt_agent` 只中断"当前 turn"，**不改变成员的 `phase`**。因此右栏不能靠 `phase` 显示"已停止"，必须区分：
- **成员生命周期**（`phase`: provisioning/active/failed）——空闲的成员也是 `active`
- **turn 级运行状态**——投影不提供，需从会话状态推导

这修正了计划 §6.4 的名册状态映射（见回填）。

### 9.3 第二轮：U-6 `workspace/changes` 已解决（S5 的关键路径）

**结论：文件变更清单可读，但不在事件里，而在一个认证 GET 路由里。**

第一轮把 U-6 记为"需要真实文件改动"。本轮用真实模型让 Agent 执行 `echo hello-s5 > probe-s5.txt`，实测拿到：

```
workspace/changes 事件的 seq = 29
GET /api/changes.summary?sessionId=<id>&seq=29   →  200
{"turn":1,"files":[{"path":"probe-s5.txt","display":"probe-s5.txt","added":1,"deleted":0}],
 "total":1,"added":1,"deleted":0}
```

**机制（读官方源码确认，非猜测）**：

- `dsh-workspace-changes` 在每个 top-level turn 结束时 append 一条
  `workspace/changes` 事件，**payload 只有 `{turn}`**（没有文件清单）。
  清单留在 Host 端的 `TurnRecorder.records`（按事件的 `seq` 索引，仅保留到 Session dispose）。
- 客户端读清单的官方路径是 `dsh-client-ui-deliverables` 注册的认证路由：
  - `GET /api/changes.summary?sessionId=&seq=` → `{turn, files[], total, added, deleted}`
  - `GET /api/changes.diff?sessionId=&seq=&index=` → 单文件 unified diff
- 这两条路由由壳的 mux cookie 认证即可访问（实测 200）。

**对 S5（交付凭证）的影响**：

| 原计划 | 修正后 |
|---|---|
| 自建"文件变更捕获" | **不自建**：用官方 `workspace/changes` + `/api/changes.summary` |
| 凭证绑定"我们读到的文件" | 凭证绑定**官方 summary 的 seq**：`{sessionId, seq}` 就是快照坐标 |
| 需要自己算增删行 | 官方直接给 `added/deleted/binary/oversized` |

**限制（必须如实处理）**：
- 清单**仅保留到 Session dispose**；Host 重启后 404（实测未验证重启场景，但源码注释明确）。
  → 凭证必须**在 turn 结束后立即落盘**，不能事后再查。
- 不在 git 仓库内时没有 snapshot，但 summary 仍列出 file-tool 改动（源码注释）。
- `present` 工具（`dsh-tool-present`）是**显式交付**的官方机制：模型调
  `present({files:[{path,description?}]})` 声明最终产物，记录绝对路径与描述、不复制内容。
  → 我们的 Deliverable 应消费 `present` 的声明 + `changes.summary` 的事实，两者互补。

**探针脚本**：`/tmp/probe-changes.cjs`（本轮为快速验证写在临时目录；若要在 CI 复用需移入 `scripts/poc/`）。

### 9.4 第三轮：P-0.8 Brief 跨会话已解决（#23 关闭）

**这是整个 Mission 层价值的前提**：如果 Brief 不会被下次会话读到，
"跨会话项目记忆"就只是一堆笔记，记录型功能全是花架子。

**实测**（`scripts/acceptance/brief-cross-session-acceptance.js`，8/8 PASS）：

```
TOKEN: ZEBRA-0C759A4077
PASS  the brief is written into <workspace>/AGENTS.md — sync=true action=appended
PASS  the user's own content survives the brief write — ok
PASS  the isolated runtime has a usable model provider configured — stepfun/step-5-preview
PASS  the isolated dsh runtime boots — ok
PASS  the runtime hands out a session cookie — ok
PASS  a session can be created in the workspace — sessionId=session-535f41…
PASS  the prompt is accepted by the runtime — ok
PASS  the real model read the brief and answered with the secret token
      — the model echoed the token — cross-session memory works
ALL PASSED (8 checks)
```

**方法（为什么这个证据可信）**：暗号法。写一个**随机** token 进 `AGENTS.md` 的
Brief 块，然后开一次全新会话问它"暗号是什么"。token 是随机的、不可能从别处
推断，答对 ⇒ 它**真的读了那个文件**（排除了"猜对"和"从上下文蒙对"）。

**结论**：
- Brief 机制在 0.2.1-rc.5 + 真实模型下**生效**。
- `AGENTS.md` §7 的"唯一未验证的 P1 项：Brief 是否真被下次会话读到"**可以关闭**。
- 用户自己写的内容在 Brief 写入后**仍然保留**（不会被覆盖）。

**限制（如实标注）**：
- 前提是工作区是 git 仓库（脚本显式 `mkdir .git`）。非 git 目录下 AGENTS.md
  是否被加载**未验证** —— 这是真实风险，UI 应在非 git 工作区提示。
- 只验证了"启动时读到"，未验证"会话进行中修改 Brief 是否即时生效"（大概率不生效，
  与 `startWork` 把上下文显式带上的做法一致）。

### 9.5 第四轮：U-7 / P-0.11 / P-0.12 权限轴的最终结论

**结论：能读，不能写。**

#### 能读（实测 200）

```json
POST /api/permissionPresets/catalog  {}
→ {"options":[{"value":"read-only"},{"value":"workspace-write"},{"value":"danger-full-access"}],
   "defaultOptions":[...],"defaultPreset":"workspace-write"}
```

`session/projections` 的 `permissions` 投影（实测）：
```json
{"currentValue":"workspace-write"}
```

#### 不能写（权威证据）

`dsh-permission-presets/lib/typert.host.js`（生成文件，唯一权威）里
**只注册了一个 remote 方法**：

```js
const $remote = createTypertRemoteInfo({
  methods: {
    'permissionPresets/catalog': {
      description: 'Read the complete process-level catalog exposed to current-session UI.',
      invocation: { kind: 'direct' }, parameters: [],
```

实测 `permissionPresets/set` / `select` / `apply` / `current` **全部 HTTP 404**。

`SessionCreateRequest` 的字段（`.d.ts` 逐字）：
```ts
{ workspaceId?, cwd?, sessionId?, agentPreset? }
```
**没有权限字段**。

#### 三条硬事实

| 问题 | 答案 |
|---|---|
| 能否在创建会话时指定权限？ | **不能**。`SessionCreateRequest` 无此字段 |
| 能否通过 remote 修改已有会话的权限？ | **不能**。只有 catalog（只读） |
| 能否读到当前权限？ | **能**。`values.permissions.currentValue` + catalog 的 label |

#### 对 D8（右栏权限控件）的修订

原计划：*"派发面板保留权限控件，但 S0 验证前置灰，写明待验证"*。

**现在验证完了，结论是"不能写"，所以控件不能变成可用的下拉框。** 改为：

| 做法 | 说明 |
|---|---|
| 显示当前权限（只读） | 从 `permissions` 投影读，用 catalog 的 `name`/`description` 渲染成人话 |
| 显示目录选项（只读） | 从 catalog 读，让人知道系统支持哪几档、当前默认是哪档 |
| **不提供切换** | 切换只能在官方 Plugins 页/设置页做。我们给一句说明："权限由 Harness 设置，此处只显示" |
| 需要切换时 | 提供"打开 Harness 设置"的跳转，而不是自己造一个假开关 |

**为什么不能造假开关**：这是本项目反复强调的底线。一个点了没反应的权限下拉，
比没有这个控件更糟 —— 用户会以为自己把权限调低了，实际没有。

#### 仍未验证

- `permission/preset` 事件在真实 turn 中是否出现（第四轮探针在测，见下条）。
- 若该事件可观测，我们能做到"权限变更时右栏即时反映"，这比轮询更好。

#### 第四轮补充：`permissions` 投影是窄的，`permission/preset` 事件在普通 turn 不出现

实测两次：

```json
// session/projections 的 values.permissions（完整内容，不是截断）
{ "currentValue": "workspace-write" }
```

`.d.ts` 声明的 `PermissionProjectionState` 是 `{preset, sandbox, approval, seeded}`
（`extends KnobState`），但 **wire 视图只有 `currentValue` 一个字段**。
→ 又一个"声明比视图宽"的例子（和 `TeamMemberView` vs `TeamMemberProjection` 同型）。
**结论：只能拿到"当前是哪一档"，拿不到 sandbox/approval 的拆分值。**

`permission/preset` 事件：发一条普通 prompt 跑完一个 turn，**事件未出现**（探针超时返回 null）。
依据官方注释，该事件是"Records the selected preset as durable, log-only user intent"——
即**只在预设被选择/变更时**才写，不是每 turn 都写。
→ 我们无法主动制造它（因为不能写预设），它只在用户在官方 UI 里切换时出现。

**P-0.12 的最终判定**：事件机制存在但**常规运行中不产生**。
因此"权限变更时右栏即时反映"这条**做不到**（我们既不触发也观测不到）。
右栏只能用 `permissions.currentValue` 做**快照式**显示，并在用户回到面板时刷新。
