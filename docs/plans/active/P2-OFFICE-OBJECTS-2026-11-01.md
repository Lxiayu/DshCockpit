# P2.3 办公室交互物件（第一批 2 个）—— 第一性原理分解

> 状态：执行中（2026-11-01）
> 上游：`docs/product/product-roadmap.md` §P2
> 前置：P1 Mission Core 已完成（`src/mission/**` 9 模块 + 18 action IPC）

## 1. 为什么先做"项目白板"而不是别的

路线图 P2.3 要求做 2 个物件：项目白板 + 收件箱。选择顺序的理由：

| 候选 | 依赖 | 价值 | 结论 |
|---|---|---|---|
| **项目白板** | Mission Core（已完整） | 把 P1 做的「跨会话记忆」变成**可见**的东西 | ✅ **第一个** |
| 收件箱 | 官方 approval 通道（已实证） | 已有 `pending` 数据在快照里，只缺物件 | ✅ 第二个 |
| 其他 4 个物件 | 各自缺数据源 | 未知 | ❌ 非目标 |

**关键判断**：项目白板的价值不在于"多一个装饰物"，而在于它是
**P1 Mission Core 的第一个用户可见出口**。Mission Core 目前只有 Mission Desk
一个窗口，用户在办公室工作时看不到任何 Mission 信息。

## 2. 架构约束（先想清楚再动手）

### 约束 1：依赖方向不可逆

```
office-module.js  ← pure-Node 门禁，禁止 fs/网络
mission/store.js  ← 需要 fs（append-only JSONL）
```

所以 Mission 数据**不能**由 office-module 自己读。必须：

```
main.js（有 fs）
  → 读 mission store
  → 算成"派生视图"（纯数据）
  → 注入进 office-module
```

这与现有 `packManager` / `answerRequest` / `pendingDetail` 是**同一模式**。

### 约束 2：办公室只能读，不能写 Mission

domain-model 铁律：**同一状态不许两个写入者**。
Mission 的写入通道只有 `mission:invoke`。办公室物件：
- 显示 Mission 状态（读派生数据）
- 点击时**发命令**（走 `mission:invoke` 或打开 Mission Desk）
- **绝不**直接改 Mission 状态

### 约束 3：必须如实降级

验收标准第 4 条："任一物件断线时显示 `stale` 而非编造数据"。

这条不是可选的美化——如果 Mission 数据 30 秒没更新，
白板必须说"数据可能过期"，而不是继续显示旧值让人以为是实时的。

### 约束 4：隐私

Mission 的 title/intent 是**用户自己的**，可以进办公室快照。
但以下**不进**：
- 原始 sessionId（只传派生句柄）
- prompt 正文
- 绝对路径

## 3. 数据契约设计

### 3.1 白板读什么

从 Mission projection 派生（**counts + 状态，不含正文**）：

```js
{
  available: true,              // false = 没有 Mission 或读失败
  observedAtMs: 1730...,        // 数据观测时间（用于 staleness 判定）
  missions: [                   // 只含 active 的（最多 3 个，白板放不下更多）
    { missionId, title, status,
      workstreamCount, activeWorkstreamCount,
      decisionCount, openQuestionCount, deliverableCount }
  ],
  totals: { activeMissions, openQuestions, decisions }
}
```

**不含**：intent 全文、决策 rationale、问题正文、deliverable 路径。
理由：白板是**概览**，详情在 Mission Desk。这同时也天然满足隐私约束。

### 3.2 staleness 判定

```js
// main.js 每次推送前打时间戳；office 侧按 age 判定
staleAfterMs = 30_000
stale = (now - observedAtMs) > staleAfterMs
```

为什么是 30 秒：Mission 状态变化是分钟级的事件（用户不会每秒改 Mission）。
30 秒内的数据可以认为是"当前"。超过则明示不确定。

## 4. 实施分解（4 步，每步可独立验证）

