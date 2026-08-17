// src/plugin-flow.js — pure helpers for the plugin install/remove flow:
// a serialization guard (one dsh plugin op at a time), failure
// classification, npm-output summarizing and stage inference. Electron-free
// on purpose so `node --test` can cover it (main.js cannot be unit-tested).
'use strict';

/**
 * Mutual-exclusion guard for plugin actions. Two concurrent `dsh plugin add`
 * invocations would run npm against the same web profile and corrupt it
 * (half-written package.json / node_modules) — every later install then fails.
 *
 * @returns {{tryBegin(action: string, fullName: string): boolean,
 *            release(): void, current: {action: string, fullName: string, startedAt: number} | null}}
 */
function createPluginOpGuard() {
  let current = null;
  return {
    tryBegin(action, fullName) {
      if (current) return false;
      current = { action, fullName, startedAt: Date.now() };
      return true;
    },
    release() { current = null; },
    get current() { return current; },
  };
}

/** Map a runDshPlugin result to a stable failure code ('timeout'|'spawn'|'exit'). */
function failureCode(result) {
  if (!result) return 'exit';
  if (result.code === 'timeout' || result.output === 'timeout') return 'timeout';
  if (result.code === 'spawn') return 'spawn';
  return 'exit';
}

/**
 * A failed install may leave a half-applied `github:<repo>` spec in the web
 * profile; remove it so the profile stays installable and seedInstalledPlugins
 * does not record the broken plugin as installed. A failed remove needs no
 * cleanup (removing IS the cleanup).
 */
function shouldCleanupAfterFailure(action) {
  return action !== 'remove';
}

/** Distill raw npm/dsh output into a short, human-readable failure line. */
function summarizeOutput(out) {
  const lines = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const errs = lines.filter((l) => /error|ERR!|fatal|failed|not found/i.test(l)).slice(-3);
  return (errs.length ? errs : lines.slice(-3)).join(' | ').slice(-600);
}

/**
 * Infer a coarse install stage from a chunk of child-process output.
 * Returns 'install' | 'download' | 'resolve' | null (keep previous stage).
 */
function inferStage(text) {
  const s = String(text || '');
  if (/install|reif|building|link|script|postinstall|added \d+ packages?/i.test(s)) return 'install';
  if (/download|clon|receiving|unpack|extract|tarball/i.test(s)) return 'download';
  if (/resolv|idealtree|fetch|packument|metadata|registry/i.test(s)) return 'resolve';
  return null;
}

/**
 * Extract the package name pnpm v10 refused to build from a failed plugin
 * install output. pnpm 10 blocks any dependency's build scripts unless it is
 * in `onlyBuiltDependencies`; for git-hosted packages (no prebuilt tarball)
 * the `prepare` script is mandatory, so the install dies with
 * ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED instead of silently skipping.
 * Returns the bare package name (version stripped) or null.
 */
function parsePnpmBlockedPackage(output) {
  const s = String(output || '');
  if (!s.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) return null;
  const m = s.match(/git-hosted package "([^"]+)"/);
  if (!m) return null;
  // strip a trailing @version but keep a leading @scope: "@a/b@1.2.3" -> "@a/b",
  // "name@1.2.3" -> "name", "@a/b" -> "@a/b"
  const at = m[1].lastIndexOf('@');
  const name = at > 0 ? m[1].slice(0, at) : m[1];
  return /^(@[\w.-]+\/)?[\w.-]+$/.test(name) ? name : null;
}

/**
 * Add a package to the `onlyBuiltDependencies` list inside pnpm-workspace.yaml
 * content. Idempotent: returns the input unchanged when already listed. Creates
 * the section (with an explanatory comment) when absent; otherwise appends
 * under the existing list with matching indentation. Line-based on purpose —
 * the runtime-generated yaml is a fixed template, so no YAML parser is needed.
 */
function upsertOnlyBuiltDependencies(content, pkg) {
  const lines = String(content || '').split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*onlyBuiltDependencies\s*:\s*$/.test(l));
  if (idx !== -1) {
    let i = idx + 1;
    const indent = /^\s*-\s/.test(lines[i] || '') ? lines[i].match(/^\s*/)[0] : '  ';
    while (i < lines.length && /^\s*-\s/.test(lines[i])) {
      if (lines[i].includes(pkg)) return content;
      i++;
    }
    lines.splice(i, 0, `${indent}- '${pkg}'`);
    return lines.join('\n');
  }
  const base = content ? content.replace(/\n*$/, '\n') : '';
  return `${base}# git-hosted plugins must run their \`prepare\` build script; pnpm 10 blocks\n`
    + `# that unless the package is explicitly allowlisted here.\n`
    + `onlyBuiltDependencies:\n  - '${pkg}'\n`;
}

