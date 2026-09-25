#!/usr/bin/env python3
# scripts/office-assets/normalize-character.py — Task 2 / SPEC-02.
#
# Normalizes a source character pack (e.g. resources/characters/whale-girl)
# into a deterministic normalized pack: one shared output canvas, one shared
# foot anchor, per-frame translation alignment (never cropping visible
# content, never trimming/rotating), declarative anchors.json (sole geometry
# authority) and animations.json (sole frame order/timing authority), plus an
# immutable validation-report.json naming any frames that require art rework.
#
# Usage:
#   python3 scripts/office-assets/normalize-character.py <source-pack> --out <out-pack>
#
# Exit codes: 0 = passed, 4 = invalid (report names the frames), 3 = tool error.

import argparse
import json
import math
import os
import sys
from collections import deque

from PIL import Image

ALPHA_BOUNDS = 16          # visible-pixel threshold (advisory when a wash saturates it)
ALPHA_BODY = 128           # main-body mask threshold
MIN_COMPONENT_PX = 32      # ignore smaller connected components
BAND_RATIO = 0.15          # examine the bottom 15% of visible bounds
MAX_CONTACT_COMPONENTS = 2 # largest main-body components touching the band
TOLERANCE_PX = 1           # walk-frame foot-anchor tolerance
PAD_MULTIPLE = 16          # output canvas padding granularity
SCHEMA_VERSION = 1
DEFAULT_FRAME_DURATION_MS = 1000
REQUIRED_STATES = ("idle",)
REQUIRED_WALK_DIRECTIONS = ("left", "right", "up", "down")
OPTIONAL_STATES = (
    "working", "finished", "warning", "error", "offline", "sleeping",
    "completed", "failed", "attention", "thinking", "waiting",
    "celebrating", "chatting", "side",
)
ALLOWED_SOURCE_EXTENSIONS = (".png",)


class ToolError(Exception):
    pass


