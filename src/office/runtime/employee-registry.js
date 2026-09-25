'use strict';

// src/office/runtime/employee-registry.js — Task 5 / SPEC-04.
//
// Binding + employee registry over the fixed profiles. Pure operational
// ledger: no Electron/Pixi/DOM/fs/network/clock/random access, no Harness
// import, no wall-clock or PRNG-global use. The registry never invents
// Runtime facts.
//
// Contracts (SPEC-04 / character-state-machine):
// - binding fields: sessionId/employeeId/bindingSource/confidence/boundAt/
//   releasedAt
// - priority manual > root-default > heuristic; a weaker source may not
//   overwrite a stronger one
// - session IDs are globally unique; one session cannot bind two employees
// - one employee holds at most one active binding
// - root sessions default to orchestrator (root-default source)
// - child runId/session registration keeps the parentId relation
// - subagent/end releases ONLY with terminal evidence (stopReason mapping to
//   a terminal outcome); unknown/soft stop reasons never release
// - a cancel acknowledgement never releases the binding
// - released bindings keep redacted last task/result summaries (no secrets)
// - presence stays present forever; no offline state exists
//
// Queue fact sourcing (review round D): the injected `queueController` is the
// SINGLE source of truth for every queued request — busy resident sessions,
// unclassified collaborator subagents and release-then-dispatch switches.
// This registry owns ONLY active/released bindings, parent/child session
// relations and classification metadata; it never mirrors a private queue.
// Pure delegation interface:
// - every bindSession goes through `queueController.enqueue(...)`; a free
//   seat yields a `dispatching` item whose effects carry the reducer
//   transaction (dispatch-started + binding-pending), a busy seat yields a
//   `queued` FIFO item and NO binding
// - release paths close the matching queue item via
//   `queueController.noteTerminalEvidence(...)`; the queue's atomic switch
//   dispatches the next FIFO head and the registry binds that head inside
//   the same transaction

const profiles = require('./employee-profile.js');
const { createPrivacyRedactor } = require('./privacy-redactor.js');
const { createQueueController, TERMINAL_OUTCOMES } = require('./queue-controller.js');

const BINDING_SOURCES = Object.freeze(['manual', 'root-default', 'heuristic']);
const SOURCE_PRIORITY = Object.freeze(Object.assign(Object.create(null), {
  heuristic: 1,
  'root-default': 2,
  manual: 3,
}));
const CONFIDENCE_BY_SOURCE = Object.freeze({ manual: 1, 'root-default': 0.9, heuristic: 0.4 });
const ROOT_DEFAULT_EMPLOYEE = 'orchestrator';
// The three resident WORK seats a classified subagent may take. Explicitly
// excludes orchestrator (root-owned) and collaborator (unclassified default).
const CLASSIFIED_WORK_SEATS = Object.freeze(['researcher', 'coder', 'reviewer']);
// stopReason values that count as terminal evidence for subagent/end.
const TERMINAL_STOP_REASONS = Object.freeze(['completed', 'error', 'failed', 'aborted', 'interrupted', 'cancelled']);
// Evidence that only acknowledges delivery is never terminal evidence.
const NON_TERMINAL_EVIDENCE = Object.freeze(['cancel-ack']);
const REDACTED_SUMMARY = '[redacted]';

function fail(code, extra) {
  return Object.freeze({ ok: false, code, ...(extra || {}) });
}

function summarize(text) {
  if (text === undefined || text === null || text === '') return '';
  return REDACTED_SUMMARY;
}

