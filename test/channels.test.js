// test/channels.test.js — IM channel system skeleton coverage (C5, v0.2.4).
//
// Pure-logic tests over src/channels/: one-shot tokens, allowlist admission,
// event→message formatting (card + text), sender card/text fallback, offline
// queue policy, channel state machine, safeStorage credential vault, sticky
// session bindings, the inbound command dispatcher, and the channel-manager
// lifecycle hub (not-installed slots, exponential reconnect, broadcast
// debounce, offline queue replay). No Electron required: safeStorage is
// faked, timers are injected.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OneShotTokens, DEFAULT_TTL_MS } = require('../src/channels/one-shot-tokens');
const { isAllowed, parseAllowFrom } = require('../src/channels/allowlist');
const { formatEvent } = require('../src/channels/formatter');
const { createSender } = require('../src/channels/senders/base');
const { OutboundQueue, DEFAULT_MAX_QUEUED } = require('../src/channels/outbound-queue');
const { ChannelSecrets } = require('../src/channels/credentials');
const { SessionBindings, createCommandDispatcher } = require('../src/channels/receivers/base');
const { createChannelManager, ChannelState, BUILTIN_SLOTS } = require('../src/channels/channel-manager');

// ------------------------------------------------------------------ helpers

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-channels-test-'));
}

const flush = () => new Promise((r) => setImmediate(r));

/** Identity-safeStorage mock that still proves encrypt/decrypt round-trips. */
function fakeSafeStorage() {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString(plain) { calls.encrypt += 1; return Buffer.from('enc!' + plain, 'utf8'); },
    decryptString(buf) { calls.decrypt += 1; return buf.toString('utf8').slice(4); },
  };
}

/** Deterministic timers: records delays, fires callbacks only on demand. */
function fakeTimers() {
  const pending = new Map();
  const delays = [];
  let seq = 0;
  return {
    delays,
    setTimeout(fn, ms) { seq += 1; pending.set(seq, fn); delays.push(ms); return seq; },
    clearTimeout(id) { pending.delete(id); },
    fire(id) { const fn = pending.get(id); if (fn) { pending.delete(id); fn(); } },
  };
}

function fakeSettings(initial = []) {
  const store = { imChannels: initial.map((c) => ({ allowFrom: [], enabled: false, ...c })) };
  return {
    get: () => store,
    patch: (p) => Object.assign(store, p),
  };
}

/** Fake channel implementation: card-capable transport + spies on output. */
function makeChannelCtor(behavior = {}) {
  const sent = { cards: [], texts: [] };
  const stats = { started: 0, stopped: 0 };
  function Ctor({ hooks }) {
    this.hooks = hooks;
    this.start = async () => {
      stats.started += 1;
      if (behavior.startFails) throw new Error(behavior.startFails);
    };
    this.stop = async () => { stats.stopped += 1; };
    this.supportsCards = behavior.textOnly ? false : true;
    this.sendText = async (t) => { sent.texts.push(t); };
    this.sendCard = async (c) => { sent.cards.push(c); };
  }
  Ctor.sent = sent;
  Ctor.stats = stats;
  return Ctor;
}

function makeManager(opts = {}) {
  const ft = fakeTimers();
  const logs = [];
  const settings = fakeSettings(opts.configs || []);
  const mgr = createChannelManager({
    userDataDir: opts.dir || tmpDir(),
    settings,
    safeStorage: null,
    log: (l) => logs.push(l),
    lang: () => 'zh',
    timers: ft,
  });
  return { mgr, ft, settings, logs };
}

// ------------------------------------------------------------ one-shot tokens

test('OneShotTokens: issue/redeem round-trip, single-use, anti-replay, expiry', () => {
  let clock = 1_000_000;
  const tokens = new OneShotTokens({ now: () => clock });

  const token = tokens.issue({ kind: 'approval', tool: 'Bash' });
  assert.match(token, /^[0-9a-f]{32}$/, 'crypto-random 16-byte hex token');

  // burn-on-redeem: first use succeeds, replay reads as unknown/forgery
  const first = tokens.redeem(token);
  assert.strictEqual(first.ok, true);
  assert.deepStrictEqual(first.payload, { kind: 'approval', tool: 'Bash' });
  const replay = tokens.redeem(token);
  assert.strictEqual(replay.ok, false);
  assert.strictEqual(replay.reason, 'unknown');

  // never-issued garbage is also unknown
  assert.deepStrictEqual(tokens.redeem('deadbeef'), { ok: false, reason: 'unknown' });

  // expiry: fresh token, clock past TTL → expired (and burned either way)
  const t2 = tokens.issue({ kind: 'question' });
  clock += DEFAULT_TTL_MS + 1;
  const expired = tokens.redeem(t2);
  assert.strictEqual(expired.ok, false);
  assert.strictEqual(expired.reason, 'expired');

  // distinct tokens for identical payloads
  const a = tokens.issue({ kind: 'approval', tool: 'X' });
  const b = tokens.issue({ kind: 'approval', tool: 'X' });
  assert.notStrictEqual(a, b);
  assert.strictEqual(tokens.size, 2);
});

