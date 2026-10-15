'use strict';

// studio/lib/pipeline/intake.js — the delivery door as a LIBRARY (R4).
//
// The security-critical half of this door already exists in bin/agent.js (the
// commit "harden the intake door against hostile delivery names"): a delivered
// file's name becomes a COMMAND-LINE VALUE for ffprobe/ffmpeg, so names are
// validated BEFORE anything is spawned. This module holds that validation as
// pure functions both doors share (agent.js and pipeline.js `run`), plus the
// delivery CONTRACT the pipeline enforces at its own door:
//
//   naming      plain file names only — letter/digit first, [A-Za-z0-9._-] after,
//               no path separators, no leading dash/space, no control characters
//               (INTAKE_UNSAFE_NAME — an unsafe name never reaches a process)
//   containment the file must resolve INSIDE the delivery directory and be a
//               REGULAR file (INTAKE_FILE_ESCAPES_DIR — a symlink cannot smuggle
//               in a path from outside)
//   type        extension whitelist per role (INTAKE_BAD_TYPE)
//   size        per-file byte cap (INTAKE_TOO_LARGE — a "delivery" is not a dump)
//   dimensions  decoded/measured bounds (INTAKE_TOO_SMALL / INTAKE_TOO_BIG)
//   duration    for video: 2–20s and a sane fps (INTAKE_TOO_SHORT / _TOO_LONG /
//               _FPS_OFF / INTAKE_PROBE_FAILED)
//
// The deep green-screen analysis (first/last frame ratios, foot-line drift) stays
// in `agent.js intake` — it needs ffmpeg frame extraction and belongs to the
// generation handoff. This door answers "is this delivery well-formed enough to
// enter the chain", which is what `pipeline run` needs before QC.

const path = require('node:path');
const fs = require('node:fs');

const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mov', 'webm', 'mkv']);
const IMAGE_EXTENSIONS = Object.freeze(['png']);
const ALL_EXTENSIONS = Object.freeze([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);

/** The hardened name shape: plain name, no separators, no leading dash/space. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_LIMITS = Object.freeze({
  maxBytesVideo: 64 * 1024 * 1024,
  maxBytesImage: 8 * 1024 * 1024,
  minShortSide: 240,
  maxLongSide: 4096,
  minDurationSec: 2,
  maxDurationSec: 20,
  minFps: 12,
  maxFps: 60,
});

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return match ? match[1].toLowerCase() : null;
}

function hasAllowedExtension(name, extensions = ALL_EXTENSIONS) {
  const ext = extensionOf(name);
  return ext !== null && extensions.includes(ext);
}

/**
 * The hardened name check (shared with bin/agent.js — ONE implementation, so the
 * two doors cannot drift apart). Plain names only; `extensions` narrows the type.
 */
function isSafeDeliveryName(name, { extensions = ALL_EXTENSIONS } = {}) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  if (!PLAIN_NAME.test(name)) return false;
  return hasAllowedExtension(name, extensions);
}

/** Containment: `abs` must really sit inside `dir` (no `..`, no absolute escape). */
function resolvesInside(dir, abs) {
  const root = path.resolve(dir);
  const target = path.resolve(abs);
  return target === root ? false : target.startsWith(`${root}${path.sep}`);
}

/** A symlink pointing elsewhere is not a regular file INSIDE the door. */
function isRegularFileInside(dir, abs) {
  if (!resolvesInside(dir, abs)) return { ok: false, code: 'INTAKE_FILE_ESCAPES_DIR', message: 'path escapes the delivery directory' };
  try {
    if (!fs.lstatSync(abs).isFile()) return { ok: false, code: 'INTAKE_FILE_ESCAPES_DIR', message: 'not a regular file (symlink/directory)' };
  } catch {
    return { ok: false, code: 'INTAKE_FILE_ESCAPES_DIR', message: 'cannot stat the file' };
  }
  return { ok: true };
}

function probeVideoFile(abs) {
  const qcVideo = require('./qc-video.js');
  if (!qcVideo.which('ffmpeg')) return { ok: false, code: 'INTAKE_PROBE_UNAVAILABLE', message: 'ffmpeg is not on PATH — the delivery cannot be measured' };
  const info = qcVideo.ffprobeInfo({ file: abs });
  if (!info || info.ok === false) return { ok: false, code: 'INTAKE_PROBE_FAILED', message: (info && info.message) || 'ffprobe could not read the clip' };
  return { ok: true, width: info.width, height: info.height, fps: info.fps, durationSec: info.durationSec };
}

function measureImageFile(abs) {
  const png = require(path.join(__dirname, '..', '..', '..', 'src', 'workbench', 'lib', 'png-geometry.js'));
  try {
    const image = png.decodePngFile(abs);
    return { ok: true, width: image.width, height: image.height };
  } catch (error) {
    return { ok: false, code: 'INTAKE_IMAGE_UNREADABLE', message: String(error.message).slice(0, 200) };
  }
}

function finding(severity, code, message, fix) {
  return { severity, code, message, fix };
}

/**
 * Validate one delivery directory. Returns the accepted entries (with their
 * measured facts) and the refused ones (with the reason). Nothing is spawned for
 * a file whose name failed the gate.
 *
 * `probe` is injectable so tests can measure without ffmpeg.
 */
