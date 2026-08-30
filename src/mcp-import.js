// src/mcp-import.js — universal MCP config importer (T1, v0.3.1).
//
// Every mainstream client stores servers in the same `{ mcpServers: { name:
// { command, args, env, url?, type? } } }` shape (Claude Desktop / Claude Code
// / VS Code / Cursor), so one normalizer covers them all. Imported env values
// are treated as secrets: they land in the shell vault via the caller, never
// in settings.json. Name conflicts get a `_1` suffix (same behaviour as
// `claude mcp add-from-claude-desktop`).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID_SLUG_RE = /[^a-z0-9-]+/g;

function slug(name) {
  return String(name || 'server').toLowerCase().replace(ID_SLUG_RE, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'server';
}

function firstExisting(candidates) {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function readJsonTolerant(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    try { return { json: JSON.parse(text) }; } catch { /* JSONC-ish → strip comments */ }
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    return { json: JSON.parse(stripped) };
  } catch (e) {
    return { error: e.message };
  }
}

function claudeDesktopFile() {
  if (process.platform === 'win32') {
    return firstExisting([
      process.env.APPDATA && path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'),
    ].filter(Boolean));
  }
  if (process.platform === 'darwin') {
    return firstExisting([path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]);
  }
  return firstExisting([path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')]);
}

function vscodeUserFile() {
  if (process.platform === 'win32') {
    return firstExisting([
      process.env.APPDATA && path.join(process.env.APPDATA, 'Code', 'User', 'mcp.json'),
    ].filter(Boolean));
  }
  if (process.platform === 'darwin') {
    return firstExisting([path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json')]);
  }
  return firstExisting([path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json')]);
}

function cursorFile() {
  return firstExisting([path.join(os.homedir(), '.cursor', 'mcp.json')]);
}

function claudeCodeFile() {
  return firstExisting([path.join(os.homedir(), '.claude.json')]);
}

/** Known sources with their file locations (probed on demand, never at boot). */
const SOURCES = [
  { key: 'claude-desktop', label: 'Claude Desktop', file: claudeDesktopFile },
  { key: 'claude-code', label: 'Claude Code (~/.claude.json)', file: claudeCodeFile },
  { key: 'vscode', label: 'VS Code (User mcp.json)', file: vscodeUserFile },
  { key: 'cursor', label: 'Cursor (~/.cursor/mcp.json)', file: cursorFile },
  { key: 'clipboard', label: 'JSON 粘贴', file: null },
];

/** Extract the `mcpServers` map from whatever wrapper the client uses. */
function extractMap(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.mcpServers && typeof json.mcpServers === 'object') return json.mcpServers;
  if (json.mcp && json.mcp.servers && typeof json.mcp.servers === 'object') return json.mcp.servers;
  if (json.servers && typeof json.servers === 'object') return json.servers;
  return null;
}

/**
 * Normalize one client entry into the shell's server record (modulo id/name
 * conflict suffixes applied by the caller). All env values are marked secret;
 * the caller routes them to the vault.
 */
function normalizeEntry(name, cfg) {
  if (!cfg || typeof cfg !== 'object') return { err: 'entry is not an object' };
  const serverName = slug(name);
  if (!cfg.command && !cfg.url) return { err: 'neither command nor url present' };
  const remote = !!cfg.url || cfg.type === 'http' || cfg.type === 'sse' || cfg.type === 'streamable-http' || cfg.type === 'websocket';
  const base = {
    name: String(name).slice(0, 64),
    serverName,
    // websocket is preserved (DSH client distinguishes it); http/streamable
    // map to sse — the closest DSH-native remote transport
    transport: remote ? (cfg.type === 'websocket' ? 'websocket' : 'sse') : 'stdio',
    enabled: true,
    failOnStartupError: false,
    source: 'import',
    origin: String(cfg.__origin || '').slice(0, 64),
    envPlain: {},
    envSecretKeys: [],
    headers: {},
    args: [],
  };
  if (remote) {
    base.url = String(cfg.url);
    for (const [k, v] of Object.entries(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {})) {
      base.headers[String(k).slice(0, 64)] = String(v).slice(0, 2048);
    }
  } else {
    base.command = String(cfg.command);
    base.args = (Array.isArray(cfg.args) ? cfg.args : []).map(String).slice(0, 32);
  }
  const secrets = {};
  for (const [k, v] of Object.entries(cfg.env && typeof cfg.env === 'object' ? cfg.env : {})) {
    const key = String(k);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = String(v ?? '');
    if (!value) continue;
    // imported values are untrusted plaintext from another tool's config —
    // everything goes through the vault so settings.json stays clean (M-2)
    secrets[key] = value;
  }
  base.envSecretKeys = Object.keys(secrets);
  return { server: base, secrets };
}

/** Parse pasted JSON tolerantly. Trae-style hand configs come in two shapes:
 * (a) JSON lines each prefixed with `// ` (the docs sample is fully
 * commented) and (b) real JSON with trailing commas from hand editing.
 * So: un-prefix `//`-leading lines first (restores the wrapped sample), drop
 * any lines still starting with `//`, strip block comments, then trailing
 * commas. Inline `//` inside strings (URLs) is never touched. */
function parsePastedJson(text) {
  const raw = String(text || '');
  try { return JSON.parse(raw); } catch { /* fall through to comment stripping */ }
  const stripped = raw
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*)\/\/\s?(.*)$/);
      if (!m) return line;
      // keep the remainder only when it looks like code (a JSON structural
      // char, allowing for indentation); prose lines ('示例：') are dropped
      return /^\s*["{}\[\]\-tfn0-9]/.test(m[2]) ? m[1] + m[2] : '';
    })
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(stripped);
}

function createMcpImport({ log } = {}) {
  /** Probe every file source; returns [{ key, label, ok, reason?, count, servers }] */
  function scanSources() {
    return SOURCES.filter((s) => s.file).map((s) => {
      const file = s.file();
      if (!file) return { key: s.key, label: s.label, ok: true, count: 0, servers: [] };
      const { json, error } = readJsonTolerant(file);
      if (error) return { key: s.key, label: s.label, ok: false, reason: error, count: 0, servers: [] };
      const map = extractMap(json);
      if (!map) return { key: s.key, label: s.label, ok: true, count: 0, servers: [] };
      const servers = Object.entries(map).map(([name, cfg]) => {
        const n = normalizeEntry(name, { ...(cfg || {}), __origin: s.label });
        return n.err ? { id: slug(name), name, error: n.err } : { id: n.server.serverName, name, summary: n.server.transport === 'stdio' ? n.server.command : n.server.url };
      });
      return { key: s.key, label: s.label, ok: true, count: servers.filter((x) => !x.error).length, servers };
    });
  }

  /** Parse one source into importable records. */
  function loadSource(sourceKey, clipboardText) {
    if (sourceKey === 'clipboard') {
      let json;
      try { json = parsePastedJson(clipboardText); } catch (e) {
        return { ok: false, reason: `invalid JSON: ${e.message}` };
      }
      const map = extractMap(json) || (json && typeof json === 'object' && (json.command || json.url) ? { imported: json } : null);
      if (!map) return { ok: false, reason: 'no mcpServers map or single server object found' };
      return { ok: true, entries: Object.entries(map) };
    }
    const src = SOURCES.find((s) => s.key === sourceKey);
    if (!src || !src.file) return { ok: false, reason: 'unknown source' };
    const file = src.file();
    if (!file) return { ok: false, reason: 'config file not found' };
    const { json, error } = readJsonTolerant(file);
    if (error) return { ok: false, reason: error };
    const map = extractMap(json);
    if (!map) return { ok: false, reason: 'no mcpServers map in file' };
    return { ok: true, entries: Object.entries(map) };
  }

  /**
   * Build records for the selected entries. Returns { ok, items: [{ server,
   * secrets }] } with id conflicts resolved against `existingIds` (+ suffix).
   * The caller runs each item through manager.save().
   */
  function prepare(sourceKey, selectedNames, clipboardText, existingIds = []) {
    const src = loadSource(sourceKey, clipboardText);
    if (!src.ok) return src;
    const taken = new Set(existingIds);
    const items = [];
    for (const [name, cfg] of src.entries) {
      if (Array.isArray(selectedNames) && selectedNames.length && !selectedNames.includes(name)) continue;
      const n = normalizeEntry(name, { ...(cfg || {}), __origin: SOURCES.find((s) => s.key === sourceKey)?.label || 'import' });
      if (n.err) { items.push({ name, error: n.err }); continue; }
      let id = n.server.serverName;
      let i = 1;
      while (taken.has(id)) { id = `${n.server.serverName}_${i}`; i += 1; }
      taken.add(id);
      items.push({ name, server: { ...n.server, serverName: n.server.serverName, id, name: id === n.server.serverName ? n.server.name : `${n.server.name} (${i - 1})` }, secrets: n.secrets });
    }
    return { ok: true, items };
  }

  return { SOURCES, scanSources, loadSource, prepare, slug, normalizeEntry };
}

module.exports = { SOURCES, slug, extractMap, normalizeEntry, parsePastedJson, createMcpImport };