// ---------------------------------------------------------------- allowlist

test('isAllowed: empty list rejects all; exact / prefix-wildcard / catch-all admit', () => {
  assert.strictEqual(isAllowed([], 'u1'), false, 'pairing mode: empty allowFrom rejects everyone');
  assert.strictEqual(isAllowed(undefined, 'u1'), false);
  assert.strictEqual(isAllowed(['u1'], 'u1'), true);
  assert.strictEqual(isAllowed(['u1'], 'u2'), false);
  assert.strictEqual(isAllowed(['u1', 'u2'], 'u2'), true);
  assert.strictEqual(isAllowed(['grp-*'], 'grp-123'), true, 'prefix wildcard');
  assert.strictEqual(isAllowed(['grp-*'], 'grpx'), false);
  assert.strictEqual(isAllowed(['*'], 'anyone'), true, 'catch-all opens the channel');
  assert.strictEqual(isAllowed(['u1'], ''), false, 'empty sender id never admitted');
  assert.strictEqual(isAllowed(['  ', ''], 'u1'), false, 'blank entries ignored');
});

test('parseAllowFrom: splits/dedupes user input and caps the list', () => {
  assert.deepStrictEqual(parseAllowFrom('u1, u2\nu3;u2  u1'), ['u1', 'u2', 'u3']);
  assert.deepStrictEqual(parseAllowFrom('  '), []);
  assert.deepStrictEqual(parseAllowFrom(['a', 'a', 'b']), ['a', 'b']);
  const many = parseAllowFrom(Array.from({ length: 120 }, (_, i) => `u${i}`).join(','));
  assert.strictEqual(many.length, 100, 'sanity ceiling of 100 entries');
});

// ---------------------------------------------------------------- formatter

test('formatEvent: taskDone/approval/question produce both card and text templates', () => {
  const task = formatEvent('zh', { kind: 'taskDone' });
  assert.strictEqual(task.card.title, '任务完成');
  assert.deepStrictEqual(task.card.actions, []);
  assert.ok(task.text.startsWith('✅'));
  assert.ok(task.text.includes('任务完成'));

  const enTask = formatEvent('en', { kind: 'taskDone' });
  assert.strictEqual(enTask.card.title, 'Task finished');

  const approval = formatEvent('zh', { kind: 'approval', tool: 'Bash', token: 'tok1' });
  assert.strictEqual(approval.card.actions.length, 2);
  assert.deepStrictEqual(
    approval.card.actions.map((a) => [a.id, a.label, a.token]),
    [['approve', '批准', 'tok1'], ['deny', '拒绝', 'tok1']],
  );
  assert.ok(approval.card.body.includes('Bash'));
  assert.ok(approval.card.body.includes('120'), 'body carries the TTL');
  assert.ok(approval.text.includes('approve tok1'));
  assert.ok(approval.text.includes('deny tok1'));

  const question = formatEvent('en', { kind: 'question', question: 'Continue?', token: 't9' });
  assert.strictEqual(question.card.actions.length, 1);
  assert.strictEqual(question.card.actions[0].id, 'answer');
  assert.strictEqual(question.card.actions[0].label, 'Reply');
  assert.ok(question.card.body.includes('Continue?'));
  assert.ok(question.text.includes('answer t9'));

  assert.throws(() => formatEvent('zh', { kind: 'nope' }), /unknown channel event kind/);
});

// ------------------------------------------------------------------ sender

