'use strict';

// src/office/runtime/tool-phrases.js — shared tool-name vocabulary.
//
// One module, three consumers, so the office panel, the office pending cards
// and the journal ingestion can never drift apart:
//   1. `toolNameOfJournalData()` — the M5 extraction from the 0.1.5 journal
//      `tool/call` record (`data.name`, with the pre-0.1.5 `data.tool` name
//      accepted). main.js previously inlined this; it now delegates here.
//   2. `toolPhraseKeyOf()` — tool name → phrase key, rendered through the spec
//      §6 i18n family `office.staff.currentTool.*` (zh/en dictionaries carry
//      identical key sets; see src/i18n.js).
//   3. `toolPhraseZhOf()` — the same phrase as a zh string, used by the office
//      `pending` snapshot block (spec §4: summary = 一句话摘要（工具名/意图）;
//      the office snapshot already carries Chinese presentation strings such
//      as taskLabel '执行任务中', so the phrase follows that convention).
//
// Pure deterministic CommonJS: ZERO dependencies (no Electron, no i18n, no
// DOM, no IO). The zh phrase text the office snapshot needs lives HERE as a
// frozen runtime vocabulary table; the matching i18n keys (`TOOL_PHRASE_I18N_KEY`)
// stay the UI's per-language source of truth, and src/i18n.js keeps its full
// `office.staff.currentTool.*` family untouched for the panel.
//
// Why the zh text is a local table instead of `require('../../i18n.js')`:
// requiring the shell dictionary made this pure module statically reach
// Electron (i18n.js lazily requires it), which broke the "no UI shell in the
// kernel" boundary (contract §17-1). Only the nine runtime phrases are mirrored
// — never the whole UI dictionary — and
// test/office-right-panel-p1.test.js pins them equal to the zh dictionary, so
// the two can never drift.

// Phrase vocabulary. The six §6 categories (typing / search / retrieval /
// terminal / browse / other) plus the three the office pending summary needs:
// §5's low row is dominated by `ask_user_question` (approval requests
// naturally concentrate in medium/high), a command phrase for the generic
// exec tools, and an edit phrase for workspace writes.
const PHRASE_KEYS = Object.freeze([
  'typing', 'search', 'retrieval', 'terminal', 'command', 'edit', 'browse',
  'asking', 'other',
]);

// Phrase key → i18n key (spec §6 family). Frozen so the dictionaries and the
// snapshot contract cannot diverge silently.
const TOOL_PHRASE_I18N_KEY = Object.freeze(Object.fromEntries(
  PHRASE_KEYS.map((key) => [key, `office.staff.currentTool.${key}`])
));

// Phrase key → zh text. This IS the office snapshot's presentation vocabulary
// (the snapshot already carries zh strings such as taskLabel '执行任务中').
// Values must stay identical to src/i18n.js `STRINGS.zh[office.staff.currentTool.*]`;
// the drift pin lives in test/office-right-panel-p1.test.js (which may require
// the shell dictionary — a pure kernel module may not).
const PHRASE_ZH = Object.freeze({
  typing: '打字',
  search: '查档案',
  retrieval: '检索',
  terminal: '终端',
  command: '执行命令',
  edit: '编辑文件',
  browse: '浏览',
  asking: '等待你回答',
  other: '其他',
});

