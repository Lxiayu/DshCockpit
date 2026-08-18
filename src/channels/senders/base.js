// src/channels/senders/base.js — outbound sender interface (C5 skeleton).
//
// A channel implementation (C6: feishu/wecom/dingtalk) provides a TRANSPORT
// with the platform dialect isolated inside it:
//
//   transport = {
//     supportsCards: boolean,             // false → sender falls back to text
//     async sendText(text),               // plain message
//     async sendCard({ title, body, actions }),  // interactive card
//   }
//
// This module binds transports to the shared formatter: one `sendEvent` that
// formats (card+text templates) and delivers through whatever the transport
// supports. Transport errors propagate to the caller (channel-manager) which
// owns the offline queue / reconnect state machine.
'use strict';

const { formatEvent } = require('../formatter');

/**
 * Build a sender over a channel transport.
 * @param {{ supportsCards?: boolean, sendText: (text: string) => Promise, sendCard: (card: object) => Promise }} transport
 * @returns {{ sendEvent(lang: string, event: object): Promise<'card'|'text'> }}
 */
function createSender(transport) {
  if (!transport || typeof transport.sendText !== 'function') {
    throw new Error('channel transport must implement sendText()');
  }
  const supportsCards = !!transport.supportsCards && typeof transport.sendCard === 'function';
  return {
    async sendEvent(lang, event) {
      const formatted = formatEvent(lang, event);
      if (supportsCards) {
        await transport.sendCard(formatted.card);
        return 'card';
      }
      await transport.sendText(formatted.text);
      return 'text';
    },
  };
}

module.exports = { createSender };
