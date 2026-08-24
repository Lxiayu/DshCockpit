// test/notification-center.test.js — R6 unified hub: pass-through default,
// DND window (incl. midnight crossing), per-kind mutes, 60s folding, JSONL
// history with cap/search/corruption tolerance.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createNotificationCenter, parseDndWindow, inDndWindow, KINDS, MAX_HISTORY } = require('../src/notification-center');

function fixture({ settings = {}, clock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-'));
  const file = path.join(dir, 'notification-history.jsonl');
  let t = 1_700_000_000_000;
  const nowFn = clock || (() => t);
  const toasts = [];
  const nc = createNotificationCenter({
    getSettings: () => settings,
    historyFile: () => file,
    now: nowFn,
    showSystem: ({ title, body }) => toasts.push({ title, body }),
    log: () => {},
  });
  return {
    nc, toasts, file, settings,
    tick: (ms) => { t += ms; },
    rawHistory: () => fs.readFileSync(file, 'utf8'),
  };
}

test('default posture is pass-through: every toast fires AND history is kept', () => {
  const f = fixture({});
  f.nc.enqueue({ kind: 'system', title: 'A', body: 'a' });
  f.nc.enqueue({ kind: 'approval', title: 'B', body: 'b' });
  assert.strictEqual(f.toasts.length, 2);
  assert.strictEqual(f.nc.list().length, 2);
  assert.match(f.rawHistory(), /"kind":"approval"/);
});

test('hub disabled (C-6 master off): legacy direct behaviour, ZERO new failure paths or files', () => {
  const f = fixture({ settings: { notificationCenterEnabled: false } });
  f.nc.enqueue({ kind: 'system', title: 'X', body: '' });
  assert.strictEqual(f.toasts.length, 1, 'toast still fires');
  assert.strictEqual(f.nc.list().length, 0, 'no history recorded');
  assert.strictEqual(fs.existsSync(f.file), false, 'history file never created');
});

test('do-not-disturb: inside the window toasts are silent but still recorded', () => {
  // 00:30 local — inside the default 23:00-07:00 window
  const d = new Date(); d.setHours(0, 30, 0, 0);
  const f = fixture({ settings: { notifDndEnabled: true }, clock: () => d.getTime() });
  const v = f.nc.enqueue({ kind: 'completion', title: 'done', body: '' });
  assert.strictEqual(v.shown, false);
  assert.strictEqual(v.reason, 'dnd');
  assert.strictEqual(f.toasts.length, 0);
  assert.strictEqual(f.nc.list().length, 1, 'recorded while silent');
});

test('DND disabled (default) → same time of day toasts normally', () => {
  const d = new Date(); d.setHours(0, 30, 0, 0);
  const f = fixture({ clock: () => d.getTime() });
  const v = f.nc.enqueue({ kind: 'system', title: 'late but loud' });
  assert.strictEqual(v.shown, true);
  assert.strictEqual(f.toasts.length, 1);
});

test('per-kind mute: muted kinds are recorded but never toast', () => {
  const f = fixture({ settings: { notifKindsDisabled: ['budget'] } });
  const v = f.nc.enqueue({ kind: 'budget', title: 'over budget' });
  assert.strictEqual(v.reason, 'kind-disabled');
  assert.strictEqual(f.toasts.length, 0);
  f.nc.enqueue({ kind: 'approval', title: 'needs you' });
  assert.strictEqual(f.toasts.length, 1);
});

test('folding (opt-in): identical key within 60s suppresses the toast; other keys and later repeats fire', () => {
  let t = 1_000_000;
  const f = fixture({ settings: { notifFoldEnabled: true }, clock: () => t });
  f.nc.enqueue({ kind: 'completion', title: 'session A finished' });
  f.tick(10_000);
  const folded = f.nc.enqueue({ kind: 'completion', title: 'session A finished' });
  assert.strictEqual(folded.reason, 'folded');
  f.nc.enqueue({ kind: 'completion', title: 'session B finished' }); // different key fires
  f.tick(61_000); // window elapsed for key A
  const again = f.nc.enqueue({ kind: 'completion', title: 'session A finished' });
  assert.strictEqual(again.shown, true);
  assert.strictEqual(f.toasts.length, 3);
  // all four events are in history despite only three toasts
  assert.strictEqual(f.nc.list().length, 4);
});

test('history search: query matches title/body case-insensitively; kind filter; newest first', () => {
  const f = fixture({});
  f.nc.enqueue({ kind: 'budget', title: 'Budget 80%', body: 'monthly spend' });
  f.nc.enqueue({ kind: 'approval', title: 'Approve rm -rf', body: 'tool bash' });
  f.nc.enqueue({ kind: 'completion', title: 'Refactor DONE', body: '42 files' });
  const all = f.nc.list();
  assert.strictEqual(all[0].title, 'Refactor DONE', 'newest first');
  const hits = f.nc.list({ query: 'RM -RF' });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].kind, 'approval');
  assert.strictEqual(f.nc.list({ kind: 'budget' }).length, 1);
  assert.strictEqual(f.nc.list({ limit: 2 }).length, 2);
});

test('cap: history keeps at most MAX_HISTORY entries (oldest dropped)', () => {
  const f = fixture({});
  for (let i = 0; i < MAX_HISTORY + 25; i++) f.nc.enqueue({ kind: 'system', title: `n${i}` });
  assert.strictEqual(f.nc.list({ limit: 500 }).length, MAX_HISTORY);
  const first = f.nc.list({ limit: 500 }).pop(); // oldest surviving
  assert.strictEqual(first.title, `n${25}`, 'oldest 25 entries were trimmed');
});

test('corrupt JSONL lines are skipped, good lines survive a rewrite cycle', () => {
  const f = fixture({});
  f.nc.enqueue({ kind: 'system', title: 'good-1' });
  fs.appendFileSync(f.file, '{broken json\n');
  f.nc.enqueue({ kind: 'system', title: 'good-2' });
  assert.strictEqual(f.nc.list().length, 2, 'corrupt line skipped on read');
  f.nc.clear();
  assert.strictEqual(f.nc.list().length, 0);
  assert.ok(f.rawHistory().length <= 1, 'clear leaves an empty store');
});

test('DND parsing: malformed windows are rejected, midnight-crossing works', () => {
  assert.deepStrictEqual(parseDndWindow('23:00-07:00'), [1380, 420]);
  assert.deepStrictEqual(parseDndWindow('9:00-18:00'), [540, 1080]);
  assert.strictEqual(parseDndWindow('25:00-07:00'), null);
  assert.strictEqual(parseDndWindow('abc'), null);
  assert.strictEqual(parseDndWindow('09:00-09:00'), null);
  assert.strictEqual(inDndWindow(23 * 60 + 30, [1380, 420]), true, '23:30 inside 23:00-07:00');
  assert.strictEqual(inDndWindow(12 * 60, [1380, 420]), false, 'noon outside');
  assert.strictEqual(inDndWindow(6 * 60 + 59, [1380, 420]), true, '06:59 inside (crossing)');
  assert.strictEqual(inDndWindow(540, [540, 1080]), true, 'start inclusive');
});

test('unknown kinds fall back to system; all five documented kinds accepted', async () => {
  const f = fixture({});
  assert.deepStrictEqual([...KINDS].sort(), ['approval', 'budget', 'completion', 'question', 'system']);
  const v = f.nc.enqueue({ kind: 'alien', title: 'x' });
  assert.strictEqual(v.shown, true);
  assert.strictEqual(f.nc.list()[0].kind, 'system', 'aliens recorded as system');
});
