# Mission Desk 右栏改造验收（2026-11-01）

> 探针：`scripts/acceptance/mission-desk-dock-acceptance.js`（**14/14 通过**）
> 证据：[`acceptance/mission-desk-dock-acceptance-2026-11-01.json`](acceptance/mission-desk-dock-acceptance-2026-11-01.json)

## 0. 改了什么

| | 改前 | 改后 |
|---|---|---|
| 页面 | `src/work/work.html?compact=1` | `src/mission-desk.html?dock=1` |
| preload | `work-preload.js` | `settings-preload.js` |
| 内容 | 工作区选择 + 任务输入 + 任务列表 | Mission 快照 / 决策 / 问题 / 工作流 / 产物 |
| 布局 | 双栏被压进 380px | 单列（下拉选 Mission + 纵向详情） |

## 1. 为什么复用 mission-desk.html 而不新写一页

**两份 UI 必然漂移**——待办列表、状态色、错误文案、空状态都要同步两处。

复用同一个文件、只让布局随尺寸变，是**唯一不会漂移**的做法。
代价是要在一个文件里维护两套布局（`.dock` 前缀的选择器），
但这比维护两个文件便宜得多。

## 2. 真机验收抓到的三个真实 bug

### bug 1：选择器被 renderList 清空

第一版把 `#dockPicker` 放在 `#list` 里面。但 `renderList()` 第一行是：

```js
box.textContent = '';   // 把 picker 一起清掉了
```

结果 `$('dockSelect')` 返回 null，下拉永远不出现。

**修**：把 picker 移到 `#list` 外面。

### bug 2：字段名写错，页面渲染 `undefined已接受`

验收脚本里我用 `{ summary: '...' }` 写决策，但 schema 要求的是 `text`：

```js
// src/mission/schema.js:224
if (!isNonEmptyString(d.text)) errors.push('text is required (what was decided)');
```

页面渲染出 `undefined已接受`。

**这是验收脚本的错，不是产品的错**——产品代码一直用的是 `d.text`。
但它暴露了更深的问题：**我写验收数据时凭印象，没有对照 schema**。

**修**：验收脚本改用真实字段名，并加守卫断言
（`doesNotMatch src: summary: '暂不引入第二套 Harness'`），
这样下次用错字段名会立刻红。

### bug 3：视觉重复

- 列表卡片（`.card.sel`）在详情上方以蓝色边框卡片重复出现
- 顶部 `h1 "Mission Desk"` 与选择器里的 `"MISSION DESK"` 标签重复

原因：`body.dock #list .row { display: none }` 只隐藏了 `.row`，
没隐藏 `.card`（卡片本身包含 `.row` 和 `.title`）。

**修**：`body.dock #list .card { display: none }`。

## 3. 验收结果（14 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | dock 模式生效 | `body.dock` ✅ |
| 2 | 选择器可见 | `block` |
| 3 | 选择器占满宽度（单列，不是压扁的双栏） | `list=380 doc=380` |
| 4 | 详情区在选择器**下方**（纵向堆叠） | `detailTop=179 listBottom=179` |
| 5 | 380px 下无横向溢出 | `false` |
| 6 | 显示 Mission 标题（在 picker 里） | `DshCockpit Runtime 集成` |
| 7 | 显示目标 | ✅ |
| 8 | 显示工作流 | ✅ |
| 9 | 显示决策 | ✅ |
| 10 | **旧的"先选一个工作区"已消失** | ✅ |
| 11 | **旧的任务表单已消失** | ✅ |
| 12 | 自动选中第一个 Mission（打开即有内容） | `value=mis-1, count=1` |
| 13 | 截图 | 760×1584 |
| 14 | 无致命错误 | ✅ |

## 4. 截图

`dock-380.png`（380px 逻辑尺寸，2x 缩放）显示：

```
Mission Desk                        进行中 1/共 1   [新建 Mission]
┌────────────────────────────────────────────────────┐
│ DshCockpit Runtime 集成                        ▼  │
└────────────────────────────────────────────────────┘
Mission 状态（我们拥有）
[active ▼]
实时状态（Harness 拥有，只读）
观察到 刚刚 · Agent 在跑：是 · 待审批 1 · 待回答 1
这项状态由 Harness 提供，DshCockpit 只读不写（所以不会在重启后撒谎）。

目标
完成 Agent Team 接入                            [改]
边界
未声明边界。
决策（含理由）
· 暂不引入第二套 Harness  已接受
  为什么：官方已足够
· 右栏复用 mission-desk.html  提议中
  为什么：避免两份 UI 漂移
[决定了什么…] [为什么（必填）…]  [记录决策]
未决问题
· 第二页做什么？  [回答…] [回答]
工作流
· [completed] 技术调研  进行中 阻塞 完成
```

## 5. 保留了哪些原有约束

| 约束 | 状态 |
|---|---|
| Mission 状态是我们拥有的 | ✅ 可编辑下拉 |
| 实时状态是 Harness 拥有的（只读） | ✅ 明确标注"只读不写" |
| 决策必须带理由 | ✅ 输入框标注"（必填）" |
| 决策 proposed / accepted 区分 | ✅ "提议中" vs "已接受" |
| 工作流状态机 | ✅ 保留 |
| 产物 sha256 校验 | ✅ 保留 |

**没有引入任何新的数据结构**——完全复用已有 IPC 的 20 个 action。

## 6. 复现方式

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-dock-acceptance.js
```

## 7. 未做（明确记录）

| 项 | 原因 |
|---|---|
| Needs Your Attention 置顶区块 | 需先接入 office 快照到右栏（下一轮） |
| Since You Were Away | 缺 `lastSeenAtMs` 持久化 |
| Finding / Assumption 实体 | 无 schema |
| 委托任务 / 跳转 Session | 无 API |
| 侧栏宽度可拖 | 本轮先固定 380 |
| 第二页重构 | 用户要求暂议 |
