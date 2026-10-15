'use strict';

// src/workbench/lib/character-geometry.js — Workbench M0 geometry report.
//
// Measures the whale-girl character engineering (content/characters/
// whale-girl/character.json) against the actual PNG bytes and produces the
// geometry report rows for the workbench panel, the golden gallery and the
// tests:
// - per frame of every walk-left/walk-right action: anchor, shoe line
//   (alpha>=128 lowest row), visible height/width (alpha>8 bounds), aspect;
// - the MEDIAN of each metric across the same-direction sibling frames and
//   every frame's deviation from it;
// - red flags: |Δ shoe line| > 1px or |Δ visible height| > 2px (the M0
//   contract tolerances).
//
// All measurement happens on the PNG the frame file resolves to. For M0 the
// character engineering references its provenance source pack (D4: the old
// resources/characters/deepseek-default pack stays the compiled artifact and
// the byte source until M4 migrates the assets).

const fs = require('node:fs');
const { decodePngFile, lowestRowAtLeastAlpha, alphaBounds } = require('./png-geometry.js');

const SHOE_ALPHA_THRESHOLD = 128;
const BOUNDS_ALPHA_THRESHOLD = 8;
// M0 contract: a frame whose shoe line drifts ±1px or whose visible height
// drifts ±2px from the same-direction median goes RED.
const TOLERANCE = Object.freeze({ footPx: 1, heightPx: 2 });
// 2026-09-22 二代行走（方案B：AI 视频 → RVM 抠像 → 后处理，83ms/帧）：
// 四个方向都是逐帧序列，帧数按方向固定 —— left/right/down 15 帧；
// up 14 帧（44 帧周期隔帧取半的前 13 帧 + 用户定稿的收束帧 22，见
// photo/output/b-plan/上走选帧记录.md）。
const REQUIRED_WALK_ACTIONS = Object.freeze(['walk-left', 'walk-right', 'walk-up', 'walk-down']);
const REQUIRED_WALK_FRAMES = Object.freeze({ left: 15, right: 15, up: 14, down: 15 });

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// measureFrameFile(absPath) -> { ok, width, height, footLine, bounds }
// Cached per absolute path by mtime+size so the panel can refresh freely.
const measureCache = new Map();
function measureFrameFile(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { ok: false, code: 'FILE_MISSING' };
  }
  const cacheKey = `${absPath}:${stat.mtimeMs}:${stat.size}`;
  const cached = measureCache.get(cacheKey);
  if (cached) return cached;
  let image;
  try {
    image = decodePngFile(absPath);
  } catch (error) {
    const result = { ok: false, code: error.code || 'PNG_DECODE_FAILED' };
    measureCache.set(cacheKey, result);
    return result;
  }
  const bounds = alphaBounds(image, BOUNDS_ALPHA_THRESHOLD);
  const result = {
    ok: true,
    width: image.width,
    height: image.height,
    footLine: lowestRowAtLeastAlpha(image, SHOE_ALPHA_THRESHOLD),
    bounds,
    visibleWidth: bounds ? bounds.w : 0,
    visibleHeight: bounds ? bounds.h : 0,
  };
  measureCache.set(cacheKey, result);
  return result;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// buildWalkGeometryReport({ character, resolveFramePath }) -> report
