// test/settings-ui.test.js — UI quality gates for the settings shell and its
// siblings. All checks are static (fs + regex/brace-balanced parsing); nothing
// here executes renderer code against a DOM.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// ------------------------------------------------------------- parsing utils

/** Contents of every inline <script> (src-less) in an HTML file, as an array. */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/i.test(m[1])) out.push(m[2]);
  return out;
}

/**
 * Slice the `{ ... }` object literal assigned to `name` out of JS source using
 * brace counting (string-aware), so dictionaries containing braces inside
 * string values (e.g. '{a} → {b}') are captured whole. Greedy regexes break
 * on those; this does not.
 */
function objectLiteral(src, name) {
  const head = src.search(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`));
  assert.notStrictEqual(head, -1, `${name} = {…} literal not found in source`);
  let i = src.indexOf('{', head);
  let depth = 0, quote = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(src.indexOf('{', head), i + 1); }
  }
  throw new Error(`unbalanced braces while slicing the ${name} literal`);
}

/** Slice a static HTML element by id while balancing nested tags of the same
 * type. This lets ownership tests assert real containment instead of relying
 * on a regex that can accidentally cross into a sibling section. */
function elementById(html, id) {
  const openRe = new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*\\bid="${id}"[^>]*>`, 'i');
  const hit = openRe.exec(html);
  assert.ok(hit, `#${id} element not found`);
  const tag = hit[1];
  const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tokenRe.lastIndex = hit.index;
  let depth = 0;
  let token;
  while ((token = tokenRe.exec(html))) {
    depth += token[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(hit.index, tokenRe.lastIndex);
  }
  throw new Error(`#${id} has no balanced closing </${tag}>`);
}

/** A CSS custom property is declared in a block body: `--bg:` etc. */
const hasVar = (block, name) => new RegExp(`--${name}\\s*:`).test(block);

// ------------------------------------------------------------- shared fixtures

const settingsHtml = read('settings.html');
const settingsJs = inlineScripts(settingsHtml).join('\n');
const I18N = new Function('return ' + objectLiteral(settingsJs, 'I18N'))();
const norm = (k) => k.replace(/[-.]/g, '_');

// every id= in the whole file: static markup plus ids created at runtime via
// innerHTML templates inside the script (e.g. #plugin-op-label)
const allIds = new Set();
for (const m of settingsHtml.matchAll(/id="([^"]+)"/g)) allIds.add(m[1]);

// ids referenced from JS via $('x') / getElementById('x')
const referencedIds = new Set();
for (const m of settingsJs.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) referencedIds.add(m[1]);
for (const m of settingsJs.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) referencedIds.add(m[1]);

// data-i18n / data-i18n-placeholder keys (normalized to underscore form)
const domI18nKeys = new Set();
for (const m of settingsHtml.matchAll(/data-i18n-placeholder="([^"]+)"/g)) domI18nKeys.add(norm(m[1]));
for (const m of settingsHtml.matchAll(/data-i18n-title="([^"]+)"/g)) domI18nKeys.add(norm(m[1]));
for (const m of settingsHtml.matchAll(/data-i18n(?!-placeholder|-title)="([^"]+)"/g)) domI18nKeys.add(norm(m[1]));

/**
 * Keys passed to tr(): takes the first argument of every tr( call (quote- and
 * paren-aware), then:
 *  - a single string literal  → assert as-is (covers bare keys like 'title');
 *  - an expression (ternary)  → assert every literal containing '.' or '-'
 *    (comparison operands like 'remove' are skipped).
 * Plus the i18n keys routed through warn(el, 'key') and the tr-mapped
 * PLUGIN_CATS / PLUGIN_STAGE_KEYS dictionary values.
 */
function trKeys(js) {
  const keys = new Set();
  const re = /\btr\s*\(/g;
  let m;
  while ((m = re.exec(js))) {
    let i = m.index + m[0].length, depth = 1, quote = null, esc = false, arg = '';
    for (; i < js.length; i++) {
      const c = js[i];
      if (quote) {
        arg += c;
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; arg += c; continue; }
      if (c === '(' || c === '{' || c === '[') { depth++; arg += c; continue; }
      if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) break; arg += c; continue; }
      if (c === ',' && depth === 1) break; // end of the first argument
      arg += c;
    }
    const sole = arg.match(/^\s*'([^']+)'\s*$/);
    if (sole) keys.add(sole[1]);
    else for (const s of arg.matchAll(/'([^'\s]*[.-][^'\s]*)'/g)) keys.add(s[1]);
    re.lastIndex = m.index + m[0].length;
  }
  return keys;
}

