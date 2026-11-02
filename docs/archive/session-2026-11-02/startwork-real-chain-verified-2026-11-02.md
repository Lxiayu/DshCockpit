# 「交给团队」真实链路已验证（2026-11-02）

> 脚本：`scripts/self-check-startwork.js`（**6/6**）
> 这是第一个**真实 runtime + 真实凭据 + 真实 Agent** 的端到端验证。

## 0. 为什么这个验证不可替代

前面所有验收都是 **UI fixture**：证明按钮存在、参数传对、提示显示。

**但它们证明不了"Agent 真的动了"。**

`session/prompt` 返回 `ok` 只代表**消息被接收**，不代表 Agent 开始处理。
如果模型凭据失效、或队列卡住，UI 全绿但用户什么都等不到。

**这个脚本填上了那个缺口。**

## 1. 验证了什么

在**隔离 DSH_HOME**（不干扰正在运行的 DshCockpit）里：

```
1. 启动真实 runtime               ✅
2. 认证                            ✅
3. session/create                  ✅  session-387bd51c
4. session/prompt                  ✅  accepted
5. **Agent 真的产出完成的 turn**   ✅  turns=1 steps=1（3 秒内）
6. workStatus 能报出真实数字        ✅
```

### 第 5 步是关键

```
等待 agent 产生 turn…
  [3s] turns=1 steps=1
PASS  the agent ACTUALLY produced a finished turn — turns=1 steps=1
```

**`turns` 从 0 变成 1，是"Agent 真的跑完了一轮"的硬证据。**

## 2. 对应到应用里的真实实现

| 脚本里的步骤 | 应用里对应的函数 |
|---|---|
| `session/create` | `missionEnsureSession()` |
| `session/prompt` | `missionPromptSession()` |
| `projections.sessionStats` | `workStatus` action |

**脚本用的就是应用生产代码的同一套协议。**

## 3. 顺带加了「执行进度」显示

用户点了「交给团队」之后最想知道"它在跑吗、跑到哪了"。

现在已绑定会话时，区块里显示：

```
已执行 3 轮 · 17 步
这是 Harness 记录的完成轮数，不代表任务已经达到你的要求。
```

### 为什么必须写那句免责

**`turns > 0` 只代表"有轮次结束"，不代表"任务成功"。**

如果只显示「已执行 3 轮」而不解释，用户会以为任务完成了——
而我们并不知道它是否达到要求。

**不猜**是不伪造原则的延伸。

## 4. 验收（20/20）

原 16 项 + 新增 4 项：

| # | 检查 | 结果 |
|---|---|---|
| 17 | **显示真实进度**（来自投影） | `3 轮 · 17 步` |
| 18 | **不声称任务成功** | `不代表任务已经达到` |
| 19 | **从不出现"已完成/成功"** | ✅ |
| 20 | 零完成轮次时如实说 | `已交给团队，还没有完成的轮次。` |

## 5. 还没做的

| 项 | 说明 |
|---|---|
| Agent 完成后**自动回写 Mission** | 需要监听 turn 结束事件，或者在 UI 轮询 |
| Desk 里**看 Agent 回复内容** | 有意不做（避免第二个聊天框） |
| 多会话绑定 | 当前一 Mission 一会话 |

**注意**：现在的进度是**打开详情页时查一次**，不是实时推送。
用户需要重新选中 Mission 才能看到最新数字。

## 6. 复现

```bash
env -u ELECTRON_RUN_AS_NODE node scripts/self-check-startwork.js
```

**这个脚本可以反复跑，不消耗正在运行的 App 的会话。**
