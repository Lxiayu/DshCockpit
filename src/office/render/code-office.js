'use strict';

// src/office/render/code-office.js — 2.5D：代码生成的办公室家具套件（纯几何）。
//
// 用户 2026-10-27 的反馈：家具和道具原先都是图片素材拼贴——观感不统一、角色走到
// 家具附近会穿模、素材复用与维护也麻烦。从这一版开始，家具、道具与环境装饰全部
// 由代码绘制，角色（鲸鱼娘）仍用已验证的 PNG 帧。
//
// 本模块只做**几何**：把每个座位锚点（世界坐标 0..1）变成一组轴对齐盒子，
// 每个盒子带 footprint（x0,y0,x1,y1）、高度（z0,z1）、材质角色（tone）与可选
// 细节（detail）。渲染器负责"顶面 + 前立面"的 2.5D 画法、颜色、阴影与排序。
//
// 分组（groups）是排序单位：一个工位拆成
//   - back  ：椅背 + 气压杆 + 五星脚（画在坐姿角色之后、桌子之前）
//   - desk  ：桌面/挡板/抽屉/侧板 + 桌面道具（画在坐姿角色之后，盖住腿）
//   - front ：坐垫（画在最前）
// 角色键 = 脚点 y；坐姿角色被重挂到 desk 键之前（见渲染器），于是"桌子盖腿、
// 椅背被身体挡住、坐垫压脚"三件事同时成立，走廊行人仍按真实前后关系穿插。

const EPS = 1e-6;

const KIT = Object.freeze({
  // 2026-10-28 第二轮（用户："家具普遍比较小，只占用页面一小块……让家具看起来不那么
  // 扣扣搜搜"）：整体放大 footprint，**高度基本不变**（高度决定会不会顶进墙带）。
  desk: Object.freeze({ w: 0.172, d: 0.090, top: 0.115, slab: 0.014, leg: 0.012, panel: 0.010 }),
  // P4：屏幕 0.060 / 支架 0.008，总高 0.068 保持不变；放大只放大宽与深。
  monitor: Object.freeze({ w: 0.084, d: 0.014, stand: 0.008, screen: 0.060 }),
  // 背面视角办公椅，对齐旧贴图素材 prop-chair-back.png 的比例：宽背框 + 双扶手
  // + 气压杆 + 五星脚。backW 必须**宽于正面立绘**，否则角色像站在空气里——
  // 这就是用户说的"办公椅和鲸鱼娘的上下图层关系有问题"的视觉根因。
  chair: Object.freeze({
    w: 0.086, backW: 0.098, d: 0.064, seatZ: 0.042, seatT: 0.009,
    backH: 0.112, backT: 0.020, armW: 0.017, armZ: 0.084,
  }),
  // 2026-10-28 第七轮：键盘按"桌宽的 60%"标定（0.104 ≈ 100px / 165px 桌宽），
  // 但纸张不能同比例放大 —— 76×54px 的白纸在 1:1 下像一块白板盖住桌面。
  // 纸张改回接近 A4 的比例（0.058，约 56px），并挪到桌面左后角。
  keyboard: Object.freeze({ w: 0.104, d: 0.031, t: 0.007 }),
  mug: Object.freeze({ w: 0.021, h: 0.022 }),
  papers: Object.freeze({ w: 0.058, d: 0.041 }),
  drawer: Object.freeze({ w: 0.055, z0: 0.030 }),
  counter: Object.freeze({ d: 0.098, top: 0.078, slab: 0.010 }),
  fridge: Object.freeze({ w: 0.068, d: 0.052, top: 0.150 }),
  // seatT 0.015 → 0.024：坐垫前沿从 9px 加到 15px，盖住底座那 16px 深色立面
  // （否则坐垫下方露出一条深凹槽，像沙发被挖空，2026-10-28 第八轮）。
  sofa: Object.freeze({ w: 0.245, d: 0.090, seatZ: 0.032, seatT: 0.024, backH: 0.072, armW: 0.022 }),
  table: Object.freeze({ w: 0.125, d: 0.080, top: 0.034, slab: 0.009 }),
  rug: Object.freeze({ w: 0.335, d: 0.225 }),
  lamp: Object.freeze({ pole: 0.100, shadeW: 0.054, shadeH: 0.034 }),
  // 绿植：4 个物种共用一套盆，但盆径按物种分档（见 plantGroup）。
  plant: Object.freeze({ potW: 0.046, potH: 0.030 }),
});

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

// Deterministic 0..1 jitter keyed off a seat/prop id. Prop placement must
// differ a little per desk (six identical desks read as a texture tile) yet
// never vary between frames: the renderer is a pure projection of the
// snapshot, so Math.random() is forbidden here too.
function hash01Seat(seed) {
  let h = 2166136261 >>> 0;
  const text = String(seed);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
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
  };
}

function makeGroup(id, kind, key, parts) {
  return { id, kind, key, parts };
}

// ---------------------------------------------------------------------------
// 工位
// ---------------------------------------------------------------------------

