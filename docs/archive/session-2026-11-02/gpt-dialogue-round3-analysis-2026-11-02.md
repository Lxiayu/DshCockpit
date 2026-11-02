# GPT 第三轮回复的分析与决策

> 来源：`/Users/xia/Downloads/ChatGPT_项目发展方向-__20261102-0418.md`（1237 行）
> 方法：**逐条核对它的技术主张**，用官方 `.d.ts` 与实际代码验证，不盲信
> 结论：**质量明显高于前两轮**，有 3 处纠正了我们的错误，但也有 2 处需要按我们的实际情况调整

## 0. 总体判断

这一轮它做了三件对的事：

1. **主动承认并修正了自己的错误**（agentTeam 那条）
2. **指出了我两个真实的技术错误**（`ownerName` 语义、`verification.command` 的安全问题）
3. **给出了可直接落地的模型**（三层模型、Verification Profile、复合 ID）

但也有两处**需要我们按实际情况调整**，见 §7。

---

## 1. 它修正了自己：`agentTeam` 可以从稳定端点拿

**它的原话**：
> 「这个说法在严格的接口边界上没有错，但容易让人误解成第三方应用不能通过
> 官方接口读取它。」

它把问题拆成三层，这个拆法是对的：

| 层 | 是什么 |
|---|---|
| `session/projections` | 官方通用投影读取接口（Remote 方法） |
| `SessionProjectionMap` | 领域插件可扩展的投影类型 |
| `agentTeam` | 实验性 Agent Team 插件注册的具体投影 |

**结论**：可直接通过 Projection 读取，**不需要自建 Host Bridge**。

### 它建议保留的三个机制（我全部认同）

**① 能力检测：不能把"没有 agentTeam"当成"空团队"**

它列出五种状态，这个区分很重要：

```
Profile 没有启用 Team
Session 不属于一个 Team
Projection 尚未加载
投影读取失败
投影存在，但确实没有成员或任务
```

**② 快照与实时事件分离**

首屏用 `session/projections` 拿基准快照，后续用投影变化流。

它还指出一个我没注意的细节：

> 「官方 `session/projections` 还区分 `sequenced` 和 `migration-required`。
> **后者没有可靠的 `asOfSeq`，只能作为缓存提示，不能直接覆盖更新的正式快照。**」

### 核对结果

这条我能验证：实测返回确实是 `{"kind":"sequenced","asOfSeq":2,"values":{...}}`。
**`kind` 字段确实存在**，所以这个区分是可实现的。

### ③ Team 投影只读

与我们既有的铁律一致。

**它建议把 Bridge 缩小成轻量 Projection Adapter**，而不是 Host 插件。
这个建议我接受——比"完全不要 Adapter"更合理，因为确实需要：
- 统一不同 Session 的数据
- 校验投影
- 处理缺失
- 映射成办公室状态

---

## 2. 三层模型：Mission → Workstream → TeamTask

**它反对**「把 Workstream 改名成 TeamTask」，理由是两个层级不同：

| 层 | 归属 | 例子 | 生命周期 |
|---|---|---|---|
| **Mission** | DshCockpit | 开发一个知识管理应用 | 长期 |
| **Workstream** | DshCockpit | 需求研究 / 前端 / 后端 / 测试 | 持续的业务分类 |
| **TeamTask** | Harness | 「设计数据库 Schema」 | 可领取/执行/完成的工作单元 |

映射关系：

```
Mission
 ├─ Workstream: Research     → TeamTask refs → Team Run A → 官方 DAG
 ├─ Workstream: Development  → TeamTask refs → Team Run B → 官方 DAG
 └─ Workstream: Verification → TeamTask refs → Team Run C → 官方 DAG
```

**这个模型我接受。** 理由：我们的 `Workstream` 确实是"阶段/方向"，
而 TeamTask 是"可执行单元"。混在一起会像它说的那样退化。

### 关键技术细节：TeamTask ID 不能当全局 ID

