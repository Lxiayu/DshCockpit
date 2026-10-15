'use strict';

// studio/lib/project.js — the project model (brief §7A): a project IS a folder.
//
//   <project root>/
//     project.json                 ← this module's contract (schemaVersion 1)
//     content/… or the tree itself ← characters / scenes / graphs / dialogues / provenance
//
// Honest note about THIS repo: the whale-girl authoring tree already exists and is
// shaped by production history (content/characters/<id>/{actions,assets,dialogue,
// provenance} + content/scenes/<id>/ + content/shared/dialogue/). The project model
// therefore DESCRIBES the real layout instead of forcing a new one: project.json
// declares where each domain lives, the loader resolves those declarations against
// the disk, and validation reports what is declared-but-missing. A brand-new project
// is created with the same defaults, so adopting the existing tree and creating a
// fresh one go through one code path.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PROJECT_FILE = 'project.json';
const SCHEMA_VERSION = 1;
const KIND_SCENE_AUTHORING = 'scene-authoring';

// Tool-owned / non-content paths: never part of a project's payload.
const EXCLUDED_DIR_NAMES = new Set(['build', '.DS_Store', 'node_modules', '.git', 'preview-pack']);
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store']);
const EXCLUDED_FILE_SUFFIXES = ['.tmp', '.log'];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(absPath) {
  return sha256(fs.readFileSync(absPath));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function relPath(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join('/');
}

// ---- defaults: the layout the real tree already uses -------------------------

function defaultLayout(characterIds = ['whale-girl'], sceneIds = ['flat']) {
  return {
    characters: characterIds.map((id) => ({ id, path: `characters/${id}` })),
    scenes: sceneIds.map((id) => ({ id, path: `scenes/${id}` })),
    graphs: [], // P6 writes graphs here; the directory appears on demand
    dialogues: ['shared/dialogue', ...characterIds.map((id) => `characters/${id}/dialogue`)],
    provenance: characterIds.map((id) => `characters/${id}/provenance`),
  };
}

function buildProject({ id, label, characterIds, sceneIds, createdAt }) {
  const layout = defaultLayout(characterIds, sceneIds);
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    label: label || id,
    kind: KIND_SCENE_AUTHORING,
    createdAt: createdAt || new Date().toISOString(),
    layout,
  };
}

// ---- validation --------------------------------------------------------------

function validateProject(project) {
  const violations = [];
  const push = (check, detail) => violations.push({ check, detail });
  if (!isPlainObject(project)) return { ok: false, violations: [{ check: 'project.shape', detail: 'project.json must be a JSON object' }] };
  if (project.schemaVersion !== SCHEMA_VERSION) push('project.schemaVersion', `expected ${SCHEMA_VERSION}, got ${JSON.stringify(project.schemaVersion)}`);
  if (typeof project.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(project.id)) push('project.id', 'id must be kebab-case [a-z0-9-], 1..64 chars');
  if (typeof project.label !== 'string' || !project.label.trim()) push('project.label', 'label must be a non-empty string');
  if (typeof project.kind !== 'string' || !project.kind) push('project.kind', 'kind must be a non-empty string');
  if (!isPlainObject(project.layout)) {
    push('project.layout', 'layout must be an object');
    return { ok: violations.length === 0, violations };
  }
  const { characters, scenes, graphs, dialogues, provenance } = project.layout;
  for (const [key, list] of [['characters', characters], ['scenes', scenes], ['graphs', graphs], ['dialogues', dialogues], ['provenance', provenance]]) {
    if (!Array.isArray(list)) {
      push(`project.layout.${key}`, 'must be an array');
      continue;
    }
    list.forEach((entry, index) => {
      const value = typeof entry === 'string' ? entry : entry && entry.path;
      const label2 = typeof entry === 'string' ? null : entry && entry.id;
      if (typeof value !== 'string' || !value.trim()) push(`project.layout.${key}[${index}]`, 'path must be a non-empty string');
      else if (path.isAbsolute(value) || value.split('/').includes('..')) push(`project.layout.${key}[${index}]`, `path must stay inside the project: ${value}`);
      if (label2 !== null && (typeof label2 !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(label2))) push(`project.layout.${key}[${index}].id`, 'id must be kebab-case');
    });
  }
  return { ok: violations.length === 0, violations };
}

// ---- loading / creating ------------------------------------------------------

function projectFileFor(root) {
  return path.join(root, PROJECT_FILE);
}

