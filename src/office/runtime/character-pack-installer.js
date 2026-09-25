'use strict';

// src/office/runtime/character-pack-installer.js — Task 2 / SPEC-02.
//
// Pure CommonJS character pack installer. No Electron, no network, no
// pack-content execution. Import sources: local folder or local ZIP buffer
// (ZIP parsing uses node:zlib only — no undeclared archive dependencies, no
// external executables).
//
// Lifecycle: discovered -> validated -> installed -> active.
// - Imports extract into packsRoot/incoming/<importId>/ (same filesystem as
//   the packs root) and become packsRoot/<packId>/versions/<version>/ via an
//   atomic rename. A failed import/update removes its temp dir and never
//   touches the previously active pack.
// - ZIP safety: rejects traversal, absolute/drive paths, backslash names,
//   symlinks, encrypted entries, unknown compression methods, duplicate entry
//   names, entry-count/per-file/total-size limits and compression-ratio bombs
//   BEFORE inflating; verifies CRC-32 of every extracted entry.
// - Validation reuses ./validate-character-pack.js (the single source of
//   truth, internalized into src/ in P5) before installation and again
//   before activation.
// - Fallback order: selected pack -> pinned built-in pack -> stable
//   diagnostic placeholder error (never a blank scene).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomBytes } = require('node:crypto');

const { validateCharacterPack } = require('./validate-character-pack.js');

const LIMITS = Object.freeze({
  maxFileCount: 512,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxZipRatio: 200,
});
// Safe single path component for packId/version (also accepts semver-like
// versions). Anything that could escape a path join is rejected.
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const UNIX_MODE_MASK = 0o170000;
const UNIX_IFLNK = 0o120000;
const ALLOWED_EXTENSIONS = new Set(['.png', '.json']);
const ROOT_ALLOWED_FILES = new Set(['LICENSE', 'NOTICE']);

function errorWithCode(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// Defense in depth: packId/version become filesystem path segments, so they
// are re-validated here even when the caller bypasses the validator output.
function validatePackIdentity(packId, version) {
  if (typeof packId !== 'string' || !IDENTITY_PATTERN.test(packId)) {
    throw errorWithCode('PACK_MANIFEST_INVALID', `packId ${JSON.stringify(packId)} is not a safe single path component`);
  }
  if (typeof version !== 'string' || !IDENTITY_PATTERN.test(version)) {
    throw errorWithCode('PACK_MANIFEST_INVALID', `version ${JSON.stringify(version)} is not a safe single path component`);
  }
}

// Builds packsRoot/<packId>/versions/<version> only after identity validation
// and verifies the result stays inside packsRoot.
function versionPathInsidePacksRoot(packsRoot, packId, version) {
  validatePackIdentity(packId, version);
  const versionsRoot = path.join(packsRoot, packId, 'versions');
  const target = path.join(versionsRoot, version);
  const rootWithSep = path.resolve(packsRoot) + path.sep;
  if (!path.resolve(target).startsWith(rootWithSep)) {
    throw errorWithCode('PACK_MANIFEST_INVALID', `computed install path escapes packsRoot: ${packId}@${version}`);
  }
  return { versionsRoot, target };
}

function validateRelativePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 256) return 'invalid path';
  if (rel.includes('\0')) return 'NUL byte in path';
  if (rel.includes('\\')) return 'backslash in path';
  if (rel.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(rel)) return 'drive-absolute path';
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'traversal or empty segment';
  return null;
}