| 步 | 内容 | 验证 |
|---|---|---|
| **S1** | `src/office/mission-board.js` —— 纯函数：projection → 白板数据 | 单测（无 IO） |
| **S2** | main.js 读 Mission store 并按节流推送进 office | 单测（store 用临时目录） |
| **S3** | office-module 快照加 `missionBoard` 字段 + 隐私白名单 | 快照契约测试 |
| **S4** | 渲染层物件 + 点击进 Desk | 真机验收（截图） |

**先做 S1+S2+S3（纯逻辑 + 契约），再做 S4（视觉）**。
理由：S1-S3 的错误是"数据不对"，S4 的错误是"看起来不对"。
前者能用断言钉死，后者需要真机截图。分开做能确保"数据对"再谈"好看"。

## 5. 执行结果（2026-11-01）

| 步 | 状态 | 证据 |
|---|---|---|
| S1 派生层 | ✅ 完成 | `src/office/mission-board.js`，26 项测试 |
| S2 主进程读取 | ✅ 完成 | `currentMissionBoard()`（30s TTL 缓存），全量回归通过 |
| S3 快照白名单 | ✅ 完成 | `src/office/office-mission-board.js`，13 项测试 |
| S3 端到端链路 | ✅ 完成 | `test/mission-board-chain.test.js`，8 项（真实 store） |
| S4 渲染层 | ⚠️ **部分完成** | 代码 + 14 项静态测试；**真机验收未完成** |

### S4 的真机验收为什么没做成

探针（`scripts/acceptance/office-mission-board-acceptance.js`）在 office 页的
**启动链**上反复失败，已删除。逐层排查消耗了大量轮次，卡点依次是：

1. `protocol.registerSchemesAsPrivileged` 缺失 → CSP 拒绝 CSS/JS
2. office 页启动需要 `office:state` / `office:visibility` → 缺则 `__office.ready=false`
3. `renderMissionBoard` 依赖 `page.missionBoardView()`，而 page 内部有**自己的
   snapshot 副本**；`page.applySnapshot()` 的回调绑在构造闭包里，
   更新的是**另一个作用域的 `latestSnapshot`**（实测 `snapAvail` 始终 false）

第 3 点是一个真实的架构耦合：`latestSnapshot`（页面作用域）、page 内部
`snapshot`、以及 `__office.api.snapshot()` 读的那个变量，是**三份不同的副本**。
要可靠地做渲染验收，需要先理清这个数据流——那是独立的一块工作，
不该塞在 P2.3 的收尾里做。

### 已经守住的（静态可测）

- `renderMissionBoard` 定义 + **在 onSnapshot 真实数据流路径中被调用**
  （只接 renderAll 会导致白板只在打开页面那一刻刷新）
- 四种状态分支齐全（ok / empty / unavailable / not-wired）
- stale 标记、moreCount 披露
- 点击 → `openMissionDesk`，且有键盘可达性
- `needs-you` 高亮（待答问题是白板的核心信号）
- 9 个 i18n key 双语齐全
- 渲染层不读 intent/rationale/prompt/sessionId（隐私）
- 渲染层不写 Mission 状态（单一作者）

### 未完成的（如实记录）

- 白板在真机上的**视觉呈现**（布局、颜色、是否真的可见）
- 点击打开 Mission Desk 的**实际 IPC 往返**

这两项需要先解决 `latestSnapshot` 三副本问题，属独立任务。
**不宣称 S4 完成**——没有截图证据就没有视觉验收。

## 6. 验收标准（来自路线图 + 本项目追加）

- [ ] 白板显示当前 Mission 的真实状态（workstream / 决策数 / 未答问题）
- [ ] 点击能进入 Mission Desk
- [ ] 数据超过 30 秒未更新时显示 `stale`
- [ ] 没有 Mission 时显示"还没有 Mission"，**不是**空白或假数据
- [ ] Mission 数据不进 office 快照的隐私字段（有测试断言）
- [ ] office-module 仍然不 require fs
- [ ] 快照契约测试覆盖新字段
