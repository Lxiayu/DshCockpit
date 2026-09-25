# DshCockpit Character State Machine

## Status

Draft for review.

## State dimensions

The runtime never stores all behavior in one enum. It combines these dimensions:

```text
presence: present
sync: healthy | stale | resyncing
runtime: unbound | idle | running | attention | completed | failed
activity: roaming | chatting | resting | sleeping | working | thinking | waiting | celebrating
movement: stationary | moving | arriving | leaving
control: none | dispatchPending | pausePending | resumePending | cancellationPending | preemptPending
binding: unbound | pending | bound | releasing
queue: empty | queued
```

Resident employees always remain `presence=present`. `offline` is not a resident animation or office status. Runtime synchronization problems are represented only by `sync`.

`control`, `binding`, and `queue` are operational dimensions, not additional Runtime facts. A dispatch command starts at `control=dispatchPending` and reserves `binding=pending` (the Session ID may still be null); it becomes `binding=bound` after the first accepted Session event. `cancellationPending` and `preemptPending` remain pending until a corresponding Harness terminal event is accepted. `pausePending` and `resumePending` are reserved vocabulary only: the current Harness public API does not expose a pause/resume pair, so the first UI must not emit these commands unless a versioned adapter capability has been verified. `queue=queued` means work waiting for a seat, not work already running.

## Priority

```text
Runtime fact (running / attention)
  > explicit user control over local presentation
  > completed / failed transient presentation
  > roaming / chatting / resting / sleeping
```

`sync=stale` or `sync=resyncing` does not itself interrupt roaming, chatting, resting, or a bound task presentation. Only a newly accepted Runtime fact or an explicit user command may interrupt local behavior. A bound task with no end event remains represented by its last trusted Runtime activity until it ends, unbinds, or is replaced by a newer session epoch.

User control has a narrower authority than Runtime facts. It may stop a local path, change a target, or request pause/cancel/preemption, but it cannot set `running`, `completed`, `failed`, tool activity, or a result without Runtime evidence. A cancel request enters `control=cancellationPending`, sends a Harness command, and keeps the existing Runtime binding until a terminal cancellation/end event is accepted. A timeout is shown as a control/sync diagnostic; it is not treated as a local completion.

## Transition Controller

Transitions are internal orchestration phases, not new Runtime business states.

```text
roaming
  → stop / turn
  → move to desk
  → arrive
  → sit / work

working
  → completed or failed presentation
  → stand
  → leave desk
  → choose local target

chatting
  → separate
  → move to task target
```

Higher-priority task or user commands may interrupt low-priority transitions. An interrupted transition records its reason and discards stale path and chat reservations.

## Event authority

- Harness events are the only source of Runtime task truth, tool activity, completion, and failure.
- User commands may request dispatch, binding, pause, resume, cancel, or preemption, but cannot invent a result.
- Local clocks may select roaming, chatting, resting, sleeping, and animation progression only.
- Window lifecycle may pause and resume simulation and rendering only.

## Runtime event consistency

The Office State Adapter converts each raw Harness message into this canonical envelope before it reaches the state machine:

```json
{
  "eventId": "evt-...",
  "sessionId": "session-...",
  "sessionEpoch": "epoch-...",
  "sequence": 17,
  "eventType": "tool/call",
  "payload": {},
  "sequenceSource": "upstream | adapter",
  "receivedAt": "2026-08-30T00:00:00.000Z"
}
```

Field rules:

- The current Harness event envelope has no global event ID. Derive a stable SHA-256 fingerprint from `sessionEpoch`, `sessionId`, the upstream `seq` when present, `eventType`, and canonical JSON payload; mark the resulting `eventId` as adapter-derived. When the upstream has no sequence, derive the duplicate fingerprint before assigning a per-session ingress sequence; identical fingerprints received within the adapter's duplicate window are ignored.
- Use the Harness `seq` as the Session-local monotonic sequence when present. Otherwise use an adapter counter scoped to `(sessionId, sessionEpoch)`; adapter counters are not compared across sessions.
- The current Harness Session event does not carry a runtime epoch. The adapter creates a new epoch at each runtime connection and increments it on a detected restart/reconnect. A persisted binding snapshot never authorizes an old epoch by itself.

Sequence handling is deliberately conservative. An event with `sequence=last+1` is applied immediately. A forward gap is buffered (maximum 64 events or 2 seconds), `sync` becomes `resyncing`, and the adapter requests a Runtime snapshot. A snapshot establishes a new contiguous baseline and replays only matching buffered events. If the request times out, the buffer is discarded, `sync` becomes `stale`, and no guessed intermediate state is emitted; the next accepted snapshot or new epoch returns `sync=healthy`.

The snapshot request/response is:

```json
{
  "type": "office:runtime-resync-request",
  "sessionId": "session-...",
  "sessionEpoch": "epoch-...",
  "fromSequence": 12,
  "requestId": "resync-..."
}
```

```json
{
  "type": "office:runtime-snapshot",
  "requestId": "resync-...",
  "sessionId": "session-...",
  "sessionEpoch": "epoch-...",
  "sequence": 15,
  "facts": { "runtime": "running", "taskId": "task-...", "tool": null },
  "eventsSince": []
}
```

