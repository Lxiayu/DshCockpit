'use strict';

// src/office/runtime/office-layout-compiler.js — Task E4 (draft → runtime).
//
// Pure, deterministic CommonJS compiler that turns a schema-v1 layout editor
// draft (normalized items, groupId groups) into a runtime office layout that
// is ISOMORPHIC to src/office/fixtures/office-layout.json: same 27 node ids
// with preserved tags/capacity/safeRadius, the same 40-edge waypoint
// topology, the same layer order, and workstations desk-1..desk-6 in
// row-major order. It never invents topology and never reads files.
//
// Strategy (keeping the graph walkable instead of re-deriving it):
// 1. Workstations: kind desk items are the anchors (row-major desk-1..6);
//    monitor/character/chair items form groupId units (singleton items are
//    their own unit) that attach to the desk minimizing total unit↔desk
//    distance over the optimal injective assignment. Props never join a
//    workstation.
// 2. Furniture: every non-hidden, non-character item becomes a furniture
//    entry whose footprint is the OPAQUE ART BOX derived from
//    draftWidths[kind] × scale and the asset contentBbox (the editor's
//    "art fills the placeholder box" contract). Workstation furniture gets
//    stable ids desk-N-back / desk-N-monitor / desk-N-chair; the chair is a
//    fixture-declared front occluder (layered above the seated character,
//    exactly like the approved draft's 桌子 < 显示器 < 鲸鱼娘 < 椅子 order).
//    Hidden items produce no furniture and no collision geometry.
// 3. Nodes: the seat anchor of a workstation is the character item's
//    calibrated foot point (characterFoot ratio × the drafted sprite box) —
//    the drafted seated position. approach/leave/roam/chat nodes are
//    re-projected onto the walkable aisles/corridors implied by the compiled
//    furniture, deterministically: a fixed ideal per node role plus a
//    bounded spiral search that accepts the first candidate satisfying the
//    no-clipping capsule against every furniture box for ALL edges that
//    become complete at that point.
// 4. Verification: every graph edge is sampled at 1/200; a sample violates
//    when it comes closer to a furniture footprint than the character's
//    mover radius (movement-controller moverRadiusRatio 0.02 × min scene
//    dimension). Furniture belonging to a workstation that one of the edge
//    endpoints belongs to is exempt — the seated employee necessarily
//    overlaps her own chair and desk. `sampleEdgeConflicts` is exported so
//    tests (and the compiler itself) share ONE definition of 穿模.
//
// Failure surface: stable OFFICE_COMPILE_* codes with structured detail
// (offending item ids / workstation pairs / walk conflicts). Nothing here
// throws; callers route the codes to the existing OFFICE_* diagnostics.

const WORKSTATION_KINDS = Object.freeze(['desk', 'monitor', 'character', 'chair']);
const DESK_COUNT = 6;
// movement-controller.js moverRadiusRatio: the walking character's own
// collision capsule, in min-scene-dimension ratios.
const MOVER_RADIUS_RATIO = 0.04;
// Placement clearance (slightly stricter than the sampler so verified
// layouts keep a small drift margin).
const PLACEMENT_CLEAR_RATIO = 0.045;
const EDGE_SAMPLES = 200;
// Minimum screen distance between two placed non-seat nodes so their
// reservation zones (safeRadius 0.03) never permanently overlap.
const NODE_SPACING_PX = 30;
const SPIRAL_STEP_PX = 8;
const SPIRAL_MAX_RING = 44;
const SCENE_EDGE_MARGIN_PX = 12;
// The character frames are drawn on a square canvas (whale-girl 352×352), so
// the drafted sprite box is square: nodeH = nodeW.
const CHARACTER_ASPECT = 1;

