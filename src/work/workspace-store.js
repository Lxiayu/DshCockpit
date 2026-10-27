'use strict';

// src/work/workspace-store.js — 工作区与 Work Product 索引（v0.7 P1，壳侧）。
//
// 位置：与 team-shell-transport.js 同级 —— 它是**壳**的基础设施，不是 Team 内核
// （src/team/runtime/** 是纯 Node 零 fs 的门禁区）。这里允许 fs，但纪律如下：
//   - 只写 `<workspace>/.dsh/**`，永不写用户工作区的其他位置（P1 边界）；
//   - 索引只存**工作区相对路径**；绝对路径只存在于本模块的返回值里，供壳使用，
//     绝不进入 ExecutionEvent / Team fact / Office 快照；
//   - 索引是"面向人和 agent 可读的事实"（harness engineering）：任务、产物、来源、
//     digest 都能被下一次任务当上下文读取。
//
// 写入：临时文件 + rename 原子替换；读到损坏索引时 fail-closed（不静默重建，
// 否则会把用户的产物记录抹掉）。

const fsDefault = require('node:fs');
const pathDefault = require('node:path');
const crypto = require('node:crypto');

const WORK_SCHEMA_VERSION = 1;
const WORK_DIR = '.dsh';
const INDEX_FILE = 'index.json';
const META_FILE = 'work.json';
const ARTIFACTS_DIR = 'artifacts';
const WORKSPACE_NAME_RE = /^[\p{L}\p{N}._-]{1,40}$/u;
const MAX_ARTIFACT_READ_BYTES = 256 * 1024;
// Change capture (v0.7 P2 WP2): bounded so a huge project never stalls the UI.
const MANIFEST_MAX_FILES = 5000;
const MANIFEST_MAX_HASH_BYTES = 2 * 1024 * 1024;
const MANIFEST_MAX_HASHED_FILES = 200;
const MANIFEST_EXCLUDED_DIRS = new Set([
  '.dsh', '.git', 'node_modules', 'dist', 'out', 'build', '.cache', 'coverage',
  '.next', 'target', '.venv', 'venv', '.idea', '.vscode',
]);
const SHELL_DIGEST_RE = /^ref-sha256:[0-9a-f]{16}$/;

function codeError(code, message) {
  // 稳定码同时进 message，调用方（与测试）可以只看到一种可读的错误形状。
  return Object.assign(new Error(message ? `${code}: ${message}` : code), { code });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 词法相对路径校验：拒绝绝对路径、空段、`.` 与 `..`（不依赖 resolve 的根目录语义）。 */
function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '' || pathDefault.isAbsolute(relPath)) return false;
  return relPath.split(/[\\/]+/).every((part) => part !== '' && part !== '.' && part !== '..');
}

