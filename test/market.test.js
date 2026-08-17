'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAwesomeReadme, parseZhDescriptions, buildMarketPayload, isCacheFresh } = require('../src/market');

// excerpt mirroring the real awesome-dsh-plugin README structure: a TOC with
// anchor links (the trap — they must NOT be parsed as plugins), then the
// Plugins region with categories, then a following top-level section
const EN = `# Awesome DSH Plugin

## Contents
- [Plugins](#plugins)
  - [UI Enhancements](#ui-enhancements)
  - [Themes & Appearance](#themes--appearance)
- [Badge](#badge)

## Plugins

### UI Enhancements

- [01Virex/dsh-status-rotator](https://github.com/01Virex/dsh-status-rotator) - Replaces the "Deep diving..." label with rotating phrases.
- [0xsline/dsh-spotlight](https://github.com/0xsline/dsh-spotlight) — Keyboard-first command palette for the DSH Web UI.
- [1123762794/dsh-web-restart](https://github.com/1123762794/dsh-web-restart) - One-click restart button.

### Themes & Appearance

- [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) - **Whale-themed** skin collection (maid-atelier).
- [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) - Terminal UI.

## Badge

- [not-a-plugin](#badge) - this section is outside the Plugins region
`;

const ZH = `## 目录
- [插件](#插件)

## 插件

### 🎨 UI 增强

- [01Virex/dsh-status-rotator](https://github.com/01Virex/dsh-status-rotator) — 把回合状态替换成更有梗的自定义文案。
- [0xsline/dsh-spotlight](https://github.com/0xsline/dsh-spotlight) — 键盘优先的命令面板。

### 🎭 主题与外观

- [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) — 鲸鱼娘皮肤合集。
`;

test('parseAwesomeReadme extracts entries only from the Plugins region, ignoring the TOC', () => {
  const entries = parseAwesomeReadme(EN);
  assert.strictEqual(entries.length, 5);
  assert.deepStrictEqual(entries.map((e) => e.fullName), [
    '01Virex/dsh-status-rotator', '0xsline/dsh-spotlight', '1123762794/dsh-web-restart',
    'Small-tailqwq/dsh-deep-whale', 'ccch1mneyyy/dsh-TUI',
  ]);
  // categories map to stable ids; document order preserved
  assert.deepStrictEqual(entries.map((e) => e.category), ['ui', 'ui', 'ui', 'theme', 'theme']);
  // both `-` and `—` separators work; ** markers stripped from descriptions
  assert.ok(entries[0].desc.startsWith('Replaces the "Deep diving..."'));
  assert.strictEqual(entries[3].desc.includes('**'), false);
  assert.ok(entries[3].desc.includes('Whale-themed'));
});

test('parseZhDescriptions joins by repo across differing headings', () => {
  const zh = parseZhDescriptions(ZH);
  assert.strictEqual(zh.get('01Virex/dsh-status-rotator'), '把回合状态替换成更有梗的自定义文案。');
  assert.strictEqual(zh.get('Small-tailqwq/dsh-deep-whale'), '鲸鱼娘皮肤合集。');
  assert.strictEqual(zh.has('ccch1mneyyy/dsh-TUI'), false); // absent from zh — falls back to en
});

test('buildMarketPayload assembles chips with counts and joins stars/installed', () => {
  const entries = parseAwesomeReadme(EN);
  for (const e of entries) e.descZh = parseZhDescriptions(ZH).get(e.fullName) || '';
  const starMap = {
    '01Virex/dsh-status-rotator': { stars: 12, updated: '2026-08-01' },
    'ccch1mneyyy/dsh-TUI': { stars: 3, updated: '2026-07-20' },
  };
  const installed = new Set(['Small-tailqwq/dsh-deep-whale']);
  const { categories, plugins } = buildMarketPayload(entries, starMap, installed);
  assert.deepStrictEqual(categories, [
    { id: 'ui', count: 3 }, { id: 'theme', count: 2 },
  ]);
  const byName = Object.fromEntries(plugins.map((p) => [p.fullName, p]));
  assert.strictEqual(byName['01Virex/dsh-status-rotator'].stars, 12);
  assert.strictEqual(byName['0xsline/dsh-spotlight'].stars, null); // not enriched — renders as —
  assert.strictEqual(byName['Small-tailqwq/dsh-deep-whale'].installed, true);
  assert.strictEqual(byName['ccch1mneyyy/dsh-TUI'].installed, false);
  // zh desc preferred when present, en kept for language switching
  assert.strictEqual(byName['Small-tailqwq/dsh-deep-whale'].description, '鲸鱼娘皮肤合集。');
  assert.ok(byName['Small-tailqwq/dsh-deep-whale'].descriptionEn.includes('Whale-themed'));
  assert.strictEqual(byName['ccch1mneyyy/dsh-TUI'].description, byName['ccch1mneyyy/dsh-TUI'].descriptionEn);
});

test('isCacheFresh validates age, shape and emptiness', () => {
  const now = Date.now();
  const mk = (fetchedAt, entries) => ({ fetchedAt, entries });
  assert.strictEqual(isCacheFresh(mk(now - 1000, [{}]), now), true);
  assert.strictEqual(isCacheFresh(mk(now - 25 * 3600 * 1000, [{}]), now), false); // past 24h TTL
  assert.strictEqual(isCacheFresh(mk(now, []), now), false);       // empty cache is not usable
  assert.strictEqual(isCacheFresh(mk(now, [{}]), now), true);
  assert.strictEqual(isCacheFresh(null, now), false);
  assert.strictEqual(isCacheFresh({ entries: [{}] }, now), false); // no fetchedAt
});

test('parseAwesomeReadme tolerates malformed input', () => {
  assert.deepStrictEqual(parseAwesomeReadme(''), []);
  assert.deepStrictEqual(parseAwesomeReadme('# no headings here'), []);
  // entries before any category heading are ignored (no category context)
  assert.deepStrictEqual(parseAwesomeReadme('## Plugins\n\n- [a/b](https://github.com/a/b) - x\n'), []);
});
