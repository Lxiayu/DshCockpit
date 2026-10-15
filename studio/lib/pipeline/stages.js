'use strict';

// studio/lib/pipeline/stages.js — S0…S8 as cacheable stages.
//
// Each stage declares (a) what it CONSUMES (that is its cache key), (b) what it
// produces, and (c) whether it needs an external model. A stage that needs a model
// and has none REFUSES (PROVIDER_NOT_CONFIGURED) — it never fabricates a result, and
// the refusal is cacheable too, so a pipeline plan can be built offline.
//
// Local stages are real: the frame QC, the matting cleanup, the normalization and the
// publish all run today. The model stages build a request PLAN (prompt + parameters +
// reference hash) and record it in the params ledger; actually calling the provider
// requires allowNetwork, which is off by default (brief §6: 生成 provider 占位配置).

const path = require('node:path');
const fs = require('node:fs');

const qcFramesLib = require('./qc-frames.js');
const qcVideoLib = require('./qc-video.js');
const matting = require('./matting.js');
const { canonical } = require('./cache.js');

function toolPath(relative) {
  return path.join(__dirname, '..', '..', '..', relative);
}

function framesFromList(frames) {
  return frames.map((frame) => (typeof frame === 'string' ? { file: path.basename(frame), abs: frame } : frame));
}

// ---- S0 reference check ------------------------------------------------------

function s0Reference({ referencePath }) {
  if (!referencePath || !fs.existsSync(referencePath)) {
    return { ok: false, code: 'S0_REFERENCE_MISSING', findings: [{ code: 'qc.reference-missing', severity: 'red', message: `reference image not found: ${referencePath}`, fix: 'pass a real reference PNG (the single baseline every asset is derived from)' }] };
  }
  const png = require(toolPath('src/workbench/lib/png-geometry.js'));
  const image = png.decodePngFile(referencePath);
  const findings = [];
  const { width, height } = image;
  if (width < 512 || height < 512) {
    findings.push({ code: 'qc.reference-too-small', severity: 'red', message: `reference is ${width}×${height}; the turnaround needs ≥512px on the short side`, fix: 're-export the reference at a usable size' });
  }
  let opaque = 0;
  let greenish = 0;
  let minAlpha = 255;
  const total = width * height;
  for (let index = 0; index < image.data.length; index += 4) {
    const r = image.data[index];
    const g = image.data[index + 1];
    const b = image.data[index + 2];
    const a = image.data[index + 3];
    if (a < minAlpha) minAlpha = a;
    if (a >= 128) {
      opaque += 1;
      if (g > 120 && g > r + 30 && g > b + 30) greenish += 1;
    }
  }
  const greenShare = opaque > 0 ? greenish / opaque : 0;
  if (minAlpha === 255 && greenShare < 0.05) {
    findings.push({ code: 'qc.reference-no-matte', severity: 'yellow', message: 'the reference has no transparency and almost no green — the studio cannot tell where the character is', fix: 'either mat it (green screen → remove-bg) or keep the green screen the pipeline expects' });
  }
  const aspect = width / height;
  if (aspect < 0.5 || aspect > 2) {
    findings.push({ code: 'qc.reference-aspect', severity: 'yellow', message: `aspect ${aspect.toFixed(2)} is unusual for a character reference (0.5–2 expected)`, fix: 'use a portrait-ish crop that contains the whole body' });
  }
  return {
    ok: findings.every((finding) => finding.severity !== 'red'),
    image: { width, height, minAlpha, greenShare: Number(greenShare.toFixed(4)) },
    findings,
  };
}

// ---- S1/S2/S3 model stages ---------------------------------------------------

// The prompt recipe is VERSIONED data (brief §4.2): a plan is a value we can cache,
// diff and hand to a human, and it names every guardrail the prompt must respect.
function buildPromptPlan({ kind, action, direction, referenceHash, beatSeconds = 10 }) {
  const beats = [];
  for (let second = 0; second < beatSeconds; second += 1) {
    beats.push({
      second: second + 1,
      instruction: second === 0
        ? 'standing still, feet locked to the canvas anchor, no props in frame'
        : second === beatSeconds - 1
          ? 'return to the exact standing pose of frame 1, props gone'
          : 'perform one beat of the action, no lateral movement (rotate in place only)',
    });
  }
  return {
    schemaVersion: 1,
    kind,
    action,
    direction,
    referenceHash,
    guardrails: [
      'green screen background (#00FF00), 16:9, no ground plane',
      'no depth or perspective wording in the prompt (it paints a floor)',
      'feet locked to the canvas anchor; in-place axis rotation only',
      'first and last frame are the same clean standing pose',
      'props follow the none → have → none closed loop, condensed within 0.5–1s',
      '10% safe margin on every side (ahoge, fins, skirt, tail)',
    ],
    negative: ['no camera movement', 'no ground', 'no shadow on the backdrop', 'no text', 'no watermark'],
    beats,
  };
}

