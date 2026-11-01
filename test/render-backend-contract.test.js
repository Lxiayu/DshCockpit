// test/render-backend-contract.test.js — RenderBackend 接缝（ADR-0006 §6.1）。
//
// 第一性原理：这个文件为什么存在
//
//   AGENTS.md §2.6 说「一个实现时不造接口」。当前确实只有一个渲染器实现。
//
//   所以这里做的**不是抽象层**，是**接缝**——标出"未来换后端时要实现什么"。
//   成本近零，收益是：未来接 Live2D 的人不用从 4673 行里考古。
//
//   接缝如果与真实实现不一致，它就变成了**错误的地图**——比没有更糟。
//   所以本文件最重要的一条是：**契约必须与真实渲染器的方法面对得上**。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const contract = require(path.join(ROOT, 'src/office/render/render-backend-contract.js'));
const { BACKEND_CONTRACT, BACKEND_SPECIFIC, BACKEND_INTERNAL, assertBackendShape } = contract;

/** 从真实渲染器源码里抽出它返回的方法名（静态提取，无需 PixiJS 环境）。 */
function realRendererMethods() {
  const src = fs.readFileSync(path.join(ROOT, 'src/office/render/pixi-office-renderer.js'), 'utf8');
  // 排除关键字：正则会把 `if (` / `for (` / `return (` 也匹配进来。
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);
  const names = [];
  for (const m of src.matchAll(/^    ([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)) {
    if (!KEYWORDS.has(m[1])) names.push(m[1]);
  }
  return [...new Set(names)];
}

// ============================================ 契约与真实实现一致（最重要）

test('seam: every contract method EXISTS on the real renderer (the map must match the land)', () => {
  // 接缝如果列了一个真实实现没有的方法，未来后端会实现一个不存在的东西；
  // 如果漏了一个真实有的方法，未来后端会漏实现而没人知道。
  const real = realRendererMethods();
  const onReal = real.filter((n) => typeof n === 'string' && !n.startsWith('_'));
  const missing = BACKEND_CONTRACT.filter((m) => !onReal.includes(m));
  assert.deepEqual(missing, [],
    `contract lists methods the renderer does not have: ${missing.join(', ')}`);
});

test('seam: the contract covers every PUBLIC renderer method (no silent gap)', () => {
  // 反向：真实渲染器的每个公开方法，都必须在契约或"技术特有"清单里。
  // 否则未来后端会漏实现一个其实必需的方法。
  const real = realRendererMethods();
  const known = new Set([...BACKEND_CONTRACT, ...BACKEND_SPECIFIC, ...BACKEND_INTERNAL]);
  const uncovered = real.filter((n) => !known.has(n));
  // _ 开头的是明确的私有，不算漏分类
  assert.deepEqual(uncovered, [],
    `renderer methods not classified in the contract: ${uncovered.join(', ')}`);
});

// ============================================ 必需 vs 技术特有

test('seam: PixiJS-specific concepts are OPTIONAL, not required', () => {
  // groundPaintOrder / furniturePaintOrder 暴露的是 PixiJS 的容器树与 z-order。
  // 一个 Live2D 或 Canvas2D 后端没有"ground 容器"这种东西——
  // 把它们列为必需等于要求未来后端伪造一个它不需要的概念。
  for (const name of ['groundPaintOrder', 'furniturePaintOrder', 'officeDiagnostics']) {
    assert.ok(BACKEND_SPECIFIC.includes(name), `${name} must be classified as backend-specific`);
    assert.ok(!BACKEND_CONTRACT.includes(name), `${name} must NOT be in the required list`);
  }
});

test('seam: product semantics are required (hit testing, drag, theme, visibility)', () => {
  // 这些是**产品行为**，不是渲染细节。换任何后端都必须能点中员工、能拖、能换主题。
  for (const name of ['hitTest', 'beginDrag', 'dragTo', 'endDrag', 'setSelection',
    'setSceneTheme', 'setVisible', 'setReducedMotion', 'setPresenting']) {
    assert.ok(BACKEND_CONTRACT.includes(name), `${name} is product semantics and must be required`);
  }
});

test('seam: lifecycle methods are required', () => {
  for (const name of ['resize', 'destroy', 'pause', 'resume', 'diagnostics']) {
    assert.ok(BACKEND_CONTRACT.includes(name), `${name} must be required`);
  }
});

// ============================================ assertBackendShape 的行为

test('seam: an empty object reports every required method as missing', () => {
  const r = assertBackendShape({});
  assert.strictEqual(r.ok, false);
  assert.deepEqual(r.missing.sort(), [...BACKEND_CONTRACT].sort());
});

test('seam: a partial backend names exactly what is missing', () => {
  const impl = {};
  for (const m of BACKEND_CONTRACT) impl[m] = () => {};
  delete impl.hitTest;
  delete impl.dragTo;
  const r = assertBackendShape(impl);
  assert.strictEqual(r.ok, false);
  assert.deepEqual(r.missing.sort(), ['dragTo', 'hitTest']);
});

test('seam: a complete backend passes', () => {
  const impl = {};
  for (const m of BACKEND_CONTRACT) impl[m] = () => {};
  assert.strictEqual(assertBackendShape(impl).ok, true);
});

test('seam: a backend may omit the optional methods and still pass', () => {
  // 这是"接缝不是抽象层"的直接体现：不强制实现技术特有的东西。
  const impl = {};
  for (const m of BACKEND_CONTRACT) impl[m] = () => {};
  const r = assertBackendShape(impl);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.extra.length, 0);
});

test('seam: a non-function property does not satisfy the contract', () => {
  const impl = {};
  for (const m of BACKEND_CONTRACT) impl[m] = () => {};
  impl.hitTest = 'not a function';
  const r = assertBackendShape(impl);
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('hitTest'));
});

test('seam: a null/undefined backend is rejected without throwing', () => {
  for (const bad of [null, undefined, 42, 'x']) {
    const r = assertBackendShape(bad);
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason);
  }
});

test('seam: internal (underscore) helpers are not reported as extra surface', () => {
  const impl = {};
  for (const m of BACKEND_CONTRACT) impl[m] = () => {};
  impl._internal = () => {};
  assert.deepEqual(assertBackendShape(impl).extra, []);
});

// ============================================ 不引入运行时成本

test('seam: it adds NO runtime dependency on the renderer', () => {
  // 接缝的价值是"让未来的人知道要做什么"，不是"运行时多一层校验"。
  const src = fs.readFileSync(path.join(ROOT, 'src/office/render/render-backend-contract.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /require\(/, 'the contract must not require anything (zero runtime cost)');
  assert.doesNotMatch(code, /pixi/i, 'and must not mention pixi — it describes semantics, not a technology');
});

test('seam: the renderer itself is unchanged by this seam', () => {
  // 绝对不做的事：为了让"接口"好看而去改 4673 行的渲染器。
  const src = fs.readFileSync(path.join(ROOT, 'src/office/render/pixi-office-renderer.js'), 'utf8');
  assert.doesNotMatch(src, /render-backend-contract/,
    'the renderer must not import the contract — the seam is documentation + a test-time check');
});
