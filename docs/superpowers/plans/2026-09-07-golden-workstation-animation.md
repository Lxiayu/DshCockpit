# Golden Workstation And Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the user's accepted initial 2-column by 3-row relationship draft into one reusable workstation template, prove one real-asset workstation and task animation loop, and only then propagate the template to six runtime seats.

**Architecture:** `src/office/fixtures/office-layout.json` remains the single canonical production layout and stays schema version 1 for backward compatibility. A pure `workstation-layout.js` normalizer converts injected editor JSON into template-relative furniture and anchors; its output is committed into the canonical fixture, never loaded from `Downloads` at runtime. Employees retain stable `desk-1..desk-6` assignments and occupy `seat` anchors dynamically rather than being persisted as furniture.

**Approval boundary:** The user accepted the draft's initial 2-column by 3-row relationship and asked to start implementation. Exact character scale, seated composition, and occlusion are not yet approved. Workstation 1 is therefore the visual checkpoint; its tuned template must be easy to revert without changing editor schema or character source assets before it is copied to all six stations.

**Tech Stack:** Electron 37, CommonJS, PixiJS 8, local PNG assets, Node `node:test`, Electron visual verification.

---

## Canonical Data And Compatibility

- `src/office/fixtures/office-layout.json` is the only production source for scene nodes, edges, furniture, workstation templates, instances, and `seat`/`approach`/`leave` anchors.
- Keep `schemaVersion: 1`; add optional `workstations` data so old injected schema-v1 fixtures remain valid. Do not create a second production `workstation-layout.json` that can drift.
- Store the immutable authoring input at `test/fixtures/office-layout-draft.json`. Record its original path, SHA-256, import date, and purpose in `test/fixtures/office-layout-draft.provenance.json`. Tests only inject parsed JSON and never read a personal path.
- Map stations deterministically by desk coordinates in row-major order: top-left/right become `desk-1/2`, middle-left/right `desk-3/4`, bottom-left/right `desk-5/6`. Existing employee seat IDs do not change.
- The main-office fixture changes from 3 columns x 2 rows to 2 columns x 3 rows. `src/office/fixtures/waypoints.json` remains a separate animation-playground fixture and is not silently made a second main-office source.
- Editor schema remains version 1. Missing `layer` defaults by kind, missing `groupId` is inferred by nearest desk, missing selection becomes `null`, and imported scene dimensions are converted through normalized coordinates. Duplicate IDs, unknown assets/kinds, non-finite coordinates/scales, and unsupported schema versions are rejected. Unknown top-level/item fields are ignored on import and not re-emitted.

## File Map

- Create `src/office/runtime/workstation-layout.js`: pure validation, deterministic grouping, template derivation, and canonical workstation expansion.
- Add `test/fixtures/office-layout-draft.json` and `.provenance.json`: immutable hermetic copy of the user draft and its SHA-256 provenance.
- Modify `src/office/fixtures/office-layout.json`: canonical 2x3 nodes, routes, workstations, furniture asset references, and anchors.
- Modify `src/office/runtime/office-layout.js`: validate optional workstations, enforce 2 columns x 3 rows for the canonical fixture, expose anchors and real furniture parts, and retain compatibility with injected legacy schema-v1 fixtures.
- Modify `src/office/layout-editor.js`, `office.html`, `office.css`, and `office-page.js`: pure round-trip operations plus import, scale, layer, and group controls.
- Modify `src/office/layout-assets.js`: expose stable asset IDs, resource URLs, default layers, scale, and anchors for production and editor use.
- Modify `src/office/render/pixi-office-renderer.js`: consume injected office textures and render back/main/front parts with stable identity and diagnostics.
- Modify `src/office/office-module.js`, `src/main.js`, `src/office/office-boot.js`, and `src/office/office.html`: resolve the selected production character pack with built-in fallback, load per-view office textures, inject them into the renderer, and drive timed transition phases and paths.
- Modify the production pack under `resources/characters/deepseek-default/` only if working-frame geometry passes. `src/office/fixtures/character-pack/` remains test-only; production Office must no longer hard-code it as its active pack.
- Test in existing top-level files: `test/office-asset-runtime.test.js`, `test/office-renderer.test.js`, `test/office-ui.test.js`, `test/office-transition-controller.test.js`, `test/office-runtime-snapshot.test.js`, and `test/office-asset-pack.test.js`.

## Task 1: Normalize The Draft And Migrate The Canonical Layout

