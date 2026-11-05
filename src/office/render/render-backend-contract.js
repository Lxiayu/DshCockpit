// src/office/render/render-backend-contract.js — 渲染后端的接缝声明（ADR-0006 §6.1）。
//
// ============================================================================
// 这是「接缝」，不是「抽象层」。两者的区别决定了这件事该不该做。
// ============================================================================
//
// 第一性原理：repo-map.md §2.6 说「只有一个实现时不造接口」。
// 而当前渲染器（pixi-office-renderer.js）确实只有一个实现。
//
// 那 ADR-0006 §6.1 为什么要求"预留 RenderBackend 接口"？
//
// 因为两者说的不是同一件事：
//
//   | | 抽象层 | 接缝 |
//   |---|---|---|
//   | 目的 | 让两个实现可互换 | **标出未来会换的地方** |
//   | 成本 | 每加能力都要改 interface | 一次性标注，不改现有代码 |
//   | 何时 | 已有第二个实现 | **预期会有，但现在没有** |
//   | 风险 | 抽象错了要重构两遍 | 几乎无风险 |
//
// ADR-0006 说「只做接口，不实现」——它要的是接缝。
// 把它做成完整的 interface + adapter 层就是过度实现，是负债。
//
// 第二性原理：为什么接缝值得做（成本近零，收益明确）
//
//   没有接缝的后果是：未来接 Live2D 的人要从 4673 行里考古，
//   判断"哪些方法必须实现、哪些是 PixiJS 特有的、哪些可以不实现"。
//   那个判断错了就会做出一个行为不一致的后端（比如忘了 hitTest，
//   于是点击员工没反应，但没有任何测试会告诉你为什么）。
//
//   有了接缝，这个判断变成一份可读的清单 + 一个可执行的检查函数。
//
// 第三性原理：为什么清单要分「必需」与「可选」
//
//   把 20 个方法全列为必需是错的。`groundPaintOrder` /
//   `furniturePaintOrder` 暴露的是 PixiJS 的容器树与 z-order 概念——
//   一个 Canvas2D 或 Live2D 后端根本没有"ground 容器"这种东西。
//   把它们列为必需，等于要求未来后端伪造一个它不需要的概念。
//
//   所以：**必需 = 语义必需；可选 = 技术特有，可实现可不实现**。
'use strict';

/**
 * 后端契约的必需方法。
 *
 * 判定标准：**这个方法表达的语义是否与渲染技术无关？**
 * 如果换任何后端都必须能做这件事，它就在必需清单里。
 */
const BACKEND_CONTRACT = Object.freeze([
  // ---- 生命周期：任何后端都要能创建/销毁/调整/暂停 ----
  'resize',
  'destroy',
  'pause',
  'resume',

  // ---- 显示控制：与"怎么画"无关，只与"画不画"有关 ----
  'setVisible',
  'setReducedMotion',
  'setPresenting',

  // ---- 交互：点击命中与拖拽是**产品语义**，不是渲染细节 ----
  'hitTest',
  'setSelection',
  'beginDrag',
  'dragTo',
  'endDrag',

  // ---- 主题：颜色 token 是产品约定，各后端自己决定怎么应用 ----
  'setSceneTheme',

  // ---- 诊断：可观测性是运维要求，不是渲染技术 ----
  'diagnostics',
]);

/**
 * 其他方法（`officeDiagnostics` / `groundPaintOrder` / `furniturePaintOrder`
 * 等）不在清单里，因为它们是**当前实现特有**的：
 *
 *   · `officeDiagnostics` —— PixiJS 的纹理/容器统计，别的后端没有这些概念
 *   · `groundPaintOrder` / `furniturePaintOrder` —— z-order 与容器树，
 *     是 PixiJS 的绘制模型；Live2D 用图层序号，Canvas2D 用绘制顺序数组
 *
 * 未来的后端可以实现它们（便于测试对照），但**不强制**。
 */
const BACKEND_SPECIFIC = Object.freeze([
  'officeDiagnostics',
  'groundPaintOrder',
  'furniturePaintOrder',
]);

/**
 * 渲染器的**内部方法**（非下划线开头，但不属于对外接口）。
 *
 * 为什么需要这个清单：渲染器返回的对象里混着对外方法（`resize`）和
 * 内部实现（`renderScene` / `schedulePump` / `sortIsoGround`…）。
 * 它们不是"接口"，只是恰好挂在同一个对象上。
 *
 * 接缝必须能区分这三类，否则"契约覆盖率"永远对不上——
 * 而一个对不上的接缝就是**错误的地图**，比没有更糟。
 *
 * 判定标准：**调用方（office-module / 测试）会用它吗？**
 * 不会 → 内部方法。这个清单是从真实渲染器提取后人工分类的，
 * 测试会断言"三类合计 == 真实方法面"，防止新增方法被漏分类。
 */
const BACKEND_INTERNAL = Object.freeze([
  'renderNow',
  'renderScene',
  'schedulePump',
  'armStallPoll',
  'stopStallPoll',
  'degradeToStatic',
  'stopPump',
  'buildStaticFallback',
  'syncViewSurface',
  'notifyStateChange',
  'refreshStaticRetry',
  'layoutFurniture',
  'layoutIsoFurniture',
  'layoutOfficeGroups',
  'sortGround',
  'sortIsoGround',
  'sortOfficeGround',
  'applyGroundOrder',
  'resetEntityOffsets',
  'fillIsoPolygon',
  'isoQuad',
  'drawIsoDetail',
  'drawIsoShadows',
]);

/**
 * 检查一个后端实现是否满足契约。
 *
 * 只在测试与开发期使用，**不进入运行时热路径**——
 * 接缝的价值是"让未来的人知道要做什么"，不是"运行时多一层校验"。
 *
 * @param {object} impl  渲染器实例
 * @returns {{ok:boolean, missing:string[], extra:string[], reason:string|null}}
 */
function assertBackendShape(impl) {
  if (!impl || typeof impl !== 'object') {
    return { ok: false, missing: [...BACKEND_CONTRACT], extra: [], reason: 'backend must be an object' };
  }
  const missing = BACKEND_CONTRACT.filter((name) => typeof impl[name] !== 'function');
  const known = new Set([...BACKEND_CONTRACT, ...BACKEND_SPECIFIC, ...BACKEND_INTERNAL]);
  const extra = Object.keys(impl)
    .filter((name) => typeof impl[name] === 'function' && !known.has(name))
    // 内部方法（下划线开头）不算"额外接口"
    .filter((name) => !name.startsWith('_'));

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      extra,
      reason: `backend is missing required method(s): ${missing.join(', ')}`,
    };
  }
  return { ok: true, missing: [], extra, reason: null };
}

module.exports = {
  BACKEND_CONTRACT,
  BACKEND_SPECIFIC,
  BACKEND_INTERNAL,
  assertBackendShape,
};