/**
 * Some ecosystem repos (e.g. skin collections like dsh-deep-whale) ship no
 * root package.json on purpose: the installable package lives in a top-level
 * subdirectory. Given a GitHub git-trees API `tree` array, return that
 * subdirectory name when exactly one candidate exists (root package.json
 * excluded, nested paths like packages/foo/package.json ignored).
 * Returns { sub, candidates } — sub is null when absent or ambiguous.
 */
function pickSubpackage(tree) {
  const entries = Array.isArray(tree) ? tree : [];
  const dirs = new Set(entries
    .filter((e) => e && e.type === 'tree' && /^[^/]+$/.test(e.path || ''))
    .map((e) => e.path));
  const candidates = entries
    .filter((e) => e && e.type === 'blob' && /^[^/]+\/package\.json$/.test(e.path || ''))
    .map((e) => e.path.split('/')[0])
    .filter((d) => dirs.has(d))
    .sort();
  const unique = [...new Set(candidates)];
  return { sub: unique.length === 1 ? unique[0] : null, candidates: unique };
}

/**
 * Find the profile package.json dependency key that points at a repo.
 * Matches `github:owner/repo` exactly, with a `#path:` fragment, or with a
 * subdirectory suffix — so removes keep working after a collection repo was
 * installed from its subpackage (dep key is then the subpackage's real name).
 */
function resolveDepKey(deps, fullName) {
  const d = deps && typeof deps === 'object' ? deps : {};
  for (const [key, spec] of Object.entries(d)) {
    const s = String(spec || '');
    if (s === `github:${fullName}` || s.startsWith(`github:${fullName}#`) || s.startsWith(`github:${fullName}/`)) {
      return key;
    }
  }
  return null;
}

/** Official bundles shipped with the dsh runtime itself — never pruned. */
const OFFICIAL_BUNDLE_PREFIX = '@deepseek-ai/';

/**
 * Remove bundle registrations (`dsh.profile.bundles`) pointing at a removed
 * plugin. dsh registers a plugin in TWO places: dependencies and bundles; a
 * prune that only drops the dependency leaves a dangling bundle reference that
 * makes the runtime throw `cannot resolve profile bundle` on every boot — a
 * permanent crash loop. `names` are candidate package names (dep keys + the
 * name field from the plugin's own package.json when available).
 * Returns the new package.json object.
 */
function pruneBundles(pkg, names) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  const drop = new Set((names || []).filter(Boolean));
  const bundles = p?.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const kept = bundles.filter((b) => !drop.has(b));
    if (kept.length !== bundles.length) p.dsh.profile.bundles = kept;
  }
  return p;
}

/**
 * Boot-time self-heal: any non-official bundle whose package is not present in
 * node_modules would make the runtime crash on boot, so drop it (and its
 * dependency entry) before the shell ever spawns the runtime. `exists(name)`
 * checks package presence; official @deepseek-ai/* bundles resolve from the
 * runtime installation and are always kept.
 * Returns { pkg, removed: string[] }.
 */
function sanitizeProfile(pkg, exists) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  const removed = [];
  const bundles = p?.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const kept = bundles.filter((b) => {
      if (typeof b !== 'string' || b.startsWith(OFFICIAL_BUNDLE_PREFIX)) return true;
      if (exists(b)) return true;
      removed.push(b);
      return false;
    });
    if (kept.length !== bundles.length) p.dsh.profile.bundles = kept;
  }
  const deps = p.dependencies || {};
  for (const name of removed) delete deps[name];
  if (!Object.keys(deps).length && p.dependencies) delete p.dependencies;
  return { pkg: p, removed };
}

module.exports = { createPluginOpGuard, failureCode, shouldCleanupAfterFailure, summarizeOutput, inferStage, parsePnpmBlockedPackage, upsertOnlyBuiltDependencies, pickSubpackage, resolveDepKey, pruneBundles, sanitizeProfile };
