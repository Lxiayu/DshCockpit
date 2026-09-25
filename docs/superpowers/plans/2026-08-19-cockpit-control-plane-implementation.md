# DshCockpit Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Harness-injected shell chrome with an independent Electron Cockpit overlay that exposes Token, Runtime, Automation, Cost, Quick Ask, Search, Remote, and Settings without modifying Harness UI.

**Architecture:** Keep `mainWindow` as a native Harness URL window with no DshCockpit DOM injection. Add one parent-owned `cockpitWindow` renderer controlled through explicit IPC and positioned from main-window/display bounds. Reuse the existing Settings renderer through validated `mode=control` and `mode=settings` routes, while fixing Quick Ask and Tasks close/focus behavior.

**Tech Stack:** Electron 37, isolated sandboxed preload scripts, vanilla HTML/CSS/JS renderers, Node `node:test`, existing RuntimeManager/tokenStats/cost/Scheduler/compact modules, Playwright CLI for browser checks.

---

## File Map

- Create: `src/cockpit-bounds.js` — pure overlay bounds calculation and mode dimensions.
- Create: `src/cockpit-snapshot.js` — pure snapshot normalization/aggregation from shell data.
- Create: `src/cockpit.html` — independent Rail, Token Peek, Cockpit Panel, and Onboarding renderer.
- Create: `src/cockpit-preload.js` — narrow context-isolated bridge, including safe File-to-path handling.
- Modify: `src/main.js` — cockpit window lifecycle, snapshot IPC, action allowlists, runtime/task/theme broadcasts, settings center routing.
- Modify: `src/preload.js` — remove Harness DOM injection and retain only a compatibility bridge if needed.
- Modify: `src/settings-store.js` — persist `cockpitOnboarded` and validate it.
- Modify: `src/settings-preload.js` — expose center mode/navigation and control-page bridge events.
- Modify: `src/settings.html` — mode-aware navigation/header, Control Center return/close controls, task dialog close/unsaved handling.
- Modify: `src/quickask.html` — visible close button, focus/blur behavior, execution-state semantics.
- Modify: `src/theme.css` — shared cockpit tokens and window-safe styles.
- Create: `test/cockpit-bounds.test.js` — geometry tests.
- Create: `test/cockpit-snapshot.test.js` — snapshot normalization/state tests.
- Create: `test/cockpit-ui.test.js` — static renderer/preload quality gates.
- Modify: `test/settings-ui.test.js` — mode, control actions, task close affordances.
- Modify: `test/channels.test.js` or `test/channels-c6.test.js` only if shared IPC assertions need updates; do not alter unrelated channel behavior.

## Task 1: Geometry and Snapshot Contracts

**Files:**
- Create: `src/cockpit-bounds.js`
- Create: `src/cockpit-snapshot.js`
- Create: `test/cockpit-bounds.test.js`
- Create: `test/cockpit-snapshot.test.js`

- [ ] **Step 1: Write failing bounds tests**

Cover Rail/Peek/Panel/Onboarding dimensions, right-edge anchoring, minimum margins, negative-coordinate displays, narrow work areas, and bounds that cannot fit the full requested panel.

- [ ] **Step 2: Run the bounds tests and verify the expected missing-module failure**

Run: `node --test test/cockpit-bounds.test.js`

Expected: FAIL because `src/cockpit-bounds.js` does not exist.

- [ ] **Step 3: Implement the minimal pure bounds module**

Export `MODE_SIZES`, `computeCockpitBounds(mainBounds, displayWorkArea, mode, viewport)` and clamp results to the display work area without persisting screen coordinates.

- [ ] **Step 4: Write failing snapshot tests**

Test `normalizeUsage`, `normalizeCost`, `buildAutomationSummary`, `runtimeState`, and `buildSnapshot` for healthy/starting/restarting/offline runtime, null usage/cost sections, exact today/month cost fields plus currency and budgetStatus, remote failure fallback, failed distinct-task count limited to the last 24 hours, task status priority (`running > failed > scheduled > completed > disabled`), ISO `lastRunAt` and history timestamp conversion to epoch milliseconds, and max-three sorted items.

