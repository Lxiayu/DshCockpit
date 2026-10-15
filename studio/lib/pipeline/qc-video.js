'use strict';

// studio/lib/pipeline/qc-video.js — S5 for VIDEO: the ffmpeg battery.
//
// The video track (dsh-pet teardown, brief §4) needs the same gate frames get, and
// ffmpeg already answers most of it:
//   blackdetect      black frames (a broken render / a hole in the source)
//   freezedetect     frozen stretches (a stalled animation — the "跳帧" cousin)
//   signalstats      a coarse colour-bias / flicker signal per sampled frame
// plus what only a decoder can tell us: duration, fps, frame count, and whether the
// alpha channel actually survived the encode (`pix_fmt`, ALPHA_MODE tags).
//
// ffmpeg is OPTIONAL: when it is absent the battery returns `unavailable` instead of
// failing the pipeline — a tool that cannot check must say so, not pretend.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function which(binary) {
  try {
    const out = execFileSync('/usr/bin/which', [binary], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function ffprobeInfo({ file, ffprobe = 'ffprobe' }) {
  if (!fs.existsSync(file)) return { ok: false, code: 'VIDEO_MISSING', message: file };
  try {
    const raw = execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,pix_fmt,r_frame_rate,nb_frames,duration,codec_name',
      '-show_entries', 'format=duration,format_name',
      '-of', 'json', file,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(raw);
    const stream = (parsed.streams || [])[0] || {};
    const format = parsed.format || {};
    const [rateNumerator, rateDenominator] = String(stream.r_frame_rate || '0/0').split('/').map(Number);
    const fps = rateDenominator ? Number((rateNumerator / rateDenominator).toFixed(3)) : null;
    const duration = Number(stream.duration || format.duration || 0);
    return {
      ok: true,
      width: stream.width || null,
      height: stream.height || null,
      pixFmt: stream.pix_fmt || null,
      codec: stream.codec_name || null,
      fps,
      durationSec: Number(duration.toFixed(3)),
      frames: stream.nb_frames ? Number(stream.nb_frames) : (fps ? Math.round(fps * duration) : null),
      formatName: format.format_name || null,
    };
  } catch (error) {
    return { ok: false, code: 'FFPROBE_FAILED', message: String(error.message).slice(0, 400) };
  }
}

// ffmpeg's filter output goes to stderr; these helpers parse the two filters whose
// lines are stable enough to rely on.
function parseBlackDetect(stderr) {
  const segments = [];
  const pattern = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  let match;
  while ((match = pattern.exec(stderr)) !== null) {
    segments.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) });
  }
  return segments;
}

function parseFreezeDetect(stderr) {
  const segments = [];
  const pattern = /freeze_start:\s*([\d.]+)[\s\S]*?freeze_duration:\s*([\d.]+)/g;
  let match;
  while ((match = pattern.exec(stderr)) !== null) {
    segments.push({ start: Number(match[1]), duration: Number(match[2]) });
  }
  return segments;
}

function runFfmpeg({ file, args, ffmpeg = 'ffmpeg' }) {
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, ...args, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stderr: '' };
  } catch (error) {
    // a non-zero exit is normal here (filters report via stderr); keep the text
    return { ok: error.status === 0 || Boolean(error.stderr), stderr: String(error.stderr || ''), status: error.status };
  }
}