test('createSender: card-capable transports get cards, others fall back to text', async () => {
  const cardTransport = {
    supportsCards: true,
    sendText: async () => { throw new Error('sendText must not be called'); },
    sendCard: async (c) => { cardTransport.lastCard = c; },
  };
  const cardSender = createSender(cardTransport);
  const via = await cardSender.sendEvent('zh', { kind: 'taskDone' });
  assert.strictEqual(via, 'card');
  assert.strictEqual(cardTransport.lastCard.title, '任务完成');

  const textTransport = {
    supportsCards: false,
    sendText: async (t) => { textTransport.lastText = t; },
    sendCard: async () => { throw new Error('sendCard must not be called'); },
  };
  const textSender = createSender(textTransport);
  const viaText = await textSender.sendEvent('zh', { kind: 'approval', tool: 'Bash', token: 'k1' });
  assert.strictEqual(viaText, 'text');
  assert.ok(textTransport.lastText.includes('approve k1'));

  assert.throws(() => createSender({ sendCard: async () => {} }), /sendText/);
});

// ------------------------------------------------------------- offline queue

test('OutboundQueue: taskDone queues (bounded ring), approval/question drop+audit', () => {
  const audits = [];
  const q = new OutboundQueue({ audit: (r) => audits.push(r) });

  assert.strictEqual(q.push({ kind: 'approval', tool: 'Bash', token: 't' }), 'dropped');
  assert.strictEqual(q.push({ kind: 'question', token: 't' }), 'dropped');
  assert.strictEqual(q.size, 0, 'transient events never queue');
  assert.strictEqual(q.droppedCount, 2);

  for (let i = 0; i < DEFAULT_MAX_QUEUED + 3; i++) q.push({ kind: 'taskDone', seq: i });
  assert.strictEqual(q.size, DEFAULT_MAX_QUEUED, 'ring keeps only the newest N');
  assert.deepStrictEqual(audits.filter((a) => a.action === 'drop').length, 2);
  assert.deepStrictEqual(audits.filter((a) => a.action === 'queue-overflow').length, 3);
});

test('OutboundQueue.drain: replays oldest-first and keeps the remainder on failure', async () => {
  const q = new OutboundQueue({ max: 5 });
  q.push({ kind: 'taskDone', seq: 1 });
  q.push({ kind: 'taskDone', seq: 2 });
  q.push({ kind: 'taskDone', seq: 3 });

  const attempted = [];
  const sent1 = await q.drain(async (ev) => { attempted.push(ev.seq); if (ev.seq === 2) throw new Error('offline'); });
  assert.strictEqual(sent1, 1, 'delivery stops at the first failure');
  assert.deepStrictEqual(attempted, [1, 2], 'seq 2 was attempted but failed');
  assert.strictEqual(q.size, 2);
  assert.deepStrictEqual(q.items.map((e) => e.seq), [2, 3], 'failed event stays queued');

  const sent2 = await q.drain(async (ev) => { attempted.push(ev.seq); });
  assert.strictEqual(sent2, 2);
  assert.strictEqual(attempted.length, 4);
  assert.strictEqual(q.size, 0);
});

// ----------------------------------------------------------- state machine

test('ChannelState: offline→connecting→online, backoff delays double and cap at 60s', () => {
  const s = new ChannelState();
  assert.strictEqual(s.state, 'offline');
  assert.strictEqual(s.attempts, 0);

  s.beginConnect();
  assert.strictEqual(s.state, 'connecting');

  s.markOnline();
  assert.strictEqual(s.state, 'online');
  assert.strictEqual(s.attempts, 0);

  // 1s → 2s → 4s … capped at 60s; attempts reset only on markOnline
  assert.strictEqual(s.nextBackoffMs(), 1_000);
  assert.strictEqual(s.nextBackoffMs(), 2_000);
  assert.strictEqual(s.nextBackoffMs(), 4_000);
  for (let i = 0; i < 20; i++) s.nextBackoffMs();
  assert.strictEqual(s.nextBackoffMs(), 60_000, 'delay caps at 60s');

  s.connectionLost();
  assert.strictEqual(s.state, 'backoff');

  s.markFailed('bad webhook');
  assert.strictEqual(s.state, 'offline');
  assert.strictEqual(s.lastError, 'bad webhook');

  s.markOnline();
  assert.strictEqual(s.attempts, 0);
  assert.strictEqual(s.lastError, null);
  assert.deepStrictEqual(s.snapshot(), { state: 'online', attempts: 0, lastError: null });
});

// ------------------------------------------------------------- credentials

