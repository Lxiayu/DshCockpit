// src/skills.js — Skills (SKILL.md instruction packs) management (v0.2.4 C4).
//
// dsh discovers skills as pure files under <DSH_HOME>/skills/<name>/SKILL.md
// (chokidar hot-reload — no runtime restart; new sessions pick them up).
// This module implements the shell side:
//   - SKILL.md frontmatter validation (E1–E7 errors / W1–W2 warnings, codes
//     mirror the dsh-skill-filesystem parser rules from the C4 research)
//   - GitHub codeload zip download (pinned to the default-branch commit) +
//     dependency-free zip extraction (store/deflate via zlib.inflateRaw)
//   - multi-skill repo scanning (one-level */SKILL.md discovery, same shape
//     as the runtime's own discovery)
//   - atomic install (stage outside the skills root, single rename into
//     place, tmp cleanup on failure) + uninstall / upgrade / local import
//   - market payload mapping (reuses the awesome-dsh-plugin curated entries
//     produced by market.js — filtered to the 'skills' category)
//
// Pure helpers are exported directly; the fs/network orchestration lives in
// createSkillsManager() with injectable roots so `node --test` can cover it.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

/** dsh's own skill-name rule: lowercase kebab-case (dsh-skill-filesystem
 * SKILL_NAME). The shell additionally enforces the 64-char cap from the
 * agentskills.io open standard. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;

/** Legacy camelCase invocation keys: dsh's rejectLegacyInvocationKey throws
 * on them, which makes the runtime drop the ENTIRE skill — surface that as
 * E7 with the canonical kebab-case replacement. */
const LEGACY_INVOCATION_KEYS = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
};

/** Content patterns that warrant the W2 caution (bundled executable helpers
 * or instructions likely to make the agent request running commands). */
const RISKY_CONTENT_RE = /\b(curl|wget)\b|eval\(|rm\s+-rf|sudo\s/i;

/** Registry of shell-installed skills (source repo / pinned commit), stored
 * inside the skills root as a dotfile the runtime ignores. */
const REGISTRY_FILE = '.dsh-cockpit-skills.json';

/** Zip bomb guard for extraction. */
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/** Zip download abort budgets (ghJson's 15s covers the API JSON calls):
 * response headers must arrive within 15s of the request and the whole
 * transfer — body streaming included — is capped at 120s. Without these a
 * hung codeload connection would hold the skills-guard mutex for its full
 * TTL (~5 min); either abort surfaces as an e6-class readable error. */
const ZIP_CONNECT_TIMEOUT_MS = 15_000;
const ZIP_TOTAL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// frontmatter parsing + validation (pure)
// ---------------------------------------------------------------------------
/** Parse a `---` fenced YAML frontmatter block. Supports the flat
 * `key: value` surface skills actually use (quoted strings, comments);
 * indented continuation lines belong to nested maps (e.g. `metadata:`) and
 * are ignored like the runtime's open-object parsing ignores unknown data.
 * Returns { ok, data, content } or { ok:false, code: 'e2'|'e5', msg }. */
function parseFrontmatter(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const lines = s.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return { ok: false, code: 'e2' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { ok: false, code: 'e2' };
  const data = {};
  let bad = '';
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) continue; // nested map / list continuation — not needed
    const m = line.match(/^([^:\s]+):\s*(.*)$/);
    if (!m) {
      if (!bad) bad = `line ${i + 1}: "${line.trim().slice(0, 40)}"`;
      continue;
    }
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)
      || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    data[m[1]] = v;
  }
  if (bad) return { ok: false, code: 'e5', msg: bad };
  return { ok: true, data, content: lines.slice(end + 1).join('\n').trim() };
}

/**
 * Validate one SKILL.md. Returns
 * { ok, errors: [{code, params}], warnings: [{code, params}], name,
 *  description, content } — codes map to i18n keys `skills.<code>` in the
 * main process (E1 is scan-level: a repo/dir without any SKILL.md).
 * W1 (dir name ≠ skill name) is non-blocking: installDir() aligns the
 * destination to the frontmatter name automatically.
 */