function workstationGroups(seat, index) {
  const k = KIT;
  const groups = [];
  const seatId = seat.id;
  const deskFront = seat.y - 0.006;
  const deskBack = deskFront - k.desk.d;
  const left = seat.x - k.desk.w / 2;
  const right = left + k.desk.w;
  const topZ = k.desk.top;
  const slabZ = topZ - k.desk.slab;
  // Deterministic per-seat jitter. Prop placement must not be identical on
  // every desk (six clones read as a texture tile), but it must also never be
  // random: the renderer is a pure projection, so the same seat always has to
  // put the mug in the same place.
  const jitter = hash01Seat(seatId);

  // ---- back: chair backrest, pedestal, five-star base, seat -----------------
  // The character art is front-facing while the desk sits behind the seat, so
  // the chair must live *behind* the sitter. Everything here draws before the
  // character: the backrest shows above the desktop, the base shows around the
  // feet, and nothing pale ever covers the legs (the old collage's failure).
  //
  // 2026-10-28 第二轮（用户："办公椅表现的也比较奇怪……和鲸鱼娘的上下图层
  // 关系也有问题"）：根因是**尺寸**而不是排序键。旧靠背只有 0.042 宽
  // （40px），而正面立绘约 168px 宽——椅子完全被角色挡住，人看起来像站在
  // 空气里。现在靠背 0.098 宽（约 94px），两侧各露出约 27px，加上双扶手与
  // 更高的靠背（backH 0.100），背视办公椅的轮廓才立得住。
  // 排序契约不变：整把椅子仍在角色之后（组键 = 靠背前下沿）。
  const backY = seat.y - 0.070;
  const seatY0 = seat.y - 0.046;
  const backParts = [
    box(`${seatId}-chair-back`, 'chair-back', 'chairBack',
      seat.x - k.chair.backW / 2, backY, seat.x + k.chair.backW / 2, backY + k.chair.backT,
      k.chair.seatZ + 0.004, k.chair.seatZ + k.chair.backH, 'chair-back'),
    // Two arms flanking the backrest: the old sprite has them, and they are the
    // detail that reads as "task chair" from behind. They live in the SAME back
    // group, so they can never cover the sitter.
    box(`${seatId}-chair-arm-l`, 'chair-arm', 'chairSeat',
      seat.x - k.chair.backW / 2 - k.chair.armW + 0.004, backY + 0.008,
      seat.x - k.chair.backW / 2 + 0.002, backY + 0.020,
      k.chair.seatZ - 0.002, k.chair.armZ, 'chair-arm'),
    box(`${seatId}-chair-arm-r`, 'chair-arm', 'chairSeat',
      seat.x + k.chair.backW / 2 - 0.002, backY + 0.008,
      seat.x + k.chair.backW / 2 + k.chair.armW - 0.004, backY + 0.020,
      k.chair.seatZ - 0.002, k.chair.armZ, 'chair-arm'),
    // Five-star base: the box is only the footprint carrier (the renderer
    // paints the disc, tapered spokes and casters); the group still sorts and
    // casts a shadow from it.
    box(`${seatId}-chair-star`, 'chair-base', 'chairSeat',
      seat.x - 0.034, seat.y - 0.030, seat.x + 0.034, seat.y + 0.030,
      0, 0.007, 'chair-star'),
    // Gas lift: two diameter steps + a dust cover, so it reads as a mechanism
    // instead of a grey stick.
    box(`${seatId}-chair-lift`, 'chair-base', 'steel',
      seat.x - 0.008, seat.y - 0.012, seat.x + 0.008, seat.y + 0.010,
      0.007, k.chair.seatZ, 'gas-lift'),
    box(`${seatId}-chair-seat`, 'chair-seat', 'chairSeat',
      seat.x - k.chair.w / 2, seatY0, seat.x + k.chair.w / 2, seatY0 + k.chair.d,
      k.chair.seatZ, k.chair.seatZ + k.chair.seatT, 'cushion'),
  ];
  // 2026-10-28 第三轮：办公椅改用**旧图片素材**（用户："你可以找一下我们之前
  // 按照图片素材的时候使用的办公椅图片素材"）。素材 `flat-chair`
  // （prop-chair-back.png）是背面视角的完整办公椅：宽背框 + 双扶手 + 气压杆 +
  // 五星脚 + 滚轮，比代码版细致得多。
  //
  // 2026-10-28 第四轮（用户指出图层顺序错）：排序键必须用**坐垫前沿**，
  // 不能用靠背前下沿。用户要的两套关系：
  //
  //   坐在工位上：办公椅（最上）> 鲸鱼娘 > 办公桌（最下）
  //   从旁边路过：鲸鱼娘（最上）> 办公椅 > 办公桌
  //
  // 画家算法是"键小先画、键大后画（盖在上面）"，所以：
  //   桌面前沿 0.2898 < 角色脚点 0.2958 < 坐垫前沿 0.3138
  // 正好给出第一套顺序。旧键（靠背前下沿 0.2458）比桌子还小，椅子被桌板
  // 压住——正是用户看到的"素材被放到最下层"。
  //
  // 第二套（路过）由渲染器按"这个座位此刻有没有人坐着"动态决定：没人坐时
  // 角色用的是自己的脚点键，而椅子仍是坐垫前沿——但路过者的脚点通常比
  // 椅子前沿更靠下（更靠近镜头），所以角色自然压在椅子之上。渲染器不需要
  // 额外分支；这里只保证键值本身正确。
  // 排序键 = 坐垫前沿（在角色脚点之后），所以椅子画在角色**之上**。
  //
  // 但"椅子在最上"必须配一个不会把鲸鱼娘整个人盖掉的椅子——素材 `flat-chair`
  // 是一整把椅子（靠背+扶手+五星脚，约 115px 高），原尺寸叠在角色前面会把
  // 她从头到脚全挡住（实测：椅子纵向 14..244，角色 52..234）。
  //
  // 解法：把椅子精灵按"只露出角色肩部以下"的高度落位。角色 214px 高时，
  // 椅背从肩线（约 55% 身高）到脚下，约 96px —— 视觉上是"她坐的椅背在她
  // 身前/上方"，五官与头发完全可见。这个比例写死为 shoulderReveal。
  // 椅子精灵尺寸：按 **真实世界比例** 定，不用素材自然尺寸、也不靠拍脑袋。
  //
  // 实测（`/tmp/probe/bounds.js`，characterScale=1.50）：
  //   角色精灵屏幕高 132px
  //   椅子素材自然尺寸 141.8px  → chair/char = 1.07，比人还高，会整片盖住她
  //
  // 现实办公椅（含五星脚）约 118cm，成年人站立约 170cm → 比值 ≈ 0.69。
  // 所以椅子取 0.69 × 132 ≈ 91px：既不是被压小的 66px（上一版用户说"又太小"），
  // 也不是 142px（会把她整个人挡住）。此时椅背上沿落在她的肩线，
  // 头与头发可见约 41px。
  //
  // ⚠ 教训（写在这里避免再犯）：`CHAR_SPRITE_PX` 这种常数必须跟着
  // `characterScale` 重新实测——上一版还留着 1.18 时代的 132 读数去推 214px，
  // 连错两轮。改任何角色比例后先跑 bounds.js。
  // 尺寸标定（2026-10-28 第五轮，全部来自实测而不是估算）：
  //   用户认可的 `r4-final-light.png` 里，六把椅子实测都是 **179 device px 宽**
  //   （= 89.5 逻辑 px），而鲸鱼娘在该图里高 419 device px。
  //   => 椅子/角色 ≈ 0.46（按可见高度）。代码里的比值经实测换算系数 1.237 校正后
  //   取 0.614 才能得到这个屏幕尺寸。
  const CHAIR_TO_STANDING_RATIO = 0.737;
  const CHAR_SPRITE_PX = 132;   // 实测值：630 画布 + characterScale 1.50
  const backGroup = makeGroup(`${seatId}-back`, 'station-back', seatY0 + k.chair.d, backParts);
  // 落点：椅子整体**下移**，让她露出的上半身更多。
  // 素材是一整把椅子（背框+坐垫+五星脚），如果按"脚底对齐座位锚点"放，背框
  // 正好盖住她的胸腹（用户看到的"椅背贴在胸口上"）。把锚点下移 0.045 世界
  // 单位后，背框上沿落到她的肩线以下，脸与头发完整可见，五星脚仍在她脚下。
  backGroup.sprite = {
    assetId: 'flat-chair',
    footX: seat.x,
    footY: seat.y + k.chair.d * 0.34 + 0.022,
    // 像素 → 世界单位（630 是描述场景的参考高）。
    height: (CHAR_SPRITE_PX * CHAIR_TO_STANDING_RATIO) / 630,
  };
  groups.push(backGroup);

  // ---- desk: slab, panel, sides, drawer + desk-top props ------------------
  // An open table, not a cabinet: two side boards, a modesty panel hanging at
  // the BACK, and a floor-standing pedestal. The old full-width front panel
  // turned every desk into a solid beige block and hid the chair entirely.
  const pedestalW = k.drawer.w;
  const pedestalX = right - pedestalW - 0.006;
  const deskParts = [
    box(`${seatId}-desk-side-l`, 'desk-side', 'deskSide',
      left, deskBack, left + k.desk.leg, deskFront, 0, slabZ, 'desk-leg'),
    box(`${seatId}-desk-side-r`, 'desk-side', 'deskSide',
      right - k.desk.leg, deskBack, right, deskFront, 0, slabZ, 'desk-leg'),
    box(`${seatId}-desk-panel`, 'desk-panel', 'deskFront',
      left + k.desk.leg, deskBack + 0.006, right - k.desk.leg, deskBack + 0.014,
      0.036, slabZ, 'panel'),
    // Floor-standing pedestal with three drawers. It is one box (one node
    // budget) whose face carries the drawer geometry.
    box(`${seatId}-desk-drawer`, 'desk-drawer', 'deskSide',
      pedestalX, deskBack + 0.012, right - 0.006, deskFront - 0.014,
      0, slabZ, 'drawer'),
    box(`${seatId}-desk-top`, 'desk-top', 'desk',
      left, deskBack, right, deskFront, slabZ, topZ, 'desk-top'),
    // Monitor mount: a flat foot plate on the slab, then a narrow neck. The
    // neck used to be as wide as the foot, which read as a grey block.
    box(`${seatId}-monitor-foot`, 'monitor-stand', 'steel',
      seat.x - 0.019, deskBack + k.monitor.d + 0.004, seat.x + 0.019, deskBack + k.monitor.d + 0.020,
      topZ, topZ + 0.004, 'monitor-foot'),
    box(`${seatId}-monitor-neck`, 'monitor-stand', 'steel',
      seat.x - 0.005, deskBack + k.monitor.d + 0.008, seat.x + 0.005, deskBack + k.monitor.d + 0.014,
      topZ + 0.004, topZ + k.monitor.stand, 'monitor-neck'),
    box(`${seatId}-monitor`, 'monitor', 'monitor',
      seat.x - k.monitor.w / 2 + 0.004, deskBack + 0.006,
      seat.x + k.monitor.w / 2 + 0.004, deskBack + 0.006 + k.monitor.d,
      topZ + k.monitor.stand, topZ + k.monitor.stand + k.monitor.screen, 'screen'),
    // Cable: drops from the monitor foot to the back edge of the slab.
    box(`${seatId}-monitor-cable`, 'cable', 'monitorEdge',
      seat.x - 0.002, deskBack + 0.002, seat.x + 0.001, deskBack + k.monitor.d + 0.006,
      topZ, topZ + 0.002, 'cable'),
    // Keyboard: a proper deck (case lip + recessed key well) rather than
    // three ruled lines.
    box(`${seatId}-keyboard`, 'keyboard', 'keycap',
      seat.x - k.keyboard.w / 2, deskFront - 0.034, seat.x + k.keyboard.w / 2,
      deskFront - 0.034 + k.keyboard.d, topZ, topZ + k.keyboard.t, 'keys'),
    // Papers at the desk's LEFT REAR, clear of the keyboard (which spans
    // ±0.052 around the seat). Slightly staggered per seat so the six desks
    // are siblings, not clones.
    // Left-front of the desk: clear of the monitor (rear-centre) and the
    // keyboard (front-centre). Sitting at the very back edge made the sheet
    // look like it hung off the desk.
    box(`${seatId}-papers`, 'papers', 'paper',
      left + 0.008 + jitter * 0.008, deskBack + 0.020,
      left + 0.008 + jitter * 0.008 + k.papers.w, deskBack + 0.020 + k.papers.d,
      topZ, topZ + 0.003, 'papers'),
    // Pen cup: 1.4× (0.012 → 0.017) so it reads at the enlarged desk scale.
    // It lives at the desk's RIGHT REAR: at the enlarged paper size there is no
    // longer a free band between the pen cup and the keyboard on the left
    // (free strip was only 12px tall, 2026-10-28).
    box(`${seatId}-pen`, 'pen-cup', 'steel',
      right - 0.030, deskBack + 0.008, right - 0.013, deskBack + 0.025, topZ, topZ + 0.021, 'pen'),
    // Mug: the mug used the RAW accent (saturation 0.68) while everything else
    // in the scene sits at 0.16–0.18 — the reviewer's "it looks like a UI icon"
    // (2026-10-28). `ceramic` mixes the accent ~82% toward paper (sat ≈0.13),
    // so it reads as a coloured glazed cup rather than a swatch.
    // Mug moved to the RIGHT REAR corner: at the enlarged prop size it collided
    // with the mouse on the right-front (2026-10-28).
    box(`${seatId}-mug`, 'mug', 'ceramic',
      right - k.mug.w - 0.010, deskBack + 0.014,
      right - 0.010, deskBack + 0.014 + k.mug.w,
      topZ, topZ + k.mug.h, 'mug'),
  ];
  // Prop variation: alternate the small stuff so the six desks are siblings,
  // not clones. Everything is keyed off the seat id, so it is deterministic.
  if (index % 2 === 0) {
    deskParts.push(box(`${seatId}-mouse`, 'mouse', 'keycap',
      seat.x + k.keyboard.w / 2 + 0.004, deskFront - 0.030,
      seat.x + k.keyboard.w / 2 + 0.016, deskFront - 0.019,
      topZ, topZ + 0.008, 'mouse'));
  } else {
    deskParts.push(box(`${seatId}-sticky`, 'sticky', 'sticky',
      left + 0.042, deskBack + 0.014, left + 0.066, deskBack + 0.034,
      topZ, topZ + 0.002, 'sticky'));
  }
  if (index % 3 === 1) {
    // Desk lamp on the desk's right rear corner. Three review findings fixed
    // here (2026-10-28):
    //   1. the shade was as tall as the monitor and touched its right edge;
    //   2. the base was 39×30px and covered the mug;
    //   3. nothing separated lamp, monitor and mug.
    // Now: a 12px-wide shade lifted 25px above the desktop, a 10px base, and a
    // 17px horizontal gap from the monitor's right edge.
    deskParts.push(box(`${seatId}-lamp-base`, 'lamp', 'steel',
      right - 0.015, deskBack + 0.011, right - 0.005, deskBack + 0.019,
      topZ, topZ + 0.003, 'lamp-base'));
    deskParts.push(box(`${seatId}-lamp-pole`, 'lamp', 'steel',
      right - 0.011, deskBack + 0.014, right - 0.009, deskBack + 0.016,
      topZ + 0.003, topZ + 0.040, 'lamp-pole'));
    deskParts.push(box(`${seatId}-lamp-shade`, 'lamp', 'lampShade',
      right - 0.018, deskBack + 0.009, right - 0.005, deskBack + 0.021,
      topZ + 0.040, topZ + 0.058, 'lamp-shade'));
  }
  groups.push(makeGroup(`${seatId}-desk`, 'station-desk', deskFront, deskParts));

  // 站位的排序键 = **角色自己的脚点**。
  //
  // 旧值是 `deskFront - 0.0002`（比桌面前沿还小一点点），于是坐着的角色被画在
  // 桌子**下面**——用户要的顺序是"鲸鱼娘 > 办公桌"，所以键必须是脚点。
  // 现在三者的键：桌面前沿 0.2898 < 脚点 0.2958 < 坐垫前沿 0.3138，
  // 得到「椅子 > 角色 > 桌子」。
  const band = {
    x0: left,
    x1: right,
    y0: deskBack,
    y1: seat.y + 0.006,
    key: seat.y,
  };
  return { groups, band };
}

