# HARNESS V0.6 计划 —— 续跑闭环 + 过程可见性 + 启动/运行瘦身

日期：2026-10-25 · 分支：develop（已推送至 88d5bd5） · 状态：待拍板

## 0. 一页结论

| WP | 内容 | 解决什么 | 规模 | 风险 |
|----|------|----------|------|------|
| WP1 | resume 执行侧闭环（bind 重试 + 流耗尽→crashed→重挂 follow） | 真实链路 attention 恢复后**停在 running / resume 直接 EXEC_HANDLE_UNKNOWN** 的两个洞 | 中 | 中 |
| WP2 | `execution/progress` 过程可见性 | researcher 工作中办公室看不到"在干什么" | 中 | 低 |
| WP3 | 首帧解耦：窗口先开、办公室先画，不等 runtime 健康 | 启动第一帧延迟的最大来源 | 中 | 中 |
| WP4 | 快照版本化推送（无变化不推） | 主进程 62 次/秒全量快照构建+脱敏+IPC 的常驻 CPU | 小 | 中（渲染侧审计后定） |
| WP5 | demo 归档 + resources/legacy 删除 | 679 行被取代的 fixture + 16MB 零引用素材 | 小 | 低 |

建议顺序：**WP1 → WP2 → WP3 → WP4 → WP5**（前两个是 harness/team 实质能力；后三个互相独立，可单独砍掉）。

---

## 1. 背景

v0.4/v0.5 已交付并经用户真机验证：办公室团队卡输入主题 → shell transport 建 dsh 会话发模板提示词 → dsh 后端以 `execution/*` 事实驱动 Team → 办公室投影可见，全链路通。

对照 Codex App Server（Item/Turn/Thread 三原语；审批暂停 turn 直到客户端应答）与 Claude Code Agent Teams（共享任务列表、hooks 质量门禁、邮箱消息不可信），我们的方向一致，但有两个被他们证明关键而我们缺失的能力：**恢复的执行侧续跑**（他们：审批应答后 turn 继续；我们：resume 后执行侧无事件流入）和**过程可见性**（他们：Item started/delta/completed 流式；我们：started 与终态之间一片空白）。同时冗余调查确认了启动路径与运行时的三处可瘦身点。

## 2. 现状核实（本计划的全部依据，均已对代码验证）

### 2.1 resume 的两个洞

**洞 A —— bind 阶段 attention 的 resume 走不通。** 真实链路的 attention 唯一来源是 bind 时
`executor.startRun` 抛 `EXEC_TRANSPORT_UNAVAILABLE`（controller `team-execution-controller.js:290-298`，
转成 `noteRunAttention({role, reason:'session-unavailable'})` 后**直接 return，`sessions` 里没有该 role 的条目**）。
用户点"继续" → `main.js:461 controller.resume(role)` → `resume()` 第一行
`sessions.get(role)` 为 undefined → `EXEC_HANDLE_UNKNOWN`。UI 已接线但控制器层面是死路。

**洞 B —— 流耗尽不停在 running。** journal 流结束而未映射出终态时（dsh 中途死掉/重启），
`pullOnce` 对 `next.done` 返回 null（controller:357-358），drive 循环安静结束，run 永远停在 `running`。
根因：dsh 后端**显式声明不产生 `execution/crashed`**（`dsh-execution-backend.js:617-618` 的
`unsupportedEventTypes`），而 controller 的 crash→attention 默认策略（:168-173）从未被触发。

### 2.2 过程可见性现状

journal 的 `tool/call` 在 `pullEvents` 规则 2 里被跳过（`dsh-execution-backend.js:390-392` 注释明说）。
呈现侧词表已是共享模块 `office/runtime/tool-phrases.js`（`toolPhraseKeyOf`/`toolPhraseZhOf`，
office-module.js:77 已 require，快照字段 `toolPhrase`/`toolPhraseKey` 已在 PRESENTATION_ALLOWLIST :3028）——
即：**词表与呈现字段都现成，只缺事实通道**。当初搁置 `execution/progress` 的理由（无消费方）已消失。

### 2.3 启动路径

- `main.js:5917` `await ensureRuntimeWithGuide()`：splash 之后**等 dsh runtime 完整启动**才走到
  `onRuntimeHealthy` → `createWindow(bootUrl)`（window-manager.js:632-640）。办公室是默认视图却陪着等。
- 延迟服务（token 轮询、调度器、余额、compact、channels）由 `showMainWhenReady` 启动，触发条件是
  **harness 视图**的 `did-first-visually-non-empty-paint`（window-manager.js:289-306，含 dom-ready 120ms
  与 15s 兜底）——即使默认视图是办公室，也要等隐藏的 harness 视图 paint。

