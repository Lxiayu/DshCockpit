# TaskRef 接线 —— 第一性原理分解

> 状态：执行中（2026-11-01）
> 上游：独立盘点审计（`docs/product/gap-inventory.md` §5.5，优先级「中」）
> 触发：schema / store / projection **三层都写好了**，但 IPC 层 0 处引用

## 1. 现状：三缺一

| 层 | 状态 | 证据 |
|---|---|---|
| schema | ✅ 完整 | `validateTaskRef`，含"禁止 status 字段"的硬约束 |
| store | ✅ 完整 | `case 'taskRef.linked': return schema.validateTaskRef(payload)` |
| projection | ✅ 完整 | fold 到 `taskRefs` + `byMission.taskRefIds` |
| **IPC action** | ❌ **0 处** | `grep -c taskRef src/ipc-mission.js` → 0 |
| **UI** | ❌ 无 | — |

结论：**没有生产者，所以永远是空的**。这是"底层完备、上层缺失"的典型。

## 2. 第一性原理：TaskRef 到底解决什么问题

domain-model §2.3 说得很清楚：

> Mission 只通过 `TaskReference` 记录"**这次会话的 goal 属于哪个 Workstream**"。

所以它解决的是一个**归属**问题，不是状态问题。

拆开来看，用户在 Mission Desk 里一定会问：

> "我刚才在 Harness 里跑的那一大段工作，属于我哪个工作流？"

没有 TaskRef，这个问题的答案只能靠人记。**这就是跨会话连续性最实际的断点**——
Mission 知道有 3 个工作流，Harness 知道有 5 次会话，
但**两者之间没有任何连接**。

### 为什么它比"再多做几个物件"重要

因为它是 Mission 与 Harness 之间**唯一**的连接点。
没有它：
- Mission 的"实时状态"永远显示"不可用"（上一轮截图里真的就是这样）
- 用户看到的工作流与实际做过的事无法对应

## 3. 第二性原理：为什么这里最容易犯"两个事实作者"的错

TaskRef 天然诱人：既然要引用一个任务，为什么不顺便存它的状态？
用户也一定想让 Desk 显示"这个任务完成了"。

但 schema 已经用一行硬约束挡住了：

```js
if (t.status !== undefined) {
  errors.push('TaskRef must NOT carry a status — task state is Harness-owned (two owners = lying state)');
}
```

**这个约束是对的，接线时必须尊重它。** 所以：

| 该做 | 不该做 |
|---|---|
| 存 `harnessRef`（派生句柄）与 `summary`（人可读） | 存 `status` / `progress` / `startedAt` |
| 展示时读 Harness 投影并标 `observedAtMs` | 在 Mission 里"同步"任务状态 |
| `outcome` 从 Harness 事实**派生**（不持久化） | 让用户手选"这个任务完成了" |

## 4. 隐私边界：harnessRef 不是 sessionId

domain-model 明确要求 `harnessRef` 是**派生句柄**（`sess-h-<digest>:t-12`），
不是 raw sessionId。这符合 AGENTS.md §2.4。

所以 IPC 层必须**做一个派生**，而不是把用户传入的 sessionId 直接存进去。

推导：`harnessRef` 的生成规则应该是
`sha256(sessionId).slice(0,n)` 前缀 + 可选的 turn 序号。
这样：
- 能唯一标识一次执行（同一 session 同一 turn 得到同一 ref）
- **不可反推**原始 sessionId（隐私）
- 跨会话比较时只需要 ref 相等

## 5. 实施分解

| 步 | 内容 | 验证 |
|---|---|---|
| **S1** | `src/mission/task-ref.js` —— `harnessRef` 的派生（纯函数） | 单测：同输入同输出、不可反推、有界 |
| **S2** | IPC action：`linkTaskRef` / `listTaskRefs` | 单测（IPC 形状 + 拒绝 status） |
| **S3** | Desk UI：在工作流下显示关联的 TaskRef + 「关联一次会话」入口 | 静态契约 + 真机 |
| **S4** | 真机验收（真实关联 → 落盘 → 重启后仍在） | 探针 |

S1 先做：派生规则是隐私边界所在，必须先固化。

## 6. 验收标准

- [ ] `harnessRef` 由派生函数生成，**不接受**调用方直接传原始 sessionId
- [ ] 同 session 同 turn 得到同一个 ref（幂等）
- [ ] ref 不可反推 sessionId（长度固定、含哈希前缀）
- [ ] 带 `status` 的 TaskRef 被**拒绝**（两个事实作者 = 撒谎的状态）
- [ ] Desk 能看到某个 Workstream 关联了哪些执行
- [ ] 关联后**重启 Desk 仍在**

## 7. 明确的非目标

- ❌ 不做任务状态同步（那是 Harness 的）
- ❌ 不做"从 Harness 自动发现 task"（需要真实 session 列表，超出本轮）
- ❌ 不做 TaskRef 的 UI 编辑（只做关联与展示）
