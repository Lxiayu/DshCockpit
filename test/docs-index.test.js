'use strict';

// test/docs-index.test.js — 文档结构的机械校验（Harness Engineering 原则的本地化）。
//
// 背景（2026-10-27 文档重构）：
//   1. 文档不是"写完就算"——没有索引的知识对人和 agent 都等于不存在；
//   2. 索引靠自觉维护必然腐化，因此用测试强制：
//      - docs/README.md 是唯一索引；docs/ 下每个 .md（除 archive/）必须被登记；
//      - 索引里登记的路径必须真实存在（无死条目）；
//      - 索引与 AGENTS.md 里的相对链接必须可解析；
//      - AGENTS.md 是**地图不是手册**（≤ 130 行，超了就该拆分）。
//   3. 本测试不联网、不读业务代码，只做结构检查（毫秒级）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX = path.join(DOCS, 'README.md');
const AGENTS = path.join(ROOT, 'AGENTS.md');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/** 索引中出现的 `docs/...` / `AGENTS.md` 反引号路径。 */
function listedPaths(text) {
  return [...text.matchAll(/`((?:docs|archive)\/[^`\n]+?\.md|AGENTS\.md)`/g)].map((m) => m[1]);
}

test('docs-index: docs/README.md is the single index and every non-archived doc is listed', () => {
  assert.ok(fs.existsSync(INDEX), 'docs/README.md must exist (the single index)');
  const listed = new Set(listedPaths(fs.readFileSync(INDEX, 'utf8')));
  const files = walk(DOCS)
    .map(rel)
    .filter((p) => p !== 'docs/README.md')
    .filter((p) => !p.startsWith('docs/archive/'));
  const missing = files.filter((p) => !listed.has(p));
  assert.deepEqual(missing, [],
    'every docs/ file outside docs/archive must be registered in docs/README.md '
    + '(agents cannot see what is not indexed)');
});

test('docs-index: no dead entries (every indexed path exists)', () => {
  const listed = [...new Set(listedPaths(fs.readFileSync(INDEX, 'utf8')))];
  assert.ok(listed.length >= 10, 'the index must actually list the docs');
  const dead = listed.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert.deepEqual(dead, [], 'the index must not reference missing files');
});

test('docs-index: relative links in docs/README.md and AGENTS.md resolve', () => {
  for (const file of [INDEX, AGENTS]) {
    const text = fs.readFileSync(file, 'utf8');
    const base = path.dirname(file);
    // Markdown links [text](target) —— 只检查相对路径（跳过 http/#/mailto）。
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].trim();
      if (/^(https?:|#|mailto:)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (clean === '') continue;
      const resolved = path.resolve(base, clean);
      assert.ok(fs.existsSync(resolved), `${rel(file)} links to a missing target: ${target}`);
    }
  }
});

test('docs-index: AGENTS.md stays a map, not a manual (<= 130 lines)', () => {
  assert.ok(fs.existsSync(AGENTS), 'AGENTS.md must exist at the repo root');
  const lines = fs.readFileSync(AGENTS, 'utf8').split('\n').length;
  assert.ok(lines <= 130, `AGENTS.md is ${lines} lines — split details into docs/ and keep the map lean`);
});

test('docs-index: no duplicated single-source docs at the repo root', () => {
  // 根目录只允许产品入口文档 + AGENTS.md；契约/计划/研究一律在 docs/。
  const allowed = new Set(['AGENTS.md', 'README.md', 'README.en.md', 'DESIGN.md', 'FEATURES.md', 'RELEASE.md']);
  const rootMd = fs.readdirSync(ROOT).filter((n) => n.endsWith('.md'));
  const unexpected = rootMd.filter((n) => !allowed.has(n));
  assert.deepEqual(unexpected, [], 'unexpected root-level markdown (keep docs in docs/)');
});
