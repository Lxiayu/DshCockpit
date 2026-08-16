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

module.exports = { createPluginOpGuard, failureCode, shouldCleanupAfterFailure, summarizeOutput, inferStage };
