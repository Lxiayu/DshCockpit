'use strict';

// test/office-pages-english.test.js — P1 English pass (2026-09-25).
//
// What this pins (the core acceptance of the office English pass):
// 1. STATIC GUARD: the three office pages (office.html / office-rail.html /
//    cockpit.html) carry NO CJK literals in real code or text — only comments
//    and, for cockpit.html, its own bilingual COPY table (the page's language
//    table itself) may contain CJK. Every user-visible string resolves through
//    src/i18n.js per language.
// 2. LANGUAGE CHANNEL: the pages follow the shell language live through the
//    same pull + push pattern as the theme (shell:get-language / shell:language),
//    and render from the SHARED dictionary exposed by the preloads — no
//    private string copy, no new office:* channel (still exactly eight).
// 3. MODULE LABEL KEYS: module-side dynamic copy is stable-key + zh-fallback —
//    employeeId-keyed names/roles, the chat pair phase (chatPhase: 'walking' |
//    'seated'), record tool rows and pending summaries carry their
//    office.* dictionary keys, and the page-side VMs resolve per language.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { STRINGS } = require('../src/i18n.js');
const officePage = require('../src/office/office-page.js');
const officeModule = require('../src/office/office-module.js');
const { toolPhraseKeyOf } = require('../src/office/runtime/tool-phrases.js');

// CJK blocks: ideographs, CJK punctuation (、。「」…), fullwidth forms （）：？
// General punctuation (… × · ≈ ¥) is shared typography and allowed.
const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * Strip comments from a mixed HTML/JS page so only real code/text remains.
 * Handles HTML comments, JS line/block comments and string literals
 * ('' "" `` with escapes) so comment markers inside strings never open a
 * comment. Regex literals are treated as plain code: none of the three pages
 * embeds "//" or "/*" inside a regex.
 */
function stripComments(src) {
  let out = '';
  let state = 'code'; // code | htmlComment | lineComment | blockComment | sq | dq | tpl
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '<' && src.startsWith('<!--', i)) { state = 'htmlComment'; i += 4; out += ' '; continue; }
      if (ch === '/' && next === '/') { state = 'lineComment'; i += 2; out += ' '; continue; }
      if (ch === '/' && next === '*') { state = 'blockComment'; i += 2; out += ' '; continue; }
      if (ch === "'") { state = 'sq'; out += ch; i += 1; continue; }
      if (ch === '"') { state = 'dq'; out += ch; i += 1; continue; }
      if (ch === '`') { state = 'tpl'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'htmlComment') {
      if (src.startsWith('-->', i)) { state = 'code'; i += 3; out += ' '; continue; }
      i += 1; continue;
    }
    if (state === 'lineComment') {
      if (ch === '\n') { state = 'code'; out += ch; i += 1; continue; }
      i += 1; continue;
    }
    if (state === 'blockComment') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; out += ' '; continue; }
      i += 1; continue;
    }
    if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if ((state === 'sq' && (ch === "'" || ch === '\n'))
      || (state === 'dq' && (ch === '"' || ch === '\n'))
      || (state === 'tpl' && ch === '`')) state = 'code';
    out += ch; i += 1;
  }
  return out;
}