The response is accepted only when `requestId`, `sessionId`, and `sessionEpoch` match the pending request. `eventsSince` entries must belong to the same epoch and have strictly increasing sequences greater than the snapshot sequence; otherwise they are discarded and another resync is requested with exponential backoff (250 ms, 500 ms, 1 s, capped at 5 s). A newer epoch always wins: it clears the old buffer, pending request, and event-ID set before establishing its baseline. The event-ID dedupe set is a bounded LRU of 4096 IDs per `(sessionId, sessionEpoch)` with a 10-minute TTL; the sequence watermark remains authoritative for older duplicates.

- Duplicate `eventId` is idempotently ignored.
- An event with a sequence not newer than the last accepted sequence for that Session is ignored.
- Events from an old `sessionEpoch` cannot mutate a new binding.
- Ignored events may enter diagnostics but never trigger animation, movement, or duplicate activity logs.

### Runtime mapping

| Accepted Runtime evidence | `runtime` / reason | Local activity effect |
| --- | --- | --- |
| session/turn start, agent running | `running` | interrupt local behavior and route to desk |
| tool call, progress, model thinking | `running`, `reason=tool` or `thinking` | working/thinking presentation while bound |
| agent waiting for user/input | `running`, `reason=waiting` | waiting presentation; binding remains |
| blocked/error needing intervention | `attention`, `reason=blocked/error` | attention presentation; no local sleep |
| terminal completed | `completed`, `reason=completed` | result presentation, then release/queue |
| terminal failed | `failed`, `reason=failed` | result presentation, then release/queue |
| session end/cancel confirmed | terminal fact plus binding release | return to queue or local behavior |

`blocked` is a reason under `attention`, not a separate top-level Runtime state. A tool error is `attention` when the session remains recoverable or awaits intervention; it becomes `failed` only when Harness emits a terminal failure/end reason. `thinking` and `waiting` are activity/substate mappings and never imply completion.

### Control, binding, and queue transitions

| Input | Immediate office transition | Confirmation / next step |
| --- | --- | --- |
| user dispatch to free employee | `control=dispatchPending`, `binding=pending` | bind on Session ID, then route to desk |
| user dispatch to busy employee | `queue=queued` | FIFO item waits; current binding is unchanged |
| user pause | unsupported in current Harness contract | hide/disable the control; do not create a paused Runtime fact |
| user resume | unsupported without a verified pause capability | hide/disable the control; `followup`/`steer` remain distinct inputs |
| user cancel | `control=cancellationPending` | retain binding until root `turn/end` with `aborted` cause, child `subagent/end`, or equivalent terminal evidence; the cancel API acknowledgement alone is not quiescence |
| user preempt | `control=preemptPending` | Office queue policy sends cancel/interrupt; next task cannot start until terminal acknowledgement |
| terminal completed/failed | `runtime=completed/failed`, `binding=releasing` | result presentation, then FIFO queue or local behavior |

`cancelled` is a historical terminal result/reason, not a new top-level Runtime state. A collaborator uses the same dimensions and queue contract; its single binding is atomically released before the next FIFO item is assigned, so one Session cannot appear in both a resident and collaborator binding.

Queue items use this minimum schema and are owned by the selected employee or the single collaborator seat:

```json
{
  "queueItemId": "queue-...",
  "requestedAt": "2026-08-30T00:00:00.000Z",
  "requestedBy": "user | runtime",
  "employeeId": "coder",
  "sessionId": null,
  "taskSummary": "...",
  "priority": "normal | urgent",
  "status": "queued | binding | running | terminal | cancelled"
}
```

An idle direct dispatch creates the item and `binding=pending` in one reducer transaction; a busy dispatch only appends `status=queued`. Urgent dispatch may preempt a result presentation but still waits for Harness cancellation before the old Session is released. The collaborator queue is FIFO across all unclassified Sessions, and assignment plus removal of the head item is atomic. A Session ID is globally indexed so it cannot be bound to two seats.

The reducer must consult a versioned adapter capability set before rendering any control. In the current baseline, `cancel`, `interrupt`, `followup`, `steer`, and `inject` are supported mappings; `pause`, `resume`, and native `preempt` are unsupported. A future runtime may add a capability, but the UI and state transitions must remain disabled until the adapter has proved the corresponding RPC and acknowledgement event for that runtime version.

## Sleep

After five continuous minutes without a task, an idle resident may enter `activity=sleeping` and return to its personal desk by default. The threshold is user-adjustable in settings. Sleep is local behavior and is immediately interruptible by a task or explicit command.

## Result presentation

`completed` and `failed` facts remain in history and the details panel. On an accepted terminal event, the current Runtime binding is marked releasing and the terminal fact is latched as `lastResult`; the old Session is no longer allowed to mutate the employee. The result presentation then runs for up to five seconds (user-adjustable). If a FIFO queue exists, the next task starts after this presentation; an explicit urgent dispatch may preempt it. The same rule applies to completed and failed results, so a failed task does not silently discard queued work. When the queue is empty, the employee returns to local behavior after the transition.

The short-lived visual `runtime=completed|failed` view may therefore coexist with `binding=releasing` or `binding=unbound`; the binding field is operational metadata, while the terminal fact remains historical UI data. A new accepted task replaces the transient presentation but never rewrites the stored result.

## Required invariants

- No local behavior produces `running`, `completed`, `failed`, or tool-call facts.
- No animation frame changes logical position or Runtime state.
- No status refresh destroys a character node or resets its movement progress.
- A task ending with an empty queue releases the binding and returns the employee to local behavior after its result transition.
- A user cancel request cannot release a binding until Harness confirms cancellation or termination.
