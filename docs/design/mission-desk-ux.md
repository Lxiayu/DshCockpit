# Mission Desk 右栏设计（Phase 1）

> 日期：2026-11-01
> 上游：`docs/quality/mission-desk-ux-audit-2026-11-01.md`（审计）、
> `docs/quality/mission-desk-mvp-analysis-2026-11-01.md`（MVP 分析）
> 范围：本轮 MVP（A 类功能，全部有真实数据与真实操作）

## 0. 一句话

**右栏从「工作区任务面板」变成「Mission Desk」——
回答"现在发生了什么、我需要关注什么、我能改变什么"。**

## 1. 职责边界（与提示词 §二 一致，但按我们的实现校准）

| 界面 | 回答的问题 | 实现 |
|---|---|---|
| **Office** | 团队正在做什么？ | PixiJS 场景 + 员工 |
| **右侧栏 = Mission Desk** | 现在发生了什么？我该关注什么？我能改变什么？ | 本轮重构 |
| **Harness 主视图** | Agent 如何具体执行？ | 官方 Web UI，不改 |
| **Mission Desk 独立窗口** | （暂时保留）大屏查看 | 不改，后续可能合并 |

**不做**：第二个聊天框、Agent Dashboard、Token 统计面板。

## 2. 信息架构

380px 宽度决定了**不能做三 tab + 多区块**。采用**单列纵向 + 折叠**：

```
┌─────────────────────────────────┐
│ MISSION DESK          [⌄] [×]  │  ← 头部：标题 / 切换 / 收起
│ ● Active · 2 个 Agent 在跑      │
├─────────────────────────────────┤
│ ⚠ 需要你处理 (2)            ▼  │  ← 最高优先级，有则置顶展开
│   ▸ [高] 审批 Bash rm -rf …    │
│   ▸ [低] 提问 要继续吗？        │
├─────────────────────────────────┤
│ MISSION                         │
│ DshCockpit Runtime 集成         │
│ 目标：完成 Agent Team 接入…     │
│ 阶段：Runtime Bridge 验证       │
├─────────────────────────────────┤
│ 决策 (3)                    ▼  │  ← 折叠区块
│ 未决问题 (1)                ▶  │
│ 工作流 (4)                  ▶  │
│ 产物 (2)                    ▶  │
├─────────────────────────────────┤
│ [调整目标]  [记录决策 +]        │  ← 底部固定操作
└─────────────────────────────────┘
```

### 为什么不用 tab

380px 下三 tab 会让每个 tab 都只有 2-3 条内容，**且用户要来回切换才知道全貌**。

纵向折叠的好处：
- 一屏内看到**全貌**（哪个区块有问题一眼可见）
- 需要细节时展开对应区块（不需要切换上下文）

这与 LukeW 调研的结论一致：**Dashboard「很难同时把握全局和细节」**，
而纵向折叠同时提供了全局（折叠标题 + 计数）和细节（展开）。

## 3. 视觉层级（三层）

| 层级 | 内容 | 视觉处理 |
|---|---|---|
| **L1 需要行动** | Needs Your Attention | 顶部、带色、默认展开 |
| **L2 情境** | Mission 快照 | 中等字重、始终可见 |
| **L3 参考** | 决策/问题/工作流/产物 | 折叠、只有标题 + 计数 |

**关键原则**：不需要用户处理的内容全部折叠。
这样"没有待办"时用户看到的是一屏干净的概览，而不是一堆空列表。

## 4. 空状态设计

| 场景 | 显示 |
|---|---|
| 没有 Mission | 「从这里开始」+ 创建按钮（复用已实现的空状态） |
| 有 Mission 但无待办 | `✓ 团队运行正常，没有需要你处理的事` + 最近变化 |
| 某区块为空 | **不显示该区块**（而不是显示"还没有"） |

**"没有需要你处理的事"本身是有价值的信息**（提示词 §三.3 一致）。

## 5. 数据映射（每个字段都说清来源）

| UI 元素 | 数据来源 | 事实作者 | 操作 |
|---|---|---|---|
| Mission 标题/目标 | `missionView().mission` | DshCockpit | `update` |
| Mission 状态 | 同上 `status` | DshCockpit | `updateStatus` |
| Agent 在跑 | `live.hasRunningAgent` | **Harness** | 只读 |
| 待办数量 | `pending[]` | **Harness** | `office:pending` 回答 |
| 决策 | `missionView().decisions` | DshCockpit | `recordDecision` |
| 未决问题 | `missionView().questions` | DshCockpit | `openQuestion`/`answerQuestion` |
| 工作流 | `missionView().workstreams` | DshCockpit | `addWorkstream`/`updateWorkstreamStatus` |
| 产物 | `missionView().deliverables` | DshCockpit | `registerDeliverable` |

**没有一个字段是推断出来的。** 全部来自已有 IPC。

## 6. 状态矩阵

| 场景 | 侧栏表现 |
|---|---|
| 无 Mission | 创建引导 |
| Mission active + 有待办 | 待办置顶展开，其余折叠 |
| Mission active + 无待办 | 「团队运行正常」+ 概览 |
| Mission paused | 顶部标 `paused`，操作区提示"已暂停" |
| Mission completed | 顶部标 `completed`，操作区只留"查看产物" |
| Harness 断线 | 待办区显示"未连接"，**不显示陈旧数据为实时** |
| 多个 Active | 头部下拉切换，数据隔离 |

## 7. Office 联动

本轮**只做一件**：白板点击 → 右栏滚动到 Mission 区块。
（会议桌/资料架/成果区：用户已确认不做）

## 8. MVP 范围确认

**做**：头部+切换、待办、Mission 快照、决策/问题/工作流/产物（折叠）、底部操作、收起、宽度可调、空状态。

**不做**：委托给 Lead（无 API）、跳转 Session（URL 未知）、
Conflict/Blocker 卡、Quick Panel、第二页重构（用户暂议）。

## 9. 与独立窗口的关系

`mission-desk.html` 独立窗口**保留不动**。
右栏是它的"常驻精简版"，两者共用同一套 IPC action。

**风险**：两份 UI 代码会漂移。缓解：本轮右栏先做，下一轮评估是否让独立窗口
复用右栏的渲染逻辑（但那是重构，不在本轮）。
