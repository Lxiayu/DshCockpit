# SPEC：虚拟办公室·右侧功能栏改版（2026-09-23，v1）

> 状态：**待实施**。拍板输入（用户 2026-09-23）：① 用量同时显示 token 与金额，"本地模型节省"按云端价折算；
> ② 审批危险分级由实施方根据大厂做法定；③ "点员工看今日工作记录"可做但优先级低；④ 先出本 spec 再动手；
> ⑤ 右栏是用户第一眼看到的东西，质量优先。
> 依据：`2026-09-23-right-panel-user-research.md`（联网调研，59 来源）、
> `2026-09-23-authoring-tools-extraction-plan.md`（创作块抽离，含 B-1 顺序约束）、
> harness 0.1.5 自有权限模型（下 §5 一手证据）。

## 1. 目标 / 非目标

**目标**：右栏从"开发期面板"变为**办公室语义的功能面板**：一眼看清 *今日花了多少*、*谁在干什么*、*谁需要我*，
并且能就地处理审批/提问。信息可读优先，不做花哨统计。

**非目标**：财务级报表、一周日历交互（调研零用户讨论）、部门/排班游戏化、把右栏做成第二个 harness 主界面。

## 2. 现状与删除项

当前右栏：标题 + 在岗/任务/排队 + 同步状态 + 员工列表 + 员工详情（追加/取消/中断）+ 活动日志 + 减少动画
+ **布局编辑入口与内嵌编辑器 UI**。

**删除（正式版）**：
| 删除项 | 前置条件 |
|---|---|
| 「布局编辑」按钮、`#layout-editor` DOM、相关 CSS/JS 接线 | **必须先做 B-1**：把 `parseDraft`/`validateDraftSchema`/`ASSET_BY_ID` 外提为 `src/office/layout-schema.js`（生产启动链 `office-boot.resolveProductionLayoutDraft` 在用，测试钉住） |
| 同步状态长文案 | 降级为圆点 + tooltip（状态本身保留） |
| fallback 诊断说明 | 收进 tooltip；细节仍走 `office:diagnostics` |

**禁止误删**：`resources/office/layout-editor/**`（10MB，名字骗人——它是生产家具素材源，渲染器与测试都在用）。

## 3. 信息架构（六块，自上而下）

| # | 区块 | 关键内容 | 交互 |
|---|---|---|---|
| 1 | **今日用量** | 今日消耗 token（主数字）+ 金额（次数字）；额度/预算进度条；三列拆分：缓存命中省、本地模型省（按云端价折算）、云端实付；单位自动（千/万/百万，hover 显示原值） | 只读；点击展开"计价口径"说明（tooltip/折叠） |
| 2 | **员工状态行** | 每员工一行：头像点 + 名字 + 状态徽标（工作/巡游/闲聊/小憩）+ 当前任务（脱敏标题，最长 18 字截断）+ 当前工具短语（打字/查档案/检索/终端…，路径只显末两级）+ 「需要你」徽标（有 pending 时高亮脉冲） | 点击选中 → §5 展开；「需要你」行点击跳到 §4 |
| 3 | **待你处理** | 卡片列表：类型图标 + 员工 + 一句话摘要（工具名/意图）+ 时间；安全操作**行内** `批准 / 拒绝`；危险操作 → 按钮为「查看并批准」打开模态框（见 §5） | 行内一键；危险→模态；空态"暂无待处理 ✓" |
| 4 | **时间线** | 最近 N（默认 20）条：时间 + 员工 + 事件 + 本轮 token/金额归属；`更多` 展开到 100 条 | 只读；点击某条可选中该员工 |
| 5 | **选中员工详情** | 现有 角色/状态/队列 保留 + **今日工作记录**（任务数/完成/失败/耗时合计/今日用量）+ 操作按钮（追加任务/请求取消/请求中断 保留） | 展开态；Esc/空白处取消选中 |
| 6 | **底部** | 减少动画（保留）+ 主题跟随（沿用）+ 极简同步圆点（正常/迟到/重连中 + tooltip） | 保留 |

排序规则：§3 的卡片按"危险度降序 → 时间升序"；状态行按"需要你 → 工作中 → 其他"分组。

## 4. 数据契约（谁写谁读）

新增两个快照块（经 `privacy-redactor` 白名单；任务正文永不出现）：

