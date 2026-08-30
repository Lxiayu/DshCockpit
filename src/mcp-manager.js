// src/mcp-manager.js — MCP server panel (T1/R3, v0.3.1).
//
// Visual management for MCP servers configured through the DSH-native
// `@deepseek-ai/dsh-mcp-client` plugin. Spec: docs/specs/MCP-MANAGER-SPEC.md
// (v2). Pure logic lives in plain functions (patch-file surgery, validation,
// Windows command wrapping) so tests run under plain node; createMcpManager()
// wires them into one stateful object for the main process.
//
// Configuration model ("intent layer vs truth layer", SPEC §D-3):
//   - settings.mcpServers  — the intent layer: every configured server incl.
//     disabled ones (disabling never destroys user input)
//   - cordis.patch.yml     — the truth layer: ONLY enabled servers, one patch
//     block each; DSH loads exactly this file on runtime start
//
// Patch-file surgery (M-1): cordis.patch.yml is a top-level YAML sequence;
// we add/remove exactly one block per server under its `- insert:` item and
// leave every other byte untouched. Every write is: backup → line-level patch
// → atomic write → `--dump-config` verify (injected dep) → rollback on failure.
//
// Secrets (M-2): sensitive env values live only in the shell vault
// (safeStorage; KeyVault reused from models-manager). They never enter
// settings.json nor cordis.patch.yml — they reach MCP servers as runtime
// child env vars (supervisor envExtras → runtime → inherited by the MCP
// process). Remote-transport header values are the one documented plaintext
// exception (DSH builds HTTP requests from config; env cannot carry them) —
// surfaced as a UI warning, never stored in the vault for nothing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KeyVault, yamlScalar, writeSettingsFile } = require('./models-manager');

const PATCH_FILE = 'cordis.patch.yml';
const PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';
const BACKUP_SUFFIX = '.mcp-bak';

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;          // server id / serverName
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/; // env/header names
const TRANSPORTS = ['stdio', 'sse', 'websocket'];

// D-5: Claude Code documents that npx-based servers crash with "Connection
// closed" on native Windows unless wrapped in `cmd /c`. UI shows/edits the
// raw form; the patch file stores the wrapped form; editing unwraps again.
const WRAP_TARGETS = new Set(['npx', 'npm', 'yarn', 'pnpm', 'bunx']);

function wrapForWindows(command, args, platform = process.platform) {
  const cmd = String(command || '');
  const list = Array.isArray(args) ? args.map(String) : [];
  if (platform !== 'win32') return { command: cmd, args: list };
  const base = path.win32.basename(cmd.trim().replace(/\.(cmd|exe|bat)$/i, '')).toLowerCase();
  if (!WRAP_TARGETS.has(base)) return { command: cmd, args: list };
  return { command: 'cmd', args: ['/c', cmd, ...list] };
}

function unwrapForWindows(command, args, platform = process.platform) {
  const cmd = String(command || '');
  const list = Array.isArray(args) ? args.map(String) : [];
  if (platform !== 'win32') return { command: cmd, args: list };
  if (cmd.trim().toLowerCase() !== 'cmd' || !list.length || list[0].toLowerCase() !== '/c') {
    return { command: cmd, args: list };
  }
  return { command: String(list[1] || ''), args: list.slice(2) };
}

// ------------------------------------------------------ patch file surgery

const INSERT_RE = /^- insert:\s*(#.*)?$/;
const ITEM_ID_RE = /^- id:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/;

/**
 * Scan the `- insert:` top-level item of a patch file. Returns
 * { insAt, itemIndent, items: [{ id, start, end }] } (end exclusive) or null
 * when the file has no `- insert:` section. Comments and blank lines never
 * terminate a block; a col-0 item or lesser-indent content does.
 */
function scanPatchItems(lines) {
  let insAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (INSERT_RE.test(lines[i])) { insAt = i; break; }
  }
  if (insAt === -1) return null;
  let itemIndent = -1;
  let current = null;
  const items = [];
  for (let i = insAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const dash = line.match(/^(\s*)- /);
    const indent = dash ? dash[1].length : line.match(/^\s*/)[0].length;
    if (dash && indent === 0) break; // next top-level item
    if (itemIndent === -1) itemIndent = indent;
    if (indent <= itemIndent && !(dash && indent === itemIndent)) break;
    if (dash && indent === itemIndent) {
      if (current) { current.end = i; items.push(current); }
      const idm = line.trim().match(ITEM_ID_RE);
      current = { id: idm ? idm[1] : null, start: i, end: lines.length };
    }
  }
  if (current) items.push(current);
  return { insAt, itemIndent, items };
}

