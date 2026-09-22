# DshCockpit Cockpit Incremental Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the existing independent Cockpit overlay by separating Control Center operations from Settings configuration, adding missing progressive-disclosure flows, replacing Harness DOM compact injection with RPC, and removing superseded shell chrome without regressing existing features.

**Architecture:** Keep the existing `mainWindow` and independent `cockpitWindow` architecture. Reuse the current Settings renderer and IPC contracts, but introduce explicit mode-scoped sections and transactional main-process helpers for Harness RPC, Runtime state, and the Quick Ask shortcut. Migrate each behavior behind tests before deleting its legacy path.

**Tech Stack:** Electron 37, vanilla HTML/CSS/JavaScript renderers, context-isolated preload bridges, Node `node:test`, existing Harness HTTP RPC and DshCockpit runtime/scheduler/remote modules.

---

## Working Tree Constraint

The current worktree contains the user's uncommitted first-round Cockpit implementation. Do not create a separate worktree, reset files, or commit unrelated changes. Use focused diffs and verification checkpoints. Do not create Git commits unless the user separately asks for them.

## File Map

- Create: `src/harness-rpc.js` - validated Harness RPC client and latest non-blank session selection for `/compact`.
- Create: `src/runtime-state.js` - one state transition/broadcast controller for Cockpit Runtime state.
- Create: `src/quickask-shortcut.js` - transactional single-accelerator registration helper.
- Create: `src/assets/cockpit-logo.jpg` - DshCockpit-owned copy of `website/public/img/logo.jpg`.
- Modify: `src/main.js` - use the new helpers, add Task Peek actions, mode-specific center intents, and remove legacy `chrome:*` handlers.
- Modify: `src/compact.js` - retain compaction tracking/history only; remove DOM selectors and injection.
- Modify: `src/cockpit-bounds.js` - add stable `taskpeek` dimensions.
- Modify: `src/cockpit-snapshot.js` - preserve task timestamps/statuses needed by Task Peek.
- Modify: `src/cockpit-preload.js` - expose only explicit Task Peek/new-task actions.
- Modify: `src/cockpit.html` - Task Peek, real-Rail onboarding highlights, logo, and mode-safe actions.
- Modify: `src/settings.html` - scoped Cost/Runtime/Remote/Channels sections, empty-group visibility, Runtime operation surface, channel mode rendering, shortcut setting, and new-task intent.
- Modify: `src/settings-preload.js` - expose Runtime state/shortcut APIs and receive center intents without arbitrary routes.
- Modify: `src/settings-store.js` - validate Quick Ask presets and remove `tokenWidget`.
- Modify: `src/preload.js` - remove superseded Harness chrome bridge, retaining only actually used non-DOM behavior.
- Modify: `README.md`, `README.en.md`, `FEATURES.md` - replace old capsule/in-window chrome/right-click compact descriptions.
- Modify: `electron-builder.yml` only if the app-asar files rule does not already package `src/assets/cockpit-logo.jpg`; do not add redundant `extraResources` when app.asar already contains it.
- Create: `test/harness-rpc.test.js` - RPC envelopes, session selection, version payload and retry policy.
- Create: `test/runtime-state.test.js` - transition/invalidation/broadcast behavior.
- Create: `test/quickask-shortcut.test.js` - transactional registration behavior.
- Modify: `test/settings-ui.test.js` - center mode sections, group visibility, Remote/Runtime/Channels responsibility, shortcut and task intent.
- Modify: `test/cockpit-ui.test.js` - Task Peek, onboarding real controls, logo, legacy bridge gates.
- Modify: `test/cockpit-bounds.test.js` - Task Peek geometry.
- Modify: `test/cockpit-snapshot.test.js` - task timestamps and all task states.
- Modify: `test/compact.test.js` - remove DOM injection assertions while retaining tracker/history tests.
- Modify: `test/settings-store.test.js` - shortcut validation and legacy key removal.
- Modify: `test/runtime-manager-unit.test.js` only where lifecycle callbacks need an explicit assertion; do not alter unrelated installer/update behavior.

## Task 1: Split Control Center and Settings Responsibilities

**Files:**