- [ ] **Step 5: Run snapshot tests to verify they fail for missing implementation**

Run: `node --test test/cockpit-snapshot.test.js`

Expected: FAIL because `src/cockpit-snapshot.js` does not exist.

- [ ] **Step 6: Implement pure snapshot normalization**

Keep this module Electron-free. Accept shell data and a `now` value, convert existing ISO scheduler history timestamps to epoch milliseconds, and return the exact spec schema with defensive defaults.

- [ ] **Step 7: Run both focused suites**

Run: `node --test test/cockpit-bounds.test.js test/cockpit-snapshot.test.js`

Expected: PASS.

## Task 2: Main-Process Cockpit Window and IPC

**Files:**
- Modify: `src/main.js`
- Modify: `src/settings-store.js`
- Modify: `src/preload.js`
- Modify: `src/theme.css`
- Test: `test/cockpit-snapshot.test.js` and a new static section in `test/cockpit-ui.test.js`

- [ ] **Step 1: Add failing static contract tests**

Assert that `main.js` defines a parent-owned cockpit window, explicit cockpit IPC handlers, mode/page allowlists, lifecycle event coverage, runtime-ready + main-visible cockpit creation/onboarding hooks, and no longer sends `chrome:tokens` to the Harness renderer. Assert `preload.js` has no `document.body.appendChild`, `querySelector`, header/toolbar scanning, or shell chrome element creation.

- [ ] **Step 2: Run the static test and verify it fails against the existing injected chrome**

Run: `node --test test/cockpit-ui.test.js`

Expected: FAIL on the existing `src/preload.js` injection and missing cockpit files/handlers.

- [ ] **Step 3: Add cockpit window creation and positioning**

Implement `createCockpitWindow`, `syncCockpitBounds`, hide/show helpers, and debounced listeners for move/resize/maximize/unmaximize/fullscreen/show/hide/minimize/restore/close. Hook creation and initial `showInactive()` into the runtime-ready + Harness-visible path, then hide it on parent hide/minimize/close and resume it on restore/show. Use the spec’s parent-owned, non-global-always-on-top, `showInactive()` strategy and re-match the current display via `screen.getDisplayMatching`.

- [ ] **Step 4: Add snapshot assembly and IPC actions**

Build the snapshot from existing runtime state, tokenStats, costSnapshot, scheduler settings/history, scheduledRunning, remote status, theme and onboarding state. Add explicit handlers for `cockpit:get-snapshot`, `cockpit:complete-onboarding`, `cockpit:open-quick-ask`, `cockpit:open-search`, `cockpit:open-center`, `cockpit:open-settings`, `cockpit:set-workspace`, `cockpit:compact-now`, and `cockpit:close` with strict page/mode validation; `open-settings` maps only to `openCenter('settings', 'general')`.

- [ ] **Step 5: Migrate compact and workspace drop safely**

Keep the existing main-process operations as the implementation target. Accept only a validated directory path from the cockpit preload’s File conversion; do not expose arbitrary shell/path operations. Continue supporting old `chrome:set-workspace` and `chrome:compact-now` for one compatibility cycle, but no Harness renderer calls them after this task.

- [ ] **Step 6: Remove the Harness DOM chrome from preload**

Reduce `src/preload.js` to the minimal bridge needed by the native Harness surface, or an empty isolated preload if no bridge consumer remains. Remove stale injected-chrome comments as well as code so static audits do not report obsolete selectors. Do not modify the loaded Harness document.

- [ ] **Step 7: Add onboarding setting validation and lifecycle broadcasts**

Add `cockpitOnboarded` to settings defaults/whitelist and a process-scoped `onboardingDismissedThisRun` flag. Broadcast normalized snapshots after token poll, scheduled changes, runtime transitions, theme changes, compact completion, and relevant settings changes. On runtime restart, emit `restarting`; first boot emits `starting`. Add tests for Escape/close temporary dismissal, no repeat within the current process, replay on the next process when the persisted flag is false, and step preservation across runtime restart plus hide/restore.

- [ ] **Step 8: Re-run focused tests and existing core tests**

Run: `node --test test/cockpit-ui.test.js test/cockpit-snapshot.test.js test/settings-store.test.js test/token-stats.test.js test/cost.test.js test/scheduler.test.js`