function checkDelivery({ dir, extensions = ALL_EXTENSIONS, limits = {}, probe = null } = {}) {
  if (!dir) return { ok: false, code: 'INTAKE_DIR_REQUIRED', entries: [], refused: [], findings: [] };
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return { ok: false, code: 'INTAKE_DIR_MISSING', message: `delivery directory not found: ${absDir}`, entries: [], refused: [], findings: [] };
  }
  const caps = { ...DEFAULT_LIMITS, ...limits };
  const measure = probe || ((abs) => (extensionOf(abs) && VIDEO_EXTENSIONS.includes(extensionOf(abs)) ? probeVideoFile(abs) : measureImageFile(abs)));

  const entries = [];
  const refused = [];
  const findings = [];
  let names = [];
  try { names = fs.readdirSync(absDir).sort(); } catch (error) {
    return { ok: false, code: 'INTAKE_DIR_UNREADABLE', message: String(error.message), entries: [], refused: [], findings: [] };
  }

  for (const name of names) {
    const abs = path.join(absDir, name);
    // 1. the name gate — BEFORE any stat/probe/spawn
    if (!isSafeDeliveryName(name, { extensions })) {
      refused.push({ name, code: 'INTAKE_UNSAFE_NAME', message: `文件名 ${JSON.stringify(name)} 不安全（只接受字母/数字开头、不含路径分隔符与空格的普通文件名；类型限于 ${extensions.join('/')}）`, fix: 'rename the file to a plain name (letters/digits/._- only, known extension) and deliver it again' });
      continue;
    }
    // 2. containment + regular file
    const inside = isRegularFileInside(absDir, abs);
    if (!inside.ok) {
      refused.push({ name, code: inside.code, message: `${name} ${inside.message}`, fix: 'deliver a regular file inside the directory (no symlinks pointing outside)' });
      continue;
    }
    const kind = VIDEO_EXTENSIONS.includes(extensionOf(name)) ? 'video' : 'image';
    const bytes = fs.statSync(abs).size;
    const cap = kind === 'video' ? caps.maxBytesVideo : caps.maxBytesImage;
    const entry = { name, abs, kind, bytes, width: null, height: null, fps: null, durationSec: null, findings: [] };
    if (bytes > cap) {
      entry.findings.push(finding('red', 'INTAKE_TOO_LARGE', `${name} is ${(bytes / 1048576).toFixed(1)} MiB (cap ${(cap / 1048576).toFixed(1)} MiB)`, 'deliver a smaller file — a clip/frames set is not a dump site'));
    }
    const measured = measure(abs);
    if (!measured.ok) {
      entry.findings.push(finding('red', measured.code, `${name}: ${measured.message}`, 'fix the file (or install ffmpeg for video deliveries) and deliver again'));
    } else {
      entry.width = measured.width;
      entry.height = measured.height;
      entry.fps = measured.fps === undefined ? null : measured.fps;
      entry.durationSec = measured.durationSec === undefined ? null : measured.durationSec;
      const shortSide = Math.min(measured.width || 0, measured.height || 0);
      const longSide = Math.max(measured.width || 0, measured.height || 0);
      if (shortSide < caps.minShortSide) {
        entry.findings.push(finding('red', 'INTAKE_TOO_SMALL', `${name} is ${measured.width}×${measured.height} (short side ≥ ${caps.minShortSide} required)`, 're-export at a usable resolution'));
      }
      if (longSide > caps.maxLongSide) {
        entry.findings.push(finding('red', 'INTAKE_TOO_BIG', `${name} is ${measured.width}×${measured.height} (long side ≤ ${caps.maxLongSide})`, 'downscale before delivering'));
      }
      if (kind === 'video') {
        if (measured.durationSec !== null && measured.durationSec < caps.minDurationSec) {
          entry.findings.push(finding('red', 'INTAKE_TOO_SHORT', `${name} is ${measured.durationSec}s (≥ ${caps.minDurationSec}s required)`, 'deliver a longer take'));
        }
        if (measured.durationSec !== null && measured.durationSec > caps.maxDurationSec) {
          entry.findings.push(finding('yellow', 'INTAKE_TOO_LONG', `${name} is ${measured.durationSec}s (≤ ${caps.maxDurationSec}s keeps the encode small)`, 'trim the take'));
        }
        if (measured.fps !== null && (measured.fps < caps.minFps || measured.fps > caps.maxFps)) {
          entry.findings.push(finding('yellow', 'INTAKE_FPS_OFF', `${name} is ${measured.fps}fps (${caps.minFps}–${caps.maxFps} expected, ~24 preferred)`, 're-export at ~24fps'));
        }
      }
    }
    if (entry.findings.some((row) => row.severity === 'red')) refused.push({ name, code: entry.findings.find((row) => row.severity === 'red').code, message: entry.findings.map((row) => row.message).join(' / '), fix: entry.findings.map((row) => row.fix).filter(Boolean).join(' / '), findings: entry.findings });
    else entries.push(entry);
    findings.push(...entry.findings);
  }

  return {
    ok: refused.length === 0,
    dir: absDir,
    at: new Date().toISOString(),
    entries,
    refused,
    findings,
    limits: caps,
  };
}

module.exports = {
  ALL_EXTENSIONS,
  DEFAULT_LIMITS,
  IMAGE_EXTENSIONS,
  PLAIN_NAME,
  VIDEO_EXTENSIONS,
  checkDelivery,
  extensionOf,
  hasAllowedExtension,
  isRegularFileInside,
  isSafeDeliveryName,
  resolvesInside,
};
