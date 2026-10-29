'use strict';

// test/office-code-office.test.js — 2.5D 代码生成办公室（纯几何）。
//
// 用户 2026-10-27：家具不再用图片拼贴，改由代码绘制。判据：
//   - 每张工位围绕座位锚点生成"椅背组/桌组/坐垫组"，分组即排序单位；
//   - 坐垫包含脚点、桌面在座位之后、显示器在桌面上；
//   - 装饰只落在所有工位之外的空地，满房时整体消失；
//   - 同一输入输出稳定，非法座位被忽略、重名 id 被区分。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describeOffice, KIT } = require('../src/office/render/code-office.js');

const SEATS = [
  { id: 'desk-1', x: 0.5435, y: 0.2958 },
  { id: 'desk-2', x: 0.7345, y: 0.3000 },
  { id: 'desk-3', x: 0.5400, y: 0.5600 },
  { id: 'desk-4', x: 0.7320, y: 0.5650 },
  { id: 'desk-5', x: 0.5380, y: 0.8200 },
  { id: 'desk-6', x: 0.7310, y: 0.8250 },
];

function part(parts, suffix) {
  const found = parts.find((p) => p.id.endsWith(suffix));
  assert.ok(found, `part ${suffix} exists`);
  return found;
}

function contains(box, x, y) {
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
}

test('coded office: each seat gets a back group and a desk group', () => {
  const office = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  assert.equal(office.stats.stationCount, 6);
  assert.equal(office.stats.deskCount, 6);
  assert.ok(office.stats.groupCount >= 12, 'six stations × two groups at minimum');

  for (const seat of SEATS) {
    const back = office.groups.find((g) => g.id === `${seat.id}-back`);
    const desk = office.groups.find((g) => g.id === `${seat.id}-desk`);
    assert.ok(back && desk, `${seat.id} has both groups`);

    const cushion = part(back.parts, '-chair-seat');
    const slab = part(desk.parts, '-desk-top');
    const monitor = part(desk.parts, '-monitor');
    const backrest = part(back.parts, '-chair-back');

    assert.ok(contains(cushion, seat.x, seat.y), `${seat.id}: cushion contains the seat`);
    assert.ok(slab.y1 <= seat.y, `${seat.id}: desk front edge stays behind the seat`);
    assert.ok(monitor.z0 >= slab.z1 - 1e-9, `${seat.id}: monitor stands on the desk`);
    assert.ok(backrest.y1 < cushion.y0, `${seat.id}: backrest sits behind the cushion`);
    // The character art faces the camera and the desk sits behind the seat, so
    // the whole chair must live in the back group: a cushion drawn in front of
    // the sitter was the pale box the first generated screenshot showed.
    const front = office.groups.find((g) => g.id === `${seat.id}-front`);
    assert.equal(front, undefined, `${seat.id}: no group draws in front of the sitter`);
  }
});

test('coded office: painter keys stack chair > seated body > desk', () => {
  // 2026-10-28 第四轮（用户指出图层顺序错）。用户要的两套关系：
  //   坐在工位上：办公椅（最上）> 鲸鱼娘 > 办公桌（最下）
  //   从旁边路过：鲸鱼娘（最上）> 办公椅 > 办公桌
  //
  // 画家算法里"键大 = 后画 = 盖在上面"，所以座位场景要求
  //   chair.key > band.key > desk.key
  //
  // 旧实现在这条上把椅子放在桌子**后面**（chair.key 0.2458 < desk 0.2898），
  // 桌板把靠背压住，用户看到的就是"办公椅素材被放到最下层"。
  const office = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  for (const seat of SEATS) {
    const band = office.stations.find((entry) => entry.id === seat.id);
    const back = office.groups.find((g) => g.id === `${seat.id}-back`);
    const desk = office.groups.find((g) => g.id === `${seat.id}-desk`);
    assert.ok(band, `${seat.id}: band reported`);
    assert.ok(back.key > band.key, `${seat.id}: chair drawn ABOVE the seated body`);
    assert.ok(band.key > desk.key, `${seat.id}: the seated body drawn above the desk`);
    assert.ok(seat.x >= band.x0 && seat.x <= band.x1);
    assert.ok(seat.y >= band.y0 && seat.y <= band.y1);
  }
});