// character: parsed character.json; resolveFramePath(character, frame) -> abs
// path of the frame PNG. Rows are ordered walk-left frames then walk-right.
function buildWalkGeometryReport({ character, resolveFramePath }) {
  const actions = [];
  const rows = [];
  for (const actionId of REQUIRED_WALK_ACTIONS) {
    const action = (character.actions || []).find((entry) => entry.id === actionId);
    if (!action) {
      actions.push({ id: actionId, missing: true, frames: [], medians: null });
      continue;
    }
    const measured = (action.frames || []).map((frame) => {
      const absPath = resolveFramePath(character, frame);
      const m = measureFrameFile(absPath);
      return { frame, m };
    });
    const okFrames = measured.filter(({ m }) => m.ok && m.footLine !== null && m.bounds);
    const medianFoot = okFrames.length ? median(okFrames.map(({ m }) => m.footLine)) : null;
    const medianHeight = okFrames.length ? median(okFrames.map(({ m }) => m.visibleHeight)) : null;
    const medianWidth = okFrames.length ? median(okFrames.map(({ m }) => m.visibleWidth)) : null;
    const frameRows = measured.map(({ frame, m }) => {
      const declared = frame.geometry || {};
      const dFoot = m.ok && m.footLine !== null && medianFoot !== null ? m.footLine - medianFoot : null;
      const dHeight = m.ok && m.bounds && medianHeight !== null ? m.visibleHeight - medianHeight : null;
      const dWidth = m.ok && m.bounds && medianWidth !== null ? m.visibleWidth - medianWidth : null;
      // RED: measured drift beyond tolerance — or a DECLARED value that no
      // longer matches the PNG (the report never trusts stale declarations).
      const footMatches = declared.footLine === undefined || declared.footLine === m.footLine;
      const heightMatches = declared.visibleHeight === undefined || declared.visibleHeight === m.visibleHeight;
      const red = !m.ok
        || dFoot === null || dHeight === null
        || Math.abs(dFoot) > TOLERANCE.footPx
        || Math.abs(dHeight) > TOLERANCE.heightPx
        || !footMatches || !heightMatches;
      const row = {
        action: actionId,
        file: frame.file,
        anchor: character.pack && character.pack.anchor ? character.pack.anchor : null,
        measured: m.ok ? {
          width: m.width,
          height: m.height,
          footLine: m.footLine,
          visibleWidth: m.visibleWidth,
          visibleHeight: m.visibleHeight,
          aspect: m.visibleHeight > 0 ? round2(m.visibleWidth / m.visibleHeight) : null,
        } : { code: m.code },
        declared: {
          footLine: declared.footLine !== undefined ? declared.footLine : null,
          visibleHeight: declared.visibleHeight !== undefined ? declared.visibleHeight : null,
          visibleWidth: declared.visibleWidth !== undefined ? declared.visibleWidth : null,
        },
        deviation: {
          footLine: dFoot,
          visibleHeight: dHeight,
          visibleWidth: dWidth,
        },
        red,
      };
      rows.push(row);
      return row;
    });
    actions.push({
      id: actionId,
      missing: false,
      frames: frameRows,
      medians: {
        footLine: medianFoot,
        visibleHeight: medianHeight,
        visibleWidth: medianWidth,
      },
    });
  }
  return {
    tolerance: TOLERANCE,
    pack: character.pack || null,
    actions,
    rows,
    totalFrames: rows.length,
    redFrames: rows.filter((row) => row.red).length,
  };
}

// measureEntry({ absPath, anchor, contentBbox }) -> row for the "选中条目"
// block of the geometry report (any PNG: character frame, furniture asset or
// content-tree image). Declared contentBbox (normalized) is re-measured and
// its drift reported; anything over ±0.002 flags red.
function measureEntry({ absPath, anchor = null, contentBbox = null }) {
  const base = {
    absPath,
    anchor,
    contentBbox: contentBbox || null,
    exists: fs.existsSync(absPath),
  };
  if (!base.exists) return { ...base, ok: false, code: 'FILE_MISSING' };
  let image;
  try {
    image = decodePngFile(absPath);
  } catch (error) {
    return { ...base, ok: false, code: error.code || 'PNG_DECODE_FAILED' };
  }
  const bounds = alphaBounds(image, BOUNDS_ALPHA_THRESHOLD);
  const drift = [];
  if (contentBbox && bounds) {
    for (const [key, px, dim] of [['x', bounds.x, image.width], ['y', bounds.y, image.height], ['w', bounds.w, image.width], ['h', bounds.h, image.height]]) {
      const measured = px / dim;
      drift.push({ key, declared: contentBbox[key], measured: round2(measured * 10000) / 10000, delta: round2((measured - contentBbox[key]) * 10000) / 10000 });
    }
  }
  return {
    ...base,
    ok: true,
    width: image.width,
    height: image.height,
    footLine: lowestRowAtLeastAlpha(image, SHOE_ALPHA_THRESHOLD),
    visibleWidth: bounds ? bounds.w : 0,
    visibleHeight: bounds ? bounds.h : 0,
    aspect: bounds && bounds.h > 0 ? round2(bounds.w / bounds.h) : null,
    contentBboxDrift: drift.length ? drift : null,
    red: drift.some((entry) => Math.abs(entry.delta) > 0.002),
  };
}

module.exports = {
  SHOE_ALPHA_THRESHOLD,
  BOUNDS_ALPHA_THRESHOLD,
  TOLERANCE,
  REQUIRED_WALK_ACTIONS,
  REQUIRED_WALK_FRAMES,
  median,
  measureFrameFile,
  buildWalkGeometryReport,
  measureEntry,
};
