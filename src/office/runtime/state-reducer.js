'use strict';

// src/office/runtime/state-reducer.js — Task 3 / SPEC-03.
//
// Pure four-layer Office state reducer. The state combines the frozen SPEC-00
// dimensions (presence/sync/runtime/activity plus movement/control/binding/
// queue) and enforces the event authority rules:
//
// - Harness events are the ONLY source of running/attention/completed/failed
//   and tool facts. They never fabricate local behavior results.
// - Local behavior events may only change roaming/chatting/resting/sleeping.
// - Animation events may only select resources/frames — they are not reducer
//   state and are reported as such.
// - Movement events may only change the movement dimension.
// - User commands can request dispatch/cancel/preempt but can never create
//   completed/failed/running/tool facts.
// - `offline` is not a resident state; presence stays `present` forever.
// - sync=stale/resyncing never ends local behavior or a bound task; only a
//   new trusted Runtime fact or explicit command may interrupt.
// - A cancel request enters cancellationPending and retains the binding until
//   terminal evidence; the cancel acknowledgement alone is not terminal.
// - Unsupported pause/resume/preempt stay capability-gated and never create
//   fake states (SPEC-00 v1 control enum has no pause/resume vocabulary).
//
// Adapter-specific eventId/sessionEpoch dedup/resync handling deliberately
// lives in the Task 6 adapter, not here: this reducer receives canonical,
// already-accepted events.
//
// Task 5 / SPEC-04 additions (minimal scope): the local sleeping guard
// (SLEEP_BLOCKED_BINDING / SLEEP_BLOCKED_SYNC) keeps unfinished bindings and
// sync=stale/resyncing from entering sleeping; sleeping stays a local
// activity and presence stays present forever.

const PRESENCE_STATES = Object.freeze(['present']);
const SYNC_STATES = Object.freeze(['healthy', 'stale', 'resyncing']);
const RUNTIME_STATES = Object.freeze(['unbound', 'idle', 'running', 'attention', 'completed', 'failed']);
const ACTIVITY_STATES = Object.freeze([
  'roaming', 'chatting', 'resting', 'sleeping', 'working', 'thinking', 'waiting', 'celebrating',
]);
const MOVEMENT_STATES = Object.freeze(['stationary', 'moving', 'arriving', 'leaving']);
const CONTROL_STATES = Object.freeze(['none', 'dispatchPending', 'cancellationPending', 'preemptPending']);
const BINDING_STATES = Object.freeze(['unbound', 'pending', 'bound', 'releasing']);
const QUEUE_STATES = Object.freeze(['empty', 'queued']);
const LOCAL_ACTIVITIES = Object.freeze(['roaming', 'chatting', 'resting', 'sleeping']);
const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed', 'cancelled']);

const DEFAULT_CAPABILITIES = Object.freeze({
  cancel: true,
  interrupt: true,
  followup: true,
  steer: true,
  inject: true,
  pause: false,
  resume: false,
  preempt: false,
});

function frozenState(state) {
  return Object.freeze({
    ...state,
    lastResult: state.lastResult ? Object.freeze({ ...state.lastResult }) : null,
    capabilities: Object.freeze({ ...state.capabilities }),
  });
}

function rejected(code, extra) {
  return Object.freeze([Object.freeze({ type: 'rejected', code, ...(extra || {}) })]);
}

function createOfficeState({ capabilities } = {}) {
  return frozenState({
    presence: 'present',
    sync: 'healthy',
    runtime: 'unbound',
    activity: 'roaming',
    movement: 'stationary',
    control: 'none',
    binding: 'unbound',
    queue: 'empty',
    lastResult: null,
    lastTool: null,
    lastActivityReason: null,
    capabilities: { ...DEFAULT_CAPABILITIES, ...(capabilities || {}) },
  });
}

