// src/channels/channel-manager.js — IM channel lifecycle + broadcast hub (C5).
//
// Owns everything channel-shaped in the shell:
//   - registry: type → constructor. C5 ships NULL slots (feishu / wecom /
//     dingtalk / whatsapp): enabling one surfaces the readable
//     "implementation not installed" state instead of a crash; C6 fills them.
//   - lifecycle: register/start/stop/status per channel, with an exponential
//     backoff reconnect schedule (1s → 2s → 4s … capped 60s, reset on success)
//     surfaced to the settings page through state subscribers.
//   - config: { id, type, enabled, allowFrom[] } per channel persisted via
//     SettingsStore.imChannels (never credentials — those live in
//     ChannelSecrets under userData, safeStorage-encrypted).
//   - broadcast(): the events.mux/events.host side-channel. taskDone events
//     debounce (3s) and queue while offline (replayed on reconnect, N=10);
//     approval/question events mint one-shot tokens and are dropped+audited
//     when no channel is online (a queued card would only deliver a dead
//     button past its 120s TTL).
//
// Channel implementation contract (C6):
//   new Ctor({ id, type, config, secrets, log, hooks })
//     hooks: { notifyDisconnect(id), onInbound({channelId, senderId, command}) }
//   await start()    — throws with a readable message on failure
//   await stop()
//   transport surface: supportsCards, sendText(text), sendCard(card)
'use strict';

const path = require('node:path');

const { OneShotTokens } = require('./one-shot-tokens');
const { OutboundQueue } = require('./outbound-queue');
const { ChannelSecrets } = require('./credentials');
const { createSender } = require('./senders/base');
const { SessionBindings, createCommandDispatcher } = require('./receivers/base');
const { isAllowed, parseAllowFrom } = require('./allowlist');
const { t } = require('../i18n');

/** Registered placeholder slots until C6 ships the protocol implementations. */
const BUILTIN_SLOTS = ['feishu', 'wecom', 'dingtalk', 'whatsapp'];

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const TASK_DONE_DEBOUNCE_MS = 3_000;

// ------------------------------------------------------------ state machine

/** offline → connecting → online ⇄ backoff (exponential reconnect delays). */
class ChannelState {
  constructor() {
    this.state = 'offline'; // offline | connecting | online | backoff
    this.attempts = 0;      // consecutive failed reconnects (0 = healthy)
    this.lastError = null;
  }

  beginConnect() { this.state = 'connecting'; }

  markOnline() {
    this.state = 'online';
    this.attempts = 0;
    this.lastError = null;
  }

  /** Startup/configuration failure: park offline with the readable reason. */
  markFailed(reason) {
    this.state = 'offline';
    this.lastError = reason ? String(reason) : null;
  }

  /** A live connection dropped: enter the backoff loop. */
  connectionLost() { this.state = 'backoff'; }

  /** Next reconnect delay: 1s,2s,4s…60s; attempts reset on markOnline(). */
  nextBackoffMs() {
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.attempts, BACKOFF_MAX_MS);
    this.attempts += 1;
    return delay;
  }

  snapshot() {
    return { state: this.state, attempts: this.attempts, lastError: this.lastError };
  }
}

// ------------------------------------------------------------------ manager

