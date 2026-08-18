// src/channels/formatter.js — runtime event → IM message formatter (C5).
//
// One formatter per event kind, each producing BOTH shapes so any channel can
// pick what its platform supports (senders/base.js decides card vs text):
//   card: { title, body, actions: [{ id, label, token }] } — interactive
//         platforms (Feishu cards, WeCom template cards, DingTalk callbacks)
//   text: single plain-text message with reply-instruction fallback for
//         text-only channels (group webhooks), mirroring the approval UX of
//         the dsh Telegram-bridge ecosystem.
// Pure functions over i18n — unit-testable with zero channels connected.
'use strict';

const { t } = require('../i18n');

const TTL_SECONDS = 120;

/** { kind: 'taskDone' } */
function formatTaskDone(lang) {
  return {
    card: {
      title: t(lang, 'channels.msg.taskDoneTitle'),
      body: t(lang, 'channels.msg.taskDoneBody'),
      actions: [],
    },
    text: `✅ ${t(lang, 'channels.msg.taskDoneTitle')} — ${t(lang, 'channels.msg.taskDoneBody')}`,
  };
}

/** { kind: 'approval', tool, token } */
function formatApprovalRequest(lang, ev) {
  const tool = String((ev && ev.tool) || '');
  return {
    card: {
      title: t(lang, 'channels.msg.approvalTitle'),
      body: t(lang, 'channels.msg.approvalBody', { tool, sec: TTL_SECONDS }),
      actions: [
        { id: 'approve', label: t(lang, 'channels.msg.approve'), token: ev.token },
        { id: 'deny', label: t(lang, 'channels.msg.deny'), token: ev.token },
      ],
    },
    text: t(lang, 'channels.msg.approvalText', { tool, token: ev.token, sec: TTL_SECONDS }),
  };
}

/** { kind: 'question', question, token } */
function formatQuestion(lang, ev) {
  const question = String((ev && ev.question) || '');
  return {
    card: {
      title: t(lang, 'channels.msg.questionTitle'),
      body: question || t(lang, 'channels.msg.questionBody'),
      actions: [
        { id: 'answer', label: t(lang, 'channels.msg.reply'), token: ev.token },
      ],
    },
    text: t(lang, 'channels.msg.questionText', { question, token: ev.token, sec: TTL_SECONDS }),
  };
}

/** Dispatch an event to its formatter; throws on an unknown kind (caller bug). */
function formatEvent(lang, event) {
  switch (event && event.kind) {
    case 'taskDone': return formatTaskDone(lang);
    case 'approval': return formatApprovalRequest(lang, event);
    case 'question': return formatQuestion(lang, event);
    default: throw new Error(`unknown channel event kind: ${event && event.kind}`);
  }
}

module.exports = { formatEvent, formatTaskDone, formatApprovalRequest, formatQuestion, TTL_SECONDS };