function modelStage({ stage, klass, ctx, params }) {
  const providers = require('../providers.js');
  const resolved = providers.resolveProvider({ model: params.model, klass, env: ctx.env || process.env });
  const plan = buildPromptPlan({
    kind: stage,
    action: params.action || null,
    direction: params.direction || null,
    referenceHash: params.referenceHash || null,
    beatSeconds: params.beatSeconds || 10,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code === providers.KEY_MISSING ? 'PROVIDER_KEY_MISSING' : resolved.code,
      message: resolved.message,
      plan,
      findings: [{
        code: 'pipeline.provider-not-configured', severity: 'red',
        message: `${stage} needs ${klass} model ${JSON.stringify(params.model)}: ${resolved.message}`,
        fix: `generate this clip with your own agent and hand it over: \`node bin/agent.js prompts --action <id>\` gives the recipe, \`node bin/agent.js intake\` receives the delivery (see studio/skills/workbench/reference/generation-handoff.md). Configuring a provider key here is the OPTIONAL in-app path (studio/docs/providers.md §5).`,
      }],
    };
  }
  if (!ctx.allowNetwork) {
    return {
      ok: false,
      code: 'PROVIDER_NETWORK_NOT_ALLOWED',
      message: `${stage} is wired for ${resolved.provider}/${resolved.model} but network calls are off (pass allowNetwork)`,
      plan,
      provider: { name: resolved.provider, model: resolved.model, baseURL: resolved.baseURL, keyFingerprint: resolved.keyFingerprint, keySource: resolved.keySource },
      findings: [{
        code: 'pipeline.network-not-allowed', severity: 'yellow',
        message: `${stage} plan ready (provider ${resolved.provider}, model ${resolved.model}, key ${resolved.keyFingerprint}) — generation is opt-in`,
        fix: 're-run with allowNetwork to actually generate; the plan and its parameters are already ledgered',
      }],
    };
  }
  return { ok: false, code: 'PROVIDER_CALL_NOT_IMPLEMENTED', message: `${stage}: the HTTP call is intentionally not implemented in this phase; the plan is ready`, plan };
}

// ---- S4 matting cleanup ------------------------------------------------------

function s4Matting({ frames, outDir, options = {} }) {
  const results = [];
  const findings = [];
  for (const frame of framesFromList(frames)) {
    const outPath = outDir ? path.join(outDir, path.basename(frame.abs)) : null;
    const outcome = matting.cleanupFile({ absPath: frame.abs, outPath, options });
    if (!outcome.ok) {
      findings.push({ code: 'pipeline.matte-failed', severity: 'red', message: `${frame.file}: ${outcome.code}`, fix: 'check the frame file' });
      continue;
    }
    results.push({ file: frame.file, out: outPath, bytes: outcome.bytes.length, steps: outcome.steps, sha256: require('./cache.js').sha256(outcome.bytes) });
  }
  return { ok: findings.length === 0, order: matting.STEP_ORDER, frames: results, findings };
}

// ---- S5 quality gate ---------------------------------------------------------

function s5Quality({ frames, label = 'frames', footLine = null, tolerancePx = 1, expectedSeries = null, video = null, expect = {} }) {
  const findings = [];
  const report = {};
  if (video) {
    const videoReport = qcVideoLib.qcVideo({ file: video, expect });
    report.video = videoReport;
    findings.push(...(videoReport.findings || []));
    if (!videoReport.ok) findings.push(...(videoReport.findings || []).map((finding) => finding));
  }
  if (frames && frames.length > 0) {
    const lists = framesFromList(frames);
    const frameReport = qcFramesLib.qcFrames({ frames: lists, label, footLine, tolerancePx, expectedSeries: expectedSeries || lists.map((frame) => frame.abs) });
    report.frames = frameReport;
    findings.push(...frameReport.findings);
  }
  const reds = findings.filter((finding) => finding.severity === 'red');
  return { ok: reds.length === 0, verdict: reds.length > 0 ? 'red' : (findings.length > 0 ? 'yellow' : 'green'), report, findings };
}

// ---- S6 normalization --------------------------------------------------------