- Modify: `src/settings.html:352-375`
- Modify: `src/settings.html:647-706`
- Modify: `src/settings.html:823-913`
- Modify: `src/settings.html:1883-1940`
- Modify: `test/settings-ui.test.js`

- [ ] **Step 1: Write failing mode-scope tests**

Add assertions that Cost, Runtime, Remote, and Channels contain explicit `data-center-scope="control"` and `data-center-scope="settings"` sections. Use a small structural helper that extracts an element by id and checks descendant ownership instead of one loose regex spanning the document. Assert these exact ownership rules:

```js
assert.match(settingsHtml, /id="remote-config"[^>]*data-center-scope="settings"/);
assert.match(settingsHtml, /id="remote-operations"[^>]*data-center-scope="control"/);
assert.match(settingsHtml, /id="runtime-config"[^>]*data-center-scope="settings"/);
assert.match(settingsHtml, /id="runtime-operations"[^>]*data-center-scope="control"/);
assert.match(settingsHtml, /id="cost-overview"[^>]*data-center-scope="control"/);
assert.match(settingsHtml, /id="cost-config"[^>]*data-center-scope="settings"/);
assert.match(settingsHtml, /id="channels-list"[^>]*data-center-scope="control"/);
assert.match(settingsHtml, /id="channels-config"[^>]*data-center-scope="settings"/);
```

Also assert:

- `remoteControl`, `remotePort`, `remoteCompat`, and `remotePublicMode` are in `remote-config`.
- pairing, device revoke, public enable/disable, tunnel start/stop and access links are in `remote-operations`.
- `remotePublic` is not exposed as a duplicate Settings checkbox; it remains Runtime operational state controlled by the existing public enable/disable IPC.
- Cost balance/usage/budget status/refresh are in `cost-overview`; rates, peak windows and monthly budget inputs are in `cost-config`. Add `cost` to the Settings allowlist but never show both scopes together.
- Runtime check/apply/rollback controls and install console move into `runtime-operations`. Settings `update` retains only channel, pinned version, registry, keep count and startup-check configuration. Control continues to enter `runtime`; Settings continues to expose `update`.
- Channels Control cards show state/toggle/test; Settings cards show allowlist/credentials/setup guide.
- Moved Control actions enter a button-level pending state, reject duplicate clicks, restore the button on failure, and refresh authoritative state without mutating persisted configuration.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/settings-ui.test.js`

Expected: FAIL because scoped sections and group visibility do not exist.

- [ ] **Step 3: Add mode-scoped markup without changing IPC contracts**

Wrap existing configuration and operation blocks with stable IDs and `data-center-scope`. Do not duplicate element IDs or create second Cost/Remote/Channels implementations. Add a compact Control Runtime status block that reads current shell status and invokes the existing guarded restart IPC. Move the existing update operation DOM into this Control block while leaving persistent update strategy in Settings.

In `applyCenterMode`, set a body/root mode attribute and hide the opposite scope before showing a page:

```js
document.documentElement.dataset.centerMode = centerMode;
document.querySelectorAll('[data-center-scope]').forEach((el) => {
  el.hidden = el.dataset.centerScope !== centerMode;
});
```

Call the same scope sync after `center:navigate` and before `showPage` to prevent stale content flash.

- [ ] **Step 4: Split Channels rendering by mode**

Keep one `channelsCache` and one refresh subscription. Render only operational controls in Control mode and only allowlist/credentials/guide configuration in Settings mode. A mode switch rerenders from `channelsCache` with `preserveInput: true`; canceled dirty navigation must not rerender or discard inputs.

- [ ] **Step 5: Add dynamic group-label visibility**

Implement one `syncNavGroups()` that walks each `.group-label` until the next label and shows the label only when at least one child `.nav-item` is not hidden by mode and search. Invoke it after `applyCenterMode` and on every search update. Do not special-case the Chinese label “系统”.

Add a pure visibility helper or minimal DOM fixture covering combined mode/search filters: a group hidden by mode stays hidden when search clears, a group with one search match stays visible, and the Control “系统” group has no visible label.

- [ ] **Step 6: Run focused tests and existing channel/remote tests**

Run: `node --test test/settings-ui.test.js test/channels.test.js test/channels-c6.test.js test/public-remote.test.js`

Expected: PASS, except a sandbox-only localhost `EPERM` must be reported rather than hidden.

## Task 2: Add Task Peek and Explicit Task Intents

**Files:**

- Modify: `src/cockpit-bounds.js`
- Modify: `src/cockpit-snapshot.js`
- Modify: `src/cockpit-preload.js`
- Modify: `src/cockpit.html`
- Modify: `src/main.js`
- Modify: `src/settings-preload.js`
- Modify: `src/settings.html`
- Modify: `test/cockpit-bounds.test.js`
- Modify: `test/cockpit-snapshot.test.js`
- Modify: `test/cockpit-ui.test.js`
- Modify: `test/settings-ui.test.js`

- [ ] **Step 1: Write failing Task Peek tests**

Cover:

- `MODE_SIZES.taskpeek` and clamped bounds.
- Renderer mode allowlist includes `taskpeek`.
- Tasks panel action requests `taskpeek` rather than opening the full page.
- Peek renders `running`, `scheduled`, `completed`, `failed`, `nextRunAt`, and `lastRunAt`.
- `New Task` calls a dedicated bridge action; `Manage All` opens normal Tasks.
- opening full Tasks collapses Cockpit to Rail; returning restores Panel.
- a `new-task` intent arriving while a Settings form is dirty does nothing when the existing navigation confirmation is canceled; mode, page, form values and pending intent remain unchanged/cleared safely.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/cockpit-bounds.test.js test/cockpit-snapshot.test.js test/cockpit-ui.test.js test/settings-ui.test.js`