// ---------------------------------------------------------------------------
// 装饰（只占用工位之外的空地）
// ---------------------------------------------------------------------------

function overlaps(a, b) {
  return !(a.x1 <= b.x0 + EPS || b.x1 <= a.x0 + EPS || a.y1 <= b.y0 + EPS || b.y1 <= a.y0 + EPS);
}

function free(rect, occupied) {
  return occupied.every((other) => !overlaps(rect, other));
}

function rectAt(x0, y0, w, d) {
  return { x0, y0, x1: x0 + w, y1: y0 + d };
}

function firstFree(candidates, occupied) {
  for (const candidate of candidates) {
    if (candidate.x0 < 0.008 || candidate.y0 < 0.12 || candidate.x1 > 0.992 || candidate.y1 > 0.995) continue;
    if (free(candidate, occupied)) return candidate;
  }
  return null;
}

function kitchenGroup(rect) {
  const k = KIT;
  const parts = [];
  const counterD = Math.min(k.counter.d, rect.y1 - rect.y0);
  const fridgeW = Math.min(k.fridge.w, rect.x1 - rect.x0);
  const fridgeX = rect.x0 + 0.006;
  const fridgeY = rect.y0 + 0.008;
  const topZ = k.counter.top;
  const slabZ = topZ - k.counter.slab;
  parts.push(box('kitchen-fridge', 'fridge', 'counterSide',
    fridgeX, fridgeY, fridgeX + fridgeW, fridgeY + k.fridge.d,
    0, k.fridge.top, 'fridge'));
  const cx0 = fridgeX + fridgeW + 0.012;
  const cx1 = Math.max(cx0 + 0.07, rect.x1);
  const counterFrontY = rect.y0 + counterD;
  // Full-depth carcass + a stone slab on top: the front face (doors) is what
  // makes a counter read as storage, not as a floating pale plate.
  parts.push(box('kitchen-counter', 'counter', 'counterFront',
    cx0, rect.y0, cx1, counterFrontY, 0, slabZ, 'counter-doors'));
  parts.push(box('kitchen-counter-top', 'counter', 'counterTop',
    cx0, rect.y0, cx1, counterFrontY, slabZ, topZ, 'counter-top'));
  // Upstand where the counter meets the wall: 4–6px in screen terms. Without
  // it the slab ends in mid-air against the wall band.
  parts.push(box('kitchen-upstand', 'counter', 'counterTop',
    cx0, rect.y0, cx1, rect.y0 + 0.008, topZ, topZ + 0.008, 'upstand'));
  parts.push(box('kitchen-sink', 'sink', 'counterSide',
    cx1 - 0.072, rect.y0 + 0.024, cx1 - 0.028, rect.y0 + 0.058,
    topZ, topZ + 0.002, 'sink'));
  // Faucet: base + riser + spout, three boxes so the renderer can draw the
  // bend. One flat bar read as a black stick.
  parts.push(box('kitchen-faucet-base', 'faucet', 'metal',
    cx1 - 0.052, rect.y0 + 0.020, cx1 - 0.045, rect.y0 + 0.027,
    topZ, topZ + 0.004, 'faucet-base'));
  parts.push(box('kitchen-faucet-riser', 'faucet', 'metal',
    cx1 - 0.051, rect.y0 + 0.021, cx1 - 0.047, rect.y0 + 0.025,
    topZ + 0.004, topZ + 0.030, 'faucet-riser'));
  // Short spout with a downturned nozzle: the L-bend is the whole silhouette.
  parts.push(box('kitchen-faucet-spout', 'faucet', 'metal',
    cx1 - 0.051, rect.y0 + 0.021, cx1 - 0.037, rect.y0 + 0.025,
    topZ + 0.024, topZ + 0.030, 'faucet-spout'));
  // Coffee machine: body + group head + drip tray + steam wand.
  parts.push(box('kitchen-machine', 'machine', 'monitor',
    cx0 + 0.010, rect.y0 + 0.026, cx0 + 0.044, rect.y0 + 0.056,
    topZ, topZ + 0.040, 'machine'));
  parts.push(box('kitchen-machine-cup', 'cup', 'paper',
    cx0 + 0.019, rect.y0 + 0.058, cx0 + 0.031, rect.y0 + 0.068,
    topZ, topZ + 0.009, 'espresso-cup'));
  // Wall-mounted UPPER CABINET (2026-10-28 第四轮：茶水间变宽后只有台面太单薄).
  // 一个带两扇门、底部收边的吊柜，挂在水槽上方的墙面上。
  const cab0 = cx0 + 0.004;
  const cab1 = cx1 - 0.004;
  // 壁架 + 杯子（原有的）。**没有加吊柜**：茶水间的 y0=0.155、台面 z=0.078，
  // 台面顶面在屏幕上已经到 y≈48px，而墙带只有 202px——再往上放 27px 高的吊柜
  // 会顶出画布（实测 cabinet z1=0.176 → 屏幕 y=-37）。要加吊柜必须整体下移厨房，
  // 而下方紧挨着第一排工位（y 0.198 起），没有余量。这条记进 §12 遗留。
  parts.push(box('kitchen-shelf', 'shelf', 'deskFront',
    cab0, rect.y0 + 0.008, cab1, rect.y0 + 0.026, 0.128, 0.134, 'shelf'));
  for (let i = 0; i < 3; i += 1) {
    const x = cx0 + 0.020 + i * 0.018;
    parts.push(box(`kitchen-cup-${i}`, 'cup', 'paper',
      x, rect.y0 + 0.013, x + 0.007, rect.y0 + 0.021, 0.134, 0.145, 'cup'));
  }
  // 水槽右侧的沥水架 + 两片碟子（原来水槽右边是空的）。
  parts.push(box('kitchen-dish-rack', 'dish-rack', 'metal',
    cx1 - 0.026, rect.y0 + 0.024, cx1 - 0.006, rect.y0 + 0.052,
    topZ, topZ + 0.012, 'dish-rack'));
  // 台面左端的热水壶（咖啡机与水槽之间留出的空档）。
  parts.push(box('kitchen-kettle', 'kettle', 'metal',
    cx0 + 0.050, rect.y0 + 0.030, cx0 + 0.068, rect.y0 + 0.050,
    topZ, topZ + 0.022, 'kettle'));
  // 2026-10-28 第七轮：台面中段还有一条 52px 的空档（水壶与水槽之间），
  // 补三件低矮的厨房小物 —— 只能往上不行（墙带只剩 14px），只能往平面铺。
  parts.push(box('kitchen-board', 'cutting-board', 'desk',
    cx0 + 0.074, rect.y0 + 0.034, cx0 + 0.100, rect.y0 + 0.046,
    topZ, topZ + 0.004, 'cutting-board'));
  parts.push(box('kitchen-jar-a', 'jar', 'paper',
    cx0 + 0.104, rect.y0 + 0.032, cx0 + 0.114, rect.y0 + 0.044,
    topZ, topZ + 0.016, 'jar'));
  parts.push(box('kitchen-jar-b', 'jar', 'plantPotAlt',
    cx0 + 0.117, rect.y0 + 0.033, cx0 + 0.126, rect.y0 + 0.043,
    topZ, topZ + 0.013, 'jar'));
  // 冰箱顶上的一盆小绿植（高处不占地面，增加生活感）。
  parts.push(box('kitchen-fridge-plant', 'plant-pot', 'plantPotAlt',
    fridgeX + fridgeW * 0.30, fridgeY + 0.004, fridgeX + fridgeW * 0.70, fridgeY + 0.026,
    k.fridge.top, k.fridge.top + 0.012, 'pot'));
  return makeGroup('kitchen', 'kitchen', counterFrontY, parts);
}