```jsonc
// 由 main.js 组装（复用现有 usage/cost/balance 缓存，不新采集），注入 office 模块 state()
"usage": {
  "dayKey": "2026-09-23",
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "total": 0 },
  "money":  { "paid": 0, "currency": "CNY" },
  "savings": { "cacheRead": 0, "localModel": 0, "localModelBasis": "cloud-equivalent" },
  "budget": { "kind": "monthly|daily|none", "limit": 0, "used": 0 },
  "pricingBasis": "api-key|subscription",          // 口径标注（调研要求）
  "staleAt": null                                   // 数据超过 60s 未更新 → 页面显示"数据延迟"
}
"pending": [
  { "id": "evt-…", "kind": "approval|question", "employeeId": "researcher",
    "toolName": "bash", "summary": "在工作区执行命令", "detailRef": "office:pending-detail", 
    "risk": "low|medium|high", "createdAtMs": 0, "eventId": "…", "clientId": "…" }
]
```

**归属**：`usage` = 壳侧唯一权威（`cost.js`/`token-stats.js`/balance）；`pending` = waterfall 事件（`approval/request`、
`user-questions/request`）到达时写入 office 模块、回答后移除；回答**复用既有 `$events/result` 通道**
（办公室与 IM 共用一处实现，避免双份逻辑）。员工行字段来自既有 state；`当前工具` 由 M5 已接的 `tool/call`
（`data.name`）映射为中文短语。

**日期口径（P1 拍板）**：`usage.dayKey` = **UTC+8 计费日**，与 `token-stats` 日桶 / 周报同源；设置页成本中心的"今日"
是另一套累计口径，**两处数字会不同**——P4 里统一（成本中心改读同一分桶，或面板标注"计费日"），本期不追。

**pending 累积时机（P1 拍板）**：模块惰性创建（不为不用办公室的用户跑 16ms 模拟），但 `main.js` 侧维护一份
**轻量、有界、无模拟成本**的 pending 镜像，模块创建时播种；否则"打开办公室才看到之后到达的审批"会漏掉最该看的一条，
"需要你"角标也会缺。

## 5. 审批危险分级（对齐 harness 自有模型，一手证据）

harness 0.1.5 的权限模型（`@deepseek-ai/dsh-permission-presets` README 原文）：**preset = 沙箱模式 × 审批策略**，
内置预设含 `read-only` / `workspace-write` / `danger-full-access`；审批结果取值为 `allowed-once` / `rejected`。

**⚠ 两个轴别混（P4 查证，一手）**：`session/list` 投影出来的 `agentPreset` 是 **agent 组合预设 id**
（`dsh-agent-presets`，真实值如 `standard`），**不是**沙箱权限预设；后者的 `sandboxMode` 是挂载执行器时的
组合属性，**未被投影到会话列表**。因此面板**拿不到**会话当前的真实沙箱模式——唯一真实口径是审批请求的
reason（沙箱放宽原文，P3 已用）。UI 上该行标题为「**Agent 预设**」并显示真实值，另有一行如实说明沙箱模式未投影。
`classifyRisk()` 对 `agentPreset` 不认识的值走保守路径（不得把 `standard` 误映射成沙箱档位）。

据此定级（实施时以 `pending.toolName` + 当前 preset/沙箱为输入，纯函数 `classifyRisk()`）：

| 风险 | 判据 | 呈现 |
|---|---|---|
| **低** | 只读类工具（read/grep/fs-search/web-search/…），或 `ask_user_question` 类提问 | 行内 `批准/拒绝`（提问则行内表单） |
| **中** | 工作区内写入（write/edit 且目标在 workspace 内） | 行内 `批准/拒绝` + 显示目标路径（末两级） |
| **高** | 越界或不可逆，**显式清单**：删除（`rm`/`rmdir`）、权限提升（`sudo`）、**依赖安装或变更**（npm/pip/cargo… install/add）、**变更类 git**（push --force / reset --hard / clean）、**数据库或云 CLI 操作**（psql / kubectl / aws / gcloud…）、**密钥与配置文件读写**（`.env`/credentials/settings 类）、写工作区外；`danger-full-access` 下的任意执行；任何沙箱**放宽**请求 | **模态框**：列出将要执行的步骤、影响范围、目标路径/命令原文、**可否撤销（undo 路径）**；按钮 `拒绝 / 仅本次批准`（不提供"总是允许"） |

跨工具对照（codex/zcode/claude-code/warp/devin…31 处可核查来源）见 `2026-09-23-approval-ux-cross-tool.md`：分档口径与上表同构，
**高危清单按该备忘录补了「依赖安装/变更类 git/数据库与云 CLI/密钥与配置读写」四项**（Warp 默认 denylist、Devin Smart 黑名单、Anthropic 事故日志三家独立点名）；
低/中两行不变（与 Claude Code Tier1 只读零打扰 / Tier2 项目内写同构）。两条实施备注：