test('ChannelSecrets: safeStorage round-trip, ciphertext at rest, warn-once plain fallback', () => {
  const dir = tmpDir();

  // encrypted path — plaintext never hits disk
  const ss = fakeSafeStorage();
  const file = path.join(dir, 'secrets.json');
  const cs = new ChannelSecrets(file, ss, () => {});
  cs.set('feishu', 'bot-secret-123');
  assert.strictEqual(cs.get('feishu'), 'bot-secret-123');
  assert.ok(ss.calls.encrypt >= 1 && ss.calls.decrypt >= 1);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('bot-secret-123'), 'vault file holds ciphertext, not the secret');
  assert.ok(JSON.parse(raw).feishu, 'stored under the channel id');

  // reload from disk still decrypts
  const reloaded = new ChannelSecrets(file, ss, () => {});
  assert.strictEqual(reloaded.get('feishu'), 'bot-secret-123');
  assert.strictEqual(reloaded.get('never-set'), null);

  // safeStorage unavailable → base64 obfuscation fallback, warned exactly once
  const logs = [];
  const plain = new ChannelSecrets(path.join(dir, 'plain.json'), null, (l) => logs.push(l));
  plain.set('wecom', 'plain-key');
  plain.set('dingtalk', 'another');
  assert.strictEqual(plain.get('wecom'), 'plain-key');
  assert.strictEqual(plain.get('dingtalk'), 'another');
  assert.strictEqual(logs.filter((l) => l.includes('safeStorage unavailable')).length, 1);

  plain.remove('wecom');
  assert.strictEqual(plain.has('wecom'), false);
  assert.strictEqual(plain.get('wecom'), null);
});

test('ChannelSecrets: vault file is 0600; a legacy 0644 file is tightened on load', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'secrets.json');
  new ChannelSecrets(file, null, () => {}).set('feishu', 's1');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'channel secrets must be 0600 on POSIX');

  // legacy wide-perm file: the successful read path tightens it (best effort)
  const legacy = path.join(dir, 'legacy-secrets.json');
  fs.writeFileSync(legacy, JSON.stringify({ feishu: Buffer.from('plain:s2').toString('base64') }));
  fs.chmodSync(legacy, 0o644); // defeat umask: simulate a pre-0600 install
  const reloaded = new ChannelSecrets(legacy, null, () => {});
  assert.strictEqual(reloaded.get('feishu'), 's2', 'legacy vault still decrypts');
  assert.strictEqual(fs.statSync(legacy).mode & 0o777, 0o600, 'legacy vault tightened on read');
});

// --------------------------------------------------------- session bindings

test('SessionBindings: sticky per (channel,sender), persists across restarts', () => {
  const file = path.join(tmpDir(), 'sessions.json');
  const sb = new SessionBindings(file);
  const s1 = sb.ensure('feishu', 'u1');
  assert.match(s1, /^ch-[0-9a-f]{16}$/, 'minted local opaque session handle');

  assert.strictEqual(sb.ensure('feishu', 'u1'), s1, 'same binding → same session');
  const s2 = sb.ensure('feishu', 'u2');
  const s3 = sb.ensure('wecom', 'u1');
  assert.notStrictEqual(s2, s1);
  assert.notStrictEqual(s3, s1);

  // restart: bindings reload from disk
  const sb2 = new SessionBindings(file);
  assert.strictEqual(sb2.get('feishu', 'u1'), s1);
  assert.strictEqual(sb2.ensure('feishu', 'u1'), s1, 'no re-mint for persisted bindings');
  assert.strictEqual(sb2.get('feishu', 'nobody'), null);
});

// ------------------------------------------------------------- dispatcher

function makeDispatcher(opts = {}) {
  const dir = tmpDir();
  let clock = 0;
  const tokens = opts.tokens || new OneShotTokens({ now: () => clock });
  const sessions = new SessionBindings(path.join(dir, 'sessions.json'));
  const calls = { approval: [], question: [], prompts: [] };
  const audits = [];
  const dispatch = createCommandDispatcher({
    tokens,
    isAllowed,
    sessions,
    runPrompt: async (p) => {
      calls.prompts.push(p);
      return { ok: true, output: 'done-output', durationMs: 1500 };
    },
    onApprovalDecision: (d) => { calls.approval.push(d); return { ok: true }; },
    onQuestionAnswer: (d) => { calls.question.push(d); return { ok: true }; },
    lang: () => 'zh',
    audit: (r) => audits.push(r),
  }).dispatch;
  return { dispatch, tokens, sessions, calls, audits, advance: (ms) => { clock += ms; } };
}

