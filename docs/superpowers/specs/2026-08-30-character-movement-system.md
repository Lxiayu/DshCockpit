# DshCockpit Character Movement System

## Status

Draft for review.

## Coordinate model

Movement uses a normalized logical office plane. Positions, target points, footprints, and chat distances are stored as ratios of the scene dimensions. For a scene of `widthPx × heightPx`, a logical delta `(dx, dy)` has screen distance `hypot(dx * widthPx, dy * heightPx)`. This keeps diagonal movement honest on non-square windows.

The speed setting is `sceneMinDimensionPerSecond`, a ratio of `min(widthPx, heightPx)` per second (initial default `0.12`). The controller converts it to pixels per second on each tick, advances by `speedPxPerSecond * deltaSeconds`, and derives segment progress from the remaining screen distance. Resize preserves the logical position and target; it recomputes screen distance and speed from the new dimensions rather than preserving a stale pixel duration. Tests must cover horizontal, vertical, diagonal, and resize cases.

All spacing geometry uses the same minimum-dimension metric. A circular logical radius `r` is rendered as `r * min(widthPx, heightPx)` pixels in both axes; an optional rectangular footprint uses `{ widthRatio, heightRatio }` and maps independently to width/height. `safeRadius`, chat separation, and circular footprint checks therefore remain comparable to movement speed on wide or tall windows.

## Waypoint Graph

The first version uses a small explicit graph rather than physics or A*.

```text
desk-1 ... desk-6
roam-1 ... roam-n
chat-a / chat-b
sleep-1 ... sleep-4
```

Each node has:

```text
id
position: { x, y }
tags
capacity
safeRadius
```

The serializable fixture format is:

```json
{
  "version": 1,
  "nodes": [
    { "id": "desk-1", "position": { "x": 0.42, "y": 0.58 }, "tags": ["desk", "sleeping"], "capacity": 1, "safeRadius": 0.05 }
  ],
  "edges": [
    { "from": "roam-1", "to": "desk-1", "behaviors": ["task", "sleeping"], "bidirectional": true }
  ]
}
```

Edges are bidirectional only when `bidirectional=true`; otherwise they are directed. `position`, `safeRadius`, and footprint values are ratios, not pixels. A route request is `findRoute({ fromNodeId, toNodeId, behavior, reservations })` and returns an ordered node ID list or `{ code: "UNREACHABLE" }`. The first version uses deterministic breadth-first search with edge order from the fixture; the graph can later swap in a weighted search without changing this API. It never falls back to teleportation.

## Target selection

The Behavior Scheduler chooses a semantic target at decision points. Movement Controller receives a target and computes a route through allowed edges. If a target is unavailable, the scheduler selects another candidate with the same tag or enters a short wait; it never teleports.

## Movement progression

- Logical position advances by elapsed time and normalized speed.
- Initial movement speed is a configurable scene-proportion value, separate from animation frame duration.
- A path segment stores start, end, progress, direction, and remaining distance.
- On resize, remaining distance and transition duration are recalculated from the same logical position; the character does not snap to a new coordinate.
- Arriving at a target completes movement before the activity animation changes.

## Direction

Direction is derived from the dominant axis of the current path segment and mapped to `walk-up`, `walk-down`, `walk-left`, or `walk-right`. Direction changes use the existing node and animation controller; they never destroy and recreate the character.

## Reservations and occupancy

Targets and narrow paths can be temporarily reserved. A reservation includes the employee ID, purpose, acquiredAt, and expiresAt (monotonic simulation time). A controller reserves the next node/edge before entering it, renews reservations at half-life, and releases them on arrival, cancellation, completion, interruption, or pause timeout. Expired reservations are ignored during route checks. Chat nodes reserve a pair atomically; if either reservation fails, the pair is cancelled and the scheduler chooses another partner or returns both employees to separate roaming decisions. Crossing path segments are treated as conflicting when their safety radii overlap; the later reservation waits or reroutes.

## Footprints and hit areas

Collision and spacing use a small logical footprint near the foot anchor, not the full transparent image. Hit areas may be larger for pointer interaction. Footprints are part of object metadata and remain independent from texture bounds.

## Local behavior scheduler

At decision points (arrival, rest end, chat end, task release, sleep end, resume), an idle employee chooses among:

```text
roaming  60%
resting  25%
chatting 15%
```

Stable per-employee seeds, minimum dwell times, cooldowns, target capacity, and one-chat-pair limits prevent synchronized or jittery behavior. Five minutes without a task permits sleeping, which defaults to the personal desk.

## Chat movement

The scheduler chooses a nearby eligible partner who is not cooling down or reserved. The pair moves to `chat-a/chat-b`, maintains a fixed separation and facing direction, then returns to separate decision points. `sync=stale` or `sync=resyncing` alone does not end chat; only an accepted Runtime task event or explicit user command does. A task or explicit command releases both reservations immediately.

## Resize and pause

The simulation clock pauses while the office is hidden or backgrounded. Resume continues from the current logical position and does not replay elapsed time. Resize updates screen coordinates and transition durations without changing anchors or logical targets.
