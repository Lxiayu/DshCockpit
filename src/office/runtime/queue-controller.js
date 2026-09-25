'use strict';

// src/office/runtime/queue-controller.js — Task 5 / SPEC-04.
//
// FIFO task queue per seat (four residents + the single collaborator).
// Pure operational ledger: no Electron/Pixi/DOM/fs/network/clock/random
// access, no Harness import, no wall-clock or PRNG-global access.
//
// Contracts (SPEC-04 / character-state-machine):
// - queue item: queueItemId/requestedAt/requestedBy/employeeId/sessionId/
//   taskSummary/priority/status; status is queued | dispatching | running |
//   cancelled | completed | failed
// - an idle seat is dispatched directly: one transaction creates the item in
//   `dispatching` AND the binding=pending effect pair (dispatch-started +
//   binding-pending)
// - a busy seat only appends a `queued` item; the active binding is unchanged
// - urgent dispatch on a busy seat requests cancel/interrupt
//   (preempt-requested + send-control) but NEVER dispatches before terminal
//   evidence and never jumps the (strict FIFO) collaborator queue
// - cancel/interrupt waits for terminal evidence: the cancel request and the
//   cancel acknowledgement alone never release the seat
// - terminal evidence (turn-end | subagent-end | session-end) atomically
//   releases the seat and starts the next queued head in the SAME
//   transaction; nothing is lost, dispatches always require a fresh path
//   (requireFreshPath) so no stale path reservation or teleport is reused
// - a session id can only live in one seat queue at a time
// - queueItemIds are deterministic (counter-based) for JSON replay

const QUEUE_ITEM_STATUS = Object.freeze([
  'queued',
  'dispatching',
  'running',
  'cancelled',
  'completed',
  'failed',
]);
const ACTIVE_STATUSES = Object.freeze(['dispatching', 'running']);
const PRIORITIES = Object.freeze(['normal', 'urgent']);
const REQUESTED_BY = Object.freeze(['user', 'runtime']);
const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed', 'cancelled']);
const TERMINAL_EVIDENCE_TYPES = Object.freeze(['turn-end', 'subagent-end', 'session-end']);

function effect(type, fields) {
  return Object.freeze({ type, ...fields });
}

function fail(code, extra) {
  return Object.freeze({ ok: false, code, ...(extra || {}) });
}

function freezeItem(item) {
  return Object.freeze({ ...item });
}