test('dispatcher: admission runs before token redemption — denied sender cannot burn tokens', async () => {
  const { dispatch, tokens } = makeDispatcher();
  const token = tokens.issue({ kind: 'approval', tool: 'Bash' });

  const denied = await dispatch({
    channelId: 'feishu', senderId: 'stranger', allowFrom: ['u1'],
    command: { type: 'approve', token },
  });
  assert.strictEqual(denied.ok, false);
  assert.ok(denied.reply.includes('白名单'), 'readable denial reply');

  const allowed = await dispatch({
    channelId: 'feishu', senderId: 'u1', allowFrom: ['u1'],
    command: { type: 'approve', token },
  });
  assert.strictEqual(allowed.ok, true, 'token survived the denied attempt');
  assert.strictEqual(allowed.reply, '已批准。');
});

test('dispatcher: approve/deny/answer flows redeem one-shot tokens exactly once; expiry replies', async () => {
  const { dispatch, tokens, calls, advance } = makeDispatcher();

  const denyTok = tokens.issue({ kind: 'approval', tool: 'Git' });
  const denied = await dispatch({
    channelId: 'feishu', senderId: 'u1', allowFrom: ['*'], command: { type: 'deny', token: denyTok },
  });
  assert.strictEqual(denied.reply, '已拒绝。');
  assert.deepStrictEqual(calls.approval[0], {
    decision: 'deny', tool: 'Git',
    payload: { kind: 'approval', tool: 'Git' }, // runtime routing fields ride the token payload
  });

  const ansTok = tokens.issue({ kind: 'question' });
  const answered = await dispatch({
    channelId: 'feishu', senderId: 'u1', allowFrom: ['*'],
    command: { type: 'answer', token: ansTok, text: 'use plan A' },
  });
  assert.strictEqual(answered.reply, '回答已送达。');
  assert.deepStrictEqual(calls.question[0], {
    text: 'use plan A',
    payload: { kind: 'question' },
  });

  // replayed answer token reads as invalid/used
  const replay = await dispatch({
    channelId: 'feishu', senderId: 'u1', allowFrom: ['*'],
    command: { type: 'answer', token: ansTok, text: 'again' },
  });
  assert.strictEqual(replay.ok, false);
  assert.ok(replay.reply.includes('已使用'));

  // expired approval token gets the dedicated expiry reply
  const expTok = tokens.issue({ kind: 'approval', tool: 'Bash' });
  advance(121_000);
  const expired = await dispatch({
    channelId: 'feishu', senderId: 'u1', allowFrom: ['*'], command: { type: 'approve', token: expTok },
  });
  assert.strictEqual(expired.ok, false);
  assert.ok(expired.reply.includes('过期'));
});

test('dispatcher: free text routes to the sticky headless session and replies with a summary', async () => {
  const { dispatch, sessions, calls } = makeDispatcher();
  const run = (text) => dispatch({
    channelId: 'feishu', senderId: 'u1', allowFrom: ['*'], command: { type: 'text', text },
  });

  const r1 = await run('查一下今天的成本');
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.reply.includes('done-output'));
  assert.ok(r1.reply.includes('✓'));

  const r2 = await run('再看看余额');
  assert.strictEqual(calls.prompts.length, 2);
  assert.strictEqual(calls.prompts[0].sessionId, calls.prompts[1].sessionId, 'stickiness');
  assert.strictEqual(calls.prompts[0].sessionId, sessions.get('feishu', 'u1'));
  assert.strictEqual(calls.prompts[0].text, '查一下今天的成本');

  const bad = await run('   ');
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.reply.includes('无法识别'));

  const nonsense = await dispatch({
    channelId: 'feishu', senderId: 'u1', allowFrom: ['*'], command: { type: 'teleport' },
  });
  assert.strictEqual(nonsense.ok, false);
});

// ---------------------------------------------------------- channel manager

test('manager: builtin slots surface not-installed; unknown ids rejected', () => {
  const { mgr } = makeManager();
  assert.deepStrictEqual(
    mgr.statusAll().map((c) => c.id).sort(),
    [...BUILTIN_SLOTS].sort(),
  );

  const res = mgr.toggle('feishu', true);
  assert.strictEqual(res.ok, true, 'config still saved for pending slots');
  const st = mgr.statusAll().find((c) => c.id === 'feishu');
  assert.strictEqual(st.installed, false);
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.status.state, 'offline');
  assert.ok(st.status.lastError.includes('未安装'), 'readable not-installed reason');

  assert.deepStrictEqual(mgr.toggle('sms', true), { ok: false, reason: 'unknown-channel' });
  mgr.toggle('feishu', false);
});

