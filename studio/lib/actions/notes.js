'use strict';

// studio/lib/actions/notes.js — frame-anchored review notes (帧号锚定批注).
//
// Storage choice: a SIDECAR file next to the action doc —
//   content/characters/<id>/actions/<actionId>.notes.json
// Reason: the action doc stays a clean publishable contract (and the pack
// validator stays untouched), the notes survive publish round trips, and a note
// always names the ACTION + FRAME INDEX it was written against, so reordering
// frames makes a stale note visible instead of silent.
//
// Shape:
//   { schemaVersion: 1, actionId, notes: [ { id, frame, file, severity, text, createdAt, resolved? } ] }

const path = require('node:path');
const fs = require('node:fs');

const NOTES_SCHEMA_VERSION = 1;
const SEVERITIES = ['note', 'fix', 'praise'];

function notesFileFor(actionsDir, actionId) {
  return path.join(actionsDir, `${actionId}.notes.json`);
}

function readNotes({ actionsDir, actionId }) {
  const file = notesFileFor(actionsDir, actionId);
  if (!fs.existsSync(file)) return { ok: true, file, exists: false, doc: { schemaVersion: NOTES_SCHEMA_VERSION, actionId, notes: [] } };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.schemaVersion !== NOTES_SCHEMA_VERSION || !Array.isArray(parsed.notes)) {
      return { ok: false, code: 'NOTES_INVALID', file, message: 'notes file schema is not recognised' };
    }
    return { ok: true, file, exists: true, doc: parsed };
  } catch (error) {
    return { ok: false, code: 'NOTES_UNPARSEABLE', file, message: error.message };
  }
}

function writeNotes({ actionsDir, actionId, doc }) {
  const file = notesFileFor(actionsDir, actionId);
  fs.mkdirSync(actionsDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { ok: true, file };
}

function addNote({ actionsDir, actionId, frame, file, severity = 'note', text, now = () => new Date().toISOString() }) {
  if (!Number.isInteger(frame) || frame < 0) return { ok: false, code: 'NOTE_FRAME_INVALID', message: 'frame must be a non-negative metadata index (帧号锚定)' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'NOTE_TEXT_REQUIRED', message: 'text is required' };
  if (!SEVERITIES.includes(severity)) return { ok: false, code: 'NOTE_SEVERITY_INVALID', message: `severity must be one of ${SEVERITIES.join('|')}` };
  const loaded = readNotes({ actionsDir, actionId });
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  const note = {
    id: `n-${String(doc.notes.length + 1).padStart(3, '0')}`,
    frame,
    file: file || null,
    severity,
    text: text.trim(),
    createdAt: now(),
  };
  doc.notes.push(note);
  const written = writeNotes({ actionsDir, actionId, doc });
  return { ok: true, note, file: written.file, total: doc.notes.length };
}

function resolveNote({ actionsDir, actionId, noteId, resolved = true }) {
  const loaded = readNotes({ actionsDir, actionId });
  if (!loaded.ok) return loaded;
  const note = loaded.doc.notes.find((entry) => entry.id === noteId);
  if (!note) return { ok: false, code: 'NOTE_NOT_FOUND', message: `no note ${noteId}` };
  note.resolved = Boolean(resolved);
  const written = writeNotes({ actionsDir, actionId, doc: loaded.doc });
  return { ok: true, note, file: written.file };
}

// Notes carry the frame index AND (when known) the file that index pointed at, so
// a reorder can be detected: `stale` means the file no longer sits at that index.
function listNotes({ actionsDir, actionId, frames = null }) {
  const loaded = readNotes({ actionsDir, actionId });
  if (!loaded.ok) return loaded;
  const notes = loaded.doc.notes.map((note) => {
    const currentFile = frames && frames[note.frame] ? frames[note.frame].file : null;
    const stale = Boolean(note.file && currentFile && note.file !== currentFile);
    return { ...note, currentFile, stale, outOfRange: frames ? note.frame >= frames.length : false };
  });
  return { ok: true, file: loaded.file, exists: loaded.exists, notes, open: notes.filter((note) => !note.resolved).length, stale: notes.filter((note) => note.stale || note.outOfRange).length };
}

// The exported form is what a reviewer hands over (or what a future task queue
// consumes): the action summary + the notes + the frame mapping they refer to.
function exportNotes({ actionsDir, actionId, frames = [], summary = null }) {
  const listed = listNotes({ actionsDir, actionId, frames });
  if (!listed.ok) return listed;
  return {
    ok: true,
    schemaVersion: NOTES_SCHEMA_VERSION,
    actionId,
    exportedAt: new Date().toISOString(),
    summary,
    frames: frames.map((frame, index) => ({ index, file: frame.file, durationMs: frame.durationMs ?? null })),
    notes: listed.notes,
  };
}

module.exports = {
  NOTES_SCHEMA_VERSION,
  SEVERITIES,
  addNote,
  exportNotes,
  listNotes,
  notesFileFor,
  readNotes,
  resolveNote,
  writeNotes,
};