function loadProject({ root }) {
  const file = projectFileFor(root);
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'PROJECT_FILE_MISSING', file, message: `no ${PROJECT_FILE} under ${root}`, violations: [] };
  }
  let project;
  try {
    project = readJson(file);
  } catch (error) {
    return { ok: false, code: 'PROJECT_FILE_UNPARSEABLE', file, message: error.message, violations: [] };
  }
  const validation = validateProject(project);
  if (!validation.ok) return { ok: false, code: 'PROJECT_INVALID', file, project, violations: validation.violations };
  return { ok: true, code: null, file, root, project, layout: resolveLayout({ root, project }) };
}

// Turns the declared layout into absolute paths + existence facts. Anything the
// project declares but the disk does not have is reported, never silently dropped.
function resolveLayout({ root, project }) {
  const check = (rel) => {
    const abs = path.join(root, rel);
    return { path: rel, abs, exists: fs.existsSync(abs) };
  };
  const layout = project.layout;
  const entries = (list) => (list || []).map((entry) => {
    const rel = typeof entry === 'string' ? entry : entry.path;
    return { id: typeof entry === 'string' ? null : entry.id, ...check(rel) };
  });
  return {
    characters: entries(layout.characters),
    scenes: entries(layout.scenes),
    graphs: entries(layout.graphs),
    dialogues: entries(layout.dialogues),
    provenance: entries(layout.provenance),
  };
}

function missingPaths(layout) {
  const missing = [];
  for (const [key, list] of Object.entries(layout)) {
    for (const entry of list) if (!entry.exists) missing.push({ domain: key, path: entry.path });
  }
  return missing;
}

function createProject({ root, id, label, characterIds, sceneIds, dryRun = false }) {
  const file = projectFileFor(root);
  if (fs.existsSync(file)) {
    return { ok: false, code: 'PROJECT_EXISTS', file, message: `${PROJECT_FILE} already exists (adopt it instead of recreating)` };
  }
  const project = buildProject({ id, label, characterIds, sceneIds });
  const validation = validateProject(project);
  if (!validation.ok) return { ok: false, code: 'PROJECT_INVALID', violations: validation.violations };
  if (!dryRun) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  }
  return { ok: true, file, project, layout: resolveLayout({ root, project }) };
}

// ---- the content manifest (the .dshpack payload description) -----------------

function isExcluded(relPath) {
  const segments = relPath.split('/');
  if (segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment))) return true;
  const base = segments[segments.length - 1];
  if (EXCLUDED_FILE_NAMES.has(base)) return true;
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  // the params ledger is content (it is how a run stays reproducible); the
  // backups tree is tool output and already excluded via 'build'.
  return false;
}

// Every file under the roots the project declares, minus tool output. The
// project file itself is included so an imported pack is immediately loadable.
function listProjectFiles({ root, project }) {
  const roots = new Set([PROJECT_FILE]);
  for (const list of Object.values(project.layout)) {
    for (const entry of list) roots.add(typeof entry === 'string' ? entry : entry.path);
  }
  const files = [];
  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        visit(abs, rel);
      } else if (entry.isFile()) {
        if (isExcluded(rel)) continue;
        files.push(rel);
      }
    }
  };
  for (const rel of [...roots].sort()) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      if (!isExcluded(rel)) files.push(rel);
      continue;
    }
    visit(abs, rel);
  }
  return [...new Set(files)].sort();
}

// { files: [{path, bytes, sha256}], digest } — the digest is content-derived:
// same bytes ⇒ same digest, independent of timestamps or walk order.
function describeProject({ root, project }) {
  const files = listProjectFiles({ root, project }).map((rel) => {
    const abs = path.join(root, rel);
    const data = fs.readFileSync(abs);
    return { path: rel, bytes: data.length, sha256: sha256(data) };
  });
  const digest = sha256(Buffer.from(files.map((file) => `${file.path}:${file.sha256}`).join('\n'), 'utf8'));
  const bySuffix = {};
  for (const file of files) {
    const suffix = path.extname(file.path).toLowerCase() || '(none)';
    bySuffix[suffix] = (bySuffix[suffix] || 0) + 1;
  }
  return {
    files,
    digest,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    bySuffix,
    counts: {
      characters: project.layout.characters.length,
      scenes: project.layout.scenes.length,
      graphs: project.layout.graphs.length,
      dialogues: project.layout.dialogues.length,
      actions: files.filter((file) => /\/actions\/[^/]+\.json$/.test(`/${file.path}`)).length,
    },
  };
}

module.exports = {
  PROJECT_FILE,
  SCHEMA_VERSION,
  KIND_SCENE_AUTHORING,
  EXCLUDED_DIR_NAMES,
  buildProject,
  createProject,
  defaultLayout,
  describeProject,
  isExcluded,
  listProjectFiles,
  loadProject,
  missingPaths,
  projectFileFor,
  resolveLayout,
  sha256,
  sha256File,
  validateProject,
};