/** 工作区内的安全相对路径解析：拒绝绝对路径、空路径与 `..` 逃逸。 */
function resolveInside(rootPath, relPath) {
  if (!isSafeRelPath(relPath)) {
    throw codeError('WORK_PATH_INVALID', 'artifact path must be a workspace-relative string');
  }
  const abs = pathDefault.resolve(rootPath, relPath);
  const rel = pathDefault.relative(rootPath, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${pathDefault.sep}`) || pathDefault.isAbsolute(rel)) {
    throw codeError('WORK_PATH_INVALID', 'artifact path escapes the workspace');
  }
  return abs;
}

function emptyIndex(workspaceId) {
  return { schemaVersion: WORK_SCHEMA_VERSION, workspaceId, items: [], artifacts: [] };
}

/** 索引形状校验（fail-closed）。未知版本/缺数组 → WORK_INDEX_INVALID。 */
function validateIndex(value, workspaceId) {
  if (!isPlainObject(value)) throw codeError('WORK_INDEX_INVALID', 'index must be an object');
  if (value.schemaVersion !== WORK_SCHEMA_VERSION) {
    throw codeError('WORK_INDEX_INVALID', `unsupported index schemaVersion: ${value.schemaVersion}`);
  }
  if (value.workspaceId !== workspaceId) {
    throw codeError('WORK_INDEX_INVALID', 'index belongs to a different workspace');
  }
  if (!Array.isArray(value.items) || !Array.isArray(value.artifacts)) {
    throw codeError('WORK_INDEX_INVALID', 'index must carry items[] and artifacts[]');
  }
  for (const item of value.items) {
    if (!isPlainObject(item) || typeof item.workItemId !== 'string' || item.workItemId === '') {
      throw codeError('WORK_INDEX_INVALID', 'every work item needs a workItemId');
    }
    if (!Array.isArray(item.artifactRefs)) {
      throw codeError('WORK_INDEX_INVALID', 'every work item needs artifactRefs[]');
    }
  }
  for (const artifact of value.artifacts) {
    if (!isPlainObject(artifact) || typeof artifact.key !== 'string' || artifact.key === '') {
      throw codeError('WORK_INDEX_INVALID', 'every artifact needs a key');
    }
    if (typeof artifact.relPath !== 'string' || artifact.relPath === '') {
      throw codeError('WORK_INDEX_INVALID', 'every artifact needs a workspace-relative path');
    }
    if (!isSafeRelPath(artifact.relPath)) {
      throw codeError('WORK_INDEX_INVALID', 'artifact paths must stay inside the workspace');
    }
  }
  return value;
}

/**
 * @param {object} deps
 * @param {object} [deps.fs]  注入 fs（测试用）
 * @param {object} [deps.path] 注入 path（测试用）
 * @param {string} deps.homeDir 用户主目录（默认工作区根 ~/DshWorkspaces）
 * @param {string[]} [deps.forbiddenRoots] 不允许打开为工作区的目录（应用目录/userData）
 * @param {() => number} [deps.nowMs]
 * @param {(message: string) => void} [deps.log]
 */
function createWorkspaceStore({
  fs = fsDefault,
  path = pathDefault,
  homeDir,
  forbiddenRoots = [],
  nowMs = () => Date.now(),
  log = () => {},
  randomId = () => crypto.randomBytes(6).toString('hex'),
} = {}) {
  if (typeof homeDir !== 'string' || homeDir === '') {
    throw codeError('WORK_HOME_REQUIRED', 'workspace store needs a home directory');
  }
  const defaultRoot = path.join(homeDir, 'DshWorkspaces');
  // 每个已打开工作区的内存索引（写穿到磁盘；单进程单写者）。
  const openIndexes = new Map();

  function workspaceIdFor(absPath) {
    return `ws-${sha256Hex(Buffer.from(absPath, 'utf8')).slice(0, 8)}`;
  }

  function displayPathOf(absPath) {
    return absPath;
  }

  function assertNotForbidden(absPath) {
    for (const root of forbiddenRoots) {
      if (typeof root !== 'string' || root === '') continue;
      const rel = path.relative(path.resolve(root), absPath);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        throw codeError('WORK_PATH_FORBIDDEN', 'workspace must not live inside the application data');
      }
    }
  }

  function assertUsableDirectory(absPath) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      throw codeError('WORK_PATH_MISSING', 'workspace directory does not exist');
    }
    if (!stat.isDirectory()) throw codeError('WORK_PATH_NOT_DIR', 'workspace path must be a directory');
    try {
      fs.accessSync(absPath, fs.constants ? fs.constants.W_OK : 2);
    } catch {
      throw codeError('WORK_PATH_NOT_WRITABLE', 'workspace directory is not writable');
    }
  }

  function workDirOf(absPath) {
    return path.join(absPath, WORK_DIR);
  }

  /** 建 `.dsh/` 布局（幂等）。只创建目录与 work.json，不碰用户文件。 */
  function ensureLayout(absPath, workspaceId) {
    const dir = workDirOf(absPath);
    fs.mkdirSync(path.join(dir, ARTIFACTS_DIR), { recursive: true });
    const metaPath = path.join(dir, META_FILE);
    if (!fs.existsSync(metaPath)) {
      writeJsonAtomic(metaPath, {
        schemaVersion: WORK_SCHEMA_VERSION,
        workspaceId,
        createdAtMs: nowMs(),
      });
    }
    return dir;
  }

  function writeJsonAtomic(file, value) {
    const tmp = `${file}.tmp-${process.pid}-${nowMs()}-${randomId()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  function indexPathOf(absPath) {
    return path.join(workDirOf(absPath), INDEX_FILE);
  }

  function readIndex(absPath, workspaceId) {
    const cached = openIndexes.get(absPath);
    if (cached) return cached;
    const file = indexPathOf(absPath);
    let index;
    if (!fs.existsSync(file)) {
      index = emptyIndex(workspaceId);
    } else {
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (error) {
        throw codeError('WORK_INDEX_UNREADABLE', `cannot read index: ${error && error.message}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw codeError('WORK_INDEX_INVALID', 'index.json is not valid JSON (kept untouched)');
      }
      index = validateIndex(parsed, workspaceId);
    }
    openIndexes.set(absPath, index);
    return index;
  }

  function saveIndex(absPath, index) {
    writeJsonAtomic(indexPathOf(absPath), index);
    openIndexes.set(absPath, index);
    return index;
  }

  /** 显式写盘（调用方已在缓存索引上做过就地修改）。 */
  function flush(workspace) {
    const index = readIndex(workspace.path, workspace.workspaceId);
    return saveIndex(workspace.path, index);
  }

  function open({ path: rawPath, create } = {}) {
    let absPath;
    let workspaceId;
    if (create !== undefined) {
      const name = typeof create === 'string' ? create.trim() : '';
      if (!WORKSPACE_NAME_RE.test(name)) throw codeError('WORK_NAME_INVALID', 'invalid workspace name');
      absPath = path.join(defaultRoot, name);
      if (fs.existsSync(absPath)) {
        const entries = fs.readdirSync(absPath);
        if (entries.length > 0) throw codeError('WORK_NAME_TAKEN', 'workspace directory is not empty');
      }
      fs.mkdirSync(absPath, { recursive: true });
    } else {
      const candidate = typeof rawPath === 'string' ? rawPath.trim() : '';
      if (candidate === '' || !path.isAbsolute(candidate)) {
        throw codeError('WORK_PATH_INVALID', 'workspace path must be absolute');
      }
      absPath = path.resolve(candidate);
    }
    assertNotForbidden(absPath);
    assertUsableDirectory(absPath);
    workspaceId = workspaceIdFor(absPath);
    ensureLayout(absPath, workspaceId);
    const index = readIndex(absPath, workspaceId);
    if (!fs.existsSync(indexPathOf(absPath))) saveIndex(absPath, index);
    log(`[work] workspace opened (${workspaceId})`);
    return Object.freeze({
      path: absPath,
      workspaceId,
      displayPath: displayPathOf(absPath),
      index,
    });
  }

  function reload(workspace) {
    openIndexes.delete(workspace.path);
    const index = readIndex(workspace.path, workspace.workspaceId);
    return index;
  }

  function artifactRefOf({ role, kind }) {
    return `ref:${role}-${kind}`;
  }

  /**
   * 登记产物（幂等：同一 jobId+kind 只登记一次）。路径必须在工作区内。
   * 输入来自 transport 的 materialized 记录 + 当前任务上下文。
   */
  function registerArtifact(workspace, {
    jobId, kind, role, runRef = null, attempt = null,
    digest, artifactPath, bytes = null, atMs = nowMs(),
  } = {}) {
    if (typeof jobId !== 'string' || jobId === '') throw codeError('WORK_ARTIFACT_INVALID', 'jobId required');
    if (typeof kind !== 'string' || kind === '') throw codeError('WORK_ARTIFACT_INVALID', 'kind required');
    if (typeof digest !== 'string' || !/^(?:exec|ref)-sha256:[0-9a-f]{16}$/.test(digest)) {
      throw codeError('WORK_ARTIFACT_INVALID', 'digest must be an opaque exec-sha256 token');
    }
    const key = `${jobId}:${kind}`;
    const index = readIndex(workspace.path, workspace.workspaceId);
    if (index.artifacts.some((entry) => entry.key === key)) return index;
    const absArtifact = path.resolve(String(artifactPath || ''));
    const relPath = path.relative(workspace.path, absArtifact);
    if (relPath === '' || relPath.startsWith('..') || path.isAbsolute(relPath)) {
      throw codeError('WORK_PATH_INVALID', 'artifact must live inside the workspace');
    }
    index.artifacts.push({
      key,
      ref: artifactRefOf({ role, kind }),
      kind,
      relPath: relPath.split(path.sep).join('/'),
      digest,
      producerRole: role,
      runRef,
      attempt,
      bytes,
      createdAtMs: atMs,
    });
    saveIndex(workspace.path, index);
    log(`[work] artifact registered (${kind}, ${bytes === null ? '?' : bytes} bytes)`);
    return index;
  }

  function appendItem(workspace, item) {
    const index = readIndex(workspace.path, workspace.workspaceId);
    if (index.items.some((entry) => entry.workItemId === item.workItemId)) return index;
    index.items.push(item);
    saveIndex(workspace.path, index);
    return index;
  }

  function updateItem(workspace, workItemId, patch) {
    const index = readIndex(workspace.path, workspace.workspaceId);
    const item = index.items.find((entry) => entry.workItemId === workItemId);
    if (!item) throw codeError('WORK_ITEM_UNKNOWN', 'work item not found');
    Object.assign(item, patch);
    saveIndex(workspace.path, index);
    return index;
  }

  function attachArtifactToItem(workspace, workItemId, key) {
    const index = readIndex(workspace.path, workspace.workspaceId);
    const item = index.items.find((entry) => entry.workItemId === workItemId);
    if (!item) throw codeError('WORK_ITEM_UNKNOWN', 'work item not found');
    if (!item.artifactRefs.includes(key)) item.artifactRefs.push(key);
    saveIndex(workspace.path, index);
    return index;
  }

  function findArtifact(workspace, key) {
    const index = readIndex(workspace.path, workspace.workspaceId);
    return index.artifacts.find((entry) => entry.key === key || entry.ref === key) || null;
  }

  /** 读取产物正文（有界；打开前校验文件存在与 digest 一致）。 */
  function readArtifact(workspace, key, {
    maxBytes = MAX_ARTIFACT_READ_BYTES,
  } = {}) {
    const artifact = findArtifact(workspace, key);
    if (!artifact) throw codeError('WORK_ARTIFACT_UNKNOWN', 'artifact not found in index');
    const abs = resolveInside(workspace.path, artifact.relPath);
    if (!fs.existsSync(abs)) throw codeError('WORK_ARTIFACT_MISSING', 'artifact file is gone');
    const bytes = fs.readFileSync(abs);
    const expected = artifact.digest.replace(/^(?:exec|ref)-sha256:/, '');
    if (sha256Hex(bytes).slice(0, 16) !== expected) {
      throw codeError('WORK_ARTIFACT_DIGEST_MISMATCH', 'artifact bytes do not match the recorded digest');
    }
    if (bytes.length > maxBytes) {
      const text = bytes.subarray(0, maxBytes).toString('utf8');
      return Object.freeze({ ok: true, key: artifact.key, kind: artifact.kind, text, truncated: true, bytes: bytes.length });
    }
    return Object.freeze({ ok: true, key: artifact.key, kind: artifact.kind, text: bytes.toString('utf8'), truncated: false, bytes: bytes.length });
  }

  /**
   * 扫描工作区清单（v0.7 P2）：相对路径 → {size, mtimeMs}。
   * 排除自产目录与依赖目录；文件数/大小有上限（truncated 如实标注）。
   */
  function scanManifest(rootPath) {
    const files = Object.create(null);
    let count = 0;
    let truncated = false;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (count >= MANIFEST_MAX_FILES) { truncated = true; return; }
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (MANIFEST_EXCLUDED_DIRS.has(entry.name)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(rootPath, abs).split(path.sep).join('/');
        if (rel === '' || rel.startsWith('..')) continue;
        let stat;
        try { stat = fs.statSync(abs); } catch { continue; }
        files[rel] = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
        count += 1;
      }
    };
    walk(rootPath);
    return Object.freeze({ files, truncated });
  }

  /** 基线 → 现在的差异（added/modified/deleted；digest 只给变化项，且有上限）。 */
  function diffManifests(before, after, rootPath = null) {
    const prev = (before && before.files) || {};
    const next = (after && after.files) || {};
    const added = [];
    const modified = [];
    const deleted = [];
    for (const [rel, info] of Object.entries(next)) {
      if (!prev[rel]) added.push({ path: rel, size: info.size, digest: null });
      else if (prev[rel].size !== info.size || prev[rel].mtimeMs !== info.mtimeMs) {
        modified.push({ path: rel, size: info.size, digest: null });
      }
    }
    for (const rel of Object.keys(prev)) if (!next[rel]) deleted.push({ path: rel });
    // digests: bounded (200 files / 2MB each) — evidence, not a backup.
    let hashed = 0;
    for (const entry of [...added, ...modified]) {
      if (!rootPath || hashed >= MANIFEST_MAX_HASHED_FILES || entry.size > MANIFEST_MAX_HASH_BYTES) continue;
      try {
        const bytes = fs.readFileSync(path.join(rootPath, entry.path));
        entry.digest = `ref-sha256:${sha256Hex(bytes).slice(0, 16)}`;
        hashed += 1;
      } catch { /* unreadable: digest stays null (honest) */ }
    }
    return Object.freeze({
      added: Object.freeze(added),
      modified: Object.freeze(modified),
      deleted: Object.freeze(deleted),
      counts: Object.freeze({ added: added.length, modified: modified.length, deleted: deleted.length }),
      truncated: !!(before && before.truncated) || !!(after && after.truncated),
    });
  }

  /** 证据原文（验证日志等）落盘到 `.dsh/artifacts/<jobId>/`；返回相对路径。 */
  function writeEvidenceFile(workspace, { jobId, filename, text = '' } = {}) {
    if (typeof jobId !== 'string' || jobId === '') throw codeError('WORK_ARTIFACT_INVALID', 'jobId required');
    if (typeof filename !== 'string' || filename === '' || filename.includes('/') || filename.includes('\\')) {
      throw codeError('WORK_ARTIFACT_INVALID', 'filename must be a simple name');
    }
    const relPath = `${WORK_DIR}/${ARTIFACTS_DIR}/${jobId}/${filename}`;
    const abs = resolveInside(workspace.path, relPath);
    const bytes = Buffer.from(String(text), 'utf8');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return Object.freeze({ relPath, bytes: bytes.length, digest: `ref-sha256:${sha256Hex(bytes).slice(0, 16)}` });
  }

  /** 壳侧产物（workspace-patch / verification）：JSON 落盘 + 索引登记（幂等）。 */
  function registerShellArtifact(workspace, { jobId, kind, value, atMs = nowMs() } = {}) {
    if (typeof jobId !== 'string' || jobId === '') throw codeError('WORK_ARTIFACT_INVALID', 'jobId required');
    if (typeof kind !== 'string' || kind === '') throw codeError('WORK_ARTIFACT_INVALID', 'kind required');
    const key = `shell:${jobId}:${kind}`;
    const index = readIndex(workspace.path, workspace.workspaceId);
    if (index.artifacts.some((entry) => entry.key === key)) {
      return Object.freeze({ key, existing: true });
    }
    const relPath = `${WORK_DIR}/${ARTIFACTS_DIR}/${jobId}/${kind}.json`;
    const abs = resolveInside(workspace.path, relPath);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    const digest = `ref-sha256:${sha256Hex(bytes).slice(0, 16)}`;
    index.artifacts.push({
      key,
      ref: `ref:shell-${kind}`,
      kind,
      relPath,
      digest,
      producerRole: 'shell',
      runRef: null,
      attempt: null,
      bytes: bytes.length,
      createdAtMs: atMs,
    });
    saveIndex(workspace.path, index);
    return Object.freeze({ key, existing: false, relPath, digest, bytes: bytes.length });
  }

  /** 绝对路径只给壳的"打开/定位"动作；不进入任何快照。 */
  function absolutePathOf(workspace, key) {
    const artifact = findArtifact(workspace, key);
    if (!artifact) throw codeError('WORK_ARTIFACT_UNKNOWN', 'artifact not found in index');
    return resolveInside(workspace.path, artifact.relPath);
  }

  return Object.freeze({
    defaultRoot,
    open,
    reload,
    flush,
    readIndex: (workspace) => readIndex(workspace.path, workspace.workspaceId),
    scanManifest,
    diffManifests,
    writeEvidenceFile,
    registerShellArtifact,
    registerArtifact,
    appendItem,
    updateItem,
    attachArtifactToItem,
    findArtifact,
    readArtifact,
    absolutePathOf,
    // 诊断用（不含工作区内容的正文）
    describe: () => Object.freeze({ schemaVersion: WORK_SCHEMA_VERSION, openWorkspaces: openIndexes.size }),
  });
}

module.exports = {
  createWorkspaceStore,
  WORK_SCHEMA_VERSION,
  MAX_ARTIFACT_READ_BYTES,
  MANIFEST_MAX_FILES,
  resolveInside,
  isSafeRelPath,
  validateIndex,
};