function extensionAllowed(rel) {
  const base = rel === 'LICENSE' || rel === 'NOTICE' || rel === 'manifest.json';
  if (base) return true;
  const ext = path.extname(rel).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// minimal ZIP reader (central directory based, safety-first)
// ---------------------------------------------------------------------------

function readZipEntries(buffer, limits) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw errorWithCode('PACK_UNSAFE_ARCHIVE', 'not a ZIP buffer');
  }
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw errorWithCode('PACK_UNSAFE_ARCHIVE', 'end of central directory not found');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > limits.maxFileCount) {
    throw errorWithCode('PACK_UNSAFE_ARCHIVE', `archive declares ${entryCount} entries (limit ${limits.maxFileCount})`);
  }
  if (cdSize > buffer.length || cdOffset > buffer.length) {
    throw errorWithCode('PACK_UNSAFE_ARCHIVE', 'central directory out of bounds');
  }

  const entries = [];
  const seenNames = new Set();
  let totalUncompressed = 0;
  let offset = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw errorWithCode('PACK_UNSAFE_ARCHIVE', 'corrupt central directory');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${name}: encrypted entries are not supported`);
    if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) {
      throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${name}: unsupported compression method ${method}`);
    }
    const pathError = validateRelativePath(name);
    if (pathError) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${name}: ${pathError}`);
    if (seenNames.has(name)) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${name}: duplicate entry name`);
    seenNames.add(name);

    const isDirectory = name.endsWith('/');
    if (!isDirectory) {
      const unixMode = externalAttrs >>> 16;
      if ((unixMode & UNIX_MODE_MASK) === UNIX_IFLNK) {
        throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${name}: symlink entries are not allowed`);
      }
      if (!extensionAllowed(name)) {
        throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${name}: file type not allowed in a character pack`);
      }
      if (uncompressedSize > limits.maxFileBytes) {
        throw errorWithCode('PACK_ASSET_TOO_LARGE', `${name}: ${uncompressedSize} bytes exceeds the per-file limit`);
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > limits.maxTotalBytes) {
        throw errorWithCode('PACK_ASSET_TOO_LARGE', `archive exceeds the total size limit (${limits.maxTotalBytes})`);
      }
      if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxZipRatio) {
        throw errorWithCode('PACK_ASSET_TOO_LARGE', `${name}: compression ratio ${Math.round(uncompressedSize / compressedSize)} exceeds ${limits.maxZipRatio} (zip bomb guard)`);
      }
    }

    entries.push({ name, isDirectory, method, crc, compressedSize, uncompressedSize, localOffset });
  }
  return entries;
}

