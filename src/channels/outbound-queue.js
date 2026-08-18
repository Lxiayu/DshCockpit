// src/channels/outbound-queue.js — offline queue for channel broadcasts.
//
// Policy (C5): while a channel is offline, `taskDone` events queue for
// replay after reconnect (bounded ring of the most recent N=10); approval /
// question events carry one-shot tokens with a 120s TTL, so queueing them
// would only deliver dead buttons — they are DROPPED and audited instead.
'use strict';

const DEFAULT_MAX_QUEUED = 10;
const TRANSIENT_KINDS = new Set(['approval', 'question']); // never queued

class OutboundQueue {
  /**
   * @param {{ max?: number, audit?: (rec: object) => void }} opts
   *        audit receives `{ action:'drop'|'queue-overflow', kind }` records —
   *        event kinds only, never card payloads or tokens.
   */
  constructor(opts = {}) {
    this.max = Number(opts.max) > 0 ? Number(opts.max) : DEFAULT_MAX_QUEUED;
    this.audit = opts.audit || (() => {});
    this.items = [];
    this.droppedCount = 0;
  }

  /**
   * @param {{ kind: string }} event broadcast event
   * @returns {'queued' | 'dropped'} disposition for the caller's log
   */
  push(event) {
    const kind = event && event.kind;
    if (TRANSIENT_KINDS.has(kind)) {
      this.droppedCount += 1;
      this.audit({ action: 'drop', reason: 'channel-offline', kind });
      return 'dropped';
    }
    this.items.push(event);
    while (this.items.length > this.max) {
      const evicted = this.items.shift();
      this.audit({ action: 'queue-overflow', reason: 'max-exceeded', kind: evicted.kind });
    }
    return 'queued';
  }

  /**
   * Replay the backlog through `sendFn` (oldest first). A failed send stops
   * the drain so the event stays queued for the next reconnect attempt.
   * @returns {number} how many events were delivered
   */
  async drain(sendFn) {
    let sent = 0;
    while (this.items.length) {
      const event = this.items[0];
      try {
        await sendFn(event);
      } catch {
        break; // still offline: keep the remainder for the next drain
      }
      this.items.shift();
      sent += 1;
    }
    return sent;
  }

  get size() { return this.items.length; }

  clear() { this.items = []; }
}

module.exports = { OutboundQueue, DEFAULT_MAX_QUEUED };
