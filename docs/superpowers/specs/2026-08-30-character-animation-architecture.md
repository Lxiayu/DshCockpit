# DshCockpit Character Animation Architecture

## Status

Draft for review. This document defines the first implementation boundary for the Virtual Office Character Runtime. It does not authorize implementation by itself.

## Goals

- Render multiple 2D Agent characters smoothly in an Electron office view.
- Keep Agent Runtime facts, local behavior, movement, animation, assets, and HTML UI independent.
- Support the current DeepSeek 娘 character pack and future character packs without core code changes.
- Make missing or invalid assets recoverable through declared fallback chains.

## Non-goals

- No real 3D scene, perspective camera, physics engine, or A* pathfinding in the first version.
- No React assumption; the current renderer boundary is `office.html` plus PixiJS.
- No executable JavaScript inside character packs.
- No animation state inferred from image playback.

## Runtime layering

```text
Electron / office.html
  → Office State Adapter
  → Character Runtime
      ├─ Agent Binding and Runtime Events
      ├─ Local Behavior Scheduler
      ├─ Movement Controller
      ├─ Animation State Machine
      ├─ Asset Resolver
      └─ PixiJS Renderer
  → HTML Details / Controls
```

PixiJS owns the stage, sprites, texture loading, ticker, hit areas, sorting, and visual effects. It does not own Harness IPC, Session binding, task truth, or persistence.

The first implementation pins the PixiJS major version in `package.json` (the current design-only branch intentionally has no PixiJS dependency yet) and uses `PIXI.Assets` for lifetime-scoped loading. The office view creates one `Application` and one root scene per WebContentsView; hiding the view pauses the ticker, while closing/destroying it unloads resources owned by that view. The renderer CSP allows only local `file:`/`app:` asset URLs and never evaluates pack JavaScript (packs contain no JavaScript by contract). The implementation plan must record the chosen PixiJS version and Electron packaging/CSP changes before adding the dependency.

## Frame and movement clocks

- Pixi ticker or `requestAnimationFrame` supplies elapsed time.
- Movement is advanced from logical position and normalized speed.
- Animation frames are advanced from animation elapsed time and frame durations.
- Movement and animation are independent: changing frame count or frame duration cannot change path speed.
- The first Playground default is `1000 ms` per frame. This is configurable and may be tuned after visual review.

## Scene projection

The first version uses a flat Marvis-inspired 2D orthographic office. All sprites share one projection and do not scale by depth. Logical positions are normalized scene coordinates; the renderer converts them to screen coordinates without changing the foot anchor contract.

## Scene layers

```text
Background
Back Furniture
Ground Entities (foot-anchor y-sort)
Front Occluders
Effects / Labels
```

Objects expose `anchor`, `footprint`, `layer`, and optional `back/main/front` parts. Hit areas are separate from collision footprints.

Ground entities use a stable sort key `(footY, layerOrder, entityTypeOrder, entityId)`. The final `entityId` tie-breaker prevents frame-to-frame ordering flicker when two feet share a y coordinate. Front occluders are explicit display objects with local masks/footprints; they are never inferred from PNG transparency.

## Data boundaries

- Runtime events update runtime facts and bindings.
- Local behavior updates only local activity and targets.
- Movement exposes a read-only movement snapshot.
- Animation consumes state and movement snapshots and reports selected resource/fallback diagnostics.
- HTML controls send explicit user commands; selection and details never rebuild Pixi nodes.

## Failure isolation

Invalid character packs, missing textures, malformed animation metadata, or failed atlas loading affect only the affected character instance. The resolver follows the graded fallback in the asset specification, emits diagnostics, and keeps core rendering and other characters alive. A pack-level rejection never leaves a silent blank character.

## Performance boundary

The expected first version has four resident employees and one collaborator. This is a small Sprite workload; the main risk is texture memory, not draw count. Assets must be normalized and downscaled before atlas construction, and the Playground must record texture dimensions and load failures.

The initial budget is five active characters, up to 12 animation states per character, with a normalized frame target no larger than `512 × 512` source pixels unless a measured pack requires more. A pack should keep its resident atlas under 16 MiB decoded RGBA where practical; optional states may be loaded on demand and unloaded after an idle grace period. The Playground records decoded dimensions, atlas count, load time, and estimated bytes (`width × height × 4`) so a real device can reject regressions. Draw count is expected to remain well below the budget; texture memory and WebContentsView lifecycle are the gating risks.

## Persistence boundary

The main process is the single writer for `office-state.v1` (atomic temp-file write followed by rename). The persisted shape contains `schemaVersion`, settings (`sleepAfterMs`, `resultPresentationMs`, `sceneMinDimensionPerSecond`, `userFrameDurationOverrideMs`, `reducedMotion`), Employee Profiles, recent tasks/activity log with bounded retention (maximum 50 tasks per employee and 200 activity entries), and recoverable binding snapshots `{ sessionId, employeeId, sessionEpoch, bindingSource, boundAt, taskSummary }`. `sceneMinDimensionPerSecond` is the movement ratio defined by the movement specification. `userFrameDurationOverrideMs`, when non-null, overrides a character animation default for all frames; per-frame durations in the pack are used only when no user override exists. Current path, animation frame, chat lock, reservation, and in-flight transition are never persisted. On startup, snapshots from an old or unknown `sessionEpoch` are displayed as stale history and cannot restore `running`; a fresh sync must rebind them. Migration is versioned, and a failed atomic write falls back to the last valid file plus a diagnostic rather than blocking office startup. Multiple office windows consume the main-process snapshot through IPC and do not maintain competing stores.

## Testing boundary

Unit-test state and movement as pure logic. Use the Playground for visual checks and screenshots. Use event replay for Runtime ordering, duplicate, restart, and recovery cases. Use window resize and reduced-motion checks before Office MVP integration.
