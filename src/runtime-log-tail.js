// src/runtime-log-tail.js — incremental log-file tailing for the boot URL
// poller (extracted from spawnRuntime so the byte-offset bookkeeping is unit
// testable — the v0.2.8 field incident: destructuring fs.readSync's NUMBER
// return yielded undefined, poisoned the offset with NaN, and every size
// comparison silently went false → the boot window span forever).
//
// Hardening contract:
//   - poll() NEVER throws and ALWAYS returns a string (possibly '')
//   - a non-finite internal offset self-heals to 0 (re-read from start)
//   - file truncation (size < offset) restarts at 0 instead of stalling
//   - fs.readSync's return is normalized whether it is a plain byte count
//     (current Node) or an object shape ({ bytesRead }) some day is not
'use strict';

const fs = require('node:fs');

/**
 * @param {string} filePath
 * @param {object} [deps] injectable for tests
 * @param {(fd: number, buf: Buffer, off: number, len: number, pos: number) => number|{bytesRead?:number}} [deps.readSyncFn]
 * @returns {{ poll: () => string, reset: () => void }}
 */
function createRuntimeLogTailer(filePath, { readSyncFn } = {}) {
  const doRead = readSyncFn || ((fd, buf, off, len, pos) => fs.readSync(fd, buf, off, len, pos));
  let offset = 0;

  /** Normalize both known fs.readSync return shapes into a finite byte count. */
  function normalizeBytesRead(ret) {
    if (typeof ret === 'number') return ret;
    if (ret && typeof ret === 'object' && Number.isFinite(ret.bytesRead)) return ret.bytesRead;
    return 0; // unknown shape → treat as "nothing read", retry next tick
  }

  return {
    /** Read only bytes appended since the last call; '' when nothing new,
     * unreadable yet, or on any error (caller just retries next tick). */
    poll() {
      let st;
      try { st = fs.statSync(filePath); } catch { return ''; }
      if (!Number.isFinite(st.size) || st.size < 0) return '';
      // truncation / rewrite → restart from zero rather than stall forever
      if (!Number.isFinite(offset) || offset < 0 || st.size < offset) offset = 0;
      if (st.size === offset) return ''; // no new bytes since last poll
      try {
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        let fd = -1;
        try {
          fd = fs.openSync(filePath, 'r');
          const bytesRead = normalizeBytesRead(doRead(fd, buf, 0, len, offset));
          if (!(Number.isFinite(bytesRead) && bytesRead > 0)) return ''; // nothing consumed; retry next tick
          offset += bytesRead;
          return buf.toString('utf8', 0, bytesRead);
        } finally {
          if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
        }
      } catch {
        return '';
      }
    },

    /** Forget consumed state (next poll re-reads the whole file). */
    reset() { offset = 0; },
  };
}

module.exports = { createRuntimeLogTailer };
