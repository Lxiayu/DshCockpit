// src/runtime-manager.js — versioned runtime installs + the update pipeline.
//
// Layout under userData/:
//   runtime/<version>/          managed installs (npm tree via @npmcli/arborist)
//   runtime-state.json          { activeVersion, pendingVersion, installed[], broken[], knownIssues }
//   npm-cache/                  npm cache for arborist/pacote
//   snapshots/pre-<version>-<ts>/   DSH_HOME lightweight snapshot before a switch
//
// A version entry is { version, path, source: 'managed' | 'bootstrap' }.
// Bootstrap entries reference an existing install (e.g. the npx-cache copy the
// user already has) without copying; managed entries live in runtime/<version>.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const semver = require('semver');

const PACKAGE = '@deepseek-ai/dsh';
const SMOKE_TIMEOUT_MS = 60_000;
/** Hard deadline for one arborist install. rc runtimes are a 60+ package
 * monorepo; without this a stalled registry / cache lock would hold the
 * update pipeline forever (the "check update" button then appears to hang
 * and the app has to be force-quit). */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

class RuntimeManager {
  constructor({ userDataDir, settings, log, resolveNodeBin }) {
    this.runtimeDir = path.join(userDataDir, 'runtime');
    this.cacheDir = path.join(userDataDir, 'npm-cache');
    this.snapshotDir = path.join(userDataDir, 'snapshots');
    this.stateFile = path.join(userDataDir, 'runtime-state.json');
    this.settings = settings; // SettingsStore (call .get()/.effective() when needed)
    this.log = log || (() => {});
    this.resolveNodeBin = resolveNodeBin; // () => path string
    this._installLocks = new Map(); // per-version in-flight install promises (dedupe)
    this.installTimeoutMs = INSTALL_TIMEOUT_MS; // injectable for tests
    this.smokeTimeoutMs = SMOKE_TIMEOUT_MS; // injectable for tests
    this.nodeProbeTimeoutMs = 5_000; // `node --version` probe deadline (tests)
    this._arborist = null; // injectable for tests (defaults to @npmcli/arborist)
    this._spawn = spawn; // injectable for tests (defaults to node:child_process)
    this.state = { activeVersion: null, previousVersion: null, pendingVersion: null, installed: [], broken: [], knownIssues: {}, lastSnapshot: null };
    this.loadState();
  }

