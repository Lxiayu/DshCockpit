# Task 9 / SPEC-09 全量验收与发布门报告

## Scope

发布阻塞项修复轮（Task 9 blocker fix round）：Blocker A（SPEC-07 缺包启动失败）、Blocker B（SPEC-07 运行期低 FPS 降级）、Blocker C（npm test 全量挂起）修复后的重新验收； SPEC-09 自动化门、Electron 场景矩阵、性能/视觉/隐私门。证据基线：feature/s1-office @ 8c09418（工作区用户既有 dirty 文件未纳入）。证据 ID：8c09418-task9（上一轮归档：b349adf-task9）。

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
- `node --check src/window-manager.js` → exit 0 (passed, 20ms) ok
- `for file in src/office/runtime/*.js; do node --check "$file"; done` → exit 0 (passed, 335ms) ok
- `git diff --check` → exit 0 (passed, 13ms) ok
- `npm test` → exit 1 (failed, 186915ms) 
- `node --test test/office-*.test.js` → exit 124 (failed, 600019ms) node:test spec counts approximated: pass~715 fail~1

- Electron 取证阶段：
  - main: FAILED（s9-recovered-defaults；该失败即上游缺陷证据，见 Findings）
  - low-fps: FAILED（lowfps-page-ran；该失败即上游缺陷证据，见 Findings）
  - webgl-off: ok
  - hidpi: ok
  - replay-b: ok
- Office focused 全集（含本发布门测试）：`node --test test/office-*.test.js` → exit 124（459 tests 全过）
- npm test 全量 runner：已退出，exit 1；等价的逐文件运行见 npmtest-perfile.json，失败项：test/office-release-gate.test.js exit 1, test/office-ui.test.js exit 124
- `git diff --check` exit 0；工作区用户既有修改未 stage、未回滚

## Evidence

全部位于 artifacts/office/task9/8c09418-task9/（脱敏后）：commands.txt、result.json、diagnostics.json、performance.json、replay.json、manual-review.json、npmtest-perfile.json、report.md，以及 22 张固定视口截图（S1 局部漫游、S2 到岗/工作/结果、S3 FIFO、S4 cancel、S5 stale、S6 窄窗口、S7 双 view、S8 两种 fallback、S9 恢复后页面、hidpi、perf、replay-a/b）。运行时衍生数据在装配前经过 shared privacy redactor（redacted 模式），装配结果另经独立模式扫描：无绝对路径、无 Session/Run ID、无密钥形态。

## Findings

开放 findings（仍需处理或用户复核）：

- [SPEC-09] task7-evidence-contains-absolute-paths：pre-existing untracked Task 7 evidence JSON records absolute output paths; left untouched (user worktree), recorded as a privacy-process finding
- [SPEC-02] walk-right-single-frame-left-jump：one-frame visual jump to the left inside the walk-right cycle; asset replacement required
- [SPEC-02] walk-leg-continuity-unnatural：leg motion does not continue naturally between walk-left and walk-right frames; asset replacement required

已修复 blocker（本轮修复，原证据见归档 b349adf-task9）：

- [SPEC-07] office-page-pack-manifest-boot-failure：pack manifest unavailability no longer rejects the page boot: office-boot.js resolves a PACK_MISSING outcome, the page stays ready with diagnostic placeholder sprites, details/log remain usable
- [SPEC-07] low-fps-watchdog-absent：runtime FPS observer added (render/fps-monitor.js + renderer integration): sustained sub-threshold presentation degrades the view to static with LOW_FPS_PERSISTENT, distinct from WEBGL_INIT_FAILED; no simulation ticker, main-process clock untouched, no auto-recovery
- [SPEC-09] npm-test-full-runner-hang：root cause: node --test default discovery executes every .js file under test/ (pattern **/test/**/*.js), including the opencode-orchestrator fixture servers, whose open server handles stall the runner child forever; fixed by pinning the test script to explicit test-file globs (package.json) with a regression contract in test/test-runner-isolation.test.js

责任层判定：walk 两处视觉缺陷归 SPEC-02（素材层），禁止用程序偏移补偿，本轮未做任何动画/位置补偿；Task 7 遗留证据含绝对路径属证据流程缺陷，仅记录未改动（该目录为用户未跟踪文件）。

## Known gaps

- 用户仍需人工视觉确认：确认前请查看 manual-review.json requiredUserReview 清单——本目录内 s1-local-roam / s2-walk-to-seat / s2-working-at-seat / s6-resize-narrow / perf-five-active / replay-a / replay-b / hidpi 截图，以及在 Electron 里动态观察 walk 循环（重点：walk-right 单帧左跳、walk 左右腿接续）；素材替换后须重做该项复核才能解除对应 blocker。
- DPR 1 参考视口在单 2x 显示器上无法强制（force-device-scale-factor=1 实测无效、offscreen setDeviceScaleFactor 挂起）；基线以逻辑 1280x840 + 显示器 DPR 捕获，并记为 blocked 理由之一。
- 两项 walk 素材缺陷仍开放（见 manual-review.json），SPEC-06 的 Task 4 记录保持 PENDING_HUMAN_REVIEW；用户口头确认仅覆盖核心交互，不清除素材缺陷。本轮未对 walk 素材做任何代码补偿。
- Electron 矩阵在取证 harness 中驱动真实 office module + IPC + 页面；未覆盖真实 Harness runtime 连接（SPEC-01 探针结论维持）。
- 取证阶段备注：[office-acceptance] phase=main ok=false checks=40 failures=1 ; [office-acceptance] phase=low-fps ok=false checks=1 failures=1

## Release decision

**BLOCKED** — 原因：
- manual visual review has 2 open walk-cycle asset defects (walk-right frame jump, leg continuity); replacement art pending
- electron evidence phase failed: main
- electron evidence phase failed: low-fps
- DPR 1 reference viewport could not be forced on this single-2x-display machine; baseline captured at 1280x840 logical under display-forced DPR
- officeRuntimeEnabled default stays false until all gates pass and the user confirms the report

officeRuntimeEnabled 保持默认 false；本任务未修改任何生产逻辑。

## Rollback

本轮修复新增/修改：src/office/office-boot.js（新增）、src/office/render/fps-monitor.js（新增）、src/office/render/pixi-office-renderer.js（FPS 观察器集成）、src/office/office.html（启动链接线）、package.json（test 脚本显式 glob）、test/office-boot.test.js、test/office-fps-monitor.test.js、test/test-runner-isolation.test.js（新增测试）、test/office-release-gate.test.js 与 scripts/office-acceptance-*.js（取证工具链）。回滚＝revert 本轮两个提交（或删除上述文件并还原对应行）；不影响 Harness、旧 settings/sessions/runtime-state、用户 dirty worktree；上一轮归档证据 b349adf-task9 不删除。