function s6Normalize({ frames, outDir, footLine = 296, packCanvas = 352, packAnchor = { x: 178, y: 296 }, targetHeight = null }) {
  const normalizer = require(toolPath('src/workbench/lib/normalizer.js'));
  const geometry = require(toolPath('src/workbench/lib/character-geometry.js'));
  const lists = framesFromList(frames);
  const heights = lists.map((frame) => geometry.measureFrameFile(frame.abs)).filter((m) => m.ok).map((m) => m.visibleHeight);
  const target = targetHeight || (heights.length > 0 ? geometry.median(heights) : 256);
  const results = [];
  const findings = [];
  for (const frame of lists) {
    const outcome = normalizer.normalizeImportFrame({
      sourceBytes: fs.readFileSync(frame.abs),
      targetHeight: target,
      footLine,
      packCanvas,
      packAnchor,
    });
    if (!outcome.ok) {
      findings.push({ code: 'pipeline.normalize-failed', severity: 'red', message: `${frame.file}: ${outcome.violations.map((violation) => violation.check).join(',')}`, fix: 'the frame is outside the canvas or has no measurable content' });
      continue;
    }
    const outPath = outDir ? path.join(outDir, path.basename(frame.abs)) : null;
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, outcome.png);
    }
    results.push({ file: frame.file, out: outPath, metrics: outcome.metrics, sha256: require('./cache.js').sha256(outcome.png) });
  }
  return { ok: findings.length === 0, targetHeight: target, footLine, packCanvas, packAnchor, frames: results, findings };
}

// ---- S7 alpha video encode ---------------------------------------------------

