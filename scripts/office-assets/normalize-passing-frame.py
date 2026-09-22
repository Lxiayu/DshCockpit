#!/usr/bin/env python3
# scripts/office-assets/normalize-passing-frame.py — Task E5a.
#
# Normalizes ONE passing walk frame (e.g. photo/output_nobg/walk-left-passing-01.png)
# into the production character pack's geometry, reusing the SPEC-02 pipeline's
# detector (normalize-character.detect_geometry) so thresholds and the foot
# contact rule stay identical. Deterministic only: uniform LANCZOS scale +
# integer translation — no cropping, no rotation, no retouching. The source
# file is opened read-only.
#
# Target geometry is DERIVED FROM THE PACK METADATA (never hardcoded): the
# output visible height must match the median visibleBounds.height of the
# same-direction walk frames already in anchors.json (task tolerance ±2px),
# and the foot contact must land on the pack anchor (178,296) within the
# pipeline's ±1px tolerance.
#
# The script inserts the frame at position 3 of walk-<direction> in
# animations.json (durationMs null → inherits defaultFrameDurationMs=1000, so
# the walk rhythm is unchanged) and records the frame's anchors.json entry.
# Re-running is idempotent for the metadata (the existing passing entry is
# replaced in place); the PNG is rewritten from the read-only source.
#
# Usage:
#   python3 scripts/office-assets/normalize-passing-frame.py <source.png> \
#       --pack resources/characters/deepseek-default --direction left
#
# Exit codes: 0 = normalized + inserted; 4 = geometry/verification failure
# (nothing is inserted); 3 = usage/tool error.

import argparse
import importlib.util
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("normalize_character", os.path.join(HERE, "normalize-character.py"))
normalize_character = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(normalize_character)

ANCHOR_TOLERANCE_PX = normalize_character.TOLERANCE_PX  # ±1px, same as the pipeline
HEIGHT_TOLERANCE_PX = 2                                  # same-direction visible-height match
INSERT_INDEX = 2                                         # between 02 and 03


def fail(message):
    print(json.dumps({"result": "invalid", "reason": message}, ensure_ascii=False))
    return 4


def reorder_for_pack(value, path=""):
    """Recursive key-sort EXCEPT the anchors top-level frames map, whose
    insertion order is the animations.json metadata order (E5a-R1)."""
    if isinstance(value, dict):
        items = list(value.items()) if path.split(".")[-1] == "frames" else sorted(value.items())
        return {key: reorder_for_pack(child, f"{path}.{key}") for key, child in items}
    if isinstance(value, list):
        return [reorder_for_pack(child, f"{path}[]") for child in value]
    return value


