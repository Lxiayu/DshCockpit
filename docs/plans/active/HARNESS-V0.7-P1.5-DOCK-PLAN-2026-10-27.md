# HARNESS v0.7 P1.5 —— 工作坞并入办公室 + 角色悬停卡（实施计划）

状态：**已开工**（用户 2026-10-27 拍板："两点都先按照你说到的做，我们来看看效果"）
依据：`docs/product/WORK-FIRST-V0.7.md`、P1 报告 §3.2（真机验收）
日期：2026-10-27

## 0. 目标

把"用团队"和"看团队"放进同一个视线：

1. 办公室右侧出现**工作坞**（壳拥有的兄弟视图）：任务输入、状态、产物、证据；可展开为全屏。
2. 办公室自有右栏在坞模式下收成**浮动的「待你处理」卡片**；员工列表/详情/用量/时间线让位。
3. 鼠标悬停某个鲸鱼娘 → 她停下、转正面、弹出该成员的详情卡；点击钉住，移开/Esc 关闭。
4. `office:*` 仍为 8 个；新交互走 `shell:*`。不新增 Team 事实。

## 1. 边界（不得违反）

- 办公室仍是**投影消费者**：工作坞是壳视图，数据走 `shell:work`，不借道 `office:*`。
- 悬停只改变**呈现状态**（暂停/朝向），不写任何 Team/Office 事实；快照新增 `presenting` 布尔。
- 悬停卡只显示快照已有的去标识字段（姓名/状态/动作短语/任务序号/产物计数/今日计数），
  绝不显示 prompt、工具参数、路径。
- 工作坞与全屏工作台共享同一 `shell:work` 状态；不存在第二套事实。

## 2. 结构

```
主窗口
├─ rail（44px）
├─ 主区域
│   ├─ office 视图（宽度 = 主区域 - 坞宽；docked 模式下隐藏自有右栏）
│   └─ work dock 视图（右侧，默认 380px，work.html?compact=1）
└─ 全屏 work 视图（rail 或坞内「展开」进入；activeMainView='work'）
```

办公室在 docked 模式下：
- `body.docked`：`#office-panel` 变为左上浮动卡片；`#usage-block`/`#employee-list-block`/
  `#activity-block`/`#details` 隐藏；只有 pending 非空时卡片出现（`body.has-pending`）。

## 3. 通道

| 通道 | 方向 | 说明 |
|---|---|---|
| `shell:office-present` | invoke | `employeeId \| null` → 办公室模拟暂停/恢复该员工的呈现；校验 id 白名单 |
| `shell:office-layout` | push | `{dock: boolean, width}` → 办公室页面切换 docked 模式 |
| `shell:work`（既有） | invoke | 新增 `action: 'expand'`：坞内展开为全屏工作台 |

`office:*` 保持 8 个（有测试钉住）。

## 4. 工作包

### WP-A 工作坞
- `window-manager`：`workDockView`（沙箱、work-preload、`work.html?compact=1`）；办公视图与坞同排；
  `sendToWorkView` 同时推送两个视图；`broadcastToShellViews` 覆盖坞；坞随主窗口销毁。
- `window-manager`：`shell:office-layout` 推送（进入/退出坞模式）。
- `work.html/js/css`：`compact` 模式（单列、历史折叠、查看器有界）；「展开」按钮。
- `work-ipc`：`expand` action → 全屏工作台。

### WP-B 悬停卡
- `office-module`：`setPresenting({employeeId, presenting})`；记录 `presenting`；tick 中跳过
  移动/行为决策/锚点插值（保留预约续期）；快照 `presenting`。
- `office.html`：`pointermove` 节流命中（复用 `renderer.hitTest`）→ `office:present` 调用 +
  成员卡渲染（跟随指针）；点击钉住、Esc/移出关闭。
- `office-preload`：`present(employeeId)`、`onDockLayout(cb)`。
- `main`：`shell:office-present` 校验 + 调用；`shell:work` 的 `expand`。
- 卡片字段：姓名、状态、当前动作、任务 #、产物数、今日完成/未完成、最近动态。

### WP-C 验收
- 源级接线测试 + 办公室模块 `setPresenting` 行为测试 + 全量回归。
- CDP 真机脚本：坞出现、待你处理浮卡、悬停暂停+转正面+卡片、展开全屏、产物可读。

## 5. 变异清单

| # | 变异 | 期望 |
|---|---|---|
| N1 | 坞宽度占满主区域 | 布局测试红 |
| N2 | docked 模式不隐藏自有右栏 | 页面契约测试红 |
| N3 | `shell:office-present` 不校验 id | 校验测试红 |
| N4 | 悬停不暂停（presenting 不参与 tick） | 行为测试红 |
| N5 | 卡片显示未白名单字段 | 隐私测试红 |
| N6 | `expand` 不进全屏 | 接线测试红 |

## 6. 进度

- [x] WP-A 工作坞（380px 壳视图、compact 工作台、办公室右栏收成浮动待办、展开全屏）
- [x] WP-B 悬停卡（暂停/转正面、钉住、Esc、`shell:office-present` 白名单）
- [x] WP-C 验收（1861 绿；CDP 真机脚本已执行：坞/悬停/钉住/展开）

**真机备注**：`resize()` 需要 ResizeObserver（隐藏右栏不触发 window resize）；
座位白名单取自模块常量 `EMPLOYEE_IDS`（实例上不存在）；聊天伙伴的决策不得改写
呈现中员工的朝向。三处均已在实现中修正。
