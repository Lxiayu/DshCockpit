// test/token-stats-cache.test.js — 解析缓存必须有足够容量
//
// 第一性原理：这是一个**实测暴露的真实性能 bug**（2026-11-02）：
//
//   解析缓存上限是 100，但本机有 102 个会话文件。
//   于是每次 collect 都在淘汰缓存，**热缓存和冷缓存一样慢**（3.5 秒）。
//
//   实测对比：
//     修复前  冷 3503ms  热 3539ms   ← 缓存完全无效
//     修复后  冷 3706ms  热    2ms   ← 1769× 提升
//
// 所以本测试断言的是「缓存容量足够」这个**结构性质**，
// 而不是某个具体耗时（耗时在 CI 上不稳定）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'token-stats.js'), 'utf8');

test('the parse cache cap is large enough for a real session tree', () => {
  const m = SRC.match(/const PARSE_CACHE_MAX = (\d+);/);
  assert.ok(m, 'PARSE_CACHE_MAX must be declared');
  const cap = Number(m[1]);
  // 100 就是原来那个 bug 的值；断言它明显更大
  assert.ok(cap >= 512, `cache cap ${cap} is too small — the old cap of 100 made the cache never warm`);
});

test('the cache evicts in BATCHES, not one-per-set', () => {
  // 原来：if (size > 100) { delete one }
  // → 容量被钉死在 100，多出来的文件永远反复解析。
  const hasBatch = /dropCount\s*=\s*Math\.ceil\(PARSE_CACHE_MAX \* 0\.25\)/.test(SRC);
  assert.ok(hasBatch, 'eviction must free a batch (25%), otherwise the cap acts as a hard wall');
});

test('a warm collect is dramatically faster than a cold one (real tree)', async () => {
  // 用真实 DSH_HOME（如果存在）；不存在就跳过——CI 上没有用户目录
  const dshHome = path.join(os.homedir(), '.dsh');
  if (!fs.existsSync(path.join(dshHome, 'sessions'))) return; // skip silently
  const tokenStats = require(path.join(ROOT, 'src', 'token-stats.js'));
  await tokenStats.collect(dshHome, { forceWalk: true });   // 冷
  const t = Date.now();
  await tokenStats.collect(dshHome, {});                    // 热
  const warm = Date.now() - t;
  // 热必须是毫秒级。原来这里是 3500ms+，正是这个 bug 的症状。
  assert.ok(warm < 500, `warm collect took ${warm}ms — the cache is not actually warm`);
});