/** Render one server's canonical patch block (4-space item indent). */
function buildPatchBlockLines(server) {
  const p = yamlScalar;
  const cfg = [
    `        serverName: ${p(server.serverName)}`,
    `        transport: ${p(server.transport)}`,
  ];
  if (server.transport === 'stdio') {
    cfg.push(`        command: ${p(server.command)}`);
    if (server.args && server.args.length) {
      cfg.push('        args:');
      for (const a of server.args) cfg.push(`          - ${p(a)}`);
    } else {
      cfg.push('        args: []');
    }
    const env = server.envPlain || {};
    const keys = Object.keys(env);
    // Secret keys are intentionally absent (runtime env injection, M-2).
    if (keys.length) {
      cfg.push('        env:');
      for (const k of keys) cfg.push(`          ${k}: ${p(env[k])}`);
    }
  } else {
    cfg.push(`        url: ${p(server.url)}`);
    const headers = server.headers || {};
    const hkeys = Object.keys(headers);
    if (hkeys.length) {
      cfg.push('        headers:');
      for (const k of hkeys) cfg.push(`          ${p(k)}: ${p(headers[k])}`);
    }
  }
  if (server.failOnStartupError) cfg.push('        failOnStartupError: true');
  return [
    `    - id: mcp-${server.id}`,
    `      name: ${p(PLUGIN_NAME)}`,
    '      config:',
    ...cfg,
  ];
}

/** Insert/replace one block; every other line keeps its exact bytes. */
function upsertPatchBlock(text, id, blockLines) {
  const lines = text.split('\n');
  const scan = scanPatchItems(lines);
  if (!scan) {
    const out = [...lines];
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('', '- insert:', ...blockLines);
    else out.push('- insert:', ...blockLines);
    return out.join('\n');
  }
  const existing = scan.items.find((it) => it.id === id);
  if (existing) {
    lines.splice(existing.start, existing.end - existing.start, ...blockLines);
    return lines.join('\n');
  }
  const last = scan.items.length ? scan.items[scan.items.length - 1] : null;
  lines.splice(last ? last.end : scan.insAt + 1, 0, ...blockLines);
  return lines.join('\n');
}

/** Remove one block; collapses an emptied `- insert:` item. Noop when absent. */
function removePatchBlock(text, id) {
  const lines = text.split('\n');
  const scan = scanPatchItems(lines);
  if (!scan) return text;
  const idx = scan.items.findIndex((it) => it.id === id);
  if (idx === -1) return text;
  lines.splice(scan.items[idx].start, scan.items[idx].end - scan.items[idx].start);
  const rescan = scanPatchItems(lines);
  if (rescan && rescan.items.length === 0) lines.splice(rescan.insAt, 1);
  return lines.join('\n');
}

/** Ids of blocks that look like ours (drift detection for the UI). */
function listPatchBlockIds(text) {
  const scan = scanPatchItems(text.split('\n'));
  return scan ? scan.items.map((it) => it.id).filter((id) => id && id.startsWith('mcp-')) : [];
}

// ---------------------------------------------------------------- validation

