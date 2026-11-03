# S0 真机探针任务清单（交给 DeepSeek 执行）

> 状态：**待执行**（2026-11-03，用户已批准新方向计划）
> 上游：`docs/plans/active/NEW-DIRECTION-PERSONAL-TEAM-2026-11-03.md` §7 S0、`docs/adr/ADR-0002-consume-official-agent-teams.md` §9、`docs/research/deepseek-harness-api-surface.md` §9
> 本文件只定义任务与验收，**不包含任何代码改动**。探针脚本的产出放在 `scripts/acceptance/` 或 `/tmp`，报告放在 `docs/quality/`。

---

## 0. 执行原则（必须遵守）

1. **真机分层**：这些探针需要图形会话与真实模型调用。DeepSeek 负责写脚本、跑 headless 部分、记录结果；**需要图形界面或真实 key 的步骤，标注为"待用户执行"，不得自行宣称通过**（AGENTS.md §4）。
2. **不伪造**：每一项必须有可复现的证据（事件流截图、JSON 快照、日志行）。拿不到证据写"未确认"，不写"通过"。
3. **先验前置条件**：`scripts/acceptance/brief-cross-session-acceptance.js` 的经验——会话能创建、prompt 能发，但没有 provider 配置时**整条链路看似成功、实际没通**。每个探针开始前必须确认：运行时版本、模型 provider 可用、会话能产生至少一条 assistant 事件。
4. **不改生产代码**：探针是只读或隔离的。不修改 `src/`、不修改 `package.json` 的 runtimeVersion（那是 S1 的事）。
5. **隔离 HOME**：探针使用独立的 `DSH_HOME` 或 profile，不污染用户的 `~/.dsh`。
6. **失败也要记录**：每个探针输出 `passed / failed / unverified` 三态，并附原始输出片段。

---

## 1. 任务总览

| 任务 | 对应计划探针 | 类型 | 谁执行 |
|---|---|---|---|
| T0 环境与前置条件 | 前置 | 自动化 | DeepSeek |
| T1 团队创建与投影 | P-0.1、P-0.2 | 半自动 | DeepSeek + 用户确认图形会话 |
| T2 readiness 与阻塞 | P-0.3 | 自动化 | DeepSeek |
| T3 成员消息 | P-0.4 | 半自动 | DeepSeek + 用户确认 |
| T4 任务修改与重分配 | P-0.5 | 半自动 | DeepSeek + 用户确认 |
| T5 停止成员 | P-0.6 | 半自动 | DeepSeek + 用户确认 |
| T6 提问回流 | P-0.7 | 半自动 | DeepSeek + 用户确认 |
| T7 Brief 跨会话 | P-0.8 | 自动化（已有脚本） | DeepSeek |
| T8 工作区变更事件 | P-0.9 | 自动化 | DeepSeek |
| T9 cwd 生效 | P-0.10 | 半自动 | DeepSeek + 用户确认 |
| T10 权限预设 | P-0.11 | 半自动 | DeepSeek + 用户确认 |
| T11 权限事件可观测 | P-0.12 | 自动化 | DeepSeek |
| T12 报告与回填 | 产出 | 文档 | DeepSeek |

执行顺序：**T0 → T1 → (T2, T7, T8, T11 可并行) → T3 → T4 → T5 → T6 → T9 → T10 → T12**。
T1 失败则 T2–T6 全部阻塞，直接进入 T12 记录阻塞原因。

---

## 2. T0 环境与前置条件（必须先做）

**目标**：确认探针可以运行，并找到可用的 0.2.1 运行时。

