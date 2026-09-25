# Virtual Office Character Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不侵入 DeepSeek Harness、保持现有 DshCockpit 回归安全的前提下，交付一个可验证的 PixiJS 2D Character Runtime，并逐步接入四名常驻员工和一个协作者的 Virtual Office。

**Architecture:** 采用“PixiJS 渲染器 + 纯逻辑 Character Runtime + DshCockpit Office State Adapter + HTML 控制层”的分层结构。Runtime 事实、绑定、状态机、行为、移动和动画互相解耦；Office State Adapter 将 Harness 的 `type/seq/time/data` 转换为带适配层代际和去重信息的 canonical envelope。先完成依赖/兼容性探针和 Animation Playground，再进入多 Agent Office MVP。

**Tech Stack:** Electron 37、CommonJS 主进程模块、PixiJS 8.x（依赖探针通过后固定精确版本）、本地 PNG/Texture Atlas、Node 内置 `node:test`、Playwright/Electron 截图验收；不使用 CDN、物理引擎或 A*。

## Repository isolation and migration contract

Office-only implementation files must live under `src/office/`, Office tests under `test/office/`, runtime props under `resources/office/`, character packs under `resources/characters/<pack-id>/`, and tooling under `scripts/office-assets/` or `scripts/office-probes/`. `photo/` remains source/reference material only; `docs/legacy/` remains archive only. Production code and packaging must not scan either directory.

The shared integration surface is intentionally small: `src/main.js`, `src/window-manager.js`, settings proxy files, `src/i18n.js`, `package.json/package-lock.json`, and packaging config. These files may contain registration, IPC/bounds, flags, copy, and asset inclusion only. Runtime state, Pixi scene logic, behavior, and adapters must be exposed through a stable Office façade such as `src/office/office-module.js`. Every task report must classify `Office-only files` versus `Shared integration files` and give a cherry-pick order for a future main-repository migration.

---

## Scope and gates

本计划只覆盖已确认的第一阶段：扁平 2D 正交办公室、四名常驻员工 + 一个动态协作者、DeepSeek 娘角色包、Waypoint Graph、本地漫游/聊天/休息/睡眠、真实 Runtime 任务绑定、详情面板和降级诊断。

明确不做：真实 3D/透视镜头、物理碰撞、A*、家具素材生成、固定 provider 到业务角色的硬权限、当前 Harness 未证明的 pause/resume UI、修改 Harness 源码、修改 `sessions/` 或既有 `settings.json`/`runtime-state.json` 格式。

阶段门：

1. Harness 兼容性和 PixiJS 加载探针通过，才能冻结接线方式。
2. Asset normalization 和 fixture 通过，才能进入 Playground。
3. Playground Stage 1–5 通过，才能进入 Character Runtime 多 Agent。
4. Character Runtime 多 Agent、队列、事件顺序和降级测试通过，才能嵌入 Office MVP。
5. Office MVP 通过 Electron、回归、性能和视觉验收后，才打开默认功能开关。

每个任务独立提交；任何门失败时只回滚该任务提交，并保留诊断产物。开始每个任务前必须运行 `git status --short` 和 `git diff --name-only`，记录任务开始时已有的 dirty 文件；不得 reset、checkout 或回滚这些既有用户改动。提交前必须用 `git diff --cached --name-only` 确认只包含本任务文件。实现过程中遵循 `@superpowers:test-driven-development` 和 `@superpowers:verification-before-completion`。

## SPEC 阅读映射

本计划只拆分任务，不重复定义字段契约。执行任何 Task 前必须依次阅读 `docs/superpowers/specs/2026-08-30-office-agent-handoff.md`、`office-development-spec-index.md`、产品总纲/研究报告、本文档，再阅读对应 SPEC：Task 0 -> SPEC-00；Task 1 -> SPEC-01；Task 2 -> SPEC-02；Task 3 -> SPEC-03；Task 4 -> SPEC-06；Task 5 -> SPEC-04；Task 6 -> SPEC-05；Task 7 -> SPEC-07；Task 8 -> SPEC-08；Task 9 -> SPEC-09。若任务步骤与 SPEC 不一致，以用户确认的 SPEC 契约为准，先记录冲突再实现。

## File map

### New files