  // ------------------------------------------------------------------ state
  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.state = { ...this.state, ...raw };
    } catch { /* first run */ }
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  /**
   * Drop installed entries whose lib/bin.js no longer exists (e.g. the app was
   * moved to a new directory / the old install was deleted). Keeps the active
   * version pointer; the caller re-resolves it to a live entry.
   */
  revalidate() {
    const before = this.state.installed.length;
    this.state.installed = this.state.installed.filter((e) => {
      const bin = path.join(e.path, 'node_modules', PACKAGE, 'lib', 'bin.js');
      if (fs.existsSync(bin)) return true;
      this.log(`[runtime] dropped stale entry ${e.version} (${e.path})`);
      return false;
    });
    if (this.state.installed.length !== before) {
      if (this.state.previousVersion && !this.entry(this.state.previousVersion)) this.state.previousVersion = null;
      this.saveState();
    }
  }

  getInfo() {
    const active = this.entry(this.state.activeVersion);
    return {
      activeVersion: this.state.activeVersion,
      pendingVersion: this.state.pendingVersion,
      installed: this.state.installed.map((e) => ({ ...e })),
      broken: [...this.state.broken],
      knownIssues: { ...this.state.knownIssues },
      activePath: active ? active.path : null,
    };
  }

  entry(version) {
    // Preference: managed (userData, writable/updatable) > bundled (installer
    // seed, read-only but instant) > bootstrap (external path reference).
    const managed = this.state.installed.find((e) => e.version === version && e.source === 'managed');
    if (managed) return managed;
    const bundled = this.state.installed.find((e) => e.version === version && e.source === 'bundled');
    if (bundled) return bundled;
    return this.state.installed.find((e) => e.version === version) || null;
  }

  /** entry() whose lib/bin.js actually exists on disk, or null. */
  liveEntry(version) {
    const e = this.entry(version);
    if (!e) return null;
    return fs.existsSync(path.join(e.path, 'node_modules', PACKAGE, 'lib', 'bin.js')) ? e : null;
  }

  /** Whether the active version is served from an owned dir (managed or bundled seed). */
  isActiveManaged() {
    const e = this.state.activeVersion ? this.entry(this.state.activeVersion) : null;
    return !!e && (e.source === 'managed' || e.source === 'bundled');
  }

  // -------------------------------------------------------------- bootstrap
  /** Register an existing install directory as a version (no copy). */
  bootstrapFrom(dir, version) {
    if (!fs.existsSync(path.join(dir, 'node_modules', PACKAGE, 'lib', 'bin.js'))) {
      throw new Error(`not a dsh install: ${dir}`);
    }
    if (!this.entry(version)) {
      this.state.installed.push({ version, path: dir, source: 'bootstrap' });
    }
    if (!this.state.activeVersion) this.state.activeVersion = version;
    this.saveState();
    return this.entry(version);
  }

  /**
   * Register the bundled installer seed (resources/runtime/<version>) as an
   * entry — run in place, zero copy, zero network.
   *
   * - A live managed copy keeps priority (entry() prefers managed).
   * - Stale bundled/bootstrap entries for the same version are replaced: a
   *   portable app may move to a new directory, leaving old absolute paths in
   *   runtime-state.json (the 'cannot find lib/bin.js' bug).
   * - If the active version currently has no live entry (dropped by
   *   revalidate() / never installed), the active pointer is repointed to the
   *   bundled version so boot can proceed.
   *
   * Returns the resulting entry, or null when the bundle is unusable.
   */
  registerBundled(bundle) {
    if (!bundle || !bundle.version || !bundle.path) return null;
    const bin = path.join(bundle.path, 'node_modules', PACKAGE, 'lib', 'bin.js');
    if (!fs.existsSync(bin)) return null;
    const existing = this.entry(bundle.version);
    if (existing) {
      const existingBin = path.join(existing.path, 'node_modules', PACKAGE, 'lib', 'bin.js');
      if (existing.source === 'managed' && fs.existsSync(existingBin)) {
        return existing; // a live managed copy wins (updatable, stable in userData)
      }
      if (existing.source === 'bundled' && existing.path === bundle.path && fs.existsSync(existingBin)) {
        return existing; // already registered at this very bundle path — no churn
      }
      // stale bundled (app moved) or bootstrap reference: replace below
    }
    // Drop stale duplicates for this version (moved app dir / old bootstrap
    // reference), keeping any live managed copy.
    const before = this.state.installed.length;
    this.state.installed = this.state.installed.filter((e) => {
      if (e.version !== bundle.version) return true;
      if (e.source === 'managed') {
        return fs.existsSync(path.join(e.path, 'node_modules', PACKAGE, 'lib', 'bin.js'));
      }
      return false;
    });
    if (this.state.installed.length !== before) {
      const reason = existing && existing.path !== bundle.path
        ? ' (was ' + existing.path + ')'
        : '';
      this.log('[runtime] replaced entry for ' + bundle.version + ' with bundled seed' + reason);
    }
    // The active pointer must have a LIVE entry (e.g. the previous install's
    // version was dropped, or points at a moved/deleted path); point it at the
    // bundle so boot can proceed.
    if (!this.state.activeVersion || !this.liveEntry(this.state.activeVersion)) {
      this.state.activeVersion = bundle.version;
    }
    this.state.installed.push({ version: bundle.version, path: bundle.path, source: 'bundled' });
    this.saveState();
    return this.entry(bundle.version);
  }

  // ------------------------------------------------------------- discovery
  /** Resolve the target version for the current channel from a packument. */
  resolveTarget(packument) {
    const cfg = this.settings.effective();
    if (cfg.channel === 'pinned') {
      const v = cfg.pinnedVersion.trim();
      if (!v) return null;
      return packument.versions && packument.versions[v] ? v : null;
    }
    if (cfg.channel === 'latest') {
      return packument['dist-tags'] && packument['dist-tags'].latest || null;
    }
    // rc: highest version (prereleases included). Versions that semver cannot
    // parse are skipped — a single malformed entry must not throw the sort and
    // take down the whole check.
    const versions = Object.keys(packument.versions || {}).filter((v) => semver.valid(v));
    if (!versions.length) return null;
    versions.sort(semver.rcompare);
    return versions[0];
  }

  /** Fetch the packument, honoring the configured registry. 30s timeout. */
  async fetchPackument() {
    const cfg = this.settings.effective();
    const registry = cfg.registry.endsWith('/') ? cfg.registry : `${cfg.registry}/`;
    const pacote = require('pacote');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    // Hard deadline: pacote may not honor the AbortSignal, so a dead/unroutable
    // network must not hang the guided first-run (or the 15s update check)
    // forever. The losing promise is left to settle on its own.
    let deadlineTimer = null;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error('registry check timed out')), 40_000);
    });
    try {
      const p = await Promise.race([
        pacote.packument(PACKAGE, {
          registry,
          cache: this.cacheDir,
          fullMetadata: false,
          signal: ac.signal,
        }),
        deadline,
      ]);
      this.log('[runtime] registry check ok (versions=' + Object.keys(p.versions || {}).length + ')');
      return p;
    } finally {
      clearTimeout(timer);
      clearTimeout(deadlineTimer); // M-fix: the losing deadline timer must not leak
    }
  }

  /** Check whether an update is available. Never throws; returns a report. */
  async checkForUpdate() {
    try {
      const packument = await this.fetchPackument();
      const target = this.resolveTarget(packument);
      if (!target) {
        return { ok: true, available: false, reason: 'no version for channel', current: this.state.activeVersion };
      }
      const current = this.state.activeVersion;
      // M12: an unknown/unparseable version must not make the check throw
      const valid = current ? semver.valid(current) : null;
      if (valid && semver.eq(target, current)) {
        return { ok: true, available: false, current, target, reason: 'up-to-date' };
      }
      if (valid && semver.lt(target, current)) {
        return { ok: true, available: false, current, target, reason: 'installed version newer than channel target' };
      }
      // The target is newer — pre-flight the runtime's own engines.node before
      // committing to a (potentially long, non-cancellable) install. rc builds
      // can require a newer Node than the shell bundles (Electron's built-in);
      // installing anyway would stall on broken postinstall hooks.
      const meta = packument.versions[target] || {};
      const nodeRange = meta.engines && meta.engines.node;
      if (nodeRange) {
        const found = await this.detectNodeVersion();
        if (found && !semver.satisfies(found, nodeRange)) {
          return {
            ok: false, available: true, current, target,
            reason: `${PACKAGE}@${target} requires Node ${nodeRange}, found v${found}`,
          };
        }
      }
      return { ok: true, available: true, current, target };
    } catch (err) {
      return { ok: false, available: false, reason: err.message };
    }
  }

  /** Resolve the actual Node version used to run the runtime (vX.Y.Z or null). */
  detectNodeVersion() {
    const node = this.resolveNodeBin();
    if (!node || !node.bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      const child = this._spawn(node.bin, ['--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve(null); // undetectable — don't block the update, smoke test covers it
      }, this.nodeProbeTimeoutMs);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => {
        clearTimeout(timer);
        const m = String(out).trim().match(/^v?(\d+\.\d+\.\d+)/);
        resolve(m ? m[1] : null);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // --------------------------------------------------------------- install
  /**
   * Install a version into runtime/<version> via arborist (respects registry + cache .npmrc).
   * @param {string} version
   * @param {(p: {stage: string, pkgCount?: number}) => void} [onProgress] live progress
   *   callback so the UI can render an install console instead of dead air
   *   (the rc runtime is a 60+ package monorepo and can take minutes).
   */
  async installVersion(version, onProgress) {
    // short-circuit only on a managed copy; a bootstrap path reference is not
    // enough (materialization must actually install into userData)
    const existingManaged = this.state.installed.find((e) => e.version === version && e.source === 'managed');
    if (existingManaged) {
      this.log(`[runtime] version ${version} already installed (managed)`);
      return existingManaged;
    }
    // Dedupe concurrent installs of the same version (guided first-run vs the
    // delayed background update check) so arborist never reifies one dir twice.
    if (this._installLocks.has(version)) return this._installLocks.get(version);
    const promise = this._doInstall(version, onProgress).finally(() => this._installLocks.delete(version));
    this._installLocks.set(version, promise);
    return promise;
  }

  async _doInstall(version, onProgress) {
    const report = (p) => { if (typeof onProgress === 'function') { try { onProgress(p); } catch { /* UI must not break installs */ } } };
    report({ stage: 'preparing' });
    const targetDir = path.join(this.runtimeDir, version);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'package.json'),
      JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: { [PACKAGE]: version } }, null, 2)
    );
    const cfg = this.settings.effective();
    const registry = cfg.registry.endsWith('/') ? cfg.registry : `${cfg.registry}/`;
    fs.writeFileSync(
      path.join(targetDir, '.npmrc'),
      [`registry=${registry}`, `cache=${this.cacheDir}`, 'fund=false', 'audit=false', 'loglevel=error'].join('\n') + '\n'
    );

    this.log(`[runtime] installing ${PACKAGE}@${version} -> ${targetDir}`);
    const Arborist = this._arborist || require('@npmcli/arborist');
    const arb = new Arborist({ path: targetDir });
    // Deadline around reify(): arborist can stall on a slow registry, a locked
    // npm cache or a broken postinstall hook, and it has no built-in timeout.
    // Without this the "check update" flow hangs forever (force-quit required).
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`install timed out after ${Math.round(this.installTimeoutMs / 1000)}s`)), this.installTimeoutMs);
    });
    // While reify runs, surface liveness: count resolved top-level packages in
    // node_modules so the console shows progress ("installed N packages…")
    // instead of dead air. readdirSync on the top level only stays cheap even
    // for large trees.
    let pkgCount = 0;
    let probe = null;
    const startedAt = Date.now();
    if (typeof onProgress === 'function') {
      probe = setInterval(() => {
        const nm = path.join(targetDir, 'node_modules');
        try { pkgCount = fs.readdirSync(nm).length; } catch { /* not created yet */ }
        // arborist materializes node_modules late; elapsed time is the honest
        // liveness signal (a bare "0 packages" for minutes looks like a hang)
        report({ stage: 'installing', pkgCount, elapsedMs: Date.now() - startedAt });
      }, 500);
    }
    try {
      await Promise.race([arb.reify({ save: false }), deadline]);
    } finally {
      clearTimeout(timer);
      if (probe) clearInterval(probe);
    }
    this.log(`[runtime] install finished for ${version}`);

    const entry = { version, path: targetDir, source: 'managed' };
    this.state.installed.push(entry);
    this.saveState();
    report({ stage: 'finalizing', pkgCount, elapsedMs: Date.now() - startedAt });
    return entry;
  }

  // ------------------------------------------------------------ smoke test
  /**
   * Boot-compose smoke test: `dsh --profile web --dump-config` must exit 0.
   * No server, no tokens. Catches breaking CLI/config changes in new runtimes.
   */
  async smokeTest(entry) {
    const binJs = path.join(entry.path, 'node_modules', PACKAGE, 'lib', 'bin.js');
    if (!fs.existsSync(binJs)) return { ok: false, reason: 'missing lib/bin.js' };
    const cfg = this.settings.effective();
    const dshHome = cfg.dshHome || path.join(require('node:os').homedir(), '.dsh');
    const node = this.resolveNodeBin(); // { bin, runAsNode }
    const env = { ...process.env, DSH_HOME: dshHome };
    if (node && node.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    return new Promise((resolve) => {
      const child = this._spawn(
        node.bin,
        [binJs, '--profile', 'web', '--dump-config'],
        { env, cwd: entry.path, windowsHide: true, stdio: 'ignore' }
      );
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, reason: 'timeout' });
      }, this.smokeTimeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, exitCode: code });
      });
    });
  }

  // --------------------------------------------------------------- switch
  /**
   * Copy a tree, pruning node_modules directories.
   *
   * DSH_HOME/profiles/node_modules is a junction farm into the ACTIVE
   * runtime's node_modules (dsh heals it on every start; see DESIGN.md §10).
   * A naive recursive copy would follow those junctions and duplicate the
   * whole runtime tree (tens of thousands of files), blocking the main
   * process. Snapshots only need the profile's own files; dsh rebuilds the
   * junction farm automatically, so node_modules is deliberately skipped.
   * Symlinks are copied as links (never dereferenced).
   */
  copyTreePruningNodeModules(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const s = path.join(src, e.name);
      const d = path.join(dest, e.name);
      if (e.isDirectory()) {
        this.copyTreePruningNodeModules(s, d);
      } else if (e.isFile()) {
        try { fs.copyFileSync(s, d); } catch { /* best effort */ }
      } else if (e.isSymbolicLink()) {
        // copy the link itself (never dereference junctions into the runtime)
        try {
          const target = fs.readlinkSync(s);
          try { fs.symlinkSync(target, d, 'junction'); }
          catch { fs.symlinkSync(target, d); }
        } catch { /* best effort */ }
      }
    }
  }

  /**
   * Snapshot DSH_HOME key config before activating a different version.
   * M4: credentials are deliberately EXCLUDED (plaintext key copies are a
   * liability; backups/snapshots never carry them). Old snapshots are pruned.
   */
  snapshotDshHome() {
    const cfg = this.settings.effective();
    const dshHome = cfg.dshHome || path.join(require('node:os').homedir(), '.dsh');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.snapshotDir, `pre-${this.state.activeVersion || 'none'}-${stamp}`);
    const keys = ['settings.yaml', 'profiles'];
    fs.mkdirSync(dest, { recursive: true });
    for (const key of keys) {
      const src = path.join(dshHome, key);
      if (!fs.existsSync(src)) continue;
      try {
        if (fs.statSync(src).isDirectory()) this.copyTreePruningNodeModules(src, path.join(dest, key));
        else fs.copyFileSync(src, path.join(dest, key));
      } catch { /* key may not exist */ }
    }
    // prune old snapshots (keep the 3 newest)
    try {
      const dirs = fs.readdirSync(this.snapshotDir)
        .filter((n) => { try { return fs.statSync(path.join(this.snapshotDir, n)).isDirectory(); } catch { return false; } })
        .sort();
      while (dirs.length > 3) {
        const old = dirs.shift();
        try { fs.rmSync(path.join(this.snapshotDir, old), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    this.state.lastSnapshot = dest;
    this.saveState(); // M10: persist the snapshot path so a crash between switch and rollback still recovers
    this.log(`[runtime] DSH_HOME snapshot -> ${dest}`);
    return dest;
  }

  /** Restore the most recent snapshot over DSH_HOME (credentials never restored). */
  restoreLastSnapshot() {
    const snap = this.state.lastSnapshot;
    if (!snap || !fs.existsSync(snap)) return false;
    const cfg = this.settings.effective();
    const dshHome = cfg.dshHome || path.join(require('node:os').homedir(), '.dsh');
    for (const key of ['settings.yaml', 'profiles']) {
      const src = path.join(snap, key);
      if (fs.existsSync(src)) {
        try {
          if (fs.statSync(src).isDirectory()) this.copyTreePruningNodeModules(src, path.join(dshHome, key));
          else fs.copyFileSync(src, path.join(dshHome, key));
        } catch (err) { this.log(`[runtime] snapshot restore ${key} failed: ${err.message}`); }
      }
    }
    this.log(`[runtime] DSH_HOME restored from ${snap}`);
    return true;
  }

  /** Activate a version: smoke it (unless forced), snapshot, switch the pointer. */
  async activate(version, { force = false } = {}) {
    const entry = this.entry(version);
    if (!entry) throw new Error(`version not installed: ${version}`);
    if (!force) {
      const smoke = await this.smokeTest(entry);
      if (!smoke.ok) {
        if (!this.state.broken.includes(version)) this.state.broken.push(version);
        this.state.knownIssues[version] = smoke.reason || `smoke test failed (exit ${smoke.exitCode})`;
        this.saveState();
        throw new Error(`smoke test failed for ${version}: ${smoke.reason || smoke.exitCode}`);
      }
    }
    const previous = this.state.activeVersion;
    this.snapshotDshHome();
    this.state.pendingVersion = null;
    this.state.previousVersion = previous;
    this.state.activeVersion = version;
    this.state.broken = this.state.broken.filter((v) => v !== version);
    delete this.state.knownIssues[version];
    this.saveState();
    this.gc();
    return { previous, current: version };
  }

  /** Switch back to the previous version and restore the DSH_HOME snapshot. */
  async rollback() {
    const current = this.state.activeVersion;
    const target = this.state.previousVersion || null;
    const prev = target ? this.entry(target) : null;
    if (!prev) throw new Error('no previous version to roll back to');
    this.restoreLastSnapshot();
    this.state.previousVersion = null;
    this.state.activeVersion = prev.version;
    this.state.pendingVersion = null;
    this.state.knownIssues[current] = 'user rolled back';
    this.saveState();
    return { from: current, to: prev.version };
  }

  // -------------------------------------------------------------------- gc
  /** Prune old managed versions beyond keepVersions (never active, rollback target, or bundled). */
  gc() {
    const cfg = this.settings.effective();
    const keep = Math.max(1, cfg.keepVersions || 2);
    const managed = this.state.installed
      .filter((e) => e.source === 'managed'
        && e.version !== this.state.activeVersion
        && e.version !== this.state.previousVersion)
      .sort((a, b) => semver.rcompare(a.version, b.version));
    const drop = managed.slice(keep - 1);
    for (const entry of drop) {
      this.log(`[runtime] gc: removing ${entry.version}`);
      // M3: never let a locked/removable dir take down the state update
      try {
        fs.rmSync(entry.path, { recursive: true, force: true });
        this.state.installed = this.state.installed.filter((e) => e !== entry);
        this.state.broken = this.state.broken.filter((v) => v !== entry.version);
      } catch (err) {
        this.log(`[runtime] gc: skip ${entry.version} (${err.message})`);
      }
    }
    this.saveState();
  }
}

module.exports = { RuntimeManager };
