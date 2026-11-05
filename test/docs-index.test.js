'use strict';

// test/docs-index.test.js — 文档结构的机械校验（Harness Engineering 原则的本地化）。
//
// 背景（2026-10-27 文档重构）：
//   1. 文档不是"写完就算"——没有索引的知识对人和 agent 都等于不存在；
//   2. 索引靠自觉维护必然腐化，因此用测试强制：
//      - docs/README.md 是唯一索引；docs/ 下每个 .md（除 archive/）必须被登记；
//      - 索引里登记的路径必须真实存在（无死条目）；
//      - 索引与 AGENTS.md 里的相对链接必须可解析；
//      - 仓库地图（docs/architecture/repo-map.md）是**地图不是手册**（≤ 130 行）；
//      - 根 AGENTS.md 是**行为协议**，必须指向地图，且不得吞掉地图职责（见下方 2026-11-05 说明）。
//   3. 本测试不联网、不读业务代码，只做结构检查（毫秒级）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX = path.join(DOCS, 'README.md');
const AGENTS = path.join(ROOT, 'AGENTS.md');
const REPO_MAP = path.join(ROOT, 'docs', 'architecture', 'repo-map.md');

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

test('docs-index: relative links in docs/README.md, AGENTS.md and the repo map resolve', () => {
  for (const file of [INDEX, AGENTS, REPO_MAP]) {
    if (!fs.existsSync(file)) continue;
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

// ---------------------------------------------------------------------------
// 2026-11-05 需求变更：AGENTS.md 从「仓库地图」改为「工程代理行为协议」。
//
// 起因：仓库地图解决"这是什么仓库"，但不解决"代理会怎么乱改代码"。
// 反复出现的返工是：为了让测试变绿去改断言 / 为了让错误消失删功能 /
// 没跑验证就说完成。这些都是**行为问题**，需要一份协议而不是地图。
//
// 于是职责拆开：
//   AGENTS.md                        → 行为协议（长，可以有 300 行，但只谈做事方式）
//   docs/architecture/repo-map.md    → 仓库地图 + 项目铁律（≤ 130 行，原来的位置）
//
// 门禁没有放松，而是跟着职责转移并收紧：
//   1. 地图仍然 ≤ 130 行（原来那条断言换个文件继续守）；
//   2. AGENTS.md **必须**指向地图（否则读者找不到铁律，协议会退化成空话）；
//   3. AGENTS.md 仍然**禁止**记录阶段交付历史（原内聚门禁保留）；
//   4. 新增：AGENTS.md 有字节上限——它是每次会话都要读进上下文的文件，
//      无限增长等于每轮对话都在付费读文档。
// ---------------------------------------------------------------------------

test('docs-index: AGENTS.md is a protocol that points at the repo map', () => {
  assert.ok(fs.existsSync(AGENTS), 'AGENTS.md must exist at the repo root');
  const text = fs.readFileSync(AGENTS, 'utf8');

  // 指针必须存在，否则"协议 + 地图"的拆分对读者就是断的
  assert.ok(text.includes('docs/architecture/repo-map.md'),
    'AGENTS.md must point at docs/architecture/repo-map.md — the map moved there on 2026-11-05');
  assert.ok(fs.existsSync(REPO_MAP),
    'docs/architecture/repo-map.md must exist — it carries the repo map and the project invariants');

  // 每次会话都会读进上下文；无限增长 = 每轮都付费
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes <= 64 * 1024,
    `AGENTS.md is ${bytes} bytes — it is read into the session context every time; keep it under 64KB`);
});

test('docs-index: the repo map stays a map, not a manual (<= 130 lines)', () => {
  assert.ok(fs.existsSync(REPO_MAP), 'docs/architecture/repo-map.md must exist');
  const lines = fs.readFileSync(REPO_MAP, 'utf8').split('\n').length;
  assert.ok(lines <= 130, `repo-map.md is ${lines} lines — split details into docs/ and keep the map lean`);
});

test('docs-index: the repo map is indexed as a live doc (not a root-level orphan)', () => {
  // 地图进了 docs/ 就必须被唯一索引登记，否则"agent 看不到等于不存在"的老问题会以新形式复发
  const index = fs.readFileSync(INDEX, 'utf8');
  assert.ok(index.includes('docs/architecture/repo-map.md'),
    'docs/README.md must register docs/architecture/repo-map.md');
});

// ---------------------------------------------------------------------------
// 内聚门禁（2026-11-01 加，2026-11-05 随地图迁址扩到两个文件）
//
// 起因：AGENTS.md 触到 130 行上限时，我的做法是**把多条事实压进一行**
// 来凑数——"P3 完成 + 2 个 Pack + 真机 13/13 + 四态结论"挤在同一行。
//
// 这是拿耦合伪装成合规：行数达标了，但文件悄悄变成了
// "阶段交付历史 + 开发规则"两件事的混合体，职责不再单一。
//
// 行数门禁只能限制**体积**，管不了**分布**。所以补这一条：
//   AGENTS.md / repo-map.md → 只留当前状态 + 指针
//   delivery-status.md      → 承载各阶段交付明细
//
// 2026-11-05：地图搬进 docs/ 后，这条门禁同时盯两个文件（比原来更严）。
// 若有人再往这两处塞阶段完成记录，这里会失败并告诉他该放哪。
// ---------------------------------------------------------------------------

test('docs-index: neither the protocol nor the map records phase history (cohesion)', () => {
  const statusPath = path.join(ROOT, 'docs', 'product', 'delivery-status.md');
  assert.ok(fs.existsSync(statusPath), 'docs/product/delivery-status.md must exist — it is the phase ledger');

  // 阶段完成记录的形态：`**P1 完成（2026-...` / `**P2 全部完成...`
  const phaseRecord = /\*\*P\d[^*]*完成/;
  for (const file of [AGENTS, REPO_MAP]) {
    assert.ok(!phaseRecord.test(fs.readFileSync(file, 'utf8')),
      `${rel(file)} must not record per-phase delivery history — put it in docs/product/delivery-status.md`);
  }

  // 但必须**指向**台账，否则读者找不到
  assert.match(fs.readFileSync(REPO_MAP, 'utf8'), /docs\/product\/delivery-status\.md/,
    'the repo map must link to delivery-status.md (it owns the "current status" section now)');
});

test('docs-index: AGENTS.md keeps a pointer, delivery-status.md keeps the evidence', () => {
  const status = fs.readFileSync(path.join(ROOT, 'docs', 'product', 'delivery-status.md'), 'utf8');
  // 台账必须真的承载证据索引，而不是一句"见别处"
  for (const marker of ['P0', 'P1', 'P2', 'P3']) {
    assert.ok(status.includes(marker), `delivery-status.md must cover ${marker}`);
  }
  assert.match(status, /docs\/quality\//, 'the ledger must point at the acceptance reports');
});

test('docs-index: no duplicated single-source docs at the repo root', () => {
  // 根目录只允许产品入口文档 + AGENTS.md；契约/计划/研究一律在 docs/。
  const allowed = new Set(['AGENTS.md', 'README.md', 'README.en.md', 'DESIGN.md', 'FEATURES.md', 'RELEASE.md']);
  const rootMd = fs.readdirSync(ROOT).filter((n) => n.endsWith('.md'));
  const unexpected = rootMd.filter((n) => !allowed.has(n));
  assert.deepEqual(unexpected, [], 'unexpected root-level markdown (keep docs in docs/)');
});