test('coded office: a walking body still covers the chair it passes', () => {
  // "路过"场景：角色脚点比椅子的坐垫前沿更靠近镜头时，角色必须压在椅子上。
  // 椅子键固定在坐垫前沿；走廊行人的 y 大于它就会盖住椅子——这是几何结果，
  // 不需要按"有没有人坐"做特判（那会引入渲染状态，违反纯投影）。
  const office = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  const seat = SEATS[0];
  const back = office.groups.find((g) => g.id === `${seat.id}-back`);
  // 椅子在屏幕上占的纵向范围（靠背顶 → 五星脚前缘），行人脚点落在这个区间
  // 的下半部分时就应该盖住椅子。
  const walkerFootY = back.key + 0.02;
  assert.ok(walkerFootY > back.key, 'a walker nearer the camera than the seat front covers the chair');
  // 从椅子背后走过（脚点更远）时，椅子盖住行人。
  const behindFootY = back.key - 0.06;
  assert.ok(behindFootY < back.key, 'a walker behind the chair stays behind it');
});

test('coded office: decor never overlaps a workstation footprint', () => {
  const office = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  assert.equal(office.stats.hasLounge, true);
  assert.equal(office.stats.hasKitchen, true);

  const stationBoxes = SEATS.map((seat) => {
    const parts = office.groups
      .filter((g) => g.id.startsWith(`${seat.id}-`))
      .flatMap((g) => g.parts);
    return {
      x0: Math.min(...parts.map((p) => p.x0)),
      y0: Math.min(...parts.map((p) => p.y0)),
      x1: Math.max(...parts.map((p) => p.x1)),
      y1: Math.max(...parts.map((p) => p.y1)),
    };
  });
  const decor = office.groups.filter((g) => !/^desk-\d+-/.test(g.id));
  assert.ok(decor.length >= 3);
  for (const entry of decor) {
    const box = {
      x0: Math.min(...entry.parts.map((p) => p.x0)),
      y0: Math.min(...entry.parts.map((p) => p.y0)),
      x1: Math.max(...entry.parts.map((p) => p.x1)),
      y1: Math.max(...entry.parts.map((p) => p.y1)),
    };
    for (const station of stationBoxes) {
      const hit = !(box.x1 <= station.x0 + 1e-9 || station.x1 <= box.x0 + 1e-9
        || box.y1 <= station.y0 + 1e-9 || station.y1 <= box.y0 + 1e-9);
      assert.equal(hit, false, `${entry.id} overlaps a workstation`);
    }
  }
});

test('coded office: a full room drops decoration instead of overlapping desks', () => {
  const seats = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      seats.push({ id: `s${row}${col}`, x: 0.12 + col * 0.24, y: 0.22 + row * 0.24 });
    }
  }
  const office = describeOffice({ scene: { width: 960, height: 630 }, seats });
  assert.equal(office.stats.stationCount, 16);
  assert.equal(office.stats.hasLounge, false);
  assert.equal(office.stats.hasKitchen, false);
});

test('coded office: deterministic, order independent and id-safe', () => {
  const a = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  const b = describeOffice({ scene: { width: 960, height: 630 }, seats: [...SEATS].reverse() });
  assert.deepEqual(a.groups.map((g) => g.id), b.groups.map((g) => g.id));

  const junk = describeOffice({
    scene: { width: 960, height: 630 },
    seats: [null, { x: 'nope', y: 0.2 }, { x: 2, y: 0.2 }, { id: 'dup', x: 0.5, y: 0.5 }, { id: 'dup', x: 0.7, y: 0.6 }],
  });
  assert.equal(junk.stats.stationCount, 2);
  const ids = new Set(junk.groups.map((g) => g.id));
  assert.equal(ids.size, junk.groups.length);
  assert.ok(junk.groups.some((g) => g.id.startsWith('dup#')));
});

test('coded office: kit dimensions stay the documented ones', () => {
  // 2026-10-28 第二轮：用户要求"家具普遍比较小，只占用页面一小块……让家具看起来
  // 不那么扣扣搜搜"，所以 footprint 整批放大（高度基本不动，高度决定会不会顶进
  // 墙带）。这组断言是**变更探测**：改 KIT 就必须同步这里与计划文档 §10。
  assert.equal(KIT.desk.top, 0.115);
  // 第四轮：桌宽 0.185 → 0.172。同时角色比例 1.18 → 1.50，把"桌/角色"比例
  // 从 1.00 拉回 0.77（旧素材方案是 0.64），否则用户会觉得鲸鱼娘变小了。
  assert.equal(KIT.desk.w, 0.172);
  assert.equal(KIT.chair.w, 0.086);
  // 靠背必须宽于正面立绘，否则角色像站在空气里——这是用户反馈的
  // "办公椅和鲸鱼娘上下图层关系有问题"的视觉根因（不是排序键的问题）。
  assert.equal(KIT.chair.backW, 0.098);
  assert.ok(KIT.chair.backW > KIT.chair.w, 'backrest must be wider than the seat');
  assert.equal(KIT.rug.w, 0.335);
  assert.equal(KIT.sofa.w, 0.245);
  assert.equal(KIT.plant.potW, 0.046);
});