Expected: PASS.

## Task 3: Independent Cockpit Renderer

**Files:**
- Create: `src/cockpit.html`
- Create: `src/cockpit-preload.js`
- Modify: `src/theme.css`
- Create/modify: `test/cockpit-ui.test.js`

- [ ] **Step 1: Add failing renderer contract tests**

Assert the HTML has Rail Token/Cockpit/Settings controls, Peek and Panel containers, onboarding steps, close buttons, aria labels/tooltips, fixed dimensions, and no Harness selectors. Assert preload exposes only the documented narrow APIs, including `openSettings`, `setWorkspaceFromFile`, and `compactNow`, and performs `webUtils.getPathForFile(file)` internally.

- [ ] **Step 2: Run the renderer test to verify missing-file failure**

Run: `node --test test/cockpit-ui.test.js`

Expected: FAIL because cockpit renderer/preload files do not exist.

- [ ] **Step 3: Implement the cockpit preload bridge**

Expose `getSnapshot`, snapshot/theme listeners, onboarding completion, Quick Ask/Search/Center/Settings actions, `setWorkspaceFromFile(file)`, `compactNow`, and `close`. In `setWorkspaceFromFile`, resolve the File path inside preload, reject missing/non-string paths, and invoke only the named IPC channel.

- [ ] **Step 4: Implement Rail, Peek, Panel, and onboarding state machine**

Render independent UI with explicit `rail`, `tokenPeek`, `cockpitPanel`, and `onboarding` states. Use snapshot-driven sections, pressure colors, explicit Runtime Restarting state, task summaries, Quick Actions, Escape/blur handling, keyboard focus, `showInactive`-compatible behavior, and onboarding tests/behavior for temporary dismiss versus persisted completion, current-step preservation on restart/hide-restore, and next-process replay.

- [ ] **Step 5: Implement drop target and Compact action**

Allow folder drop only on cockpit-controlled UI and show success/failure feedback. Compact is a visible Peek action with running/success/failure states; it must not depend on Harness DOM or page session selectors.

- [ ] **Step 6: Run focused UI tests**

Run: `node --test test/cockpit-ui.test.js`

Expected: PASS.

## Task 4: Settings Control/Configuration Modes

**Files:**
- Modify: `src/main.js`
- Modify: `src/settings-preload.js`
- Modify: `src/settings.html`
- Modify: `test/settings-ui.test.js`

- [ ] **Step 1: Add failing mode-routing tests**

Assert mode/page allowlists, Control Center labels, Control-only return-to-Cockpit action, Settings-only configuration semantics, a Settings-mode content close action, a single settings window navigation event contract, and dirty-form `center:navigate` confirmation that preserves the current mode/page when canceled.

- [ ] **Step 2: Run the routing tests against the current all-pages Settings UI**

Run: `node --test test/settings-ui.test.js`

Expected: FAIL because mode query handling and center navigation are absent.

- [ ] **Step 3: Implement single-window center routing in main/preload**

Parse and validate `mode` and `page` in main process, create the one existing Settings window with the query/hash, and send `center:navigate` when it already exists. Expose a narrow `onCenterNavigate`, `closeCenter`, and `returnToCockpit` bridge. The renderer must compare the requested route against dirty form state, ask for confirmation, and only mutate mode/nav/hash after confirmation; cancel leaves the current route and form untouched.

- [ ] **Step 4: Make Settings renderer mode-aware**

Add mode-specific title/subtitle, nav filtering, default page, and Control header actions. Add a content-area close button in Settings mode as well as the Control return/close actions. Track dirty form state for incoming center navigation and preserve the current route when confirmation is canceled. Preserve existing page logic and IPC calls. Unknown page/mode falls back to the safe default rather than rendering an empty page.

- [ ] **Step 5: Add Control return behavior**

Closing via “Return to Cockpit” closes Settings, focuses the Harness parent, and asks Cockpit to reopen its Panel. A normal close only closes the Settings window.

- [ ] **Step 6: Run Settings tests and existing UI tests**

Run: `node --test test/settings-ui.test.js test/i18n.test.js`

