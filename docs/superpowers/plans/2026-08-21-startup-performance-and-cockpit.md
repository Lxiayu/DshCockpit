# Startup Performance and Cockpit Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent packaged first-launch blank windows and main-process jank, while making the floating rail reliably clickable and draggable on Windows/macOS.

**Architecture:** Add one session worker service used by the Electron hot path for usage and compaction data. Keep the tested token-stats API intact, but route `collectStats` and compact tracking through the worker service. Harden loading-window readiness/error behavior and replace the 8px rail handle with a bordered rail drag region whose offset updates are serialized and clamped.

**Tech Stack:** Electron 37, Node `worker_threads`, existing `fzstd`, Electron IPC, Node test runner, electron-builder.

---

### Task 1: Add the session worker protocol

**Files:**
- Create: `src/session-worker.js`
- Create: `src/session-worker-client.js`
- Test: `test/session-worker.test.js`

- [ ] Write failing protocol tests for usage collection, compaction scan input, one in-flight request, and worker restart after an error.
- [ ] Run `node --test test/session-worker.test.js` and confirm failure.
- [ ] Implement the worker with message IDs, async file reads, zstd decode and structured results; implement the client with a single long-lived worker, request queue, cache key, and reset-on-error.
- [ ] Run the focused test and confirm pass.

### Task 2: Route Electron hot paths through the worker

**Files:**
- Modify: `src/main.js:collectStats` and startup initialization
- Modify: `src/compact.js:createTracker`
- Modify: `src/token-stats.js` only for shared result normalization/export helpers
- Test: `test/cockpit-ui.test.js`, `test/token-stats.test.js`

- [ ] Add tests asserting the Electron path does not call main-thread zstd decode and that compact/token requests share one worker snapshot.
- [ ] Run focused tests and confirm failure.
- [ ] Instantiate the client after app ready, make `collectStats` use it, invalidate it on workspace changes, and make compact tracking consume worker output with a non-overlapping tick guard.
- [ ] Preserve direct `token-stats.collect` behavior for existing tests and CLI benchmarks.
- [ ] Run focused tests and confirm pass.

### Task 3: Harden loading and packaged-resource startup

**Files:**
- Modify: `src/main.js:createLoadingWindow`, `setLoading`, `ensureRuntimeWithGuide`, and runtime-ready flow
- Modify: `src/loading.html`
- Modify: `scripts/verify-dist.js`
- Test: `test/cockpit-ui.test.js`, new `test/loading-resource.test.js`

- [ ] Add contract tests for ready-to-show display, buffered progress, visible failure state, and packaged icon/resource paths.
- [ ] Run focused tests and confirm failure.
- [ ] Show loading only after `ready-to-show`, handle `did-fail-load`, keep failure text visible, and use `process.resourcesPath`-safe asset URLs. Verify both app resources and runtime seed presence in directory/zip artifacts.
- [ ] Run focused tests and confirm pass.

### Task 4: Make the rail hit area and drag state robust

**Files:**
- Modify: `src/cockpit.html`
- Modify: `src/main.js:createCockpitWindow`, `syncCockpitBounds`, `scheduleCockpitSync`
- Modify: `src/cockpit-bounds.js`
- Test: `test/cockpit-bounds.test.js`, `test/cockpit-ui.test.js`

- [ ] Add tests for bordered rail markup, non-button drag hit area, offset clamping, and drag updates not being overwritten by delayed sync.
- [ ] Run focused tests and confirm failure.
- [ ] Give the rail a visible border and 16px minimum drag padding around non-button content, use pointer capture on the whole drag region, serialize offset IPC updates, and suppress scheduled anchor sync while dragging.
- [ ] Run focused tests and confirm pass.

### Task 5: Defer nonessential startup work and verify

**Files:**
- Modify: `src/main.js` app-ready startup ordering
- Modify: `src/channels/channel-manager.js` only if a deferred-start hook is required
- Test: `test/cockpit-ui.test.js`

- [ ] Add source-contract tests that channel connections, updater initialization, balance polling, compaction polling, and plugin seeding are deferred until after the main window is created.
- [ ] Run focused tests and confirm failure.
- [ ] Move those starts behind a post-window `setTimeout`/idle callback, retain runtime health behavior, and add startup timing logs.
- [ ] Run `node --test` and the build/resource verification commands.
- [ ] Review the diff for unrelated changes and report any platform-specific verification limits.
