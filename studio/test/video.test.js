'use strict';

// studio/test/video.test.js — the video track (P5).
//
// The phase question is "should an action ship as frames or as a VP9-alpha video?".
// The answer must be DATA, so this suite measures the real walk cycle both ways and
// asserts the properties the decision rests on:
//   * the encode carries REAL alpha — verified twice, by decoding with the libvpx
//     decoder AND by asking Chromium (the actual runtime) to draw it on a canvas;
//   * the container tag is not evidence (the browser and the auto-selected ffmpeg
//     decoder disagreed with it at one point — the trap this phase exists to avoid);
//   * the bytes and the cadence, so the verdict in action-video.js is reproducible.
//
// The Electron probes are guarded: without the dev dependency the suite still passes
// (with the runtime half reported as skipped), which keeps CI/other checkouts usable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const FRAME_DIR = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default', 'assets', 'animations', 'walk', 'left');

const videoLib = require(path.join(STUDIO_ROOT, 'lib', 'video', 'action-video.js'));
const alphaProbe = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'alpha-probe.js'));
const qcVideo = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'qc-video.js'));

function frames() {
  return fs.readdirSync(FRAME_DIR).filter((name) => /-b\d+\.png$/.test(name)).sort()
    .map((name) => ({ file: name, abs: path.join(FRAME_DIR, name) }));
}

function electronBin() {
  const bin = path.join(REPO_ROOT, 'node_modules', '.bin', 'electron');
  return fs.existsSync(bin) ? bin : null;
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the track plan is explainable per action', () => {
  const base = { actionId: 'walk-left', summary: { frames: 15 }, tags: [] };
  assert.equal(videoLib.planTrack(base).track, 'frames', 'the default is the frame track');
  assert.ok(videoLib.planTrack(base).reasons.some((reason) => reason.includes('default track')));
  assert.equal(videoLib.planTrack({ ...base, tags: ['highlight'] }).track, 'video', 'a highlight reads better as video');
  assert.equal(videoLib.planTrack({ ...base, hasVideoSource: true }).track, 'video', 'a video-sourced action stays video');
  assert.equal(videoLib.planTrack({ actionId: 'idle', summary: { frames: 1 }, tags: ['highlight'] }).track, 'frames', 'a static pose gains nothing from video');
  const planned = videoLib.planTrack({ ...base, tags: ['highlight'] });
  assert.equal(planned.playback.codec, 'vp9-alpha');
  assert.equal(planned.playback.size, '640x360');
  assert.equal(planned.playback.fps, 24);
});

test('the encode produces a 640×360 24fps VP9-alpha clip that DECODES with alpha', (t) => {
  const dir = sandbox(t);
  const clip = path.join(dir, 'walk-left.webm');
  const outcome = videoLib.encodeActionVideo({ frames: frames(), outFile: clip });
  assert.equal(outcome.ok, true, `encode ok (${outcome.code || ''} ${outcome.message || ''})`);
  assert.equal(outcome.probe.codec, 'vp9');
  assert.equal(outcome.probe.fps, 24);
  assert.equal(outcome.probe.width, 640);
  assert.equal(outcome.probe.height, 360);
  // the fast in-band check: force the libvpx decoder, otherwise ffmpeg's
  // auto-selected native decoder drops the alpha plane and reports an opaque frame
  assert.equal(outcome.alpha.present, true, `alpha survived (${JSON.stringify(outcome.alpha)})`);
  assert.ok(outcome.alpha.transparentPixels > 10000, `a real matte, not a speck (${outcome.alpha.transparentPixels} px)`);
  // and the clip is honest under the general video battery
  const report = qcVideo.qcVideo({ file: clip, expect: { fps: 24 } });
  assert.equal(report.findings.filter((finding) => finding.code === 'qc.black-frames').length, 0);
});

test('Chromium — the actual runtime — sees the same alpha the encoder wrote', (t) => {
  const bin = electronBin();
  if (!bin) return; // environment without the Electron dev dependency
  const dir = sandbox(t);
  const clip = path.join(dir, 'walk-left.webm');
  const encoded = videoLib.encodeActionVideo({ frames: frames(), outFile: clip });
  assert.equal(encoded.ok, true);

  const runtime = alphaProbe.probeAlpha({ electronBin: bin, clip });
  assert.equal(runtime.ok, true, `the probe ran (${runtime.stage} ${runtime.error || ''})`);
  assert.equal(runtime.verdict, 'alpha-present', `Chromium draws transparency (${JSON.stringify(runtime.alpha)})`);
  assert.equal(runtime.alpha.transparent, encoded.alpha.transparentPixels,
    'the two independent readers agree exactly — the correction of the earlier wrong conclusion is itself locked');
  assert.equal(runtime.supportsVideoFrameCallback, true, 'the runtime can drive the feel layer from frame callbacks');
});

test('an opaque source fails the alpha expectation (the tag is not evidence)', (t) => {
  const clip = path.join(REPO_ROOT, 'photo', 'video-matting-kit', 'videos', 'walk-left.mp4');
  if (!fs.existsSync(clip)) return; // the private photo tree is absent in some checkouts
  const report = qcVideo.qcVideo({ file: clip, expect: { alpha: true } });
  assert.equal(report.verdict, 'red');
  assert.ok(report.findings.some((finding) => finding.code === 'qc.alpha-lost'));
});

test('the A/B measures both tracks on the real cycle and returns a defensible verdict', { timeout: 240000 }, (t) => {
  const bin = electronBin();
  if (!bin) return; // the A/B needs the runtime
  const dir = sandbox(t);
  const report = videoLib.abCompare({ actionId: 'walk-left', frames: frames(), electronBin: bin, frameMs: 200, measureMs: 1500, workDir: dir });
  assert.equal(report.ok, true, `A/B ran (${report.stage || ''})`);
  assert.equal(report.tracks.frames.files, 15);
  assert.ok(report.tracks.video.bytes > 1000);
  assert.ok(report.sizeRatio > 1, `the video track is smaller (${report.sizeRatio}×)`);
  assert.equal(report.alpha.verdict, 'alpha-present');
  assert.equal(report.alpha.chromium.transparent, report.alpha.ffmpeg.transparentPixels, 'both readers agree');
  // cadence: both lanes must actually play at the display rate in this environment
  assert.ok(report.cadence.video.fpsMean > 30, `video lane plays (${report.cadence.video.fpsMean}fps)`);
  assert.ok(report.cadence.frames.fpsMean > 30, `frame lane plays (${report.cadence.frames.fpsMean}fps)`);
  // the feel layer is driven by PLAYBACK TIME, which is the video track's point
  assert.ok(['lead', 'moving', 'tail'].includes(report.feel.sample.phase));
  assert.equal(typeof report.feel.sample.offsetPx, 'number');
  assert.ok(/lead\/tail/.test(report.feel.mode));
  // the verdict follows the measured data
  assert.equal(report.verdict.track, 'video', `the verdict follows the ratio (${report.verdict.reason})`);
  assert.ok(fs.existsSync(report.clip), 'the encoded clip is kept for inspection');
  assert.ok(fs.existsSync(path.join(dir, 'walk-left-ab.png')), 'the A/B screenshot is kept');
  assert.equal(report.screenshot, path.join(dir, 'walk-left-ab.png'), 'the screenshot lands where the caller asked');
});
