# Shared Context 三实体 + UI 层级打磨 验收（2026-11-01）

> 探针：`scripts/acceptance/mission-desk-shared-context-acceptance.js`（**17/17**）
> 证据：[`acceptance/mission-desk-shared-context-acceptance-2026-11-01.json`](acceptance/mission-desk-shared-context-acceptance-2026-11-01.json)

## 0. 修了一个截图能看到的 bug

用户截图显示零 Mission 时**同一段引导出现两遍**：

```
从这里开始 / 一个 Mission 就是…   [创建第一个 Mission]   ← #list
还没有选中任何 Mission / 先在左边创建…                    ← #detail
```

原因：dock 模式隐藏了 `#list .card` 和 `#list .empty`，
但空状态的 `empty-lead/empty-body/button` 是**直接挂在 `#list` 下的**。

修：dock 模式下 `#list` 整个 `display:none`（下拉已替代选择职责）。

## 1. 为什么之前"单调"——诊断

用户说"单调的黑色"。**不是颜色不够多，是缺乏视觉层次。**

四个问题：

| 问题 | 根因 |
|---|---|
| 全是同一层级的白字 | 层级靠 **color** 而非 **scale/weight** |
| 区块间只有横线 | 用分隔线代替留白 |
| 大面积纯黑 | 没有"表面"层次 |
| 静态无反馈 | 无 hover |

### 来自 Linear 设计系统的关键原则

调研 [Linear DESIGN.md](https://github.com/opencoworkai/open-codesign/blob/ca833517a009bb194b95c7620005a8dc8b57bf88/apps/desktop/resources/templates/brand-refs/linear/DESIGN.md)：

> **「Hierarchy is enforced through scale and weight, never color.」**
> **「no separators — only background hover state」**

对照我们的实现，第一条被完全违反了。

## 2. 改了什么

### 层级靠 scale + weight

| 层级 | 改前 | 改后 |
|---|---|---|
| 区块标题 | 13px / 400 / text-2 / 小写 | **11px / 650 / UPPERCASE / tracking .07em** |
| 正文 | 12px / 400 | 13px |
| 元信息 | 10.5px | 11px |
| 数字 | 普通 | **tabular-nums**（变化时不跳动） |

小标题 UPPERCASE + 字距让"标签"和"内容"在**形状上**就分开，不依赖颜色。

### 去掉分隔线

`.sec { border-top }` → `.sec { margin-top: 14px }`。靠留白分组。
待办卡片**内部**的分隔线保留（那是必要的信息切分），但改成极淡的 inset。

### 交互反馈

- 可点行加 hover 背景
- 待办项 hover 时底色变化（Linear 的"只靠 hover 承载 affordance"）

## 3. 三个新实体

| 实体 | 回答什么 | 关键约束 |
|---|---|---|
| **Finding** | 我们发现了什么 | `confidence` 只允许 low/medium/high（**不允许 73% 这种虚假精确**） |
| **Assumption** | 暂时假设什么 | `violated` **必须给理由**；`expired` 是**显式状态**不靠时间推算 |
| **Evidence** | 凭什么相信 | `ref` 必须**相对路径**（隐私边界）；`claim` 必填 |

### 为什么 Assumption 最重要

**假设是未来会爆炸的地雷。**

没有它，团队会在三天后基于一个早已不成立的前提继续工作，
而且没人知道当初假设了什么。

所以它必须有 `verifyBy`（怎么验证还成立）与显式 `status`——
而不是靠"时间过了就自动过期"（那是**推断**，不是事实）。

### Evidence 只存引用不存内容

`ref` 是相对路径 / commit sha / URL / 命令。
**绝不存文件内容本身**——那是隐私边界，也会让事件日志爆炸。

`targetKind`/`targetId` 让它挂到某个 decision/finding/assumption 上，
形成"这条证据支持那个结论"的反向关联。

## 4. 一致性检查抓到的真实问题

加了 5 个 IPC action 后，`mission-desk-action-parity` 测试报错：

> these actions have no UI and no documented reason:
> recordFinding, updateFindingStatus, recordAssumption, updateAssumptionStatus, recordEvidence

**我第一版只做了展示，没做写入入口**——正是"只能看不能写"的老问题。

修：补三个写入表单 + 两个状态推进按钮（已验证/推翻、仍成立/已推翻）。

真机验证三个表单都能提交，payload 正确：
```
{"missionId":"mis-1","text":"测试发现","confidence":"medium","foundBy":"user"}
```

## 5. 验收结果（17 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | dock 模式列表完全隐藏（无重复引导） | `display:none` |
| 2-4 | 三个实体渲染真实数据 | ✅ |
| 5 | refuted 显示"已推翻" | ✅ |
| 6 | violated 显示原因 | ✅ |
| 7 | evidence 显示它的 claim | ✅ |
| 8 | 状态徽标存在 | 6 个 |
| 9 | 标签用 UPPERCASE + tracking | `11px/650/0.77px/uppercase` |
| 10 | **正文 > 元信息（scale 承载层级）** | `12.5 > 10.5` |
| 11 | **标签 > 正文（weight 承载层级）** | `650 > 400` |
| 12 | 区块间无分隔线 | `[]` |
| 13 | 深色对比度 | 正文 18.17 / 元信息 6.07 |
| 14 | 浅色对比度 | 正文 16.43 / 元信息 4.85 |
| 15 | 浅色元信息 ≥ AA | 4.85 |
| 16 | 双主题截图 | ✅ |
| 17 | 无致命错误 | ✅ |

## 6. 新增测试

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `test/mission-shared-context-entities.test.js` | 14 | schema 校验 + 端到端 IPC |
| `test/theme-tokens.test.js`（上轮） | 4 | 假 token / 双主题 / 零硬编码 |

关键断言：
- 置信度不接受数字（防虚假精确）
- violated 无理由被拒（`VIOLATED_REASON_REQUIRED`）
- 绝对路径证据被拒（`EVIDENCE_INVALID`）
- 模型不能伪造用户署名的发现（`foundBy` 默认 `model`）

## 7. 复现

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-shared-context-acceptance.js
```
