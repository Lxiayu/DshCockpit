# Mission Desk 写入路径真机验收（P4，2026-11-01）

> 探针：`scripts/acceptance/mission-desk-write-acceptance.js`（15/15 通过）
> 证据：[`acceptance/mission-desk-write-acceptance-2026-11-01.json`](acceptance/mission-desk-write-acceptance-2026-11-01.json)

## 0. 一句话结论

**15/15 通过。** Mission Desk 从"只读报表"变成"编辑器"，并且打通了 Mission↔Harness 的连接点。

## 1. 起因：审计发现 Desk 是只读的

18 个 action 里 **7 个没有 UI 出口**，其中 4 个是写入。后果：

| 价值主张 | 依赖 | 修复前 |
|---|---|---|
| V2「跨会话不丢决策」 | `recordDecision` | ❌ 无入口 |
| V3「产物是真实文件」 | `registerDeliverable` | ❌ 无入口 |

**没有写入的 Desk 不叫 Desk，叫报表。**

## 2. 先修治理漏洞（比功能缺失更严重）

```js
// 修前
status:    payload.status    || 'accepted'   // 已接受
decidedBy: payload.decidedBy || 'user'       // 用户拍的板
```

两个默认值合起来 = **任何人不传这两个字段，写出来的就是"用户已接受的决策"**。
模型只要调一次，幻觉就变成用户共识。

`user-journeys` §5.4 早就写着「Agent 不能直接把东西标为已定决策」——
但那条规则**只在文档里**，代码默认做着相反的事。

修复为 fail-safe 默认：`proposed` + `model`。
**宁可把真实用户决策标成"待确认"，也不要让模型幻觉变成用户共识。**

## 3. 三条写入路径

| 表单 | 关键设计 |
|---|---|
| 记录决策 | 理由**必填**（UI 先挡，不吃后端错误）；显式传 `accepted`/`user` |
| 登记产物 | 复用 `registerDeliverable` —— **真的读文件算 sha256**，不存在的路径被拒绝 |
| 工作流 | 新建 + 就地状态切换，不弹窗 |

**proposed 与 accepted 在 UI 上必须可区分**（提议中=琥珀 / 已接受=绿），
否则"模型提议"会被误读成"已经拍板"。

## 4. 为什么离线测试不够

离线测试能证明：源码调了 `recordDecision`、store 能写入读回。

它证明不了**在真实 DOM 里点那个按钮会发生什么**。典型失败模式：
- 按钮在，但 input 选择器拿错 → 提交空值
- `refresh()` 没重绘 → 用户看不到刚写的内容
- 表单在 `display:none` 容器里 → 用户点不到

第一版探针就踩了第一个坑：用 `[data-mission-id]` 找卡片，但卡片是
`div.card[role="button"]`，没有那个属性 → 全部 8 项失败。
**这恰好证明了真机验收的价值**——离线测试永远发现不了选择器写错。

## 5. 验收结果（15 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | Mission 卡片可选中 | cards=1 |
| 2 | 页面加载 + 桥可用 | `dshShell=object` |
| 3 | 决策表单**存在且可见** | 3/3 + `visible=true` |
| 4 | **点击真的写入 store** | `用 SQLite 而不是 JSON` |
| 5 | 用户提交的决策标记为 accepted/user | `accepted/user` |
| 6 | **写入后 UI 重绘** | `true` |
| 7 | 登记真实文件算出真实 sha256 | `7cc600c9523ac647…` |
| 8 | 工作流可从 UI 创建 | `接入 StepFun` |
| 9 | 工作流状态可就地切换 | `blocked` |
| 10 | 截图 | 2360×1630 |
| 11 | 无致命错误 | ✅ |
| 12 | **可从 UI 关联一次执行（TaskRef）** |  |
| 13 | **关联的是派生句柄不是 sessionId** |  |
| 14 | **sessionId 全程未落盘** |  |
| 15 | **重启后四类数据全部保留** |  |

截图确认：决策区显示「用 SQLite 而不是 JSON **已接受**」+ 理由；
工作流显示 `[blocked] 接入 StepFun` + 三个状态按钮；
产物显示 `验收报告 unchecked` + `docs/report.md · sha256:7cc600c9523a…`。

## 6. 复现方式

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-write-acceptance.js
```

## 7. 仍未做

`update`（改标题/目标）和 `openQuestion`（主动提问）还没有 UI。
优先级低于已做的三条——它们是"编辑已有内容"，
而这三条是"产出新事实"。
