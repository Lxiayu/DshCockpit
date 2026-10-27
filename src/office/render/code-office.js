'use strict';

// src/office/render/code-office.js — P3.1 代码生成的办公室布局（纯几何）。
//
// 用户 2026-10-27 的反馈："现在的家具布置是受图片素材限制拼起来的，探索用代码
// 生成一整套办公室布局，大胆一些。"
//
// 这个模块不读快照、不碰 Pixi：它只把**功能锚点**（每张工位的 seat 坐标、预留区）
// 变成一套视觉布局。桌/椅/显示器围绕 seat 按规则生成，所以角色的就座点、走路图
// 与命中测试完全不变；变的只是"画什么"。装饰区（休闲区、茶水间、绿植）放在
// 功能上不占用的空白区域，规则显式、可测试。

// 尺寸都是归一化坐标（0..1，y 向下）。
const DESK = Object.freeze({ w: 0.118, d: 0.118, gapAboveSeat: 0.006, height: 0.032 });
const MONITOR = Object.freeze({ w: 0.076, h: 0.088, lift: 0.004, height: 0.038 });
const CHAIR = Object.freeze({ w: 0.054, h: 0.118, aboveSeat: 0.052, height: 0.024 });
const KEYBOARD = Object.freeze({ w: 0.052, h: 0.018 });
const MUG = Object.freeze({ r: 0.0055 });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readSeats(seats) {
  if (!Array.isArray(seats)) return [];
  const out = [];
  for (const seat of seats) {
    if (!seat || typeof seat !== 'object') continue;
    const x = Number(seat.x);
    const y = Number(seat.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    out.push({ id: typeof seat.id === 'string' ? seat.id : `seat-${out.length + 1}`, x, y });
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function rect(x, y, w, h) {
  return { x, y, w, h };
}

/**
 * Build the generated office layout.
 *
 * @param {object} input
 * @param {{width:number,height:number}} input.scene
 * @param {Array<{id:string,x:number,y:number}>} input.seats  normalized seat anchors
 * @param {{x:number,y:number,width:number,height:number}} [input.reserve]
 */
function describeOffice(input) {
  const options = input || {};
  const seats = readSeats(options.seats);
  const width = Number(options.scene && options.scene.width) > 0 ? Number(options.scene.width) : 1280;
  const height = Number(options.scene && options.scene.height) > 0 ? Number(options.scene.height) : 840;

  const workstations = seats.map((seat) => {
    const desk = rect(
      clamp(seat.x - DESK.w / 2, 0.01, 0.99 - DESK.w),
      clamp(seat.y - DESK.d + DESK.gapAboveSeat, 0.02, 0.98 - DESK.d),
      DESK.w,
      DESK.d
    );
    const monitor = rect(
      clamp(seat.x - MONITOR.w / 2, 0.01, 0.99 - MONITOR.w),
      clamp(desk.y - MONITOR.h + MONITOR.lift, 0.01, desk.y + 0.02),
      MONITOR.w,
      MONITOR.h
    );
    const chair = rect(
      clamp(seat.x - CHAIR.w / 2, 0.01, 0.99 - CHAIR.w),
      clamp(seat.y - CHAIR.aboveSeat, 0.02, 0.98 - CHAIR.h),
      CHAIR.w,
      CHAIR.h
    );
    const keyboard = rect(
      clamp(seat.x - KEYBOARD.w / 2, desk.x + 0.006, desk.x + desk.w - KEYBOARD.w - 0.006),
      desk.y + desk.d * 0.52,
      KEYBOARD.w,
      KEYBOARD.h
    );
    return {
      seatId: seat.id,
      seat,
      desk,
      monitor,
      chair,
      keyboard,
      mug: { x: desk.x + desk.w * 0.82, y: desk.y + desk.d * 0.52, r: MUG.r },
      drawer: {
        ...rect(desk.x + desk.w * 0.78, desk.y + desk.d * 0.18, desk.w * 0.18, desk.d * 0.62),
        height: 0.016,
      },
      height: DESK.height,
      monitorHeight: MONITOR.height,
      chairHeight: CHAIR.height,
    };
  });

  // A desk occupies a vertical band [seat.y - d, seat.y + ~0.07]; decoration
  // may only use space clear of every band.
  const occupied = workstations.map((station) => ({
    x: Math.min(station.chair.x, station.desk.x),
    y: station.monitor.y,
    w: Math.max(station.chair.x + station.chair.w, station.desk.x + station.desk.w) - Math.min(station.chair.x, station.desk.x),
    h: (station.chair.y + station.chair.h) - station.monitor.y,
  }));
  const free = (candidate) => occupied.every((box) => (
    candidate.x + candidate.w <= box.x
    || box.x + box.w <= candidate.x
    || candidate.y + candidate.h <= box.y
    || box.y + box.h <= candidate.y
  ));

  // Lounge: the largest free block in the lower-left quadrant.
  const loungeCandidates = [
    rect(0.03, 0.60, 0.22, 0.30),
    rect(0.03, 0.55, 0.20, 0.26),
    rect(0.02, 0.64, 0.18, 0.24),
  ];
  const loungeRect = loungeCandidates.find(free) || null;
  const lounge = loungeRect ? {
    ...loungeRect,
    rug: { x: loungeRect.x, y: loungeRect.y, w: loungeRect.w, h: loungeRect.h },
    sofa: {
      x: loungeRect.x + 0.012,
      y: loungeRect.y + loungeRect.h - 0.085,
      w: loungeRect.w - 0.024,
      h: 0.062,
    },
    table: {
      x: loungeRect.x + loungeRect.w * 0.30,
      y: loungeRect.y + loungeRect.h * 0.24,
      w: loungeRect.w * 0.40,
      h: loungeRect.h * 0.26,
      height: 0.028,
    },
    sofaHeight: 0.045,
  } : null;

  // Kitchen: a counter along the top-left, above the lounge band.
  const kitchenCandidates = [
    rect(0.03, 0.19, 0.20, 0.12),
    rect(0.03, 0.24, 0.17, 0.10),
    rect(0.02, 0.30, 0.15, 0.09),
  ];
  const kitchenRect = kitchenCandidates.find((candidate) => free(candidate)
    && (!lounge || candidate.y + candidate.h <= lounge.y));
  const kitchen = kitchenRect ? {
    ...kitchenRect,
    sink: { x: kitchenRect.x + kitchenRect.w * 0.62, y: kitchenRect.y + kitchenRect.h * 0.30, r: kitchenRect.h * 0.16 },
    machine: {
      x: kitchenRect.x + kitchenRect.w * 0.18,
      y: kitchenRect.y + kitchenRect.h * 0.22,
      w: kitchenRect.w * 0.20,
      h: kitchenRect.h * 0.46,
      height: 0.030,
    },
    height: 0.045,
  } : null;

  // Plants in the corners, only where nothing else needs the space.
  const plantSpots = [
    { x: 0.035, y: 0.90, r: 0.028 },
    { x: 0.955, y: 0.88, r: 0.026 },
    { x: 0.955, y: 0.56, r: 0.024 },
    { x: 0.035, y: 0.50, r: 0.024 },
  ];
  const plants = plantSpots.filter((spot) => free({
    x: spot.x - spot.r, y: spot.y - spot.r * 2.2, w: spot.r * 2, h: spot.r * 2.2,
  }));

  return {
    scene: { width, height },
    workstations,
    lounge,
    kitchen,
    plants,
    stats: {
      desks: workstations.length,
      hasLounge: !!lounge,
      hasKitchen: !!kitchen,
      plants: plants.length,
    },
  };
}

module.exports = { describeOffice, DESK, MONITOR, CHAIR };
