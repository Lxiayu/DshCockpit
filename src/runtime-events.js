// src/runtime-events.js — consume the runtime's event WebSockets from the shell.
//
// The browser surface receives events over `ws://<host>/api/events.host` and
// `/api/events.mux`; each message is ONE JSON frame (string payload). We use:
//   - events.host: `host/session-status { running }`  -> task done signal
//   - events.mux:  `approval/requested`, `question/requested` -> pending UX
// Failure is silent (notifications are best-effort, never a dependency).
'use strict';

/**
 * Open one runtime event WebSocket.
 * @param {string} baseUrl e.g. http://127.0.0.1:4099
 * @param {string} path e.g. /api/events.host
 * @param {(frame: object) => void} onFrame
 * @param {(err: Error) => void} onError
 * @returns {{ close(): void }}
 */
function connectEvents(baseUrl, path, onFrame, onError, options = {}) {
  const wsUrl = baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + path;
  const headers = options.headers && Object.keys(options.headers).length ? options.headers : null;
  let closed = false;
  let socket = null;
  try {
    if (headers) {
      // 0.1.5 起事件面（/api/remote.mux）要求浏览器会话 Cookie；全局 WebSocket
      // 无法自定义头，因此带 headers 时用 `ws` 包（Electron 主进程可用）。
      const { WebSocket: NodeWebSocket } = require('ws');
      socket = new NodeWebSocket(wsUrl, { headers });
    } else {
      socket = new WebSocket(wsUrl);
    }
  } catch (e) {
    if (onError) onError(e instanceof Error ? e : new Error(String(e)));
    return { close: () => {} };
  }
  socket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      onFrame(JSON.parse(ev.data));
    } catch { /* malformed frame: skip */ }
  };
  socket.onerror = () => { if (onError && !closed) onError(new Error(`websocket error (${path})`)); };
  socket.onclose = () => { if (onError && !closed) onError(new Error(`websocket closed (${path})`)); };
  return {
    close: () => {
      closed = true;
      try { if (socket) socket.close(); } catch { /* ignore */ }
    },
  };
}

module.exports = { connectEvents };