**这是我没想到的真实问题**：`task-1` 只在 Team 内唯一，不同 Team 会撞。

它建议复合引用：

```ts
interface TeamTaskRef {
  teamRootSessionId: string;
  taskId: string;
  revision: number;
}

interface WorkstreamTaskLink {
  missionId: string;
  workstreamId: string;
  teamRootSessionId: string;
  taskId: string;
  linkedAt: number;
}
```

并且明确：
> 「不要复制官方 Task 的标题、状态和负责人作为另一份可编辑数据。
> 这些都是官方 Task 的字段，读取时以投影为准。**DshCockpit 只保存关联关系。**」

**这完全符合我们的铁律 1（单一事实源）。我完全接受。**

### 它指出的限制（重要）

> 「官方 `blockedBy` 不自动支持跨 Team 依赖。」

**第一版不做跨 Team DAG** —— 同意。

---

## 3. Work Receipt：它纠正了我草案的真实安全问题

### 我的草案

```ts
verification: { command: string, expectedExitCode: number }
```

### 它指出的问题（全部成立）

- 不同操作系统命令格式不一样
- **Shell 转义和命令注入风险**
- 命令可能包含未授权的操作
- **环境变量可能包含 API Key**
- 执行路径可能超出项目目录
- Agent 可能自行修改验证脚本

**这些我确实没认真考虑。** 尤其"环境变量含 API Key"——我们的模型 Key 就在环境里。

### 它的方案：Verification Profile

```ts
interface VerificationProfile {
  id: string;
  name: string;
  executable: string;        // 不是 command 字符串，是可执行文件
  args: string[];            // 参数分离，无 shell 转义问题
  workingDirectory: string;
  timeoutMs: number;
  expectedExitCodes: number[];
  scope: { kind: 'workspace'|'artifact'; paths?: string[] };
  definitionDigest: string;  // ← 验证定义本身的摘要
  trustLevel: 'platform'|'user_approved'|'agent_proposed';
}
```

**比我草案好得多。** 关键改进：
- `executable` + `args[]` 而不是 `command` 字符串 → 没有 shell 注入
- `definitionDigest` → 能检测验证定义是否被改
- `trustLevel` → 区分"平台给的可信验证"和"Agent 提议的"

### 它指出的最狠的一条：验证脚本本身会被 Agent 篡改

> 假设 Agent 修改了源码，同时把 `package.json` 改成
> `"test": "echo ok"`。此时 `npm test` 返回 0，但这不能代表原来的测试通过。

**这个问题我完全没想到。**

它的处置：
- 验证配置有独立版本和摘要
- Agent 修改验证文件时标记需重新审查
- **运行结果关联验证配置摘要 + 具体源码快照**
- **检测到变化后，之前的验证结果自动变成 `Stale`**

### `Stale` 状态是我漏掉的关键

```
上次测试时 Commit 是 A → 通过
Agent 又改了源码 → 当前是 B
→ A 上的测试结果**不能显示为 B 已经通过**
```

**这直接回答了我的问题"谁能判定验证通过"**：
答案是——**没有谁能一次性判定，只有"在某个快照上、用某个验证定义、跑出了某个结果"**。

我原来的问题是自己挖的坑：我想找一个"最终判决"，但实际上应该记录**有范围的证据**。

### 三层区分（我接受）

| 层 | 表示 | 谁产生 |
|---|---|---|
| **Agent Claim** | Agent 声称完成 | Agent |
| **Verification Run** | 实际执行了检查 | 系统执行 |
| **Human Acceptance** | 用户接受 | 人 |

**三者互相关联但不能互相替代。**

---

## 4. `ready: false` 的 380px 展示：它纠正了我一个真实错误

### 我的错误

我说：`ready: false` 时显示「等待：`ownerName`」。

**它指出**：
> 「`ownerName` 是**当前这个 TeamTask** 的负责人名称，
> 不是它所依赖的阻塞任务的负责人。」