- `scripts/office-pixi-smoke.js`：PixiJS/Electron 本地加载和最小渲染探针。
- `scripts/office-harness-probe.js`：目标 Harness 版本的脱敏事件/取消/子代理兼容探针。
- `scripts/office-assets/normalize-character.py`：使用 Pillow 做透明边界、统一画布和脚底 anchor 预处理。
- `scripts/office-assets/build-atlas.js`：可选的 v1 atlas 构建器（仅在单帧 PNG Playground 通过后启用）。
- `src/office/runtime/character-pack-installer.js`：本地文件夹/ZIP 的 discovered -> validated -> installed -> active 生命周期和安全限制。
- `scripts/office-assets/validate-character-pack.js`：manifest、geometry、动画帧和资源安全校验。
- `src/office/runtime/asset-pack.js`：角色包加载、能力解析和降级链。
- `src/office/runtime/animation-controller.js`：独立帧时钟、方向和状态动画选择。
- `src/office/runtime/movement-controller.js`：归一化坐标、Waypoint Graph 路径、速度和 reservation。
- `src/office/runtime/behavior-scheduler.js`：漫游、聊天、休息和睡眠的本地行为调度。
- `src/office/runtime/transition-controller.js`：stop/turn、到达、坐下/站起、离开、结果展示和中断清理。
- `src/office/runtime/state-reducer.js`：四层状态、控制/绑定/队列 reducer 和不变量。
- `src/office/runtime/runtime-adapter.js`：Harness 事件 canonical envelope、去重、乱序缓冲和 resync。
- `src/office/runtime/runtime-snapshot.js`：Office snapshot/resync schema、Harness `follow/page/control` 组合和 epoch/sequence 合并。
- `src/office/runtime/office-persistence.js`：`office-state.v1` 原子持久化和迁移。
- `src/office/runtime/privacy-redactor.js`：详情、日志、持久化和探针共用的隐私脱敏策略。
- `src/office/office-module.js`：Office 对主进程和窗口管理器的唯一薄接线 façade；不承载业务状态。
- `src/office/runtime/employee-profile.js`：四名常驻员工、协作者、角色包引用和 Runtime binding schema。
- `src/office/runtime/office-layout.js`、`src/office/fixtures/office-layout.json`：2x3 右下偏移工位、通道、footprint 和 back/main/front 图层 fixture。
- `src/office/render/pixi-office-renderer.js`：Pixi stage、sprite、排序、命中区域和降级渲染。
- `src/office/office-module.js`：对主进程/窗口管理器暴露的唯一薄接线 façade，不承载业务状态。
- `src/office/office-page.js`、`src/office/office-preload.js`、`src/office/office.html`、`src/office/office.css`：正式办公室页面和 IPC bridge。
- `src/office/playground-page.js`、`src/office/playground.html`、`src/office/playground.css`：孤立的 Animation Playground。
- `src/office/fixtures/character-pack/`、`src/office/fixtures/waypoints.json`、`src/office/fixtures/events.json`：可重复测试夹具。
- `test/office-*.test.js`：每个纯逻辑模块的单元/契约测试。
- `docs/notes/office-pixi-spike-2026-08.md`：依赖和 Electron 接线探针结果。

### Existing files allowed to change

- `package.json`、`package-lock.json`：只追加并精确锁定 PixiJS（必要时的最小构建辅助依赖）。
- `src/main.js`：只增加办公室窗口/IPC/feature flag 接线；每次修改先 `node --check src/main.js`。
- `src/window-manager.js`：只增加 office WebContentsView 生命周期和 bounds 同步。
- `src/settings-store.js`、`src/settings.html`、`src/settings-preload.js`、`src/i18n.js`：只追加办公室设置、双语文案和 IPC。
- `src/harness-rpc.js`：只增加已由兼容探针证明的 Session/Agent 控制调用。
- `resources/characters/`：只接入经过校准的 manifest/metadata，不覆盖用户未确认的原始图片。

内置回退包固定为 `resources/characters/deepseek-default/`，随 Core 版本发布并带可校验版本号；`whale-girl` 是可独立启用的角色包。共享包损坏时按包级别禁用并记录 `PACK_*` 错误码，optional 状态缺失只记录 `ANIMATION_CAPABILITY_MISSING`。

办公室设置的唯一持久化来源是新文件 `userData/office-state.v1.json`。`settings-store.js` 不增加办公室字段，只负责读取/写入一个受 feature flag 保护的办公室设置 IPC 代理；既有 `settings.json` schema 和读写路径保持不变。

Feature flags 固定为：`officeRuntimeEnabled`（默认 `false`，生产开关）和 `officePlaygroundEnabled`（默认 `false`，开发/测试开关）。两者保存在 `office-state.v1.json`，Playground 可独立于正式办公室启用；未通过阶段门时不得把任一默认值改为 `true`。

> **修订（2026-09-17，用户拍板 M4 直启动）**：`officeRuntimeEnabled` 默认值改为 `true`（左栏入口一键进入办公室；`DSH_DESKTOP_OFFICE_RUNTIME=0` 可强制关闭）。本修订由用户决策直接授权；SPEC-09 证据刷新（含新定稿素材）在整合进主项目（M6）前完成。`officePlaygroundEnabled` 保持 `false`。