def median(sorted_values):
    """Deterministic median: upper element for even-length lists."""
    if not sorted_values:
        raise ToolError("median of empty list")
    return sorted_values[len(sorted_values) // 2]


def detect_geometry(image):
    """Returns a dict with bounds/anchors for one RGBA frame.

    selected rule: alpha16 bounds, unless they saturate the whole canvas while
    a strictly smaller alpha128 main-body exists (background wash) — then the
    main-body bounds become the visible bounds and the deviation is recorded.
    """
    width, height = image.size
    pixels = image.load()

    min_x, min_y, max_x, max_y = width, height, -1, -1
    body = [[False] * width for _ in range(height)]
    for y in range(height):
        row = body[y]
        for x in range(width):
            alpha = pixels[x, y][3]
            if alpha >= ALPHA_BOUNDS:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
                if alpha >= ALPHA_BODY:
                    row[x] = True

    if max_x < 0:
        return {"status": "invalid", "reason": "frame has no visible pixels"}

    alpha16_saturated = min_x == 0 and min_y == 0 and max_x == width - 1 and max_y == height - 1

    # connected components on the main-body mask
    seen = [[False] * width for _ in range(height)]
    components = []
    for y in range(height):
        for x in range(width):
            if body[y][x] and not seen[y][x]:
                queue = deque([(x, y)])
                seen[y][x] = True
                pts = []
                while queue:
                    cx, cy = queue.popleft()
                    pts.append((cx, cy))
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < width and 0 <= ny < height and body[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            queue.append((nx, ny))
                if len(pts) >= MIN_COMPONENT_PX:
                    components.append(pts)

    if not components:
        return {"status": "invalid", "reason": "no main-body pixels above the alpha threshold"}

    body_min_x = min(p[0] for c in components for p in c)
    body_max_x = max(p[0] for c in components for p in c)
    body_min_y = min(p[1] for c in components for p in c)
    body_max_y = max(p[1] for c in components for p in c)

    use_body_bounds = alpha16_saturated and (
        body_min_x > min_x or body_min_y > min_y or body_max_x < max_x or body_max_y < max_y
    )
    if use_body_bounds:
        vis_x0, vis_y0, vis_x1, vis_y1 = body_min_x, body_min_y, body_max_x, body_max_y
        selected_rule = "alpha128-body-bounds"
    else:
        vis_x0, vis_y0, vis_x1, vis_y1 = min_x, min_y, max_x, max_y
        selected_rule = "alpha16-bounds"

    band_top = vis_y0 + int((vis_y1 - vis_y0) * (1.0 - BAND_RATIO))
    touching = []
    for component in components:
        lowest_row = max(p[1] for p in component)
        if lowest_row >= band_top:
            touching.append(component)
    touching.sort(key=len, reverse=True)
    chosen = touching[:MAX_CONTACT_COMPONENTS]

    band_contacts = []
    for component in chosen:
        lowest_row = max(p[1] for p in component)
        row_xs = sorted(p[0] for p in component if p[1] == lowest_row)
        band_contacts.append(
            {
                "medianX": row_xs[len(row_xs) // 2],
                "lowestRowY": lowest_row,
                "componentSize": len(component),
            }
        )

    if len(band_contacts) >= 2:
        contact_x = int(math.floor((band_contacts[0]["medianX"] + band_contacts[1]["medianX"]) / 2))
        contact_y = int(math.floor((band_contacts[0]["lowestRowY"] + band_contacts[1]["lowestRowY"]) / 2))
        contact_rule = "midpoint-of-two-lowest-row-medians"
    else:
        contact_x = band_contacts[0]["medianX"]
        contact_y = band_contacts[0]["lowestRowY"]
        contact_rule = "single-lowest-row-median"

    return {
        "status": "ok",
        "selectedRule": selected_rule,
        "alpha16Bounds": {"x": min_x, "y": min_y, "width": max_x - min_x + 1, "height": max_y - min_y + 1},
        "visibleBounds": {"x": vis_x0, "y": vis_y0, "width": vis_x1 - vis_x0 + 1, "height": vis_y1 - vis_y0 + 1},
        "anchor": {"x": contact_x, "y": contact_y},
        "contactRule": contact_rule,
        "bandContacts": band_contacts,
        "componentCount": len(components),
        "warnings": (
            [
                "background-wash-present: alpha16 bounds saturate the canvas; "
                "visible bounds derived from the alpha>=128 main-body mask. "
                "Art rework recommended (remove the semi-opaque background layer)."
            ]
            if use_body_bounds
            else []
        ),
    }


def load_source_manifest(source_pack):
    path = os.path.join(source_pack, "manifest.json")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_source_frames(source_pack, manifest):
    """Collects manifest-referenced PNG frames grouped into normalized entries."""
    entries = []  # {state, direction, animation, source_rel}

    for direction in ("down", "up", "left", "right"):
        for rel in (manifest.get("walkAnimations") or {}).get(direction) or []:
            entries.append({"state": "walk", "direction": direction, "animation": f"walk-{direction}", "source_rel": rel})

    for key, rel in (manifest.get("sideFrames") or {}).items():
        entries.append({"state": "side", "direction": "none", "animation": f"side-{key}", "source_rel": rel})

    for state, rel in (manifest.get("expressions") or {}).items():
        entries.append({"state": state, "direction": "none", "animation": state, "source_rel": rel})

    for name, rels in (manifest.get("animations") or {}).items():
        if isinstance(rels, str):
            rels = [rels]
        for rel in rels or []:
            if not any(e["source_rel"] == rel for e in entries):
                entries.append({"state": name, "direction": "none", "animation": name, "source_rel": rel})

    # deterministic ordering + dedupe by source file
    seen = {}
    ordered = []
    for entry in sorted(entries, key=lambda e: (e["state"], e["animation"], e["source_rel"])):
        if entry["source_rel"] in seen:
            continue
        seen[entry["source_rel"]] = entry
        ordered.append(entry)

    # un-referenced PNGs become explicit skipped orphans
    assets_dir = os.path.join(source_pack, "assets")
    all_pngs = set()
    for root, _dirs, files in os.walk(assets_dir):
        for name in files:
            if name.lower().endswith(".png"):
                rel = os.path.relpath(os.path.join(root, name), source_pack).replace(os.sep, "/")
                all_pngs.add(rel)
    referenced = {e["source_rel"] for e in ordered}
    orphans = sorted(all_pngs - referenced)
    vectors = sorted(
        rel
        for rel in (os.path.relpath(os.path.join(root, name), source_pack).replace(os.sep, "/")
                    for root, _d, files in os.walk(assets_dir) for name in files)
        if rel.lower().endswith(".svg")
    )
    return ordered, orphans, vectors


def output_rel_for(entry):
    base = os.path.basename(entry["source_rel"])
    if entry["state"] == "walk":
        return f"assets/animations/walk/{entry['direction']}/{base}"
    if entry["state"] == "side":
        return f"assets/animations/side/none/{base}"
    return f"assets/expressions/{entry['animation']}.png"


def normalize(source_pack, out_pack):
    manifest = load_source_manifest(source_pack)
    frames, orphans, vectors = collect_source_frames(source_pack, manifest)

    # pass 1: detect geometry per unique source frame
    detected = {}
    for entry in frames:
        rel = entry["source_rel"]
        if rel in detected:
            continue
        abs_path = os.path.join(source_pack, rel)
        try:
            image = Image.open(abs_path).convert("RGBA")
        except Exception as error:  # noqa: BLE001 - recorded as an invalid frame
            detected[rel] = {"status": "invalid", "reason": f"cannot decode PNG: {error}"}
            continue
        result = detect_geometry(image)
        result["size"] = image.size
        detected[rel] = result

    walk_entries = [e for e in frames if e["state"] == "walk"]
    walk_contacts = [
        (detected[e["source_rel"]]["anchor"]["x"], detected[e["source_rel"]]["anchor"]["y"])
        for e in walk_entries
        if detected[e["source_rel"]].get("status") == "ok"
    ]
    if len(walk_contacts) < 4 * len(REQUIRED_WALK_DIRECTIONS) * 0.5:
        raise ToolError("too few walk frames with detectable foot contacts to define a pack anchor")

    anchor_x = median(sorted(c[0] for c in walk_contacts))
    anchor_y = median(sorted(c[1] for c in walk_contacts))

    # pass 2: translations in shared-source coordinates
    shared_source_w = median(sorted(detected[e["source_rel"]]["size"][0] for e in frames if detected[e["source_rel"]].get("status") == "ok"))
    shared_source_h = median(sorted(detected[e["source_rel"]]["size"][1] for e in frames if detected[e["source_rel"]].get("status") == "ok"))

    max_shift = 0
    for entry in frames:
        info = detected[entry["source_rel"]]
        if info.get("status") != "ok":
            continue
        if info["size"] != (shared_source_w, shared_source_h):
            info["status"] = "invalid"
            info["reason"] = (
                f"source canvas {info['size']} differs from the shared source canvas "
                f"{(shared_source_w, shared_source_h)}; mixed-canvas sources require art rework"
            )
            continue
        dx = anchor_x - info["anchor"]["x"]
        dy = anchor_y - info["anchor"]["y"]
        info["translation"] = {"dx": dx, "dy": dy}
        max_shift = max(max_shift, abs(dx), abs(dy))

    pad = ((max_shift + PAD_MULTIPLE - 1) // PAD_MULTIPLE) * PAD_MULTIPLE if max_shift > 0 else 0
    out_w = shared_source_w + 2 * pad
    out_h = shared_source_h + 2 * pad
    out_anchor = {"x": anchor_x + pad, "y": anchor_y + pad}
    output_scale = out_w / shared_source_w

    # pass 3: rasterize aligned frames and verify
    os.makedirs(out_pack, exist_ok=True)
    report_frames = {}
    output_frames = {}
    failures = []
    warnings = []
    valid_count = 0

    for entry in frames:
        info = detected[entry["source_rel"]]
        rel_out = output_rel_for(entry)
        record = {
            "state": entry["state"],
            "direction": entry["direction"],
            "animation": entry["animation"],
            "sourceFile": entry["source_rel"],
            "outputFile": rel_out,
            "selectedRule": info.get("selectedRule"),
            "alpha16Bounds": info.get("alpha16Bounds"),
            "sourceAnchor": info.get("anchor"),
            "translation": info.get("translation", {"dx": 0, "dy": 0}),
            "candidates": info.get("bandContacts"),
            "contactRule": info.get("contactRule"),
            "warnings": list(info.get("warnings", [])),
        }
        if info.get("status") != "ok":
            record["status"] = "invalid"
            record["reason"] = info.get("reason", "geometry detection failed")
            failures.append({"file": entry["source_rel"], "reason": record["reason"]})
            report_frames[rel_out] = record
            continue

        abs_source = os.path.join(source_pack, entry["source_rel"])
        image = Image.open(abs_source).convert("RGBA")
        dx = info["translation"]["dx"]
        dy = info["translation"]["dy"]
        # pad >= max|shift| guarantees the translated frame fits the output
        # canvas; kept as a hard guard so cropping can never happen silently.
        paste_x = pad + dx
        paste_y = pad + dy
        fits = (
            paste_x >= 0
            and paste_y >= 0
            and paste_x + image.width <= out_w
            and paste_y + image.height <= out_h
        )
        if not fits:
            record["status"] = "invalid"
            record["reason"] = "alignment translation would crop visible content"
            failures.append({"file": entry["source_rel"], "reason": record["reason"]})
            report_frames[rel_out] = record
            continue
        canvas = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
        canvas.paste(image, (paste_x, paste_y))

        abs_out = os.path.join(out_pack, rel_out)
        os.makedirs(os.path.dirname(abs_out), exist_ok=True)
        canvas.save(abs_out, format="PNG")

        # verification: re-detect on the OUTPUT frame; the contact must equal
        # the declared pack anchor exactly (integer translation, no resample).
        verify = detect_geometry(canvas)
        verified_dx = verify["anchor"]["x"] - out_anchor["x"]
        verified_dy = verify["anchor"]["y"] - out_anchor["y"]
        verified_delta = max(abs(verified_dx), abs(verified_dy))
        record["outputAnchor"] = dict(out_anchor)
        record["verifiedDeltaPx"] = verified_delta
        record["visibleBounds"] = {
            "x": verify["visibleBounds"]["x"],
            "y": verify["visibleBounds"]["y"],
            "width": verify["visibleBounds"]["width"],
            "height": verify["visibleBounds"]["height"],
        }
        record["anchorDeltaPx"] = max(
            abs(info["anchor"]["x"] - anchor_x), abs(info["anchor"]["y"] - anchor_y)
        )
        record["originalTranslation"] = {"dx": dx, "dy": dy}

        is_walk = entry["state"] == "walk"
        record["status"] = "passed" if verified_delta <= TOLERANCE_PX else "invalid"
        if record["status"] == "invalid":
            record["reason"] = f"post-alignment foot anchor drift {verified_delta}px exceeds ±{TOLERANCE_PX}px"
            failures.append({"file": entry["source_rel"], "reason": record["reason"]})
        else:
            valid_count += 1
        warnings.extend(f"{entry['source_rel']}: {w}" for w in record["warnings"])
        report_frames[rel_out] = record
        output_frames[rel_out] = record

    # required-state evaluation
    output_states = {r["state"] for r in output_frames.values() if r["status"] == "passed"}
    walk_dirs = {r["direction"] for r in output_frames.values() if r["status"] == "passed" and r["state"] == "walk"}
    capabilities_missing = [s for s in OPTIONAL_STATES if s not in output_states]
    for state in REQUIRED_STATES:
        if state not in output_states:
            failures.append({"file": None, "reason": f"required state missing after normalization: {state}"})
    for direction in REQUIRED_WALK_DIRECTIONS:
        if direction not in walk_dirs:
            failures.append({"file": None, "reason": f"required walk direction missing after normalization: {direction}"})

    result = "passed" if not failures else "invalid"

    # ---- write pack metadata ------------------------------------------------
    animation_entries = {}
    anchors_frames = {}
    for rel_out, record in output_frames.items():
        if record["status"] != "passed":
            continue
        anchors_frames[rel_out] = {
            "sourceAnchor": record["sourceAnchor"],
            "outputAnchor": record["outputAnchor"],
            "visibleBounds": record["visibleBounds"],
            "sourceCanvas": {"width": shared_source_w, "height": shared_source_h},
            "sourceScale": 1,
            "detection": {
                "selectedRule": record["selectedRule"],
                "contactRule": record["contactRule"],
                "candidates": record["candidates"],
                "translation": record["translation"],
                "anchorDeltaPx": record["anchorDeltaPx"],
                "verifiedDeltaPx": record["verifiedDeltaPx"],
            },
        }
        entry_frames = animation_entries.setdefault(
            record["animation"],
            {"state": record["state"], "direction": record["direction"], "loop": record["state"] == "walk", "frames": []},
        )
        entry_frames["frames"].append(
            {"file": rel_out, "durationMs": None, "anchor": None, "visibleBounds": record["visibleBounds"]}
        )

    animations_doc = {
        "schemaVersion": SCHEMA_VERSION,
        "defaultFrameDurationMs": DEFAULT_FRAME_DURATION_MS,
        "animations": dict(sorted(animation_entries.items())),
    }
    anchors_doc = {
        "schemaVersion": SCHEMA_VERSION,
        "sourceCanvas": {"width": shared_source_w, "height": shared_source_h},
        "outputCanvas": {"width": out_w, "height": out_h},
        "outputScale": output_scale,
        "anchor": dict(out_anchor),
        "visibleBounds": {
            "x": min(r["visibleBounds"]["x"] for r in output_frames.values() if r["status"] == "passed"),
            "y": min(r["visibleBounds"]["y"] for r in output_frames.values() if r["status"] == "passed"),
            "width": max(
                r["visibleBounds"]["x"] + r["visibleBounds"]["width"]
                for r in output_frames.values() if r["status"] == "passed"
            )
            - min(r["visibleBounds"]["x"] for r in output_frames.values() if r["status"] == "passed"),
            "height": max(
                r["visibleBounds"]["y"] + r["visibleBounds"]["height"]
                for r in output_frames.values() if r["status"] == "passed"
            )
            - min(r["visibleBounds"]["y"] for r in output_frames.values() if r["status"] == "passed"),
        },
        "frames": anchors_frames,
    }
    manifest_out = {
        "schemaVersion": SCHEMA_VERSION,
        "id": manifest.get("id") or os.path.basename(os.path.normpath(source_pack)),
        "version": str(manifest.get("version") or "1.0.0"),
        "author": str(manifest.get("author") or "unknown"),
        "license": str(manifest.get("license") or "unknown"),
        "runtimeCompatibility": {"schema": SCHEMA_VERSION},
        "geometry": "animation/anchors.json",
        "animations": "animation/animations.json",
        "fallback": {"allowStaticPose": True, "allowProgrammaticEmphasis": True},
    }

    animation_dir = os.path.join(out_pack, "animation")
    os.makedirs(animation_dir, exist_ok=True)
    with open(os.path.join(animation_dir, "anchors.json"), "w", encoding="utf-8") as handle:
        json.dump(anchors_doc, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    with open(os.path.join(animation_dir, "animations.json"), "w", encoding="utf-8") as handle:
        json.dump(animations_doc, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    with open(os.path.join(out_pack, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest_out, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")

    license_src = os.path.join(source_pack, "LICENSE")
    notice_src = os.path.join(source_pack, "NOTICE")
    if os.path.exists(license_src):
        with open(license_src, "r", encoding="utf-8") as src, open(os.path.join(out_pack, "LICENSE"), "w", encoding="utf-8") as dst:
            dst.write(src.read())
    else:
        with open(os.path.join(out_pack, "LICENSE"), "w", encoding="utf-8") as dst:
            dst.write(f"{manifest_out['license']}\nAuthor: {manifest_out['author']}\n")
    if os.path.exists(notice_src):
        with open(notice_src, "r", encoding="utf-8") as src, open(os.path.join(out_pack, "NOTICE"), "w", encoding="utf-8") as dst:
            dst.write(src.read())
    else:
        with open(os.path.join(out_pack, "NOTICE"), "w", encoding="utf-8") as dst:
            dst.write(
                f"Character pack: {manifest_out['id']} (normalized output pack)\n"
                f"Author: {manifest_out['author']}\n"
                f"License: {manifest_out['license']}\n"
                "This pack was produced by scripts/office-assets/normalize-character.py from the\n"
                "source pack named in validation-report.json. PNG frames are geometry-aligned\n"
                "copies (translation only: never cropped, trimmed or rotated). No pixel content\n"
                "was retouched; see validation-report.json for anchors, translations and warnings.\n"
            )

    report = {
        "schemaVersion": SCHEMA_VERSION,
        "characterId": manifest_out["id"],
        "sourcePack": os.path.basename(os.path.normpath(source_pack)),
        "sourceManifestVersion": str(manifest.get("version") or ""),
        "sourceCanvas": {"width": shared_source_w, "height": shared_source_h},
        "outputCanvas": {"width": out_w, "height": out_h},
        "outputScale": output_scale,
        "threshold": {
            "alphaBounds": ALPHA_BOUNDS,
            "alphaBody": ALPHA_BODY,
            "minComponentPx": MIN_COMPONENT_PX,
            "bandRatio": BAND_RATIO,
            "maxContactComponents": MAX_CONTACT_COMPONENTS,
            "tolerancePx": TOLERANCE_PX,
        },
        "packAnchor": {"source": {"x": anchor_x, "y": anchor_y}, "output": dict(out_anchor)},
        "frames": dict(sorted(report_frames.items())),
        "skipped": {
            "orphanSourceFiles": orphans,
            "vectorSourcesNotNormalized": vectors,
        },
        "capabilitiesMissing": capabilities_missing,
        "warnings": sorted(set(warnings)),
        "failures": failures,
        "result": result,
    }
    with open(os.path.join(out_pack, "validation-report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")

    return report


def main(argv):
    parser = argparse.ArgumentParser(description="Normalize a source character pack (SPEC-02).")
    parser.add_argument("source", help="source pack directory (read-only input)")
    parser.add_argument("--out", required=True, help="normalized output pack directory")
    args = parser.parse_args(argv)

    if not os.path.isdir(args.source):
        print(json.dumps({"result": "tool-error", "reason": f"source pack not found: {args.source}"}))
        return 3
    try:
        report = normalize(args.source, args.out)
    except ToolError as error:
        print(json.dumps({"result": "tool-error", "reason": str(error)}))
        return 3
    summary = {
        "result": report["result"],
        "outputCanvas": report["outputCanvas"],
        "packAnchor": report["packAnchor"],
        "passedFrames": sum(1 for f in report["frames"].values() if f.get("status") == "passed"),
        "invalidFrames": [
            {"file": name, "reason": f.get("reason")}
            for name, f in report["frames"].items()
            if f.get("status") == "invalid"
        ],
        "capabilitiesMissing": report["capabilitiesMissing"],
        "report": os.path.join(args.out, "validation-report.json"),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if report["result"] == "passed" else 4


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
