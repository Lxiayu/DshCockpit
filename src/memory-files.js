// src/memory-files.js — AGENTS.md memory file management (v0.2.4 C3).
//
// dsh (dsh-agent-instructions) reads workspace instructions from
// <cwd>/AGENTS.md plus the global $DSH_HOME/AGENTS.md when a session starts.
// The shell's editor manages exactly those two files and nothing else:
// writes go through an ArcDesk-style closed whitelist (resolve + compare)
// with atomic tmp+rename, so the settings page can never be talked into
// writing an arbitrary path.
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024; // dsh caps a single source at 1 MiB; allow headroom

/**
 * @param {object} roots
 *   workspaceOf () => current runtime workspace dir
 *   dshHomeOf   () => DSH_HOME root
 */
function createMemoryFiles({ workspaceOf, dshHomeOf }) {
  const paths = () => ({
    project: path.join(workspaceOf(), 'AGENTS.md'),
    global: path.join(dshHomeOf(), 'AGENTS.md'),
  });

  /** Closed whitelist: a path is writable only when it resolves to exactly
   * one of the two managed AGENTS.md files. */
  function isAllowed(p) {
    const list = Object.values(paths());
    let resolved;
    try { resolved = path.resolve(String(p || '')); } catch { return false; }
    return list.some((allowed) => resolved === allowed);
  }

  /** Read one of the two memory files. Missing files are reported (and can
   * be created by save), read errors are surfaced. */
  async function get(scope) {
    if (scope !== 'project' && scope !== 'global') {
      return { ok: false, code: 'scope', reason: 'invalid scope' };
    }
    const file = paths()[scope];
    try {
      const content = await fsp.readFile(file, 'utf8');
      return { ok: true, scope, path: file, exists: true, content };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, scope, path: file, exists: false, content: '' };
      return { ok: false, code: 'read', reason: e.message };
    }
  }

  /** Create/overwrite one of the two memory files (atomic write). */
  async function save(scope, content) {
    if (scope !== 'project' && scope !== 'global') {
      return { ok: false, code: 'scope', reason: 'invalid scope' };
    }
    const file = paths()[scope];
    if (!isAllowed(file)) return { ok: false, code: 'denied', reason: 'path outside whitelist' };
    const text = typeof content === 'string' ? content : '';
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      return { ok: false, code: 'size', reason: 'content too large' };
    }
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, file);
    } catch (e) {
      return { ok: false, code: 'write', reason: e.message };
    }
    return { ok: true, scope, path: file };
  }

  /** Delete one of the two memory files. Only the whitelisted paths are
   * ever unlinked; a missing file is a success (idempotent). */
  async function remove(scope) {
    if (scope !== 'project' && scope !== 'global') {
      return { ok: false, code: 'scope', reason: 'invalid scope' };
    }
    const file = paths()[scope];
    if (!isAllowed(file)) return { ok: false, code: 'denied', reason: 'path outside whitelist' };
    try {
      await fsp.unlink(file);
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, scope, path: file, existed: false };
      return { ok: false, code: 'delete', reason: e.message };
    }
    return { ok: true, scope, path: file, existed: true };
  }

  return { paths, isAllowed, get, save, remove };
}

module.exports = { createMemoryFiles };
