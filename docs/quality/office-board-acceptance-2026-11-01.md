# 项目白板真机验收报告（P2.3 S4，2026-11-01）

> 探针：`scripts/acceptance/office-mission-board-acceptance.js`（10/10 通过）
> 证据：[`acceptance/office-board-acceptance-2026-11-01.json`](acceptance/office-board-acceptance-2026-11-01.json)
> 离线守卫：`test/office-board-acceptance.test.js`（10 项）

## 0. 一句话结论

**10/10 通过。** 并且这次验收同时纠正了我上一轮的一个**错误诊断**。

## 1. 先纠正错误诊断

上一轮我写：「`latestSnapshot` 有三份作用域副本，需先理清才能做渲染验收」。

**这是错的。** 数据流一直是通的：

```
office:state → bridge.getState() → page.applySnapshot()
  → onSnapshot 回调 → renderMissionBoard()
```

失败的真实原因全是**探针环境缺件**。逐层排查后共 4 层：

| # | 缺什么 | 症状 |
|---|---|---|
| 1 | `registerSchemesAsPrivileged` | CSP 拒绝 CSS/JS，页面白屏 |
| 2 | `office:state` / `office:visibility` | `__office.ready=false`，整页不渲染 |
| 3 | **页面订阅 `bridge.onState()`** | **每次推送都 applySnapshot，覆盖手动注入的快照** |
| 4 | **`shell:get-i18n`（共享词典）** | **`tr()` 全部返回空串，标题和计数全空** |

### 为什么第 3/4 条特别容易误导

**第 3 条**：我注入快照后立即读 DOM，看到的永远是初始值（`not-wired`），
于是判断"注入无效"→"渲染坏了"。实际是页面自己的推送把它覆盖了。

**第 4 条**：白板行渲染出来了但标题和计数全是空串。看起来像"i18n 坏了"，
实际是 `tr()` 走的是 `officeBridge.i18n.t()`，而探针没提供那个通道。

**教训：先让真实链路跑通，再考虑注入。** 注入绕过订阅可以，但绕过 i18n
只会制造假失败。最终方案是**完全不注入**——让 stub 的 `office:state`
直接返回带白板的数据，页面自然走完整启动链路。

## 2. 验收结果

| # | 检查 | 实际值 |
|---|---|---|
| 1 | 页面启动 | `__office.ready=true` |
| 2 | 白板渲染 | rows=1 |
| 3 | Mission 标签 | `重构认证模块` |
| 4 | 计数渲染 | `2/3 条工作线 · 5 条决策` |
| 5 | "需要你" | `2 个待回答` |
| 6 | 空态互斥 | empty/unavailable 均 hidden |
| 7 | **高亮真生效** | `color=rgb(255, 207, 122)` |
| 8 | more 披露 | `还有 1 个 Mission 在 Mission Desk 中` |
| 9 | i18n | 标题=`项目白板` |
| 10 | 截图 | 2800×1630 |

### 第 7 条的做法值得说明

只断言 `.needs-you` class 在 DOM 里是不够的——class 存在不等于 CSS 生效
（选择器写错、被覆盖、优先级问题都会让它失效）。

所以探针用 `getComputedStyle(el).color` 读**实际生效的颜色**：
`rgb(255, 207, 122)`，正是 CSS 里定义的那个橙色。

### 视觉确认

截图（2080×1384 右侧面板）显示：
- 「项目白板」位于**「今日用量」之上** —— 符合注意力顺序（需要你的事先看）
- `重构认证模块` 加粗标签
- `2/3 条工作线 · 5 条决策 · 2 个待回答` 橙色高亮
- `还有 1 个 Mission 在 Mission Desk 中`

## 3. 探针守卫：把 4 个坑钉死

`test/office-board-acceptance.test.js`（10 项）断言探针必须：
- `registerSchemesAsPrivileged`
- 提供 `office:state` / `office:visibility`
- 提供 `shell:get-i18n`，且用**真实词典** `i18n.STRINGS`
- **不得手动注入快照**（不得有 feedSnapshot / page.applySnapshot）
- 断言渲染**内容**而非仅存在性
- 高亮用 getComputedStyle 验证

### 守卫本身也踩了一个坑

第一次跑守卫有 2 项失败——因为我的正则匹配到了**注释里**的
`page.applySnapshot` 和 `registerSchemesAsPrivileged`。

**断言必须只看代码。** 这是本项目多次遇到的同类问题
（office.html 的设计注释、i18n 的说明文字…），已固定成习惯写进文件头：
断言前先剥离注释。

## 4. 复现方式

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/office-mission-board-acceptance.js
```

证据落在 `$TMPDIR/office-board-acceptance/`。

## 5. P2.3 最终状态

| 步 | 状态 |
|---|---|
| S1 派生层 | ✅ 26 项测试 |
| S2 主进程读取（30s TTL） | ✅ 全量回归 |
| S3 快照白名单 | ✅ 13 项 |
| S3 端到端链路（真实 store） | ✅ 8 项 |
| S4 渲染层静态契约 | ✅ 14 项 |
| **S4 真机验收** | ✅ **10/10** |

**合计 71 项离线测试 + 10 项真机检查。**