function createChannelManager(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const lang = d.lang || (() => 'zh');
  const settings = d.settings;
  const timers = d.timers || { setTimeout, clearTimeout };

  const registry = new Map(); // type -> ctor | null (null = registered slot, impl pending)
  const testers = new Map();  // type -> async (creds) => {ok, kind?, reason?}
  for (const type of BUILTIN_SLOTS) registry.set(type, null);

  const secrets = new ChannelSecrets(
    path.join(d.userDataDir, 'channel-secrets.json'),
    d.safeStorage,
    log,
  );
  const tokens = new OneShotTokens();
  const sessions = new SessionBindings(path.join(d.userDataDir, 'channel-sessions.json'));
  const queue = new OutboundQueue({
    audit: (rec) => log(`[channels] audit ${rec.action} ${rec.kind || ''} ${rec.reason || ''}`.trim()),
  });
  const dispatcher = createCommandDispatcher({
    tokens,
    isAllowed,
    sessions,
    runPrompt: d.runPrompt || (async () => ({ ok: false, output: 'runner not wired', durationMs: 0 })),
    onApprovalDecision: d.onApprovalDecision || (() => ({ ok: false, reason: 'no-hook' })),
    onQuestionAnswer: d.onQuestionAnswer || (() => ({ ok: false, reason: 'no-hook' })),
    lang,
    audit: (rec) => log(`[channels] audit ${rec.action} ${rec.reason || rec.decision || ''} ${rec.channelId || ''}`.trim()),
  });

  const states = new Map();     // id -> ChannelState
  const instances = new Map();  // id -> { impl, sender, reconnectTimer }
  const subscribers = new Set();
  let lastTaskDoneAt = 0;

  const stateOf = (id) => {
    let s = states.get(id);
    if (!s) { s = new ChannelState(); states.set(id, s); }
    return s;
  };

  function emitState() {
    const snap = statusAll();
    for (const cb of subscribers) {
      try { cb(snap); } catch { /* subscriber bug must not break channels */ }
    }
  }

  // ------------------------------------------------------------- config

  const configs = () => (settings && settings.get().imChannels) || [];

  function configOf(id) {
    return configs().find((c) => c && c.id === id) || { id, type: id, enabled: false, allowFrom: [] };
  }

  function saveConfig(id, patch) {
    if (!settings) return;
    const list = configs().map((c) => ({ ...c }));
    const idx = list.findIndex((c) => c && c.id === id);
    if (idx === -1) list.push({ id, type: id, enabled: false, allowFrom: [], ...patch });
    else list[idx] = { ...list[idx], ...patch };
    settings.patch({ imChannels: list });
  }

  // ---------------------------------------------------------- lifecycle

  /** Register (or replace) a channel implementation for a type. */
  function register(type, ctor, tester) {
    registry.set(String(type), ctor || null);
    if (typeof tester === 'function') testers.set(String(type), tester);
  }

  async function startChannel(id) {
    const state = stateOf(id);
    const existing = instances.get(id);
    if (existing) return { ok: true, alreadyRunning: true };
    const ctor = registry.get(id);
    if (!ctor) {
      // Registered placeholder slot: surface the readable not-installed state.
      state.markFailed(t(lang(), 'channels.notInstalled'));
      emitState();
      log(`[channels] ${id} start refused: implementation not installed`);
      return { ok: false, reason: 'not-installed' };
    }
    state.beginConnect();
    emitState();
    const cfg = configOf(id);
    try {
      const impl = new ctor({
        id,
        type: id,
        config: cfg,
        secrets,
        log,
        hooks: {
          notifyDisconnect: () => onChannelDown(id),
          onInbound: (msg) => onInbound(id, msg),
        },
      });
      await impl.start();
      const rec = { impl, sender: createSender(impl), reconnectTimer: null };
      instances.set(id, rec);
      state.markOnline();
      emitState();
      log(`[channels] ${id} online`);
      // replay what piled up while offline (taskDone only, by queue policy)
      queue.drain((ev) => rec.sender.sendEvent(lang(), ev))
        .then((n) => { if (n) log(`[channels] ${id} replayed ${n} queued event(s)`); })
        .catch(() => { /* sender errors route through handleSendError */ });
      return { ok: true };
    } catch (e) {
      state.markFailed(e.message);
      emitState();
      log(`[channels] ${id} start failed: ${e.message}`);
      scheduleReconnect(id);
      return { ok: false, reason: e.message };
    }
  }

  function stopChannel(id) {
    const rec = instances.get(id);
    if (rec) {
      if (rec.reconnectTimer) { timers.clearTimeout(rec.reconnectTimer); rec.reconnectTimer = null; }
      instances.delete(id);
      try { rec.impl.stop(); } catch { /* ignore */ }
      log(`[channels] ${id} stopped`);
    }
    stateOf(id).markFailed(null); // back to a clean offline
    emitState();
  }

  function scheduleReconnect(id) {
    if (!instances.has(id) && !configs().some((c) => c && c.id === id && c.enabled)) return; // disabled meanwhile
    const state = stateOf(id);
    const delay = state.nextBackoffMs();
    let rec = instances.get(id);
    if (!rec) { rec = { impl: null, sender: null, reconnectTimer: null }; instances.set(id, rec); }
    if (rec.reconnectTimer) timers.clearTimeout(rec.reconnectTimer);
    state.connectionLost();
    emitState();
    log(`[channels] ${id} reconnect in ${delay}ms (attempt ${state.attempts})`);
    rec.reconnectTimer = timers.setTimeout(() => {
      rec.reconnectTimer = null;
      instances.delete(id); // startChannel builds a fresh impl
      startChannel(id);
    }, delay);
  }

  /** A connected channel reported its transport dropped. */
  function onChannelDown(id) {
    if (!instances.has(id)) return;
    const rec = instances.get(id);
    try { if (rec.impl) rec.impl.stop(); } catch { /* ignore */ }
    instances.delete(id);
    scheduleReconnect(id);
  }

  async function handleSendError(id, err) {
    log(`[channels] ${id} send failed: ${err.message}`);
    onChannelDown(id);
  }

  // ------------------------------------------------------------ inbound

  function onInbound(channelId, msg) {
    const cfg = configOf(channelId);
    // The adapter parsed a v1 command; admission + token logic live downstream.
    dispatcher.dispatch({
      channelId,
      senderId: msg && msg.senderId,
      allowFrom: cfg.allowFrom,
      command: msg && msg.command,
    }).then((res) => {
      const rec = instances.get(channelId);
      if (rec && rec.impl && typeof rec.impl.sendText === 'function') {
        rec.impl.sendText(res.reply).catch(() => { /* reply best-effort */ });
      }
      if (!res.ok) log(`[channels] inbound on ${channelId} rejected (${res.reply || ''})`);
    }).catch((e) => log(`[channels] inbound dispatch error: ${e.message}`));
  }

  // ----------------------------------------------------------- broadcast

  /**
   * Fan an event out to every online channel.
   * @param {{ kind: 'taskDone' } | { kind: 'approval', tool } | { kind: 'question', question }} event
   */
  function broadcast(event) {
    if (!event || !event.kind) return;
    const ev = { ...event };
    if (ev.kind === 'taskDone') {
      const now = Date.now();
      if (now - lastTaskDoneAt < TASK_DONE_DEBOUNCE_MS) return; // debounce
      lastTaskDoneAt = now;
    } else if (ev.kind === 'approval' || ev.kind === 'question') {
      // buttons/replies carry a one-shot token, 120s TTL; the token payload
      // keeps the runtime routing fields (rpcId/sessionId/approvalId/question
      // shape) so the decision hook can answer POST /api/respond
      ev.token = tokens.issue({ ...ev });
    }
    const live = [];
    for (const [id, rec] of instances) {
      if (rec.sender) live.push([id, rec]);
    }
    if (!live.length) {
      queue.push(ev); // taskDone queues; approval/question drop+audit (policy)
      return;
    }
    for (const [id, rec] of live) {
      rec.sender.sendEvent(lang(), ev).catch((e) => handleSendError(id, e));
    }
  }

  // -------------------------------------------------------------- status

  function statusAll() {
    return BUILTIN_SLOTS.filter((type) => registry.has(type)).map((type) => {
      const cfg = configOf(type);
      return {
        id: type,
        type,
        enabled: !!cfg.enabled,
        allowFrom: Array.isArray(cfg.allowFrom) ? cfg.allowFrom : [],
        installed: !!registry.get(type),
        credentialsConfigured: hasSecrets(type),
        status: stateOf(type).snapshot(),
      };
    });
  }

  // ------------------------------------------------------------- ipc ops

  /**
   * Store one channel's credentials (JSON string) in the safeStorage vault.
   * Callers pass already-validated field names; values never hit the logs.
   */
  function configureSecrets(id, values) {
    const type = String(id || '');
    if (!registry.has(type)) return { ok: false, reason: 'unknown-channel' };
    if (values === null || values === undefined) {
      secrets.remove(type);
      log(`[channels] ${type} credentials cleared`);
      return { ok: true };
    }
    if (!values || typeof values !== 'object') return { ok: false, reason: 'bad-credentials' };
    secrets.set(type, JSON.stringify(values));
    log(`[channels] ${type} credentials saved (${Object.keys(values).length} fields)`);
    return { ok: true };
  }

  /** Whether the vault holds (decodable) credentials for a channel. */
  function hasSecrets(id) {
    try { return !!secrets.get(String(id || '')); } catch { return false; }
  }

  /**
   * L1 connectivity probe with the given (or stored) credentials, through the
   * channel implementation's own test path. Never dials the real socket.
   */
  async function testChannel(id, values) {
    const type = String(id || '');
    if (!registry.has(type)) return { ok: false, kind: 'protocol', reason: 'unknown-channel' };
    let creds = values && typeof values === 'object' ? values : null;
    if (!creds) {
      const raw = secrets.get(type);
      try { creds = raw ? JSON.parse(raw) : null; } catch { creds = null; }
    }
    if (!creds) return { ok: false, kind: 'credentials', reason: 'credentials missing' };
    const test = testers.get(type);
    if (!test) return { ok: false, kind: 'protocol', reason: 'no-test-path' };
    try { return await test(creds); } catch (e) {
      return { ok: false, kind: 'protocol', reason: e.message };
    }
  }

  function toggle(id, enabled) {
    const type = String(id || '');
    if (!registry.has(type)) return { ok: false, reason: 'unknown-channel' };
    saveConfig(type, { enabled: !!enabled });
    if (enabled) {
      startChannel(type); // async; state lands via subscribers
    } else {
      stopChannel(type);
    }
    return { ok: true, channels: statusAll() };
  }

  function setAllowFrom(id, input) {
    const type = String(id || '');
    if (!registry.has(type)) return { ok: false, reason: 'unknown-channel' };
    saveConfig(type, { allowFrom: parseAllowFrom(input) });
    emitState();
    return { ok: true, channels: statusAll() };
  }

  /** Start every channel the user previously enabled (app boot). */
  function startEnabled() {
    for (const cfg of configs()) {
      if (cfg && cfg.enabled && registry.has(cfg.id)) startChannel(cfg.id);
    }
  }

  function stopAll() {
    for (const id of [...instances.keys()]) stopChannel(id);
    queue.clear();
  }

  return {
    register,
    startChannel,
    stopChannel,
    startEnabled,
    stopAll,
    broadcast,
    toggle,
    setAllowFrom,
    statusAll,
    configureSecrets,
    hasSecrets,
    testChannel,
    onState: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    // exposed for tests / C6 wiring
    tokens,
    queue,
    secrets,
    sessions,
    dispatcher,
  };
}

module.exports = { createChannelManager, ChannelState, BUILTIN_SLOTS, TASK_DONE_DEBOUNCE_MS };
