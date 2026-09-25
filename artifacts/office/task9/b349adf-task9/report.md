# Task 9 / SPEC-09 全量验收与发布门报告

## Scope

Office 运行时全量验收（SPEC-00 至 SPEC-08 完成门复核 + SPEC-09 自动化门、Electron 场景矩阵、性能/视觉/隐私门），证据基线：feature/s1-office @ b349adf（工作区含用户既有 dirty 文件，未纳入本任务）。证据 ID：b349adf-task9。

## Environment

- OS：darwin arm64（darwin/25.5.0，基线要求 macOS 14+）
- Node：24.16.0；Electron：37（v37 实测 37.10.3）；Pixi：8.5.2
- 参考视口 1280x840（逻辑）；DPR 为显示器强制的 2——force-device-scale-factor=1 在本机实测无效、offscreen setDeviceScaleFactor 挂起，DPR 1 参考未达成（见 Known gaps）；另测窄窗口 720x620 与高 DPR 锚点捕获
- 逻辑时钟：office module 固定 16ms tick；场景取证全部以显式 tick 驱动，捕获确定性可重放

## Contracts

- office-state.v1（schemaVersion 1、flags 默认 false、settings clamp、备份恢复）
- office:* IPC channels（state/dispatch/cancel/interrupt/settings/diagnostics/visibility）
- canonical envelope（Adapter 派生 eventId/sessionEpoch、sync healthy/stale/resyncing、capability 矩阵）
- Feature flags：officeRuntimeEnabled=false、officePlaygroundEnabled=false（本任务未改动，验收期间保持默认）

## Tests

- `node --check src/main.js` → exit 0 (passed, 21ms) ok
- `node --check src/window-manager.js` → exit 0 (passed, 21ms) ok
- `for file in src/office/runtime/*.js; do node --check "$file"; done` → exit 0 (passed, 265ms) ok
- `git diff --check` → exit 0 (passed, 11ms) ok
- `npm test` → exit 124 (timed-out-no-progress, 600072ms) 
- `node --test test/office-*.test.js` → exit 0 (passed, 390ms) node:test spec counts approximated: pass~459 fail~0

- Electron 取证阶段：
  - main: FAILED（s8-pack-manifest-boot；该失败即上游缺陷证据，见 Findings）
  - webgl-off: ok
  - hidpi: ok
  - replay-b: ok
- Office focused 全集（含本发布门测试）：`node --test test/office-*.test.js` → exit 0（459 tests 全过）
- npm test 全量 runner：无进展终止（运行 600s，kill 原因 output-stall，配置上限 900s、无输出增长阈值 300s；最后可见测试行：✔ collectEvents unwraps the OpenCode global event payload envelope (1.385542ms)）；等价的逐文件运行见 npmtest-perfile.json，失败项：none — every repo test file passes when run individually
- `git diff --check` exit 0；工作区用户既有修改未 stage、未回滚

## Evidence

全部位于 artifacts/office/task9/b349adf-task9/（脱敏后）：commands.txt、result.json、diagnostics.json、performance.json、replay.json、manual-review.json、npmtest-perfile.json、report.md，以及 21 张固定视口截图（S1 局部漫游、S2 到岗/工作/结果、S3 FIFO、S4 cancel、S5 stale、S6 窄窗口、S7 双 view、S8 两种 fallback、S9 恢复后页面、hidpi、perf、replay-a/b）。运行时衍生数据在装配前经过 shared privacy redactor（redacted 模式），装配结果另经独立模式扫描：无绝对路径、无 Session/Run ID、无密钥形态。

## Findings

- [SPEC-07] office-page-pack-manifest-boot-failure：office page boot rejects when the pack manifest is unavailable: __office.ready never becomes true, details/log are not usable, static/diagnostic fallback is not reached
- [SPEC-07] low-fps-watchdog-absent：renderer has no runtime FPS watchdog; static/diagnostic fallback exists only for init failure, so a runtime FPS drop cannot self-degrade
- [SPEC-09] npm-test-full-runner-hang：npm test (node --test full run) does not finish in this environment; per-file runs of the same files pass
- [SPEC-09] task7-evidence-contains-absolute-paths：pre-existing untracked Task 7 evidence JSON records absolute output paths; left untouched (user worktree), recorded as a privacy-process finding
- [SPEC-02] walk-right-single-frame-left-jump：one-frame visual jump to the left inside the walk-right cycle; asset replacement required
- [SPEC-02] walk-leg-continuity-unnatural：leg motion does not continue naturally between walk-left and walk-right frames; asset replacement required

责任层判定：低 FPS 看门狗缺失归 SPEC-07（渲染器生命周期）；walk 两处视觉缺陷归 SPEC-02（素材层），禁止用程序偏移补偿；npm test 全量挂起为仓库既有现象（非 Office 引入），按 SPEC-09 记录并保守阻断；Task 7 遗留证据含绝对路径属证据流程缺陷，仅记录未改动（该目录为用户未跟踪文件）。

## Known gaps

- 用户仍需人工视觉确认：确认前请查看 manual-review.json requiredUserReview 清单——本目录内 s1-local-roam / s2-walk-to-seat / s2-working-at-seat / s6-resize-narrow / perf-five-active / replay-a / replay-b / hidpi 截图，以及在 Electron 里动态观察 walk 循环（重点：walk-right 单帧左跳、walk 左右腿接续）；素材替换后须重做该项复核才能解除对应 blocker。
- DPR 1 参考视口在单 2x 显示器上无法强制（force-device-scale-factor=1 实测无效、offscreen setDeviceScaleFactor 挂起）；基线以逻辑 1280x840 + 显示器 DPR 捕获，并记为 blocked 理由之一。
- 两项 walk 素材缺陷仍开放（见 manual-review.json），SPEC-06 的 Task 4 记录保持 PENDING_HUMAN_REVIEW；用户口头确认仅覆盖核心交互，不清除素材缺陷。
- WebGL 失败与低 FPS 已分开分类；低 FPS 只有测量与分类记录，没有生产看门狗（见 Findings）。
- npm test 全量挂起未在本任务内修复（不属于本任务授权范围）。
- Electron 矩阵在取证 harness 中驱动真实 office module + IPC + 页面；未覆盖真实 Harness runtime 连接（SPEC-01 探针结论维持）。
- 取证阶段备注：[office-acceptance] phase=main ok=false checks=37 failures=1

## Release decision

**BLOCKED** — 原因：
- gate failed: npm test (timed-out-no-progress)
- manual visual review has 2 open walk-cycle asset defects (walk-right frame jump, leg continuity); replacement art pending
- electron evidence phase failed: main
- DPR 1 reference viewport could not be forced on this single-2x-display machine; baseline captured at 1280x840 logical under display-forced DPR
- officeRuntimeEnabled default stays false until all gates pass and the user confirms the report

officeRuntimeEnabled 保持默认 false；本任务未修改任何生产逻辑。

## Rollback

本任务仅新增：test/office-release-gate.test.js、scripts/office-acceptance-run.js、scripts/office-acceptance-evidence.js、artifacts/office/task9/b349adf-task9/、docs/notes 追加章节。回滚＝revert 本次提交（或删除上述新增文件）；不影响 Harness、旧 settings/sessions/runtime-state、用户 dirty worktree。
