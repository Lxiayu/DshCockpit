'use strict';

// src/workbench/lib/depth-bands.js — what a layer NUMBER means (workbench UX
// rectification, gap #2: 选中物件的数值属性).
//
// The layout's `layer` is DEPTH: larger draws further front (back → front). The
// product's own schema pins a default per kind (studio/lib/layout-schema.js:
// monitor 10 · chair 20 · prop 25 · character 30 · desk 40), and those five
// numbers are the vocabulary the compiled fixture was built with — but the field
// accepts any integer, so "45" alone tells a user nothing about what will cover
// what. This module is the translation: which band a layer sits in, and the
// ladder itself, so the inspector can say 「层级 35 · 角色(30) 与 桌面(40) 之间」
// instead of a bare number.
//
// Deliberately pure and tiny: no DOM, no i18n (the caller supplies the labels —
// the band ids are the schema's kind names, which the dictionary already owns).

// The five depth bands, in paint order (back first). `kind` is the schema's own
// DEFAULT_LAYER_BY_KIND key, so a band id maps 1:1 onto a catalog kind.
const DEPTH_BANDS = Object.freeze([
  Object.freeze({ layer: 10, kind: 'monitor' }),
  Object.freeze({ layer: 20, kind: 'chair' }),
  Object.freeze({ layer: 25, kind: 'prop' }),
  Object.freeze({ layer: 30, kind: 'character' }),
  Object.freeze({ layer: 40, kind: 'desk' }),
]);

// The band a layer belongs to: the LAST band at or below it (a layer of 35 is
// painted after the character band and before the desk band, so it reads as
// "between character(30) and desk(40)" rather than pretending to be one).
// A layer below the first band has no band under it — `below` names the first
// one instead of inventing a sixth. Nothing typed (null / undefined / an empty
// or blank field) has NO band: the caller then shows the ladder instead of
// pretending the user asked about layer 0 (Number('') is 0).
function bandOf(layer) {
  if (layer === null || layer === undefined) return null;
  if (typeof layer === 'string' && layer.trim() === '') return null;
  const value = Number(layer);
  if (!Number.isFinite(value)) return null;
  let index = -1;
  for (let i = 0; i < DEPTH_BANDS.length; i += 1) {
    if (DEPTH_BANDS[i].layer <= value) index = i;
    else break;
  }
  if (index < 0) {
    return { kind: 'below', band: null, above: DEPTH_BANDS[0] };
  }
  const band = DEPTH_BANDS[index];
  const above = index + 1 < DEPTH_BANDS.length ? DEPTH_BANDS[index + 1] : null;
  // exactly on the band's own number → that band; strictly above it → the gap
  // between this band and the next one (or "in front of everything" at the top)
  if (value === band.layer) return { kind: 'on', band, above: null };
  return { kind: above ? 'between' : 'front', band, above };
}

const wbDepthBandsApi = { DEPTH_BANDS, bandOf };
// dual module (the house pattern, see i18n.js): require()-able from Node AND
// loadable as a classic script in the page.
if (typeof window !== 'undefined') window.wbDepthBands = wbDepthBandsApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbDepthBandsApi;