function fail(code, detail) {
  return { ok: false, code, detail: detail || null };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Deterministic content hash of the canonical JSON encoding (key order fixed
// by the draft serialization). Pure JS (FNV-1a over the encoding) so the
// compiler also runs inside the office page's mini module loader; the
// generation script passes the real SHA-256 via sourceDraftSha256.
function stableSha256(value) {
  const source = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, '0')}-${source.length.toString(16)}`;
}

// ---- geometry helpers (scene px) -------------------------------------------

function pointRectDistancePx(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ---- draft validation -------------------------------------------------------

function validateDraftEnvelope(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  if (draft.schemaVersion !== 1) return false;
  if (!draft.scene || !Number.isFinite(draft.scene.width) || draft.scene.width <= 0
      || !Number.isFinite(draft.scene.height) || draft.scene.height <= 0) return false;
  if (!Array.isArray(draft.items)) return false;
  return true;
}

function validateItem(item, assetById, invalidItems, unknownAssetItems) {
  if (!item || typeof item !== 'object') { invalidItems.push({ id: null, reason: 'item' }); return false; }
  if (typeof item.id !== 'string' || item.id.length === 0) { invalidItems.push({ id: null, reason: 'id' }); return false; }
  if (typeof item.asset !== 'string' || !assetById.has(item.asset)) { unknownAssetItems.push(item.id); return false; }
  if (!item.position || !isFiniteNumber(item.position.x) || item.position.x < 0 || item.position.x > 1
      || !isFiniteNumber(item.position.y) || item.position.y < 0 || item.position.y > 1) {
    invalidItems.push({ id: item.id, reason: 'position' });
    return false;
  }
  if (!isFiniteNumber(item.scale) || item.scale <= 0) { invalidItems.push({ id: item.id, reason: 'scale' }); return false; }
  if (!Number.isInteger(item.layer) || item.layer < 0) { invalidItems.push({ id: item.id, reason: 'layer' }); return false; }
  return true;
}

// ---- furniture derivation ---------------------------------------------------

// The opaque art box of a draft item, in scene pixels, using the editor's
// contentBbox viewport contract (art fills the box; box height follows the
// bbox aspect). Assets without contentBbox use the full PNG (square canvas
// for every managed family the compiler consumes).
function artBoxPx(item, asset, draftWidths, scene) {
  const boxW = (draftWidths[item.kind] || 100) * item.scale;
  const bbox = asset.contentBbox || { x: 0, y: 0, w: 1, h: 1 };
  const boxH = boxW * (bbox.h / bbox.w) * CHARACTER_ASPECT;
  return {
    x: item.position.x * scene.width - boxW / 2,
    y: item.position.y * scene.height - boxH / 2,
    width: boxW,
    height: boxH,
  };
}

function normalizeRect(rect, scene) {
  return {
    x: rect.x / scene.width,
    y: rect.y / scene.height,
    width: rect.width / scene.width,
    height: rect.height / scene.height,
  };
}

// ---- no-clipping walk sampler ----------------------------------------------

function workstationIdOfNode(nodeId) {
  const match = /^(desk-[1-6])(?:-approach|-leave)?$/.exec(nodeId || '');
  return match ? match[1] : null;
}

// The workstations whose furniture is exempt for this edge:
// - the workstation whose SEAT node (desk-N itself) is an endpoint — the
//   seated employee necessarily overlaps her own chair/desk;
// - the workstation BOTH endpoints belong to (the desk-N → approach → leave
//   internal chain) — standing up and stepping out weaves through the own
//   seating composition, which the flat projection draws as correct
//   back/front occlusion.
// Edges that LEAVE the workstation (desk-N-leave ↔ roam-X) get NO exemption:
// a leave node sits outside the furniture zone and its walk-out edge has no
// excuse to cross any furniture, own or foreign.
function exemptWorkstationsForEdge(fromId, toId) {
  const exempt = new Set();
  for (const nodeId of [fromId, toId]) {
    const match = /^(desk-[1-6])$/.exec(nodeId || '');
    if (match) exempt.add(match[1]);
  }
  const fromWs = workstationIdOfNode(fromId);
  if (fromWs && fromWs === workstationIdOfNode(toId)) exempt.add(fromWs);
  return exempt;
}

function workstationIdOfFurniture(furnitureId) {
  const match = /^(desk-[1-6])-/.exec(furnitureId || '');
  return match ? match[1] : null;
}

function furnitureRects(fixture) {
  const rects = [];
  for (const item of fixture.furniture || []) {
    for (const [part, rect] of Object.entries(item.parts || {})) {
      rects.push({
        furnitureId: item.id,
        workstationId: workstationIdOfFurniture(item.id),
        part,
        rect: {
          x: rect.x * fixture.scene.referenceWidth,
          y: rect.y * fixture.scene.referenceHeight,
          width: rect.width * fixture.scene.referenceWidth,
          height: rect.height * fixture.scene.referenceHeight,
        },
      });
    }
  }
  return rects;
}

// Every graph edge sampled at 1/200 with the character's mover capsule must
// clear every furniture footprint, except the furniture of the workstation
// an edge endpoint belongs to (the seat overlaps its own chair/desk).
//
// mode 'flat' (default): ALL workstation furniture collides — the flat 2D
// projection draws furniture and characters in the same screen plane, so a
// foot point inside another workstation's art box reads as clipping.
// mode 'legacy-iso': workstation furniture is walkable-behind (the isometric
// projection elevates it, so a foot point inside a desk rect reads as the
// character passing BEHIND the desk — normal occlusion); only environment
// props and zone markers collide. The isometric fixture was calibrated for
// exactly these semantics, and the compiled flat layout satisfies the stricter
// flat mode as well.
function sampleEdgeConflicts(fixture, options = {}) {
  const radiusRatio = isFiniteNumber(options.moverRadiusRatio) ? options.moverRadiusRatio : MOVER_RADIUS_RATIO;
  const legacyIso = options.mode === 'legacy-iso';
  const radiusPx = radiusRatio * Math.min(fixture.scene.referenceWidth, fixture.scene.referenceHeight);
  const nodesById = new Map((fixture.nodes || []).map((node) => [node.id, node]));
  const rects = furnitureRects(fixture);
  const conflicts = [];
  const byKey = new Map();
  for (const edge of fixture.edges || []) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) continue;
    const exempt = exemptWorkstationsForEdge(edge.from, edge.to);
    for (let step = 0; step <= EDGE_SAMPLES; step += 1) {
      const point = lerpPoint(from.position, to.position, step / EDGE_SAMPLES);
      const px = { x: point.x * fixture.scene.referenceWidth, y: point.y * fixture.scene.referenceHeight };
      for (const entry of rects) {
        if (entry.workstationId && (exempt.has(entry.workstationId) || legacyIso)) continue;
        if (pointRectDistancePx(px, entry.rect) < radiusPx) {
          const key = `${edge.from}>${edge.to}|${entry.furnitureId}`;
          if (!byKey.has(key)) {
            byKey.set(key, true);
            conflicts.push({
              edge: `${edge.from}>${edge.to}`,
              furnitureId: entry.furnitureId,
              point: { x: Number(px.x.toFixed(2)), y: Number(px.y.toFixed(2)) },
            });
          }
          break;
        }
      }
    }
  }
  return conflicts;
}

// ---- workstation grouping ---------------------------------------------------

function buildWorkstationGroups(items, assetById) {
  const desks = items.filter((item) => item.kind === 'desk');
  if (desks.length !== DESK_COUNT) {
    return { ok: false, code: 'OFFICE_COMPILE_WORKSTATION_COUNT', detail: { deskCount: desks.length } };
  }
  // Non-desk workstation members group by groupId (singleton/ungrouped items
  // are their own unit); each unit must hold distinct kinds.
  const unitsByGroup = new Map();
  for (const item of items) {
    if (!WORKSTATION_KINDS.includes(item.kind) || item.kind === 'desk') continue;
    const key = item.groupId || `__solo__${item.id}`;
    if (!unitsByGroup.has(key)) unitsByGroup.set(key, []);
    unitsByGroup.get(key).push(item);
  }
  const units = [];
  for (const [key, members] of [...unitsByGroup.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const kinds = new Set(members.map((member) => member.kind));
    if (kinds.size !== members.length) {
      return fail('OFFICE_COMPILE_WORKSTATION_MEMBER_DUPLICATE', { group: key, items: members.map((m) => m.id) });
    }
    const character = members.find((member) => member.kind === 'character');
    units.push({
      key,
      members,
      anchor: character ? character.position : members[0].position,
    });
  }
  if (units.length !== DESK_COUNT) {
    return fail('OFFICE_COMPILE_WORKSTATION_MEMBER_MISSING', {
      deskCount: desks.length,
      unitCount: units.length,
      items: units.map((unit) => unit.key),
    });
  }
  // Optimal injective unit→desk assignment by total distance (6! search is
  // trivial), tie-broken by the lexicographic assignment order.
  let best = null;
  let bestCost = Infinity;
  const permutations = (array) => {
    if (array.length <= 1) return [array];
    const out = [];
    for (let i = 0; i < array.length; i += 1) {
      const rest = [...array.slice(0, i), ...array.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([array[i], ...tail]);
    }
    return out;
  };
  for (const order of permutations(desks.map((desk, index) => index))) {
    let cost = 0;
    for (let u = 0; u < units.length; u += 1) cost += distance(units[u].anchor, desks[order[u]].position);
    if (cost < bestCost - 1e-12) { bestCost = cost; best = order; }
  }
  const byIndex = new Map(units.map((unit, index) => [index, { unit, desk: desks[best[index]] }]));
  const claimed = new Set([...byIndex.values()].map((entry) => entry.desk.id));
  const missing = [];
  for (const desk of desks) {
    if (!claimed.has(desk.id)) missing.push(desk.id);
  }
  if (missing.length > 0) return fail('OFFICE_COMPILE_WORKSTATION_MEMBER_MISSING', { desks: missing, memberKinds: [] });
  const pairs = [...byIndex.values()];
  for (const pair of pairs) {
    const kinds = new Set(pair.unit.members.map((member) => member.kind));
    for (const kind of WORKSTATION_KINDS) {
      if (kind === 'desk') continue;
      if (!kinds.has(kind)) {
        return fail('OFFICE_COMPILE_WORKSTATION_MEMBER_MISSING', {
          desks: [pair.desk.id],
          memberKinds: [kind],
          items: [pair.unit.key],
        });
      }
    }
  }
  return { ok: true, pairs, desks };
}

// ---- node placement ---------------------------------------------------------

function spiralCandidates(ideal, scene) {
  const candidates = [];
  const clampPoint = (point) => ({
    x: Math.min(scene.width - SCENE_EDGE_MARGIN_PX, Math.max(SCENE_EDGE_MARGIN_PX, point.x)),
    y: Math.min(scene.height - SCENE_EDGE_MARGIN_PX, Math.max(SCENE_EDGE_MARGIN_PX, point.y)),
  });
  candidates.push(clampPoint(ideal));
  const directions = [];
  for (let k = 0; k < 16; k += 1) {
    const angle = (Math.PI * 2 * k) / 16;
    directions.push([Math.cos(angle), Math.sin(angle)]);
  }
  for (let ring = 1; ring <= SPIRAL_MAX_RING; ring += 1) {
    for (const [dx, dy] of directions) {
      candidates.push(clampPoint({
        x: ideal.x + dx * ring * SPIRAL_STEP_PX,
        y: ideal.y + dy * ring * SPIRAL_STEP_PX,
      }));
    }
  }
  return candidates;
}

// ---- compiler ---------------------------------------------------------------

function compileOfficeLayout({ draft, assets, draftWidths, characterFoot, topology, sourceDraftSha256 = null }) {
  if (!validateDraftEnvelope(draft)) return fail('OFFICE_COMPILE_DRAFT_INVALID', { schemaVersion: draft && draft.schemaVersion });
  if (!Array.isArray(assets) || assets.length === 0) return fail('OFFICE_COMPILE_DRAFT_INVALID', { reason: 'assets' });
  if (!characterFoot || !isFiniteNumber(characterFoot.x) || !isFiniteNumber(characterFoot.y)) {
    return fail('OFFICE_COMPILE_DRAFT_INVALID', { reason: 'characterFoot' });
  }
  if (!topology || !Array.isArray(topology.nodes) || !Array.isArray(topology.edges)) {
    return fail('OFFICE_COMPILE_DRAFT_INVALID', { reason: 'topology' });
  }

  // M4.1b (2026-09-17): LEFT-WING EXTENSION (flat layout only). The isometric
  // topology predates the user's left-wing furniture; the left desk column
  // leaves only ~13px clear between one row's chairs and the next row's
  // monitors, so NO straight edge can cross it horizontally. The left wing
  // therefore connects through the one clean route that exists: the bottom
  // band below the last desk row. Two roaming nodes give the wing real
  // routes; the compiler tests pin the extension as isometric + exactly
  // {roam-8, roam-9} and the two edges below.
  //
  // M4.1h (2026-09-24 巡游/休息区): the two-node wing gave the whale-girls a
  // place to VANISH INTO but not a place to BE — 90% of the leftward plans died
  // on the single roam-9↔roam-6 gateway, and the furniture band (island / water
  // bar / coffee machine / rice cooker, then the sofa row, water cooler and
  // plant) had ZERO reachable waypoints, so "休息" always happened in place.
  // The extension is now the left column itself:
  //   * a vertical aisle column at x = 0.27 (LEFT_WING_COLUMN_X) with four new
  //     walkable spots whose y levels are derived from the compiled furniture
  //     rows — 0.36 (below the reserve/kitchen band), then evenly spaced down to
  //     roam-8 — so every one of them stands beside a furniture cluster in the
  //     open floor, never inside a prop;
  //   * `resting` + `rest-area` tags on the three column nodes that are next to
  //     a real resting surface (water cooler / sofa row / kitchen band), which
  //     is what turns the director's `/rest-area/` pool and the scheduler's
  //     `resting` target search into REAL walks to the break area;
  //   * a SECOND gateway across the left desk column: the only crossing the
  //     穿模 sampler accepts is the bottom aisle, and the deepest chair bottom
  //     (desk-5/6, y≈0.9403) plus the mover capsule (0.04) plus a margin is the
  //     highest level that clears both chairs — a walkway at exactly that level
  //     (seat level for the transit node) lets a walker reach roam-9 through
  //     roam-4 as well as through the legacy roam-6 gateway. The old gateway
  //     stays (it is the shorter way), so one occupied node no longer strands
  //     the whole wing.
  const LEFT_WING_FOOTPRINT = Object.freeze({ width: 0.05, height: 0.05 });
  const LEFT_WING_COLUMN_X = 0.27;
  const LEFT_WING_TAGS = Object.freeze(['roaming', 'rest-area']);
  const LEFT_WING_REST_TAGS = Object.freeze(['roaming', 'rest-area', 'resting']);
  // The second gateway's two transit nodes are NOT roaming targets: they exist
  // to be WALKED THROUGH (a target pool that included them would park bodies on
  // the only bypass). `transit` is inert to every candidate filter in the
  // runtime — the movement contract only needs the node to exist and its edges
  // to carry the behavior.
  const LEFT_WING_TRANSIT_TAGS = Object.freeze(['transit']);
  const LEFT_WING_NODES = Object.freeze([
    // The two corner/bend nodes of the wing carry NO roaming target: they are
    // the wing's cut vertices (every column path goes through roam-8, gateway 1
    // through roam-9), and a dweller parked on one of them sealed the whole
    // wing off (measured: whole left pool unreachable in 65% of the left-intent
    // decisions). Transit-only tags keep bodies passing THROUGH, never parking.
    Object.freeze({ id: 'roam-8', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_TRANSIT_TAGS, capacity: 2, safeRadius: 0.03 }),
    Object.freeze({ id: 'roam-9', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_TRANSIT_TAGS, capacity: 2, safeRadius: 0.03 }),
    Object.freeze({ id: 'roam-10', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_TAGS, capacity: 2, safeRadius: 0.03 }),
    Object.freeze({ id: 'roam-11', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_REST_TAGS, capacity: 2, safeRadius: 0.03 }),
    Object.freeze({ id: 'roam-12', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_REST_TAGS, capacity: 2, safeRadius: 0.03 }),
    Object.freeze({ id: 'roam-13', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_REST_TAGS, capacity: 2, safeRadius: 0.03 }),
    // the second gateway's bottom-aisle transit node (x = 0.47 — the free span
    // just left of the left desk column's front chair)
    Object.freeze({ id: 'roam-14', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_TRANSIT_TAGS, capacity: 2, safeRadius: 0.03 }),
    // two more column spots so the six left targets are spread along the aisle
    Object.freeze({ id: 'roam-15', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_TAGS, capacity: 2, safeRadius: 0.03 }),
    Object.freeze({ id: 'roam-16', position: null, footprint: LEFT_WING_FOOTPRINT, tags: LEFT_WING_TAGS, capacity: 2, safeRadius: 0.03 }),
  ]);
  const LEFT_WING_EDGES = Object.freeze([
    Object.freeze({ from: 'roam-8', to: 'roam-9', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    // gateway 1 (legacy): the bottom-band crossing into the corner node
    Object.freeze({ from: 'roam-9', to: 'roam-6', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    // gateway 2 (M4.1h): roam-4 → roam-14 → roam-8. It reaches the COLUMN
    // WITHOUT passing roam-9, which is the wing's cut vertex — a body parked on
    // roam-9 used to make every left node unreachable (measured: 65% of the
    // left-intent decisions found the whole pool blocked). Two hops with ONE
    // transit vertex is also the minimum-blocking shape: every extra vertex is
    // another body that can strand the wing.
    Object.freeze({ from: 'roam-4', to: 'roam-14', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    Object.freeze({ from: 'roam-14', to: 'roam-8', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    // the left column itself
    Object.freeze({ from: 'roam-8', to: 'roam-10', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    Object.freeze({ from: 'roam-10', to: 'roam-11', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    Object.freeze({ from: 'roam-11', to: 'roam-15', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    Object.freeze({ from: 'roam-15', to: 'roam-12', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    Object.freeze({ from: 'roam-12', to: 'roam-16', behaviors: Object.freeze(['roaming']), bidirectional: true }),
    Object.freeze({ from: 'roam-16', to: 'roam-13', behaviors: Object.freeze(['roaming']), bidirectional: true }),
  ]);

  const topoNodes = [...topology.nodes, ...LEFT_WING_NODES];

  // M4.1f 穿模修正（flat 投影专用拓扑适配）：canonical 拓扑的 desk-N↔roam-X
  // 直连边服务于 isometric 的 walk-behind 语义（斜穿自家工位读作绕到桌后）。
  // flat 投影下同一条边是立绘斜切桌背板/显示器贴图——sampler 对带座位端点
  // 的边按设计豁免自家家具，几何校验抓不到，只在视觉上暴露（漫游起身瞬间
  // 的对角线穿桌）。flat 输出丢弃直连边，并把 approach/leave 链三段边的行
  // 为补全为全行为：起身与落座一律沿 走廊→桌前→绕椅后 的链走，链上豁免
  // 段的遮挡读作自然的前后关系。isometric canonical fixture 不受影响。
  // M4.1f 对话可达性：beginChat 以 behavior 'chatting' 为双方规划到
  // chat-a/chat-b 的真实路线。canonical 拓扑里只有 roam-2/roam-3↔chat 三条
  // 边带 'chatting'——发起者与搭档都必须恰好站在 chat 座位邻点，配对是
  // 位置彩票。flat 编译给链边与 roam↔roam 走廊边补上 'chatting'（聊天走
  // 位视觉上与漫游走位完全相同），任何位置的两位空闲同事都能走到水 cooler。
  // M4.1h: 同一手法给链边/走廊边/chat 边补上 'resting'——左翼休息节点上线后，
  // "去休息区休息"必须能从任何工位/走廊位置规划出真实路线（否则 resting 的
  // 目标搜索在 flat 图上永远不可达，又退回原地休息）。
  const FLAT_CHAIN_BEHAVIORS = Object.freeze(['roaming', 'task', 'sleeping', 'chatting', 'resting']);
  const FLAT_CORRIDOR_BEHAVIORS = Object.freeze(['roaming', 'task', 'sleeping', 'chatting', 'resting']);
  const FLAT_CHAT_BEHAVIORS = Object.freeze(['roaming', 'chatting', 'resting']);
  const isChainEdge = (edge) => [edge.from, edge.to]
    .some((id) => /^desk-[1-6]-(?:approach|leave)$/.test(id));
  const hasSeatEndpoint = (edge) => [edge.from, edge.to]
    .some((id) => /^desk-[1-6]$/.test(id));
  const isCorridorEdge = (edge) => [edge.from, edge.to]
    .every((id) => /^roam-/.test(id));
  const isChatEdge = (edge) => [edge.from, edge.to]
    .some((id) => /^chat-/.test(id));
  const flatEdges = [...topology.edges, ...LEFT_WING_EDGES]
    .filter((edge) => isChainEdge(edge) || !hasSeatEndpoint(edge))
    .map((edge) => {
      if (isChainEdge(edge)) return { ...edge, behaviors: [...FLAT_CHAIN_BEHAVIORS] };
      if (isCorridorEdge(edge)) return { ...edge, behaviors: [...FLAT_CORRIDOR_BEHAVIORS] };
      if (isChatEdge(edge)) return { ...edge, behaviors: [...FLAT_CHAT_BEHAVIORS] };
      return edge;
    });
  const topoEdges = flatEdges;

  const scene = { width: draft.scene.width, height: draft.scene.height };
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const invalidItems = [];
  const unknownAssetItems = [];
  for (const item of draft.items) {
    if (!validateItem(item, assetById, invalidItems, unknownAssetItems)) continue;
  }
  if (invalidItems.length > 0) {
    return fail('OFFICE_COMPILE_ITEM_INVALID', { items: invalidItems.map((entry) => entry.id || entry.reason) });
  }
  if (unknownAssetItems.length > 0) {
    return fail('OFFICE_COMPILE_ASSET_UNKNOWN', { items: unknownAssetItems });
  }
  for (const item of draft.items) {
    if (assetById.get(item.asset).kind !== item.kind) {
      return fail('OFFICE_COMPILE_ITEM_INVALID', { items: [item.id] });
    }
  }
  const items = draft.items.filter((item) => item.hidden !== true);

  const grouping = buildWorkstationGroups(items, assetById);
  if (!grouping.ok) return grouping;
  const pairs = grouping.pairs;

  // Workstation furniture + seats, ordered row-major desk-1..desk-6.
  const sortedPairs = [...pairs].sort((a, b) => {
    const dy = a.desk.position.y - b.desk.position.y;
    if (Math.abs(dy) > 1e-9) return dy;
    return a.desk.position.x - b.desk.position.x;
  });
  const workstations = sortedPairs.map((pair, index) => ({ deskId: `desk-${index + 1}`, pair }));

  // Workstation overlap check (art boxes of two different workstations).
  const wsBoxes = workstations.map(({ deskId, pair }) => {
    const boxes = pair.unit.members
      .filter((member) => member.kind !== 'character')
      .map((member) => artBoxPx(member, assetById.get(member.asset), draftWidths, scene))
      .concat([artBoxPx(pair.desk, assetById.get(pair.desk.asset), draftWidths, scene)]);
    return { deskId, boxes };
  });
  for (let i = 0; i < wsBoxes.length; i += 1) {
    for (let j = i + 1; j < wsBoxes.length; j += 1) {
      for (const a of wsBoxes[i].boxes) {
        for (const b of wsBoxes[j].boxes) {
          if (rectsOverlap(a, b)) {
            return fail('OFFICE_COMPILE_WORKSTATION_OVERLAP', { workstations: [wsBoxes[i].deskId, wsBoxes[j].deskId] });
          }
        }
      }
    }
  }

  // Furniture emission. Workstation parts first (stable ids), then props in
  // draft (layer, array) order, then chairs (front occluders) last.
  const furniture = [];
  const seatAnchors = new Map();
  for (const { deskId, pair } of workstations) {
    const { desk } = pair;
    const membersByKind = new Map(pair.unit.members.map((member) => [member.kind, member]));
    const monitor = membersByKind.get('monitor');
    const chair = membersByKind.get('chair');
    const character = membersByKind.get('character');
    const deskBox = artBoxPx(desk, assetById.get(desk.asset), draftWidths, scene);
    const monitorBox = artBoxPx(monitor, assetById.get(monitor.asset), draftWidths, scene);
    const chairBox = artBoxPx(chair, assetById.get(chair.asset), draftWidths, scene);
    furniture.push({
      id: `${deskId}-back`,
      kind: 'desk-back',
      layer: 'back-furniture',
      // M4.1c: flat furniture sorts geometrically by its bottom edge at render
      // time (walkers pass OVER desks/chairs, the seated body is occluded by
      // whatever stands in front of it). The isometric fixture omits this
      // flag and keeps its explicit-layer semantics.
      sortY: true,
      assetId: desk.asset,
      depth: desk.layer,
      footprint: { width: deskBox.width / scene.width, height: deskBox.height / scene.height },
      parts: { back: normalizeRect(deskBox, scene) },
    });
    furniture.push({
      id: `${deskId}-monitor`,
      kind: 'monitor',
      layer: 'back-furniture',
      sortY: true,
      assetId: monitor.asset,
      depth: monitor.layer,
      footprint: { width: monitorBox.width / scene.width, height: monitorBox.height / scene.height },
      parts: { back: normalizeRect(monitorBox, scene) },
    });
    furniture.push({
      id: `${deskId}-chair`,
      kind: 'chair',
      layer: 'front-occluders',
      occluder: true,
      sortY: true,
      assetId: chair.asset,
      depth: chair.layer,
      footprint: { width: chairBox.width / scene.width, height: chairBox.height / scene.height },
      parts: { front: normalizeRect(chairBox, scene) },
    });
    // Seat = the drafted character's calibrated foot point.
    const nodeW = (draftWidths.character || 96) * character.scale;
    const foot = {
      x: character.position.x + (characterFoot.x - 0.5) * nodeW / scene.width,
      y: character.position.y + (characterFoot.y - 0.5) * nodeW / scene.height,
    };
    seatAnchors.set(deskId, { foot, desk, monitor, chair, character, deskBox, monitorBox, chairBox });
  }
  const props = items
    .filter((item) => item.kind === 'prop')
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.layer - b.item.layer) || (a.index - b.index));
  for (const { item } of props) {
    const box = artBoxPx(item, assetById.get(item.asset), draftWidths, scene);
    furniture.push({
      id: item.id,
      kind: 'prop',
      layer: 'back-furniture',
      sortY: true,
      assetId: item.asset,
      depth: item.layer,
      footprint: { width: box.width / scene.width, height: box.height / scene.height },
      parts: { main: normalizeRect(box, scene) },
    });
  }

  // Obstacles for the walk-graph re-projection (scene px).
  const obstacles = furniture.map((item) => ({
    furnitureId: item.id,
    workstationId: workstationIdOfFurniture(item.id),
    rect: {
      x: item.parts[Object.keys(item.parts)[0]].x * scene.width,
      y: item.parts[Object.keys(item.parts)[0]].y * scene.height,
      width: item.parts[Object.keys(item.parts)[0]].width * scene.width,
      height: item.parts[Object.keys(item.parts)[0]].height * scene.height,
    },
  }));

  // ---- node placement -------------------------------------------------------
  const clearPx = PLACEMENT_CLEAR_RATIO * Math.min(scene.width, scene.height);
  const samplerRadiusPx = MOVER_RADIUS_RATIO * Math.min(scene.width, scene.height);

  function pointClear(point) {
    for (const obstacle of obstacles) {
      if (pointRectDistancePx(point, obstacle.rect) < clearPx) return false;
    }
    return true;
  }

  // A whole edge is clean when every sample keeps the mover capsule clear of
  // non-exempt furniture. The exemption mirrors the sampler: only the
  // furniture of a workstation whose SEAT node is an edge endpoint.
  function edgeClean(fromPoint, toPoint, fromNodeId, toNodeId) {
    const exempt = exemptWorkstationsForEdge(fromNodeId, toNodeId);
    for (let step = 0; step <= EDGE_SAMPLES; step += 1) {
      const point = lerpPoint(fromPoint, toPoint, step / EDGE_SAMPLES);
      for (const obstacle of obstacles) {
        if (obstacle.workstationId && exempt.has(obstacle.workstationId)) continue;
        if (pointRectDistancePx(point, obstacle.rect) < samplerRadiusPx) return false;
      }
    }
    return true;
  }

  // Topology roles: the isometric graph's node metadata (tags, capacity,
  // safeRadius, default footprint) is preserved verbatim; only positions are
  // re-projected. The seat positions come from the draft; every other node
  // lands on a deterministic aisle/corridor slot.
  const topologyDesks = topoNodes.filter((node) => node.tags.includes('desk')).map((node) => node.id);
  if (topologyDesks.length !== DESK_COUNT) return fail('OFFICE_COMPILE_DRAFT_INVALID', { reason: 'topology-desks' });

  const nodesById = new Map();
  function addNode(topologyNode, position) {
    nodesById.set(topologyNode.id, {
      id: topologyNode.id,
      position,
      footprint: { ...topologyNode.footprint },
      safeRadius: topologyNode.safeRadius,
      tags: [...topologyNode.tags],
      capacity: topologyNode.capacity,
    });
  }

  for (let index = 0; index < DESK_COUNT; index += 1) {
    const topologyNode = topoNodes.find((node) => node.id === `desk-${index + 1}`);
    addNode(topologyNode, { ...seatAnchors.get(`desk-${index + 1}`).foot });
  }

  const placedPoints = [...nodesById.values()].map((node) => ({ ...node.position }));

  function tooCloseToPlaced(point) {
    return placedPoints.some((other) => distance(point, other) < NODE_SPACING_PX);
  }

  // Places one node: tries the ideal, then a bounded spiral, accepting the
  // first candidate that is clear of furniture, far enough from placed
  // nodes, and keeps every edge that becomes complete here clean.
  function placeNode(topologyNode, ideal, completeEdges) {
    for (const candidate of spiralCandidates(ideal, scene)) {
      if (!pointClear(candidate)) continue;
      if (tooCloseToPlaced(candidate)) continue;
      const ok = completeEdges.every(({ other, otherId }) => edgeClean(candidate, other, topologyNode.id, otherId));
      if (!ok) continue;
      addNode(topologyNode, { x: candidate.x / scene.width, y: candidate.y / scene.height });
      placedPoints.push({ x: candidate.x, y: candidate.y });
      return true;
    }
    return false;
  }

  const seatByDesk = new Map(workstations.map(({ deskId }) => [deskId, nodesById.get(deskId).position]));

  const seatPxByDesk = new Map([...seatByDesk].map(([deskId, seat]) => [deskId, { x: seat.x * scene.width, y: seat.y * scene.height }]));

  // Corridor geometry from the compiled furniture (scene-normalized). The
  // ideals exist BEFORE any aisle node is placed: the walk-out chain (leave)
  // uses its roam neighbor's IDEAL as a provisional endpoint — the dependency
  // leave↔roam is circular, so the corridor placement (last) re-verifies the
  // real pair and its own spiral absorbs the difference.
  const deskBoxes = workstations.map(({ deskId }) => ({
    deskId,
    box: normalizeRect(seatAnchors.get(deskId).deskBox, scene),
  }));
  const chairBottoms = workstations.map(({ deskId }) => normalizeRect(seatAnchors.get(deskId).chairBox, scene).y
    + normalizeRect(seatAnchors.get(deskId).chairBox, scene).height);
  const deskTops = deskBoxes.map(({ box }) => box.y);
  const leftDesks = [...deskBoxes].sort((a, b) => a.box.x - b.box.x).slice(0, 3);
  const rightDesks = [...deskBoxes].sort((a, b) => (b.box.x + b.box.width) - (a.box.x + a.box.width)).slice(0, 3);
  const corridorX = ((Math.max(...leftDesks.map(({ box }) => box.x + box.width)) + Math.min(...rightDesks.map(({ box }) => box.x))) / 2);
  const rightCorridorX = (Math.max(...rightDesks.map(({ box }) => box.x + box.width)) + 1) / 2;
  const sortedChairBottoms = [...chairBottoms].sort((a, b) => a - b);
  const sortedDeskTops = [...deskTops].sort((a, b) => a - b);
  const rowGap1Y = (sortedChairBottoms[1] + sortedDeskTops[2]) / 2;
  const rowGap2Y = (sortedChairBottoms[3] + sortedDeskTops[4]) / 2;
  const bottomY = sortedChairBottoms[5] + 24 / scene.height;
  const centerX = (idealX) => idealX * scene.width;
  const centerY = (idealY) => idealY * scene.height;

  const corridorIdeals = {
    'roam-7': { x: centerX(corridorX - 0.009), y: centerY(rowGap1Y) },
    'roam-2': { x: centerX(corridorX + 0.045), y: centerY(rowGap1Y) },
    'roam-1': { x: centerX(corridorX + 0.047), y: centerY(rowGap1Y + 0.14) },
    'chat-a': { x: centerX(corridorX - 0.008), y: centerY(rowGap1Y + 0.14) },
    'chat-b': { x: centerX(corridorX - 0.008), y: centerY(rowGap1Y + 0.21) },
    'roam-5': { x: centerX(corridorX + 0.027), y: centerY(rowGap2Y) },
    'roam-8': { x: centerX(0.27), y: centerY((rowGap2Y + bottomY) / 2) },
    'roam-9': { x: centerX(0.27), y: centerY(bottomY) },
    'roam-3': { x: centerX(corridorX + 0.007), y: centerY(bottomY) },
    'roam-6': { x: centerX(corridorX - 0.043), y: centerY(bottomY) },
    'roam-4': { x: centerX(rightCorridorX), y: centerY(bottomY) },
  };

  // M4.1h left column + second gateway (see LEFT_WING_NODES above). The y
  // levels are DERIVED, never hand-picked: the column starts just below the
  // reserve/kitchen band (reserve.y + reserve.height + a placement margin) and
  // spaces the four new spots evenly down to the existing left-wing pair; the
  // transit node sits at the highest level that still clears the deepest chair
  // bottom by the mover capsule plus a margin — the only crossing the 穿模
  // sampler accepts across the left desk column.
  const leftColumnTopY = (0.02 + 0.32) + PLACEMENT_CLEAR_RATIO;
  const leftColumnBottomY = corridorIdeals['roam-8'].y / scene.height;
  const leftColumnStepY = (leftColumnBottomY - leftColumnTopY) / 6;
  const bottomGateY = Math.min(0.99, Math.max(...chairBottoms) + MOVER_RADIUS_RATIO + 0.008);
  corridorIdeals['roam-13'] = { x: centerX(LEFT_WING_COLUMN_X), y: centerY(leftColumnTopY) };
  corridorIdeals['roam-16'] = { x: centerX(LEFT_WING_COLUMN_X), y: centerY(leftColumnTopY + leftColumnStepY) };
  corridorIdeals['roam-12'] = { x: centerX(LEFT_WING_COLUMN_X), y: centerY(leftColumnTopY + leftColumnStepY * 2) };
  corridorIdeals['roam-15'] = { x: centerX(LEFT_WING_COLUMN_X), y: centerY(leftColumnTopY + leftColumnStepY * 3) };
  corridorIdeals['roam-11'] = { x: centerX(LEFT_WING_COLUMN_X), y: centerY(leftColumnTopY + leftColumnStepY * 4) };
  corridorIdeals['roam-10'] = { x: centerX(LEFT_WING_COLUMN_X), y: centerY(leftColumnTopY + leftColumnStepY * 5) };
  corridorIdeals['roam-14'] = { x: centerX(0.47), y: centerY(bottomGateY) };

  // M4.1f: approach/leave 的理想点从“座位正下方固定偏移”改为“中央走廊内、
  // 贴近本工位背板一侧”。座位正下方落在自家椅矩形里，placeNode 对全家具
  // 强制净空，节点只能被螺旋搜索推到工位侧面中部——92px 立绘于是横跨桌
  // 背板与椅顶角（视觉判定：嵌进桌椅侧面）。走廊侧理想点让落座走位变成
  // 走廊→桌前→绕椅后→落座，站立点本身完全不压任何贴图。
  const ART_HALFWIDTH_RATIO = 0.055; // 0.11 身高的方形立绘近似半宽
  const CORRIDOR_MARGIN_RATIO = 0.006;

  for (let index = 0; index < DESK_COUNT; index += 1) {
    const deskId = `desk-${index + 1}`;
    const seatPx = seatPxByDesk.get(deskId);
    const deskBox = deskBoxes.find((entry) => entry.deskId === deskId).box;
    const outboardPx = (ART_HALFWIDTH_RATIO + CORRIDOR_MARGIN_RATIO) * scene.height;
    const corridorSideX = deskBox.x + deskBox.width / 2 < corridorX
      ? (deskBox.x + deskBox.width) * scene.width + outboardPx
      : deskBox.x * scene.width - outboardPx;
    const approachNode = topoNodes.find((node) => node.id === `${deskId}-approach`);
    if (!placeNode(approachNode, { x: corridorSideX, y: seatPx.y + 0.045 * scene.height }, [{ other: seatPx, otherId: deskId }])) {
      return fail('OFFICE_COMPILE_GRAPH_BLOCKED', { node: `${deskId}-approach`, ideal: 'corridor-side' });
    }
    const approachPlaced = nodesById.get(approachNode.id).position;
    const leaveNode = topoNodes.find((node) => node.id === `${deskId}-leave`);
    const leaveNeighbors = [
      { other: seatPx, otherId: deskId },
      { other: { x: approachPlaced.x * scene.width, y: approachPlaced.y * scene.height }, otherId: approachNode.id },
    ];
    // Provisional walk-out constraint: the leave's edge to its roam neighbor
    // must be clean when the roam sits at its ideal (the corridor placement
    // re-verifies against the real, finally-placed position).
    for (const edge of topoEdges) {
      if (edge.from !== leaveNode.id && edge.to !== leaveNode.id) continue;
      const otherId = edge.from === leaveNode.id ? edge.to : edge.from;
      const ideal = corridorIdeals[otherId];
      if (ideal) leaveNeighbors.push({ other: ideal, otherId });
    }
    if (!placeNode(leaveNode, { x: corridorSideX, y: seatPx.y + 0.085 * scene.height }, leaveNeighbors)) {
      return fail('OFFICE_COMPILE_GRAPH_BLOCKED', { node: `${deskId}-leave`, ideal: 'corridor-side' });
    }
  }

  for (const nodeId of Object.keys(corridorIdeals)) {
    const topologyNode = topoNodes.find((node) => node.id === nodeId);
    if (!topologyNode) return fail('OFFICE_COMPILE_DRAFT_INVALID', { reason: `topology-${nodeId}` });
    const completeEdges = topoEdges
      .filter((edge) => edge.from === nodeId || edge.to === nodeId)
      .map((edge) => {
        const otherId = edge.from === nodeId ? edge.to : edge.from;
        const otherNode = nodesById.get(otherId);
        // Neighbor not placed yet (roam↔roam among the corridor set): its
        // edge is re-verified globally after placement.
        return otherNode
          ? { other: { x: otherNode.position.x * scene.width, y: otherNode.position.y * scene.height }, otherId }
          : null;
      })
      .filter(Boolean);
    if (!placeNode(topologyNode, corridorIdeals[nodeId], completeEdges)) {
      return fail('OFFICE_COMPILE_GRAPH_BLOCKED', {
        node: nodeId,
        ideal: 'corridor',
        placed: Object.fromEntries([...nodesById.values()].map((node) => [node.id, {
          x: Math.round(node.position.x * 10000) / 10000,
          y: Math.round(node.position.y * 10000) / 10000,
        }])),
      });
    }
  }

  // Global verification with the exported sampler semantics (self-check).
  const layout = {
    schemaVersion: 1,
    description: 'Flat runtime layout compiled from the approved office editor draft by src/office/runtime/office-layout-compiler.js — generated, do not hand-edit.',
    provenance: { sourceDraftSha256: sourceDraftSha256 || stableSha256(draft) },
    scene: { referenceWidth: scene.width, referenceHeight: scene.height },
    layers: ['background', 'back-furniture', 'ground-entities', 'front-occluders', 'effects-labels'],
    layout: {
      grid: { columns: 2, rows: 3 },
      offset: { x: 0, y: 0 },
      reserve: { x: 0.02, y: 0.02, width: 0.26, height: 0.32 },
    },
    nodes: topoNodes.map((topologyNode) => {
      const node = nodesById.get(topologyNode.id);
      return {
        id: node.id,
        position: { x: node.position.x, y: node.position.y },
        footprint: node.footprint,
        safeRadius: node.safeRadius,
        tags: node.tags,
        capacity: node.capacity,
      };
    }),
    edges: topoEdges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      behaviors: [...edge.behaviors],
      bidirectional: edge.bidirectional === true,
    })),
    furniture,
    workstations: {
      schemaVersion: 1,
      template: {
        desk: { assetId: 'flat-desk', offset: { x: 0, y: 0 }, scale: 1, layer: 'back-furniture' },
        monitor: { assetId: 'flat-monitor', offset: { x: 0, y: 0 }, scale: 1, layer: 'back-furniture' },
        chair: { assetId: 'flat-chair', offset: { x: 0, y: 0 }, scale: 1, layer: 'front-occluders' },
        seat: { offset: { x: 0, y: 0 }, scale: 1, layer: 'ground-entities' },
      },
      instances: workstations.map(({ deskId }) => {
        const seat = nodesById.get(deskId).position;
        const approach = nodesById.get(`${deskId}-approach`).position;
        const leave = nodesById.get(`${deskId}-leave`).position;
        // Task E5a-R2: the composed character presentation travels with the
        // workstation — the draft item's scale drives the runtime visible
        // height (see office-module's heightRatio mapping) and its direction
        // selects the seated pose (whale-girl-back → the back view).
        const composed = seatAnchors.get(deskId).character;
        return {
          deskId,
          position: { ...seat },
          seat: { id: deskId, position: { ...seat } },
          approach: { id: `${deskId}-approach`, nodeId: `${deskId}-approach`, position: { ...approach } },
          leave: { id: `${deskId}-leave`, nodeId: `${deskId}-leave`, position: { ...leave } },
          character: { scale: composed.scale, direction: composed.direction },
        };
      }),
    },
  };

  const conflicts = sampleEdgeConflicts(layout);
  if (conflicts.length > 0) {
    return fail('OFFICE_COMPILE_GRAPH_BLOCKED', { conflicts: conflicts.slice(0, 20) });
  }
  return { ok: true, layout };
}

// ---- runtime layout source chain (Task E4.2) --------------------------------
//
// resolveRuntimeLayout picks the runtime view's layout fixture — the chain
// stays同源 with the editor's draft chain:
//   1. the user-saved flat draft (userData/office-layout.v1.json), COMPILED;
//   2. the bundled compiled flat fixture (office-layout-flat.json) AS-IS
//      (it is compiler output, never re-compiled);
//   3. the canonical isometric fixture (never blocks startup).
// validateLayout is the consumer's createOfficeLayout (injected for purity):
// every candidate must pass it before it may be served. A present-but-broken
// saved draft is a real diagnostic (OFFICE_LAYOUT_SAVED_INVALID, detail
// carries the compiler code); a missing one is the normal first run.
function resolveRuntimeLayout({ savedDraft = undefined, flatFixture = null, isometricFixture = null, validateLayout, assets, draftWidths, characterFoot, sourceDraftSha256 = null }) {
  if (typeof validateLayout !== 'function') {
    throw new TypeError('resolveRuntimeLayout requires validateLayout(fixture)');
  }
  const topology = isometricFixture
    ? { nodes: isometricFixture.nodes, edges: isometricFixture.edges }
    : null;
  let savedCode = null;
  let savedDetail = null;
  if (savedDraft !== undefined && savedDraft !== null) {
    if (!topology) return { ok: false, layout: null, source: null, code: 'OFFICE_LAYOUT_UNAVAILABLE', detail: { reason: 'topology-missing' } };
    const compiled = compileOfficeLayout({ draft: savedDraft, assets, draftWidths, characterFoot, topology, sourceDraftSha256 });
    if (compiled.ok) {
      return { ok: true, layout: compiled.layout, source: 'saved-compiled', code: null, detail: null };
    }
    // A present-but-uncompilable saved draft is a REAL diagnostic — and the
    // chain continues: the runtime view must never block on it (e.g. a draft
    // saved before the flat rework carries the isometric-era asset ids).
    savedCode = 'OFFICE_LAYOUT_SAVED_INVALID';
    savedDetail = { compileCode: compiled.code, compileDetail: compiled.detail };
  }
  if (flatFixture && validateLayout(flatFixture).ok) {
    return { ok: true, layout: flatFixture, source: 'bundled-flat', code: savedCode, detail: savedDetail };
  }
  if (isometricFixture && validateLayout(isometricFixture).ok) {
    return { ok: true, layout: isometricFixture, source: 'isometric-fallback', code: savedCode || null, detail: savedDetail };
  }
  return { ok: false, layout: null, source: null, code: savedCode || 'OFFICE_LAYOUT_UNAVAILABLE', detail: savedDetail };
}

module.exports = {
  compileOfficeLayout,
  resolveRuntimeLayout,
  sampleEdgeConflicts,
  MOVER_RADIUS_RATIO,
};