function createEmployeeRegistry({ redactor = null, clock = null, queueController = null } = {}) {
  const shareRedactor = redactor || createPrivacyRedactor({ mode: 'redacted' });
  const now = clock && typeof clock.nowMs === 'function' ? clock.nowMs : () => 0;

  const employees = new Map();
  for (const profile of profiles.listResidentProfiles()) {
    employees.set(profile.employeeId, {
      employeeId: profile.employeeId,
      displayName: profile.displayName,
      role: profile.role,
      defaultSeat: profile.defaultSeat,
      presence: 'present',
    });
  }
  const collaboratorProfile = profiles.getCollaboratorProfile();
  employees.set(collaboratorProfile.employeeId, {
    employeeId: collaboratorProfile.employeeId,
    displayName: collaboratorProfile.displayName,
    role: collaboratorProfile.role,
    defaultSeat: collaboratorProfile.defaultSeat,
    presence: 'present',
  });

  // The single queue fact source. An injected controller is shared verbatim;
  // a private default keeps the standalone registry usable.
  const queue =
    queueController ||
    createQueueController({
      seats: [...employees.keys()],
      collaboratorId: collaboratorProfile.employeeId,
      clock: clock ? { nowMs: now } : null,
    });
  const seats = new Set(queue.seats || [...employees.keys()]);

  // sessionId -> binding record
  const bindingsBySession = new Map();
  // employeeId -> active binding record (binding.releasedAt === null)
  const activeByEmployee = new Map();
  // childSessionId -> { parentSessionId, childSessionId, runId, registeredAt }
  const childSessions = new Map();
  // sessionId -> classification ('root' | 'child' | 'unclassified')
  const classification = new Map();
  // sessionId -> { bindingSource, confidence } — binding INTENT metadata for
  // sessions waiting in the queue-controller FIFO. Classification metadata
  // ONLY: no FIFO order, no status and no queueItemId facts live here (the
  // queue-controller remains the single fact source for all of those). The
  // intent is consumed once the queue dispatches the session.
  const pendingBindingIntent = new Map();
  // Task 7B: runId recorded at subagent/start for UNCLASSIFIED queued
  // subagents — the fail-closed reference for their queued terminal evidence.
  // Consumed (deleted) when the queued item closes.
  const queuedRunIds = new Map();

  function atOrDefault(nowMs) {
    return typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : now();
  }

  function freezeBinding(binding) {
    return Object.freeze({ ...binding });
  }

  function createBinding({ employeeId, sessionId, bindingSource, confidence, at, taskSummary }) {
    const binding = {
      sessionId,
      employeeId,
      bindingSource,
      confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0,
      boundAt: at,
      releasedAt: null,
      lastTask: summarize(taskSummary),
      lastResult: '',
    };
    bindingsBySession.set(sessionId, binding);
    activeByEmployee.set(employeeId, binding);
    return binding;
  }

  function hasAnyActiveBindingForSession(sessionId) {
    return bindingsBySession.has(sessionId) && bindingsBySession.get(sessionId).releasedAt === null;
  }

  function sessionKnownInQueue(sessionId) {
    for (const seat of seats) {
      const active = queue.activeItem(seat);
      if (active && active.sessionId === sessionId) return true;
      for (const item of queue.waitingItems(seat)) {
        if (item.sessionId === sessionId) return true;
      }
    }
    return false;
  }

  // Re-binds or upgrades an existing session binding.
  function upsertBinding({ employeeId, sessionId, bindingSource, confidence, at, taskSummary }) {
    const existing = bindingsBySession.get(sessionId);
    if (existing && existing.releasedAt !== null) {
      return fail('SESSION_BINDING_RELEASED', { sessionId });
    }
    if (existing) {
      const currentRank = SOURCE_PRIORITY[existing.bindingSource] || 0;
      const nextRank = SOURCE_PRIORITY[bindingSource] || 0;
      if (nextRank < currentRank) {
        return fail('BINDING_PRIORITY_INSUFFICIENT', { current: existing.bindingSource, next: bindingSource });
      }
      if (existing.employeeId !== employeeId) {
        return fail('SESSION_ALREADY_BOUND', { sessionId, employeeId: existing.employeeId });
      }
      existing.bindingSource = bindingSource;
      existing.confidence = Math.max(existing.confidence, confidence);
      return Object.freeze({ ok: true, binding: freezeBinding(existing), effects: Object.freeze([]) });
    }
    const binding = createBinding({ employeeId, sessionId, bindingSource, confidence, at, taskSummary });
    return Object.freeze({ ok: true, binding: freezeBinding(binding), effects: Object.freeze([]) });
  }

  function bindSession(request) {
    const { employeeId, sessionId, bindingSource = 'heuristic', confidence, nowMs, taskSummary } = request || {};
    if (!employees.has(employeeId)) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    if (typeof sessionId !== 'string' || sessionId === '') return fail('SESSION_ID_REQUIRED');
    if (!BINDING_SOURCES.includes(bindingSource)) {
      return fail('INVALID_BINDING_SOURCE', { bindingSource: bindingSource ?? null });
    }
    const at = atOrDefault(nowMs);
    const resolvedConfidence =
      typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : CONFIDENCE_BY_SOURCE[bindingSource];

    // Session identities are single-use. Keep the released binding record as
    // the audit/last-result ledger and reject any later attempt before it can
    // reach the shared queue or overwrite that record.
    const existingBinding = bindingsBySession.get(sessionId);
    if (existingBinding && existingBinding.releasedAt !== null) {
      return fail('SESSION_BINDING_RELEASED', { sessionId });
    }

    if (hasAnyActiveBindingForSession(sessionId)) {
      return upsertBinding({ employeeId, sessionId, bindingSource, confidence: resolvedConfidence, at, taskSummary });
    }
    if (sessionKnownInQueue(sessionId)) {
      return fail('SESSION_ALREADY_QUEUED', { sessionId });
    }
    classification.set(sessionId, 'root');

    // Single fact source: the queue-controller decides direct dispatch versus
    // FIFO queueing. A dispatching item means the seat was free; the registry
    // binds it in the same transaction. A queued item means the seat was
    // busy; NO binding is created and the item lives only in the queue.
    const enqueued = queue.enqueue({
      requestedBy: 'runtime',
      employeeId,
      sessionId,
      taskSummary: summarize(taskSummary),
      priority: 'normal',
      nowMs: at,
    });
    if (!enqueued.ok) return fail(enqueued.code, { sessionId });
    if (enqueued.item.status === 'queued') {
      // Preserve the caller's binding intent for the future dispatch: the
      // queue owns the item, the registry keeps only source/confidence.
      pendingBindingIntent.set(sessionId, { bindingSource, confidence: resolvedConfidence });
      return Object.freeze({
        ok: true,
        queued: true,
        employeeId,
        queueItemId: enqueued.item.queueItemId,
        binding: null,
        effects: Object.freeze([]),
      });
    }
    const binding = createBinding({ employeeId, sessionId, bindingSource, confidence: resolvedConfidence, at, taskSummary });
    return Object.freeze({
      ok: true,
      queued: false,
      employeeId,
      queueItemId: enqueued.item.queueItemId,
      binding: freezeBinding(binding),
      effects: enqueued.effects,
    });
  }

  function bindRootSession({ sessionId, nowMs, taskSummary } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return fail('SESSION_ID_REQUIRED');
    // a root session's queued run id (if any) is consumed at (re)bind time,
    // but its pending binding INTENT must survive until the queue dispatches
    consumeQueuedRunId(sessionId);
    return bindSession({
      employeeId: ROOT_DEFAULT_EMPLOYEE,
      sessionId,
      bindingSource: 'root-default',
      nowMs,
      taskSummary,
    });
  }

  function registerChildSession({ parentSessionId, childSessionId, runId, nowMs } = {}) {
    if (typeof childSessionId !== 'string' || childSessionId === '') return fail('SESSION_ID_REQUIRED');
    if (!bindingsBySession.has(parentSessionId)) {
      return fail('PARENT_SESSION_UNKNOWN', { parentSessionId: parentSessionId ?? null });
    }
    if (childSessions.has(childSessionId)) {
      const existing = childSessions.get(childSessionId);
      if (existing.parentSessionId !== parentSessionId || (runId !== undefined && existing.runId !== runId)) {
        return fail('CHILD_SESSION_CONFLICT', { childSessionId });
      }
      return Object.freeze({ ok: true, child: Object.freeze({ ...existing }), effects: Object.freeze([]) });
    }
    const record = {
      parentSessionId,
      childSessionId,
      runId: runId === undefined ? null : runId,
      registeredAt: atOrDefault(nowMs),
    };
    childSessions.set(childSessionId, record);
    classification.set(childSessionId, 'child');
    return Object.freeze({ ok: true, child: Object.freeze({ ...record }), effects: Object.freeze([]) });
  }

  function listChildSessions(parentSessionId) {
    const out = [];
    for (const record of childSessions.values()) {
      if (record.parentSessionId === parentSessionId) out.push(Object.freeze({ ...record }));
    }
    return Object.freeze(out);
  }

  function getParentOf(childSessionId) {
    const record = childSessions.get(childSessionId);
    return record ? record.parentSessionId : null;
  }

  // Unclassified subagents enter the single collaborator FIFO owned by the
  // queue-controller. They always queue (never direct-dispatch) and the
  // registry keeps no private copy of the queue.
  function registerUnclassifiedSubagent({ sessionId, runId, taskSummary, nowMs } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return fail('SESSION_ID_REQUIRED');
    if (hasAnyActiveBindingForSession(sessionId) || sessionKnownInQueue(sessionId)) {
      return fail('SESSION_ALREADY_KNOWN', { sessionId });
    }
    const at = atOrDefault(nowMs);
    const enqueued = queue.enqueue({
      requestedBy: 'runtime',
      employeeId: collaboratorProfile.employeeId,
      sessionId,
      taskSummary: summarize(taskSummary),
      priority: 'normal',
      nowMs: at,
      forceQueue: true,
    });
    if (!enqueued.ok) return fail(enqueued.code, { sessionId });
    classification.set(sessionId, 'unclassified');
    queuedRunIds.set(sessionId, runId ?? null);
    if (runId !== undefined && runId !== null && runId !== '') {
      queuedRunIds.set(sessionId, runId);
    }
    // Unclassified subagents keep the documented heuristic default intent;
    // the queue item itself lives only in the queue-controller.
    pendingBindingIntent.set(sessionId, {
      bindingSource: 'heuristic',
      confidence: CONFIDENCE_BY_SOURCE.heuristic,
    });
    return Object.freeze({
      ok: true,
      queued: true,
      employeeId: collaboratorProfile.employeeId,
      queueItemId: enqueued.item.queueItemId,
      effects: Object.freeze([]),
    });
  }

  function getCollaboratorQueueLength() {
    return queue.waitingCount(collaboratorProfile.employeeId);
  }

  // A CLASSIFIED subagent is a child whose structured metadata (label/mode)
  // named one of the three resident WORK seats. It binds straight to that seat
  // through the SAME queue-controller contract as every other binding: a free
  // seat dispatches immediately (one active binding per employee), a busy seat
  // queues FIFO. The collaborator FIFO is untouched — that remains the
  // documented destination for UNCLASSIFIED subagents only.
  //
  // Fail-closed: only the three resident work seats are accepted. The
  // orchestrator seat is never handed to a child (root sessions own it), and
  // `collaborator` is never passed here (it has its own entry point).
  function registerClassifiedSubagent({ sessionId, runId, employeeId, nowMs } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return fail('SESSION_ID_REQUIRED');
    if (!CLASSIFIED_WORK_SEATS.includes(employeeId)) {
      return fail('NOT_A_CLASSIFIED_SEAT', { employeeId: employeeId === undefined ? null : employeeId });
    }
    if (hasAnyActiveBindingForSession(sessionId) || sessionKnownInQueue(sessionId)) {
      return fail('SESSION_ALREADY_KNOWN', { sessionId });
    }
    const at = atOrDefault(nowMs);
    const enqueued = queue.enqueue({
      requestedBy: 'runtime',
      employeeId,
      sessionId,
      taskSummary: '',
      priority: 'normal',
      nowMs: at,
    });
    if (!enqueued.ok) return fail(enqueued.code, { sessionId });
    if (runId !== undefined && runId !== null && runId !== '') queuedRunIds.set(sessionId, runId);
    if (enqueued.item.status === 'queued') {
      // Seat busy: the queue owns the FIFO item; the intent keeps the
      // heuristic source for the future dispatch.
      pendingBindingIntent.set(sessionId, {
        bindingSource: 'heuristic',
        confidence: CONFIDENCE_BY_SOURCE.heuristic,
      });
      return Object.freeze({
        ok: true,
        queued: true,
        employeeId,
        queueItemId: enqueued.item.queueItemId,
        binding: null,
        effects: Object.freeze([]),
      });
    }
    const binding = createBinding({
      employeeId,
      sessionId,
      bindingSource: 'heuristic',
      confidence: CONFIDENCE_BY_SOURCE.heuristic,
      at,
      taskSummary: '',
    });
    consumeQueuedIdentity(sessionId);
    return Object.freeze({
      ok: true,
      queued: false,
      employeeId,
      queueItemId: enqueued.item.queueItemId,
      binding: freezeBinding(binding),
      effects: enqueued.effects,
    });
  }  function peekCollaboratorQueue() {
    const head = queue.waitingItems(collaboratorProfile.employeeId)[0];
    return head
      ? Object.freeze({ sessionId: head.sessionId, runId: null, taskSummary: head.taskSummary, enqueuedAt: head.requestedAt })
      : null;
  }

  function assignNextCollaboratorItem({ nowMs } = {}) {
    const at = atOrDefault(nowMs);
    if (activeByEmployee.has(collaboratorProfile.employeeId) || queue.activeItem(collaboratorProfile.employeeId)) {
      const active = queue.activeItem(collaboratorProfile.employeeId);
      return fail('COLLABORATOR_BUSY', { sessionId: active ? active.sessionId : null });
    }
    const dispatched = queue.dispatchNext({ employeeId: collaboratorProfile.employeeId, nowMs: at });
    if (!dispatched.ok) return fail(dispatched.code);
    if (!dispatched.item) return Object.freeze({ ok: true, item: null, effects: Object.freeze([]) });
    // Restore the stored binding intent (unclassified: heuristic default).
    const intent = pendingBindingIntent.get(dispatched.item.sessionId) || {
      bindingSource: 'heuristic',
      confidence: CONFIDENCE_BY_SOURCE.heuristic,
    };
    const binding = createBinding({
      employeeId: collaboratorProfile.employeeId,
      sessionId: dispatched.item.sessionId,
      bindingSource: intent.bindingSource,
      confidence: intent.confidence,
      at,
      taskSummary: dispatched.item.taskSummary,
    });
    consumeQueuedIdentity(dispatched.item.sessionId);
    pendingBindingIntent.delete(dispatched.item.sessionId);
    return Object.freeze({
      ok: true,
      item: Object.freeze({
        sessionId: dispatched.item.sessionId,
        runId: null,
        taskSummary: dispatched.item.taskSummary,
        requestedAt: dispatched.item.requestedAt,
      }),
      binding: freezeBinding(binding),
      effects: Object.freeze([
        Object.freeze({ type: 'binding-pending', employeeId: collaboratorProfile.employeeId, sessionId: dispatched.item.sessionId }),
      ]),
    });
  }

  function releaseBindingRecord(binding, at, evidence, outcome, resultSummary) {
    binding.releasedAt = at;
    binding.lastEvidence = evidence === undefined ? null : evidence;
    binding.lastOutcome = outcome === undefined ? null : outcome;
    binding.lastResult = summarize(resultSummary);
    const active = activeByEmployee.get(binding.employeeId);
    if (active === binding) activeByEmployee.delete(binding.employeeId);
    return binding;
  }

  // Maps a free-text evidence marker to a terminal evidence type. Anything
  // that only acknowledges delivery (cancel-ack) maps to null and can never
  // release a binding or close a queue item.
  function evidenceTypeFrom(evidence) {
    if (typeof evidence !== 'string' || evidence === '') return null;
    const lowered = evidence.toLowerCase();
    if (NON_TERMINAL_EVIDENCE.some((token) => lowered.includes(token))) return null;
    if (lowered.includes('subagent/end')) return 'subagent-end';
    if (lowered.includes('session/end') || lowered.includes('session-end')) return 'session-end';
    if (lowered.includes('turn/end') || lowered.includes('turn-end')) return 'turn-end';
    return null;
  }

  function outcomeFromEvidence(evidence, fallback) {
    if (typeof evidence === 'string') {
      const lowered = evidence.toLowerCase();
      if (/cancel|abort|interrupt/.test(lowered)) return 'cancelled';
      if (/fail|error/.test(lowered)) return 'failed';
      if (/complet|success/.test(lowered)) return 'completed';
    }
    return fallback || null;
  }

  // runId validation (review rounds 2+3): a runId supplied with the terminal
  // event must match a verifiable registered relation BEFORE any state moves.
  // A parent may register MULTIPLE children (independent subagent runs) — any
  // of their registered runIds verifies the parent session's end; a wrong
  // runId fails closed with RUN_ID_MISMATCH and a runId without any
  // verifiable relation fails closed with RUN_ID_UNVERIFIED. Sessions without
  // a runId keep the previous compatible semantics.
  function verifyRunId(sessionId, runId) {
    if (runId === undefined || runId === null || runId === '') return { ok: true };
    // child form: this session is itself a registered child run
    const asChild = childSessions.get(sessionId);
    if (asChild) {
      if (asChild.runId === null || asChild.runId === undefined) {
        return { ok: false, code: 'RUN_ID_UNVERIFIED' };
      }
      return asChild.runId === runId ? { ok: true } : { ok: false, code: 'RUN_ID_MISMATCH' };
    }
    // parent form: any registered child run under this parent verifies
    let hasChildren = false;
    let hasRegisteredRun = false;
    for (const record of childSessions.values()) {
      if (record.parentSessionId !== sessionId) continue;
      hasChildren = true;
      if (record.runId !== null && record.runId !== undefined) {
        hasRegisteredRun = true;
        if (record.runId === runId) return { ok: true };
      }
    }
    if (!hasChildren || !hasRegisteredRun) return { ok: false, code: 'RUN_ID_UNVERIFIED' };
    return { ok: false, code: 'RUN_ID_MISMATCH' };
  }

  // Preflight: the matching queue item must be ACTIVE, otherwise queue and
  // binding ledger are desynced and everything fails closed.
  function findActiveQueueItemId(sessionId) {
    for (const seat of seats) {
      const active = queue.activeItem(seat);
      if (active && active.sessionId === sessionId) return active.queueItemId;
    }
    return null;
  }

  // Closes the queue item of a released session through the SAME
  // queue-controller. The queue's atomic switch dispatches the next FIFO
  // head; that head is bound here in the same registry transaction so the
  // queue and the bindings stay consistent (no lost task, no stale seat).
  // Returns the queue's verbatim effects (release-binding ->
  // dispatch-started -> binding-pending | resume-local-behavior).
  function closeQueueItemForSession(sessionId, { evidenceType, outcome, at }) {
    const itemId = findActiveQueueItemId(sessionId);
    if (!itemId) return fail('QUEUE_ITEM_DESYNC', { sessionId });
    const closed = queue.noteTerminalEvidence({ queueItemId: itemId, evidenceType, outcome, nowMs: at });
    if (!closed.ok) return closed;
    const started = closed.effects.find((effect) => effect.type === 'dispatch-started');
    if (started) queuedRunIds.delete(started.sessionId);
    if (started && !bindingsBySession.has(started.sessionId)) {
      const intent = pendingBindingIntent.get(started.sessionId) || {
        bindingSource: 'heuristic',
        confidence: CONFIDENCE_BY_SOURCE.heuristic,
      };
      const nextActive = queue.activeItem(started.employeeId);
      createBinding({
        employeeId: started.employeeId,
        sessionId: started.sessionId,
        bindingSource: intent.bindingSource,
        confidence: intent.confidence,
        at,
        taskSummary: nextActive ? nextActive.taskSummary : '',
      });
      pendingBindingIntent.delete(started.sessionId);
    }
    return closed;
  }

  // Task 7B: terminal evidence for a session that is still WAITING in the
  // FIFO (never dispatched). The queue-controller closes the queued item in
  // place (never dispatches, never takes the seat); the pending binding
  // intent is consumed because the session will never dispatch. RunIds are
  // verified fail closed so a foreign terminal can never close a subagent.
  // Test/diagnostics-only count of live queued identity records (queued run
  // ids + pending binding intents). No ids ever leave the registry.
  function identityLedgerCount() {
    return queuedRunIds.size + pendingBindingIntent.size;
  }
  void consumeQueuedRunId;

  function consumeQueuedRunId(sessionId) {
    queuedRunIds.delete(sessionId);
  }

  function consumeQueuedIdentity(sessionId) {
    queuedRunIds.delete(sessionId);
    pendingBindingIntent.delete(sessionId);
  }

  function retainQueuedTerminal({ sessionId, evidenceType, outcome, runId, nowMs } = {}) {
    if (!TERMINAL_OUTCOMES.includes(outcome)) {
      return fail('INVALID_OUTCOME', { outcome: outcome === undefined ? null : outcome });
    }
    let queued = null;
    for (const seat of seats) {
      for (const item of queue.waitingItems(seat)) {
        if (item.sessionId === sessionId && item.status === 'queued') { queued = item; break; }
      }
      if (queued) break;
    }
    if (!queued) {
      return fail('SESSION_NOT_QUEUED', { sessionId: sessionId ?? null });
    }
    // fail closed: a recorded runId must match the terminal's runId exactly —
    // a missing or empty terminal runId is UNVERIFIED, a different one is a
    // MISMATCH; neither may close the queued subagent.
    const registeredRun = queuedRunIds.get(sessionId);
    if (registeredRun !== undefined) {
      if (runId === undefined || runId === null || runId === '') {
        return fail('RUN_ID_UNVERIFIED', { sessionId, runId: runId ?? null });
      }
      if (runId !== registeredRun) {
        return fail('RUN_ID_MISMATCH', { sessionId, runId: runId ?? null });
      }
    }
    const at = atOrDefault(nowMs);
    let closed;
    if (outcome === 'cancelled') {
      closed = queue.requestCancel({ queueItemId: queued.queueItemId, nowMs: at });
    } else {
      closed = queue.closeQueuedItem({ queueItemId: queued.queueItemId, evidenceType, outcome, nowMs: at });
    }
    if (!closed.ok) return closed;
    consumeQueuedIdentity(sessionId);
    return Object.freeze({
      ok: true,
      closed: true,
      dispatched: false,
      outcome,
      item: closed.item,
      effects: Object.freeze([]),
    });
  }

  function releaseBinding({ sessionId, nowMs, evidence, outcome, resultSummary } = {}) {
    const binding = bindingsBySession.get(sessionId);
    if (!binding || binding.releasedAt !== null) {
      return fail('BINDING_NOT_ACTIVE', { sessionId: sessionId ?? null });
    }
    const evidenceType = evidenceTypeFrom(evidence);
    if (!evidenceType) {
      return fail('TERMINAL_EVIDENCE_REQUIRED', { evidence: evidence === undefined ? null : evidence });
    }
    const at = atOrDefault(nowMs);
    const resolvedOutcome = outcome || outcomeFromEvidence(evidence) || 'completed';
    // Fail-closed preflight: the queue must still hold this session as its
    // active item BEFORE the ledger moves; otherwise report desync.
    const closed = closeQueueItemForSession(sessionId, { evidenceType, outcome: resolvedOutcome, at });
    if (!closed.ok) return closed;
    releaseBindingRecord(binding, at, evidence, resolvedOutcome, resultSummary);
    // The queue's verbatim effects (release-binding -> dispatch-started ->
    // binding-pending | resume-local-behavior) are returned upstream; the
    // registry never fabricates duplicate effects.
    return Object.freeze({ ok: true, binding: freezeBinding(binding), effects: closed.effects });
  }

  // subagent/end: releases only when the stop reason is terminal evidence
  // and (when present) the runId matches a verifiable registered relation.
  function subagentEnd({ sessionId, runId, stopReason, terminalEvidence, nowMs, resultSummary } = {}) {
    const binding = bindingsBySession.get(sessionId);
    if (!binding || binding.releasedAt !== null) {
      return fail('BINDING_NOT_ACTIVE', { sessionId: sessionId ?? null });
    }
    const runIdCheck = verifyRunId(sessionId, runId);
    if (!runIdCheck.ok) {
      return fail(runIdCheck.code, { sessionId, runId: runId ?? null });
    }
    const isTerminal = terminalEvidence === true && TERMINAL_STOP_REASONS.includes(stopReason);
    if (!isTerminal) {
      return Object.freeze({
        ok: true,
        released: false,
        reason: terminalEvidence !== true ? 'TERMINAL_EVIDENCE_REQUIRED' : 'STOP_REASON_NOT_TERMINAL',
        binding: freezeBinding(binding),
        effects: Object.freeze([]),
      });
    }
    const at = atOrDefault(nowMs);
    const resolvedOutcome = outcomeFromEvidence(stopReason) || 'completed';
    // Fail-closed preflight before the ledger moves.
    const closed = closeQueueItemForSession(sessionId, { evidenceType: 'subagent-end', outcome: resolvedOutcome, at });
    if (!closed.ok) return closed;
    releaseBindingRecord(binding, at, `subagent/end:${stopReason}`, resolvedOutcome, resultSummary);
    return Object.freeze({ ok: true, released: true, binding: freezeBinding(binding), effects: closed.effects });
  }

  // A cancel acknowledgement never releases: the binding is retained until
  // terminal evidence arrives.
  function cancelAcknowledged({ sessionId, nowMs } = {}) {
    const binding = bindingsBySession.get(sessionId);
    if (!binding || binding.releasedAt !== null) {
      return fail('BINDING_NOT_ACTIVE', { sessionId: sessionId ?? null });
    }
    return Object.freeze({
      ok: true,
      released: false,
      binding: freezeBinding(binding),
      effects: Object.freeze([Object.freeze({ type: 'awaiting-terminal-evidence', sessionId })]),
    });
  }

  function getBindingForSession(sessionId) {
    const binding = bindingsBySession.get(sessionId);
    return binding ? freezeBinding(binding) : null;
  }

  /** 该员工当前**未释放**的绑定（只读引用，不复制整表）。
   *  2026-09-25（性能专项）：`state()` 每 tick、每员工都要问一次"这个员工绑在哪个
   *  会话"，旧路径走 `snapshot()`——复制并冻结 employees/bindings/childSessions
   *  三张全表；62.5Hz × N 员工 = 每秒数百次全表复制与冻结。这里线性扫绑定表并直接
   *  返回引用（遍历顺序与 snapshot().bindings 一致，语义不变）。 */
  function activeBindingForEmployee(employeeId) {
    for (const binding of bindingsBySession.values()) {
      if (binding && binding.employeeId === employeeId && binding.releasedAt === null) return binding;
    }
    return null;
  }

  function releaseCollaboratorAndAssignNext({ sessionId, evidence, outcome, resultSummary, nowMs } = {}) {
    const binding = bindingsBySession.get(sessionId);
    if (!binding || binding.releasedAt !== null || binding.employeeId !== collaboratorProfile.employeeId) {
      return fail('COLLABORATOR_BINDING_NOT_ACTIVE', { sessionId: sessionId ?? null });
    }
    const evidenceType = evidenceTypeFrom(evidence);
    if (!evidenceType) {
      return fail('TERMINAL_EVIDENCE_REQUIRED', { evidence: evidence === undefined ? null : evidence });
    }
    const at = atOrDefault(nowMs);
    const resolvedOutcome = outcome || outcomeFromEvidence(evidence) || 'completed';
    // Fail-closed preflight before the ledger moves.
    const closed = closeQueueItemForSession(sessionId, { evidenceType, outcome: resolvedOutcome, at });
    if (!closed.ok) return closed;
    releaseBindingRecord(binding, at, evidence, resolvedOutcome, resultSummary);
    const next = queue.activeItem(collaboratorProfile.employeeId);
    return Object.freeze({
      ok: true,
      item: next
        ? Object.freeze({ sessionId: next.sessionId, runId: null, taskSummary: next.taskSummary, requestedAt: next.requestedAt })
        : null,
      binding: freezeBinding(binding),
      // verbatim queue effects: release-binding -> dispatch-started ->
      // binding-pending (the queue's atomic switch already dispatched u-next)
      effects: closed.effects,
    });
  }

  function listEmployees() {
    return Object.freeze(
      [...employees.values()].map((employee) => {
        const active = activeByEmployee.get(employee.employeeId) || null;
        return Object.freeze({
          ...employee,
          // The registry owns bindings only; `activity` belongs to the
          // behavior/reducer layers and is never `offline` here.
          state: Object.freeze({
            binding: active ? 'bound' : 'unbound',
            activity: null,
          }),
        });
      })
    );
  }

  function snapshot() {
    return Object.freeze({
      employees: Object.freeze(
        [...employees.values()].map((employee) => Object.freeze({ ...employee }))
      ),
      bindings: Object.freeze(
        [...bindingsBySession.values()].map((binding) => freezeBinding(binding))
      ),
      childSessions: Object.freeze(
        [...childSessions.values()].map((record) => Object.freeze({ ...record }))
      ),
      classification: Object.freeze(Object.fromEntries(classification)),
      // binding intent metadata only (bindingSource/confidence per waiting
      // session); the queue-controller remains the FIFO fact source
      pendingBindingIntents: Object.freeze(
        Object.fromEntries([...pendingBindingIntent].map(([sessionId, intent]) => [sessionId, Object.freeze({ ...intent })]))
      ),
    });
  }

  return Object.freeze({
    bindSession: Object.freeze(bindSession),
    bindRootSession: Object.freeze(bindRootSession),
    retainQueuedTerminal: Object.freeze(retainQueuedTerminal),
    identityLedgerCount: Object.freeze(identityLedgerCount),
    registerChildSession: Object.freeze(registerChildSession),
    listChildSessions: Object.freeze(listChildSessions),
    getParentOf: Object.freeze(getParentOf),
    registerUnclassifiedSubagent: Object.freeze(registerUnclassifiedSubagent),
    registerClassifiedSubagent: Object.freeze(registerClassifiedSubagent),
    getCollaboratorQueueLength: Object.freeze(getCollaboratorQueueLength),
    peekCollaboratorQueue: Object.freeze(peekCollaboratorQueue),
    assignNextCollaboratorItem: Object.freeze(assignNextCollaboratorItem),
    releaseCollaboratorAndAssignNext: Object.freeze(releaseCollaboratorAndAssignNext),
    subagentEnd: Object.freeze(subagentEnd),
    cancelAcknowledged: Object.freeze(cancelAcknowledged),
    releaseBinding: Object.freeze(releaseBinding),
    getBindingForSession: Object.freeze(getBindingForSession),
    activeBindingForEmployee: Object.freeze(activeBindingForEmployee),
    listEmployees: Object.freeze(listEmployees),
    snapshot: Object.freeze(snapshot),
    // Wiring/verification handle to the SAME queue fact source; the registry
    // itself mutates queue state only through the delegated calls above.
    queueController: queue,
  });
}

module.exports = {
  createEmployeeRegistry,
  BINDING_SOURCES,
  SOURCE_PRIORITY,
  CONFIDENCE_BY_SOURCE,
  ROOT_DEFAULT_EMPLOYEE,
  TERMINAL_STOP_REASONS,
  NON_TERMINAL_EVIDENCE,
};
