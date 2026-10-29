'use strict';

// src/office/render/iso-office.js — I2：等轴测下的办公室家具（纯几何，零依赖）。
//
// 世界坐标：x/y ∈ 0..1（与快照里的 position 同一套坐标），z 向上，单位与 x/y
// 相同（1.0 = 整个房间进深）。投影由 iso-projection.js 负责，这里只回答
// "有哪些长方体、放在哪、多高、什么材质、要不要画细节"。
//
// 布局规则（与平面生成布局同一套功能语义，尺寸按等轴测重新标定）：
//   - 每张工位：桌面在座位**后方**（y 更小，靠墙），显示器在桌面后沿，
//     键盘/杯子在桌面前沿，抽屉在桌面右下，椅背在座位上后方、坐垫在脚下。
//   - 休闲区/茶水间/绿植只能占用所有工位包围盒之外的空地，按候选顺序取第一个
//     完全空闲的位置；没有空地就不放（stats 里记账），绝不压座位。
//
// 每个 part 是一个轴对齐长方体 + 材质角色（tone）+ 可选细节（detail）。渲染器
// 按 depth = 中心 (x+y) 排序，与角色（脚点 x+y）一起走同一次画家算法。

const SIZES = Object.freeze({
  desk: Object.freeze({ w: 0.20, d: 0.16, top: 0.145, slab: 0.018, leg: 0.016, panel: 0.012 }),
  monitor: Object.freeze({ w: 0.105, d: 0.018, stand: 0.012, screen: 0.070, bezel: 0.007 }),
  chair: Object.freeze({ w: 0.075, d: 0.075, seatZ: 0.055, seatT: 0.016, backT: 0.013, backH: 0.075 }),
  keyboard: Object.freeze({ w: 0.072, d: 0.028, t: 0.006 }),
  mug: Object.freeze({ w: 0.013, h: 0.017 }),
  drawer: Object.freeze({ w: 0.055, d: 0.10, z0: 0.018 }),
  rug: Object.freeze({ w: 0.26, d: 0.18, t: 0.002 }),
  sofa: Object.freeze({ w: 0.20, d: 0.08, seatZ: 0.048, seatT: 0.018, backH: 0.075 }),
  table: Object.freeze({ w: 0.095, d: 0.065, top: 0.048, slab: 0.012 }),
  counter: Object.freeze({ w: 0.07, d: 0.20, top: 0.11, slab: 0.02 }),
  machine: Object.freeze({ w: 0.045, d: 0.045, h: 0.045 }),
  plant: Object.freeze({ w: 0.04, h: 0.032, foliage: 0.06 }),
});

const EPS = 1e-6;