test('manager: failed start enters exponential backoff reconnect (1s→2s→4s)', async () => {
  const { mgr, ft } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  mgr.register('feishu', makeChannelCtor({ startFails: 'boom' }));

  const r = await mgr.startChannel('feishu');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /boom/);
  assert.strictEqual(ft.delays[0], 1_000);

  ft.fire(1); await flush(); await flush();
  assert.strictEqual(ft.delays[1], 2_000);

  ft.fire(2); await flush(); await flush();
  assert.strictEqual(ft.delays[2], 4_000);

  const st = mgr.statusAll().find((c) => c.id === 'feishu').status;
  assert.strictEqual(st.state, 'backoff');
  mgr.stopAll(); // clears the pending fake timer
});

test('manager: broadcast to an online channel debounces taskDone and mints distinct tokens', async () => {
  const Ctor = makeChannelCtor();
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  mgr.register('feishu', Ctor);

  const r = await mgr.startChannel('feishu');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(Ctor.stats.started, 1);
  const st = mgr.statusAll().find((c) => c.id === 'feishu').status;
  assert.strictEqual(st.state, 'online');

  mgr.broadcast({ kind: 'taskDone' });
  await flush();
  assert.strictEqual(Ctor.sent.cards.length, 1);
  assert.strictEqual(Ctor.sent.cards[0].title, '任务完成');

  mgr.broadcast({ kind: 'taskDone' }); // inside the 3s debounce window
  await flush();
  assert.strictEqual(Ctor.sent.cards.length, 1, 'debounced');

  mgr.broadcast({ kind: 'approval', tool: 'Bash' });
  mgr.broadcast({ kind: 'approval', tool: 'Git' }); // approvals are not debounced
  await flush(); await flush();
  assert.strictEqual(Ctor.sent.cards.length, 3);

  const [a1, a2] = [Ctor.sent.cards[1], Ctor.sent.cards[2]];
  assert.notStrictEqual(a1.actions[0].token, a2.actions[0].token, 'fresh one-shot token per card');
  const redeemed = mgr.tokens.redeem(a1.actions[0].token);
  assert.strictEqual(redeemed.ok, true);
  assert.strictEqual(redeemed.payload.tool, 'Bash');

  mgr.stopAll();
});

test('manager: offline broadcasts queue taskDone / drop approvals, replay on connect', async () => {
  const Ctor = makeChannelCtor();
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  mgr.register('feishu', Ctor);

  mgr.broadcast({ kind: 'taskDone' }); // no channel online → queued
  mgr.broadcast({ kind: 'approval', tool: 'Bash' }); // transient → dropped (dead buttons past TTL)
  assert.strictEqual(mgr.queue.size, 1);
  assert.strictEqual(mgr.queue.droppedCount, 1);

  const r = await mgr.startChannel('feishu');
  assert.strictEqual(r.ok, true);
  await flush(); await flush(); // drain is async
  assert.strictEqual(Ctor.sent.cards.length, 1, 'queued taskDone replayed on connect');
  assert.strictEqual(Ctor.sent.cards[0].title, '任务完成');
  assert.strictEqual(mgr.queue.size, 0);

  mgr.stopAll();
  assert.strictEqual(Ctor.stats.stopped, 1);
});

test('manager: permanent start failure parks the channel (no reconnect loop)', async () => {
  const { mgr, ft } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  const boom = new Error('feishu: credentials missing');
  boom.permanent = true; // adapters flag config/credential errors this way
  function Ctor() {
    this.start = async () => { throw boom; };
    this.stop = async () => {};
  }
  mgr.register('feishu', Ctor);

  const r = await mgr.startChannel('feishu');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /credentials missing/);
  assert.strictEqual(ft.delays.length, 0, 'permanent failure must not schedule a reconnect');
  const st = mgr.statusAll().find((c) => c.id === 'feishu').status;
  assert.strictEqual(st.state, 'offline');
  assert.match(st.lastError, /credentials missing/);
  mgr.stopAll();
});