### 2.4 快照推送

`PUSH_INTERVAL_MS = TICK_MS = 16`（office-module.js:85,94），每 tick 全量 `state()` 构建 + `redactSnapshot`
+ 每视图一次结构化克隆 IPC ≈ 62 次/秒，与画面是否变化无关。推送点 `:4087` 的 due 判定已集中，
`logicalMs`/`lastPushAtMs` 簿记现成。渲染侧 Pixi ticker 停用、按 push 渲染，entity 级有 skip，主进程无快照级 skip。

### 2.5 可归档物

- `team-office-demo.js`（280 行，旧固定脚本）与 `team-executor-demo.js`（399 行，FakeExecutor demo）：
  真实 UI 入口已覆盖用途；引用面 = `src/main.js`（门禁接线）、`src/team/runtime/index.js` 的 `TEAM_MODULES`、
  4 个测试文件（其中 3 个断言模块清单完整性）。
- `resources/legacy/` 16MB：src/、scripts/、package.json、test/ **零引用**（grep 已验证）。
- `fake-executor.js` **保留**（离线契约套件唯一执行器）；office-module 的 legacy harness 摄取路径
  （applyFact 等 ~600 行）**保留**（用户自己在 harness 页跑会话仍走它，是活路径）。

---

## 3. WP1 —— resume 执行侧闭环

### 3.1 设计

**WP1a（bind 重试）**：把 `bindExecution` 中 dispatch 之后的"执行器绑定"段（startRun→assertHandle→observe→
sessions.set→驱动）提炼为可重入的 `bindExecutorFor(role)`。`resume(role)` 分支：
- `sessions` 无条目或 `session.handle == null`（attention 来自 bind 失败）→ 先 `team.startRun({role})`
  （attention→running，Team 权威路径，team-runtime.js:144-146 已支持）→ 调 `bindExecutorFor(role)` 重试；
- 重试再抛 `EXEC_TRANSPORT_UNAVAILABLE` → `noteRunAttention`（状态诚实回到 attention），
  返回 `{ok:false, status:'attention'}`；其他错误走 executor-error ledger；
- 成功 → 正常驱动，恢复事件流。

**WP1b（流耗尽→crashed→重挂）**：
- dsh 后端：journal 迭代器 done 且 `!state.terminal` 时，经 `buildEvent` 产出**一条**合成
  `execution/crashed`（reason 为粗粒度 token，如 `stream-ended`；schema 的 crashed reason 词表若受限则同步扩充）；
  从 `unsupportedEventTypes` 与 `capability()` 中移除 `execution/crashed`。
- 新增 `resume(handle)`（后端层）：仅非终态会话——对同一 sessionId 重新 `transport.follow`
  替换迭代器（dsh 会话自身存活时 journal 会续流；若会话其实已跑完，重挂后回放映射出 turn/end →
  正常 completed，artifact materializer 照常在 completed 前落地）。
- controller 侧无需新逻辑：crashed→attention（:168-173 已有），resume→`executor.resume(handle)`（:427-436 已有）。
- 顺序守卫：合成 crashed 只发一次（幂等），且排在回执队列清空之后，不与真实终态重复（terminal 已设即不发）。

transport v1 契约不变（`follow` 本就幂等可重开；不新增方法）。`main.js:604` 的"不自动 resume"原则保持：
**恢复永远显式**，UI 已接。

### 3.2 测试与变异（V1–V6）

新增/钉住（先写失败测试再改）：
- V0-钉：流耗尽无终态 → 现状 run 停 running（今天的行为写成回归基准，修复后此测试翻转为 attention）。
- V1：bind 失败→attention→resume→transport 第二次成功 → 走到 running 且事件续流（注入可编程 transport）。
- V2：resume 重试仍 transport 失败 → 回 attention（不 failed、不 running）。
- V3：流耗尽 → 恰好一条 `execution/crashed`(stream-ended) → Team attention；resume → re-follow → completed。
- V4：resume 后会话其实已完成 → 回放得到 completed + artifact 正常落地。
- V5：终态后 resume → 拒绝（不产生第二条终态）。
- V6：crashed 缺 reason → schema 拒绝（buildEvent 抛 EXEC_*）。
- 变异法照旧：逐条破坏实现 → 对应测试红 → 还原 → hash 校验。

### 3.3 非目标

`recover()`（attempt+1 重开新执行）仍留端口边界；crash→failed 的宿主裁决（`finish-crashed`）不做 UI；
durable store / app 重启后团队存活（阶段5）。

## 4. WP2 —— `execution/progress` 过程可见性

### 4.1 设计