function reduceOfficeState(state, event) {
  const type = event ? event.type : undefined;
  const next = { ...state };
  const effects = [];

  switch (type) {
    // ---- Harness runtime facts (sole authority for runtime/task truth) ----
    case 'runtime/fact': {
      const fact = event.fact;
      if (!RUNTIME_STATES.includes(fact) || fact === 'unbound') {
        return { state, effects: rejected('RUNTIME_FACT_INVALID', { fact: fact === undefined ? null : fact }) };
      }
      next.runtime = fact;
      if (fact === 'running') {
        next.activity =
          event.reason === 'thinking' ? 'thinking' : event.reason === 'waiting' ? 'waiting' : 'working';
        if (next.binding === 'pending') {
          next.binding = 'bound';
          if (next.control === 'dispatchPending') next.control = 'none';
        }
        effects.push({ type: 'interrupt-local-behavior' });
      } else if (fact === 'attention') {
        if (next.activity === 'sleeping') next.activity = 'working';
        effects.push({ type: 'attention-presentation', reason: event.reason || null });
      } else if (fact === 'completed' || fact === 'failed') {
        next.lastResult = {
          outcome: fact,
          reason: event.reason || null,
          taskId: event.taskId || null,
        };
        if (next.binding !== 'unbound') next.binding = 'releasing';
        effects.push({ type: 'result-presentation', outcome: fact });
      } else if (fact === 'idle') {
        if (next.binding === 'releasing') next.binding = 'unbound';
      }
      break;
    }

    case 'runtime/tool': {
      if (state.runtime !== 'running') {
        return { state, effects: rejected('TOOL_FACT_WITHOUT_RUNNING') };
      }
      next.lastTool = event.tool || null;
      effects.push({ type: 'tool-fact', tool: next.lastTool });
      break;
    }

    case 'runtime/cancelled': {
      if (state.control !== 'cancellationPending' && state.control !== 'preemptPending') {
        return { state, effects: rejected('CANCEL_EVIDENCE_WITHOUT_REQUEST') };
      }
      next.control = 'none';
      if (next.binding !== 'unbound') next.binding = 'releasing';
      next.runtime = 'idle';
      next.lastResult = { outcome: 'cancelled', reason: event.evidence || null, taskId: null };
      effects.push({ type: 'release-binding', evidence: event.evidence || null });
      break;
    }

    // ---- Local behavior (may only write the four local activities) -------
    case 'local/activity': {
      if (!LOCAL_ACTIVITIES.includes(event.activity)) {
        return { state, effects: rejected('LOCAL_ACTIVITY_UNSUPPORTED', { activity: event.activity || null }) };
      }
      if (state.runtime === 'running' || state.runtime === 'attention') {
        return { state, effects: rejected('runtime-priority') };
      }
      if (state.runtime === 'completed' || state.runtime === 'failed') {
        return { state, effects: rejected('result-presentation') };
      }
      // Task 5 / SPEC-04: sleeping is a local activity, never offline, but a
      // resident with an unfinished binding or a non-healthy sync may not
      // enter it. Roaming/chatting/resting are unaffected by sync.
      if (event.activity === 'sleeping') {
        if (state.binding !== 'unbound') {
          return { state, effects: rejected('SLEEP_BLOCKED_BINDING', { binding: state.binding }) };
        }
        if (state.sync !== 'healthy') {
          return { state, effects: rejected('SLEEP_BLOCKED_SYNC', { sync: state.sync }) };
        }
      }
      next.activity = event.activity;
      next.lastActivityReason = event.reason || null;
      effects.push({ type: 'activity-changed', from: state.activity, to: event.activity });
      break;
    }

    // ---- Sync diagnostics (never touch activity/runtime/binding) ---------
    case 'sync/status': {
      if (!SYNC_STATES.includes(event.sync)) {
        return { state, effects: rejected('SYNC_STATUS_INVALID', { sync: event.sync === undefined ? null : event.sync }) };
      }
      next.sync = event.sync;
      effects.push({ type: 'sync-changed', sync: event.sync });
      break;
    }

    // ---- User control (cannot fabricate Runtime facts) --------------------
    case 'control/dispatch': {
      if (state.runtime === 'running' || state.runtime === 'attention') {
        next.queue = 'queued';
        effects.push({ type: 'queued' });
      } else {
        next.control = 'dispatchPending';
        next.binding = 'pending';
        effects.push({ type: 'dispatch-started' });
      }
      break;
    }

    case 'control/cancel': {
      if (!state.capabilities.cancel) {
        return { state, effects: rejected('CONTROL_UNSUPPORTED', { control: 'cancel' }) };
      }
      if (state.binding === 'unbound') {
        return { state, effects: rejected('NOT_BOUND') };
      }
      next.control = 'cancellationPending';
      effects.push({ type: 'send-control', control: 'cancel' });
      break;
    }

    case 'control/cancel-ack': {
      // An acknowledgement only confirms the request was delivered; the
      // binding is retained until terminal evidence arrives.
      effects.push({ type: 'awaiting-terminal-evidence' });
      break;
    }

    case 'control/preempt': {
      if (!state.capabilities.preempt) {
        return { state, effects: rejected('CONTROL_UNSUPPORTED', { control: 'preempt' }) };
      }
      if (state.binding === 'unbound') {
        return { state, effects: rejected('NOT_BOUND') };
      }
      next.control = 'preemptPending';
      effects.push({ type: 'send-control', control: 'cancel' });
      break;
    }

    case 'control/pause':
    case 'control/resume': {
      // Reserved vocabulary only: the current Harness contract exposes no
      // pause/resume pair, and the frozen SPEC-00 control enum has no
      // pausePending/resumePending state to represent one.
      const control = type === 'control/pause' ? 'pause' : 'resume';
      return { state, effects: rejected('CONTROL_UNSUPPORTED', { control }) };
    }

    // ---- Derived binding (Office Adapter evidence) ------------------------
    case 'binding/bound': {
      if (state.binding !== 'pending') {
        return { state, effects: rejected('BINDING_INVALID_TRANSITION') };
      }
      next.binding = 'bound';
      if (next.control === 'dispatchPending') next.control = 'none';
      effects.push({ type: 'binding-changed', binding: 'bound' });
      break;
    }

    case 'binding/released': {
      if (state.binding !== 'releasing') {
        return { state, effects: rejected('BINDING_INVALID_TRANSITION') };
      }
      next.binding = 'unbound';
      effects.push({ type: 'binding-changed', binding: 'unbound' });
      break;
    }

    case 'queue/enqueue': {
      next.queue = 'queued';
      effects.push({ type: 'queue-changed', queue: 'queued' });
      break;
    }

    case 'queue/dequeue': {
      if (state.queue !== 'queued') {
        return { state, effects: rejected('QUEUE_EMPTY') };
      }
      next.queue = 'empty';
      effects.push({ type: 'queue-changed', queue: 'empty' });
      break;
    }

    // ---- Transition completion after result presentation ------------------
    case 'transition/complete': {
      if (state.runtime !== 'completed' && state.runtime !== 'failed') {
        return { state, effects: rejected('TRANSITION_COMPLETE_NOT_APPLICABLE') };
      }
      if (state.queue === 'queued') {
        next.runtime = 'unbound';
        next.control = 'dispatchPending';
        next.binding = 'pending';
        effects.push({ type: 'start-queued-task' });
      } else {
        next.runtime = 'idle';
        next.binding = 'unbound';
        next.activity = 'roaming';
        next.movement = 'stationary';
        effects.push({ type: 'resume-local-behavior' });
      }
      break;
    }

    // ---- Movement events (position/direction/reservations only) -----------
    case 'movement/status': {
      if (!MOVEMENT_STATES.includes(event.movement)) {
        return { state, effects: rejected('MOVEMENT_STATUS_INVALID', { movement: event.movement === undefined ? null : event.movement }) };
      }
      next.movement = event.movement;
      effects.push({ type: 'movement-changed', movement: event.movement });
      break;
    }

    // ---- Animation events select resources only, never office state ------
    case 'animation/select': {
      effects.push({ type: 'animation-not-reducer-state', resource: event.resource || null });
      break;
    }

    // ---- Presence is a resident invariant ---------------------------------
    case 'presence/set': {
      if (event.presence !== 'present') {
        return { state, effects: rejected('PRESENCE_OFFLINE_UNSUPPORTED', { presence: event.presence === undefined ? null : event.presence }) };
      }
      effects.push({ type: 'presence-confirmed', presence: 'present' });
      break;
    }

    default:
      return { state, effects: rejected('UNKNOWN_EVENT', { eventType: type === undefined ? null : type }) };
  }

  return { state: frozenState(next), effects: Object.freeze(effects.map((effect) => Object.freeze(effect))) };
}

module.exports = {
  createOfficeState,
  reduceOfficeState,
  PRESENCE_STATES,
  SYNC_STATES,
  RUNTIME_STATES,
  ACTIVITY_STATES,
  MOVEMENT_STATES,
  CONTROL_STATES,
  BINDING_STATES,
  QUEUE_STATES,
  LOCAL_ACTIVITIES,
  TERMINAL_OUTCOMES,
  DEFAULT_CAPABILITIES,
};