**步骤**：
1. 确认官方 App 自带运行时：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（asar 内 `dsh/node_modules/@deepseek-ai/`）。注意：`app.asar.unpacked/dsh` 下只有部分原生依赖，**官方 `@deepseek-ai` 包在 asar 归档里**，读取须用 `docs/research/deepseek-harness-api-surface.md` §1.2 的正确读取器（4 字节对齐）。
2. 确认 `~/.dsh/profiles/desktop/package.json` 的 bundles 包含 `@deepseek-ai/dsh-experimental-agent-team-profile`。已在 2026-11-03 核实该条目存在。
3. 确认模型 provider：读取 `~/.dsh/.credentials.yaml` 的 `refs` 段（只检查 key **名称**，不打印值）。若探针需要 key，记录"需要用户提供/确认"。
4. 在隔离目录安装或复用 0.2.1-rc.5 运行时，记录版本号与路径（不得安装到 `~/.dsh` 的生产 profile）。
5. 启动运行时（`--profile web --port 0 --no-open` 同 `scripts/upstream-compat-smoke.js`），用 `GET /api/health` 探测。

**验收**：
- 运行时版本为 `0.2.1-rc.5`（或记录实际版本）。
- health 检查返回成功。
- 能创建一个会话并在其中收到至少一条 assistant 事件（哪怕只是"你好"的回复）。若拿不到，**整个 S0 阻塞**，报告写"前置条件未满足：无可用模型 provider"。

**产出**：`docs/quality/harness-agent-team-probe-2026-11-XX.md` 的"环境"一节。

---

## 3. T1 团队创建与投影（P-0.1、P-0.2）

**目标**：通过官方接口创建一个团队，确认任务出现在 `agentTeam` 投影中。

**步骤**：
1. 通过 `session/create` 创建 lead 会话（或使用 `dsh-experimental-agent-team` 的正式入口，以运行时 README 为准；README 不在本机可读，**需先在 asar 中定位该包的 `lib/*.js` 与 `typert.host.js`**，读取 RPC 名称与参数）。
2. 请 lead 创建两名成员与若干任务（真实模型调用，一句话任务即可）。
3. 调用 `session/projections`（请求形状依 `deepseek-harness-api-surface.md` §3.2，注意参数是 `{ request: { sessionId } }`，见 `src/main.js` `officeSessionProjections` 的注释）。
4. 记录 `agentTeam` 键的完整原始 JSON（脱敏：去掉 key、绝对路径，保留结构）。

**验收（P-0.1）**：投影的 `members` 与 `tasks` 数量与步骤 2 的实际创建一致。
**验收（P-0.2）**：逐字段比对 `{members, tasks, failure}` 声明；每个差异单独列出（字段名、声明类型、实际类型、实际值示例）。

**图形会话确认**：用户在 Harness 的 Web UI 中核对团队成员与任务数，回填"与 UI 一致 / 不一致"。

---

## 4. T2 readiness 与阻塞（P-0.3）

**目标**：验证 `blockedBy` 与 `ready` 派生是否与 Harness UI 一致。

**步骤**：
1. 创建一个带依赖的任务图：A、B 依赖 A、C 依赖 B（线性），再加一个独立任务 D。
2. 读取投影中每个任务的 `ready` 与 `blockedBy`。
3. 预期 ready 集合：`{A, D}`。B、C 应为 `ready=false`。
4. 让 A 完成后再读取，预期 ready：`{B, D}`。

**验收**：三次读取的 ready 集合与预期一致；若不一致，记录实际值与 Harness UI 的显示。
**注意**：ADR-0002 §11 提示"readiness 派生规则未验证"。如果投影直接给出 `ready`，我们**原样透传，不自己重算**（计划 §3 铁律 1）。这里只验证"透传值是否符合依赖语义"。

---

## 5. T3 成员消息（P-0.4）

**目标**：确认向具体成员发消息，成员会收到并响应。

**步骤**：
1. 在 T1 的团队中，向成员 X 发 inbox 消息，内容为一个可验证的暗号（如 `PROBE-MSG-<随机8位>`），要求其在回复中原样复述。
2. 等待成员响应（轮询其会话事件，超时 120 秒）。
3. 检查响应是否包含暗号。

**验收**：响应包含暗号 ⇒ 通过。无响应 ⇒ 未确认（不是失败，需注明可能是模型侧延迟）。
**官方接口**：若 inbox 发送接口不明确，先用 asar 中 `dsh-experimental-agent-team` 的 `typert.host.js` 列出方法名，**不得猜测方法名**。

