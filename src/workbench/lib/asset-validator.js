'use strict';

// src/workbench/lib/asset-validator.js — the 素材校验器 catalog rows.
//
// Validates EVERY active entry of the shared layout asset catalog
// (src/office/layout-assets.js — the single manifest the editor shelf, the
// renderer and this panel consume) against the production PNG bytes:
// - 存在: the managed production file is on disk
// - 解码: the file decodes as a PNG with positive dimensions
// - alpha: the PNG carries a real alpha channel (colorType 4/6) AND actually
//   uses it (not a fully-opaque image)
// - 路径: the declared src hits the managed production URL families and
//   never fixtures/, photo/, artifacts/, test trees or absolute paths
// - contentBbox 漂移: declared normalized bbox vs freshly measured alpha
//   bounds (threshold 8), drift <= 0.002 per component
//
// The archived isometric family (ARCHIVED_LAYOUT_ASSETS, retired from the
// shelf) stays resolvable but is not part of the active panel — the catalog
// tests already lock its files.

const fs = require('node:fs');
const path = require('node:path');

const { decodePngFile, alphaBounds } = require('./png-geometry.js');

const CONTENT_BBOX_DRIFT_LIMIT = 0.002;
const PRODUCTION_SRC_PATTERN = /^\.\/office-assets\/(layout-editor\/)?prop-|^\.\/office-assets\/flat\/(prop|flat)-|^\.\/characters\/deepseek-default\//;
const FORBIDDEN_SRC_PATTERN = /fixtures|photo\/|artifacts|test|[A-Za-z]:\\|^\//;

function resolveCatalogAssetPath(repoRoot, src) {
  if (src.startsWith('./office-assets/')) return path.join(repoRoot, 'resources', 'office', src.slice('./office-assets/'.length));
  if (src.startsWith('./characters/')) return path.join(repoRoot, 'resources', src.slice('./'.length));
  return null;
}

// catalogAssetRows(repoRoot) -> [{id, label, kind, src, checks:{...}, ok}]
function catalogAssetRows(repoRoot) {
  const { LAYOUT_ASSETS } = require(path.join(repoRoot, 'src', 'office', 'layout-assets.js'));
  return LAYOUT_ASSETS.map((asset) => {
    const pathOk = PRODUCTION_SRC_PATTERN.test(asset.src) && !FORBIDDEN_SRC_PATTERN.test(asset.src);
    const abs = resolveCatalogAssetPath(repoRoot, asset.src);
    const exists = !!abs && fs.existsSync(abs);
    let decodeOk = false;
    let alphaOk = false;
    let colorType = null;
    let bboxDrift = null;
    let bboxOk = true;
    if (exists) {
      try {
        const image = decodePngFile(abs);
        decodeOk = image.width > 0 && image.height > 0;
        colorType = image.colorType;
        alphaOk = image.colorType === 4 || image.colorType === 6;
        if (alphaOk) {
          const bounds = alphaBounds(image, 8);
          alphaOk = !!bounds; // a fully-transparent or fully-opaque flat asset is a mistake
        }
        if (asset.contentBbox && decodeOk) {
          const bounds = alphaBounds(image, 8);
          if (bounds) {
            bboxDrift = ['x', 'y', 'w', 'h'].map((key, index) => {
              const measured = (index === 0 ? bounds.x : index === 1 ? bounds.y : index === 2 ? bounds.w : bounds.h)
                / (index === 0 || index === 2 ? image.width : image.height);
              return { key, delta: Math.round((measured - asset.contentBbox[key]) * 10000) / 10000 };
            });
            bboxOk = bboxDrift.every((entry) => Math.abs(entry.delta) <= CONTENT_BBOX_DRIFT_LIMIT);
          } else {
            bboxOk = false;
          }
        }
      } catch (error) {
        decodeOk = false;
        bboxOk = !asset.contentBbox; // drift is unknown, not violated — but the decode failure already fails the row
      }
    }
    const checks = {
      exists,
      decode: decodeOk,
      alpha: alphaOk,
      path: pathOk,
      bbox: bboxOk,
    };
    return {
      id: asset.id,
      label: asset.label,
      kind: asset.kind,
      src: asset.src,
      colorType,
      contentBbox: asset.contentBbox || null,
      bboxDrift,
      checks,
      ok: checks.exists && checks.decode && checks.alpha && checks.path && checks.bbox,
    };
  });
}

module.exports = {
  CONTENT_BBOX_DRIFT_LIMIT,
  PRODUCTION_SRC_PATTERN,
  FORBIDDEN_SRC_PATTERN,
  resolveCatalogAssetPath,
  catalogAssetRows,
};