Expected: PASS.

## Task 5: Quick Ask and Tasks Close/Focus Repair

**Files:**
- Modify: `src/quickask.html`
- Modify: `src/quickask-preload.js` only if a close/blur action needs a bridge change
- Modify: `src/settings.html`
- Modify: `src/main.js` only for explicit window hide/blur semantics
- Modify: `test/settings-ui.test.js`
- Create: `test/quickask-ui.test.js`

- [ ] **Step 1: Add failing Quick Ask and Tasks UI tests**

Assert Quick Ask has a visible close button, Escape handler, focus target, no prompt reuse, and a blur matrix: pre-submit blur hides the palette, while post-submit blur only hides the window and does not cancel the headless run. Assert Tasks has Control header close/return, dialog close button, Escape/Cancel wiring, unsaved confirmation path, and save-failure form retention.

- [ ] **Step 2: Run focused tests and confirm current failures**

Run: `node --test test/quickask-ui.test.js test/settings-ui.test.js`

Expected: FAIL because Quick Ask has no visible close button and Tasks lacks the specified Control close/unsaved paths.

- [ ] **Step 3: Repair Quick Ask UI**

Add an icon close button with tooltip/aria-label, keep Escape, focus textarea on ready, and implement the blur matrix: a blur before submission hides the palette and clears transient input; a blur after submission hides the window without touching `quickAskRunning` or the headless child. Clear the prompt when a new palette session opens; retain result feedback until explicit close.

- [ ] **Step 4: Repair Tasks Control page and dialog**

Add explicit return/close controls, dialog title-bar close button, Escape and backdrop handling, dirty-form confirmation, and error rendering that keeps form data. Preserve current task tab when scheduler pushes changes, and assert visible Running/Scheduled/Completed/Next Run/Failed status labels in the task view.

- [ ] **Step 5: Run focused tests and scheduler regression tests**

Run: `node --test test/quickask-ui.test.js test/settings-ui.test.js test/scheduler.test.js`

Expected: PASS.

## Task 6: Integration, Visual Verification, and Compatibility Gates

**Files:**
- Modify: `test/cockpit-ui.test.js`
- Modify: `test/settings-ui.test.js`
- Modify: `README.md` or `FEATURES.md` only if user-facing shortcuts/architecture descriptions become inaccurate; keep unrelated docs unchanged.

- [ ] **Step 1: Run the complete unit suite**

Run: `npm test`

Expected: all existing and new Node tests pass.

- [ ] **Step 2: Start the Electron app in a controlled development profile**

Run: `DSH_DESKTOP_USER_DATA=/tmp/dsh-cockpit-ui npm start`

Use a runtime/profile fixture already supported by the repository; do not change the user’s normal DSH_HOME or settings.

- [ ] **Step 3: Verify desktop window behavior**

Exercise Rail, Token Peek, Cockpit, onboarding, Quick Ask, Tasks, Settings modes, and Search. Resize, maximize, minimize/restore, enter/leave fullscreen, and move the main window across displays when available. Confirm overlay bounds follow the parent and do not resize Harness content.

- [ ] **Step 4: Run Playwright screenshots and interaction checks**

Use the Playwright skill/CLI to capture desktop and narrow viewport states. Check nonblank rendering, no text overlap, stable panel dimensions, keyboard focus, close paths, theme changes, reduced-motion behavior, and long Chinese/English labels. If the full runtime cannot boot in the environment, run renderer pages from a local static server and report the Electron limitation explicitly.

- [ ] **Step 5: Perform Harness-coupling audit**

Run a comment-aware audit over `src/preload.js`, `src/cockpit*`, and `src/main.js` for `querySelector`, `querySelectorAll`, `data-testid`, header/toolbar class selectors, `document.body.appendChild`, `webContents.executeJavaScript`, and `chrome:tokens`.

Expected: no Harness UI selector/DOM injection matches in the new Cockpit path. Compatibility IPC names may remain only in main process as documented migration shims.

- [ ] **Step 6: Report changes without commit/push**

Leave `docs/` ignored per user request. Do not create Git commits or push to GitHub. Report test commands, Electron/Playwright coverage, and any environment-limited checks.