---

## 6. T4 任务修改与重分配（P-0.5）

**目标**：确认修改任务描述、重分配 owner 后，投影同步变化。

**步骤**：
1. 选 T1 中的一个未完成任务 T，记录其 `revision` 与 `ownerName`。
2. 修改其 description，或重分配给另一成员。
3. 重新读取投影，比对 `revision` 是否递增、字段是否更新。

**验收**：投影中 `revision` 递增，且字段与操作一致 ⇒ 通过。`revision` 未递增或字段未变 ⇒ 失败，记录实际值。
**注意**：revision 是官方 CAS 机制，我们的写入必须携带当前 revision（计划 §8）。这里顺便验证 CAS：使用过期 revision 写入应被拒绝。

---

## 7. T5 停止成员（P-0.6）

**目标**：确认 `session/control` 或 interrupt 能停止一名正在工作的成员。

**步骤**：
1. 让成员 X 执行一个较长的任务（如"逐条列出 200 个质数"）。
2. 在其运行中调用停止接口（先从 asar 中确认 `session/control` 的 payload 形状；`src/harness-rpc.js:400` 目前显式返回 unsupported，**需先读懂语义**）。
3. 检查成员的会话事件与投影状态：是否变为 stopped / aborted / interrupted。

**验收**：状态变化可观测 ⇒ 通过。接口调用成功但状态不变 ⇒ 失败（记录"接口接受但无效果"，这是重要发现）。

---

## 8. T6 提问回流（P-0.7）

**目标**：确认成员发起的 `userQuestions` 是否只能由 root Agent 发起，并确认 Lead 收集机制可行。

**步骤**：
1. 让成员 X 调用 `ask_user_question`（提供 2 个选项）。
2. 检查该问题出现在哪里：成员会话？lead 会话？`userQuestions` 投影？
3. 用 `userQuestions/answer`（依 `dsh-user-questions` 的 remote 表面）回答，检查成员是否收到答案。

**验收**：记录问题实际归属（成员会话 / lead 会话 / 两者）、答案是否回到成员。文档声称"只能 root Agent 发起"，**以实测为准**，若与文档不符，单独列出。

---

## 9. T7 Brief 跨会话（P-0.8）

**目标**：确认 Brief 在新会话启动时被读到。

**步骤**：直接运行已有脚本 `scripts/acceptance/brief-cross-session-acceptance.js`，它已实现暗号法：写入随机暗号到 `AGENTS.md`，开新会话问暗号，答对即通过。

**注意**：该脚本默认指向 `DSH_POC_ROOT`（默认路径 `/var/folders/.../dsh-poc/0.2.1-rc.5`，**当前该路径已不存在**）。执行前需设置 `DSH_POC_ROOT` 指向 T0 安装的运行时，或修正默认路径。修改脚本的默认路径属于**测试工具改动**，须在报告中说明。

**验收**：脚本输出 `ALL PASSED` ⇒ 通过。

---

## 10. T8 工作区变更事件（P-0.9）

**目标**：确认 `workspace/changes` 事件包含本 turn 的改动文件清单。

**步骤**：
1. 在一个 git 工作区中，让成员修改两个文件（新建一个、修改一个）。
2. 订阅会话事件流（`session/follow`），筛选 `workspace/changes`。
3. 记录事件的 `turn` 字段，以及是否包含文件清单（若只有 turn 数字，记录"无文件清单"）。

**验收**：事件存在且 `turn` 为数字 ⇒ 部分通过；若含文件清单且与实际改动一致 ⇒ 通过。

---

## 11. T9 cwd 生效（P-0.10）

**目标**：确认 `SessionCreateRequest.cwd` 真的让会话在指定目录执行。

