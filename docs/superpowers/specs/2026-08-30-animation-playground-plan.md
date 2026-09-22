# DshCockpit Animation Playground Plan

## Status

Draft for review.

## Purpose

The Playground is a small, isolated PixiJS scene used to validate assets, anchors, movement, transitions, and runtime diagnostics before any full Virtual Office integration. It is a validation tool, not a second office implementation.

## Scope

```text
one character
pure background
four-direction walk
idle / working / thinking / sleeping
completed / failed
click-to-target movement
speed and frame-duration controls
resize and pause simulation
```

It uses a fixture Character Pack and synthetic state events. It does not connect to Harness, create real Session bindings, or persist office history.

The default fixture includes a small Waypoint Graph with desk, roam, chat, and sleep nodes. Clicking the stage projects the pointer to the nearest reachable waypoint for the selected behavior, so the Playground exercises the same route contract as Office Runtime. A clearly labeled `direct-target` debug mode may send an arbitrary point for anchor inspection; it is not part of the formal movement gate.

## Controls

- Select animation/state.
- Select direction or click a target point.
- Adjust normalized movement speed.
- Adjust frame duration, default `1000 ms`.
- Toggle loop, pause, resume, reduced-motion, and debug overlays.
- Show foot anchor, visible bounds, logical footprint, target route, current frame, and fallback reason.
- Show deterministic clock time, logical position, screen position, reservation owner, and resource memory estimate.

## Test stages

### Stage 1: Asset geometry

- All frames share canvas and visible-height policy.
- Foot contact points meet the `±1px` source threshold.
- Anchor overlay remains fixed while frames change.
- No frame is cropped or unexpectedly padded.

### Stage 2: Walk cycle

- Up, down, left, and right map to the intended sequences.
- Frame order loops without a visible jump.
- Left/right movement keeps a horizontal foot baseline.
- Movement speed changes distance per second but not frame timing.
- Adding or removing frames does not change path speed.

Automated checks use a fake ticker clock. Frame boundaries must occur within `±16 ms` of declared durations; foot baseline drift must be at most `1 CSS px` at the reference viewport; and a one-second movement sample must be within `±5%` of configured speed.

### Stage 3: Transitions

- Idle → stop/turn → walk is continuous.
- Walk → arrive → work/sleep is continuous.
- Work → result presentation → stand → walk is continuous.
- Higher-priority task events can interrupt local transitions without node recreation.

### Stage 4: Projection and resize

- Logical position remains stable during resize.
- Visible character height follows the 11% policy and 64/180px clamps.
- Anchor remains at the same logical ground point.
- Pause/resume does not replay elapsed time or cause a snap.
- After resize, logical position error is at most `0.005` normalized units and arrival error is at most `0.01` normalized units.

### Stage 5: Faults and fallback

- Missing dedicated state uses the declared fallback chain.
- Invalid manifest or missing texture produces diagnostics and a safe fallback.
- Duplicate and stale synthetic events do not replay transitions.
- Reduced-motion keeps logical state and targets progressing but renders the current state at a single representative frame and applies target positions immediately (no interpolation). State text, task/result details, and diagnostics remain visible; resume does not replay elapsed time or cause a snap.

The visual checks retain human review for contact/passing readability and transition naturalness. Objective failures must be reported separately from subjective review rather than hidden in a pass summary. The baseline runtime target is at least 30 rendered FPS on the supported development machine with five active characters; a lower result is a performance failure requiring asset or ticker investigation.

## Evidence

Each Playground run should produce:

- deterministic fixture and configuration
- screenshot at initial, moving, arriving, and result states
- optional frame/anchor overlay screenshot
- event replay log
- asset resolver diagnostics
- pass/fail summary

## Gate to Character Runtime

The Playground gate passes only when all Stage 1–5 checks pass for the fixture pack and at least one intentionally incomplete pack. A visual defect must be fixed in asset normalization, animation metadata, movement, or transition logic at the responsible layer; it must not be hidden by a one-off CSS offset.

## Gate to Office MVP

After Playground passes, Character Runtime must pass multi-agent tests for four residents plus one collaborator, local behavior scheduling, chat reservation, task queueing, Runtime event ordering, role/pack fallback, and HTML details interaction. Only then may it be embedded in the six-desk Office MVP.
