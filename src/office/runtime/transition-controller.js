'use strict';

// src/office/runtime/transition-controller.js — Task 3 / SPEC-03.
//
// Explicit transition orchestration phases, without rendering. Transitions
// are internal orchestration records (never new Runtime business states):
//
//   task start:  stop -> turn -> move -> arrive -> sit -> work
//   task end:    result -> stand -> leave      (completed AND failed)
//
// The controller is pure and deterministic: every method takes explicit
// input and returns frozen records. It never touches sprites, positions or
// runtime facts; it only decides WHICH phase is active and WHAT stale state
// (old path reservations, chat locks) must be released. Interruptions record
// their reason and preserve the last trusted task; stale path/chat state can
// never survive into a new transition.

const TASK_START_PHASES = Object.freeze(['stop', 'turn', 'move', 'arrive', 'sit', 'work']);
const TASK_END_PHASES = Object.freeze(['result', 'stand', 'leave']);
const CLEANUP_ALL = Object.freeze({ releaseReservations: true, releaseChatLock: true, clearPath: true });
const CLEANUP_NONE = Object.freeze({ releaseReservations: false, releaseChatLock: false, clearPath: false });
const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed']);

function freezeTransition(transition) {
  return Object.freeze({
    ...transition,
    cleanup: Object.freeze({ ...transition.cleanup }),
    interrupted: transition.interrupted ? Object.freeze({ ...transition.interrupted }) : null,
    target: transition.target ? Object.freeze({ ...transition.target }) : null,
  });
}