- **schema**（execution-schema.js）：词表加第 10 个类型 `execution/progress`（非终态）；
  事件字段白名单增加可选 `phase`（闭集 = `toolPhraseKeyOf` 的键族，即 `office.staff.currentTool.*`）。
  执行器仍不得携带 evidence/outcome/artifactId；progress 只多一个 `phase`。
- **dsh 后端**：`pullEvents` 的映射表新增 `tool/call` → `execution/progress`，工具名经共享
  `tool-phrases.js` 的 `toolPhraseKeyOf` 转键；**未映射工具照旧跳过**（不放大词表）；
  **同一 run 连续相同 phase 去重**（无定时器，纯状态去重）。原始工具参数/文件路径**绝不**进事件（隐私边界）。
- **Team Runtime**：新 fact `run/progress`（携带 phase 键，粗粒度）；run 状态只存最新
  `progress = {phase, atMs}`（历史在 append-only fact log 里）。去重后典型每 run 数条，无音量风险。
- **controller**：`ingestExecutionEvent` 加 progress 分支 → `team.noteRunProgress`（纯转发，不评估）。
- **bridge/office**：`ingestTeamProjectionFact` 扩展映射 `run/progress` → 座位 `toolPhraseKey`
  （呈现字段与 i18n 键复用 legacy 路径现成物）；团队卡状态行显示当前 phase。
  office-module.js 当前 4530 行，冻结天花板 4800，预计 +30~60 行；**requires 清单不动**
  （tool-phrases.js 本来就在 :77）。office-runtime-boundary 测试的天花断言无需改。
- **renderer/i18n**：键复用 `office.staff.currentTool.*` 族，新增 team 卡片相关少量键。

### 4.2 测试与变异（V7–V10）

- V7：tool/call → progress 事件 phase 为闭集键；未映射工具不产事件、不终止流。
- V8：连续相同 tool 去重（fact 音量断言：N 次相同调用 ≤ 1 条 progress fact）。
- V9（隐私门）：progress 事件 payload 出现原始工具名/参数 → 契约测试红（白名单校验）。
- V10：office 渲染只接受闭集键（快照里出现非闭集 phase → 投影拒绝/fail-closed）。

## 5. WP3 —— 首帧解耦

### 5.1 设计

- **窗口先行**：主窗口在 app ready 后立即创建并以办公室视图 paint（办公室模块不依赖 dsh runtime）；
  `ensureRuntimeWithGuide()` 改为后台启动，不阻塞窗口。runtime 健康后走 `onRuntimeHealthy` 的
  "窗口已存在"分支（loadURL harness 视图 + cockpit，window-manager.js:632-640 结构已半就绪）。
- **harness 视图自身仍等 runtime**（它要加载 runtime URL，天然有序，不动）。
- **延迟服务改门**：`startDeferredServices` 的消费者绝大多数谈 dsh HTTP API → 触发条件从
  "harness 视图 non-empty paint" 改为 "runtime 健康"（与窗口/视图解耦）。逐项审计清单内服务，
  确有依赖窗口 webContents 的（若有）单列，仍挂窗口事件。
- **失败路径核对**（本 WP 的第一张任务）：`ensureRuntimeWithGuide` 的 guide/重试/退出流程在
  "窗口已开"下的表现——guide 可退出 app（窗口存在不妨碍 quit）；runtime 永久失败时办公室照常可画、
  harness 视图进入既有 unavailable 呈现（核对现有态，缺则补）。
- **M15 语义复核**：`setMainWindowPending(true)` 的 window-all-closed 钳制在早开窗口后仍成立
  （窗口先开反而消除"runtime boot 期间无窗口"窗口期）。
- splash（`createLoadingWindow`）职责收缩为仅覆盖 runtime 引导对话场景，或直接砍掉（窗口即反馈）——
  实现时按 guide 流程依赖定，倾向保留但立即被主窗口 paint 顶替关闭。

### 5.2 测试与变异（W1–W3）

- W1：runtime 未健康时 `createWindow` 已被调用（boot 顺序断言，抽 main.js 启动函数入沙箱测，沿用
  office-team-real-wiring 的提取手法）。
- W2：延迟服务由 runtime-healthy 事件触发，而非 harness paint（注入两事件验证顺序无关性）。
- W3：runtime 永久失败 → 窗口仍在、office 可用、harness 视图 unavailable 呈现（不白屏不假数据）。

## 6. WP4 —— 快照版本化推送

### 6.1 设计

- office-module 增加单调 `snapshotVersion`，一切状态变更（fact 摄取、tick 位移、状态翻转）+1；
  推送条件改为 `version !== lastPushedVersion || logicalMs - lastPushAtMs >= HEARTBEAT_MS`。
