'use strict';

// studio/lib/video/action-video.js — the video track as a first-class asset (P5).
//
// Verdict of the A/B on the real walk cycle (studio/test/video.test.js + the evidence
// bundle studio-P5/):
//   * bytes: 91,813 (VP9-alpha 640×360) vs 1,053,040 (the 15 PNG frames) → 11.5× smaller
//   * alpha: identical in both readers (ffmpeg with the libvpx decoder AND Chromium)
//   * cadence: both lanes held 60fps in the probe (jitter ≤0.3ms) — no playback penalty
//   * the frame track keeps what video cannot express: per-frame anchors/geometry that
//     the pack contract measures and gates
// So: frames stay the DEFAULT track (brief §14), and the video track is offered where it
// wins — loop/highlight actions whose source is video, and any action whose purpose is
// motion smoothness rather than frame-exact geometry.
//
// Encoding recipe (verified on this machine, ffmpeg 7.1.1 / libvpx-vp9):
//   -framerate F -i frame%04d.png -vf scale=W:H:flags=lanczos,format=yuva420p
//   -c:v libvpx-vp9 -crf 40 -b:v 0 -pix_fmt yuva420p -r F -an out.webm
// and the alpha is verified by DECODING (two independent readers), never by the
// container tag.

const path = require('node:path');
const fs = require('node:fs');

const stages = require('../pipeline/stages.js');
const qcVideo = require('../pipeline/qc-video.js');

const PLAYBACK_SIZE = '640x360';
const PLAYBACK_FPS = 24;
const PLAYBACK_CRF = 40;

// Which track does an action deserve? The rule is data-driven and explainable:
//   * an action whose frames were REVIEWED and published with anchors → frames
//     (the runtime's existing path, per-frame geometry guaranteed)
//   * an action tagged as a highlight, or whose source is a video clip → video
function planTrack({ actionId, summary = null, tags = [], hasVideoSource = false } = {}) {
  const reasons = [];
  let track = 'frames';
  if (hasVideoSource) { track = 'video'; reasons.push('the source is a video clip — keeping it as video avoids the frame-extraction losses'); }
  if (tags.includes('highlight')) { track = 'video'; reasons.push('tagged highlight (a one-shot, motion-heavy beat reads better as video)'); }
  if (summary && summary.frames <= 2) { track = 'frames'; reasons.push('a static pose gains nothing from video'); }
  if (track === 'frames') reasons.push('default track: the pack contract measures per-frame anchors/geometry');
  return { actionId, track, reasons, playback: track === 'video' ? { size: PLAYBACK_SIZE, fps: PLAYBACK_FPS, crf: PLAYBACK_CRF, codec: 'vp9-alpha' } : null };
}

function encodeActionVideo({ frames, outFile, size = PLAYBACK_SIZE, fps = PLAYBACK_FPS, crf = PLAYBACK_CRF, verifyRuntime = false, electronBin = null }) {
  const outcome = stages.s7Encode({ frames, outFile, size, fps, crf });
  if (!outcome.ok) return outcome;
  const result = {
    ok: true,
    out: outFile,
    bytes: outcome.bytes,
    probe: outcome.probe,
    alpha: outcome.alpha,
  };
  if (verifyRuntime) {
    if (!electronBin) return { ...result, runtimeAlpha: { ok: false, code: 'ELECTRON_BIN_REQUIRED' } };
    const alphaProbe = require('../pipeline/alpha-probe.js');
    result.runtimeAlpha = alphaProbe.probeAlpha({ electronBin, clip: outFile });
  }
  return result;
}

// The full A/B for one action: both tracks, sided by side, measured.
function abCompare({ actionId, frames, electronBin, frameMs = 200, measureMs = 2500, workDir = null }) {
  const dir = workDir || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ab-'));
  const clip = path.join(dir, `${actionId}-video.webm`);
  const encoded = encodeActionVideo({ frames, outFile: clip, verifyRuntime: true, electronBin });
  if (!encoded.ok) return { ok: false, stage: 'encode', detail: encoded };

  const framePaths = frames.map((frame) => (typeof frame === 'string' ? frame : frame.abs));
  const frameBytes = framePaths.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const ab = require('./ab-probe.js').abProbe({ electronBin, clip, framePaths, frameMs, measureMs, screenshotPath: path.join(dir, `${actionId}-ab.png`) });

  return {
    ok: ab.ok,
    actionId,
    tracks: {
      frames: { files: framePaths.length, bytes: frameBytes, width: 352, height: 352 },
      video: {
        file: clip,
        bytes: encoded.bytes,
        width: encoded.probe.width,
        height: encoded.probe.height,
        fps: encoded.probe.fps,
        durationSec: encoded.probe.durationSec,
        codec: `${encoded.probe.codec}/${encoded.probe.pixFmt}`,
      },
    },
    sizeRatio: Number((frameBytes / encoded.bytes).toFixed(2)),
    alpha: { ffmpeg: encoded.alpha, chromium: encoded.runtimeAlpha ? encoded.runtimeAlpha.alpha : null, verdict: encoded.runtimeAlpha ? encoded.runtimeAlpha.verdict : null },
    cadence: ab.cadence || null,
    feel: { mode: ab.feelMode || null, sample: ab.feelSample || null },
    screenshot: ab.screenshot || null,
    verdict: (() => {
      const smaller = frameBytes / encoded.bytes;
      const alphaOk = encoded.alpha && encoded.alpha.present && (!encoded.runtimeAlpha || encoded.runtimeAlpha.verdict === 'alpha-present');
      if (!alphaOk) return { track: 'frames', reason: 'the video track did not carry verifiable alpha — do not ship it' };
      if (smaller >= 2) return { track: 'video', reason: `the video track is ${smaller.toFixed(1)}× smaller with verified alpha; use it where per-frame geometry is not the point (highlights, video-sourced actions)`, ratio: Number(smaller.toFixed(2)) };
      return { track: 'frames', reason: `the video track is only ${smaller.toFixed(1)}× smaller — the frame contract is worth more than the bytes`, ratio: Number(smaller.toFixed(2)) };
    })(),
    clip,
    dir,
  };
}

module.exports = { PLAYBACK_CRF, PLAYBACK_FPS, PLAYBACK_SIZE, abCompare, encodeActionVideo, planTrack };