**步骤**：
1. 在临时目录 `/tmp/s0-cwd-<随机>` 下创建一个标记文件 `MARK.txt`，内容为随机串。
2. 用 `session/create` 传入 `cwd` 指向该目录（`request: { cwd }`）。
3. 发送 prompt："读取当前目录下 MARK.txt 并原样输出"。
4. 检查回复是否包含随机串。

**验收**：回复包含随机串 ⇒ 通过（证明 cwd 生效）。若回复找不到文件，检查会话实际的工作目录（让它执行 `pwd`），记录差异。
**隐私注意**：报告中不写绝对路径，写"临时目录（已脱敏）"。

---

## 12. T10 权限预设（P-0.11）

**目标**：确认能否在创建会话时指定权限预设，并生效。

**步骤**：
1. 从 asar 中读取 `dsh-permission-presets` 的参数定义，确认取值（`read-only` / `workspace-write` / `danger-full-access`）以及 `session/create` 是否接受权限字段。**若 `SessionCreateRequest` 的类型中没有权限字段，记为"接口不支持，需另寻路径"，不得猜测字段名。**
2. 若可指定：分别在 `read-only` 与 `workspace-write` 下，让会话尝试写入工作区外的文件。
3. 记录写入是否被拒绝。

**验收**：
- 接口支持且越权被拒 ⇒ 通过（D8 控件可启用）。
- 接口支持但越权未被拒 ⇒ 失败（D8 控件必须保持置灰，并在报告中标红）。
- 接口不支持 ⇒ "未通过，D8 保持置灰"。

---

## 13. T11 权限事件可观测（P-0.12）

**目标**：确认 `permission/preset` 事件在会话中出现，且取值与 T10 所设一致。

**步骤**：
1. 在 T10 的会话中订阅事件流，搜索 `permission/preset`。
2. 比对其 `preset` 字段与 T10 所设值。

**验收**：事件存在且取值一致 ⇒ 通过。事件不存在 ⇒ 未通过，办公室只能显示"未知"（计划 D8/§6.4）。

---

## 14. T12 报告与回填

**目标**：汇总所有探针结果，回填 ADR-0002 §9 与 `deepseek-harness-api-surface.md` §9。

**产出**：`docs/quality/harness-agent-team-probe-2026-11-XX.md`，结构固定：

```
## 环境（T0）
## 结果总表：探针 | 状态(passed/failed/unverified) | 证据位置 | 备注
## 与声明不符项（逐条：声明来源 / 实测 / 影响）
## 未验证项与原因（如：需用户图形会话确认）
## 对计划的影响（哪些阶段可以开始，哪些阻塞）
```

**回填**：
- ADR-0002 §9 三个前置条件逐条标注结果。
- `deepseek-harness-api-surface.md` §9 "未能验证的事项"中已被验证的条目，划掉并注明证据位置。
- 在 `docs/README.md` 登记新报告。

**验收**：报告中每个探针都有三态之一，无空白项；与声明不符的项不少于一条记录（即使是"无不符"也要明确写出）。

---

## 15. 用户需要做的事（图形会话与密钥）

| 事项 | 对应任务 |
|---|---|
| 确认 provider key 可用（只确认名称存在，不要粘贴到对话里） | T0 |
| 在 Harness Web UI 核对团队成员与任务数 | T1 |
| 在 Harness UI 中观察成员收到消息 | T3 |
| 在 Harness UI 中观察任务修改后的状态 | T4 |
| 在 Harness UI 中观察停止效果 | T5 |
| 在 Harness UI 中回答成员的提问（若需要） | T6 |

---

## 16. 本清单的局限

- 所有依赖 `dsh-experimental-agent-team` 的接口名称，都需要先从 asar 中读出，**本清单未给出确切方法名**，以免 DeepSeek 直接照抄而产生伪证据。
- `scripts/acceptance/brief-cross-session-acceptance.js` 的默认 `DSH_POC_ROOT` 路径已失效，T7 需先修正或设置环境变量。
- 本清单假设 0.2.1-rc.5 在隔离目录可以启动；若 T0 失败，整个 S0 阻塞，应先解决环境。