## Task 0: Specification and worktree freeze

**Files:**
- Modify: `docs/specs/OFFICE-DESIGN-DISCUSSION.md`, `总纲.md`（若存在）
- Test: `test/office-doc-contract.test.js`

- [ ] **Step 1: Mark superseded text and freeze current vocabulary.**

  Move or mark old undecided paragraphs as `superseded`; keep only the current flat orthographic projection, `movement=moving`, four residents + one collaborator, local sleep, adapter-derived `eventId/sessionEpoch`, and current control matrix as implementation input. Mark GitHub character-pack import as post-MVP if it appears in the master outline.

- [ ] **Step 2: Add a documentation contract test.**

  Assert that the active docs contain the canonical state dimensions, snapshot schema, storage ownership, feature flags and explicit unsupported pause/resume wording, and that no active section claims Harness natively provides `eventId` or `sessionEpoch`.

- [ ] **Step 3: Run and commit the documentation gate.**

  Run: `node --test test/office-doc-contract.test.js`; then stage only the docs/test files after checking the cached file list and commit `docs(office): freeze implementation vocabulary`.

## Task 1: Harness and Pixi compatibility gates

**Files:**
- Create: `scripts/office-harness-probe.js`, `scripts/office-pixi-smoke.js`, `docs/notes/office-pixi-spike-2026-08.md`
- Create: `src/office/runtime/privacy-redactor.js`
- Modify: `package.json`, `package-lock.json`
- Test: `test/office-compatibility.test.js`, `test/office-privacy-redactor.test.js`

- [ ] **Step 1: Write failing compatibility assertions.**

  Assert that the probe can normalize a `SessionEvent` with `type/seq/time/data`, observe `agent/status`, record `turn/end` cancellation reasons, pair `subagent/start/end`, report unsupported `pause/resume/preempt`, and expose the `session.follow/page/control` stream capabilities needed by the Office adapter. Assert that the Pixi smoke fixture creates one application and one sprite without a network URL. Assert that the shared redactor removes prompt text, tool arguments/results, Session IDs, paths, token counts and secrets before diagnostics or hashing while preserving coarse event/status fields.

- [ ] **Step 2: Run the focused test and confirm it fails.**

  Run: `node --test test/office-compatibility.test.js test/office-privacy-redactor.test.js`

  Expected: FAIL because the probe scripts, shared redactor and pinned PixiJS dependency do not yet exist.