- [ ] Copy `/Users/xia/Downloads/office-layout-draft.json` byte-for-byte to the test fixture, calculate SHA-256, and commit provenance metadata; production code must not know the personal path.
- [ ] Add failing tests in `test/office-asset-runtime.test.js` for six complete nearest-desk groups, rejection of missing/duplicate/ambiguous members, row-major stable IDs, averaged relative offsets, and exclusion of calibration characters from furniture.
- [ ] Run `node --test test/office-asset-runtime.test.js` and confirm failure is `MODULE_NOT_FOUND` for `workstation-layout.js`.
- [ ] Implement a filesystem-free API `normalizeWorkstationDraft(draft)` returning `{ template, instances }`. Each instance has `deskId`, desk position, and derived `seat`, `approach`, and `leave`; the template has desk/monitor/chair asset IDs, offsets, scales, and layers.
- [ ] Use the measured draft offsets as assertions with tolerance: monitor about `(0.002706,-0.092636)`, chair `(0.074337,-0.038946)`, seat `(0.054719,-0.103251)`. Define `approach` below/right of `seat` and `leave` as the connected aisle node, not an arbitrary teleport point.
- [ ] Add failing `office-renderer.test.js` assertions for exactly two rounded x columns, three y rows, row-major `desk-1..6`, all anchor references resolving, connected task routes, and the unchanged employee assignment contract.
- [ ] Migrate `office-layout.json` nodes, edges, reserve zone, furniture IDs, and workstation data together. Preserve `desk-1..6`, resident/collaborator/spare tags, and connect every approach/leave route to the roaming graph.
- [ ] Update `office-layout.js` so the canonical fixture enforces 2 columns x 3 rows while legacy schema-v1 fixtures without `workstations` retain their existing structural validation.
- [ ] Run `node --test test/office-asset-runtime.test.js test/office-renderer.test.js test/office-employee-profile.test.js test/office-movement-controller.test.js` and commit this contract separately.

## Task 2: Make The Editor Round-Trip The Authoritative Draft

- [ ] Add failing pure-operation tests for `load`, `setScale`, `bringForward`, `sendBackward`, and `moveGroup`, including duplicate-ID/malformed-draft rejection and one-step undo/redo.
- [ ] Assert schema-v1 defaults: default layer by kind, deterministic inferred `groupId`, normalized scene migration, `selectedId: null` when invalid, and ignored unknown fields.
- [ ] Implement the operations in `layout-editor.js` without filesystem or DOM access. Export only `id`, `kind`, `asset`, normalized `position`, positive `scale`, `direction`, integer `layer`, and `groupId`.
- [ ] Add an accessible “Import draft” file input and selection controls in `office.html`/`office.css`; wire them in `office-page.js`, displaying stable validation errors without partially replacing the current draft.
- [ ] Add UI tests for import, selection, scale/layer controls, grouped movement, keyboard behavior, and malformed-file recovery.
- [ ] Visually verify importing the committed raw draft reproduces two columns x three rows and moving one group preserves all relative offsets.
- [ ] Run `node --test test/office-asset-runtime.test.js test/office-ui.test.js` and commit the editor round trip.

## Task 3: Load Real Furniture And Calibrate One Golden Workstation

- [ ] Add failing catalog tests proving every workstation asset ID resolves to a managed `resources/office/layout-editor/*.png` URL plus default layer/scale/anchor metadata; no production URL may point into `photo/` or `artifacts/`.
- [ ] Add failing renderer tests for injected desk/monitor/chair textures, stable per-part sprite identity across snapshots/resizes, explicit back/main/front ordering, and `OFFICE_TEXTURE_MISSING` diagnostics with placeholder fallback.
- [ ] Extend `layout-assets.js` as the shared manifest. In `office.html`, load each declared office URL into a new per-view `Image`, create a per-view `PIXI.Texture` from each decoded image, collect stable failures, and inject an office-texture map separately from character-pack textures. Do not use the global `PIXI.Assets` cache for furniture.
- [ ] Render furniture sprites and textures owned by the current view; updates reuse them, resize recomputes transforms without reloading, and `destroy()` releases that view's sprites, textures, and image references. Add a two-view test proving destroying one view neither mutates nor destroys the other's resources.
- [ ] Render only workstation 1 with monitor/chair back layers, employee at `seat`, and required desk/front occluder above the employee. Keep the other five on the reversible placeholder path during calibration.
- [ ] Capture desktop and compact-window screenshots plus texture diagnostics. Confirm no blank texture, overlap, or resize shift; record artifacts under ignored `artifacts/office-view/`.
- [ ] After this visual checkpoint is acceptable, switch all six instances to the same template. If not acceptable, tune template metadata only; do not alter the raw draft, editor schema, or source PNGs.
- [ ] Run `node --test test/office-renderer.test.js test/office-asset-runtime.test.js test/office-ui.test.js` and commit the real workstation renderer.

## Task 4: Classify Existing Working Frames And Prove The Runtime Loop