// Decode one frame of the produced clip and look for real transparency.
//
// CORRECTION (2026-09-28): the alpha plane of a VP9-alpha WebM is only decoded when
// the LIBVPX wrapper is forced (`-c:v libvpx-vp9` as an INPUT option). FFmpeg's
// auto-selected native vp9 decoder silently drops it and reports an opaque frame —
// which is what led to the earlier (wrong) claim that this machine "cannot write
// alpha". Chromium sees the plane (verified: 191,875 transparent pixels on the same
// clip), and so does this invocation. studio/lib/pipeline/alpha-probe.js keeps the
// Chromium check as the authoritative runtime test; this one is the fast in-band one.
function verifyAlphaPlane({ ffmpeg, file }) {
  const { execFileSync } = require('node:child_process');
  const probeDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 's7-alpha-'));
  const framePath = path.join(probeDir, 'frame.png');
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', file, '-frames:v', '1', '-vf', 'format=rgba', framePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const png = require(toolPath('src/workbench/lib/png-geometry.js'));
    const image = png.decodePngFile(framePath);
    let transparent = 0;
    for (let index = 3; index < image.data.length; index += 4) if (image.data[index] === 0) transparent += 1;
    return { present: transparent > 0, transparentPixels: transparent, reason: transparent > 0 ? null : 'every decoded pixel is opaque' };
  } catch (error) {
    return { present: false, reason: `alpha probe failed: ${String(error.message).slice(0, 120)}` };
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

function s7Encode({ frames, outFile, fps = 24, crf = 40, size = '640x360', expectAlpha = true }) {
  const which = qcVideoLib.which('ffmpeg');
  if (!which) return { ok: false, code: 'QC_FFMPEG_UNAVAILABLE', message: 'ffmpeg is not on PATH' };
  const lists = framesFromList(frames);
  if (lists.length === 0) return { ok: false, code: 'PIPELINE_NO_FRAMES', message: 'no frames to encode' };
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 's7-'));
  try {
    lists.forEach((frame, index) => {
      fs.copyFileSync(frame.abs, path.join(tmpDir, `f${String(index).padStart(4, '0')}.png`));
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const { execFileSync } = require('node:child_process');
    execFileSync(which, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', String(fps), '-i', path.join(tmpDir, 'f%04d.png'),
      '-vf', `scale=${size}:flags=lanczos,format=yuva420p`,
      '-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-pix_fmt', 'yuva420p', '-r', String(fps), '-an', outFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const probe = qcVideoLib.ffprobeInfo({ file: outFile });
    // The muxer sets the `alpha_mode=1` tag even when the alpha PLANE did not make
    // it into the file (verified on this machine: every variant — crf/lossless/
    // auto-alt-ref 0 — decodes to an opaque frame while the tag claims alpha).
    // So the encode verifies the BYTES: extract a frame and count transparency.
    const alpha = verifyAlphaPlane({ ffmpeg: which, file: outFile });
    if (expectAlpha && !alpha.present) {
      return {
        ok: false,
        code: 'S7_ALPHA_PLANE_MISSING',
        message: `the encode produced ${probe.pixFmt} with alpha_mode=${probe.pixFmt ? '1' : '?'} but no transparent pixels survive (${alpha.reason})`,
        findings: [{
          code: 'qc.alpha-lost', severity: 'red',
          message: 'the VP9-alpha encode lost the alpha plane (the container tag would have said otherwise)',
          fix: 'check the encode parameters (-pix_fmt yuva420p + format=yuva420p); the Chromium probe (alpha-probe.js) is the authority',
        }],
        probe,
        out: outFile,
      };
    }
    return { ok: true, out: outFile, bytes: fs.statSync(outFile).size, probe, alpha };
  } catch (error) {
    return { ok: false, code: 'S7_ENCODE_FAILED', message: String(error.message).slice(0, 400) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- S8 publish --------------------------------------------------------------

function s8Publish({ ctx, actionId }) {
  const publisher = require(toolPath('src/workbench/lib/action-publisher.js'));
  const paths = publisher.createPaths({ contentDir: ctx.contentDir, charactersRoot: ctx.charactersRoot });
  const qcPath = path.join(ctx.contentDir, 'build', 'qc', `${actionId}.qc.json`);
  // the gate: a red QC report on disk blocks the publish (brief §5 S5: 不通过不许入包)
  if (fs.existsSync(qcPath)) {
    const report = JSON.parse(fs.readFileSync(qcPath, 'utf8'));
    if (report && report.verdict === 'red') {
      return {
        ok: false,
        code: 'PUBLISH_BLOCKED_BY_QC',
        findings: [{ code: 'pipeline.qc-blocked', severity: 'red', message: `${actionId} has a RED QC report (${report.findings.filter((finding) => finding.severity === 'red').length} blocking finding(s))`, fix: 'fix or triage the blocking findings, then re-run QC' }],
      };
    }
  }
  const outcome = publisher.publishAction({ contentDir: ctx.contentDir, charactersRoot: ctx.charactersRoot, actionId });
  return outcome.ok ? { ok: true, published: outcome.summary || null, noop: Boolean(outcome.noop), paths } : { ok: false, code: outcome.code || 'PUBLISH_REFUSED', findings: (outcome.violations || []).map((violation) => ({ code: 'pipeline.publish-refused', severity: 'red', message: `${violation.file} ${violation.check} ${violation.detail || ''}`, fix: 'fix the geometry/validation violation' })) };
}

// ---- the registry ------------------------------------------------------------
//
// `paramKeys` is the parameter whitelist that enters the stage's CACHE KEY: a
// parameter nobody reads cannot invalidate a stage (editing `packCanvas` must not
// re-run the matting). `consumes`/`produces` drive the chain: a stage consumes
// what an upstream stage produced, so its key follows those bytes.

const STAGES = Object.freeze([
  { id: 'S0', name: 'reference-check', providerClass: null, consumes: ['reference'], produces: ['reference-facts'], paramKeys: [], run: (input) => s0Reference(input) },
  { id: 'S1', name: 'turnaround', providerClass: 'image', consumes: ['reference'], produces: ['turnaround-image'], paramKeys: ['model', 'action', 'direction', 'beatSeconds', 'referenceHash'], run: (input) => modelStage({ stage: 'S1-turnaround', klass: 'image', ctx: input.ctx, params: input.params }) },
  { id: 'S2', name: 'direction-bases', providerClass: 'image', consumes: ['turnaround-image'], produces: ['direction-bases'], paramKeys: ['model', 'action', 'direction', 'beatSeconds', 'referenceHash'], run: (input) => modelStage({ stage: 'S2-direction-bases', klass: 'image', ctx: input.ctx, params: input.params }) },
  { id: 'S3', name: 'action-video', providerClass: 'video', consumes: ['direction-bases'], produces: ['action-video'], paramKeys: ['model', 'action', 'direction', 'beatSeconds', 'referenceHash'], run: (input) => modelStage({ stage: 'S3-action-video', klass: 'video', ctx: input.ctx, params: input.params }) },
  { id: 'S4', name: 'matting-cleanup', providerClass: null, consumes: ['frames'], produces: ['cleaned-frames'], paramKeys: ['options'], run: (input) => s4Matting(input) },
  { id: 'S5', name: 'quality-gate', providerClass: null, consumes: ['cleaned-frames', 'action-video'], produces: ['qc-report'], paramKeys: ['footLine', 'tolerancePx', 'expectedSeries', 'expect'], run: (input) => s5Quality(input) },
  { id: 'S6', name: 'normalize', providerClass: null, consumes: ['cleaned-frames', 'qc-report'], produces: ['normalized-frames'], paramKeys: ['footLine', 'packCanvas', 'packAnchor', 'targetHeight'], run: (input) => s6Normalize(input) },
  { id: 'S7', name: 'encode-alpha-video', providerClass: null, consumes: ['cleaned-frames'], produces: ['alpha-webm'], paramKeys: ['fps', 'crf', 'size', 'expectAlpha'], run: (input) => s7Encode(input) },
  { id: 'S8', name: 'publish', providerClass: null, consumes: ['normalized-frames', 'qc-report'], produces: ['pack-entry'], paramKeys: [], run: (input) => s8Publish(input) },
]);

function stageById(id) {
  return STAGES.find((stage) => stage.id === id) || null;
}

module.exports = {
  STAGES,
  buildPromptPlan,
  s0Reference,
  s4Matting,
  s5Quality,
  s6Normalize,
  s7Encode,
  s8Publish,
  verifyAlphaPlane,
  stageById,
  framesFromList,
};