function readSeats(seats) {
  if (!Array.isArray(seats)) return [];
  const out = [];
  const used = new Set();
  for (const seat of seats) {
    if (!seat || typeof seat !== 'object') continue;
    const x = Number(seat.x);
    const y = Number(seat.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const base = typeof seat.id === 'string' && seat.id ? seat.id : `seat-${out.length + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}#${n}`;
    used.add(id);
    out.push({ id, x, y });
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function box(id, kind, tone, x0, y0, x1, y1, z0, z1, detail) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const back = Math.min(y0, y1);
  const front = Math.max(y0, y1);
  const bottom = Math.min(z0, z1);
  const top = Math.max(z0, z1);
  return {
    id,
    kind,
    tone,
    detail: detail || null,
    x0: left,
    y0: back,
    x1: right,
    y1: front,
    z0: bottom,
    z1: top,
    // Painter key: the box's centre in (x + y). Characters use their foot
    // point in the same units, so both sort in one pass.
    depth: (left + right + back + front) / 2,
  };
}

function workstationParts(seat) {
  const s = SIZES;
  const parts = [];
  const seatId = seat.id;

  // Desk: front edge just behind the seat so the seated body draws in front.
  const deskFront = seat.y - 0.004;
  const deskBack = deskFront - s.desk.d;
  const deskLeft = seat.x - s.desk.w / 2;
  const deskRight = deskLeft + s.desk.w;
  const deskTopZ = s.desk.top;
  const slabZ = deskTopZ - s.desk.slab;

  parts.push(box(`${seatId}-desk`, 'desk', 'desk',
    deskLeft, deskBack, deskRight, deskFront, slabZ, deskTopZ));
  // Modesty panel across the desk front: with the seated character re-keyed to
  // draw just before the desk, this is what hides her legs (the same "seated
  // bodies sit behind" contract the flat renderer implements by depth alone).
  parts.push(box(`${seatId}-desk-panel`, 'desk-panel', 'deskSide',
    deskLeft, deskFront - s.desk.panel, deskRight, deskFront, 0.02, slabZ, 'panel'));
  // Two side panels ground the desk without a full 4-leg pass.
  parts.push(box(`${seatId}-desk-leg-l`, 'desk-leg', 'deskSide',
    deskLeft, deskBack + 0.01, deskLeft + s.desk.leg, deskFront - 0.01, 0, slabZ));
  parts.push(box(`${seatId}-desk-leg-r`, 'desk-leg', 'deskSide',
    deskRight - s.desk.leg, deskBack + 0.01, deskRight, deskFront - 0.01, 0, slabZ));
  // Drawer block under the right half of the desk.
  const drawerW = Math.min(s.drawer.w, s.desk.w * 0.45);
  parts.push(box(`${seatId}-drawer`, 'drawer', 'deskSide',
    deskRight - drawerW - 0.008, deskBack + 0.012, deskRight - 0.008, deskFront - 0.02,
    s.drawer.z0, slabZ, 'drawer'));

  // Monitor on the desk's back edge, screen facing the seat (+y).
  const monW = Math.min(s.monitor.w, s.desk.w * 0.62);
  const monCx = deskLeft + s.desk.w * 0.42;
  const monBack = deskBack + 0.012;
  const monFront = monBack + s.monitor.d;
  const monBottom = deskTopZ + s.monitor.stand;
  parts.push(box(`${seatId}-monitor-stand`, 'monitor', 'monitorEdge',
    monCx - 0.008, monBack + s.monitor.d * 0.35, monCx + 0.008, monFront - 0.002,
    deskTopZ, monBottom));
  parts.push(box(`${seatId}-monitor`, 'monitor', 'monitor',
    monCx - monW / 2, monBack, monCx + monW / 2, monFront,
    monBottom, monBottom + s.monitor.screen, 'screen'));

  // Keyboard and mug sit on the desk's front half.
  const kbW = Math.min(s.keyboard.w, s.desk.w * 0.5);
  parts.push(box(`${seatId}-keyboard`, 'keyboard', 'monitor',
    seat.x - kbW / 2, deskFront - 0.055, seat.x + kbW / 2, deskFront - 0.055 + s.keyboard.d,
    deskTopZ, deskTopZ + s.keyboard.t, 'keys'));
  parts.push(box(`${seatId}-mug`, 'mug', 'deskSide',
    deskRight - 0.030, deskFront - 0.048, deskRight - 0.030 + s.mug.w, deskFront - 0.048 + s.mug.w,
    deskTopZ, deskTopZ + s.mug.h, 'mug'));

  // Chair: backrest behind the seated body, cushion under it. The backrest is
  // re-keyed to the desk's depth band so a seated character covers it (a chair
  // back behind a person is exactly what the camera cannot see).
  const chairBackY = seat.y - s.chair.d * 0.55;
  const chairBack = box(`${seatId}-chair-back`, 'chair', 'chairBack',
    seat.x - s.chair.w / 2, chairBackY, seat.x + s.chair.w / 2, chairBackY + s.chair.backT,
    s.chair.seatZ, s.chair.seatZ + s.chair.backH);
  chairBack.sortKey = (deskBack + deskFront) / 2 - 0.0005;
  parts.push(chairBack);
  parts.push(box(`${seatId}-chair-seat`, 'chair', 'chairSeat',
    seat.x - s.chair.w / 2, chairBackY, seat.x + s.chair.w / 2, chairBackY + s.chair.d,
    s.chair.seatZ, s.chair.seatZ + s.chair.seatT));

  return parts;
}

// Where a seated body belongs in the painter pass: just before the desk, so
// the desk slab + modesty panel cover her legs. The band covers the desk's
// x-span and the depth from the desk's back edge to the cushion's front edge.
function stationBand(seat, parts) {
  const desk = parts.find((part) => part.kind === 'desk');
  const cushion = parts.find((part) => part.id.endsWith('-chair-seat'));
  if (!desk || !cushion) return null;
  return {
    x0: desk.x0,
    x1: desk.x1,
    y0: desk.y0,
    y1: cushion.y1,
    key: desk.depth - 0.0002,
  };
}

function stationExtent(parts) {
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const part of parts) {
    x0 = Math.min(x0, part.x0);
    y0 = Math.min(y0, part.y0);
    x1 = Math.max(x1, part.x1);
    y1 = Math.max(y1, part.y1);
  }
  return { x0, y0, x1, y1 };
}

function overlaps(a, b) {
  return !(a.x1 <= b.x0 + EPS || b.x1 <= a.x0 + EPS || a.y1 <= b.y0 + EPS || b.y1 <= a.y0 + EPS);
}

function free(rect, occupied) {
  return occupied.every((boxRect) => !overlaps(rect, boxRect));
}

// First candidate that is free and inside the room.
function place(candidates, occupied) {
  for (const candidate of candidates) {
    if (candidate.x0 < 0.01 || candidate.y0 < 0.01 || candidate.x1 > 0.99 || candidate.y1 > 0.99) continue;
    if (free(candidate, occupied)) return candidate;
  }
  return null;
}

function rectAt(x0, y0, w, d) {
  return { x0, y0, x1: x0 + w, y1: y0 + d };
}

function loungeParts(rect) {
  const s = SIZES;
  const parts = [];
  const cx = (rect.x0 + rect.x1) / 2;
  // Rug under everything.
  parts.push(box('lounge-rug', 'rug', 'rug',
    cx - s.rug.w / 2, rect.y0, cx + s.rug.w / 2, rect.y0 + s.rug.d, 0, s.rug.t));
  // Sofa against the back of the block (smaller y), facing the room (+y).
  const sofaW = Math.min(s.sofa.w, rect.x1 - rect.x0);
  const sofaX = cx - sofaW / 2;
  const sofaY = rect.y0 + s.rug.d * 0.12;
  parts.push(box('lounge-sofa-base', 'sofa', 'sofaFront',
    sofaX, sofaY, sofaX + sofaW, sofaY + s.sofa.d, 0.012, s.sofa.seatZ, 'sofa-base'));
  parts.push(box('lounge-sofa-seat', 'sofa', 'sofaSeat',
    sofaX + 0.008, sofaY + 0.008, sofaX + sofaW - 0.008, sofaY + s.sofa.d,
    s.sofa.seatZ, s.sofa.seatZ + s.sofa.seatT));
  parts.push(box('lounge-sofa-back', 'sofa', 'sofa',
    sofaX, sofaY, sofaX + sofaW, sofaY + 0.018,
    s.sofa.seatZ, s.sofa.seatZ + s.sofa.backH));
  // Coffee table in front of the sofa.
  const tableX = cx - s.table.w / 2;
  const tableY = sofaY + s.sofa.d + 0.02;
  parts.push(box('lounge-table', 'table', 'desk',
    tableX, tableY, tableX + s.table.w, tableY + s.table.d,
    s.table.top - s.table.slab, s.table.top, 'table'));
  parts.push(box('lounge-table-leg', 'table-leg', 'deskSide',
    tableX + 0.01, tableY + 0.01, tableX + s.table.w - 0.01, tableY + s.table.d - 0.01,
    0, s.table.top - s.table.slab));
  return parts;
}

function kitchenParts(rect) {
  const s = SIZES;
  const parts = [];
  const counterW = Math.min(s.counter.w, rect.x1 - rect.x0);
  const counterD = Math.min(s.counter.d, rect.y1 - rect.y0);
  const x = rect.x0;
  const y = rect.y0 + (rect.y1 - rect.y0 - counterD) / 2;
  parts.push(box('kitchen-counter', 'counter', 'counter',
    x, y, x + counterW, y + counterD, 0, s.counter.top, 'counter'));
  parts.push(box('kitchen-sink', 'sink', 'counterSide',
    x + counterW * 0.18, y + counterD * 0.10, x + counterW * 0.82, y + counterD * 0.26,
    s.counter.top, s.counter.top + 0.002, 'sink'));
  const machineW = Math.min(s.machine.w, counterW * 0.8);
  parts.push(box('kitchen-machine', 'machine', 'monitor',
    x + (counterW - machineW) / 2, y + counterD * 0.62, x + (counterW + machineW) / 2, y + counterD * 0.62 + s.machine.d,
    s.counter.top, s.counter.top + s.machine.h, 'machine'));
  return parts;
}

function plantParts(id, x, y) {
  const s = SIZES;
  const parts = [];
  parts.push(box(`${id}-pot`, 'plant', 'plantPot',
    x - s.plant.w / 2, y - s.plant.w / 2, x + s.plant.w / 2, y + s.plant.w / 2, 0, s.plant.h, 'pot'));
  parts.push(box(`${id}-foliage`, 'plant', 'plantLeaf',
    x - s.plant.w * 0.62, y - s.plant.w * 0.62, x + s.plant.w * 0.62, y + s.plant.w * 0.62,
    s.plant.h, s.plant.h + s.plant.foliage, 'foliage'));
  return parts;
}

/**
 * Build the isometric office furniture.
 *
 * @param {object} input
 * @param {Array<{id:string,x:number,y:number}>} input.seats world-space seats
 */
function describeIsoOffice(input) {
  const options = input || {};
  const seats = readSeats(options.seats);
  const parts = [];
  const occupied = [];
  const stations = [];

  for (const seat of seats) {
    const station = workstationParts(seat);
    parts.push(...station);
    occupied.push(stationExtent(station));
    const band = stationBand(seat, station);
    if (band) stations.push({ id: seat.id, ...band });
  }

  let lounge = false;
  const loungeRect = place([
    rectAt(0.03, 0.62, 0.30, 0.30),
    rectAt(0.03, 0.55, 0.26, 0.30),
    rectAt(0.66, 0.62, 0.30, 0.30),
    rectAt(0.04, 0.40, 0.24, 0.24),
  ], occupied);
  if (loungeRect) {
    parts.push(...loungeParts(loungeRect));
    occupied.push(rectAt(loungeRect.x0, loungeRect.y0, SIZES.rug.w, SIZES.rug.d));
    lounge = true;
  }

  let kitchen = false;
  const kitchenRect = place([
    rectAt(0.02, 0.04, 0.09, 0.22),
    rectAt(0.88, 0.04, 0.09, 0.22),
    rectAt(0.02, 0.30, 0.09, 0.22),
  ], occupied);
  if (kitchenRect) {
    parts.push(...kitchenParts(kitchenRect));
    occupied.push(kitchenRect);
    kitchen = true;
  }

  const plants = [];
  const plantSpots = [
    ['plant-a', 0.06, 0.06],
    ['plant-b', 0.94, 0.06],
    ['plant-c', 0.06, 0.94],
    ['plant-d', 0.94, 0.94],
  ];
  for (const [id, x, y] of plantSpots) {
    const spot = rectAt(x - 0.03, y - 0.03, 0.06, 0.06);
    if (!free(spot, occupied)) continue;
    parts.push(...plantParts(id, x, y));
    occupied.push(spot);
    plants.push(id);
  }

  // Deterministic ids; a malformed seat can otherwise collide.
  const seen = new Set();
  for (const part of parts) {
    if (seen.has(part.id)) throw new Error(`iso-office: duplicate id ${part.id}`);
    seen.add(part.id);
  }

  const stationCount = seats.length;
  return {
    parts,
    stations,
    seats: seats.map((seat) => ({ id: seat.id, x: seat.x, y: seat.y })),
    stats: {
      stationCount,
      partCount: parts.length,
      deskCount: parts.filter((part) => part.kind === 'desk').length,
      chairCount: parts.filter((part) => part.kind === 'chair').length,
      lounge,
      kitchen,
      plantCount: plants.length,
    },
  };
}

module.exports = {
  describeIsoOffice,
  SIZES,
};