function createQueueController({ seats, collaboratorId = null, isBusy = null, clock = null } = {}) {
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new TypeError('createQueueController requires a non-empty seats array');
  }
  const seatSet = new Set(seats);
  const now = clock && typeof clock.nowMs === 'function' ? clock.nowMs : () => 0;

  const queues = new Map();
  for (const seat of seats) queues.set(seat, []);
  const itemsById = new Map();
  const sessionIndex = new Map();
  const activeByEmployee = new Map();
  let counter = 0;

  function atOrDefault(nowMs) {
    return typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : now();
  }

  function nextItemId() {
    counter += 1;
    return `queue-${String(counter).padStart(6, '0')}`;
  }

  function seatBusy(employeeId) {
    if (activeByEmployee.has(employeeId)) return true;
    return isBusy ? !!isBusy(employeeId) : false;
  }

  function enqueue(request) {
    const {
      requestedBy,
      employeeId,
      sessionId,
      taskSummary,
      priority = 'normal',
      nowMs,
      forceQueue = false,
    } = request || {};
    if (!seatSet.has(employeeId)) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    if (!REQUESTED_BY.includes(requestedBy)) return fail('INVALID_REQUESTED_BY', { requestedBy: requestedBy ?? null });
    if (!PRIORITIES.includes(priority)) return fail('INVALID_PRIORITY', { priority: priority ?? null });
    if (typeof sessionId !== 'string' || sessionId === '') return fail('SESSION_ID_REQUIRED');
    if (sessionIndex.has(sessionId)) {
      return fail('SESSION_ALREADY_QUEUED', { sessionId, queueItemId: sessionIndex.get(sessionId) });
    }
    const at = atOrDefault(nowMs);
    const item = {
      queueItemId: nextItemId(),
      requestedAt: at,
      requestedBy,
      employeeId,
      sessionId,
      taskSummary: taskSummary === undefined || taskSummary === null ? '' : String(taskSummary),
      priority,
      status: 'queued',
      cancelRequested: false,
      acknowledgedAt: null,
    };
    itemsById.set(item.queueItemId, item);
    sessionIndex.set(sessionId, item.queueItemId);

    const busy = forceQueue || seatBusy(employeeId);
    if (busy) {
      queues.get(employeeId).push(item);
      const effects = [effect('queued', { employeeId, sessionId, queueItemId: item.queueItemId })];
      const active = activeByEmployee.get(employeeId);
      if (!forceQueue && priority === 'urgent' && active) {
        // Urgent asks for cancel/interrupt of the running task but never
        // starts before terminal evidence, never teleports and never jumps
        // the FIFO order.
        effects.push(
          effect('preempt-requested', {
            employeeId,
            queueItemId: item.queueItemId,
            targetSessionId: active.sessionId,
          })
        );
        effects.push(
          effect('send-control', { control: 'cancel', employeeId, queueItemId: active.queueItemId })
        );
      }
      return Object.freeze({ ok: true, item: freezeItem(item), effects: Object.freeze(effects) });
    }

    item.status = 'dispatching';
    activeByEmployee.set(employeeId, item);
    const effects = [
      effect('dispatch-started', {
        employeeId,
        sessionId,
        queueItemId: item.queueItemId,
        priority,
        requireFreshPath: true,
      }),
      effect('binding-pending', { employeeId, sessionId, queueItemId: item.queueItemId }),
    ];
    return Object.freeze({ ok: true, item: freezeItem(item), effects: Object.freeze(effects) });
  }

  // Starts the FIFO head of a free seat (used by the collaborator assignment
  // and by future adapter-driven resident dispatch).
  function dispatchNext({ employeeId, nowMs } = {}) {
    if (!seatSet.has(employeeId)) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    if (activeByEmployee.has(employeeId)) return fail('SEAT_BUSY', { employeeId });
    const queue = queues.get(employeeId);
    const head = queue.shift();
    if (!head) return Object.freeze({ ok: true, item: null, effects: Object.freeze([]) });
    head.status = 'dispatching';
    activeByEmployee.set(employeeId, head);
    const effects = [
      effect('dispatch-started', {
        employeeId,
        sessionId: head.sessionId,
        queueItemId: head.queueItemId,
        priority: head.priority,
        requireFreshPath: true,
      }),
      effect('binding-pending', { employeeId, sessionId: head.sessionId, queueItemId: head.queueItemId }),
    ];
    return Object.freeze({ ok: true, item: freezeItem(head), effects: Object.freeze(effects) });
  }

  function markRunning({ queueItemId, nowMs } = {}) {
    const item = itemsById.get(queueItemId);
    if (!item) return fail('ITEM_UNKNOWN', { queueItemId: queueItemId ?? null });
    if (item.status !== 'dispatching') {
      return fail('ITEM_NOT_DISPATCHING', { queueItemId, status: item.status });
    }
    item.status = 'running';
    return Object.freeze({ ok: true, item: freezeItem(item), effects: Object.freeze([]) });
  }

  function requestCancel({ queueItemId, nowMs } = {}) {
    const item = itemsById.get(queueItemId);
    if (!item) return fail('ITEM_UNKNOWN', { queueItemId: queueItemId ?? null });
    if (TERMINAL_OUTCOMES.includes(item.status)) {
      return fail('ITEM_ALREADY_TERMINAL', { queueItemId, status: item.status });
    }
    if (item.status === 'queued') {
      const queue = queues.get(item.employeeId);
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
      item.status = 'cancelled';
      sessionIndex.delete(item.sessionId);
      return Object.freeze({
        ok: true,
        item: freezeItem(item),
        effects: Object.freeze([
          effect('queue-item-cancelled', { employeeId: item.employeeId, queueItemId, sessionId: item.sessionId }),
        ]),
      });
    }
    // Active item: request cancel/interrupt, keep the binding. The item stays
    // active until terminal evidence arrives.
    item.cancelRequested = true;
    return Object.freeze({
      ok: true,
      item: freezeItem(item),
      effects: Object.freeze([
        effect('send-control', { control: 'cancel', employeeId: item.employeeId, queueItemId }),
      ]),
    });
  }

  function noteCancelAcknowledged({ queueItemId, nowMs } = {}) {
    const item = itemsById.get(queueItemId);
    if (!item) return fail('ITEM_UNKNOWN', { queueItemId: queueItemId ?? null });
    // An acknowledgement only confirms delivery: the item stays active and
    // the binding is retained until terminal evidence.
    item.acknowledgedAt = atOrDefault(nowMs);
    return Object.freeze({
      ok: true,
      item: freezeItem(item),
      effects: Object.freeze([effect('awaiting-terminal-evidence', { queueItemId })]),
    });
  }

  // Accepts a Harness terminal fact for one active item and, in the SAME
  // transaction, releases the seat and starts the next queued head.
  // Task 7B: terminal evidence for an item that is still WAITING (never
  // dispatched). The item leaves the waiting queue with its real outcome and
  // the seat's active item is untouched — a queued close can never dispatch,
  // never take the seat and never disturb the running task.
  function closeQueuedItem({ sessionId, queueItemId, evidenceType, outcome, nowMs } = {}) {
    if (!TERMINAL_EVIDENCE_TYPES.includes(evidenceType)) {
      return fail('TERMINAL_EVIDENCE_REQUIRED', { evidenceType: evidenceType === undefined ? null : evidenceType });
    }
    if (!TERMINAL_OUTCOMES.includes(outcome)) {
      return fail('INVALID_OUTCOME', { outcome: outcome === undefined ? null : outcome });
    }
    if (queueItemId && sessionId) {
      const referenced = itemsById.get(queueItemId);
      if (!referenced || referenced.sessionId !== sessionId) {
        return fail('QUEUE_ITEM_SESSION_MISMATCH', { sessionId, queueItemId });
      }
    }
    const item = queueItemId
      ? itemsById.get(queueItemId)
      : findQueuedItemBySession(sessionId);
    if (!item || item.status !== 'queued') {
      return fail('SESSION_NOT_QUEUED', { sessionId: sessionId ?? null, queueItemId: queueItemId ?? null });
    }
    const queue = queues.get(item.employeeId);
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    item.status = outcome;
    sessionIndex.delete(item.sessionId);
    return Object.freeze({ ok: true, item: freezeItem(item), effects: Object.freeze([]) });
  }

  function findQueuedItemBySession(sessionId) {
    const queueItemId = sessionIndex.get(sessionId);
    if (!queueItemId) return null;
    const item = itemsById.get(queueItemId);
    return item && item.status === 'queued' ? item : null;
  }

  function noteTerminalEvidence({ queueItemId, evidenceType, outcome, nowMs } = {}) {
    if (!TERMINAL_EVIDENCE_TYPES.includes(evidenceType)) {
      return fail('TERMINAL_EVIDENCE_REQUIRED', { evidenceType: evidenceType === undefined ? null : evidenceType });
    }
    if (!TERMINAL_OUTCOMES.includes(outcome)) {
      return fail('INVALID_OUTCOME', { outcome: outcome === undefined ? null : outcome });
    }
    const item = itemsById.get(queueItemId);
    if (!item) return fail('ITEM_UNKNOWN', { queueItemId: queueItemId ?? null });
    if (!ACTIVE_STATUSES.includes(item.status)) {
      return fail('ITEM_NOT_ACTIVE', { queueItemId, status: item.status });
    }
    const employeeId = item.employeeId;
    item.status = outcome;
    if (activeByEmployee.get(employeeId) === item) activeByEmployee.delete(employeeId);
    sessionIndex.delete(item.sessionId);
    const effects = [
      effect('release-binding', { employeeId, sessionId: item.sessionId, queueItemId, outcome }),
    ];
    const queue = queues.get(employeeId);
    const head = queue.shift();
    if (head) {
      head.status = 'dispatching';
      activeByEmployee.set(employeeId, head);
      effects.push(
        effect('dispatch-started', {
          employeeId,
          sessionId: head.sessionId,
          queueItemId: head.queueItemId,
          priority: head.priority,
          requireFreshPath: true,
        })
      );
      effects.push(
        effect('binding-pending', { employeeId, sessionId: head.sessionId, queueItemId: head.queueItemId })
      );
    } else {
      effects.push(effect('resume-local-behavior', { employeeId }));
    }
    return Object.freeze({ ok: true, item: freezeItem(item), effects: Object.freeze(effects) });
  }

  function activeItem(employeeId) {
    const item = activeByEmployee.get(employeeId);
    return item ? freezeItem(item) : null;
  }

  function waitingItems(employeeId) {
    const queue = queues.get(employeeId);
    if (!queue) return [];
    return Object.freeze(queue.map((item) => freezeItem(item)));
  }

  function waitingCount(employeeId) {
    const queue = queues.get(employeeId);
    return queue ? queue.length : 0;
  }

  function getItem(queueItemId) {
    const item = itemsById.get(queueItemId);
    return item ? freezeItem(item) : null;
  }

  function snapshot(employeeId) {
    if (employeeId !== undefined) {
      if (!seatSet.has(employeeId)) return fail('UNKNOWN_EMPLOYEE', { employeeId });
      return Object.freeze({
        employeeId,
        waitingCount: waitingCount(employeeId),
        active: activeItem(employeeId),
        waiting: waitingItems(employeeId),
      });
    }
    return Object.freeze({
      queues: Object.freeze(
        seats.map((seat) =>
          Object.freeze({
            employeeId: seat,
            waitingCount: waitingCount(seat),
            waiting: waitingItems(seat),
          })
        )
      ),
    });
  }

  return Object.freeze({
    enqueue: Object.freeze(enqueue),
    dispatchNext: Object.freeze(dispatchNext),
    markRunning: Object.freeze(markRunning),
    requestCancel: Object.freeze(requestCancel),
    closeQueuedItem: Object.freeze(closeQueuedItem),
    noteCancelAcknowledged: Object.freeze(noteCancelAcknowledged),
    noteTerminalEvidence: Object.freeze(noteTerminalEvidence),
    activeItem: Object.freeze(activeItem),
    findQueuedItemBySession: Object.freeze(findQueuedItemBySession),
    waitingItems: Object.freeze(waitingItems),
    waitingCount: Object.freeze(waitingCount),
    getItem: Object.freeze(getItem),
    snapshot: Object.freeze(snapshot),
    seats: Object.freeze([...seats]),
    collaboratorId,
  });
}

module.exports = {
  createQueueController,
  QUEUE_ITEM_STATUS,
  ACTIVE_STATUSES,
  PRIORITIES,
  REQUESTED_BY,
  TERMINAL_OUTCOMES,
  TERMINAL_EVIDENCE_TYPES,
};
