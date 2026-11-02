# 严重问题：产品是"状态记录器"，不是"工作发生器"

> 日期：2026-11-02
> 触发：用户创建 Mission 后"没有反应，不知道下一步做什么"，
> 并质问"约 50 轮对话到底做了什么？"

## 0. 用户的批评是对的，我先给证据

### 铁证：29 个 Mission action 里，**0 个能启动 Agent 工作**

```
list / get / create / updateStatus / update
addWorkstream / updateWorkstreamStatus
recordDecision / openQuestion / answerQuestion
registerDeliverable / linkTaskRef / listTaskRefs / verifyDeliverables
getBrief / diagnostics / openDesk
syncBrief / unsyncBrief / briefSyncState
attention / sinceLastSeen / markSeen
recordFinding / updateFindingStatus
recordAssumption / updateAssumptionStatus
recordEvidence / sessionProjections
```

**全部是「记录」「查询」「关联」。没有一个能让 Agent 开始工作。**

### 铁证 2：创建 Mission 之后什么都不会发生

```js
state.selectedId = r.missionId;
await refresh();     // ← 只是选中并刷新列表
```

**没有任何"下一步"引导。** 用户看到的是一个空的详情页 + 一堆待填表单。

### 铁证 3：Mission 和 Harness 的会话是**断开的**

- Mission 存的是 `harnessRef`（派生句柄 `sess-h-*`）
- 但 Mission **不存 raw sessionId**（隐私规则）
- 所以 Mission 无法"用这个会话继续工作"
- 用户创建 Mission 后，Harness 那边**完全不知道有这个 Mission**

**这是架构级的断线，不是 UI 问题。**

## 1. 那 50 轮到底做了什么

诚实清单（按价值排序）：

### 真正有价值的部分

| 项 | 价值 |
|---|---|
| 审计 + 定位（"缺的是接到用户手上"） | ✅ 这个判断是对的 |
| 修了 3 条"假 ✅"技术债 | ✅ 真实价值 |
| 修了白板点击 TypeError（Mission Desk 无入口） | ✅ 真实价值 |
| 修了权限加固从未生效 | ✅ 安全价值 |
| 升级 0.2.1 + 发现 session/projections | ✅ 解锁了结构化交互 |
| Brief 真机验证（模型能从 AGENTS.md 读暗号） | ✅ 跨会话连续性真的有 |
| 双主题 / 对比度 / 假 token 门禁 | ✅ 质量价值 |

### 有价值但**用户感知不到**的部分

| 项 | 问题 |
|---|---|
| Needs Your Attention 置顶 | 只有 harness 真的产生 approval/question 才出现——用户几乎遇不到 |
| Since You Were Away | 需要真的用一段时间才有内容 |
| Finding / Assumption / Evidence | **用户不知道填这些干什么** |
| Work Receipt / Verification Profile | 纯数据模型，**没有 UI，用户完全看不到** |
| TeamTask 映射 + BlockedBy | **生产没启用 team profile，用户永远看不到** |

### 纯内部质量（对用户零感知）

四态 CI 门禁、变异验证、主题 token 化、契约测试、~100 项真机检查。

**这些让产品不容易坏，但没让产品更有用。**

## 2. 核心诊断：做的是"记录器"，不是"发生器"

### 现在的循环

```
用户 → 创建 Mission → 填目标 → 空白
                              ↓
                        没有下一步
```

### 缺的是什么

**Mission 应该能"启动工作"，而不是只"记录工作"。**

具体缺三个能力：

| 缺失 | 后果 |
|---|---|
| **A. Mission → 启动 Agent 会话** | 用户创建 Mission 后无事可做 |
| **B. Mission 与 Session 双向绑定** | Harness 不知道 Mission 存在 |
| **C. 完成后回写 Mission** | 工作成果不会自动进 Mission |

**A 是致命的那一个。**

## 3. 为什么之前没做 A

我之前的理由（在文档里写过）：

> "委托任务给 Lead 需要 API，grep `team/spawn` → 0"

**这个判断是错的。** `session/prompt` 就是那个 API——

我们**已经在用**它（Brief 验证探针里就是 `session/prompt` 让模型回答问题）。
我只是没把它接到 Mission 上。

**这是我 50 轮里最大的判断失误：把"没有专门 API"误判成"做不到"，
而实际上通用 API 已经存在且已验证可用。**

## 4. 现在该做什么（按用户价值排序）

### P0：让 Mission 能启动工作

```
Mission 详情页底部加一个输入框：
  「告诉团队要做什么…」  [交给团队]

点"交给团队" →
  1. 找到/创建这个 Mission 绑定的 Harness 会话
  2. session/prompt 把「任务 + Mission Brief」发过去
  3. 把 sessionId 绑到 Mission（存 workspace 内的绑定文件，不进事件日志）
  4. 用户在 harness 视图能看到会话在跑
  5. 完成的内容回来能 linkTaskRef 到 Mission
```

**这一条做完，"创建 Mission 后没事可做"就解决了。**

### P1：Mission 与 Harness 双向可见

- Mission 详情显示"这个 Mission 的会话"（一个链接，点了切到 harness 视图）
- harness 视图里能看到 Mission 名字（通过 AGENTS.md 的 Brief 已经能做到一半）

### P2：让用户看懂"填这些有什么用"

现在 Finding/Assumption/Evidence 是**裸表单**，用户不知道为什么要填。

应该改成：**Agent 工作时自动产生，用户只需要确认/修正**，
而不是让用户手填。

## 5. 我要承认的三件事

### 1. 我把"架构正确"当成了"产品有用"

50 轮里我反复做的是：让状态机更严、让测试更全、让文档更准。
**这些都对，但都不解决"用户打开产品不知道干什么"。**

### 2. 我该更早发现"没有启动入口"

审计时我看的是"已实现的功能接到 UI 了吗"，
但**没看"UI 有没有让用户开始工作"**。

这是审计清单本身的盲区。

### 3. 我不该把"没有专门 API"当成阻塞

`session/prompt` 一直在那儿。我甚至在探针里用过它，
却没意识到它就是 Mission 需要的那个入口。

## 6. 诚实的回答："50 轮做了什么"

**做了三件事，只有第一件用户能感知：**

1. **让产品不坏**（修 bug、修假 ✅、修安全、升级、门禁）
2. **让产品能记录**（Mission/决策/发现/产物/待办/时间线）
3. **让产品能观察**（团队任务、plan-review、结构化选项）

**缺了第四件：让产品能工作。**

前两件是必要的地基，但第三件做完后**应该立刻做第四件**，
而不是继续打磨"观察"和"记录"。

**这是我的排序错误，不是方向错误。**