**它是对的。** 正确做法：

1. 读当前任务的 `blockedBy`
2. 在 TeamTask 列表里找对应任务
3. 取每个阻塞任务的 `subject` / `status` / `ownerName`
4. 按实际阻塞关系显示

### 它建议的展示（我接受）

单阻塞：
```
实现后端 API          (被阻塞)
等待：数据库 Schema 设计
```

多阻塞：
```
实现后端 API          (被阻塞)
等待 2 项前置任务                    [展开]
  数据库 Schema 设计   研究员 · 进行中
  接口协议确定         Lead · 未开始
```

### 它还区分了两件我混在一起的事

| 字段 | 含义 | 文案 |
|---|---|---|
| `ready: false` | 依赖未满足 | 「等待 N 项前置任务」 |
| `writeScopeWarnings` | 写入路径可能重叠 | 「可能存在文件修改范围冲突」 |
| | | ❌ **不能写**「文件已锁定」（官方说 writeScopes 只是提示，不是锁） |

**这个区分很关键**——写错文案就是撒谎。

### 还有一个我漏了的

> 「如果 `agentTeam.failure` 有值，需要展示投影异常，不能继续把陈旧任务列表
> 标为实时状态。」

**`TeamProjectionState` 确实有 `failure?: string`** 字段，我读类型时看到了但没重视。

---

## 5. plan-review：它给了官方实现依据

**它的发现**：官方 `@deepseek-ai/dsh-client-ui-plan` **已经**把完整计划
放在右侧栏独立 Tab。

**我核对结果：完全正确。**

```js
// dsh-client-ui-plan/lib/client.js
ctx.sidebarRight           // 官方确实用右栏
"preview.open": "Open plan in sidebar"   // 官方文案
```

**所以「折叠卡片 + 独立审查视图」不是我们发明的，是官方已有的模式。**

### 它的建议

MISSION DESK 里简洁，右侧栏加独立 Tab 放完整计划。

**这个方案我接受**，而且现在有了官方依据。

---

## 6. 四个投影字段：它逐个分析，我逐个核对

| 字段 | 它的判断 | 我核对的结果 |
|---|---|---|
| `todos` | Agent 个人清单，`{content, status}`，无 ID 无优先级 | ✅ **正确**（官方 `TodoItem` 就是这样） |
| `plan` | **只是规划模式开关** `{active, pending}`，**不是计划内容** | ✅ **正确**（`dsh-plan-mode` 类型确认） |
| `permissions` | **权限预设**，**不是待审批列表** | ✅ 合理（需再验证 `currentValue` 结构） |
| `inbox` | Agent 自己的待处理输入队列 `{nextTurn, nextStep}` | ✅ 与实测结构一致 |

**它纠正了我一个猜测**：我以为 `plan` 可能是 plan-review 的数据源。
**实际上不是**——plan 只是模式开关，真正的计划内容要从 user question 的 `detail` 拿。

**这是重要修正**，避免了我们去接错数据。

### 它的关键原则（我完全认同）

> 「**不要因为能拿到 21 个字段，就把 21 个字段全部显示在右侧栏。**
> 应该让每一个 Projection 为一个明确的用户问题提供答案。」

### 最终使用位置表（我接受）

| Projection | 位置 | 重要度 |
|---|---|---|
| `agentTeam` | Office / Team Workspace | 核心 |
| `Task blockedBy` | Mission Desk Workstream | 核心 |
| `Task writeScopes` | Workstream 风险提示 | 辅助 |
| `todos` | 成员详情 | 辅助 |
| `plan` | 成员状态 / Plan Review | 辅助 |
| `permissions` | 成员安全信息 | 辅助 |
| `inbox` | 成员详情 / 执行队列 | 辅助 |

---

## 7. 它建议的待办分类：我部分接受

它建议分两个层次：

**需要你决策**：Human Question / Approval / Plan Review / Mission Decision / Deliverable Review
**团队执行提醒**：Team Blocker / Execution Warning / Queued Input