// Tool name → phrase key. Matching is exact and lowercase; anything unknown
// falls back to 'other' (the table never invents a phrase).
const PHRASE_KEY_BY_TOOL = new Map([
  // generic command execution (spec §5 medium: sandboxed execution)
  ['bash', 'command'], ['shell', 'command'], ['sh', 'command'], ['zsh', 'command'],
  ['fish', 'command'], ['powershell', 'command'], ['pwsh', 'command'], ['cmd', 'command'],
  ['exec', 'command'], ['execute', 'command'], ['terminal', 'command'], ['run', 'command'],
  ['process', 'command'], ['spawn', 'command'], ['command', 'command'], ['eval', 'command'],
  ['git', 'command'],
  // Tools literally named after a shell command (wrapper/MCP tools, and the
  // approval-risk high-risk list) are command executions for display purposes:
  // the panel must not fall back to "其他" for `rm` / `sudo` / `npm` …
  ['rm', 'command'], ['rmdir', 'command'], ['unlink', 'command'], ['shred', 'command'],
  ['delete', 'command'], ['remove', 'command'],
  ['sudo', 'command'], ['su', 'command'], ['doas', 'command'],
  ['npm', 'command'], ['pnpm', 'command'], ['yarn', 'command'], ['pip', 'command'],
  ['pip3', 'command'], ['poetry', 'command'], ['conda', 'command'], ['cargo', 'command'],
  ['gem', 'command'], ['brew', 'command'], ['apt', 'command'], ['apt-get', 'command'],
  ['dnf', 'command'], ['apk', 'command'], ['composer', 'command'], ['install', 'command'],
  ['add', 'command'],
  ['psql', 'command'], ['mysql', 'command'], ['mongo', 'command'], ['mongosh', 'command'],
  ['sqlite3', 'command'], ['kubectl', 'command'], ['helm', 'command'], ['aws', 'command'],
  ['gcloud', 'command'], ['az', 'command'], ['terraform', 'command'], ['oci', 'command'],
  ['flyctl', 'command'], ['heroku', 'command'],
  // workspace writes
  ['edit', 'edit'], ['write', 'edit'], ['apply-patch', 'edit'], ['apply_patch', 'edit'],
  ['patch', 'edit'], ['multi-edit', 'edit'], ['multi_edit', 'edit'], ['notebook-edit', 'edit'],
  ['notebook_edit', 'edit'], ['str-replace', 'edit'], ['str_replace', 'edit'],
  ['create-file', 'edit'], ['create_file', 'edit'], ['update-file', 'edit'],
  ['update_file', 'edit'], ['replace', 'edit'], ['save', 'edit'],
  // file / code search ("查档案")
  ['read', 'search'], ['readfile', 'search'], ['read_file', 'search'], ['view', 'search'],
  ['cat', 'search'], ['open', 'search'], ['ls', 'search'], ['dir', 'search'],
  ['glob', 'search'], ['grep', 'search'], ['rg', 'search'], ['find', 'search'],
  ['fs-search', 'search'], ['fs_search', 'search'], ['code-search', 'search'],
  ['code_search', 'search'], ['file-search', 'search'], ['file_search', 'search'],
  ['search', 'search'], ['list', 'search'], ['tree', 'search'],
  // web search ("检索")
  ['web-search', 'retrieval'], ['websearch', 'retrieval'], ['web_search', 'retrieval'],
  ['search-web', 'retrieval'], ['google', 'retrieval'], ['bing', 'retrieval'],
  // web fetch / browser ("浏览")
  ['web-fetch', 'browse'], ['webfetch', 'browse'], ['fetch', 'browse'],
  ['browse', 'browse'], ['browser', 'browse'], ['browser-use', 'browse'],
  ['url', 'browse'],
  // ask-user questions ("等待你回答")
  ['ask_user_question', 'asking'], ['ask-user', 'asking'], ['askuserquestion', 'asking'],
  ['ask-user-question', 'asking'], ['question', 'asking'], ['user-questions/request', 'asking'],
  // chat-ish tools ("打字")
  ['chat', 'typing'], ['message', 'typing'], ['prompt', 'typing'], ['compose', 'typing'],
  ['quickask', 'typing'], ['ask', 'typing'],
]);

const FALLBACK_PHRASE_KEY = 'other';

/** M5 journal extraction: 0.1.5 names the tool under `data.name`; the pre-0.1.5
 * wire used `data.tool`. Returns null when neither is a non-empty string. */
function toolNameOfJournalData(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.name === 'string' && data.name !== '') return data.name;
  if (typeof data.tool === 'string' && data.tool !== '') return data.tool;
  return null;
}

/** Tool name → phrase key (one of PHRASE_KEYS). */
function toolPhraseKeyOf(toolName) {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (!name) return FALLBACK_PHRASE_KEY;
  return PHRASE_KEY_BY_TOOL.get(name) || FALLBACK_PHRASE_KEY;
}

/** Tool name → i18n key for the phrase (spec §6 family). */
function toolPhraseI18nKeyOf(toolName) {
  return TOOL_PHRASE_I18N_KEY[toolPhraseKeyOf(toolName)];
}

/** Tool name → zh phrase string (snapshot-layer summary; see module header). */
function toolPhraseZhOf(toolName) {
  return PHRASE_ZH[toolPhraseKeyOf(toolName)] || PHRASE_ZH[FALLBACK_PHRASE_KEY];
}

/** Question pending summary (no runtime text ever reaches the snapshot). */
function questionSummaryZh() {
  return PHRASE_ZH.asking;
}

module.exports = {
  PHRASE_KEYS,
  PHRASE_ZH,
  TOOL_PHRASE_I18N_KEY,
  FALLBACK_PHRASE_KEY,
  toolNameOfJournalData,
  toolPhraseKeyOf,
  toolPhraseI18nKeyOf,
  toolPhraseZhOf,
  questionSummaryZh,
};
