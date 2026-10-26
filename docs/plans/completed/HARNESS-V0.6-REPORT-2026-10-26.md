# Harness v0.6 报告 —— 续跑闭环 / 过程可见性 / 启动与运行时瘦身

日期：2026-10-26 · 分支：develop · 提交：f661843 / b114fec / 520b6a9 / bec0b43 / 21f7db3
计划：`docs/plans/completed/HARNESS-V0.6-PLAN-2026-10-25.md` · 契约增量：`docs/architecture/WORKER-EXECUTION-CONTRACT-v0.md` §17

## 1. 交付概览

| WP | 提交 | 一句话 | 变异 |
|----|------|--------|------|
| WP1 | f661843 | resume 执行侧闭环：bind 重试 + 流耗尽→crashed→重挂 follow | M-V1…M-V8 全 DETECTED |
| WP2 | b114fec | execution/progress：工具调用 → 闭集 phase → 座位短语 + 卡片状态 | M-V9…M-V12 全 DETECTED |
| WP3 | 520b6a9 | 首帧解耦：主窗口先行，延迟服务由 runtime 健康触发 | M-W1…M-W3 全 DETECTED |
| WP4 | bec0b43 | 快照版本化推送：静止场景跳过构建+IPC | M-W4、M-W5' DETECTED；M-W5/M-W6 掩蔽（记录） |
| WP5 | 21f7db3 | demo 归档 + 16MB 零引用 legacy 删除 | 结构钉 + 归档断言 |

全量测试：**1802 pass / 0 fail**（归档的 38 个 demo 期测试不再运行）。

## 2. WP1 —— 两个真实链路的洞已闭合

**洞 A（bind 重试）**：attention 来自 bind 阶段 `EXEC_TRANSPORT_UNAVAILABLE` 时 `sessions` 无条目，
旧 `controller.resume()` 第一行就 `EXEC_HANDLE_UNKNOWN` —— "继续"按钮是死路。现在 resume 对无会话
的 attention：Team startRun（attention→running，Team 权威）→ 重试执行器绑定；重试再失败 → 诚实回
attention（reason `session-unavailable`）。

**洞 B（流耗尽）**：journal 流耗尽而无终态时旧实现静默停 running。现在后端合成恰一条
`execution/crashed(stream-ended)`（幂等）→ controller 的 crash→attention 默认策略接手。

**重挂 follow 的正确性**：follow 无 resume cursor（重开即从头重放）——后端以 journal 自身单调 seq
去重吸收重放，只交付新事件。observe 迭代器不再在自然耗尽上闩死（resume 后可续交付——初版实现
实测踩过：pumpOne 永远拿不到事件）。会话其实已跑完时，重挂回放映射出 turn/end → 正常 completed +
artifact 按时序落地；重挂后发现还是死的 → 再合成 crashed（诚实可观测）。

**壳层**：驱动循环在 attention 退场后可由 `resumeTeam()` 重启（race-safe：循环运行中收到重启请求
排队到 finally 再启）；IPC resume 单一走 `instance.resumeTeam()`。

## 3. WP2 —— 过程可见性

链路：journal `tool/call` →（壳注入 `phaseForTool`，内核零 office 依赖）→ `execution/progress{phase}`
（闭集 9 键，连续相同去重）→ controller → Team `run/progress`（只存最新）→ adapter `run-progress`
→ office 座位 `toolPhraseKey/toolPhrase` → 团队卡状态行附短语（复用 `office.staff.currentTool.*`）。

隐私边界行为级钉住：工具名/参数/查询词不出现在事件、Team 事实、office 快照里；`phase` 闭集校验
在 schema/后端(buildEvent)/adapter/office 四处 fail-closed；闭集与 office 词表的漂移钉
（PROGRESS_PHASES === PHRASE_KEYS）。

## 4. WP3 —— 首帧解耦

启动顺序：splash → **立即 createWindow('about:blank')** → 办公室视图上屏 → `await
ensureRuntimeWithGuide()`（安装检查，可能引导退出）→ spawnRuntime → runtime 健康时
onRuntimeHealthy 给 harness 视图换真 URL + 开 cockpit + **启动延迟服务**。

- 延迟服务门从「harness 视图 non-empty paint」改为「runtime 健康」（它们的真实前置）；
- 原 paint 15s 兜底的"服务保活"职责迁到壳侧 45s 定时器；
- M15 退出钳制保留在"早开窗失败"的罕见路径；
- `DSH_DESKTOP_OPEN_OFFICE=0`（工作台优先）回退开关语义不变。

## 5. WP4 —— 快照版本化推送（含渲染侧审计结论）