- [ ] **Step 3: Add the dependency and probes.**

  Run: `npm install --save-exact pixi.js@8.5.2` and record the resolved version in `docs/notes/office-pixi-spike-2026-08.md`. The smoke script is an Electron entrypoint, not a plain Node WebGL program: launch it with `npx electron scripts/office-pixi-smoke.js` (or the repository's Electron binary), create/destroy one BrowserWindow and one Pixi application, report renderer type, decoded texture bytes and Electron version, and exit non-zero on blank/failed initialization. The Harness probe must be read-only or use a disposable test Session, redact task content, and record actual version differences against `docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md`. Implement the redactor as pure CommonJS before any adapter hash; its API must be deterministic and reusable by SPEC-05 and SPEC-08.

- [ ] **Step 4: Run the focused test and real probes.**

  Run: `node --test test/office-compatibility.test.js test/office-privacy-redactor.test.js`; then run the smoke script in Electron with `npx electron scripts/office-pixi-smoke.js --headless` where supported, or with a visible window on macOS, and the target-runtime probe with `node scripts/office-harness-probe.js --redact`.

  Expected: focused tests PASS; smoke reports local Pixi load, one renderable sprite and clean destroy; Harness probe reports actual event/control support or a documented mismatch. If direct local ESM loading fails, stop and amend this plan with the selected minimal local bundling path before continuing.

- [ ] **Step 5: Commit the gate.**

  Run: `git add package.json package-lock.json scripts/office-* src/office/runtime/privacy-redactor.js test/office-compatibility.test.js test/office-privacy-redactor.test.js docs/notes/office-pixi-spike-2026-08.md && git commit -m "chore(office): verify pixi and harness boundaries"`

## Task 2: Character asset normalization and pack contract

**Files:**
- Create: `scripts/office-assets/normalize-character.py`, `scripts/office-assets/validate-character-pack.js`, `src/office/fixtures/character-pack/manifest.json`, `src/office/fixtures/character-pack/animation/anchors.json`, `src/office/fixtures/character-pack/animation/animations.json`, `resources/characters/deepseek-default/manifest.json` and its pinned minimal fallback assets
- Modify: `resources/characters/whale-girl/` only after asset approval; otherwise read it as an external source fixture
- Test: `test/office-asset-pack.test.js`, `test/office-character-pack-installer.test.js`

- [ ] **Step 1: Write failing geometry and fallback tests.**

  Cover shared canvas, alpha thresholds, `±1px` foot-anchor tolerance, no trim/rotate atlas flags, missing optional state fallback, unsafe path rejection, license metadata, and decoded-size limits. Installer tests must explicitly reject absolute paths, `..` traversal, symlink/hardlink entries, manifest-external files, executable extensions, file-count limits, per-file limits, total extraction limits and ZIP bombs, while proving failed updates retain the previous active version.

- [ ] **Step 2: Run the focused test.**

  Run: `node --test test/office-asset-pack.test.js test/office-character-pack-installer.test.js`

  Expected: FAIL because the normalizer, validator and fixture metadata are absent.

- [ ] **Step 3: Implement deterministic normalization.**

  Use the already available Python image tooling (`Pillow 11.3.0` on the development machine) for alpha analysis, resampling and PNG encoding; keep the Node validator declarative and dependency-free. Normalize source PNGs to one canvas, detect transparent bounds and foot candidates, apply manifest override when required, emit `validation-report.json`, and reject packs that cannot satisfy the `±1px` rule without cropping. Keep assets declarative; never execute pack JavaScript.

  v1 runtime loads normalized individual PNG frames; it does not require an atlas. Add `scripts/office-assets/build-atlas.js` only after the individual-frame Playground passes. If an atlas is built, it must preserve the normalized canvas per frame and reject trim/rotate flags; atlas support is an optimization, not a prerequisite for Office MVP.

  Character pack installation is limited to built-in resources and local folder/local ZIP import in v1. The installer must extract to a temporary directory, reject path traversal, symlinks, ZIP bombs, oversized files and executable content, validate before atomic rename into the user character directory, and keep the previous version on failed update/removal. GitHub import remains post-MVP.

- [ ] **Step 4: Run normalization and tests.**

  Run: `python3 scripts/office-assets/normalize-character.py resources/characters/whale-girl --out src/office/fixtures/character-pack`; then `node scripts/office-assets/validate-character-pack.js src/office/fixtures/character-pack`; then `node --test test/office-asset-pack.test.js test/office-character-pack-installer.test.js`.

  Expected: validation report is `passed` for the approved fixture or explicitly records the exact frame requiring rework; tests PASS only when the report is valid. The report must include `sourceCanvas`, `outputCanvas`, `outputScale`, source/output anchors, immutable frame results, and reject conflicting inline geometry metadata. The runtime fallback order is: disable invalid pack -> pinned built-in `deepseek-default` -> diagnostic placeholder with stable error code.

- [ ] **Step 5: Commit the asset contract.**

  Run: `git add scripts/office-assets src/office/runtime/character-pack-installer.js src/office/fixtures/character-pack resources/characters/deepseek-default test/office-asset-pack.test.js test/office-character-pack-installer.test.js docs/superpowers/specs/2026-08-30-character-asset-spec.md && git diff --cached --name-only && git commit -m "feat(office): add validated character pack contract"`

## Task 3: Pure Character Runtime foundation

**Files:**
- Create: `src/office/runtime/asset-pack.js`, `src/office/runtime/animation-controller.js`, `src/office/runtime/movement-controller.js`, `src/office/runtime/transition-controller.js`, `src/office/runtime/state-reducer.js`
- Test: `test/office-animation-controller.test.js`, `test/office-movement-controller.test.js`, `test/office-transition-controller.test.js`, `test/office-state-reducer.test.js`, `test/office-asset-runtime.test.js`

- [ ] **Step 1: Write failing unit tests.**

  Test independent animation time, direction mapping, fallback reasons, deterministic BFS route behavior (directed/bidirectional edges, behavior tags, capacity/safe-radius, `UNREACHABLE`, no teleport), normalized movement on horizontal/vertical/diagonal segments, resize preservation, reservation half-life renewal and crossing-segment conflict, four-layer state priority, cancellation binding retention, unsupported control capability gating, and Transition Controller stop/turn, arrive/sit, result/stand/leave and stale path/chat cleanup. Assert `visibleHeight = clamp(64px, sceneHeight * 0.11, 180px)` at minimum, normal and maximum scene heights, and assert all animation states for one employee share the same computed visible height.

- [ ] **Step 2: Run focused tests and confirm failure.**

  Run: `node --test test/office-animation-controller.test.js test/office-movement-controller.test.js test/office-transition-controller.test.js test/office-state-reducer.test.js test/office-asset-runtime.test.js`

  Expected: FAIL because the runtime modules do not exist.

- [ ] **Step 3: Implement the minimum pure APIs.**

  Implement `createAnimationController`, `createMovementController`, `createTransitionController`, `resolveAnimation`, and `reduceOfficeState` with no DOM, Pixi, Electron, filesystem writes, or Harness imports. Use `sceneMinDimensionPerSecond`, independent frame clocks, explicit graph edges, stable y-sort keys, and the event/control authority rules from the state-machine spec. Use the minimum scene dimension for circular `safeRadius`/chat geometry and explicit width/height ratios for rectangular footprints.

  The renderer-facing size contract is `visibleHeight = clamp(64px, sceneHeight * 0.11, 180px)` based on manifest `visibleBounds`; every state and walk frame for one employee shares this visible height and source anchor.

- [ ] **Step 4: Run focused tests and inspect boundary cases.**

  Run the same `node --test` command plus `node --check` on each new CommonJS module.

  Expected: all focused tests PASS; no test relies on wall-clock timing or random values.

- [ ] **Step 5: Commit the pure foundation.**

  Run: `git add src/office/runtime test/office-*-controller.test.js test/office-state-reducer.test.js test/office-asset-runtime.test.js && git diff --cached --name-only && git commit -m "feat(office): add pure character runtime foundation"`

## Task 4: Animation Playground gate

**Files:**
- Create: `src/office/playground-page.js`, `src/office/playground.html`, `src/office/playground.css`, `src/office/fixtures/waypoints.json`, `src/office/fixtures/events.json`
- Modify: `src/main.js` only to add a development-only Playground window command behind `officePlaygroundEnabled=false`
- Test: `test/office-playground.test.js`

- [ ] **Step 1: Write failing deterministic fixture tests.**

  Cover click-to-nearest-waypoint projection, fake ticker frame boundaries (`±16ms`), one-second movement distance (`±5%`), foot baseline drift (`≤1 CSS px`), state transitions, reduced-motion, resize error (`≤0.005` logical units), arrival error (`≤0.01`), and incomplete-pack fallback.

- [ ] **Step 2: Run focused tests and confirm failure.**

  Run: `node --test test/office-playground.test.js`

  Expected: FAIL because the Playground page and fixture runner are absent.

- [ ] **Step 3: Implement the isolated Pixi scene.**

  Create one application, pure background, one selected character, debug overlays for anchor/bounds/route/frame/fallback, controls for state/direction/speed/frame duration/loop/pause/reduced-motion, and deterministic fake-clock replay. Do not connect Harness or persist office state.

- [ ] **Step 4: Run tests and visual evidence capture.**

  Run: `node --test test/office-playground.test.js`; launch the Playground in Electron; capture initial, moving, arriving, result, resize, reduced-motion and missing-texture screenshots with the reference viewport recorded.

  Expected: objective checks PASS and visual review separately records Contact/Passing readability and transition naturalness. Any defect is assigned to asset, animation, movement or transition layer.

- [ ] **Step 5: Commit only after the Playground gate passes.**

  Use Playwright against the Electron window at a fixed reference viewport `1280x840`, device scale factor `1`, system font defaults recorded in the evidence JSON, and save screenshots under `artifacts/office-playground/<commit>/`. Run `git add src/office/playground-* src/office/fixtures test/office-playground.test.js src/main.js && git diff --cached --name-only && git commit -m "feat(office): add animation playground gate"`.

## Task 5: Local behavior, chat, queue and resident employees

**Files:**
- Create: `src/office/runtime/behavior-scheduler.js`, `src/office/runtime/employee-registry.js`, `src/office/runtime/employee-profile.js`, `src/office/runtime/queue-controller.js`
- Modify: `src/office/runtime/state-reducer.js`
- Test: `test/office-behavior-scheduler.test.js`, `test/office-employee-registry.test.js`, `test/office-employee-profile.test.js`, `test/office-queue-controller.test.js`

- [ ] **Step 1: Write failing behavior tests.**

  Cover exact stable profiles (`orchestrator`, `researcher`, `coder`, `reviewer`) with display name, role, seat, character pack variant and allowed overrides; one collaborator profile; root Session default binding to `orchestrator`; child `runId`/Session registration; `bindingSource`, confidence, `boundAt`, `releasedAt`; manual-binding precedence; immediate local roaming without Harness traffic, deterministic seeds, one chat pair and atomic reservations, five-minute configurable sleep, task interruption, FIFO queueing, urgent result preemption, and no `offline` resident status. Assert local chatting exposes only a non-text icon/ellipsis plus accessibility label and never emits Runtime transcript or simulated message text.

- [ ] **Step 2: Run focused tests and confirm failure.**

  Run: `node --test test/office-behavior-scheduler.test.js test/office-employee-registry.test.js test/office-employee-profile.test.js test/office-queue-controller.test.js`

  Expected: FAIL because these modules do not exist.

- [ ] **Step 3: Implement local behavior and queue reducers.**

  Implement roaming/resting/chatting/sleeping as local-only activities; task/runtime facts can only enter through the adapter. Enforce the four exact profiles, root/child binding rules, single collaborator FIFO ownership, global Session ID uniqueness, reservation expiry and release on interruption/terminal confirmation. The queue controller exposes waiting-count and ordered summaries for the details UI.

  Local chatting may render only a non-text ellipsis/chat icon resource and an accessibility label; it must never write simulated dialogue into the Runtime transcript or activity log as if an LLM message occurred.

- [ ] **Step 4: Run tests and commit.**

  Run the focused command and `for file in src/office/runtime/*.js; do node --check "$file"; done`.

  Expected: all tests PASS and no module imports Electron or calls an LLM.

  Commit: `git add src/office/runtime test/office-behavior-scheduler.test.js test/office-employee-registry.test.js test/office-employee-profile.test.js test/office-queue-controller.test.js && git diff --cached --name-only && git commit -m "feat(office): add resident behavior and task queue"`

## Task 6: Harness Office State Adapter

**Files:**
- Create: `src/office/runtime/runtime-adapter.js`, `src/office/runtime/runtime-snapshot.js`, `test/office-runtime-adapter.test.js`, `test/office-runtime-snapshot.test.js`
- Modify: `src/harness-rpc.js`, `src/main.js` only for additive `session.follow/page/control` subscription, Office snapshot request/response IPC, and compatibility-proven cancel/interrupt/followup/steer/inject calls

- [ ] **Step 1: Write failing adapter and resync tests.**

  Replay `turn/start`, `tool/call`, `tool/result`, `turn/end`, `agent/status`, `subagent/start/end`, duplicate events, forward gaps, stale epochs, reconnects, cancel timeouts and malformed snapshots. Also assert that `sync=stale|resyncing` preserves the last trusted task presentation, does not end local chat/rest, and does not make an unfinished binding sleep. Define and test the DshCockpit-only messages:

  ```json
  { "type": "office:runtime-resync-request", "requestId": "...", "sessionId": "...", "sessionEpoch": "...", "fromSequence": 12 }
  ```

  ```json
  { "type": "office:runtime-snapshot", "requestId": "...", "sessionId": "...", "sessionEpoch": "...", "sequence": 15, "facts": {}, "eventsSince": [] }
  ```

  Assert request/session/epoch matching, strictly increasing `eventsSince` sequences greater than the snapshot sequence, newer-epoch precedence, buffer limits (64 events/2 seconds), exponential retry (250ms/500ms/1s, capped at 5s), and a 4096-entry/10-minute event-ID LRU. Assert no duplicate movement/activity log and no guessed terminal state.

- [ ] **Step 2: Run focused tests and confirm failure.**

  Run: `node --test test/office-runtime-adapter.test.js test/office-runtime-snapshot.test.js`

  Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement canonicalization, snapshot merge and capability gating.**

  Prefer Harness `seq`; derive adapter `eventId/sessionEpoch` with source markers. When upstream sequence is absent, compute SHA-256 over `sessionEpoch + sessionId + seq-or-empty + eventType + canonicalJson(payload)` before assigning the adapter ingress counter. Every adapter instance exposes a versioned capability set `{ adapterVersion, runtimeVersion, supports: { cancel, interrupt, followup, steer, inject, pause, resume }, terminalEvidence }`; UI controls require a positive capability and evidence event. Buffer at most 64 events or 2 seconds; request only DshCockpit `office:*` resync. Implement snapshot acceptance only when request/session/epoch match; establish the snapshot sequence as the new contiguous watermark, discard older buffered events, and replay only same-epoch buffered events with strictly greater sequence in order. On invalid/timeout response, discard the buffer after retry policy and mark `sync=stale`; never guess intermediate state. Map `turn/end` by its `TurnEndReason` (`completed`, `error`, `blocked`, `aborted`, `interrupted`, etc.); `subagent/end` maps by its `stopReason`, not by event type alone. Expose cancel/interrupt/followup/steer/inject only where the compatibility probe proves them. Do not expose pause/resume or native preempt.

- [ ] **Step 4: Run replay tests and syntax checks.**

  Run: `node --test test/office-runtime-adapter.test.js test/office-runtime-snapshot.test.js`; then `node --check src/main.js` and `node --check src/harness-rpc.js`.

  Expected: replay tests PASS; syntax checks exit 0; adapter diagnostics identify every dropped, stale or unsupported event.

- [ ] **Step 5: Commit the adapter boundary.**

  Run: `git add src/office/runtime/runtime-adapter.js src/office/runtime/runtime-snapshot.js src/harness-rpc.js src/main.js test/office-runtime-adapter.test.js test/office-runtime-snapshot.test.js docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md && git diff --cached --name-only && git commit -m "feat(office): adapt harness events to office runtime"`

## Task 7: Pixi Office Scene and HTML details UI

**Files:**
- Create: `src/office/render/pixi-office-renderer.js`, `src/office/office-module.js`, `src/office/office-page.js`, `src/office/office-preload.js`, `src/office/office.html`, `src/office/office.css`, `src/office/runtime/office-layout.js`, `src/office/fixtures/office-layout.json`, `test/office-renderer.test.js`, `test/office-ui.test.js`
- Modify: `src/window-manager.js`, `src/main.js`, `src/i18n.js`

- [ ] **Step 1: Write failing renderer and interaction tests.**

  Assert one persistent Pixi node per employee, no node recreation on status/selection refresh, stable y-sort tie-break, anchor-preserving resize, the 2x3 desk layout shifted slightly right/down with left-top furniture reserve, channel width and footprint spacing, explicit back/main/front furniture metadata, keyboard/pointer selection, queue-count badge, ordered waiting-task list, collaborator current-task/count display, activity-log events, details hierarchy (large name, role marker, prominent task/result), and reduced-motion behavior.

- [ ] **Step 2: Run focused tests and confirm failure.**

  Run: `node --test test/office-renderer.test.js test/office-ui.test.js`

  Expected: FAIL because the new office page and renderer are absent.

- [ ] **Step 3: Implement the scene and shell wiring.**

  Use one Pixi application per Office WebContentsView; keep HTML details/controls outside the canvas; load only local validated packs through `PIXI.Assets`, with a view-owned asset registry unloaded on view destruction; enforce local-only `file:`/`app:` CSP and reject pack JavaScript. When furniture art is unavailable, draw deterministic flat desk/chair/occluder placeholders from `office-layout.json` using Pixi Graphics; this is the geometry fixture, not final art. Render background, six-desk fixture, ground entities, explicit occluders and labels; apply `visibleHeight = clamp(64px, sceneHeight * 0.11, 180px)` to all character states. Route all task truth through the adapter and all local behavior through the scheduler. `pixi-office-renderer.js` owns initialization failure handling: WebGL/Pixi failure switches to a static diagnostic canvas or DOM placeholder while keeping details/log IPC alive, and emits a stable diagnostic code. The simulation clock pauses when the WebContentsView is hidden/backgrounded and resumes from the current logical position without replay. Add only new `office:*` IPC channels and keep existing channels unchanged.

- [ ] **Step 4: Run tests, Electron smoke and visual checks.**

  Run focused tests, `node --check src/main.js`, `node --check src/window-manager.js`, then launch Electron and capture default, selected, running, completed, stale-sync, missing-pack and reduced-motion states. Verify two Office views consume one main-process snapshot/simulation clock and that closing one view unloads only its Pixi resources.

  Expected: focused tests PASS, no blank canvas, no duplicate ticker, no destroyed/recreated character nodes during refresh, and details remain readable without animation.

- [ ] **Step 5: Commit the Office scene.**

  Run: `git add src/office src/window-manager.js src/main.js src/i18n.js test/office-renderer.test.js test/office-ui.test.js && git diff --cached --name-only && git commit -m "feat(office): embed pixi virtual office scene"`

## Task 8: Persistence, settings, diagnostics and fallback

**Files:**
- Create: `src/office/runtime/office-persistence.js`, `test/office-persistence.test.js`, `test/office-privacy.test.js`
- Modify: `src/settings-store.js`, `src/settings.html`, `src/settings-preload.js`, `src/i18n.js`, `src/main.js`

- [ ] **Step 1: Write failing persistence and settings tests.**

  Cover defaults (`sleepAfterMs=300000`, `resultPresentationMs=5000`), clamps (`sleepAfterMs` 60s-24h, `resultPresentationMs` 1s-30s), user frame-duration override, speed, reduced-motion, bounded history (50 tasks per employee, 200 activity entries), Employee Profiles/current character selection, complete recoverable binding snapshots, old epoch binding rejection, exclusion of path/frame/chat/reservation/in-flight state, atomic write recovery, feature flags, bilingual keys, privacy redaction, and static/diagnostic fallback when Pixi/WebGL/pack loading fails. A setting change applies at the next behavior/transition decision point; it never rewrites an active path or truncates an in-progress result presentation. The canonical precedence is: user `userFrameDurationOverrideMs` (when non-null) > per-frame duration > animation `frameDurationMs`; `sceneMinDimensionPerSecond` is the only movement setting name. Stale/resyncing sync must preserve the last trusted task presentation and must not force local chat/rest to end or make a bound task sleep.

- [ ] **Step 2: Run focused tests and confirm failure.**

  Run: `node --test test/office-persistence.test.js test/office-privacy.test.js`

  Expected: FAIL because the persistence, privacy and settings additions are absent.

- [ ] **Step 3: Implement additive settings and office-state.v1.**

  Keep the main process as the single writer, write a new `userData/office-state.v1.json` atomically, never touch sessions, `settings.json` or existing runtime state formats. `settings-store.js` remains unchanged for persistence; its additive office IPC proxy reads/writes the office store. Define `privacyMode` (`full`/`redacted`, default `redacted`) and apply one redaction function to task titles, tool arguments/results, error text, activity log, probe output and details UI: keep employee role, status, event type and bounded result code; replace task text, arguments, raw output, Session IDs and token/context counts with placeholders or coarse buckets. Make all new controls default-safe/disabled until the gates pass.

- [ ] **Step 4: Run focused tests and i18n/UI checks.**

  Run focused tests, `node --check src/main.js`, and `npm test -- --test-name-pattern='settings|i18n|office'`.

  Expected: all focused tests PASS, both language dictionaries have identical office keys, and malformed/old state falls back without blocking startup.

- [ ] **Step 5: Commit persistence and diagnostics.**

  Run: `git add src/office/runtime/office-persistence.js src/office/runtime/privacy-redactor.js src/settings-store.js src/settings.html src/settings-preload.js src/i18n.js src/main.js test/office-persistence.test.js test/office-privacy.test.js && git diff --cached --name-only && git commit -m "feat(office): add settings persistence and diagnostics"`

## Task 9: Full regression, performance and release gate

**Files:**
- Modify: `docs/notes/office-pixi-spike-2026-08.md` and the relevant specs with measured results only
- Test: all `test/office-*.test.js` plus existing `test/`

- [ ] **Step 1: Run the complete automated suite.**

  Run: `npm test`; then `node --check src/main.js`, `node --check src/window-manager.js`, and `for file in src/office/runtime/*.js; do node --check "$file"; done`; finally run `node --test test/office-*.test.js` and `git diff --check`.

  Expected: zero test failures and zero syntax errors. A failure in unrelated legacy tests is recorded and blocks enabling the feature.

- [ ] **Step 2: Run Electron acceptance scenarios.**

  Verify office opens with no Harness conversation, four residents roam locally, a real task routes one employee to a desk, completion returns to local behavior, collaborator FIFO is atomic, cancel retains binding until terminal evidence, stale sync does not create offline state, resize preserves anchors, simultaneous Office views consume one main-process snapshot and simulation clock, and closing/reopening does not duplicate clocks.

- [ ] **Step 3: Measure performance and visual baselines.**

  With five active characters, record rendered FPS (target `>=30`) on the supported baseline `macOS 14+`, Electron 37, reference viewport `1280x840`, device scale factor `1`, and the actual GPU/WebGL renderer reported by the smoke probe. Run one WebGL case and one forced-canvas/static-fallback case; classify WebGL initialization failure separately from an FPS failure. Record decoded texture bytes, load time, screenshot viewport/DPI/font, and an explicit pixel-diff threshold (initially 5% changed pixels for layout, with animation frame differences excluded by deterministic fake-clock captures). Store only redacted diagnostics and fixture configuration.

- [ ] **Step 4: Apply the release decision.**

  Keep `officeRuntimeEnabled=false` if any gate is incomplete. Enable it only after the user confirms the measured report. Do not merge or push automatically.

  Commit evidence only: `git add docs/notes/office-pixi-spike-2026-08.md docs/specs/OFFICE-DESIGN-DISCUSSION.md docs/superpowers/specs/2026-08-30-character-animation-architecture.md docs/superpowers/specs/2026-08-30-character-state-machine.md docs/superpowers/specs/2026-08-30-character-movement-system.md docs/superpowers/specs/2026-08-30-character-asset-spec.md docs/superpowers/specs/2026-08-30-animation-playground-plan.md && git diff --cached --name-only && git commit -m "docs(office): record runtime acceptance evidence"`

## Rollback and recovery boundary

- Each task has its own commit and can be reverted without touching pre-existing user changes.
- The feature flag disables Office rendering while preserving Harness and existing shell behavior.
- Office data lives only under a new `userData/office-state.v1` path; deleting that file resets Office configuration/history but does not alter Sessions, settings or Runtime state.
- Invalid packs, Pixi/WebGL failures and adapter incompatibility fall back to diagnostic/static presentation; they never blank the whole shell or terminate the Harness view.
- A failed `main.js` or `window-manager.js` syntax check blocks the task before any further test or commit.