- 行走时主进程每 tick 推进位置 → version 每 tick 变 → 运动期间自然恢复 60fps 推送；
  静止时跳过构建+脱敏+IPC，仅心跳（建议 1000ms，供在线判定与时钟校正）。
- **第一张任务是渲染侧审计**：盘点快照中"每 tick 必变"的字段（已知嫌疑 `animationElapsedMs`，:2918）。
  若它驱动连续动画 → 方案 c：version 计数排除该字段，动画起止翻转 version 一次，渲染侧本地时钟推进
  （快照改携带动画起始时间戳或渲染侧用 performance.now 差值）；若审计发现方案 c 改动面大 →
  退方案 b：心跳压到 30–50ms（62/s → ~25/s，仍有 2 倍收益）。**审计结论先行，拍板方案后再动渲染层。**

### 6.2 测试与变异（W4–W6）

- W4：静置 N tick 无变更 → 恰好 0 次推送（心跳除外）；发生一次位移 → 恢复每 tick 推送。
- W5：version 计数漏掉某类变更（变异：去掉 fact 摄入的 bump）→ 投影刷新断言红。
- W6：心跳期间渲染侧不依赖新推送也能维持（现有暂停/隐藏路径回归不破）。

## 7. WP5 —— demo 归档 + legacy 删除（纯减法）

- `team-office-demo.js` + `team-executor-demo.js` → `archive/team-demos/`（沿用 s1 收编的 archive 模式）。
- **先搬覆盖再删**：`office-team-executor-demo.test.js` 独有的"有/无 Office 事实日志一致"等 E2E 断言，
  先移植成 controller+fake-executor 层的等价测试（进 `test/team-execution-scenarios.test.js`），
  移植后原 demo 测试随文件归档（不再参与测试运行）。
- 同步：`TEAM_MODULES`（index.js）与 3 处模块清单断言、main.js 两个 demo 门禁接线与环境变量文档、
  `fake-executor.js` 内涉及 demo 的注释（如有）。`fake-executor.js` 本体保留。
- `resources/legacy/` 16MB：删除前最后一次全仓 grep（排除 node_modules/photo/artifacts）确认真零引用，
  然后 `git rm -r`。**不做历史重写**（收益是停止跟踪与包体，不是重写历史；破坏性 git 操作本就禁用）。
- `office-persistence` 死写容量：本轮**不动**（读侧对旧文件的容忍还有用，删除收益太小）。
- 验证 = 全量测试绿 + 零引用 grep 留档。

## 8. 顺序、验收与安全

**顺序**：WP1 → WP2（同链路，schema 相邻）→ WP3 → WP4（独立 UX）→ WP5（最后，保持归档前全量回归可用）。
每个 WP 独立成 commit，可单独回退。

**总验收**：
1. 全量测试绿（基线 = 当前 1651 通过）；
2. 变异 V1–V10、W1–W6 全部"破坏→红→还原→hash 校验"留痕；
3. 真机脚本（交用户执行）：
   - a) 团队卡发任务 → researcher 座位实时显示工具短语（WP2）；
   - b) dsh 运行中途杀掉 → 办公室出现 attention → 重启 dsh → 点继续 → 任务走到 completed（WP1b）；
   - c) dsh 停着发任务 → attention → 起 dsh → 点继续 → completed（WP1a）；
   - d) 冷启动直达办公室可交互，harness 视图随后自动就绪（WP3）；
   - e) 静置观察主进程 CPU 占用下降（WP4，活动监视器粗验）。

**Git 安全（沿用既定纪律）**：严禁 `reset --hard`/`clean -fd`/`checkout -- .`/`add -A`；
逐 WP 提交；**推送 develop 需本轮另行授权**；不覆盖他人改动。

**交付物**：代码与测试 + 本计划文档 + `docs/research/HARNESS-V0.6-REPORT-2026-10-25.md`（含变异留痕与真机脚本结果）。

## 9. 风险表

| 风险 | 缓解 |
|------|------|
| WP1b 重挂 follow 与 dsh 会话生命周期不匹配（会话真死时 follow 失败） | resume 失败 → 回 attention（诚实），不假装成功；真机脚本 b/c 双向验证 |
| WP2 fact 音量失控 | 后端连续去重 + 每 run 条数断言（V8） |
| WP3 启动顺序牵动 M15/退出语义 | W1–W3 + 既有 M15 回归；WP3 独立 commit 可单独回退 |
| WP4 渲染侧依赖未审计字段导致动画冻结 | 审计先行、方案 c/b 分级、W6 回归 |
| WP5 删测试丢覆盖 | 移植先行、归档不删除文件 |