function validateSkillMd(text, opts = {}) {
  const errors = [];
  const warnings = [];
  const fm = parseFrontmatter(text);
  if (!fm.ok) {
    errors.push({ code: fm.code, params: fm.code === 'e5' ? { msg: fm.msg || '' } : {} });
    return { ok: false, errors, warnings, name: '', description: '', content: '' };
  }
  const name = typeof fm.data.name === 'string' ? fm.data.name.trim() : '';
  const description = typeof fm.data.description === 'string' ? fm.data.description.trim() : '';
  for (const [legacy, canonical] of Object.entries(LEGACY_INVOCATION_KEYS)) {
    if (legacy in fm.data) errors.push({ code: 'e7', params: { key: legacy, canonical } });
  }
  const missing = [];
  if (!name) missing.push('name');
  if (!description) missing.push('description');
  if (missing.length) errors.push({ code: 'e3', params: { field: missing.join(' / ') } });
  if (name && (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX)) {
    errors.push({ code: 'e4', params: { name } });
  }
  if (name && opts.dirName && name !== opts.dirName) {
    warnings.push({ code: 'w1', params: { name, dir: opts.dirName } });
  }
  if (opts.hasScripts || RISKY_CONTENT_RE.test(fm.content)) warnings.push({ code: 'w2', params: {} });
  return { ok: errors.length === 0, errors, warnings, name, description, content: fm.content };
}

// ---------------------------------------------------------------------------
// zip extraction — GitHub codeload zips are plain store/deflate
// ---------------------------------------------------------------------------
/** Walk the central directory, yielding {name, raw, method} for every file
 * entry (directories skipped). Shared by the sync and async extractors so
 * the parse logic lives in exactly one place. */
function* zipEntries(b) {
  // locate the end-of-central-directory record (scan back over a possible
  // trailing comment, max 64 KiB per the zip spec)
  let eocd = -1;
  const scanFloor = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= scanFloor; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory record not found');
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('zip: corrupt central directory entry');
    }
    const method = b.readUInt16LE(off + 10);
    const compSize = b.readUInt32LE(off + 20);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const localOff = b.readUInt32LE(off + 42);
    const name = b.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory marker
    if (localOff + 30 > b.length || b.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(`zip: corrupt local header for ${name}`);
    }
    const lNameLen = b.readUInt16LE(localOff + 26);
    const lExtraLen = b.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(start, start + compSize);
    yield { name, raw, method };
  }
}

/** Extract a zip archive buffer into [{path, data}] (directories skipped).
 * Sync variant — pure in-memory helper kept for tests / small archives. */
function extractZipBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = [];
  let total = 0;
  for (const { name, raw, method } of zipEntries(b)) {
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    total += data.length;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('zip: decompressed size exceeds the safety cap');
    out.push({ path: name.replace(/\\/g, '/'), data });
  }
  return out;
}

/** Async extraction for the main-process install path (P1-4 win-jank fix):
 * inflates via the callback zlib API (non-blocking) and yields to the event
 * loop between entries, so a large repo zip can't freeze every window.
 * Identical results/errors to extractZipBuffer. */
async function extractZipBufferAsync(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = [];
  let total = 0;
  let i = 0;
  for (const { name, raw, method } of zipEntries(b)) {
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = await new Promise((resolve, reject) => {
      zlib.inflateRaw(raw, (err, outBuf) => (err ? reject(err) : resolve(outBuf)));
    });
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    total += data.length;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('zip: decompressed size exceeds the safety cap');
    out.push({ path: name.replace(/\\/g, '/'), data });
    if (++i % 16 === 0) await new Promise((resolve) => setImmediate(resolve)); // yield between chunks
  }
  return out;
}

