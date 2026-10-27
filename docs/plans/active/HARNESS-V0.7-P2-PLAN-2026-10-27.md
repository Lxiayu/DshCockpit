# HARNESS v0.7 P2 —— 让团队真正改代码（实施计划）

状态：**进行中**（用户 2026-10-27 拍板：P2 执行根 = 专用 Team runtime）
上位文档：`docs/product/WORK-FIRST-V0.7.md` §4 / §7 P2
前置：P1 报告 §3.2 / §3.3（真机验收、工作坞、悬停卡）

## 0. 关键决定（已拍板 + 已实测）

dsh 官方语义：**进程启动目录 = workspace 根**（`dsh/README.md:20`），没有按会话切 cwd 的接口。
因此 P2 用一个**专用 dsh runtime** 承载团队执行：

- cwd = 任务工作区；独立端口 / token / cookie / mux / rpc；共享 `DSH_HOME`；
- 与主 harness runtime 完全隔离（主界面会话不受影响）；
- 任务结束空闲 60s 自动停止；随壳退出（watchdog 兜底，防孤儿进程）。

实测（2026-10-27）：两个 runtime 同时存在（主 `/Users/xia`、团队工作区）；
团队任务 completed（research-notes 2700 B + review-findings 100 473 B）；
模型把 `team-status-research-notes.md`（23 KB）写进了工作区；空闲 60s 后团队 runtime 正常退出。

## 1. 目标与非目标

**P2 交付**：团队能在工作区里**留下可审阅的变更与真实验证证据**，并据此迭代一次。

1. 工作区变更捕获（壳侧受信）：added / modified / deleted 文件清单 + digest。
2. Verification Runner：在工作区执行任务声明的验证命令，记录退出码与有界日志。
3. 受控 retry：验证/评审不通过时可再跑一次（attempt ≤ 3），每轮证据保留。
4. 工作台呈现：变更、验证、评审三类证据可读。

**非目标**：任意并行写、跨工作区、自动合并冲突（P3 以后）。

## 2. 事实与所有权

- **Team 事实**仍只由 Team Runtime 写；P2 不新增 Team fact 类型（除非验证证明必要）。
- 变更与验证是**壳侧受信证据**，写入工作区索引（`.dsh/index.json`）与 `.dsh/artifacts/`；
  它们属于 Work Product，不属于 Team 的 execution 事件。
- 隐私：索引只存相对路径 + digest；验证日志留在工作区，不进 Team/Office 快照。

## 3. 工作包

### WP1 专用 Team runtime（✅ 已实现）
`src/team-runtime-host.js`：spawn（cwd=工作区）/URL 解析/健康检查/独立 auth+mux+rpc/
空闲停止/watchdog；`startWorkRun` 注入 `rpc` 与 `openFollow(mux)`；i18n 错误码。
证据：`test/team-runtime-host.test.js`（5，变异 P1–P4 全 DETECTED）+ 真机。

### WP2 工作区变更捕获（`workspace-patch`）
- `workspace-store`：`scanManifest()`（排除 `.dsh/.git/node_modules/dist/out/build`，
  文件上限 5000、单文件哈希上限 2 MB、总耗时预算）；`diffManifests(before, after)`。
- `work-controller.begin` 记录基线（内存；进程重启则无基线，如实标注 `baseline-missing`）；
  任务终态时生成 `workspace-patch` JSON 写入 `.dsh/artifacts/<jobId>/`，
  登记为壳侧产物并挂到工作项。
- 工作台：产物类型 `workspace-patch`（i18n）、查看器直接显示 JSON。
- 验收：改一个文件 → 产物里出现该文件（状态 modified + digest）；未改动 → 空变更不伪造。

### WP3 Verification Runner
- 工作项可带 `verifyCommand`（工作台输入，可空）；终态后在**工作区**执行（超时 5 分钟）。
- 证据：`.dsh/artifacts/<jobId>/verify.log`（有界）+ 索引里的
  `{command, exitCode, durationMs, ok, startedAtMs}`；命令原文只存工作区（不进事实链）。
- 工作台：证据行（通过/失败、耗时、退出码）+ 「打开日志」。
- 验收：`exit 0` → ok；`exit 1` → not ok；超时 → `timeout`；无命令 → 不产生假证据。

### WP4 受控 retry
- 触发条件：验证失败 **或** 评审结论为「需补充」；attempt ≤ 3（工作项记录）。
- 重试 = 同工作区、新 run（consumed artifacts 重新计算），保留每轮变更/验证/评审。
- attention 语义不变：超过上限 → 工作项 attention，等人决定。

### WP5 真机验收
- 首跑：选工作区 → 改代码任务 + 验证命令 → 完成 → 查看 patch/verification/review。
- 失败路径：验证失败 → 一次自动重试 → 仍失败 → attention。

## 4. 变异清单

| # | 变异 | 期望 |
|---|---|---|
| Q1 | 基线在任务开始后才拍 | 变更测试红 |
| Q2 | 排除 `.dsh` 失效 | 变更清单出现自产文件 |
| Q3 | 验证命令不在工作区执行 | 验证测试红 |
| Q4 | 超时不杀进程 | 超时测试红 |
| Q5 | 空变更也写 workspace-patch | 空变更测试红 |
| Q6 | retry 无上限 | 上限测试红 |

## 5. 进度

- [x] WP1 专用 Team runtime（含真机验证）
- [x] WP2 变更捕获（scanManifest/diffManifests + workspace-patch 壳侧产物；空变更不写）
- [x] WP3 Verification Runner（工作区执行、超时/输出上限、verify.log + verification 证据）
- [x] WP4 受控 retry（手动、上限 3、保留每轮证据；验证失败也可触发）
- [ ] WP5 真机验收与报告（WP1–WP3 已真机通过；重试真机路径待跑）
