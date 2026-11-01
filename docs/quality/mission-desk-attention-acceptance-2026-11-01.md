# 待办区 + 离开期间 + 双主题 验收（2026-11-01）

> 探针：`scripts/acceptance/mission-desk-attention-acceptance.js`（**19/19 通过**）
> 证据：[`acceptance/mission-desk-attention-acceptance-2026-11-01.json`](acceptance/mission-desk-attention-acceptance-2026-11-01.json)
> 截图：`/tmp/mission-desk-attention-acceptance/`（深/浅 × 有/无待办，共 4 张）

## 0. 做了什么

| 区块 | 层次 | 数据来源 |
|---|---|---|
| **需要你处理** | L1（置顶、最高对比） | `office` 快照 → `mission.attention` 聚合 |
| **你离开期间** | L2（时间线） | Mission 投影 + `lastSeenAtMs` |
| 快照/决策/问题/工作流 | L3（参考） | 已有 |

## 1. 第一性原理：待办不是"多一个区块"，是排序机制

做成普通区块 = **又多了一个要用户自己找的地方**。

三个设计判断：

| 判断 | 理由 |
|---|---|
| **零待办时也占位** | 空白会让用户不确定"是真的没有还是加载失败" |
| **按 risk 排序，不按时间** | 一个高风险审批比十个低风险提问更急 |
| **每张卡必须能直接处理** | 只显示不能点 = 用户还得去别处找 |

## 2. "离开"的定义

三个候选：

| 定义 | 问题 |
|---|---|
| 上次关闭应用 | 用户可能整天开着 |
| 上次右栏可见 | 切视图就触发，噪音大 |
| **上次查看这个 Mission** | ✅ 语义准确 |

### 存储位置的关键判断

`lastSeenAtMs` **不写进 Mission 实体**——它是 UI 偏好，不是项目事实。

`schema.js` 的 `FORBIDDEN_PERSISTED_FIELDS` 已把 `focused` 这类列进黑名单，
`lastSeenAtMs` 是同一类：写进项目数据就会同步给别人，而对别人毫无意义。

存在 `<workspace>/.dsh/ui-seen.json`（0600，原子写）。

## 3. 时间线只列真实事件，不用模型生成

| 事件 | 变成一句话 |
|---|---|
| `decision.recorded` | 决策 <text> |
| `openQuestion.opened` | 提问 <text> |
| `deliverable.registered` | 产物 <label> |
| `workstream.created` | 工作流 <title> |

**用户要的是"发生了什么"，不是"模型猜测发生了什么"。**

超过 12 条时截断，并如实说明"另有 N 条未显示"。

## 4. 前端打磨：视觉重量承载语义

用户要求"不要只是简单的几个框和按钮"。做法是**三级视觉重量**：

| 层 | 内容 | 处理 |
|---|---|---|
| L1 | 需要你处理 | 红边框 + 风险色左竖条 + 最高对比 |
| L2 | 离开期间 | 卡片 + 时间线圆点（ok绿/warn橙/info蓝） |
| L3 | 参考 | 仅分隔线 |

### 双主题彻底打通

**这页原来有 37 处硬编码颜色**，浅色模式下 `#8fc0ff` 浅蓝字配白底几乎不可见。

现在：**页面内零硬编码颜色**，全部走 `theme.css` 的 token。
新增 13 个语义 token（`--att-*` / `--tl-*` / `--on-acc`），两套主题各自定义。

## 5. 真机验收抓到的三个真实 bug

### bug 1：`--bg-2` 是个不存在的 token（"假 token"）

```css
background: var(--bg-2, #22252c);   /* --bg-2 在 theme.css 里根本没有 */
```

永远走兜底值 `#22252c`。**浅色主题下变成深底深字，几乎看不见。**

这种 bug 最危险：**兜底值让错误看起来像正常工作。**

修：改用真实 token，并**移除所有 `var(--x, fallback)` 的兜底值**——
兜底会把"token 不存在"这个错误静默掉。

### bug 2：元信息对比度不达标

`--text-4` 是最弱层级（禁用/占位用），我却用它承载"Bash · 风险 高 · 2 分钟前"这种**要读**的信息。

实测：深色 2.89:1、浅色 2.57:1，**都低于 AA 4.5:1**。

修：改 `--text-3` → 深色 6.07、浅色 4.85。

### bug 3：fixture 自相矛盾

零待办场景里，`attention` 报 0 条，但 `live` 还说着"待审批 1"。
页面于是显示"数据不一致"。

**页面是对的，fixture 错了。** 但这暴露了一个真实风险：两条数据路径
（一条读 `pendingItems`，一条读计数）确实可能不一致。

修：加**一致性守卫**——当 attention 说 0 但 live 说 >0 时，
明确显示"待办数据不一致，请到办公室查看收件箱"，**而不是撒谎说"运行正常"**。

## 6. 验收结果（19 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | 待办区在**首屏可见** | `top=115`（不是只在 DOM 里靠前） |
| 2 | 显示标题 + 计数 | `⚠ 需要你处理` + `2` |
| 3 | **高风险排第一** | `["high","low"]` |
| 4 | 每张卡可操作 | `[["拒绝","允许"],["回答"]]` |
| 5 | 时间线存在 | ✅ |
| 6 | 只列真实事件 | 3 条（决策/提问/产物） |
| 7 | 显示上次查看时间 | ✅ |
| 8 | 条目带 tone 便于扫读 | `["ok","warn","ok"]` |
| 9 | **点击"允许"真的送回 Harness** | `{action:'answer',id:'p1',value:'granted'}` |
| 10 | 用真实 payload 形状 | ✅ |
| 11 | 深色对比度 ≥ 4.5 | `.att-item-text` **18.17** |
| 12 | 浅色对比度 ≥ 4.5 | **16.43** |
| 13 | 浅色时间线对比度 | **8.06** |
| 14 | 零待办显式提示 | `✓ 团队运行正常` |
| 15 | 零待办视觉可区分 | `att att-clear` |
| 16 | 首次查看无时间线 | ✅（不显示空盒子） |
| 17 | 双主题截图 | 4 张 |
| 18 | `markSeen` 被调用 | 5 次 |
| 19 | 无致命错误 | ✅ |

### 完整对比度实测

| 元素 | 深色 | 浅色 |
|---|---|---|
| `.att-item-text` | 18.17 | 16.43 |
| `.att-item-meta` | 6.07 | 4.85 |
| `.tl-list li` | 11.99 | 8.06 |
| `.att-head` | 9.95 | 5.94 |

全部 ≥ AA 4.5:1。

## 7. 新增的机械门禁

`test/theme-tokens.test.js`（4 项）：

1. 页面引用的每个 token **必须在 theme.css 定义**（防"假 token"）
2. 深/浅两套主题**必须定义同一套 token**（防主题遗漏）
3. 页面内**零硬编码颜色**
4. 待办/时间线的语义 token 两套主题都有

变异验证：引入 `--bg-2` → 2 项红；加硬编码 `#555c66` → 1 项红。

## 8. 顺带修正：IPC 契约扫描盲区

`allRegisteredChannels()` 靠静态扫描 `ipcMain.handle('office:…')`，
但 office 是 `OFFICE_IPC_CHANNELS` 常量 + 分发器注册，**抓不到**。

之前没暴露是因为没有 preload 引用 office 通道。
settings-preload 加 `office:pending` 后立刻误报。

修：扫描器补读那个常量 → 快照 138 → 148（**不是接口变更，是修正盲区**）。

## 9. 复现方式

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-attention-acceptance.js
```