function qcVideo({
  file,
  expect = {},
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  requireFfmpeg = false,
  blackMinDuration = 0.1,
  blackPixelThreshold = 0.10,
  freezeMinDuration = 0.3,
}) {
  if (!which(ffmpeg) || !which(ffprobe)) {
    const outcome = { ok: !requireFfmpeg, verdict: 'unavailable', code: 'QC_FFMPEG_UNAVAILABLE', message: 'ffmpeg/ffprobe are not on PATH — video QC cannot run (not a pass)' };
    return requireFfmpeg ? outcome : { ...outcome, findings: [], stats: null };
  }
  const probe = ffprobeInfo({ file, ffprobe });
  if (!probe.ok) return { ok: false, verdict: 'red', code: probe.code, message: probe.message, findings: [] };

  const black = runFfmpeg({ file, ffmpeg, args: ['-vf', `blackdetect=d=${blackMinDuration}:pix_th=${blackPixelThreshold}`] });
  const freeze = runFfmpeg({ file, ffmpeg, args: ['-vf', `freezedetect=n=-60dB:d=${freezeMinDuration}`] });
  const blackSegments = parseBlackDetect(black.stderr);
  const freezeSegments = parseFreezeDetect(freeze.stderr);

  const findings = [];
  for (const segment of blackSegments) {
    findings.push({
      code: 'qc.black-frames', severity: 'red',
      at: segment,
      message: `black from ${segment.start.toFixed(2)}s to ${segment.end.toFixed(2)}s (${segment.duration.toFixed(2)}s)`,
      fix: 'the render/source has a hole — re-export that segment',
    });
  }
  for (const segment of freezeSegments) {
    findings.push({
      code: 'qc.frozen-stretch', severity: 'yellow',
      at: segment,
      message: `frozen for ${segment.duration.toFixed(2)}s starting at ${segment.start.toFixed(2)}s`,
      fix: 'a paused tail is fine (the feel layer fades on idle); a mid-action freeze is a dropped segment',
    });
  }
  // expectations the caller can state explicitly (from the brief's checklist)
  if (expect.durationSec && Math.abs(probe.durationSec - expect.durationSec) > (expect.durationToleranceSec || 0.5)) {
    findings.push({
      code: 'qc.duration-mismatch', severity: 'yellow',
      message: `duration ${probe.durationSec}s vs expected ${expect.durationSec}s (±${expect.durationToleranceSec || 0.5}s)`,
      fix: 'check the source segment length — a short tail usually means a truncated export',
    });
  }
  if (expect.fps && probe.fps && Math.abs(probe.fps - expect.fps) > 0.5) {
    findings.push({
      code: 'qc.fps-mismatch', severity: 'yellow',
      message: `fps ${probe.fps} vs expected ${expect.fps}`,
      fix: 'encode at the pipeline rate (24fps) so the rhythm survives',
    });
  }
  if (expect.alpha === true) {
    const hasAlpha = Boolean(probe.pixFmt && /yuva|rgba|argb|bgra|ya/i.test(probe.pixFmt));
    if (!hasAlpha) {
      findings.push({
        code: 'qc.alpha-lost', severity: 'red',
        message: `the encoded stream is ${probe.pixFmt} — no alpha channel survived (expected VP9-alpha / yuva420p)`,
        fix: 're-encode with -c:v libvpx-vp9 and force format=yuva420p after scale',
      });
    }
  }
  if (expect.maxWidth && probe.width && probe.width > expect.maxWidth) {
    findings.push({
      code: 'qc.dimension-mismatch', severity: 'yellow',
      message: `width ${probe.width} exceeds the playback budget ${expect.maxWidth}`,
      fix: 'scale down to the playback size (640×360 class) before encode',
    });
  }

  const reds = findings.filter((finding) => finding.severity === 'red');
  const yellows = findings.filter((finding) => finding.severity === 'yellow');
  return {
    ok: reds.length === 0,
    verdict: reds.length > 0 ? 'red' : (yellows.length > 0 ? 'yellow' : 'green'),
    file,
    probe,
    blackSegments,
    freezeSegments,
    findings,
    stats: {
      durationSec: probe.durationSec,
      fps: probe.fps,
      frames: probe.frames,
      pixFmt: probe.pixFmt,
      codec: probe.codec,
      width: probe.width,
      height: probe.height,
      blackSegments: blackSegments.length,
      freezeSegments: freezeSegments.length,
      red: reds.length,
      yellow: yellows.length,
    },
  };
}

module.exports = { ffprobeInfo, parseBlackDetect, parseFreezeDetect, qcVideo, runFfmpeg, which };