function createTransitionController() {
  function base(fields) {
    return {
      kind: null,
      phase: null,
      reason: null,
      fromActivity: null,
      target: null,
      taskId: null,
      outcome: null,
      result: null,
      lastTrustedTask: null,
      interrupted: null,
      cleanup: CLEANUP_NONE,
      updatedAt: null,
      ...fields,
    };
  }

  // A runtime task arriving during roaming/chatting/resting/sleeping (or any
  // in-flight transition) interrupts local behavior: release the old path
  // reservations and chat locks, clear the stale path, keep the trusted task.
  function beginTaskStart({ fromActivity, task, target, nowMs, previous } = {}) {
    const lastTrustedTask = task || (previous && previous.lastTrustedTask) || null;
    const interrupted = previous && previous.phase
      ? { reason: 'runtime-task', fromPhase: previous.phase }
      : fromActivity
        ? { reason: 'runtime-task', fromActivity }
        : null;
    const transition = base({
      kind: 'task-start',
      phase: 'stop',
      reason: 'runtime-task',
      fromActivity: fromActivity || (previous && previous.fromActivity) || null,
      target: target || (task && task.target) || null,
      taskId: (task && (task.taskId !== undefined ? task.taskId : task.sessionId)) || null,
      lastTrustedTask,
      interrupted,
      cleanup: CLEANUP_ALL,
      updatedAt: nowMs !== undefined ? nowMs : null,
    });
    return {
      transition: freezeTransition(transition),
      effects: [Object.freeze({ type: 'transition-started', kind: 'task-start', reason: 'runtime-task' })],
    };
  }

  function beginTaskEnd({ outcome, result, task, nowMs, previous } = {}) {
    if (!TERMINAL_OUTCOMES.includes(outcome)) {
      return {
        transition: null,
        effects: [Object.freeze({ type: 'rejected', code: 'INVALID_OUTCOME', outcome: outcome || null })],
      };
    }
    const transition = base({
      kind: 'task-end',
      phase: 'result',
      reason: outcome,
      outcome,
      result: result || null,
      taskId: (task && (task.taskId !== undefined ? task.taskId : task.sessionId)) ||
        (previous && previous.taskId) ||
        null,
      lastTrustedTask: task || (previous && previous.lastTrustedTask) || null,
      interrupted: null,
      cleanup: CLEANUP_NONE,
      updatedAt: nowMs !== undefined ? nowMs : null,
    });
    return {
      transition: freezeTransition(transition),
      effects: [Object.freeze({ type: 'present-result', outcome })],
    };
  }

  // Interruption/cancellation terminal record: stale path and chat state are
  // released, the reason is kept, and the last trusted task survives.
  function interruptedTransition(previous, reason, nowMs) {
    const transition = base({
      kind: 'interrupted',
      phase: null,
      reason,
      outcome: previous && previous.outcome ? previous.outcome : null,
      lastTrustedTask: (previous && previous.lastTrustedTask) || null,
      interrupted: { reason, fromPhase: previous ? previous.phase : null },
      cleanup: CLEANUP_ALL,
      updatedAt: nowMs !== undefined ? nowMs : null,
    });
    return freezeTransition(transition);
  }

  function advance({ transition, event, nowMs } = {}) {
    if (!transition || !transition.kind || !transition.cleanup) {
      return { transition: null, effects: [Object.freeze({ type: 'rejected', code: 'TRANSITION_INVALID' })] };
    }
    const at = nowMs !== undefined ? nowMs : null;
    const eventType = event ? event.type : undefined;

    if (eventType === 'phase-complete' || eventType === 'arrived') {
      const chain = transition.kind === 'task-start' ? TASK_START_PHASES : TASK_END_PHASES;
      if (transition.kind !== 'task-start' && transition.kind !== 'task-end') {
        return { transition, effects: [Object.freeze({ type: 'rejected', code: 'PHASE_NOT_ADVANCEABLE' })] };
      }
      if (eventType === 'arrived') {
        if (transition.phase !== 'move') {
          return { transition, effects: [Object.freeze({ type: 'rejected', code: 'ARRIVED_OUTSIDE_MOVE' })] };
        }
        const next = freezeTransition(base({ ...transition, phase: 'arrive', updatedAt: at }));
        return {
          transition: next,
          effects: [Object.freeze({ type: 'phase-advanced', from: 'move', to: 'arrive' })],
        };
      }
      const index = chain.indexOf(transition.phase);
      if (index === -1) {
        return { transition, effects: [Object.freeze({ type: 'rejected', code: 'PHASE_NOT_ADVANCEABLE' })] };
      }
      if (index === chain.length - 1) {
        const effects = [Object.freeze({ type: 'transition-complete', kind: transition.kind })];
        if (transition.kind === 'task-end') {
          effects.push(Object.freeze({ type: 'resume-local-behavior', outcome: transition.outcome }));
        }
        return { transition: null, effects };
      }
      const nextPhase = chain[index + 1];
      let cleanup = transition.cleanup;
      const effects = [Object.freeze({ type: 'phase-advanced', from: transition.phase, to: nextPhase })];
      if (transition.kind === 'task-end' && nextPhase === 'leave') {
        cleanup = { ...transition.cleanup, releaseReservations: true, clearPath: true };
        effects.push(Object.freeze({ type: 'release-path-reservations' }));
      }
      return {
        transition: freezeTransition(base({ ...transition, phase: nextPhase, cleanup, updatedAt: at })),
        effects,
      };
    }

    if (eventType === 'runtime-task') {
      const started = beginTaskStart({
        fromActivity: event.fromActivity || null,
        task: event.task || null,
        target: event.target || null,
        nowMs: at,
        previous: transition,
      });
      return {
        transition: started.transition,
        effects: [
          Object.freeze({ type: 'interrupt-previous', fromPhase: transition.phase, reason: 'runtime-task' }),
          Object.freeze({ type: 'release-path-reservations' }),
          Object.freeze({ type: 'release-chat-lock' }),
          Object.freeze({ type: 'stop-movement' }),
        ],
      };
    }

    if (eventType === 'task-terminal') {
      const ended = beginTaskEnd({
        outcome: event.outcome,
        result: event.result || null,
        task: event.task || null,
        nowMs: at,
        previous: transition,
      });
      if (!ended.transition) return ended;
      return {
        transition: ended.transition,
        effects: ended.effects,
      };
    }

    if (eventType === 'interrupt') {
      const reason = event.reason || 'unspecified';
      return {
        transition: interruptedTransition(transition, reason, at),
        effects: [
          Object.freeze({ type: 'release-path-reservations' }),
          Object.freeze({ type: 'release-chat-lock' }),
          Object.freeze({ type: 'stop-movement' }),
          Object.freeze({ type: 'transition-complete', kind: 'interrupted' }),
        ],
      };
    }

    if (eventType === 'cancel-request') {
      return {
        transition: interruptedTransition(transition, 'cancellationRequested', at),
        effects: [
          Object.freeze({ type: 'release-path-reservations' }),
          Object.freeze({ type: 'release-chat-lock' }),
          Object.freeze({ type: 'stop-movement' }),
          Object.freeze({ type: 'transition-complete', kind: 'interrupted' }),
        ],
      };
    }

    return {
      transition,
      effects: [Object.freeze({ type: 'rejected', code: 'UNKNOWN_EVENT', eventType: eventType === undefined ? null : eventType })],
    };
  }

  return Object.freeze({
    beginTaskStart: Object.freeze(beginTaskStart),
    beginTaskEnd: Object.freeze(beginTaskEnd),
    advance: Object.freeze(advance),
    TASK_START_PHASES,
    TASK_END_PHASES,
  });
}

module.exports = {
  createTransitionController,
  TASK_START_PHASES,
  TASK_END_PHASES,
};