def main(argv):
    parser = argparse.ArgumentParser(description="Normalize one passing walk frame into the pack (E5a).")
    parser.add_argument("source", help="read-only source PNG (photo/ tree)")
    parser.add_argument("--pack", required=True, help="production pack directory")
    parser.add_argument("--direction", required=True, choices=["left", "right"])
    parser.add_argument("--dry-run", action="store_true", help="verify geometry only, write nothing")
    args = parser.parse_args(argv)

    pack = args.pack
    anchors_path = os.path.join(pack, "animation", "anchors.json")
    animations_path = os.path.join(pack, "animation", "animations.json")
    try:
        with open(anchors_path, "r", encoding="utf-8") as handle:
            anchors = json.load(handle)
        with open(animations_path, "r", encoding="utf-8") as handle:
            animations = json.load(handle)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"result": "tool-error", "reason": f"cannot read pack metadata: {error}"}))
        return 3

    animation_id = f"walk-{args.direction}"
    animation = animations.get("animations", {}).get(animation_id)
    if not animation:
        print(json.dumps({"result": "tool-error", "reason": f"{animation_id} missing from animations.json"}))
        return 3
    prefix = f"assets/animations/walk/{args.direction}/"
    existing_heights = []
    for frame in animation["frames"]:
        declared = anchors.get("frames", {}).get(frame["file"])
        if declared and declared.get("visibleBounds"):
            existing_heights.append(declared["visibleBounds"]["height"])
    if not existing_heights:
        return fail("no same-direction frames with declared visibleBounds in anchors.json")
    existing_heights.sort()
    target_height = existing_heights[len(existing_heights) // 2]  # deterministic median

    output_name = f"walk-{args.direction}-passing-01.png"
    output_rel = f"{prefix}{output_name}"
    pack_anchor = anchors["anchor"]
    output_canvas = anchors["outputCanvas"]

    # ---- geometry detection on the read-only source -------------------------
    try:
        image = Image.open(args.source).convert("RGBA")
    except Exception as error:  # noqa: BLE001
        return fail(f"cannot decode source PNG: {error}")
    detection = normalize_character.detect_geometry(image)
    if detection.get("status") != "ok":
        return fail(f"source geometry detection failed: {detection.get('reason')}")
    source_bounds = detection["visibleBounds"]
    source_anchor = detection["anchor"]

    scale = target_height / source_bounds["height"]
    scaled_w = max(1, round(image.width * scale))
    scaled_h = max(1, round(image.height * scale))
    if scaled_w > output_canvas["width"] or scaled_h > output_canvas["height"]:
        return fail(
            f"scaled source {scaled_w}x{scaled_h} does not fit the {output_canvas['width']}x{output_canvas['height']} "
            f"output canvas at the target visible height {target_height}px"
        )
    scaled = image.resize((scaled_w, scaled_h), Image.LANCZOS)
    scaled_detection = normalize_character.detect_geometry(scaled)
    if scaled_detection.get("status") != "ok":
        return fail("scaled geometry detection failed")

    paste_x = round(pack_anchor["x"] - scaled_detection["anchor"]["x"])
    paste_y = round(pack_anchor["y"] - scaled_detection["anchor"]["y"])
    if (
        paste_x < 0
        or paste_y < 0
        or paste_x + scaled_w > output_canvas["width"]
        or paste_y + scaled_h > output_canvas["height"]
    ):
        return fail(
            f"alignment translation ({paste_x},{paste_y}) would push the frame out of the "
            f"{output_canvas['width']}x{output_canvas['height']} canvas"
        )
    canvas = Image.new("RGBA", (output_canvas["width"], output_canvas["height"]), (0, 0, 0, 0))
    canvas.paste(scaled, (paste_x, paste_y))

    verify = normalize_character.detect_geometry(canvas)
    if verify.get("status") != "ok":
        return fail("output geometry verification failed")
    anchor_delta = max(abs(verify["anchor"]["x"] - pack_anchor["x"]), abs(verify["anchor"]["y"] - pack_anchor["y"]))
    height_delta = abs(verify["visibleBounds"]["height"] - target_height)
    if anchor_delta > ANCHOR_TOLERANCE_PX:
        return fail(f"post-alignment foot anchor drift {anchor_delta}px exceeds ±{ANCHOR_TOLERANCE_PX}px")
    if height_delta > HEIGHT_TOLERANCE_PX:
        return fail(
            f"visible height {verify['visibleBounds']['height']}px deviates from the same-direction "
            f"target {target_height}px by {height_delta}px (tolerance ±{HEIGHT_TOLERANCE_PX}px)"
        )

    summary = {
        "result": "ok",
        "dryRun": bool(args.dry_run),
        "source": args.source,
        "sourceSize": list(image.size),
        "sourceVisibleBounds": source_bounds,
        "sourceAnchor": source_anchor,
        "targetVisibleHeight": target_height,
        "sameDirectionVisibleHeights": existing_heights,
        "scale": scale,
        "scaledSize": [scaled_w, scaled_h],
        "pasteOffset": [paste_x, paste_y],
        "outputFile": output_rel,
        "outputAnchor": {"x": verify["anchor"]["x"], "y": verify["anchor"]["y"]},
        "outputVisibleBounds": verify["visibleBounds"],
        "anchorDeltaPx": anchor_delta,
        "heightDeltaPx": height_delta,
        "contactRule": detection["contactRule"],
        "selectedRule": detection["selectedRule"],
        "insertIndex": INSERT_INDEX,
        "aspectNote": {
            "existingVisibleWidth": None,
            "passingVisibleWidth": verify["visibleBounds"]["width"],
        },
    }
    # record the same-direction width context for the report
    widths = []
    for frame in animation["frames"]:
        declared = anchors.get("frames", {}).get(frame["file"])
        if declared and declared.get("visibleBounds"):
            widths.append(declared["visibleBounds"]["width"])
    widths.sort()
    summary["aspectNote"]["existingVisibleWidth"] = widths[len(widths) // 2] if widths else None

    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False))
        return 0

    abs_out = os.path.join(pack, output_rel)
    os.makedirs(os.path.dirname(abs_out), exist_ok=True)
    canvas.save(abs_out, format="PNG")

    # ---- metadata insertion (deterministic, idempotent) ---------------------
    animation["frames"] = [
        frame for frame in animation["frames"] if os.path.basename(frame["file"]) != output_name
    ]
    animation["frames"].insert(
        INSERT_INDEX,
        {
            "file": output_rel,
            "durationMs": None,
            "anchor": None,
            "visibleBounds": {
                "x": verify["visibleBounds"]["x"],
                "y": verify["visibleBounds"]["y"],
                "width": verify["visibleBounds"]["width"],
                "height": verify["visibleBounds"]["height"],
            },
        },
    )
    anchors.setdefault("frames", {})[output_rel] = {
        "sourceAnchor": source_anchor,
        "outputAnchor": {"x": verify["anchor"]["x"], "y": verify["anchor"]["y"]},
        "visibleBounds": {
            "x": verify["visibleBounds"]["x"],
            "y": verify["visibleBounds"]["y"],
            "width": verify["visibleBounds"]["width"],
            "height": verify["visibleBounds"]["height"],
        },
        "sourceCanvas": {"width": image.width, "height": image.height},
        "sourceScale": scale,
        "detection": {
            "selectedRule": detection["selectedRule"],
            "contactRule": detection["contactRule"],
            "candidates": detection["bandContacts"],
            "translation": {"dx": paste_x, "dy": paste_y},
            "anchorDeltaPx": anchor_delta,
            "verifiedDeltaPx": anchor_delta,
            "normalizedScale": scale,
            "note": "E5a passing frame: uniform LANCZOS scale + integer translation over the read-only source",
        },
    }
    # E5a-R1: rebuild the anchors frames map in the animations.json METADATA
    # order for this direction (01, 02, passing, 03, 04); every other frame
    # keeps its existing relative order after the direction's block.
    reordered = {}
    for frame in animation["frames"]:
        reordered[frame["file"]] = anchors["frames"][frame["file"]]
    for rel, entry in anchors["frames"].items():
        if rel not in reordered:
            reordered[rel] = entry
    anchors["frames"] = reordered

    for path, doc in ((anchors_path, anchors), (animations_path, animations)):
        with open(path, "w", encoding="utf-8") as handle:
            # Task E5a-R1: the anchors frames map is emitted in the animations.json
            # METADATA order (01, 02, passing, 03, 04) — a sorted-key dump would
            # append "passing" after "04" (lexicographic) and make any key-order
            # enumeration play the frame last. Every other level stays
            # alphabetically sorted to keep the file diff minimal.
            handle.write(json.dumps(reorder_for_pack(doc), ensure_ascii=False, indent=2))
            handle.write("\n")

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