function loungeGroups(rect) {
  const k = KIT;
  const groups = [];
  const rug = rectAt(rect.x0, rect.y0, Math.min(k.rug.w, rect.x1 - rect.x0), Math.min(k.rug.d, rect.y1 - rect.y0));
  const cx = (rug.x0 + rug.x1) / 2;
  const sofaW = Math.min(k.sofa.w, rug.x1 - rug.x0 - 0.02);
  // 2026-10-28 第八轮（用户："沙发和旁边的落地灯稍微有些重叠"）：沙发整体右移
  // 约 5px（0.0052 世界单位）。落地灯在 x 9..60、沙发左缘原本在 46，压住灯
  // 14px；右移后重叠降到 9px，灯罩与灯杆完整可见。
  const SOFA_SHIFT_X = 0.0052;
  const sofaX = cx - sofaW / 2 + SOFA_SHIFT_X;
  const sofaY = rug.y0 + 0.018;

  groups.push(makeGroup('lounge-rug', 'rug', rug.y0 + 0.002, [
    box('lounge-rug', 'rug', 'rug', rug.x0, rug.y0, rug.x1, rug.y1, 0, 0.002, 'rug'),
  ]));

  const sofaParts = [
    // Legs first (they are behind the skirt in painter order but must exist):
    // four short block feet, so the sofa is lifted off the rug.
    box('lounge-sofa-leg-fl', 'sofa-leg', 'deskSide',
      sofaX + 0.010, sofaY + k.sofa.d - 0.014, sofaX + 0.022, sofaY + k.sofa.d - 0.004, 0, 0.006, 'sofa-leg'),
    box('lounge-sofa-leg-fr', 'sofa-leg', 'deskSide',
      sofaX + sofaW - 0.022, sofaY + k.sofa.d - 0.014, sofaX + sofaW - 0.010, sofaY + k.sofa.d - 0.004, 0, 0.006, 'sofa-leg'),
    // Plinth + skirt: the dark band under the seat that grounds the sofa.
    box('lounge-sofa-base', 'sofa', 'sofa',
      sofaX, sofaY, sofaX + sofaW, sofaY + k.sofa.d, 0.006, k.sofa.seatZ, 'sofa-base'),
    box('lounge-sofa-skirt', 'sofa', 'sofa',
      sofaX + k.sofa.armW * 0.5, sofaY + k.sofa.d - 0.014, sofaX + sofaW - k.sofa.armW * 0.5,
      sofaY + k.sofa.d, 0.006, k.sofa.seatZ, 'sofa-skirt'),
    // Backrest: TWO cushions split at the sofa's mid-line (a single slab read
    // as a bench back). NOTE: `cx` is already the world mid-line — it must not
    // be offset by sofaX again (that bug made one cushion 136px and the other
    // 21px wide).
    //
    // The two halves must MEET exactly at `cx`. Leaving a 0.002 gap on each
    // side (as the first version did) put a 0.004-wide — about 4px — strip of
    // BACKGROUND between them: the sofa looked cut in half (reviewer evidence
    // 2026-10-28, x152–155 at y344–382). The centre seam is drawn by the
    // renderer as a dark line, not left as a hole.
    box('lounge-sofa-back-l', 'sofa', 'sofaBack',
      sofaX + k.sofa.armW - 0.002, sofaY, cx, sofaY + 0.026,
      k.sofa.seatZ, k.sofa.seatZ + k.sofa.backH, 'sofa-back'),
    box('lounge-sofa-back-r', 'sofa', 'sofaBack',
      cx, sofaY, sofaX + sofaW - k.sofa.armW + 0.002, sofaY + 0.026,
      k.sofa.seatZ, k.sofa.seatZ + k.sofa.backH, 'sofa-back'),
    // Arms: equal height, rounded, rolled. Asymmetric arms read as a mistake
    // at this size, not as a design choice.
    box('lounge-sofa-arm-l', 'sofa', 'sofaBack',
      sofaX, sofaY, sofaX + k.sofa.armW, sofaY + k.sofa.d,
      0.006, k.sofa.seatZ + 0.032, 'sofa-arm'),
    box('lounge-sofa-arm-r', 'sofa', 'sofaBack',
      sofaX + sofaW - k.sofa.armW, sofaY, sofaX + sofaW, sofaY + k.sofa.d,
      0.006, k.sofa.seatZ + 0.032, 'sofa-arm'),
  ];
  const innerW = sofaW - k.sofa.armW * 2 - 0.006;
  for (let i = 0; i < 2; i += 1) {
    const x = sofaX + k.sofa.armW + 0.004 + i * (innerW / 2 + 0.004);
    // 2026-10-28 第八轮：坐垫**后沿压进靠背下方 6px**（原来的后沿贴着靠背前沿，
    // 两者在屏幕上差 10px，露出一条硬直线，像两块嵌板拼起来）。压进去之后，
    // 靠背的接触阴影会自然盖住接缝，读作"垫子塞在靠背下面"。
    sofaParts.push(box(`lounge-sofa-cushion-${i}`, 'sofa-cushion', 'sofaSeat',
      x, sofaY + 0.018, x + innerW / 2 - 0.004, sofaY + k.sofa.d - 0.006,
      k.sofa.seatZ, k.sofa.seatZ + k.sofa.seatT, 'sofa-cushion'));
  }
  // Two throw pillows, leaning against the back cushions.
  sofaParts.push(box('lounge-pillow-l', 'pillow', 'accentSoft',
    sofaX + k.sofa.armW + 0.012, sofaY + 0.010, sofaX + k.sofa.armW + 0.044, sofaY + 0.026,
    k.sofa.seatZ + k.sofa.seatT, k.sofa.seatZ + k.sofa.seatT + 0.022, 'pillow'));
  sofaParts.push(box('lounge-pillow-r', 'pillow', 'sofaSeat',
    sofaX + sofaW - k.sofa.armW - 0.044, sofaY + 0.010, sofaX + sofaW - k.sofa.armW - 0.012,
    sofaY + 0.024, k.sofa.seatZ + k.sofa.seatT, k.sofa.seatZ + k.sofa.seatT + 0.020, 'pillow'));
  groups.push(makeGroup('lounge-sofa', 'lounge-sofa', sofaY + k.sofa.d, sofaParts));

  const tableW = Math.min(k.table.w, rug.x1 - rug.x0 - 0.04);
  const tableX = cx - tableW / 2;
  const tableY = sofaY + k.sofa.d + 0.026;
  groups.push(makeGroup('lounge-table', 'lounge-table', tableY + k.table.d, [
    // Two slab legs (not one block) + a thicker top with a chamfer.
    box('lounge-table-leg-l', 'table-leg', 'deskSide',
      tableX + 0.012, tableY + 0.012, tableX + 0.020, tableY + k.table.d - 0.012,
      0, k.table.top - k.table.slab, 'table-leg'),
    box('lounge-table-leg-r', 'table-leg', 'deskSide',
      tableX + tableW - 0.020, tableY + 0.012, tableX + tableW - 0.012, tableY + k.table.d - 0.012,
      0, k.table.top - k.table.slab, 'table-leg'),
    box('lounge-table-top', 'table', 'desk',
      tableX, tableY, tableX + tableW, tableY + k.table.d, k.table.top - k.table.slab, k.table.top, 'table'),
    // Magazine: two offset sheets with a folded corner.
    // 2026-10-28 第九轮（用户："或许可以按你说的加个杂志堆？"）：单本杂志换成
    // 一小摞（4 本，逐层错位旋转），放在茶几左前方。桌面宽 120px，右前方留给
    // 遥控器，中间留白正好放这一摞。
    // 盒子高度必须给足：0.007 世界单位在 630 高的画布上只有 4.4px，分 4 层
    // 每层 1.1px —— 正面完全看不见，看起来还是一张薄片（2026-10-28 实测）。
    // 0.020 → 12.6px，每层 3px，才能画出"一摞"。
    box('lounge-magazine-stack', 'magazine-stack', 'paper',
      tableX + 0.014, tableY + 0.010, tableX + 0.056, tableY + 0.034,
      k.table.top, k.table.top + 0.020, 'magazine-stack'),
    // Remote control: small dark bar with two button dots (moved slightly right
    // so it clears the taller magazine stack).
    box('lounge-remote', 'remote', 'monitorEdge',
      tableX + tableW - 0.030, tableY + 0.014, tableX + tableW - 0.010, tableY + 0.023,
      k.table.top, k.table.top + 0.002, 'remote'),
  ]));

  const lampX = rug.x0 + 0.016;
  groups.push(makeGroup('lounge-lamp', 'lounge-lamp', rug.y0 + 0.056, [
    // Base: weighted disc; pole: two-step metal; shade: tapered drum.
    box('lounge-lamp-base', 'lamp', 'steel',
      lampX - 0.014, rug.y0 + 0.038, lampX + 0.014, rug.y0 + 0.056, 0, 0.007, 'lamp-base'),
    box('lounge-lamp-pole', 'lamp', 'steel',
      lampX - 0.003, rug.y0 + 0.043, lampX + 0.003, rug.y0 + 0.049, 0.007, k.lamp.pole, 'lamp-pole'),
    box('lounge-lamp-shade', 'lamp', 'lampShade',
      lampX - k.lamp.shadeW / 2, rug.y0 + 0.032, lampX + k.lamp.shadeW / 2, rug.y0 + 0.062,
      k.lamp.pole, k.lamp.pole + k.lamp.shadeH, 'lamp-shade'),
  ]));

  return { groups, rug };
}

