# 产物「收获」：从 Agent 回复里登记真实文件（2026-11-02）

> 测试：`test/mission-harvest-deliverables.test.js`（**8/8**）
> 全量：**2981 passed / 0 failed**

## 0. 补的是回写的最后一环

上一轮做完之后，用户能看到 Agent 的回复预览了。但：

**Agent 说"报告在 docs/report.md"——Mission 里没有这个产物。**

用户还是得手填「登记产物」表单，还要自己算 sha256。

## 1. 核心难点：Agent 的话不是证据

Agent 说"我生成了 `docs/report.md`"，这句话可能是：

- 文件根本没创建
- 创建在别的目录
- 被后续步骤删了
- 只是它在描述计划

**所以不能直接把它的话登记成产物。**

## 2. 做法：三层校验，一层都不许少

```
1. 从回复里抽"看起来像路径"的片段
     ↓  只认常见扩展名（md/js/ts/json/...）
2. 过滤掉不该考虑的
     ↓  绝对路径、..、Windows 盘符、纯文件名（位置不明）
3. **逐个 fs.stat 校验真的存在**
     ↓  不存在 → 记 skipped，不登记
4. 算真实 sha256（读文件内容）
     ↓  读不了 → 记 skipped
5. append deliverable.registered（schema 还会再校验一次）
```

**三层防线**：filter → stat → digest → schema。
任何一层单独被破坏，后面的层仍然会拒绝。

## 3. 诚实的关键：报告"提到但没找到"

返回值不只给 `added`，还给 `skipped`：

```json
{
  "added": [{ "relPath": "docs/report.md", "digest": "f374cad0…", "bytes": 14 }],
  "skipped": [{ "relPath": "docs/ghost.md", "reason": "file not found in workspace" }],
  "mentionedTotal": 2
}
```

UI 显示：

```
已登记 1 个真实产物，1 个提到但未找到。
  · docs/ghost.md — file not found in workspace
```

**这比"只显示成功的"诚实得多**——用户能看出 Agent 在吹牛。

## 4. 为什么只认带目录的路径

`README.md`（纯文件名）**不登记**。

理由：不知道它在哪个目录。可能是根目录，也可能是子项目。
**位置不确定就别猜。**

## 5. ⚠️ 两个假测试的教训（重要）

第一版测试是**假测试**：变异验证没抓到任何东西。

### 假测试 1：只断言"被跳过"

```js
// 假测试
assert.deepStrictEqual(r.skipped.map(s => s.relPath), ['docs/ghost.md']);
```

**为什么假**：`fs.statSync` 抛异常 → `stat=null` → 后面 `readFileSync` 也失败
→ `digest=null` → 仍然走 skipped 分支。

所以**删掉 stat 检查，测试照样通过**。

**修**：断言精确到**原因**：

```js
assert.strictEqual(r.skipped[0].reason, 'file not found in workspace',
  'the skip must come from the existence check itself, not a downstream failure');
```

### 假测试 2：只断言"没登记"

```js
assert.deepStrictEqual(r.added, []);  // 绝对路径没被登记
```

**为什么假**：schema 层会拒绝非法 relPath，所以即使 filter 被删掉，
最终结果还是"没登记"。

**修**：断言 `mentionedTotal`——证明它在**处理前**就被过滤了：

```js
assert.strictEqual(r.mentionedTotal, 1,
  'absolute paths and .. must be filtered BEFORE they are considered');
```

### 教训

> **断言必须精确到"为什么"，不能只看"结果是什么"。**
>
> 当一个系统有多层防线时，"结果正确"可能来自任何一层。
> 只断言结果，就测不到任何具体那一层。

## 6. 变异验证（两个都 DETECTED）

| 变异 | 结果 |
|---|---|
| 删掉 `fs.statSync` 存在性检查 | ✅ 2 项红 |
| 删掉绝对路径/`..` 过滤 | ✅ 1 项红 |
| 只删 stat 检查（第一版测试） | ❌ **全绿 —— 假测试** |
| 只删路径过滤（第一版测试） | ❌ **全绿 —— 假测试** |

## 7. UI

Agent 回复预览下方：

```
┌──────────────────────────────────────┐
│ 团队最近一次回复（第 2 轮）            │
│ 已完成调研，报告在 docs/report.md      │
│ 回应的是：先调研 Agent Team            │
│ 这是预览（有长度上限）…                │
│ [核对并登记产物]                       │
└──────────────────────────────────────┘
```

按钮文案是「**核对**并登记产物」，不是「登记产物」——
明确告诉用户我们会去核对，不是照抄 Agent 的话。

## 8. 还没做的

| 项 | 说明 |
|---|---|
| 不监听事件，用户需手动点 | 自动登记风险太高（可能登记中间产物） |
| 只看最后一轮回复 | 历史轮的产物可能已被改 |
| 不读文件内容判断"算不算交付物" | 这需要 Work Receipt 状态机 |