test('manager: reconnect gives up after the attempt cap; toggling resets it', async () => {
  const { mgr, ft } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  mgr.register('feishu', makeChannelCtor({ startFails: 'boom' }));

  await mgr.startChannel('feishu'); // failure #1 schedules retry #1
  for (let i = 1; i <= 13; i++) {
    ft.fire(i);
    await flush(); await flush();
  }
  // the cap fires on the 13th failure: 12 retries were scheduled, then silence
  assert.strictEqual(ft.delays.length, 12, 'reconnect stops after MAX_RECONNECT_ATTEMPTS');
  ft.fire(99); await flush();
  assert.strictEqual(ft.delays.length, 12, 'no timer left to fire');

  // user toggles off→on: the parked state clears and retries resume
  mgr.toggle('feishu', false);
  mgr.toggle('feishu', true);
  await flush(); await flush();
  assert.ok(ft.delays.length > 12, 'toggle resets the reconnect loop');
  mgr.stopAll();
});

test('manager: hasSecrets decodes the vault once and caches until configureSecrets', () => {
  const safe = fakeSafeStorage();
  const settings = fakeSettings([]);
  const mgr = createChannelManager({
    userDataDir: tmpDir(),
    settings,
    safeStorage: safe,
    log: () => {},
    lang: () => 'zh',
    timers: fakeTimers(),
  });

  assert.strictEqual(mgr.hasSecrets('feishu'), false);
  const before = safe.calls.decrypt;
  assert.strictEqual(mgr.hasSecrets('feishu'), false, 'cached — no extra decrypt call');
  assert.strictEqual(safe.calls.decrypt, before);

  mgr.configureSecrets('feishu', { appId: 'a', appSecret: 'b' });
  assert.strictEqual(mgr.hasSecrets('feishu'), true);
  const after1 = safe.calls.decrypt;
  assert.strictEqual(mgr.hasSecrets('feishu'), true, 'cached after write');
  assert.strictEqual(safe.calls.decrypt, after1);

  mgr.configureSecrets('feishu', null); // clears → invalidates the cache
  assert.strictEqual(mgr.hasSecrets('feishu'), false);
  mgr.stopAll();
});

// ------------------------------------------- connecting-window races (P1-2/3)

test('manager: concurrent startChannel during the connecting window dedupes (no double impl)', async () => {
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  let release;
  const gate = new Promise((r) => { release = r; });
  const stats = { started: 0, stopped: 0 };
  function SlowCtor() {
    this.supportsCards = true;
    this.start = async () => { stats.started += 1; await gate; };
    this.stop = async () => { stats.stopped += 1; };
    this.sendText = async () => {};
    this.sendCard = async () => {};
  }
  mgr.register('feishu', SlowCtor);

  // second call lands while `await impl.start()` is still in flight — the
  // id is not in `instances` yet, so without the in-flight guard it would
  // build a second impl and leak the first connection
  const p1 = mgr.startChannel('feishu');
  const p2 = mgr.startChannel('feishu');
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.alreadyRunning, true, 'second start during connecting is deduped');
  assert.strictEqual(stats.started, 1, 'exactly one impl was constructed');
  const st = mgr.statusAll().find((c) => c.id === 'feishu').status;
  assert.strictEqual(st.state, 'online');
  mgr.stopAll();
  assert.strictEqual(stats.stopped, 1, 'the single impl is stopped once');
});

test('manager: disabling during the connecting window aborts the start (no zombie online)', async () => {
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  let release;
  const gate = new Promise((r) => { release = r; });
  const stats = { started: 0, stopped: 0 };
  function SlowCtor() {
    this.supportsCards = true;
    this.start = async () => { stats.started += 1; await gate; };
    this.stop = async () => { stats.stopped += 1; };
    this.sendText = async () => {};
    this.sendCard = async () => {};
  }
  mgr.register('feishu', SlowCtor);

  const p = mgr.startChannel('feishu'); // connecting window opens
  mgr.toggle('feishu', false);          // user disables before start resolves
  release();
  await p;
  const st = mgr.statusAll().find((c) => c.id === 'feishu').status;
  assert.strictEqual(st.state, 'offline', 'channel must never come online');
  assert.strictEqual(stats.stopped, 1, 'the in-flight impl was stopped, not leaked');
  assert.strictEqual(stats.started, 1, 'only one impl was ever constructed');
  mgr.stopAll();
  assert.strictEqual(stats.stopped, 1, 'stopAll finds no instance to stop again');
});