// ---------------------------------------------------------------------------
// 绿植：4 个物种，各自的剪影与叶序（2026-10-28 第二轮）
//
// 用户："现在的绿植看起来很怪，不自然……可以放多个种类的绿植而不是简单的复用"。
// 上一版所有盆都是"5 片同款尖叶 + 一个梯形盆"，所以一眼是复用的贴纸。现在
// 每个物种有自己的：
//   - 盆（圆盆 / 方盆 / 高筒盆 / 宽矮盆）与盆色；
//   - 叶形（龟背竹的大裂叶、虎皮兰的剑形直立叶、多肉的莲座、榕树的小圆叶）；
//   - 叶序（放射 / 直立 / 层叠莲座 / 伞状树冠）。
// 物种由调用方传入（`species`），不是随机——渲染必须是同一输入的纯投影。
// ---------------------------------------------------------------------------

// `baseK` = 叶片起始高度占 height 的比例；`stepK` = 每层递增比例。
// 多肉是贴地莲座（baseK 0.02），榕树是高位伞冠（baseK 0.55）——这是四种绿植
// 剪影能分开的关键之一，不能共用一套。
const PLANT_SPECIES = Object.freeze({
  // `asset`：这一物种的**图片素材**（resources/office/flat/flat-plant-*.png）。
  // 2026-10-28 第三轮拍板：绿植回退到图片素材。理由是与用户一起验收过两轮代码
  // 绘制后，代码版在前景近距离下始终比素材粗糙（叶片体积感、盆的陶土质感、
  // 叶脉密度都差一档）。结构类家具（桌/椅/显示器/台面）继续用代码绘制——它们
  // 需要跟角色一起参与排序和遮挡，素材反而受限。绿植是**静态落地装饰**，
  // 只按组排序，用素材没有额外代价。
  monstera: Object.freeze({ asset: 'flat-plant-monstera', pot: 'round', potScale: 1.00, potTone: 'plantPot', height: 0.115, baseK: 0.20, stepK: 0.09 }),
  snake: Object.freeze({ asset: 'flat-plant-snake', pot: 'tall', potScale: 0.86, potTone: 'plantPotAlt', height: 0.135, baseK: 0.10, stepK: 0.06 }),
  // 多肉：矮宽盆 + 矮莲座，但盆要够高才有「盆」的体积（第一版 0.80× 太扁，
  // 莲座看起来浮在盆上）。
  succulent: Object.freeze({ asset: 'flat-plant-succulent', pot: 'wide', potScale: 1.10, potTone: 'plantPot', height: 0.050, baseK: 0.02, stepK: 0.05 }),
  // 榕树：中等高度的伞状树冠。baseK 不能太高，否则树冠会飘出屏幕上沿（2026-10-28）。
  ficus: Object.freeze({ asset: 'flat-plant-a', pot: 'round', potScale: 0.94, potTone: 'plantPotAlt', height: 0.115, baseK: 0.30, stepK: 0.05 }),
});

