// test/models-credentials.test.js — models-manager 的凭据文件读写。
//
// 第一性原理：这个 bug 为什么能活这么久
//
//   `upsertCredential` 把 `${REF}: ${value}` **追加到文件末尾**。
//   当 `.credentials.yaml` 里已经有 `refs:` 段（用户先配过别的 provider），
//   新 key 就落到了**顶层**。
//
//   为什么没人发现：
//     · 本应用自己的 vault（userData/model-keys.json）里有值
//     · 所以设置页的"测试连接"是绿的
//     · 但 **runtime 只从 refs 段读** → 真正调用时 Agent 说没 key
//
//   这是一个"两层存储不一致"的经典陷阱：本应用能读，runtime 读不到。
//   所以本文件的重点是：**写出去的 YAML 结构必须让 runtime 能读**。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { upsertCredential, readCredential } = require('../src/models-manager.js');

/** 模拟 runtime 的读法：只在 `refs:` 段里找。 */
function readFromRefsSection(text, ref) {
  const lines = String(text || '').split('\n');
  const at = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (!/^\s+/.test(l)) break; // 出了 refs 段
    const m = l.match(new RegExp(`^\\s+${ref}:\\s*(.+)$`));
    if (m) return m[1].trim();
  }
  return null;
}

// ============================================ 核心：必须写进 refs 段

test('credentials: a NEW ref lands INSIDE the refs section', () => {
  // 这正是原来的 bug：追加到末尾 → 顶层 → runtime 读不到。
  const before = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-old\n';
  const after = upsertCredential(before, 'STEP_API_KEY', 'sk-new');
  assert.strictEqual(readFromRefsSection(after, 'STEP_API_KEY'), 'sk-new',
    'the runtime only reads refs: — the new key must be indented under it');
});

test('credentials: the new ref keeps its neighbours intact', () => {
  const before = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-old\n  OPENDESIGN_API_KEY: od-old\n';
  const after = upsertCredential(before, 'STEP_API_KEY', 'sk-new');
  assert.strictEqual(readFromRefsSection(after, 'DEEPSEEK_API_KEY'), 'sk-old');
  assert.strictEqual(readFromRefsSection(after, 'OPENDESIGN_API_KEY'), 'od-old');
  assert.strictEqual(readFromRefsSection(after, 'STEP_API_KEY'), 'sk-new');
});

test('credentials: a LATER top-level section is not broken', () => {
  // records: 段必须还在，且它的子行不能被插进去。
  const before = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-old',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
  ].join('\n');
  const after = upsertCredential(before, 'STEP_API_KEY', 'sk-new');
  assert.strictEqual(readFromRefsSection(after, 'STEP_API_KEY'), 'sk-new');
  // records 段完整
  assert.match(after, /records:\n  client-connection\/browser-session:\n    kind: grant/);
});

test('credentials: an EXISTING ref is updated in place (no duplicate)', () => {
  const before = 'version: 1\nrefs:\n  STEP_API_KEY: old-value\n';
  const after = upsertCredential(before, 'STEP_API_KEY', 'new-value');
  assert.strictEqual(readFromRefsSection(after, 'STEP_API_KEY'), 'new-value');
  assert.strictEqual((after.match(/STEP_API_KEY/g) || []).length, 1, 'no duplicate lines');
});

test('credentials: an empty file stays FLAT (no invented sections)', () => {
  // 尊重原格式：空文件没有 refs 段，就不要凭空造一个——
  // 那会改变用户文件的形态，且旧的读取逻辑仍能读到。
  const after = upsertCredential('', 'STEP_API_KEY', 'sk-new');
  assert.match(after, /^STEP_API_KEY: sk-new$/m);
  assert.strictEqual(readCredential(after, 'STEP_API_KEY'), 'sk-new');
});

test('credentials: a flat file stays flat (format is preserved, not upgraded)', () => {
  // 重要：不能为了"统一格式"去改造用户已有的文件——
  // 那会破坏注释与顺序（见 models-manager.test.js 的 line-level 契约）。
  const before = 'version: 1\n';
  const after = upsertCredential(before, 'STEP_API_KEY', 'sk-new');
  assert.match(after, /^STEP_API_KEY: sk-new$/m);
  assert.doesNotMatch(after, /^refs:$/m, 'must not inject a refs section into a flat file');
  assert.strictEqual(readCredential(after, 'STEP_API_KEY'), 'sk-new');
});

test('credentials: refs with no children yet is handled', () => {
  const after = upsertCredential('version: 1\nrefs:\n', 'STEP_API_KEY', 'sk-new');
  assert.strictEqual(readFromRefsSection(after, 'STEP_API_KEY'), 'sk-new');
});

// ============================================ 与旧的读取函数一致

test('credentials: readCredential still reads what upsertCredential wrote', () => {
  // 兼容性：旧读取函数用的是宽松匹配，必须仍能读到。
  const after = upsertCredential('version: 1\nrefs:\n  A_API_KEY: a\n', 'STEP_API_KEY', 'sk-new');
  assert.strictEqual(readCredential(after, 'STEP_API_KEY'), 'sk-new');
});

// ============================================ 变异守卫

test('credentials: in a SECTIONED file the new ref is indented (mutation guard)', () => {
  // 有人把实现改回"盲追加"，上面第一条会红；这里再直接断言形态。
  const after = upsertCredential('version: 1\nrefs:\n  A_API_KEY: a\n', 'B_API_KEY', 'b');
  assert.match(after, /\n {2}B_API_KEY: b/, 'the ref line must be indented by two spaces');
  assert.doesNotMatch(after, /\nB_API_KEY: b/, 'never at column 0 when a refs section exists');
});

test('credentials: in a FLAT file the ref stays at column 0 (no false indent)', () => {
  const after = upsertCredential('A_API_KEY: a\n', 'B_API_KEY', 'b');
  assert.match(after, /^B_API_KEY: b$/m);
});
