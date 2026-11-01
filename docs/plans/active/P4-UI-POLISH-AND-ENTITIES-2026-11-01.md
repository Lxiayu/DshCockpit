# 右栏 UI 深度打磨 + Finding/Assumption/Evidence

> 状态：执行中（2026-11-01）
> 触发：用户截图反馈"还是单调的黑色，ui 并不好看"、"是否有些单调"
> 上游：`docs/quality/mission-desk-attention-acceptance-2026-11-01.md`

## 0. 先修一个真实 bug

截图显示零 Mission 时**同一段引导出现两遍**：

```
从这里开始 / 一个 Mission 就是…   [创建第一个 Mission]   ← #list 里的
还没有选中任何 Mission / 先在左边创建…                    ← #detail 里的
```

原因：dock 模式隐藏了 `#list .card` 和 `#list .empty`，但空状态的
`empty-lead/empty-body/button` 是**直接挂在 `#list` 下的**，没被隐藏。

修：dock 模式下 `#list` 整个 `display:none`（下拉已替代选择职责）。

## 1. 为什么现在"单调"——第一性原理

用户说"单调的黑色"。但**不是颜色不够多**——是**缺乏视觉层次**。

### 诊断：当前右栏的四个问题

| 问题 | 表现 | 根因 |
|---|---|---|
| **1. 全是同一层级的白字** | 标题、正文、元信息只是字号微差 | 层级靠 color 而非 scale/weight |
| **2. 区块之间只有横线** | 一条条横线切分，像表单 | 用分隔线代替留白与背景 |
| **3. 大面积纯黑** | `--bg-app: #0A0A0C` 直接铺满 | 没有"表面"层次（surface/elevated） |
| **4. 静态无反馈** | 行不可点、无 hover | 没有交互暗示 |

### 关键洞察（来自 Linear 设计系统）

调研了 [Linear DESIGN.md](https://github.com/opencoworkai/open-codesign/blob/ca833517a009bb194b95c7620005a8dc8b57bf88/apps/desktop/resources/templates/brand-refs/linear/DESIGN.md)，
它有一条原则直接命中我们的问题：

> **「Hierarchy is enforced through scale and weight, never color.」**
> （层级靠字号与字重，绝不靠颜色）

还有两条：

> 「Issue rows: dense list rows, 32px tall, **no separators — only background hover state**」
> 「**Don't**: Add iconography to row items unless functionally required」

对照我们的实现：

| Linear 原则 | 我们的现状 | 判断 |
|---|---|---|
| 层级靠 scale/weight | 靠 `--text-1/2/3/4` 四级色 | ❌ 违反 |
| 无分隔线，靠 hover | 到处 `border-top` | ❌ 违反 |
| 单一强调色 | `--acc` + 5 个语义色 | ⚠️ 语义色有必要，但用得太散 |
| 密集行高 28-32px | 行高约 36-40px | ⚠️ 偏松 |
| 近黑背景 `#08090A` | `#0A0A0C` | ✅ 接近 |
| surface `#101113` 用于侧栏 | `--bg-panel: #121216` | ✅ 接近 |

**结论：我们的 token 数值没问题，问题是"怎么用"。**

## 2. 具体改什么

### 2.1 层级靠 scale + weight（最重要的改动）

| 层级 | 现在 | 改后 |
|---|---|---|
| 区块标题 | 12px / 620 / `--text-2` | **11px / 650 / uppercase / letter-spacing .06em** / `--text-3` |
| 主内容 | 12px / 400 / `--text-1` | 13px / 450 / `--text-1` |
| 元信息 | 10.5px / 400 / `--text-3` | 11px / 400 / `--text-3` |
| 数值强调 | 无 | **tabular-nums + 600** |

小标题用 uppercase + tracking 是 Linear/Notion 的通用做法：
**它让"标签"和"内容"在视觉上立刻分开，而不需要额外的颜色或框。**

### 2.2 用留白和背景代替分隔线

- 移除区块间的 `border-top`
- 用 `margin` + 极浅的背景差（`--bg-panel` vs `--bg-app`）
- 只保留**卡片内部**的分隔（那些是必要的信息切分）

### 2.3 建立"表面"层次

当前只有 `--bg-app` 和 `--bg-panel` 两级在用。
改用三级：
- `--bg-app`：页面底
- `--bg-panel`：区块卡
- `--bg-hover`：行 hover / 内嵌井

### 2.4 交互反馈

- 可点的行加 hover 背景
- 按钮加 `:active` 位移 1px（Linear 的做法：无阴影，靠微位移）

## 3. 前三项未完成功能

| # | 功能 | 状态 |
|---|---|---|
| 1 | Needs Your Attention 置顶 | ✅ 已完成（上一轮） |
| 2 | Since You Were Away | ✅ 已完成（上一轮） |
| 3 | **Finding / Assumption / Evidence 实体** | ❌ 本轮 |
| — | 前端深度打磨 | ❌ 本轮 |

等等——用户说"可以开始还没做的前三项了"。按我上一轮列的清单，
前三项是：Finding/Assumption 实体、委托任务、跳转 Session。

但委托和跳转**没有 API**（grep 为 0），做了就是假的。

**所以我按"能真正做完"重新排序**：

| 优先 | 项 | 依赖 |
|---|---|---|
| 1 | Finding / Assumption / Evidence（schema + IPC + UI） | 无 |
| 2 | Shared Context 视图（基于 3 个新实体的分组展示） | 项 1 |
| 3 | 侧栏宽度可拖（380 → 640） | 无 |

第 4 项才是委托/跳转——需要先确认 Harness 有没有对应 API。

## 4. 验收标准

- [ ] 零 Mission 时引导只出现一次
- [ ] 层级可辨：不看颜色也能分出标签/内容/元信息
- [ ] 区块间无分隔线，靠留白分组
- [ ] 可点行有 hover 反馈
- [ ] Finding/Assumption/Evidence 可写入、可读取、可展示
- [ ] **Evidence 关联到 Decision/Finding**（这是"凭什么相信"的关键）
- [ ] 双主题下依然达标
- [ ] 两个主题截图

## 5. 非目标

- ❌ 委托任务 / 跳转 Session（无 API，需先调研）
- ❌ 第二页重构（用户暂议）
- ❌ 改办公室主场景