function cjkHits(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (CJK.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 1. the static guard
// ---------------------------------------------------------------------------

test('GUARD office.html carries no CJK outside comments (English pass)', () => {
  const code = stripComments(read('src/office/office.html'));
  // integrity sentinels: the stripper must not have swallowed real code
  for (const anchor of ['id="office-panel"', 'createOfficePageController', 'data-i18n', 'office-runtime://local']) {
    assert.ok(code.includes(anchor), `stripper integrity: ${anchor} survived`);
  }
  assert.deepEqual(cjkHits(code), [], 'office.html code/text must be CJK-free (comments allowed)');
});

test('GUARD office-rail.html carries no CJK outside comments (English pass)', () => {
  const code = stripComments(read('src/office-rail.html'));
  for (const anchor of ['id="harness"', 'id="office"', 'data-i18n', 'officeRail']) {
    assert.ok(code.includes(anchor), `stripper integrity: ${anchor} survived`);
  }
  assert.deepEqual(cjkHits(code), [], 'office-rail.html code/text must be CJK-free (comments allowed)');
});

test('GUARD cockpit.html carries no CJK outside comments and its own COPY language table', () => {
  // Whitelist (documented): cockpit.html ships its OWN bilingual dictionary —
  // the COPY literal with a zh and an en column, consumed exclusively through
  // applyLanguage() and pinned by cockpit-ui.test.js. It IS the page's
  // language table, exactly like src/i18n.js is for the shell; everything
  // outside it must be CJK-free.
  const code = stripComments(read('src/cockpit.html'));
  for (const anchor of ['const COPY = {', 'function applyLanguage', 'id="peek"', 'id="task-peek"']) {
    assert.ok(code.includes(anchor), `stripper integrity: ${anchor} survived`);
  }
  const start = code.indexOf('const COPY = {');
  const endMark = '\n  };';
  const end = code.indexOf(endMark, start);
  assert.ok(start !== -1 && end > start, 'the COPY table region is locatable');
  let outside = code.slice(0, start) + code.slice(end + endMark.length);
  // Whitelisted individual case (reason): the first-run LANGUAGE PICKER labels
  // each option in its own language — '中文' must stay Chinese so a first-run
  // user who cannot read English yet can still find their language (the same
  // convention every OS language picker uses). 'English' is ASCII already.
  outside = outside.replaceAll('<button class="quiet" id="language-zh">中文</button>', '<button class="quiet" id="language-zh"></button>');
  assert.deepEqual(cjkHits(outside), [], 'cockpit.html must be CJK-free outside COPY + comments + the language picker');
  assert.ok(CJK.test(code.slice(start, end)), 'the COPY zh column stays the zh fallback table');
});

// ---------------------------------------------------------------------------
// 2. the language channel (shared dictionary + live switch, theme precedent)
// ---------------------------------------------------------------------------

test('office preloads expose the shared dictionary and the shell language channel', () => {
  const officePreload = read('src/office/office-preload.js');
  const railPreload = read('src/office-rail-preload.js');
  for (const [name, src] of [['office-preload', officePreload], ['office-rail-preload', railPreload]]) {
    // a SANDBOXED preload cannot require repo files: the tables arrive over
    // shell:get-i18n (single source: src/i18n.js), t() translates locally
    assert.match(src, /ipcRenderer\.invoke\('shell:get-i18n'\)/, `${name} pulls the SHARED dictionary tables`);
    assert.doesNotMatch(src, /require\('\.\.\/i18n\.js'\)/, `${name} must not require repo files (sandboxed)`);
    assert.match(src, /i18n:\s*\{\s*t:/, `${name} exposes the translator`);
    assert.match(src, /getLanguage:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('shell:get-language'\)/, `${name} pulls the shell language`);
    assert.match(src, /onLanguage:/, `${name} subscribes to shell:language pushes`);
  }
  // no new office:* channel: the office preload surface stays the pinned eight
  const officeChannels = officePreload.match(/'office:[a-z-]+'/g) || [];
  assert.equal(new Set(officeChannels).size, 8, `still exactly the eight office:* channels (${[...new Set(officeChannels)].join(', ')})`);
  const main = read('src/main.js');
  assert.match(main, /ipcMain\.handle\('shell:get-i18n'/, 'main hands out the shared dictionary tables');
  assert.match(main, /\{ t, resolveLanguage, STRINGS \} = require\('\.\/i18n'\)/, 'the tables come from the SAME src/i18n.js import');
  assert.match(main, /ipcMain\.handle\('shell:get-language'/, 'main answers the language pull');
  assert.match(main, /function broadcastLanguage\(\)/, 'main broadcasts the resolved language');
  assert.match(main, /broadcastToShellViews\('shell:language', value\)/, 'the push reaches the shell VIEWS (rail + office)');
  assert.match(main, /if \(saved\.language !== before\.language\) broadcastLanguage\(\)/, 'a saved language change re-localizes live');
  assert.match(main, /broadcastLanguage\(\); \/\/ P1 English pass/, 'cockpit:set-language follows live too');
});

test('office.html and office-rail.html render per language and follow switches live', () => {
  const html = read('src/office/office.html');
  assert.match(html, /data-i18n="/, 'static DOM copy rides data-i18n keys');
  assert.match(html, /data-i18n-aria="/, 'static aria labels ride data-i18n keys');
  assert.match(html, /function applyI18n\(\)/, 'the static copy re-applies');
  assert.match(html, /localize,\s*onSnapshot:/, 'the page controller gets the localize injection');
  assert.match(html, /bridge\.onLanguage\(setLanguage\)/, 'office.html follows language pushes live');
  assert.match(html, /applyI18n\(\);\s*\n\s*if \(changed\) renderAll\(\)/, 'a switch re-renders the panel immediately');
  const rail = read('src/office-rail.html');
  assert.match(rail, /api\.onLanguage\(setLanguage\)/, 'office-rail.html follows language pushes live');
  assert.match(rail, /data-i18n-title="office\.rail\.harness"/, 'rail labels ride dictionary keys');
});

// ---------------------------------------------------------------------------
// 3. module label keys: stable keys + zh fallback, bilingual rendering
// ---------------------------------------------------------------------------

test('i18n: every office.* label family the pages render exists in both dictionaries', () => {
  const zhKeys = Object.keys(STRINGS.zh).sort();
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.deepStrictEqual(zhKeys, enKeys, 'zh/en dictionaries cover the same keys');
  const families = [
    'office.employee.orchestrator', 'office.employee.collaborator',
    'office.role.orchestrator', 'office.role.collaborator',
    'office.activity.working', 'office.activity.chat-walking', 'office.activity.present',
    'office.status.working', 'office.status.chat-walking',
    'office.log.chat-started', 'office.log.task-started', 'office.log.dispatch-followup',
    'office.outcome.completed', 'office.runtime.attention', 'office.binding.heuristic',
    'office.control.preemptPending', 'office.details.bindingValue', 'office.details.queueLineFull',
    'office.staff.taskTitle', 'office.staff.needsYou', 'office.overview.summary',
    'office.pending.reviewAnswer', 'office.pending.risk.high', 'office.usage.empty',
    'office.timeline.turn', 'office.record.usageTip', 'office.panel.stageAria',
    'office.panel.bootFailed', 'office.degrade.layout', 'office.degrade.separator',
    'office.rail.harness', 'office.rail.officeBack', 'office.panel.sep',
  ];
  for (const key of families) {
    assert.ok(typeof STRINGS.zh[key] === 'string' && STRINGS.zh[key] !== '', `zh missing ${key}`);
    assert.ok(typeof STRINGS.en[key] === 'string' && STRINGS.en[key] !== '', `en missing ${key}`);
  }
});

test('i18n: every DYNAMIC label the page VMs can emit resolves in both dictionaries', () => {
  // the fixed vocabularies (module + page tables) must all resolve through the
  // dictionary — a missing key would leak the zh fallback into the English UI
  const ids = {
    'office.activity.': Object.keys(officePage.ACTIVITY_LABELS),
    'office.status.': Object.keys(officePage.STAFF_STATUS_LABELS),
    'office.log.': Object.keys(officePage.ACTIVITY_LOG_LABELS),
  };
  for (const [prefix, keys] of Object.entries(ids)) {
    for (const id of keys) {
      for (const lang of ['zh', 'en']) {
        assert.ok(typeof STRINGS[lang][prefix + id] === 'string' && STRINGS[lang][prefix + id] !== '',
          `${lang} missing ${prefix}${id}`);
      }
    }
  }
  // the tool phrase family the snapshot keys point at
  for (const key of ['typing', 'search', 'retrieval', 'terminal', 'command', 'edit', 'browse', 'asking', 'other']) {
    for (const lang of ['zh', 'en']) {
      assert.ok(STRINGS[lang][`office.staff.currentTool.${key}`], `${lang} missing office.staff.currentTool.${key}`);
    }
  }
  // the usage basis mapping (§4 marker -> dictionary key)
  for (const marker of ['api-key', 'subscription']) {
    const key = marker === 'api-key' ? 'office.usage.basis.apiKey' : `office.usage.basis.${marker}`;
    for (const lang of ['zh', 'en']) assert.ok(STRINGS[lang][key], `${lang} missing ${key}`);
  }
});

// English resolver over the shared dictionary (what the page injects).
const en = (key, fallback, vars) => {
  let s = STRINGS.en[key] || fallback;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = String(s).replaceAll(`{${k}}`, String(v));
  }
  return s;
};

const CHAT_WALKING_EMPLOYEE = {
  employeeId: 'coder',
  displayName: '编码员',
  role: '编码、文件、命令',
  activity: 'chatting',
  chatPhase: 'walking',
  runtime: 'idle',
  sync: 'healthy',
  control: 'none',
  binding: null,
  queueCount: 0,
};

test('semantic alignment: a chat pair still WALKING keys to the intermediate label, never 闲聊', () => {
  // zh fallback (no localize): the historical consumers see the intermediate word
  const zhPage = officePage.createOfficePageController({
    bridge: { getState: async () => ({ employees: [CHAT_WALKING_EMPLOYEE], activityLog: [], pending: [] }), onState: () => {} },
  });
  zhPage.applySnapshot({ employees: [CHAT_WALKING_EMPLOYEE], activityLog: [], pending: [] });
  const zhRow = zhPage.staffRows()[0];
  assert.equal(zhRow.statusKey, 'chat-walking', 'the badge key is the intermediate phase');
  assert.equal(zhRow.statusLabel, '前往闲聊', 'walking is NOT announced as 闲聊 (zh fallback)');
  const zhDetails = zhPage.detailsFor('coder');
  assert.equal(zhDetails.primary.text, '前往交流', 'details say heading-to-chat while walking');
  // en (the localize the page injects)
  const enPage = officePage.createOfficePageController({
    bridge: { getState: async () => ({ employees: [CHAT_WALKING_EMPLOYEE], activityLog: [], pending: [] }), onState: () => {} },
    localize: en,
  });
  enPage.applySnapshot({ employees: [CHAT_WALKING_EMPLOYEE], activityLog: [], pending: [] });
  assert.equal(enPage.staffRows()[0].statusLabel, 'To chat', 'the en badge is short');
  assert.equal(enPage.detailsFor('coder').primary.text, 'Heading to chat', 'the en details phrase');
});

test('semantic alignment: a SEATED chat pair is announced as chatting (bubbles visible)', () => {
  const seated = { ...CHAT_WALKING_EMPLOYEE, chatPhase: 'seated' };
  const enPage = officePage.createOfficePageController({
    bridge: { getState: async () => ({ employees: [seated], activityLog: [], pending: [] }), onState: () => {} },
    localize: en,
  });
  enPage.applySnapshot({ employees: [seated], activityLog: [], pending: [] });
  assert.equal(enPage.staffRows()[0].statusKey, 'chatting', 'seated keys back to chatting');
  assert.equal(enPage.staffRows()[0].statusLabel, 'Chatting', 'the en badge');
});

test('module label keys: names/roles/dim fields/log labels resolve per language with zh fallback', () => {
  const employee = {
    employeeId: 'researcher',
    displayName: '研究员',
    role: '资料检索与分析',
    activity: 'working',
    runtime: 'running',
    sync: 'healthy',
    control: 'none',
    binding: { source: 'manual', confidence: 1 },
    queueCount: 0,
    taskLabel: '执行任务中',
    taskSeq: 2,
    toolPhraseKey: 'command',
    toolPhrase: '执行命令',
  };
  const enPage = officePage.createOfficePageController({
    bridge: { getState: async () => ({ employees: [employee], activityLog: [{ kind: 'task-started', atMs: 1, employeeId: 'researcher' }], pending: [] }), onState: () => {} },
    localize: en,
  });
  enPage.applySnapshot({ employees: [employee], activityLog: [{ kind: 'task-started', atMs: 1, employeeId: 'researcher' }], pending: [] });
  const row = enPage.staffRows()[0];
  assert.equal(row.nameKey, 'office.employee.researcher', 'the stable name key rides the row');
  assert.equal(row.roleKey, 'office.role.researcher', 'the stable role key rides the row');
  // the VM keeps the zh displayName as the fallback and rides the stable key;
  // the PAGE renders tr(name.key) per language (office.html, source-pinned)
  assert.equal(enPage.detailsFor('researcher').name.key, 'office.employee.researcher');
  assert.equal(STRINGS.en['office.employee.researcher'], 'Researcher', 'names localize via the key');
  assert.equal(row.taskTitle, 'Task #2', 'the de-identified title localizes');
  assert.equal(row.toolPhrase, 'Running a command', 'tool phrases localize from the snapshot key');
  assert.equal(enPage.activityLog()[0].label, 'Task started', 'log labels localize from the stable kind');
  const details = enPage.detailsFor('researcher');
  assert.equal(details.dimFields[0].key, 'office.details.status', 'dim fields carry their label keys');
  assert.ok(details.dimFields[0].value.startsWith('Working'), 'the runtime word localizes');
  // zh fallback with NO localize stays byte-identical to the historical output
  const zhPage = officePage.createOfficePageController({
    bridge: { getState: async () => ({ employees: [employee], activityLog: [{ kind: 'task-started', atMs: 1, employeeId: 'researcher' }], pending: [] }), onState: () => {} },
  });
  zhPage.applySnapshot({ employees: [employee], activityLog: [{ kind: 'task-started', atMs: 1, employeeId: 'researcher' }], pending: [] });
  assert.equal(zhPage.staffRows()[0].taskTitle, '任务 #2');
  assert.equal(zhPage.detailsFor('researcher').primary.text, '执行任务中');
  assert.equal(zhPage.activityLog()[0].label, '开始任务');
});

test('module label keys: record tool rows and pending summaries carry stable keys', () => {
  const record = {
    dayKey: '2026-09-25',
    tasks: 1, completed: 1, failed: 0, cancelled: 0,
    usage: null, durationMs: 0,
    tools: [{ phrase: '执行命令', key: toolPhraseKeyOf('bash'), count: 3 }],
    recent: [],
  };
  const enPage = officePage.createOfficePageController({
    bridge: { getState: async () => ({ employees: [{ employeeId: 'coder', displayName: '编码员', role: 'r', activity: 'working', runtime: 'idle', sync: 'healthy', control: 'none', binding: null, queueCount: 0, record }], activityLog: [], pending: [] }), onState: () => {} },
    localize: en,
  });
  enPage.applySnapshot({ employees: [{ employeeId: 'coder', displayName: '编码员', role: 'r', activity: 'working', runtime: 'idle', sync: 'healthy', control: 'none', binding: null, queueCount: 0, record }], activityLog: [], pending: [] });
  const vm = enPage.recordFor('coder');
  assert.equal(vm.tools[0].key, 'command', 'the stable phrase key survives the VM');
  assert.equal(vm.tools[0].phrase, 'Running a command', 'record tool phrases localize');
  // pending summary keys pass through the inbox VM
  const pendingItem = { id: 'p1', kind: 'approval', employeeId: 'coder', toolName: 'bash', summary: '执行命令', summaryKey: 'command', risk: 'medium', createdAtMs: 1 };
  const summary = enPage.pendingSummary();
  void pendingItem;
  const withPending = officePage.createOfficePageController({
    bridge: { getState: async () => ({ employees: [], activityLog: [], pending: [pendingItem] }), onState: () => {} },
  });
  withPending.applySnapshot({ employees: [], activityLog: [], pending: [pendingItem] });
  assert.equal(withPending.pendingSummary().items[0].summaryKey, 'command', 'summaryKey rides the inbox row');
  assert.equal(summary.count, 0, 'sanity: the en page snapshot carried no pending');
});

// ---------------------------------------------------------------------------
// 4. the module snapshot itself: chatPhase vocabulary on real behavior
// ---------------------------------------------------------------------------

const PROD_PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const assetPack = require('../src/office/runtime/asset-pack.js');
const PROD_PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

function makeModule() {
  return officeModule.createOfficeModule({
    pack: PROD_PACK,
    // seed-2 forms a chat pair ~80s into the simulation (chat decisions are
    // probabilistic; this seed keeps the behavior test well under the window)
    seed: 'seed-2',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
  });
}

function tickFor(module, ms) {
  const steps = Math.round(ms / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) module.tickOnce();
}

function tickUntil(module, predicate, maxMs = 60000) {
  const steps = Math.round(maxMs / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    module.tickOnce();
    if (predicate(module.state())) return true;
  }
  return false;
}

test('module snapshot: chatPhase is null off-pair and a real pair walks then sits (panel == picture)', () => {
  const module = makeModule();
  tickFor(module, 500);
  for (const employee of module.state().employees) {
    assert.equal(employee.chatPhase, null, `no pair yet -> chatPhase null (${employee.employeeId})`);
  }
  // drive the local behavior until a chat pair forms (chatting 15% decision
  // probability, 6 free residents, cooldown 1s — same regime office-ui uses)
  const pairFormed = tickUntil(module, (state) => state.employees.some((e) => e.chatPhase !== null), 200000);
  assert.ok(pairFormed, 'a chat pair forms within the window');
  const snapshot = module.state();
  const pairMembers = snapshot.employees.filter((e) => e.chatPhase !== null);
  assert.ok(pairMembers.length === 2, `exactly the two pair members carry a phase (${pairMembers.length})`);
  for (const member of pairMembers) {
    assert.ok(['walking', 'seated'].includes(member.chatPhase), `the phase is the fixed vocabulary (${member.chatPhase})`);
    assert.equal(member.activity, 'chatting', 'the pair member stays chatting for the whole episode');
  }
  // the seated phase must be reachable — and the moment both stand at their
  // chat seats is exactly when the panel may say 闲聊/Chatting (bubbles show)
  const seated = tickUntil(module, (state) => state.employees.some((e) => e.chatPhase === 'seated'), 200000);
  assert.ok(seated, 'a pair member reaches the seated phase');
  for (const member of module.state().employees.filter((e) => e.chatPhase === 'seated')) {
    assert.equal(member.movement, 'stationary', 'seated means physically at the chat seat');
  }
});

test('module snapshot: the pending block and record tools carry the stable phrase keys', () => {
  const module = makeModule();
  tickFor(module, 200);
  const snapshot = module.state();
  for (const employee of snapshot.employees) {
    if (!employee.record) continue;
    for (const row of employee.record.tools) {
      assert.equal(typeof row.key, 'string', 'record tool rows carry the phrase key');
      assert.ok(['typing', 'search', 'retrieval', 'terminal', 'command', 'edit', 'browse', 'asking', 'other'].includes(row.key),
        `the key is the fixed phrase vocabulary (${row.key})`);
    }
  }
  // pending items: the summary key resolves from the tool name vocabulary
  module.notePendingRequest({ eventId: 'evt-guard-1', kind: 'approval', sessionId: 'sess-guard-1', toolName: 'bash' });
  const item = module.state().pending.find((p) => p.id === 'evt-guard-1');
  assert.ok(item, 'the pending item projected');
  assert.equal(item.summaryKey, toolPhraseKeyOf('bash'), 'the summary key derives from the tool name');
  assert.notEqual(item.summary, 'bash', 'the summary stays the fixed phrase, never the raw tool name');
});
