# DshCockpit Character Asset Specification

## Status

Draft for review.

## Character Pack and Employee Profile

Character assets and employee identity are separate:

```text
Character Pack
  → assets, animation capabilities, anchors, default personality, license

Employee Profile
  → employeeId, displayName, role, characterId/variant, seat, allowed overrides
```

One Character Pack can serve multiple employees. Changing a pack does not change Runtime identity, tasks, or history.

## Pack layout

```text
character-pack/
├── manifest.json
├── assets/
│   ├── atlas/
│   ├── animations/
│   ├── expressions/
│   └── preview.png
├── animation/
│   ├── animations.json
│   └── anchors.json
├── personality/
│   ├── profile.json
│   └── behavior.json
├── LICENSE
└── NOTICE
```

## Manifest responsibilities

`manifest.json` declares stable ID, name, version, author, license, runtime compatibility, variants, and the entry points for geometry and animation metadata:

```json
{
  "id": "whale-girl",
  "version": "1.0.0",
  "geometry": "animation/anchors.json",
  "animations": "animation/animations.json",
  "fallback": { "allowStaticPose": true, "allowProgrammaticEmphasis": true }
}
```

In v1, `animation/anchors.json` is the sole authority for canvas, anchor, visible bounds, and per-frame overrides; `animation/animations.json` is the sole authority for frame order, timing, loops, and resource IDs. The same fields must not be duplicated inline in `manifest.json`. If a future manifest version permits inline overrides, precedence must be explicit and versioned; v1 rejects conflicting duplicates. The manifest does not contain Session IDs, current tasks, Token data, or executable behavior.

## Geometry contract

Every state image and walk frame uses one source canvas and source-pixel geometry:

```json
{
  "canvas": { "width": 2508, "height": 2508 },
  "anchor": { "x": 1254, "y": 2350 },
  "visibleBounds": { "x": 620, "y": 180, "width": 1260, "height": 2050 }
}
```

Walk-frame foot contact points must remain within `±1px` in source coordinates. The scene node represents the foot contact point; changing a frame cannot change node position.

Geometry has one canonical coordinate system: the source canvas declared by `anchors.json`. Normalization produces an output canvas with the same aspect ratio and a recorded scale `outputScale = outputCanvas.width / sourceCanvas.width`; it does not silently redefine the anchor. For every frame:

```text
outputAnchor = sourceAnchor × outputScale
runtimeAnchor = outputAnchor × runtimeSpriteScale
```

Atlas frame coordinates are output-canvas coordinates, never source-pixel coordinates. The builder writes `sourceCanvas`, `outputCanvas`, `outputScale`, and per-frame `sourceAnchor/outputAnchor` to `anchors.json` and the validation report. A 2508px source may therefore become a 512px output, with `2350 × (512 / 2508)` used before runtime scaling; integer rounding is applied only at rasterization and the unrounded value remains in metadata.

## Animation metadata

Animations declare ordered frame references, loop behavior, and frame duration. The first version uses four frames per direction where available and a default frame duration of `1000 ms`; frame count is not hard-coded.

```json
{
  "animations": {
    "walk-left": {
      "frames": ["left-01.png", "left-02.png"],
      "frameDurationMs": 1000,
      "loop": true
    }
  }
}
```

Frame entries may later provide individual `durationMs` values. Frame timing is independent from movement speed.

Texture Atlas rules are intentionally conservative in v1: frames must not be trimmed and must not be rotated. Every atlas frame retains the normalized source canvas dimensions, and its JSON frame rectangle maps one-to-one to that canvas. A build may optimize transparent storage only in a later metadata version that includes `sourceSize`, `spriteSourceSize`, `trim`, `rotate`, and the original anchor; the renderer must reconstruct the source canvas before applying the foot anchor. A v1 pack containing trim/rotate flags is rejected rather than rendered with guessed offsets.

## Required and optional capabilities

Priority assets for DeepSeek 娘 are four-direction walk cycles, idle/rest/sleep, working, thinking/waiting, completed, failed/attention, chatting poses, and stand/sit/turn transitions. Runtime supports declared capability fallbacks for incomplete or third-party packs.

Fallback order is: dedicated animation, compatible static pose, compatible directional pose, then small programmatic emphasis. The resolver records the selected resource and fallback reason.

## Normalization pipeline

```text
PNG source
  → transparent bounds
  → uniform canvas
  → automatic foot candidate detection
  → manual manifest override when needed
  → anchor alignment
  → visibleBounds validation
  → atlas or normalized PNG output
  → validation-report.json
```

Automatic detection is advisory; an explicit geometry override is final. The deterministic detector uses `alpha >= 16` for visible bounds, `alpha >= 128` for the main-body mask, ignores connected components smaller than 32 source pixels, and treats pixels with `alpha < 64` in the bottom 8% as shadow candidates unless explicitly included by the pack. It examines the bottom 15% of the visible bounds, chooses up to the two largest main-body components touching that band, and defines the contact point as the midpoint of their lowest-row medians (or the single component median). Hair, skirt hems, and shadows are not contact points unless an override says so. The report records all candidates and the selected rule. If the `±1px` rule cannot be met without cropping visible content, the pack fails validation.

## validation-report.json

The report records character ID, source files, canvas, threshold, detected/override/final anchors, visible bounds, deltas, warnings, failure reasons, and overall result. It is immutable diagnostic output and is not modified by Runtime.

## Rendering and size

Visible height defaults to `11%` of the scene height, clamped to `64px` minimum and `180px` maximum. All states share the same visible-height calculation. Source images must be normalized/downscaled before atlas loading; 2508px source files are not assumed to be GPU runtime size.

Fallback is graded: (1) reject activation for invalid manifest, unsafe path, license omission, incompatible version, or failed geometry; (2) for an active pack with a missing optional state, use the declared animation fallback chain; (3) if the selected pack cannot load at all, use the built-in `deepseek-default` pack from the Core resources directory at its pinned package version; (4) if that pack also fails, render a small internal diagnostic placeholder sprite while preserving state text and error details. A blank scene is never used as a silent fallback. Pack-level failures disable the pack for all instances and emit stable codes such as `PACK_MANIFEST_INVALID`, `PACK_GEOMETRY_INVALID`, `PACK_ASSET_MISSING`, and `PACK_LOAD_FAILED`; optional-state fallback uses `ANIMATION_CAPABILITY_MISSING` and does not disable the pack.

## Licensing and safety

Every pack requires author and license metadata and its own LICENSE/NOTICE where applicable. Packs contain declarative JSON and raster/vector assets only; no JavaScript execution. Invalid paths, missing files, incompatible versions, or license omissions reject activation and fall back without crashing the office.