审计（2026-10-26 对生产包 deepseek-default 逐项核对）：
- 静止位姿动画**全部单帧**（idle/idle-blink/idle-lunch/finished/error/offline）；
- 多帧只有 walk（15 帧；行走时位置每 tick 变化天然驱动推送）与 working-back（3 帧，秒级翻转）；
- 位置是归一化坐标、行走 ~0.001/tick —— 签名按 1e-4 量化（任何 ≥0.2px@2000px 的可见位移都翻转）；
- 渲染端不读 simulatedAtMs（时钟冻结风险为零）。

实现：`contentSignature()`（FNV 哈希：动画粒度桶 250ms、paused、globalSync、usage 对象身份、
activityLog/diagnostics 尾、pendingInvalid + pending id 集、每员工 位置/朝向量化/四态枚举/marker/
bubble/result/toolKind/teamPhase/transition/taskSeq/动画桶）。签名未变且未到 1s 心跳 → 跳过全量
构建+脱敏+每视图 IPC。

真实行为：**有人走动时仍每 tick 推**（M2 渲染契约不变；测试改为确定性 debugClockFire 计量）；
全员静止时坍缩到 ≤5 次/秒。注意：办公室大部分时间有漫游者，收益集中在夜间/无会话时段——
这是诚实的实测结论，不是"永远 62→5"。

测试资产钉：静止动画必须保持单帧（素材包若加入多帧静止动画，钉会红——防"跳过"前提被悄悄破坏）。

## 6. WP5 —— 归档与删除（git 兜底）

- 两个 demo fixture + 其测试移到本地保险箱 `archive/team-demos/`（archive/ 按仓库既有约定
  git 忽略；历史版本在过往提交里）；"有/无 Office 事实日志逐字节一致"先移植到真实链路测试再归档。
- main.js 摘除两个 demo 门/挂载/摘除函数/冲突常量；三方互斥收窄为单实例守卫；index.js 表面同步。
- resources/legacy/ 16MB（44 文件，零引用）git rm；不做历史重写。
- **过程事故（如实记录）**：首轮删 demo 函数时用区间切割误吞了夹在中间的整段桥接函数
  （startTeamRealWithTopic/registerShellTeamIpc/attachOfficeTeamReal 等）。用 `git restore
  --source=HEAD -- src/main.js`（单文件、仅丢弃本步我的未提交改动）恢复，改为逐函数精确删除 +
  每步 `node --check` + 关键函数存在性断言。用户预警的清理风险真实发生了一次，git 兜底生效。

## 7. 变异汇总

| 组 | 结果 |
|----|------|
| M-V1 无会话 resume 分支删除 | 2 红 |
| M-V2 executor 失败回滚删除 | 1 红 |
| M-V3 crashed 合成删除 | 7 红 |
| M-V4 journal-seq 去重删除 | 5 红 |
| M-V5 终态守卫删除 | 1 红 |
| M-V6 crashed reason 置空 | 7 红 |
| M-V7 驱动不重启 | 2 红 |
| M-V8 IPC 绕过 resumeTeam | 2 红 |
| M-V9 原始工具名当 phase | 4 红（schema 闭集拦截） |
| M-V10 连续 phase 去重删除 | 1 红 |
| M-V11 office 闭集校验删除 | 1 红 |
| M-V12 adapter token 校验删除 | 1 红 |
| M-W1 窗口退回 await 之后 | 1 红 |
| M-W2 paint 重新启动服务 | 1 红 |
| M-W3 45s 兜底删除 | 1 红 |
| M-W4 签名掺原始时间 | 3 红 |
| M-W5 teamPhase 移出签名 | **未红（掩蔽）**：每次摄取都进 diagnostics 环，而诊断尾在签名里 —— 冗余捕捉者替管道挡住了变异 |
| M-W5' 位置移出签名 | 1 红（行走不再推送 → M2 契约破坏）|
| M-W6 动画粒度移出签名 | **未红（掩蔽）**：静止窗内调度器/诊断的有机变化仍在推；粒度桶是纯兜底 |

教训：M-W5/M-W6 的"掩蔽"说明签名有多层冗余捕捉者——安全性上是好事，但把这两条当作"已检出"
是不诚实的；如实记录，并保留粒度+心跳作为未纳入字段的兜底。

## 8. 遗留（阶段 2 起）

1. **bind-attention 的取消入口**：卡片只有"继续"；单实例守卫下取消需要宿主级 detach（加按钮时一起做）。
2. **blocked-turn 的 steer 续跑**：dsh 要求人工应答的 blocked 场景，resume 目前只是重挂流；
   "再发一条 steer"属阶段 2（执行侧语义扩展）。
3. **crash 受信来源细化**：进程级 crash 信号仍只走 runtime-health；`finishCrashed` 无 UI。
4. **durable store / 重启存活**（阶段 5）。
5. 真机脚本 5 条（契约 §17.5）待用户执行。