function sanitizeServer(input, prev, existingList) {
  const src = input || {};
  const id = String(src.id || '').trim();
  if (!ID_RE.test(id)) return { err: 'invalid id (lowercase letter, then a-z0-9-)' };
  const name = String(src.name || '').trim().slice(0, 64);
  if (!name) return { err: 'missing name' };
  const serverName = String(src.serverName || '').trim();
  if (!ID_RE.test(serverName)) return { err: 'invalid namespace (lowercase letter, then a-z0-9-)' };
  const others = (existingList || []).filter((s) => s.id !== id);
  if (others.some((s) => s.serverName === serverName)) {
    return { err: `namespace "${serverName}" is already used by another server` };
  }
  const transport = String(src.transport || 'stdio');
  if (!TRANSPORTS.includes(transport)) return { err: 'invalid transport' };

  let command = '';
  let args = [];
  let url = '';
  let headers = {};
  if (transport === 'stdio') {
    command = String(src.command || '').trim();
    if (!command) return { err: 'missing command' };
    if (command.length > 512) return { err: 'command too long' };
    args = (Array.isArray(src.args) ? src.args : []).map((a) => String(a)).slice(0, 32);
    if (args.some((a) => a.length > 512)) return { err: 'argument too long' };
  } else {
    url = String(src.url || '').trim();
    // sse rides http(s); websocket rides ws(s) — each transport validates its own scheme
    const schemeRe = transport === 'websocket' ? /^wss?:\/\// : /^https?:\/\//;
    if (!schemeRe.test(url)) {
      return { err: `invalid url for ${transport} (must start with ${transport === 'websocket' ? 'ws:// or wss://' : 'http:// or https://'})` };
    }
    const rawHeaders = src.headers && typeof src.headers === 'object' ? src.headers : {};
    for (const [k, v] of Object.entries(rawHeaders).slice(0, 16)) {
      if (!ENV_KEY_RE.test(k)) return { err: `invalid header name: ${k}` };
      headers[k] = String(v).slice(0, 2048);
    }
  }

  const envPlain = {};
  const rawEnv = src.envPlain && typeof src.envPlain === 'object' ? src.envPlain : {};
  for (const [k, v] of Object.entries(rawEnv).slice(0, 16)) {
    if (!ENV_KEY_RE.test(k)) return { err: `invalid env key: ${k}` };
    envPlain[k] = String(v).slice(0, 1024);
  }
  const envSecretKeys = [...new Set((Array.isArray(src.envSecretKeys) ? src.envSecretKeys : [])
    .map((k) => String(k)).filter((k) => ENV_KEY_RE.test(k)))].slice(0, 16);
  // a key cannot be both plain and secret
  for (const k of envSecretKeys) delete envPlain[k];

  const num = (v, def, min, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const server = {
    id, name, serverName, transport,
    enabled: src.enabled === undefined ? (prev ? !!prev.enabled : true) : !!src.enabled,
    failOnStartupError: !!src.failOnStartupError,
    command, args, envPlain, envSecretKeys, url, headers,
    startupTimeoutSec: num(src.startupTimeoutSec, 10, 3, 120),
    toolTimeoutSec: num(src.toolTimeoutSec, 60, 3, 600),
    source: ['registry', 'manual', 'import'].includes(src.source) ? src.source : (prev && prev.source) || 'manual',
    origin: String(src.origin || (prev && prev.origin) || '').slice(0, 64),
    createdAt: (prev && prev.createdAt) || Date.now(),
  };
  return { server };
}

/** Snapshot for the renderer: which secret keys have vault values, no values. */
function publicView(server, vault) {
  const envSecrets = {};
  for (const k of server.envSecretKeys || []) envSecrets[k] = { configured: vault.has(`mcp:${server.id}:${k}`) };
  return { ...server, envSecrets };
}

// ------------------------------------------------------------------- manager

/**
 * deps:
 *   - settings: SettingsStore (mcpServers array)
 *   - dshHome(): string
 *   - profileName: string   — 'web'
 *   - userDataDir: string   — vault location
 *   - safeStorage           — electron safeStorage (nullable in tests)
 *   - log(line)
 *   - dumpConfigVerify(): Promise<{ok, reason?}>  — injected smoke check
 *   - platform: string      — override for tests
 */
function createMcpManager(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const platform = d.platform || process.platform;
  const vault = new KeyVault(path.join(d.userDataDir, 'mcp-secrets.json'), d.safeStorage, log);
  const dshHome = () => d.dshHome();
  const profileName = d.profileName || 'web';
  const patchFile = () => path.join(dshHome(), 'profiles', profileName, PATCH_FILE);
  const verify = d.dumpConfigVerify || (async () => ({ ok: true, skipped: true }));

  const servers = () => d.settings.get().mcpServers || [];

  const readPatch = () => {
    try { return fs.readFileSync(patchFile(), 'utf8'); } catch { return ''; }
  };

  /**
   * Shared write pipeline: backup → patch → atomic write → verify → rollback.
   * `apply(text)` returns the new file text (or null for a no-op).
   */
  async function writePatch(apply, opLabel) {
    const file = patchFile();
    const before = readPatch();
    const after = apply(before);
    if (after === null) return { ok: true, noop: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let backupOk = false;
    if (before !== '') {
      try { fs.copyFileSync(file, file + BACKUP_SUFFIX); backupOk = true; } catch { /* best effort */ }
    }
    try {
      writeSettingsFile(file, after);
    } catch (e) {
      return { ok: false, reason: `write failed: ${e.message}` };
    }
    const v = await verify();
    if (!v.ok) {
      log(`[mcp] ${opLabel}: dump-config rejected the write (${v.reason}); rolling back`);
      try {
        if (backupOk) fs.copyFileSync(file + BACKUP_SUFFIX, file);
        else fs.unlinkSync(file); // no prior file → restore absence
      } catch (e) {
        log(`[mcp] rollback failed: ${e.message}`);
        return { ok: false, reason: `${v.reason}; rollback failed: ${e.message}` };
      }
      return { ok: false, reason: v.reason };
    }
    return { ok: true };
  }

  /** Whether the server currently has a block in the truth layer. */
  function hasBlock(id) {
    return listPatchBlockIds(readPatch()).includes(`mcp-${id}`);
  }

  /** Rebuild + upsert (enabled) or drop (disabled) one block. */
  async function syncBlock(server, prevEnabled) {
    const id = `mcp-${server.id}`;
    if (server.enabled) {
      const { command, args } = wrapForWindows(server.command, server.args, platform);
      const block = buildPatchBlockLines({ ...server, command, args });
      const r = await writePatch((text) => upsertPatchBlock(text, id, block), `save ${server.id}`);
      return r;
    }
    if (prevEnabled || hasBlock(server.id)) {
      return writePatch((text) => (text.includes(id) ? removePatchBlock(text, id) : null), `disable ${server.id}`);
    }
    return { ok: true, noop: true };
  }

  return {
    /** Full snapshot for the renderer (never includes secret values). */
    listServers() {
      const blockIds = listPatchBlockIds(readPatch());
      const list = servers().map((s) => publicView(s, vault));
      return {
        ok: true,
        servers: list,
        patchBlockIds: blockIds,
        patchFile: patchFile(),
      };
    },

    getServer(id) {
      const s = servers().find((x) => x.id === id);
      return s ? { ok: true, server: publicView(s, vault) } : { ok: false, reason: 'not found' };
    },

    /** Create/update. `secrets` = { ENV_KEY: value } — sent once by the
     * renderer, stored in the vault, never persisted anywhere else. */
    async save(input, secrets) {
      const list = servers();
      const prev = list.find((s) => s.id === (input && input.id));
      const { server, err } = sanitizeServer(input, prev, list);
      if (err) return { ok: false, reason: err };
      const next = list.filter((s) => s.id !== server.id);
      next.push(server);

      const vals = secrets && typeof secrets === 'object' ? secrets : {};
      for (const [k, v] of Object.entries(vals)) {
        if (!server.envSecretKeys.includes(k)) continue;
        const value = String(v || '');
        if (!value) continue; // empty = keep the stored value
        vault.set(`mcp:${server.id}:${k}`, value);
      }
      // drop vault entries for keys the user removed from the secret list
      if (prev) {
        for (const k of prev.envSecretKeys || []) {
          if (!server.envSecretKeys.includes(k)) vault.remove(`mcp:${server.id}:${k}`);
        }
      }

      const r = await syncBlock(server, prev ? prev.enabled : false);
      if (!r.ok) return r;
      d.settings.patch({ mcpServers: next });
      log(`[mcp] saved "${server.id}" (${server.transport}, ${server.enabled ? 'enabled' : 'disabled'})`);
      return { ok: true, server: publicView(server, vault) };
    },

    async remove(id) {
      const list = servers();
      const prev = list.find((s) => s.id === id);
      if (!prev) return { ok: false, reason: 'not found' };
      const r = await writePatch(
        (text) => (text.includes(`mcp-${id}`) ? removePatchBlock(text, `mcp-${id}`) : null),
        `remove ${id}`,
      );
      if (!r.ok) return r;
      for (const k of prev.envSecretKeys || []) vault.remove(`mcp:${id}:${k}`);
      d.settings.patch({ mcpServers: list.filter((s) => s.id !== id) });
      log(`[mcp] removed "${id}"`);
      return { ok: true };
    },

    /** D-3: disable keeps the record; only the patch block goes away. */
    async toggle(id, enabled) {
      const list = servers();
      const prev = list.find((s) => s.id === id);
      if (!prev) return { ok: false, reason: 'not found' };
      if (!!enabled === !!prev.enabled) return { ok: true, noop: true };
      const next = list.map((s) => (s.id === id ? { ...s, enabled: !!enabled } : s));
      const r = await syncBlock(next.find((s) => s.id === id), prev.enabled);
      if (!r.ok) return r;
      d.settings.patch({ mcpServers: next });
      log(`[mcp] ${enabled ? 'enabled' : 'disabled'} "${id}"`);
      return { ok: true };
    },

    /**
     * Secret env vars of every ENABLED server, resolved from the vault.
     * Consumed by the supervisor (envExtras) so DSH-spawned MCP servers
     * inherit them from the runtime child env — no plaintext in any file.
     * Key collisions resolve last-wins with a single log line.
     */
    runtimeSecretEnv() {
      const out = {};
      const seen = new Set();
      for (const s of servers()) {
        if (!s.enabled) continue;
        for (const k of s.envSecretKeys || []) {
          const v = vault.get(`mcp:${s.id}:${k}`);
          if (v === null || v === undefined) continue;
          if (seen.has(k) && !(k in out)) continue;
          if (k in out && out[k] !== v) log(`[mcp] secret env "${k}" declared by multiple servers; last one wins`);
          out[k] = v;
          seen.add(k);
        }
      }
      return out;
    },

    /** Resolve one secret for the tier-2 probe (main process only). */
    resolveSecret(id, key) {
      return vault.get(`mcp:${id}:${key}`);
    },

    patchFile,
    vault,
  };
}

module.exports = {
  PATCH_FILE,
  PLUGIN_NAME,
  WRAP_TARGETS,
  wrapForWindows,
  unwrapForWindows,
  scanPatchItems,
  buildPatchBlockLines,
  upsertPatchBlock,
  removePatchBlock,
  listPatchBlockIds,
  sanitizeServer,
  createMcpManager,
};
