# plan-review 折叠视图 验收（2026-11-02）

> 探针：`scripts/acceptance/mission-desk-plan-review-acceptance.js`（**15/15**）

## 0. 官方机制（照抄，不猜）

```ts
export type AskUserQuestionIntent = {
  /** A plan submitted for review: `detail` is the plan markdown `ask()` requires. */
  kind: 'plan-review';
  /**
   * The option label that approves the plan; every other option declines it.
   * **Named rather than positional so no UI infers the verdict from option order.**
   */
  approve: string;
  callId?: ToolCallId;
};
```

两条硬约束：

1. `detail` 是**计划的完整 markdown**（可能几千字）
2. `approve` 用 **label 命名**，**不能按选项顺序推断**哪个是批准

## 1. 为什么是折叠而不是弹窗/跳页

GPT 第三轮指出：官方 `@deepseek-ai/dsh-client-ui-plan` **已经**把完整计划
放在右侧栏独立 Tab（`ctx.sidebarRight`，"Open plan in sidebar"）。

**但那是全宽的右栏 Tab，我们这里是 380px。**

三个选项对比：

| 方案 | 问题 |
|---|---|
| 弹窗 | 用户正在看任务，被踢出上下文 |
| 跳第二页 | 用户对第二页暂议；且丢失当前位置 |
| **折叠 + 展开** | ✅ 留在原地，按需展开 |

**所以选折叠。** 这不是凭空发明——是官方模式的窄栏适配。

## 2. 实现

```
计划待审阅
# 实施计划：Runtime Bridge 接入

## 目标
把官方的 Session Projection 接到 Mission Desk。
────────────────────────────────
展开全文（还有 9 行）
[批准计划]
[拒绝，需要修改]
[或自定义回答…            ] [发送]
```

| 参数 | 值 | 理由 |
|---|---|---|
| 默认预览行数 | 4 行 | 够看出这是什么计划 |
| 预览最大高度 | 120px | 不至于把侧栏撑爆 |
| 展开后最大高度 | 320px | 内部滚动，页面不跳 |
| 展开按钮文案 | `展开全文（还有 N 行）` | 告诉用户还有多少，不是模糊的"展开" |

## 3. 验收结果（15 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | plan-review 区块渲染 | `计划待审阅` |
| 2 | **默认折叠**（预览短于全文） | `72 / 194` 字符 |
| 3 | 有展开按钮 | ✅ |
| 4 | 按钮说明还有多少行 | `展开全文（还有 9 行）` |
| 5 | **正文高度受限**（不撑爆 380px） | `maxHeight: 120px` |
| 6 | **展开真的显示全文** | `72 → 194` |
| 7 | 展开后按钮变「收起」 | ✅ |
| 8 | 收起恢复预览 | ✅ |
| 9 | 选项渲染成按钮 | `["批准计划","拒绝，需要修改"]` |
| 10 | **approve label 是选项之一，不按索引推断** | ✅ |
| 11 | **点击"批准计划"送出该 label** | `{action:'answer', id:'call-1', value:'批准计划'}` |
| 12 | 无 `detail` 时如实说明 | `计划没有附带正文…` |
| 13 | **非 plan-review 问题不显示计划区块** | ✅ |
| 14 | 双主题截图 | ✅ |
| 15 | 无致命错误 | ✅ |

## 4. approve 的处置（重要）

我们**不按选项顺序猜哪个是批准**：

- 只把点击的那个 label 原样送出
- 判定完全交给运行时

**这是官方设计意图**——它特意说 "Named rather than positional
**so no UI infers the verdict from option order**"。

如果我们按"第一个是批准"实现，就会在官方调整选项顺序时静默出错。

## 5. 没做的（如实记录）

| 未做 | 原因 |
|---|---|
| 独立审查 Tab（全宽） | 需要用户对"第二页"的决策，暂议 |
| 计划 markdown 渲染（标题/列表/代码块） | 当前是 `<pre>` 等宽显示，纯文本可读但无样式 |
| `callId` 关联原始 tool 调用 | 官方给了 `callId?`，可用来跳转查原始计划，本轮未接 |

## 6. 复现

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-plan-review-acceptance.js
```