1. **模态的"命令原文/目标路径"不能依赖 approval 事件**——harness 的审批请求载荷不含工具参数，须走 §4 的 `detailRef` 取上下文；**P3 的阻塞式依赖**。
2. 低风险卡片实际主要是 `ask_user_question`（审批天然集中在中高危），`classifyRisk()` 的测试样本应向中/高倾斜。
3. 交互对齐业界共识：**审批期间阻塞输入框、权限请求不设超时**（普通提问才有超时）；"列出步骤与影响"要假设用户不细读（Anthropic 官方 93% 直接批准），故高危模态必须带撤销说明。

## 6. i18n 键（中英同表，新增）

`office.usage.today / .spent / .saved / .cache / .local / .cloud / .budget / .stale / .basis.apiKey / .basis.subscription`、
`office.pending.title / .empty / .approve / .reject / .review / .modal.steps / .modal.impact / .modal.approveOnce`、
`office.staff.currentTool.*`（**实施为 9 键**：打字/查档案/检索/终端/浏览/编辑/命令/提问/其他）、`office.timeline.more`、`office.sync.ok|late|reconnecting`。
既有键（`office.*`、`减少动画` 等）不动。

## 7. 测试计划

- **契约测试**（模块层，无需 Electron）：`usage` 块字段完整性与脱敏（无任务正文）；`pending` 增删/排序/去重（同一 eventId 幂等）；
  `classifyRisk()` 表格驱动（低/中/高各 ≥3 例，含 `danger-full-access` 兜底）；`$events/result` 回答后 pending 移除。
- **静态断言**：`office.html` 不再含 `layout-editor`（删除后加 grep 断言，防回归）。
- **探针截图**（复用 `/tmp/office-e2e` 探针框架）：① 用量块（有数据/空数据两态）② 员工行「需要你」高亮
  ③ 危险操作模态 ④ 时间线。产出到 `/tmp/office-e2e/panel-*.png` 供用户目检。
- **回归**：`node --test "test/*.test.js"` 全绿（当前 1342）。

## 8. 分期（P1→P5）

| 期 | 交付 | 验收 |
|---|---|---|
| **P1 数据管道** | `usage` 注入 + `pending` 列表 + `classifyRisk()` + 工具短语映射 + 契约测试 | 全量套件全绿；快照字段有测试钉住；**不动 UI 结构**（低风险） |
| **P2 结构改版** | 顶部用量块 + 员工状态行强化（任务/工具/需要你）+ 时间线（token 归属） | 探针截图（用量/员工行/时间线）+ 用户目检 |
| **P3 收件箱** | 待你处理卡片：行内批/拒 + 危险模态 + 与 IM 一致性 | 真触发一次审批（安全策略调 "ask" 跑 bash）+ 截图 |
| **P4 员工记录 + 打磨** | 选中员工今日工作记录 + 密度/折叠/动效/深浅打磨。**P2 目检记下的打磨项**：①「待你处理」计数为 0 时红色徽标改中性/隐藏（红色只留给 >0）；② 员工行下方「方向键移动焦点…」键盘提示过于说教，收进 tooltip 或降为极弱提示；③ 顶部「在岗 N 人 · 执行任务 N · 排队 N」与员工行信息重叠，评估是否并入用量块或压缩；④ 模态里「将要执行」是 harness 英文 reason 原文，加「harness 原文」小标注以免与中文 UI 混淆；⑤ 模态的「权限预设」行目前只从 `session/list` 种子读，新会话显示"未知"——评估预设实时刷新（每 N 秒重列 session）；⑥ **已知非本任务缺陷**：`test/office-ui.test.js` 的 `E5a-R1 real shell`（行走脚线像素测量）间歇失败，已在未修改的 HEAD 上复现，需单独立项排查 | 用户目检 |
| **P5 删创作块** | 按抽离方案 B-1 → A 档顺序（先外提 `layout-schema.js`，再摘 UI，再排包） | `npm test` 全绿 + `npm run build` + 真包冒烟（包内无编辑器） |

## 9. 风险与回退

| 风险 | 缓解 |
|---|---|
| 用量数据口径与 harness 账户不一致（订阅 vs API Key） | 显示 `pricingBasis` 标签 + tooltip 说明；数值来源单一（壳侧缓存） |
| pending 列表与 IM 回答竞争（双写） | 回答统一走一处（`respondToRuntime`）；pending 以 eventId 幂等 |
| 危险模态误拦（把低风险判成高） | `classifyRisk()` 表格驱动测试 + 支持"仅本次批准"；不做"总是允许"以免掩盖越界 |
| B-1 之外先摘编辑器 → 生产启动 404 | 分期硬约束：P5 严格按 B-1 → UI → 排包 |

## 10. 附录：待补

- `2026-09-23-approval-ux-cross-tool.md`（codex / zcode / agent 类产品的审批交互对照）——落地 §5 时同步附上；不阻塞 P1/P2。