function plantGroup(id, x, y, speciesId) {
  const k = KIT;
  const speciesKey = PLANT_SPECIES[speciesId] ? speciesId : 'monstera';
  const sp = PLANT_SPECIES[speciesKey];
  const potW = k.plant.potW * sp.potScale;
  const potH = k.plant.potH * (sp.pot === 'tall' ? 1.35 : sp.pot === 'wide' ? 0.80 : 1.0);
  // 方盆（多肉）：footprint 是方口；圆盆：稍窄的椭圆口。
  const squarePot = sp.pot === 'wide';
  const parts = [
    box(`${id}-tray`, 'plant-tray', sp.potTone,
      x - potW * 0.27, y - potW * 0.17, x + potW * 0.27, y + potW * 0.17,
      0, 0.003, 'pot-tray'),
    box(`${id}-pot`, 'plant-pot', sp.potTone,
      x - potW / 2, y - potW * 0.30, x + potW / 2, y + potW * 0.30,
      0, potH, squarePot ? 'pot-square' : 'pot'),
    // Stems rise INTO the crown. They used to stop at 30–42% of the plant
    // height, which left the leaves floating above bare pot (2026-10-28).
    box(`${id}-stem-a`, 'plant-stem', 'plantLeafAlt',
      x - 0.004, y - 0.004, x + 0.001, y + 0.001,
      potH, potH + sp.height * Math.min(0.62, sp.baseK + 0.30), 'stem'),
    box(`${id}-stem-b`, 'plant-stem', 'plantLeafAlt',
      x + 0.001, y + 0.001, x + 0.006, y + 0.006,
      potH, potH + sp.height * Math.min(0.48, sp.baseK + 0.20), 'stem'),
  ];
  // 叶片布局按物种切换。每个条目：相对中心偏移、半宽、半高、层高、材质、指向。
  // 关键：leaf.family 决定渲染器用哪种叶形（broad / sword / rosette / round）。
  const layout = {
    // 龟背竹：4–5 片大裂叶，向外斜伸，中间留出缝隙（自然的散开感）。
    monstera: [
      [-0.32, -0.02, 0.48, 0.38, 0, 'plantLeaf', -0.55, 'broad'],
      [0.34, 0.04, 0.46, 0.36, 1, 'plantLeafAlt', 0.58, 'broad'],
      [0.02, -0.16, 0.40, 0.32, 2, 'plantLeaf', 0.05, 'broad'],
      [-0.20, 0.22, 0.36, 0.28, 3, 'plantLeafAlt', -0.30, 'broad'],
      [0.22, 0.28, 0.32, 0.26, 4, 'plantLeaf', 0.42, 'broad'],
    ],
    // 虎皮兰：剑形直立叶，几乎不横向散开，高矮错落。
    snake: [
      [-0.26, -0.28, 0.20, 0.86, 0, 'plantLeafAlt', -0.10, 'sword'],
      [0.02, -0.36, 0.17, 0.98, 1, 'plantLeaf', 0.02, 'sword'],
      [0.28, -0.24, 0.18, 0.78, 2, 'plantLeafAlt', 0.12, 'sword'],
      [-0.44, -0.05, 0.16, 0.60, 3, 'plantLeaf', -0.24, 'sword'],
      [0.46, 0.02, 0.15, 0.56, 4, 'plantLeafAlt', 0.26, 'sword'],
    ],
    // 多肉：莲座层叠，中心小、外圈大，贴着盆口（不是浮在盆上方）。
    succulent: [
      [0.00, 0.10, 0.36, 0.22, 0, 'plantLeafAlt', 0.00, 'rosette'],
      [-0.30, 0.16, 0.30, 0.19, 1, 'plantLeaf', -0.50, 'rosette'],
      [0.30, 0.16, 0.30, 0.19, 2, 'plantLeaf', 0.50, 'rosette'],
      [-0.16, 0.26, 0.26, 0.16, 3, 'plantLeafAlt', -0.26, 'rosette'],
      [0.16, 0.26, 0.26, 0.16, 4, 'plantLeafAlt', 0.26, 'rosette'],
    ],
    // 榕树：小圆叶组成伞状树冠。叶片必须**贴着茎顶**排布——第一版把叶子放在
    // 离茎很远的 y 偏移上，叶子看起来飘在空中（2026-10-28 实测）。
    ficus: [
      [-0.26, -0.10, 0.26, 0.20, 0, 'plantLeaf', -0.20, 'round'],
      [0.04, -0.18, 0.24, 0.19, 1, 'plantLeafAlt', 0.05, 'round'],
      [0.28, -0.09, 0.25, 0.20, 2, 'plantLeaf', 0.22, 'round'],
      [-0.34, 0.04, 0.22, 0.17, 3, 'plantLeafAlt', -0.34, 'round'],
      [0.34, 0.06, 0.22, 0.17, 4, 'plantLeaf', 0.34, 'round'],
      [-0.10, -0.02, 0.20, 0.16, 5, 'plantLeaf', -0.08, 'round'],
      [0.14, 0.08, 0.19, 0.15, 6, 'plantLeafAlt', 0.10, 'round'],
    ],
  }[speciesKey];
  layout.forEach(([dx, dy, rw, rh, level, tone, tilt, family], i) => {
    const lx = x + potW * dx;
    const ly = y + potW * dy;
    const rx = potW * rw;
    const ry = potW * rh;
    const z0 = potH + sp.height * (sp.baseK + level * sp.stepK);
    const part = box(`${id}-leaf-${i}`, 'plant-leaf', tone,
      lx - rx, ly - ry, lx + rx, ly + ry, z0, z0 + sp.height * 0.30, 'leaf');
    part.tilt = tilt;
    part.family = family;
    parts.push(part);
  });
  // 2026-10-28 第三轮：绿植改由**图片素材**绘制（见 PLANT_SPECIES 的说明）。
  // 组上带 `sprite` 描述，渲染器如果能拿到该 assetId 的纹理就画素材、
  // 否则回退到上面这套代码绘制（离线测试/纹理缺失时仍然成立）。
  // footprint 用一支"占地上限"盒子表达，保证排序键、接触阴影与占地检查都不变。
  const spriteFoot = sp.height + potH;
  const group = makeGroup(id, 'plant', y + potW * 0.30, parts);
  group.sprite = {
    assetId: sp.asset,
    // 素材在屏幕上的落点：以盆底中心为锚，向上长 spriteFoot。
    footX: x,
    footY: y + potW * 0.30,
    width: potW * 2.4,
    height: spriteFoot * 1.28,
  };
  return group;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * Build the generated 2.5D office.
 *
 * @param {object} input
 * @param {{width:number,height:number}} [input.scene] echoed for diagnostics
 * @param {Array<{id:string,x:number,y:number}>} input.seats world-space seats
 */
function describeOffice(input) {
  const options = input || {};
  const seats = readSeats(options.seats);
  const width = Number(options.scene && options.scene.width) > 0 ? Number(options.scene.width) : 1280;
  const height = Number(options.scene && options.scene.height) > 0 ? Number(options.scene.height) : 840;

  const groups = [];
  const stations = [];
  const occupied = [];

  seats.forEach((seat, index) => {
    const station = workstationGroups(seat, index);
    groups.push(...station.groups);
    stations.push({ id: seat.id, x: seat.x, y: seat.y, ...station.band });
    const parts = station.groups.flatMap((entry) => entry.parts);
    occupied.push({
      x0: Math.min(...parts.map((part) => part.x0)),
      y0: Math.min(...parts.map((part) => part.y0)),
      x1: Math.max(...parts.map((part) => part.x1)),
      y1: Math.max(...parts.map((part) => part.y1)),
    });
  });

  let kitchen = false;
  // 2026-10-28 第三轮（用户："减小窗户大小来增大茶水间"）：窗缩到 0.13 宽并
  // 右移到 0.305 之后，茶水间可以用到 x≈0.295（窗左缘再留 1px 余量）。
  // 首选 0.275 宽（264px），比上一轮的 0.20 宽了 37%。
  const kitchenRect = firstFree([
    rectAt(0.012, 0.155, 0.282, 0.115),
    rectAt(0.015, 0.16, 0.235, 0.105),
    rectAt(0.015, 0.17, 0.19, 0.095),
  ], occupied);
  if (kitchenRect) {
    groups.push(kitchenGroup(kitchenRect));
    occupied.push(kitchenRect);
    kitchen = true;
  }

  let lounge = false;
  const loungeRect = firstFree([
    rectAt(0.02, 0.62, 0.30, 0.28),
    rectAt(0.02, 0.56, 0.27, 0.26),
    rectAt(0.68, 0.60, 0.28, 0.30),
    rectAt(0.02, 0.38, 0.24, 0.22),
  ], occupied);
  if (loungeRect) {
    const placed = loungeGroups(loungeRect);
    groups.push(...placed.groups);
    occupied.push({
      x0: placed.rug.x0, y0: placed.rug.y0, x1: placed.rug.x1, y1: placed.rug.y1,
    });
    lounge = true;
  }

  const plants = [];
  const spots = [
    // 4 个物种各放一盆（用户："可以放多个种类的绿植而不是简单的复用"）。
    // 物种跟着位置固定，不随机：同一输入的投影必须一致。
    ['plant-a', 0.045, 0.955, 'monstera'],
    ['plant-b', 0.955, 0.955, 'ficus'],
    ['plant-c', 0.965, 0.52, 'snake'],
    ['plant-d', 0.045, 0.46, 'succulent'],
  ];
  for (const [id, x, y, species] of spots) {
    const spot = rectAt(x - 0.035, y - 0.05, 0.07, 0.07);
    if (!free(spot, occupied)) continue;
    groups.push(plantGroup(id, x, y, species));
    occupied.push(spot);
    plants.push(id);
  }

  const seen = new Set();
  for (const entry of groups) {
    if (seen.has(entry.id)) throw new Error(`code-office: duplicate group id ${entry.id}`);
    seen.add(entry.id);
  }

  const partCount = groups.reduce((sum, entry) => sum + entry.parts.length, 0);
  return {
    scene: { width, height },
    groups,
    stations,
    stats: {
      stationCount: seats.length,
      groupCount: groups.length,
      partCount,
      deskCount: groups.filter((entry) => entry.kind === 'station-desk').length,
      hasKitchen: kitchen,
      hasLounge: lounge,
      plants: plants.length,
    },
  };
}

module.exports = {
  describeOffice,
  KIT,
};
