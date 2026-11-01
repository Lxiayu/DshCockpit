# Needs Your Attention + Since You Were Away + 前端深度打磨

> 状态：执行中（2026-11-01）
> 上游：`docs/design/mission-desk-ux.md`（Phase 1）、用户要求"不要只是简单的几个框和按钮"
> 范围：右栏 Mission Desk 的三个最高价值区块 + 双主题彻底打通

## 1. 第一性原理：右栏现在缺的是什么

改完之后右栏能显示 Mission/决策/问题/工作流/产物——**但它是"资料柜"，不是"简报"**。

用户打开右栏的真实问题始终是那三个：

1. **现在需要我做什么？** → 现在能回答，但埋在第三屏
2. **上次之后发生了什么？** → **完全不能回答**
3. **团队往哪走？** → 能回答，但是静态的

第 1 个是"排序问题"，第 2 个是"数据问题"，第 3 个已经够了。

**所以这轮只做 1 和 2。**

## 2. Needs Your Attention：不是"多一个区块"，是"排序机制"

### 容易做错的地方

把待办做成一个普通区块，等于**又多了一个要用户自己找的地方**。

### 正确的做法

**待办存在时，它占据右栏最顶部，且压缩其他内容的视觉重量。**
待办不存在时，那一行变成一句"团队运行正常"——**这就是有价值的信号**。

三个设计判断：

| 判断 | 理由 |
|---|---|
| **零待办时也要占位** | 空白/消失会让用户不确定"是真的没有还是加载失败" |
| **分 risk 排序，不按时间** | 一个高风险审批比十个低风险提问更急（与 Companion 一致） |
| **每张卡必须能直接处理** | 显示但不能点 = 更糟的体验（用户还得去别处找） |

### 数据来源（已核实，不需新建）

`mission/live` 已有：
- `pendingApprovals`（数）
- `pendingQuestions`（数）
- `awaitingUser`（布尔）
- `hasRunningAgent`

**但只有计数，没有条目内容。**

条目在 office 快照的 `pending[]`（含 `kind`/`risk`/`createdAtMs`），
走 `office:state` 通道，需要 office preload。

### 关键决策：怎么拿到条目

| 方案 | 做法 | 问题 |
|---|---|---|
| A | 右栏换 office-preload | 会失去 mission 桥（mission-desk.html 需要它） |
| B | settings-preload 增加 office:state 转发 | 一个 preload 同时提供两个域，**语义混杂但可行** |
| C | mission IPC 增加 `attention` action，服务端聚合 | **最干净**：事实源在 office，但通过 mission 桥暴露 |

**选 C。** 理由：右栏关心的是"和这个 Mission 相关的待办"，
而不是整个 office 的全部待办——聚合逻辑本就应该在服务端，
不该让 UI 自己去 office 快照里筛。

## 3. Since You Were Away：需要新建"上次查看时间"

### 第一性原理：什么叫"你离开期间"

必须先定义"离开"。三个候选：

| 定义 | 问题 |
|---|---|
| 上次关闭应用 | 用户可能整天开着 |
| 上次右栏可见 | 切视图也触发，噪音 |
| **上次查看这个 Mission** | ✅ 语义准确，且已有 focus 概念 |

选第三个。**需要持久化 `lastSeenAtMs` per Mission。**

### 存储位置的关键判断

不能写进 Mission 实体本身——它是 **UI 偏好，不是项目事实**。

`schema.js` 的 `FORBIDDEN_PERSISTED_FIELDS` 明确禁止了 `focused` 这类字段，
理由就是"UI 偏好不属于项目数据"。**`lastSeenAtMs` 是同一类。**

所以存到 **UI 状态**（`ui-state.json` 或 office-state），不进 Mission 事件日志。

### 怎么算"期间发生了什么"

有了 `lastSeenAtMs`，从投影里筛出该时间点之后产生的事件：

| 事件 | 变成一句什么话 |
|---|---|
| `decision.recorded` | ✓ 形成一项新决策：<text> |
| `openQuestion.opened` | ? 提出一个新问题：<text> |
| `workstream.created` | ▸ 新开工作流：<title> |
| `workstream.statusChanged` | ▸ 工作流变了：<title> → <to> |
| `deliverable.registered` | ✦ 登记产物：<label> |
| `mission.statusChanged` | ● Mission 状态 → <to> |

**关键约束：只从真实事件派生，不调用模型生成摘要。**
用户要的是"发生了什么"，不是"模型猜测发生了什么"。

## 4. 前端打磨：不是"更好看"，是"信息有层次"

用户说"不要只是简单的几个框和按钮"。这不是要花哨，是要**视觉层次承载语义**。

### 具体判断

| 问题 | 现在 | 改后 |
|---|---|---|
| 所有区块视觉重量一样 | 一样 | **待办 > 快照 > 参考资料** 三级 |
| 区块不能折叠 | 全展开，要滚很久 | 待办永久展开，其余可折叠 |
| 状态只有文字 | `[completed] 技术调研` | 状态点 + 颜色 + 文字 |
| 空状态是"未声明边界。" | 干巴巴 | 一句话说明"这里该放什么" |
| 无 hover/focus 反馈 | 没有 | 行可点时有 hover |

### 双主题：这是硬要求

当前 mission-desk.html **37 处硬编码颜色** vs 26 处 token 引用。
浅色模式下 `#8fc0ff`（浅蓝）在白底上几乎不可见。

**必须全部改成 token。** 新增需要的语义 token 到 theme.css，
而不是在页面里写死——否则下一个页面还得再来一遍。

## 5. 实施顺序

| 步 | 内容 | 依赖 |
|---|---|---|
| S1 | theme.css 补语义 token（attention/absent 用色） | 无 |
| S2 | mission IPC 加 `attention` + `lastSeenAtMs` 读写 | 无 |
| S3 | 右栏待办区（置顶 + 可处理 + 零待办占位） | S2 |
| S4 | Since You Were Away（时间线摘要） | S2 |
| S5 | 视觉打磨 + 全部 token 化 | S1 |
| S6 | **双主题真机验收**（两个主题 × 六个场景截图） | 全部 |

## 6. 验收标准

- [ ] 有高风险待办时，它出现在右栏**首屏可见**位置
- [ ] 待办卡片能直接执行操作（审批/回答），不是只显示
- [ ] 零待办时显示"团队运行正常"，**不是空白**
- [ ] Since You Were Away 只列真实事件，无模型生成内容
- [ ] `lastSeenAtMs` 不写进 Mission 事件日志（UI 偏好）
- [ ] **浅色模式下所有文字对比度 ≥ AA**
- [ ] 页面内零硬编码颜色（全部 token）
- [ ] 两个主题截图都能看清

## 7. 非目标

- ❌ 委托任务 / 跳转 Session（无 API）
- ❌ Finding / Assumption 实体（另开一轮）
- ❌ 第二页重构（用户暂议）
- ❌ 侧栏宽度可拖（下轮）