**这个分法我认同**，因为现在我们的待办区确实只有一个红框，
所有东西混在一起会让用户每次都看到一堆红。

**但有一处要按我们的实际调整**：

它把 `Deliverable Review` 放在"需要你决策"里，标注"视情况"。
我们的实际情况是——**我们还没有 Deliverable 的审查状态机**
（缺口 B 还没做）。所以第一版不能把它放进"需要你决策"，
否则会是一个空分类。

**调整**：先做「需要你决策」= Human Question + Approval + Plan Review 三类
（都有真实数据源），Deliverable Review 等状态机做好再放。

---

## 8. 我不采纳 / 需要调整的两处

### 8.1 「Verification Runner」现在不做（它也说 P2）

它自己把 Verification Runner 标为 P2，理由是"有安全执行环境后"。

**我们的实际情况**：在 Electron 主进程里跑任意命令**风险很高**
（我们刚修过权限加固从未生效的 bug）。

**决策**：
- ✅ 先做 **Verification Profile 的数据模型**（P1，纯数据，无执行）
- ❌ 不做 Runner（等有沙箱方案）
- 中间态：`trustLevel: 'agent_proposed'` 的验证**只展示不执行**

### 8.2 「Session Projection Explorer」P1 —— 我降到 P2

它建议做一个系统化探索剩余字段的工具。

**我们的实际情况**：我有 5 个真机验收探针、探针基础设施已经很强。
**再加一个 Explorer 是在给自己的工具链加负债。**

**决策**：不建独立 Explorer，而是**在每个需要的场景里按需读取**，
并用契约测试钉住形状。

---

## 9. 它给的 8 个 Issue 建议：我采纳 6 个

| 它的建议 | 优先级 | 我的决策 |
|---|---|---|
| TeamTask → Workstream Mapping | P0 | ✅ 采纳 |
| BlockedBy Compact UI | P0 | ✅ 采纳（但依赖前者） |
| Verification Profile | P1 | ✅ 采纳（**只做模型，不做 Runner**） |
| Verification Runner | P2 | ⏸ 采纳但要沙箱前提 |
| Plan Review Dedicated View | P1 | ✅ 采纳（有官方 `ctx.sidebarRight` 依据） |
| Session Projection Explorer | P1 | ❌ **降级/不做**（见 8.2） |
| Todo Projection Integration | P2 | ✅ 采纳 |
| Inbox Queue Awareness | P2 | ✅ 采纳 |

---

## 10. 我下一步该做什么

按「能真正闭合」排序（沿用我自己的判据）：

| 顺序 | 任务 | 为什么先做 |
|---|---|---|
| **1** | **Verification Profile 数据模型** | 纯数据/纯文档，零执行风险，缺口 B 的地基 |
| **2** | **待办区两层分类** | 现在只有一个红框，加了分类用户才知道轻重 |
| **3** | **TeamTask ↔ Workstream 映射设计** | 需要先启用 profile 验证，依赖外部条件 |
| 4 | BlockedBy UI | 依赖 3 |
| 5 | Plan Review 独立视图 | 依赖我们对 `ctx.sidebarRight` 的理解 |

**注意**：第 3 项需要先启用 agent-team profile 并真实 spawn teammate，
这比前两项风险高，所以排在后面。

---

## 11. 它这次没说但我认为重要的

**它没有指出我们一个更根本的问题**：我们的 Mission Desk 现在
**没有任何"团队"概念**——只有 Mission 自己的决策/发现/产物。

如果按三层模型，Mission Desk 应该能显示：
- 这个 Mission 有哪些 Workstream
- 每个 Workstream 关联了哪个 Team
- 那个 Team 的任务 DAG 进展

**现在这一层是空的**（因为没启用 team profile）。

所以第 3 项不是"锦上添花"，而是**让 Mission Desk 真正有"团队"内容的必要步骤**。