- [ ] Inventory all four tracked `photo/output_nobg/working-front-3q-01..04.png` sources as `present-unconnected`; verify SHA-256, alpha, 1254x1254 bounds, visible bounds, chair/hands composition, and frame-to-frame anchor variance. Never classify them as missing.
- [ ] Use `photo/output_nobg/` as source-of-record and write derived files only under `resources/characters/deepseek-default/assets/animations/working/front-3q/`. Normalize non-destructively to the pack's 352x352 canvas with the existing image pipeline or a new deterministic script under `scripts/`; record source hashes, crop/scale, output hashes, license/provenance, and geometry verdict in an immutable validation report.
- [ ] Add authoring-tool tests for the inventory/normalizer verdict vocabulary `present-unconnected`, `geometry-approved`, or `geometry-rejected`; `validation-report.json` remains acceptance/provenance evidence and is never read by runtime `asset-pack.js`. Only `geometry-approved` frames may be added to production `animations.json`/`anchors.json`; rejected frames leave the current static `working` fallback intact.
- [ ] Add failing boot/runtime tests proving `main.js` resolves the selected installed character pack, falls back to `resources/characters/deepseek-default/`, passes a portable pack descriptor through the office preload/boot boundary, and never supplies `src/office/fixtures/character-pack/` to production Office. Cover invalid selected pack, missing built-in pack, and diagnostic-placeholder fallback with existing runtime error codes.
- [ ] Update `main.js`, `office-boot.js`, and `office.html` so the renderer loads manifest/anchors/animations and frame URLs from that resolved descriptor. Add the approved derived working frames to the built-in production pack only after validation; keep fixture-pack tests independent.
- [ ] Add `preTaskNodeId` and `preTaskPosition` to the per-employee runtime record. Capture them exactly once in `beginTaskTransition`, before the current local route is cleared: retain `currentNodeId` only when it resolves to a non-desk graph node, and always retain the current normalized position. A replacement task keeps the original pre-task origin; cancellation/interruption clears it after cleanup; completed/failed task end clears it only after leave completes.
- [ ] Add failing module integration tests for phase ownership: `stop/turn` use zero or configured short durations; the graph route ends at the workstation `approach` node; `arrive/sit` is a separate interpolated anchor segment from `approach` to `seat`; `work` waits for terminal runtime state; `result` lasts a configured presentation duration; `stand` reverses the anchor segment from `seat` to `approach`; `leave` starts a graph route to a still-valid `preTaskNodeId`, otherwise the nearest reachable roaming node chosen by distance then stable node ID.
- [ ] Keep the workstation reservation across the graph approach route and both anchor segments. Reaching `approach` must not call the generic `arriveAtNode` reservation release path; release the workstation reservation only after the stand segment reaches `approach` and the leave route has been acquired, or during explicit interruption cleanup. Graph route reservations remain governed by the movement controller per segment.
- [ ] Assert local behavior resumes only after arrival at the leave target, and snapshots expose `transitionKind`, `transitionPhase`, `preTaskNodeId`, target/seat/approach anchor, active segment, and animation state without a position jump.
- [ ] Cover completed, failed, cancellation/interruption, reduced-motion zero-duration phases, repeated event replay, and invalid/missing route degradation in module/transition/snapshot tests.
- [ ] Implement a single clock-driven phase advance path in `office-module.js`; do not synchronously collapse `arrive`, `sit`, and `work`. Model `route-to-approach`, `approach-to-seat`, `seat-to-approach`, and `route-to-leave` explicitly so the generic node-arrival path cannot prematurely release the workstation. Do not generate new in-between images in this baseline.
- [ ] Map animations to phases: directional walk for route movement, approved seated working animation or static fallback at `seat`, completed/failed result expression, then directional walk during stand/leave.
- [ ] Run focused transition, module/UI, snapshot, animation, asset-pack, and renderer tests; then run `npm test`.
- [ ] Replay one deterministic task in Electron for workstation 1 and capture evidence of walk -> seat/work -> completed and failed result -> stand -> leave at desktop and compact sizes, including reduced motion and missing-texture fallback.

## Commit, Rollback, And Push Boundaries

- Commit plan, layout contract, editor round trip, renderer, and animation loop separately. Do not include `artifacts/office-view/` or `requested-port`.
- Layout rollback is one canonical fixture/module commit; renderer rollback changes only office catalog/texture rendering; working-frame rollback removes only derived production frames and pack metadata, never source PNGs.
- Push scoped commits to the already authorized `origin/feature/s1-office` only after focused tests, full `npm test`, and Electron evidence complete. A visual checkpoint failure is reported and left unpropagated rather than hidden by generating more assets.

## Exit Criteria

- The committed raw draft deterministically reproduces a canonical two-column by three-row main-office layout, with no personal-path dependency.
- Six stable desks share one template; employees dynamically occupy `seat` anchors and can route through `approach` and `leave` without teleporting.
- The editor imports, scales, reorders, group-moves, exports, undoes, and redoes schema-v1 drafts with explicit defaults and validation.
- Real managed office textures render with explicit occlusion, stable identity, resize behavior, lifecycle ownership, and missing-texture diagnostics.
- Existing working frames are either connected after geometry approval or explicitly recorded as present but geometry-rejected, with the static fallback preserved.
- Successful, failed, cancelled, and reduced-motion task loops have deterministic automated and Electron evidence; `npm test` passes before push.