function extractZip(buffer, entries, targetDir, limits) {
  for (const entry of entries) {
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${entry.name}: corrupt local header`);
    }
    const localNameLen = buffer.readUInt16LE(entry.localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(entry.localOffset + 28);
    const localName = buffer.toString('utf8', entry.localOffset + 30, entry.localOffset + 30 + localNameLen);
    if (localName !== entry.name) {
      throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${entry.name}: local header name mismatch`);
    }
    const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen;
    const payload = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let data;
    try {
      data = entry.method === ZIP_METHOD_DEFLATE ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    } catch (error) {
      throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${entry.name}: decompression failed (${error.message})`);
    }
    if (data.length !== entry.uncompressedSize) {
      throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${entry.name}: declared size ${entry.uncompressedSize} != actual ${data.length}`);
    }
    if (zlib.crc32(data) !== entry.crc) {
      throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${entry.name}: CRC-32 mismatch`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o644 });
  }
}

// ---------------------------------------------------------------------------
// installer
// ---------------------------------------------------------------------------

function createCharacterPackInstaller(options) {
  const opts = options || {};
  const packsRoot = path.resolve(opts.packsRoot);
  const builtinPackPath = opts.builtinPackPath ? path.resolve(opts.builtinPackPath) : null;
  const limits = { ...LIMITS, ...(opts.limits || {}) };

  fs.mkdirSync(packsRoot, { recursive: true });
  const incomingRoot = path.join(packsRoot, 'incoming');
  fs.mkdirSync(incomingRoot, { recursive: true });

  const imports = new Map(); // importId -> { state, packDir }
  let importCounter = 0;

  function importId() {
    importCounter += 1;
    return `import-${importCounter.toString(36)}-${randomBytes(4).toString('hex')}`;
  }

  function incomingDir(id) {
    return path.join(incomingRoot, id, 'pack');
  }

  function discardImport(id) {
    const record = imports.get(id);
    if (record) {
      fs.rmSync(path.join(incomingRoot, id), { recursive: true, force: true });
      imports.delete(id);
    }
  }

  function copyFolderTree(sourceDir, targetDir) {
    const stats = fs.lstatSync(sourceDir);
    if (!stats.isDirectory()) throw errorWithCode('PACK_UNSAFE_ARCHIVE', 'source must be a directory');
    let fileCount = 0;
    let totalBytes = 0;
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const pathError = validateRelativePath(relPath);
        if (pathError) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${relPath}: ${pathError}`);
        if (entry.isSymbolicLink()) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${relPath}: symlinks are not allowed`);
        if (entry.isDirectory()) {
          fs.mkdirSync(path.join(targetDir, relPath), { recursive: true });
          walk(abs, relPath);
          continue;
        }
        if (!entry.isFile()) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${relPath}: special files are not allowed`);
        const stat = fs.statSync(abs);
        // Hardlinks: a regular file with nlink > 1 aliases content outside the
        // pack (or another entry). Never silently copy or dereference it.
        if (stat.nlink > 1) {
          throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${relPath}: hardlinked file (nlink ${stat.nlink}) is not allowed`);
        }
        if (!extensionAllowed(relPath)) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `${relPath}: file type not allowed in a character pack`);
        const size = stat.size;
        if (size > limits.maxFileBytes) throw errorWithCode('PACK_ASSET_TOO_LARGE', `${relPath}: ${size} bytes exceeds the per-file limit`);
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) throw errorWithCode('PACK_ASSET_TOO_LARGE', `pack exceeds the total size limit (${limits.maxTotalBytes})`);
        fileCount += 1;
        if (fileCount > limits.maxFileCount) throw errorWithCode('PACK_UNSAFE_ARCHIVE', `pack contains more than ${limits.maxFileCount} files`);
        fs.mkdirSync(path.dirname(path.join(targetDir, relPath)), { recursive: true });
        fs.copyFileSync(abs, path.join(targetDir, relPath));
        fs.chmodSync(path.join(targetDir, relPath), 0o644);
      }
    };
    walk(sourceDir, '');
  }

  function readInstalledManifest(installPath) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(installPath, 'manifest.json'), 'utf8'));
    } catch (error) {
      throw errorWithCode('PACK_MANIFEST_INVALID', `cannot read installed manifest: ${error.message}`);
    }
    return manifest;
  }

  function validateStateOutcome(outcome) {
    if (outcome.ok) return outcome;
    const first = outcome.errors && outcome.errors[0];
    throw errorWithCode(first ? first.code : 'PACK_LOAD_FAILED', first ? first.message : 'pack validation failed');
  }

  return {
    importFromFolder(sourceDir) {
      const id = importId();
      const target = incomingDir(id);
      fs.mkdirSync(target, { recursive: true });
      try {
        copyFolderTree(path.resolve(sourceDir), target);
      } catch (error) {
        discardImport(id);
        throw error;
      }
      const record = { state: 'discovered', packDir: target };
      imports.set(id, record);
      return { importId: id, state: record.state };
    },

    importFromZip(zipBuffer) {
      const id = importId();
      const target = incomingDir(id);
      fs.mkdirSync(target, { recursive: true });
      try {
        const entries = readZipEntries(zipBuffer, limits);
        extractZip(zipBuffer, entries, target, limits);
      } catch (error) {
        discardImport(id);
        throw error;
      }
      const record = { state: 'discovered', packDir: target };
      imports.set(id, record);
      return { importId: id, state: record.state };
    },

    validateImport(id) {
      const record = imports.get(id);
      if (!record) throw errorWithCode('IMPORT_NOT_FOUND', `unknown import: ${id}`);
      if (record.state !== 'discovered') throw errorWithCode('INVALID_STATE', `import ${id} is ${record.state}, expected discovered`);
      let outcome;
      try {
        outcome = validateCharacterPack(record.packDir);
        validateStateOutcome(outcome);
      } catch (error) {
        discardImport(id); // failed import: clean the temp dir, keep the active pack
        throw error;
      }
      const manifest = readInstalledManifest(record.packDir);
      record.state = 'validated';
      return { importId: id, state: record.state, packId: manifest.id, version: manifest.version };
    },

    installImport(id) {
      const record = imports.get(id);
      if (!record) throw errorWithCode('IMPORT_NOT_FOUND', `unknown import: ${id}`);
      if (record.state !== 'validated') throw errorWithCode('INVALID_STATE', `import ${id} is ${record.state}, expected validated`);
      const manifest = readInstalledManifest(record.packDir);
      // Defense in depth: identity is validated here even though the
      // validator already rejected unsafe manifest identity fields.
      const { versionsRoot, target } = versionPathInsidePacksRoot(packsRoot, manifest.id, manifest.version);
      if (fs.existsSync(target)) {
        discardImport(id);
        throw errorWithCode('PACK_VERSION_EXISTS', `${manifest.id}@${manifest.version} is already installed`);
      }
      fs.mkdirSync(versionsRoot, { recursive: true });
      try {
        fs.renameSync(record.packDir, target); // same-filesystem atomic move
      } catch (error) {
        fs.rmSync(path.join(incomingRoot, id), { recursive: true, force: true });
        imports.delete(id);
        throw errorWithCode('PACK_LOAD_FAILED', `atomic install failed: ${error.message}`);
      }
      fs.rmSync(path.join(incomingRoot, id), { recursive: true, force: true });
      record.state = 'installed';
      record.installPath = target;
      return { importId: id, state: record.state, packId: manifest.id, version: manifest.version, installPath: target };
    },

    activate(packId, version) {
      const { target } = versionPathInsidePacksRoot(packsRoot, packId, version);
      if (!fs.existsSync(path.join(target, 'manifest.json'))) {
        throw errorWithCode('PACK_ASSET_MISSING', `cannot activate ${packId}@${version}: not installed`);
      }
      const outcome = validateCharacterPack(target);
      validateStateOutcome(outcome);
      // The pointer stays portable (no machine-specific absolute paths);
      // getActive() derives the install path under packsRoot.
      const pointerPath = path.join(packsRoot, 'active.json');
      const pointerTmp = `${pointerPath}.tmp`;
      fs.writeFileSync(pointerTmp, JSON.stringify({ packId, version }, null, 2));
      fs.renameSync(pointerTmp, pointerPath); // atomic; failed updates never touch it
      return { packId, version, installPath: target, state: 'active' };
    },

    getActive() {
      const pointerPath = path.join(packsRoot, 'active.json');
      if (!fs.existsSync(pointerPath)) return null;
      let pointer;
      try {
        pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
      } catch (error) {
        return null;
      }
      if (typeof pointer.packId !== 'string' || typeof pointer.version !== 'string') return null;
      const installPath = path.join(packsRoot, pointer.packId, 'versions', pointer.version);
      if (!fs.existsSync(path.join(installPath, 'manifest.json'))) return null;
      return { packId: pointer.packId, version: pointer.version, installPath, state: 'active' };
    },

    listInstalled() {
      const packsRootDir = packsRoot;
      const out = [];
      if (!fs.existsSync(packsRootDir)) return out;
      for (const packId of fs.readdirSync(packsRootDir).sort()) {
        const versionsDir = path.join(packsRootDir, packId, 'versions');
        if (!fs.existsSync(versionsDir)) continue;
        for (const version of fs.readdirSync(versionsDir).sort()) {
          out.push({ packId, version, installPath: path.join(versionsDir, version) });
        }
      }
      return out;
    },

    resolveRenderablePack(selectedPath) {
      if (selectedPath) {
        try {
          validateStateOutcome(validateCharacterPack(selectedPath));
          return { kind: 'pack', installPath: path.resolve(selectedPath) };
        } catch (error) {
          // fall through to the pinned builtin pack
        }
      }
      if (builtinPackPath) {
        try {
          validateStateOutcome(validateCharacterPack(builtinPackPath));
          return { kind: 'builtin', installPath: builtinPackPath };
        } catch (error) {
          // fall through to the diagnostic placeholder
        }
      }
      return { kind: 'placeholder', code: 'PACK_LOAD_FAILED' };
    },
  };
}

module.exports = { createCharacterPackInstaller, LIMITS };