const usedTrKeys = new Set([...trKeys(settingsJs)].map(norm));
for (const m of settingsJs.matchAll(/\bwarn\s*\(\s*\$\('[^']+'\)\s*,\s*'([^']+)'/g)) usedTrKeys.add(norm(m[1]));
for (const mapName of ['PLUGIN_CATS', 'PLUGIN_STAGE_KEYS', 'MARKET_CATS']) {
  const lit = objectLiteral(settingsJs, mapName);
  for (const m of lit.matchAll(/'([^']+)'/g)) usedTrKeys.add(norm(m[1]));
}

const keysMissingFrom = (keys, dict) => [...keys].filter((k) => !(k in dict));

// ------------------------------------------------------------------- tests

test('settings.html inline <script> blocks are syntactically valid', () => {
  const blocks = inlineScripts(settingsHtml);
  assert.ok(blocks.length > 0, 'expected at least one inline <script> block');
  blocks.forEach((src, i) => {
    try { new Function(src); } // compile only — never invoked, so no DOM needed
    catch (e) { throw new Error(`inline script #${i} fails to parse: ${e.message}`); }
  });
});

test('all data-i18n / data-i18n-placeholder keys exist in I18N.zh and I18N.en', () => {
  assert.ok(domI18nKeys.size > 100, `expected a full settings page worth of i18n keys, got ${domI18nKeys.size}`);
  const missZh = keysMissingFrom(domI18nKeys, I18N.zh);
  const missEn = keysMissingFrom(domI18nKeys, I18N.en);
  assert.deepStrictEqual(missZh, [], `keys missing from I18N.zh: ${missZh.join(', ')}`);
  assert.deepStrictEqual(missEn, [], `keys missing from I18N.en: ${missEn.join(', ')}`);
});

test('embedded I18N zh and en dictionaries cover the same key set', () => {
  const zh = Object.keys(I18N.zh).sort();
  const en = Object.keys(I18N.en).sort();
  assert.deepStrictEqual(zh, en,
    'zh/en key sets differ in settings.html I18N '
    + `— zh-only: [${zh.filter((k) => !en.includes(k))}], en-only: [${en.filter((k) => !zh.includes(k))}]`);
});

test("every tr('key') call (incl. ternaries, warn(), PLUGIN_CATS/STAGE maps) resolves in zh and en", () => {
  assert.ok(usedTrKeys.size > 50, `expected the full set of runtime i18n keys, got ${usedTrKeys.size}`);
  const missZh = keysMissingFrom(usedTrKeys, I18N.zh);
  const missEn = keysMissingFrom(usedTrKeys, I18N.en);
  assert.deepStrictEqual(missZh, [], `tr() keys missing from I18N.zh: ${missZh.join(', ')}`);
  assert.deepStrictEqual(missEn, [], `tr() keys missing from I18N.en: ${missEn.join(', ')}`);
});

test("$()/getElementById() references resolve to an id present in settings.html", () => {
  assert.ok(referencedIds.size > 50, `expected the full set of referenced ids, got ${referencedIds.size}`);
  const dangling = [...referencedIds].filter((id) => !allIds.has(id));
  assert.deepStrictEqual(dangling, [], `JS references undefined element ids: ${dangling.join(', ')}`);
});

test('theme.css :root defines all legacy aliases (--bg/--panel/--line/--text/--dim)', () => {
  const root = read('theme.css').match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(root, ':root block not found in theme.css');
  for (const v of ['bg', 'panel', 'line', 'text', 'dim']) {
    assert.ok(hasVar(root[1], v), `:root is missing the legacy alias --${v}`);
  }
});

test('theme.css [data-theme="light"] defines all legacy aliases (--bg/--panel/--line/--text/--dim)', () => {
  const light = read('theme.css').match(/\[data-theme="light"\]\s*\{([\s\S]*?)\}/);
  assert.ok(light, '[data-theme="light"] block not found in theme.css');
  for (const v of ['bg', 'panel', 'line', 'text', 'dim']) {
    assert.ok(hasVar(light[1], v), `[data-theme="light"] is missing the legacy alias --${v}`);
  }
});

test('plugin center: legacy #btn-open-market is gone, #plugin-cats exists', () => {
  assert.ok(!settingsHtml.includes('btn-open-market'), 'settings.html still references the removed #btn-open-market entry');
  assert.ok(allIds.has('plugin-cats'), 'settings.html is missing the #plugin-cats category container');
});

test('plugin center: category labels (legacy + curated + search chip) exist in zh and en', () => {
  const catKeys = ['plugins_catAll', 'plugins_catTheme', 'plugins_catSkills', 'plugins_catWorkflow',
    'plugins_catMemory', 'plugins_catDesign', 'plugins_catDevtools', 'plugins_catFun', 'plugins_catOther',
    'market_searchChip', 'market_searchPhGitHub'];
  const missZh = keysMissingFrom(catKeys, I18N.zh);
  const missEn = keysMissingFrom(catKeys, I18N.en);
  assert.deepStrictEqual(missZh, [], `category labels missing from I18N.zh: ${missZh.join(', ')}`);
  assert.deepStrictEqual(missEn, [], `category labels missing from I18N.en: ${missEn.join(', ')}`);
  // curated categories from awesome-dsh-plugin (MARKET_CATS values are tr-mapped)
  const lit = objectLiteral(settingsJs, 'MARKET_CATS');
  const mcatKeys = [...lit.matchAll(/'mcat\.([a-z]+)'/g)].map((m) => norm(m[0].slice(1, -1)));
  assert.ok(mcatKeys.length >= 14, `expected the full curated category set, got ${mcatKeys.length}`);
  const mMissZh = keysMissingFrom(mcatKeys, I18N.zh);
  const mMissEn = keysMissingFrom(mcatKeys, I18N.en);
  assert.deepStrictEqual(mMissZh, [], `curated category labels missing from I18N.zh: ${mMissZh.join(', ')}`);
  assert.deepStrictEqual(mMissEn, [], `curated category labels missing from I18N.en: ${mMissEn.join(', ')}`);
});

test('plugin center: chips are rendered dynamically with data-cat filters', () => {
  // renderChips() builds "all" + curated cats + the GitHub-search chip at runtime
  assert.ok(settingsJs.includes("mk('all'"), "renderChips no longer mounts the 'all' chip");
  assert.ok(settingsJs.includes('SEARCH_CHIP, tr('), 'renderChips no longer mounts the GitHub-search chip');
  assert.ok(settingsJs.includes('b.dataset.cat = cat'), 'chips must carry the data-cat filter the click handler reads');
  assert.ok(settingsJs.includes("chip.dataset.cat"), 'the chip click handler must read data-cat to switch category');
});

test('plugin center: list renders incrementally (paged) with a load-more button', () => {
  // 1000+ curated entries — only the first `limit` rows may hit the DOM at once
  assert.ok(settingsJs.includes('const PLUGIN_PAGE'), 'PLUGIN_PAGE batch size not defined');
  assert.ok(settingsJs.includes('items.slice(0, plug.limit)'), 'renderPlugins must slice items to plug.limit');
  assert.ok(settingsJs.includes("tr('plugins.loadMore'"), 'load-more button label missing');
  assert.ok(settingsJs.includes('plug.limit += PLUGIN_PAGE'), 'load-more must advance the batch window');
  // every filter change restarts from the first page
  const resets = (settingsJs.match(/plug\.limit = PLUGIN_PAGE/g) || []).length;
  assert.ok(resets >= 3, `expected limit resets on chip/input/refresh (${resets} found)`);
});

test('plugin center: toolbar has an icon search button and a separate icon refresh', () => {
  assert.ok(allIds.has('plugin-go'), 'settings.html is missing the #plugin-go search button');
  assert.ok(settingsHtml.includes('id="plugin-refresh"'), 'settings.html is missing the #plugin-refresh button');
  // both are icon-only: their i18n key lives in data-i18n-title, not text content
  assert.ok(settingsHtml.includes('data-i18n-title="plugins.go"'), 'plugin-go must be labelled via data-i18n-title');
  assert.ok(settingsHtml.includes('data-i18n-title="plugins.refresh"'), 'plugin-refresh must be labelled via data-i18n-title');
  assert.ok(!settingsHtml.includes('data-i18n="plugins.refresh"'), 'plugin-refresh should not carry a visible text label');
  assert.ok(settingsJs.includes("addEventListener('keydown'"), 'Enter in the search box should trigger the search immediately');
});

test('settings / loading / quickask / search all link theme.css', () => {
  for (const f of ['settings.html', 'loading.html', 'quickask.html', 'search.html']) {
    assert.ok(read(f).includes('<link rel="stylesheet" href="theme.css"'),
      `${f} does not <link> the shared theme.css token source`);
  }
});

// ------------------------------------- Control Center / Settings separation

test('shared centers use mutually exclusive operation and configuration sections', () => {
  const sections = {
    'cost-overview': 'control',
    'cost-config': 'settings',
    'runtime-operations': 'control',
    'runtime-config': 'settings',
    'remote-operations': 'control',
    'remote-config': 'settings',
    'channels-list': 'control',
    'channels-config': 'settings',
  };
  for (const [id, scope] of Object.entries(sections)) {
    const section = elementById(settingsHtml, id);
    assert.match(section.split('>')[0], new RegExp(`data-center-scope="${scope}"`), `#${id} has wrong scope`);
  }

  const costControl = elementById(settingsHtml, 'cost-overview');
  for (const id of ['balance-status', 'btn-balance-refresh', 'cost-status']) assert.match(costControl, new RegExp(`id="${id}"`));
  const costConfig = elementById(settingsHtml, 'cost-config');
  for (const id of ['costInputPerM', 'costPeakWindows', 'monthlyBudget']) assert.match(costConfig, new RegExp(`id="${id}"`));

  const remoteConfig = elementById(settingsHtml, 'remote-config');
  for (const id of ['remoteControl', 'remotePort', 'remoteCompat', 'remotePublicMode']) assert.match(remoteConfig, new RegExp(`id="${id}"`));
  const remoteOps = elementById(settingsHtml, 'remote-operations');
  for (const id of ['btn-remote-pair', 'btn-remote-revoke', 'btn-public-enable', 'btn-public-disable', 'btn-tunnel-start', 'btn-tunnel-stop']) {
    assert.match(remoteOps, new RegExp(`id="${id}"`));
  }

  const runtimeOps = elementById(settingsHtml, 'runtime-operations');
  for (const id of ['btn-runtime-restart', 'btn-check', 'btn-apply', 'btn-rollback', 'install-console']) assert.match(runtimeOps, new RegExp(`id="${id}"`));
  const runtimeConfig = elementById(settingsHtml, 'runtime-config');
  for (const id of ['workspace', 'dshHome', 'port', 'contextWindow']) assert.match(runtimeConfig, new RegExp(`id="${id}"`));
});

test('mode routing hides empty nav groups and reruns visibility after search filtering', () => {
  assert.match(settingsJs, /const SETTINGS_PAGES = new Set\(\[[^\]]*'cost'/);
  assert.match(settingsJs, /function syncCenterScopes\(\)/);
  assert.match(settingsJs, /function syncNavGroups\(\)/);
  assert.match(settingsJs, /applyCenterMode[\s\S]*syncCenterScopes\(\)[\s\S]*syncNavGroups\(\)/);
  const searchHandler = settingsJs.slice(settingsJs.indexOf("$('nav-search')"));
  assert.match(searchHandler, /syncNavGroups\(\)/, 'nav search must recalculate empty group labels');
  assert.match(settingsJs, /function navGroupHasVisibleItems\(items\)/, 'group visibility should be testable independently');
});

test('channels render different controls for control and settings modes', () => {
  assert.match(settingsJs, /function renderChannelOperations\(/);
  assert.match(settingsJs, /function renderChannelConfiguration\(/);
  assert.match(settingsJs, /centerMode === 'control'[\s\S]*renderChannelOperations/);
  assert.match(settingsJs, /centerMode === 'settings'[\s\S]*renderChannelConfiguration/);
  assert.doesNotMatch(elementById(settingsHtml, 'channels-list'), /credentials|allowFrom/i);
});

test('moved control operations guard duplicate clicks and refresh authoritative state after failure', () => {
  assert.match(settingsJs, /async function runControlOperation\(button, operation, refresh\)/);
  assert.match(settingsJs, /button\.disabled\s*=\s*true/);
  assert.match(settingsJs, /finally[\s\S]*button\.disabled\s*=\s*false/);
  assert.match(settingsJs, /catch[\s\S]*await refresh\(\)/);
});

test('Control Runtime renders all lifecycle states from the main-process contract', () => {
  assert.match(settingsJs, /const RUNTIME_STATE_KEYS = Object\.freeze\(\{/);
  for (const state of ['starting', 'healthy', 'restarting', 'offline']) {
    assert.match(settingsJs, new RegExp(`${state}:\\s*'runtime\\.state`));
  }
  assert.match(settingsJs, /RUNTIME_STATE_KEYS\[info\.state\]/);
  assert.doesNotMatch(settingsJs, /info\.activeVersion\s*\?\s*tr\('runtime\.stateHealthy'/);
});

test('Quick Ask shortcut is a Settings-only preset with a disabled option and failure rollback', () => {
  assert.match(settingsHtml, /id="quickAskHotkey"/);
  assert.match(settingsHtml, /value="CommandOrControl\+Alt\+Space"/);
  assert.match(settingsHtml, /value="CommandOrControl\+Shift\+Space"/);
  assert.match(settingsHtml, /value="Alt\+Space"/);
  assert.match(settingsHtml, /option value=""/);
  assert.match(settingsJs, /setQuickAskShortcut\(selected\)/);
  assert.match(settingsJs, /result\.active/);
  const preload = read('settings-preload.js');
  assert.match(preload, /getQuickAskShortcut:/);
  assert.match(preload, /setQuickAskShortcut:/);
  assert.match(settingsJs, /getQuickAskShortcut\(\)/);
  assert.match(settingsJs, /active\.active/);
});

// ------------------------------------------------- automation center (tasks)

test('automation center: header actions, three tabs and pane containers exist', () => {
  assert.ok(allIds.has('auto-new') && allIds.has('auto-ask'), 'manual-new / create-in-chat buttons missing');
  for (const t of ['tasks', 'history', 'templates']) {
    assert.ok(new RegExp(`class="auto-tab[^"]*"[^>]*data-tab="${t}"`).test(settingsHtml), `#${t} tab missing`);
  }
  assert.ok(allIds.has('auto-pane-tasks') && allIds.has('auto-pane-history') && allIds.has('auto-pane-templates'),
    'tab pane containers missing');
  assert.ok(allIds.has('auto-list') && allIds.has('auto-tpl') && allIds.has('auto-hist'),
    'task/template/history list containers missing');
});

test('automation center: task cards use the mac-window icon + card grid structure', () => {
  assert.ok(settingsHtml.includes('.auto-grid { display: grid'), 'card grid CSS missing');
  // cards carry the skeuomorphic mac window (red/yellow/green dots + svg body)
  assert.ok(settingsJs.includes('mac-dots'), 'mac-window dots markup missing');
  assert.ok(/mac-dots i:nth-child\(3\).*#28C840/.test(settingsHtml), 'green dot styling missing');
  // descriptions are clamped to 2 lines
  assert.ok(settingsHtml.includes('-webkit-line-clamp: 2'), 'card descriptions must clamp to 2 lines');
});

test('automation center: every AUTO_TPL id resolves name/desc/prompt in zh and en', () => {
  // tr('auto_tpl_' + tpl.id + '_name') builds keys dynamically, so the generic
  // tr() gate cannot see them — assert them here (ids use '-', dict uses '_')
  const head = settingsJs.indexOf('const AUTO_TPL');
  assert.ok(head !== -1, 'AUTO_TPL template list not found in settings.html');
  const lit = settingsJs.slice(head, settingsJs.indexOf('];', head));
  const ids = [...lit.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(ids.length, 8, `expected 8 built-in templates, found ${ids.length}`);
  for (const id of ids) {
    for (const part of ['name', 'desc', 'prompt']) {
      const k = `auto_tpl_${norm(id)}_${part}`;
      assert.ok(k in I18N.zh, `I18N.zh.${k} missing`);
      assert.ok(k in I18N.en, `I18N.en.${k} missing`);
      assert.ok(I18N.zh[k].length > 0 && I18N.en[k].length > 0, `${k} is empty`);
    }
  }
});

test('automation center: schedule dialog covers daily / weekly / every', () => {
  for (const id of ['auto-dialog', 'auto-f-kind', 'auto-f-day', 'auto-f-time', 'auto-f-every',
    'auto-f-name', 'auto-f-prompt', 'auto-f-save', 'auto-f-cancel']) {
    assert.ok(allIds.has(id), `#${id} missing from settings.html`);
  }
  // the kind select offers the three schedule kinds the scheduler understands
  for (const v of ['daily', 'weekly', 'every']) {
    assert.ok(settingsHtml.includes(`<option value="${v}"`), `schedule kind "${v}" not offered`);
  }
  // weekly day selector covers all 7 weekdays (0=Sun … 6=Sat)
  const dayOpts = [...settingsHtml.matchAll(/<option value="([0-6])" data-i18n="schedule\.day/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual([...dayOpts].sort(), [0, 1, 2, 3, 4, 5, 6], 'weekday options must cover 0–6');
});

test('automation center: preload exposes the history/run/clear/ask APIs used by the page', () => {
  const preload = read('settings-preload.js');
  for (const api of ['scheduledList', 'scheduledUpsert', 'scheduledRemove', 'scheduledRun',
    'scheduledHistory', 'scheduledClearHistory', 'copyAndShow', 'onScheduledChanged']) {
    assert.ok(new RegExp(`\\b${api}\\s*:`).test(preload), `settings-preload.js is missing ${api}`);
    assert.ok(settingsJs.includes(`.${api}(`), `settings.html never calls ${api}()`);
  }
});