Expected: FAIL on missing `taskpeek` mode/actions.

- [ ] **Step 3: Add Task Peek mode and stable layout**

Add a bounded overlay size consistent with existing Peek/Panel. Reuse snapshot automation items; do not add a second scheduler query. Format times in renderer locale and show an em-free ASCII placeholder such as `--` when absent.

- [ ] **Step 4: Add explicit new/manage actions**

Expose separate preload methods such as:

```js
openTasks: () => ipcRenderer.invoke('cockpit:open-control-page', 'tasks'),
newTask: () => ipcRenderer.invoke('cockpit:new-task'),
```

`cockpit:new-task` calls the existing validated center opener with `{ mode: 'control', page: 'tasks', intent: 'new-task' }`. The Settings preload forwards only the known intent. The renderer consumes it after Tasks is active and calls the existing dialog-opening function. Unknown intents are ignored.

- [ ] **Step 5: Preserve dirty form and return semantics**

If the center window is already open with dirty content, apply the existing confirmation before navigating or opening the dialog. Cancel means no mode/page/intent changes. Control Center close returns to Harness; Return to Cockpit restores Panel, never stale Task Peek.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/cockpit-bounds.test.js test/cockpit-snapshot.test.js test/cockpit-ui.test.js test/settings-ui.test.js test/scheduler.test.js`

Expected: PASS.

## Task 3: Make Onboarding Point to the Real Branded Rail

**Files:**

- Create: `src/assets/cockpit-logo.jpg`
- Modify: `src/cockpit.html`
- Modify: `test/cockpit-ui.test.js`
- Inspect/modify: `electron-builder.yml`

- [ ] **Step 1: Write failing onboarding/asset tests**

Assert:

- The actual `#rail` remains rendered in onboarding.
- Step 1 applies a highlight class to the actual Token button.
- Step 2 applies it to the actual Cockpit button.
- Rail clicks are intercepted while onboarding is active.
- Cockpit button contains an `<img>` referring to `assets/cockpit-logo.jpg` with an accessible alt or surrounding aria label.
- The copied file exists and has non-zero size.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/cockpit-ui.test.js`

Expected: FAIL because the logo copy and actual-control highlighting are absent.

- [ ] **Step 3: Copy the supplied asset**

Copy `website/public/img/logo.jpg` to `src/assets/cockpit-logo.jpg` byte-for-byte. Do not edit or delete the website source. Since `src/**` is included in app.asar by the current builder `files` rules, add `extraResources` only if a packaging inspection proves it is needed.

- [ ] **Step 4: Refactor onboarding state only**

Keep the real Rail visible. Add a state-derived highlight class/aria description to real controls. While mode is onboarding, Rail click handlers only advance/ignore as specified and never invoke navigation. Step 3 removes highlights before completing the existing one-time flag.

- [ ] **Step 5: Verify source and packaging assumptions**

Run: `cmp website/public/img/logo.jpg src/assets/cockpit-logo.jpg`

Run: `node --test test/cockpit-ui.test.js`

Expected: both exit 0.

## Task 4: Replace DOM Compact Injection with Harness RPC

**Files:**

- Create: `src/harness-rpc.js`
- Modify: `src/main.js`
- Modify: `src/compact.js`
- Create: `test/harness-rpc.test.js`
- Modify: `test/compact.test.js`
- Modify: `test/cockpit-ui.test.js`

- [ ] **Step 1: Write failing RPC contract tests**

Test real request bodies through an injected `request` function:

```js
{
  type: 'client-request',
  rpcId: 'generated-id',
  method: 'session/list',
  payload: { args: {} }
}
```

and:

```js
{
  type: 'client-request',
  rpcId: 'generated-id',
  method: 'commands/execute',
  payload: { args: { agentId: 's-new', line: '/compact', images: [] } }
}
```

Cover latest `updatedAt` non-blank selection, no-session failure, rc.7 payload without `images`, rc.8 payload with `images`, unknown-version argument-shape retry, and no retry for HTTP/network/permission/business errors.

- [ ] **Step 2: Run RPC tests and verify RED**

Run: `node --test test/harness-rpc.test.js`

Expected: FAIL because `src/harness-rpc.js` does not exist.

- [ ] **Step 3: Implement the minimal RPC helper**

Export pure/testable helpers plus one client factory:

```js
module.exports = {
  selectLatestNonBlankSession,
  commandArgsForVersion,
  isArgumentShapeError,
  createHarnessRpcClient,
};
```

Validate Runtime URL origin, generate RPC ids in the main process, enforce fixed method/command values, parse non-2xx and RPC errors, and cap response size/time using the project's existing HTTP patterns.

- [ ] **Step 4: Wire `compactNow()` to RPC**

Use the current Runtime URL and active runtime version. Return structured `{ ok, code, reason, sessionId }`. Preserve the tracker/history flow. UI copy must say it targets the latest active non-blank session rather than claiming the DOM-visible session.

- [ ] **Step 5: Verify the replacement path is GREEN before deletion**

Run: `node --test test/harness-rpc.test.js test/compact.test.js test/cockpit-ui.test.js`

Expected: PASS while the new RPC path is active. Assert `compactNow()` imports and calls the RPC client so passing pure-helper tests cannot mask an unwired production path.

- [ ] **Step 6: Remove DOM trigger code and tests**

Delete `COMPACT_INPUT_SELECTORS`, `COMPACT_SEND_SELECTORS`, `firstMatch`, `buildInjectScript`, `submitCompactCommand`, and all `executeJavaScript` use for compact. Retain scanning, history, memory-file, savings, and tracker tests.

- [ ] **Step 7: Verify RPC and compact tests again after deletion**

Run: `node --test test/harness-rpc.test.js test/compact.test.js test/cockpit-ui.test.js`

Expected: PASS and `rg -n "COMPACT_INPUT_SELECTORS|buildInjectScript|executeJavaScript" src/compact.js src/main.js` has no compact trigger match.

## Task 5: Centralize Runtime Lifecycle State

**Files:**

- Create: `src/runtime-state.js`
- Modify: `src/main.js:478-660`
- Create: `test/runtime-state.test.js`
- Modify: `test/cockpit-ui.test.js`

- [ ] **Step 1: Write failing state-controller tests**

Cover valid states, duplicate-state suppression, snapshot invalidation before broadcast, generation tokens, and transition sequences:

```text
startup -> starting -> healthy
manual restart -> restarting -> healthy
health/spawn failure -> offline
unexpected exit -> offline -> starting -> healthy
crash-loop stop -> offline
```

Start generation 2, then invoke delayed health/exit callbacks carrying generation 1 and assert they cannot replace generation 2's state. Add a source integration assertion that `main.js` has no direct lifecycle assignments outside controller initialization and that spawn `error`, child `close`, health failure, auto-restart and crash-loop paths call the generation-aware controller.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/runtime-state.test.js`

Expected: FAIL because `src/runtime-state.js` does not exist.

- [ ] **Step 3: Implement a focused controller**

The controller owns only the state value/current generation and calls injected `invalidate` and `broadcast` callbacks. `beginGeneration(state)` returns a generation id; `setForGeneration(id, state)` ignores stale ids. It does not spawn, restart, notify, or add retry policy.

- [ ] **Step 4: Replace direct assignments in every lifecycle path**

Use the controller for initial spawn, manual restart, health success/final failure, child `error`, child unexpected `close`, auto-restart scheduling, and crash-loop stop. Capture the generation in child and health callbacks. Keep existing crash guard timing/counts intact.

- [ ] **Step 5: Verify state and runtime manager tests**

Run: `node --test test/runtime-state.test.js test/runtime-manager-unit.test.js test/cockpit-snapshot.test.js test/cockpit-ui.test.js`

Expected: PASS.

## Task 6: Add Transactional Quick Ask Shortcut Settings

**Files:**

- Create: `src/quickask-shortcut.js`
- Modify: `src/settings-store.js`
- Modify: `src/main.js`
- Modify: `src/settings-preload.js`
- Modify: `src/settings.html`
- Create: `test/quickask-shortcut.test.js`
- Modify: `test/settings-store.test.js`
- Modify: `test/settings-ui.test.js`

- [ ] **Step 1: Write failing shortcut tests**

Test the allowlist:

```js
const QUICK_ASK_HOTKEYS = new Set([
  'CommandOrControl+Alt+Space',
  'CommandOrControl+Shift+Space',
  'Alt+Space',
  '',
]);
```

Cover startup registration, successful switch, failed new registration preserving old accelerator and persisted value, Disabled unregistering current, idempotent same-value update, and shutdown unregistering only the tracked accelerator.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/quickask-shortcut.test.js test/settings-store.test.js test/settings-ui.test.js`

Expected: FAIL on missing manager/UI validation.

- [ ] **Step 3: Implement the registration transaction**

The helper receives `globalShortcut` and an `onTrigger` callback. For a non-empty new value, register new first; only after success unregister old and call persistence. If registration fails, leave both old registration and stored value unchanged. Disabled unregisters current and persists `''`.

- [ ] **Step 4: Add narrow IPC and Settings control**

Expose `getQuickAskShortcut` and `setQuickAskShortcut` methods, not arbitrary global shortcut access. Add a General-page select with the four approved choices. On failure, reset the select to the returned active value and show a localized error.

- [ ] **Step 5: Remove `unregisterAll()` ownership leakage**

At app shutdown, unregister only the shortcut helper's tracked accelerator so DshCockpit does not claim ownership of unrelated Electron shortcut registrations.

- [ ] **Step 6: Verify shortcut and UI tests**

Run: `node --test test/quickask-shortcut.test.js test/settings-store.test.js test/settings-ui.test.js test/cockpit-ui.test.js`

Expected: PASS.

## Task 7: Remove Superseded Chrome, Setting, and Bridge Paths

**Files:**

- Modify: `src/main.js`
- Modify: `src/preload.js`
- Modify: `src/settings-store.js`
- Modify: `test/settings-store.test.js`
- Modify: `test/cockpit-ui.test.js`

- [ ] **Step 1: Write failing static cleanup gates**

Assert source no longer contains:

```text
chrome:open-settings
chrome:refresh-tokens
chrome:set-workspace
chrome:report
chrome:compact-now
tokenWidget
tokenWidgetLogged
```

Also assert `src/preload.js` does not append DshCockpit UI, query Harness DOM, or expose a legacy chrome bridge.

Add a migration test that writes an old `settings.json` containing `tokenWidget`, loads `SettingsStore`, calls `save()`, and reloads the file. Startup must succeed, supported values must remain, and `tokenWidget` must be absent from persisted JSON.

- [ ] **Step 2: Run cleanup tests and verify RED**

Run: `node --test test/cockpit-ui.test.js test/settings-store.test.js`

Expected: FAIL on existing legacy handlers/keys.

- [ ] **Step 3: Prove replacement behavior is GREEN**

Before deletion, add or run focused tests proving workspace drop, snapshot/token refresh, Settings open, and RPC compact are each reachable through Cockpit/main-process IPC.

Run: `node --test test/cockpit-ui.test.js test/cockpit-snapshot.test.js test/harness-rpc.test.js test/compact.test.js`

Expected: PASS. If a replacement is missing, implement it behind its failing test before deleting the old route.

- [ ] **Step 4: Delete the legacy paths**

Remove all `chrome:*` registrations and preload exposures. Remove `tokenWidget` from defaults/type lists/tests and rename `tokenWidgetLogged` to a behavior-specific name or delete it if no longer needed. Filter loaded JSON through the supported-key/type schema so obsolete keys are pruned on save without dropping valid values or failing startup.

- [ ] **Step 5: Run the focused cleanup tests**

Run: `node --test test/cockpit-ui.test.js test/settings-store.test.js test/compact.test.js`

Expected: PASS.

## Task 8: Update Product Documentation

**Files:**

- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `FEATURES.md`
- Modify: `test/cockpit-ui.test.js` or add a focused documentation test only if the repository already treats docs as static gates.

- [ ] **Step 1: Record stale wording matches**

Run against production/docs only so assertion strings in tests do not create false positives:

```bash
rg -n "实时胶囊|Live token capsule|右键.*压缩|capsule right-click|窗口内 chrome|in-window chrome|hover" README.md README.en.md FEATURES.md
```

Expected: matches in current documentation.

- [ ] **Step 2: Update Chinese and English docs together**

Describe the independent Edge Rail, Token Peek, Cockpit Panel, Task Peek, Control Center/Settings responsibility, and latest-active-session RPC compact semantics. Remove claims that Cockpit UI lives inside or patches Harness. Preserve existing installation, Runtime, Remote, Channels, model, backup, plugin and skill documentation.

- [ ] **Step 3: Verify stale wording is gone and links remain valid**

Run the Step 1 search again.

Expected: no stale implementation claims; generic historical use of “hover” is allowed only if it accurately describes an existing control.

## Task 9: Full Regression and Build Verification

**Files:**

- Inspect all modified files.

- [ ] **Step 1: Run source hygiene checks**

Run: `git diff --check`

Run:

```bash
rg -n "chrome:|tokenWidget|COMPACT_INPUT_SELECTORS|COMPACT_SEND_SELECTORS|buildInjectScript|submitCompactCommand" src README.md README.en.md FEATURES.md
```

Expected: exit 1 with no matches. Migration tests may contain legacy strings by design.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all non-network tests pass. If the restricted sandbox causes localhost `EPERM` in Remote gateway tests, list the exact tests separately and rerun the rest; do not call the suite fully passing.

- [ ] **Step 3: Run packaging/build validation**

Run: `node scripts/build.js --mac dir --arm64 --publish never`

Then run:

```bash
node_modules/.bin/asar list dist/mac-arm64/DshCockpit.app/Contents/Resources/app.asar | rg '^/src/assets/cockpit-logo.jpg$'
```

Expected: build exits 0 and the archive contains `/src/assets/cockpit-logo.jpg`. If electron-builder emits a different versioned platform directory, locate the single archive with `find dist -path '*/DshCockpit.app/Contents/Resources/app.asar' -print`, validate that it has exactly one result, and inspect that explicit path rather than an unresolved glob.

- [ ] **Step 4: Inspect final diff by requirement**

Check:

- Control Center has no empty group headings.
- Remote/Runtime/Channels operational and configuration surfaces are mutually exclusive.
- Task Peek actions use existing scheduler UI.
- Onboarding uses real Rail controls.
- Compact has no Harness DOM dependency.
- Runtime transitions broadcast from every lifecycle path.
- Exactly one Quick Ask accelerator is owned.
- Legacy paths and stale docs are removed.
- No Harness DOM/layout/UI files were modified or injected.

- [ ] **Step 5: Report evidence and residual risk**

Report exact test/build commands and counts. Explicitly note that the user-excluded real resize/fullscreen/multi-monitor matrix was not expanded, while existing bounds tests were retained.
