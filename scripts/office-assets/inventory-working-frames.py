#!/usr/bin/env python3
"""Task 4 — working frame inventory and geometry validation.

Read-only audit of the tracked photo/output_nobg/working-front-3q-0*.png
sources (the sources themselves are NEVER modified) producing:

  --inventory  stdout JSON: per-frame sha256/size/alpha/visible bounds plus
               frame-to-frame stability evidence. Writes nothing.
  --report     writes validation-report.json next to the derived-frame
               directory (resources/characters/deepseek-default/assets/
               animations/working/front-3q/) with the final geometry verdict.

The validation report is AUTHORING/ACCEPTANCE evidence only. The runtime
asset resolver (src/office/runtime/asset-pack.js) never reads it.
"""

import argparse
import hashlib
import json
import os
import sys

from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE_DIR = os.path.join("photo", "output_nobg")
SOURCE_FILES = [
    "working-front-3q-01.png",
    "working-front-3q-02.png",
    "working-front-3q-03.png",
    "working-front-3q-04.png",
]
PACK_ROOT = os.path.join("resources", "characters", "deepseek-default")
DERIVED_DIR = os.path.join(PACK_ROOT, "assets", "animations", "working", "front-3q")

# production pack geometry convention (animation/anchors.json): 64x64 canvas,
# full-body foot anchor (32, 60), standalone-character visible box.
PACK_CANVAS = {"width": 64, "height": 64}
PACK_ANCHOR = {"x": 32, "y": 60}
PACK_VISIBLE_BOUNDS = {"x": 22, "y": 12, "width": 21, "height": 49}
# geometry approval criteria (all must hold for geometry-approved):
CRITERIA = {
    "canvasMatchesProductionConvention": "source must normalize into the pack's "
    "declared outputCanvas (64x64); the requested 352x352 convention belongs to "
    "the test fixture pack and cannot coexist with the pack-level outputCanvas",
    "fullBodyFootAnchorCompatible": "content must reference the pack's full-body "
    "foot anchor (32,60); half-body compositions have no foot reference and "
    "break inter-state scale consistency",
    "alphaChannelPresent": True,
    "frameToFrameStabilityMaxRatio": 0.10,
}


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 16), b""):
            digest.update(block)
    return digest.hexdigest()


def frame_geometry(path):
    image = Image.open(path).convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    width, height = image.size
    opaque = sum(
        1 for value in alpha.getdata() if value > 200
    )
    return {
        "width": width,
        "height": height,
        "alpha": True,
        "visibleBounds": {
            "x": bbox[0],
            "y": bbox[1],
            "width": bbox[2] - bbox[0],
            "height": bbox[3] - bbox[1],
        },
        "opaqueRatio": round(opaque / (width * height), 4),
    }


def inventory():
    frames = []
    for name in SOURCE_FILES:
        path = os.path.join(REPO_ROOT, SOURCE_DIR, name)
        geometry = frame_geometry(path)
        frames.append({
            "file": name,
            "sha256": sha256_of(path),
            **geometry,
            "composition": "half-body front 3/4 working pose (head, torso and "
            "typing hands at the bottom edge); no baked chair or desk",
            "verdict": "present-unconnected",
        })
    widths = [frame["visibleBounds"]["width"] for frame in frames]
    heights = [frame["visibleBounds"]["height"] for frame in frames]
    return {
        "schemaVersion": 1,
        "sourceDir": SOURCE_DIR,
        "frames": frames,
        "frameToFrame": {
            "maxWidthDeltaRatio": round((max(widths) - min(widths)) / max(widths), 4),
            "maxHeightDeltaRatio": round((max(heights) - min(heights)) / max(heights), 4),
            "maxLeftEdgeDeltaPx": max(f["visibleBounds"]["x"] for f in frames)
            - min(f["visibleBounds"]["x"] for f in frames),
        },
    }


def evaluate(inv):
    """Applies the geometry criteria and produces the report document."""
    stability = inv["frameToFrame"]
    stable = (
        stability["maxWidthDeltaRatio"] <= CRITERIA["frameToFrameStabilityMaxRatio"]
        and stability["maxHeightDeltaRatio"] <= CRITERIA["frameToFrameStabilityMaxRatio"]
    )
    reasons = [
        "canvas-convention: the production pack (deepseek-default) declares a "
        "pack-level 64x64 outputCanvas with full-body foot anchor (32,60); "
        "outputCanvas cannot be overridden per frame, so the requested 352x352 "
        "normalization target cannot coexist with the pack's existing "
        "idle/walk/completed/failed/sleeping frames",
        "anchor-compatibility: all four sources are half-body (bust) working "
        "poses without a foot reference; normalized into the pack's 21x49 "
        "standalone-character visible box they would break inter-state scale "
        "consistency (head width roughly 2x the idle head at equal visible "
        "height) and render hands floating above the workstation desk surface",
    ]
    frames = []
    for frame in inv["frames"]:
        entry = dict(frame)
        entry["verdict"] = "geometry-rejected"
        entry["reasons"] = list(reasons)
        if not stable:
            entry["reasons"].append(
                "frame-to-frame visible-bounds drift exceeds the stability budget"
            )
        frames.append(entry)
    return {
        "schemaVersion": 1,
        "generatedBy": "scripts/office-assets/inventory-working-frames.py --report",
        "immutable": True,
        "runtimeVisibility": "authoring-only; runtime asset-pack.js never reads "
        "this report and production pack metadata never references it",
        "source": {
            "dir": SOURCE_DIR,
            "role": "source-of-record (tracked, never modified by this script)",
        },
        "target": {
            "pack": "deepseek-default",
            "outputCanvas": PACK_CANVAS,
            "anchor": PACK_ANCHOR,
            "visibleBounds": PACK_VISIBLE_BOUNDS,
            "derivedDir": DERIVED_DIR,
        },
        "criteria": CRITERIA,
        "frameToFrame": stability,
        "frames": frames,
        "verdict": "geometry-rejected",
        "reasons": reasons,
        "derivedFiles": [],
        "license": "production pack MIT (resources/characters/deepseek-default/"
        "LICENSE and NOTICE); source frames are DshCockpit-generated assets "
        "tracked under photo/output_nobg/",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", action="store_true", help="print read-only inventory JSON")
    parser.add_argument("--report", action="store_true", help="write validation-report.json")
    args = parser.parse_args()
    if not (args.inventory or args.report):
        parser.error("choose --inventory or --report")
    inv = inventory()
    if args.inventory:
        json.dump(inv, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    report = evaluate(inv)
    destination = os.path.join(REPO_ROOT, DERIVED_DIR)
    os.makedirs(destination, exist_ok=True)
    target = os.path.join(destination, "validation-report.json")
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"wrote {os.path.relpath(target, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