/** Strip the single common root segment GitHub zips carry (`repo-sha/…`). */
function stripZipRoot(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return list;
  const first = list[0].path.split('/')[0];
  if (!first) return list;
  const shared = list.every((f) => f.path.startsWith(`${first}/`));
  if (!shared) return list;
  return list.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

/**
 * Locate installable skill bundles among repo-relative paths: a root
 * SKILL.md ('') and/or one-level `<dir>/SKILL.md` — exactly the two shapes
 * dsh discovers (deeper nested SKILL.md paths are deliberately unsupported;
 * NOTE: never write the glob form here — its characters close this comment).
 * Dot-directories are skipped (staging noise, .github, …).
 */
function findSkillCandidates(paths) {
  const set = new Set((Array.isArray(paths) ? paths : []).map(String));
  const dirs = [];
  if (set.has('SKILL.md')) dirs.push('');
  const first = new Set();
  for (const p of set) {
    const m = p.match(/^([^/]+)\/SKILL\.md$/);
    if (m && !m[1].startsWith('.')) first.add(m[1]);
  }
  for (const d of [...first].sort()) dirs.push(d);
  return dirs;
}

// ---------------------------------------------------------------------------
// market mapping (pure) — reuses awesome-dsh-plugin entries from market.js
// ---------------------------------------------------------------------------
/** Map curated market entries to the skills payload: only the 'skills'
 * category passes through (CATEGORY_MAP['Skills'].id), stars/installed
 * joined in. Both market forms (bundle-plugin skill packs and pure
 * SKILL.md repos) stay in the list — the form is detected at install time. */
function buildSkillsMarketPayload(entries, starMap, installedRepos) {
  const stars = starMap || {};
  const installed = installedRepos || new Set();
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.category === 'skills');
  return {
    count: list.length,
    skills: list.map((e) => {
      const meta = stars[e.fullName] || {};
      return {
        fullName: e.fullName,
        description: e.descZh || e.desc,
        descriptionEn: e.desc,
        stars: typeof meta.stars === 'number' ? meta.stars : null,
        updated: meta.updated || '',
        installed: installed.has(e.fullName),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// registry (shell-side install records: repo + pinned commit)
// ---------------------------------------------------------------------------
function readRegistry(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function writeRegistry(file, map) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// manager (fs + network orchestration)
// ---------------------------------------------------------------------------
/**
 * @param {object} deps
 *   dshHomeOf    () => DSH_HOME root (skills live in <DSH_HOME>/skills)
 *   stagingRoot  () => dir for downloaded repo zips (outside the skills root,
 *                 so dsh's chokidar never sees half-written trees)
 *   log          (line) => void
 *   progress     optional ({stage, tail}) => void — resolve/download/verify/write
 *   fetchImpl    injectable fetch (defaults to global fetch)
 *   now          injectable clock (defaults to Date.now)
 *   zipConnectTimeoutMs / zipTotalTimeoutMs — zip download abort budgets
 *                 (default 15s to response headers / 120s for the whole
 *                 transfer; tests shrink them to stay fast)
 */
function createSkillsManager(deps) {
  const { dshHomeOf, stagingRoot, log } = deps;
  const progress = deps.progress || (() => {});
  const doFetch = deps.fetchImpl || ((...a) => fetch(...a));
  const now = deps.now || Date.now;
  const zipConnectMs = deps.zipConnectTimeoutMs || ZIP_CONNECT_TIMEOUT_MS;
  const zipTotalMs = deps.zipTotalTimeoutMs || ZIP_TOTAL_TIMEOUT_MS;

  const skillsRoot = () => path.join(dshHomeOf(), 'skills');
  const registryFile = () => path.join(skillsRoot(), REGISTRY_FILE);
  const stagingDirOf = (fullName) => path.join(stagingRoot(), String(fullName).replace(/[^\w.-]+/g, '__'));

  /** One GitHub API JSON call with a 15s abort (fetchText cadence). */
  async function ghJson(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const res = await doFetch(url, {
        signal: ac.signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cockpit' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Download the repo zip pinned to the current default-branch commit.
   * Two abort budgets on the fetchText/ghJson cadence: response headers
   * within zipConnectMs (a hung connect) and the whole transfer within
   * zipTotalMs (a stalled body) — either abort becomes a readable error
   * so the caller's e6 path can surface it instead of hanging. */
  async function fetchRepoZip(fullName) {
    progress({ stage: 'resolve', tail: fullName });
    const repo = await ghJson(`https://api.github.com/repos/${fullName}`);
    const branch = repo.default_branch || 'main';
    const commitInfo = await ghJson(`https://api.github.com/repos/${fullName}/commits/${encodeURIComponent(branch)}`);
    const commit = String(commitInfo.sha || '');
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error('commit sha missing from commits API');
    progress({ stage: 'download', tail: commit.slice(0, 7) });
    const ac = new AbortController();
    let timeoutKind = ''; // '' | 'connect' | 'total'
    const connectTimer = setTimeout(() => { timeoutKind = 'connect'; ac.abort(); }, zipConnectMs);
    const totalTimer = setTimeout(() => { timeoutKind = 'total'; ac.abort(); }, zipTotalMs);
    try {
      let res;
      try {
        res = await doFetch(`https://codeload.github.com/${fullName}/zip/${commit}`, {
          headers: { 'user-agent': 'dsh-cockpit' },
          signal: ac.signal,
        });
      } finally {
        clearTimeout(connectTimer); // headers arrived — only the total cap remains
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const files = stripZipRoot(await extractZipBufferAsync(Buffer.from(await res.arrayBuffer())));
      return { branch, commit, files };
    } catch (e) {
      if (timeoutKind) {
        throw new Error(`zip download timed out (${timeoutKind === 'connect'
          ? `no response within ${Math.round(zipConnectMs / 1000)}s`
          : `not finished within ${Math.round(zipTotalMs / 1000)}s`})`);
      }
      throw e;
    } finally {
      clearTimeout(totalTimer);
    }
  }

  /** Materialize the repo zip into the staging dir (wiped first). Reuses an
   * existing staging dir unless `force` (upgrade needs a fresh pin). */
  async function stageRepo(fullName, force) {
    const dir = stagingDirOf(fullName);
    const manifestFile = path.join(dir, '.manifest.json');
    if (!force && fs.existsSync(manifestFile)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (m && m.fullName === fullName) {
          // staged content present — rescan without touching the network
          const cands = scanCandidatesFromDir(dir);
          return { commit: m.commit || '', dir, candidates: cands, reused: true };
        }
      } catch { /* no usable staging — download below */ }
    }
    const { commit, files } = await fetchRepoZip(fullName);
    // P1-4 (win-jank fix): all disk work is async via fsp — sync rmSync +
    // writeFileSync for hundreds of files froze the main process for seconds
    // under Windows AV; yield between writes so windows stay responsive.
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    for (const f of files) {
      const dest = path.join(dir, f.path);
      if (!dest.startsWith(dir + path.sep)) continue; // zip-slip guard
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, f.data);
      await new Promise((resolve) => setImmediate(resolve)); // yield between files
    }
    await fsp.writeFile(manifestFile, JSON.stringify({ fullName, commit, stagedAt: now() }));
    return { commit, dir, candidates: scanCandidatesFromDir(dir), reused: false };
  }

  /** Candidate skills inside an extracted repo dir. */
  function scanCandidatesFromDir(dir) {
    let paths = [];
    try { paths = fs.readdirSync(dir, { recursive: true }); } catch { return []; }
    const rel = paths
      .map(String)
      .map((p) => p.replace(/\\/g, '/')) // Windows recursive readdir uses '\'
      .filter((p) => !p.split('/').some((seg) => seg.startsWith('.') && seg !== '.'))
      .filter((p) => { try { return fs.statSync(path.join(dir, p)).isFile(); } catch { return false; } });
    const out = [];
    for (const cand of findSkillCandidates(rel)) {
      const sub = cand ? path.join(dir, cand) : dir;
      out.push(readCandidate(sub, cand));
    }
    return out;
  }

  /** Read + validate one candidate skill dir into a preview/install meta. */
  function readCandidate(skillDir, candDir) {
    const label = candDir || path.basename(skillDir);
    let text = '';
    try { text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'); } catch { /* missing — e1 at scan level */ }
    const hasScripts = fs.existsSync(path.join(skillDir, 'scripts'));
    const v = validateSkillMd(text, { dirName: candDir || undefined, hasScripts });
    return {
      dir: candDir,
      name: v.name || label,
      description: v.description,
      valid: v.ok,
      errors: v.errors,
      warnings: v.warnings,
      content: text,
    };
  }

  /**
   * Install one validated skill dir into <skillsRoot>/<name>/ atomically:
   * copy under a hidden tmp name inside the skills root, then a single
   * rename flips it into place — dsh's chokidar watcher never sees a
   * half-written <name>/ tree. The source (staging cache or the user's
   * import dir) is never moved or consumed. Failures always remove the
   * tmp tree so no partial skill is left behind. Async (fsp) — the sync
   * cpSync of a large tree pinned the main process (P1-4).
   */
  async function installDirFrom(srcDir, meta, record) {
    const root = skillsRoot();
    const dest = path.join(root, meta.name);
    const srcResolved = path.resolve(srcDir);
    if (srcResolved === path.resolve(dest)) return { ok: true, name: meta.name, warnings: meta.warnings }; // already in place
    if (dest.startsWith(srcResolved + path.sep)) return { ok: false, code: 'write', reason: 'source contains destination' };
    const tmp = path.join(root, `.tmp-${meta.name}-${process.pid}`);
    try {
      await fsp.mkdir(root, { recursive: true });
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.cp(srcResolved, tmp, { recursive: true });
      await fsp.rm(dest, { recursive: true, force: true }); // upgrade: replace old tree
      await fsp.rename(tmp, dest);
    } catch (e) {
      try { await fsp.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, code: 'write', reason: e.message };
    }
    const reg = readRegistry(registryFile());
    reg[meta.name] = { ...(record || {}), installedAt: new Date(now()).toISOString() };
    try { writeRegistry(registryFile(), reg); } catch (e) { log(`[skills] registry write failed: ${e.message}`); }
    return { ok: true, name: meta.name, warnings: meta.warnings };
  }

  /** Preview (security gate): full SKILL.md text of every candidate. */
  async function preview(fullName) {
    try {
      const staged = await stageRepo(fullName, false);
      if (!staged.candidates.length) return classifyEmpty(staged);
      return { ok: true, fullName, commit: staged.commit, candidates: staged.candidates };
    } catch (e) {
      return { ok: false, code: 'e6', errors: [{ code: 'e6', params: { msg: e.message } }] };
    }
  }

  /** Empty scan → plugin-form repo or E1 (not a skill package). */
  function classifyEmpty(staged) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(staged.dir, 'package.json'), 'utf8'));
      if (pkg && (pkg.dsh || pkg.dshBundle)) return { ok: false, code: 'plugin-form' };
    } catch { /* no package.json — plain non-skill repo */ }
    return { ok: false, code: 'e1', errors: [{ code: 'e1', params: {} }] };
  }

  /**
   * Install from a market repo. `pick`: undefined/null → single-candidate
   * auto-install, multi returns the candidate list for the user; a candidate
   * dir name installs that one; 'all' installs every valid candidate.
   */
  async function install(fullName, pick) {
    let staged;
    try {
      staged = await stageRepo(fullName, false);
    } catch (e) {
      return { ok: false, code: 'e6', errors: [{ code: 'e6', params: { msg: e.message } }] };
    }
    if (!staged.candidates.length) return classifyEmpty(staged);
    const valid = staged.candidates.filter((c) => c.valid);
    if (pick === undefined || pick === null) {
      if (staged.candidates.length > 1) {
        return { ok: false, code: 'multi', candidates: staged.candidates };
      }
      if (!valid.length) return { ok: false, code: 'invalid', errors: staged.candidates[0].errors };
    }
    let chosen;
    if (pick === 'all') chosen = valid;
    else if (pick) chosen = staged.candidates.filter((c) => c.dir === pick);
    else chosen = valid.slice(0, 1);
    if (!chosen.length) return { ok: false, code: 'invalid', errors: [{ code: 'e1', params: {} }] };
    const record = { repo: fullName, commit: staged.commit };
    const installed = [];
    const errors = [];
    for (const c of chosen) {
      if (!c.valid) { errors.push(...c.errors); continue; }
      progress({ stage: 'verify', tail: c.name });
      const sub = c.dir ? path.join(staged.dir, c.dir) : staged.dir;
      const r = await installDirFrom(sub, c, record);
      if (r.ok) installed.push({ name: r.name, warnings: r.warnings });
      else errors.push({ code: 'write', params: { msg: r.reason || '' } });
    }
    if (!installed.length) return { ok: false, code: 'invalid', errors };
    return { ok: true, installed, commit: staged.commit };
  }

  /** Remove an installed skill (dir + flat-file forms) and its record. */
  function remove(name) {
    if (!SKILL_NAME_RE.test(String(name || ''))) return { ok: false, code: 'invalid', reason: 'invalid skill name' };
    const root = skillsRoot();
    const targets = [path.join(root, name), path.join(root, `${name}.md`)];
    let removedSomething = false;
    for (const t of targets) {
      if (!path.resolve(t).startsWith(path.resolve(root) + path.sep)) continue;
      try {
        if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); removedSomething = true; }
      } catch (e) {
        return { ok: false, code: 'write', reason: e.message };
      }
    }
    const regFile = registryFile();
    const reg = readRegistry(regFile);
    if (name in reg) { removedSomething = true; }
    delete reg[name];
    try { writeRegistry(regFile, reg); } catch (e) { log(`[skills] registry write failed: ${e.message}`); }
    return removedSomething ? { ok: true, name } : { ok: false, code: 'missing' };
  }

  /** Upgrade: re-pin the latest default-branch commit and overwrite. */
  async function upgrade(name) {
    const reg = readRegistry(registryFile());
    const rec = reg[name];
    if (!rec || !rec.repo) return { ok: false, code: 'no-source' };
    let staged;
    try {
      staged = await stageRepo(rec.repo, true); // force: fetch the newest commit
    } catch (e) {
      return { ok: false, code: 'e6', errors: [{ code: 'e6', params: { msg: e.message } }] };
    }
    const cand = staged.candidates.find((c) => c.name === name) || staged.candidates.find((c) => c.dir === name);
    if (!cand || !cand.valid) {
      return { ok: false, code: 'upgrade-not-found', errors: cand ? cand.errors : undefined };
    }
    progress({ stage: 'verify', tail: name });
    const sub = cand.dir ? path.join(staged.dir, cand.dir) : staged.dir;
    const r = await installDirFrom(sub, cand, { repo: rec.repo, commit: staged.commit });
    if (!r.ok) return r;
    return { ok: true, installed: [{ name: r.name, warnings: r.warnings }], commit: staged.commit };
  }

  /** Import a local skill directory (Claude Skill compatible) — same
   * validation pipeline, recorded with a local source instead of a repo.
   * `pick` mirrors install(): undefined → single-candidate auto-import
   * (multi returns the candidate list), a dir name imports that one,
   * 'all' imports every valid candidate. Async because the atomic install
   * (installDirFrom) is now fsp-based (P1-4). */
  async function importLocal(dir, pick) {
    const src = path.resolve(String(dir || ''));
    let stat;
    try { stat = fs.statSync(src); } catch { return { ok: false, code: 'invalid', errors: [{ code: 'e1', params: {} }] }; }
    if (!stat.isDirectory()) return { ok: false, code: 'invalid', errors: [{ code: 'e1', params: {} }] };
    const cands = scanCandidatesFromDir(src);
    if (!cands.length) return { ok: false, code: 'e1', errors: [{ code: 'e1', params: {} }] };
    // a picked directory (root SKILL.md) installs directly; a collection
    // returns its candidates so the UI can offer the same picker as the market
    const rootCand = cands.find((c) => c.dir === '');
    if (pick === undefined || pick === null) {
      if (rootCand) {
        if (!rootCand.valid) return { ok: false, code: 'invalid', errors: rootCand.errors };
        const r = await installDirFrom(src, rootCand, { repo: null, source: 'local' });
        if (!r.ok) return r;
        return { ok: true, installed: [{ name: r.name, warnings: r.warnings }] };
      }
      if (cands.length > 1) return { ok: false, code: 'multi', candidates: cands };
      if (!cands[0].valid) return { ok: false, code: 'invalid', errors: cands[0].errors };
      const r = await installDirFrom(path.join(src, cands[0].dir), cands[0], { repo: null, source: 'local' });
      if (!r.ok) return r;
      return { ok: true, installed: [{ name: r.name, warnings: r.warnings }] };
    }
    const valid = cands.filter((c) => c.valid);
    let chosen;
    if (pick === 'all') chosen = valid;
    else chosen = cands.filter((c) => c.dir === pick);
    if (!chosen.length) return { ok: false, code: 'invalid', errors: [{ code: 'e1', params: {} }] };
    const installed = [];
    const errors = [];
    for (const c of chosen) {
      if (!c.valid) { errors.push(...c.errors); continue; }
      const sub = c.dir ? path.join(src, c.dir) : src;
      const r = await installDirFrom(sub, c, { repo: null, source: 'local' });
      if (r.ok) installed.push({ name: r.name, warnings: r.warnings });
      else errors.push({ code: 'write', params: { msg: r.reason || '' } });
    }
    if (!installed.length) return { ok: false, code: 'invalid', errors };
    return { ok: true, installed };
  }

  /** Live scan of <DSH_HOME>/skills — the directory is the source of truth
   * (manual drops included), the registry only adds repo/commit metadata. */
  function listInstalled() {
    const root = skillsRoot();
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    const reg = readRegistry(registryFile());
    const out = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // .system + our registry/tmp trees
      if (ent.isDirectory()) {
        const skillDir = path.join(root, ent.name);
        if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
        const v = validateSkillMd(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), {
          dirName: ent.name,
          hasScripts: fs.existsSync(path.join(skillDir, 'scripts')),
        });
        const rec = reg[v.name] || reg[ent.name] || {};
        out.push({
          name: v.name || ent.name,
          description: v.description,
          dir: true,
          errors: v.errors,
          warnings: v.warnings,
          repo: rec.repo || null,
          commit: rec.commit || null,
          source: rec.source || (rec.repo ? 'market' : null),
          installedAt: rec.installedAt || null,
        });
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        // flat single-file skill form: <root>/<name>.md (dsh discovers these too)
        let v;
        try {
          v = validateSkillMd(fs.readFileSync(path.join(root, ent.name), 'utf8'), {});
        } catch { continue; }
        const name = v.name || ent.name.replace(/\.md$/, '');
        const rec = reg[name] || {};
        out.push({
          name, description: v.description, dir: false,
          errors: v.errors, warnings: v.warnings,
          repo: rec.repo || null, commit: rec.commit || null,
          source: rec.source || (rec.repo ? 'market' : null),
          installedAt: rec.installedAt || null,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  return {
    skillsRoot,
    registryFile,
    listInstalled,
    preview,
    install,
    remove,
    upgrade,
    importLocal,
  };
}

module.exports = {
  SKILL_NAME_RE,
  LEGACY_INVOCATION_KEYS,
  parseFrontmatter,
  validateSkillMd,
  extractZipBuffer,
  extractZipBufferAsync,
  stripZipRoot,
  findSkillCandidates,
  buildSkillsMarketPayload,
  createSkillsManager,
};
