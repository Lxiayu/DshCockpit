'use strict';

// studio/test/pipeline.test.js — the pipeline core (P4).
//
// Acceptance (brief §9 P4) has two halves and both are asserted on REAL material:
//   1. reproduce the historical defects (黑边/鬼影/跳帧) and produce a repair report:
//      the checks run over the shipped b-series, the retired C-card set and the
//      gen-1 frames — three generations of this project's own output;
//   2. 改一步只重跑一步: the content-addressed cache re-runs exactly the affected
//      segment and nothing upstream of it.
// Plus the supporting contracts: the matting order, the provider gate (model ↔ key),
// the video battery and the QC-blocks-publish rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const FRAME_DIR = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default', 'assets', 'animations', 'walk', 'left');

const qcFrames = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'qc-frames.js'));
const matting = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'matting.js'));
const cacheLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'cache.js'));
const { runPipeline } = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'orchestrate.js'));
const stages = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'stages.js'));
const providers = require(path.join(STUDIO_ROOT, 'lib', 'providers.js'));

function frameList(names) {
  return names.map((name) => ({ file: name, abs: path.join(FRAME_DIR, name) }));
}

function series(prefix) {
  return fs.readdirSync(FRAME_DIR).filter((name) => new RegExp(`-${prefix}\\d+\\.png$`).test(name)).sort();
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pipelineContext(dir, names) {
  const framesDir = path.join(dir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(FRAME_DIR, name), path.join(framesDir, name));
  const referencePath = path.join(dir, 'reference.png');
  fs.copyFileSync(path.join(REPO_ROOT, 'photo', 'output_nobg', 'action-eat.png'), referencePath);
  return {
    repoRoot: REPO_ROOT,
    contentDir: path.join(REPO_ROOT, 'content'),
    charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
    referencePath,
    frames: names.map((name) => ({ file: name, abs: path.join(framesDir, name) })),
    cleanedDir: path.join(dir, 'cleaned'),
    normalizedDir: path.join(dir, 'normalized'),
    qcReportPath: path.join(dir, 'qc', 'test.qc.json'),
    label: 'test-action',
    footLine: 296,
  };
}

// ---- 1. reproducing the historical defects ------------------------------------

test('the shipped b-series passes the frame gate (no crying wolf on approved art)', () => {
  const names = series('b');
  assert.equal(names.length, 15);
  const report = qcFrames.qcFrames({ frames: frameList(names), label: 'walk-left', footLine: 296, expectedSeries: names.map((name) => path.join(FRAME_DIR, name)) });
  assert.equal(report.stats.red, 0, `no blocking finding on the current art (${JSON.stringify(report.findings.filter((finding) => finding.severity === 'red'))})`);
  assert.equal(report.stats.medianFootLine, 296, 'the sole line is the declared one');
  // the two advisory classes we KNOW about are reported, not hidden
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('qc.residue-below-soles'), 'the sub-sole residue rows are reported');
  assert.equal(report.verdict, 'yellow', 'advisories do not block');
});

test('the retired C-card set reproduces the historical defects (gap, margin, jitter, drop)', () => {
  const names = series('c');
  assert.deepEqual(names, ['walk-left-c01.png', 'walk-left-c02.png', 'walk-left-c04.png', 'walk-left-c05.png'], 'c03 was cut away by the equal-thirds sheet slicing');
  const report = qcFrames.qcFrames({ frames: frameList(names), label: 'c-card', footLine: 296, expectedSeries: names.map((name) => path.join(FRAME_DIR, name)) });
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('qc.frame-gap'), 'the missing c03 is reported as a series hole');
  assert.ok(codes.includes('qc.safe-margin'), 'the right-edge margin breach is reported');
  assert.ok(codes.includes('qc.bbox-jitter'), 'the 46px centroid wander is reported');
  assert.ok(codes.includes('qc.motion-irregular'), 'the jump across the hole reads as a dropped frame');
  const gap = report.findings.find((finding) => finding.code === 'qc.frame-gap');
  assert.deepEqual(gap.missing, [3], 'the report names the missing number');
  assert.ok(gap.message.length > 0 && gap.fix.length > 0, 'the finding carries a message and a fix');
  assert.ok(report.stats.adjacentDistances.includes(14), `the adjacency outlier is measured (${report.stats.adjacentDistances})`);
});

const GEN1 = ['walk-left-01.png', 'walk-left-02.png', 'walk-left-03.png', 'walk-left-04.png'];

test('the gen-1 frames reproduce the wash-line residue below the sole line', () => {
  const names = GEN1;
  assert.equal(names.length, 4);
  const report = qcFrames.qcFrames({ frames: frameList(names), label: 'gen-1', footLine: 296, tolerancePx: 1 });
  const residue = report.findings.filter((finding) => finding.code === 'qc.residue-below-soles');
  assert.equal(residue.length, 4, 'every gen-1 frame carries the residue');
  // the measured shape of the defect: several rows of low-alpha wash below the soles
  const first = residue[0];
  assert.match(first.message, /row\(s\) below the sole line/);
  assert.ok(first.measured.footLine === 296, `the soles themselves are consistent (${first.measured.footLine})`);
  const worstRow = /worst row (\d+) α(\d+)/.exec(first.message);
  assert.ok(worstRow, `the report names the worst row (${first.message})`);
  assert.ok(Number(worstRow[1]) > 296 && Number(worstRow[1]) < 320, 'the wash sits just below the soles');
  assert.match(first.fix, /remove-bg|re-issue/, 'the repair suggestion is concrete');
});

// ---- 2. the matting repair ----------------------------------------------------

test('the matting repair clears the wash residue and keeps the order contract', (t) => {
  const dir = sandbox(t);
  const names = GEN1;
  const before = qcFrames.qcFrames({ frames: frameList(names), label: 'gen-1', footLine: 296 });
  assert.equal(before.findings.filter((finding) => finding.code === 'qc.residue-below-soles').length, 4);

  const cleanedDir = path.join(dir, 'cleaned');
  const outcome = stages.s4Matting({ frames: frameList(names), outDir: cleanedDir });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.order, ['unpremultiply', 'harden', 'removeNearBlack', 'trimBelowSoles'],
    'the documented order first (unpremultiply → harden → 去近黑), then the belt-and-braces sole cut');

  const after = qcFrames.qcFrames({
    frames: names.map((name) => ({ file: name, abs: path.join(cleanedDir, name) })),
    label: 'gen-1-cleaned',
    footLine: 296,
  });
  const residueAfter = after.findings.filter((finding) => finding.code === 'qc.residue-below-soles');
  assert.equal(residueAfter.length, 0, `the repair clears the residue (${JSON.stringify(residueAfter.map((finding) => finding.message))})`);
  // and the character itself survives (soles + height unchanged)
  assert.equal(after.stats.medianFootLine, before.stats.medianFootLine, 'the sole line is untouched');
  // the wash line INFLATED the measured height (its rows sit below the soles and the
  // bounds threshold counts them); the repair removes the phantom extension, so the
  // height shrinks by the residue band and never grows.
  assert.ok(after.stats.medianVisibleHeight <= before.stats.medianVisibleHeight, 'the repair can only shrink the phantom extension');
  assert.ok(before.stats.medianVisibleHeight - after.stats.medianVisibleHeight <= 10, `the correction matches the residue band (${before.stats.medianVisibleHeight} → ${after.stats.medianVisibleHeight})`);
});

test('cleanup steps are individually callable and idempotent on clean input', () => {
  const png = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
  const image = { width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4) };
  // a semi-transparent dark fringe pixel (the classic black edge)
  const offset = (1 * 4 + 1) * 4;
  image.data[offset] = 10; image.data[offset + 1] = 10; image.data[offset + 2] = 10; image.data[offset + 3] = 40;
  const removed = matting.removeNearBlack(image);
  assert.equal(removed.image.data[offset + 3], 0, 'the near-black fringe is dropped');
  assert.ok(removed.stats.nearBlackPixelsRemoved >= 1);

  const clean = matting.cleanup(image);
  assert.deepEqual(clean.steps.map((step) => step.step), ['unpremultiply', 'harden', 'removeNearBlack', 'trimBelowSoles']);
  const again = matting.cleanup(clean.image);
  assert.deepEqual(Buffer.compare(again.image.data, clean.image.data), 0, 'a second pass changes nothing');
});

// ---- 3. the cache: 改一步只重跑一步 ---------------------------------------------

test('the content-addressed cache re-runs exactly the affected segment', (t) => {
  const dir = sandbox(t);
  const names = series('b');
  const ctx = pipelineContext(dir, names);
  const cache = cacheLib.createCache({ repoRoot: dir, cacheDir: path.join(dir, '.studio-cache') });
  const stageIds = ['S0', 'S4', 'S5', 'S6'];

  const first = runPipeline({ ctx, stageIds, cache });
  assert.equal(first.ok, true, `cold run clean (${JSON.stringify(first.triage.map((entry) => entry.code))})`);
  assert.deepEqual(first.ran, ['S0', 'S4', 'S5', 'S6']);
  assert.deepEqual(first.cachedStages, []);

  const second = runPipeline({ ctx, stageIds, cache });
  assert.deepEqual(second.ran, [], `nothing changed ⇒ nothing re-runs (${JSON.stringify(second.ran)})`);
  assert.deepEqual(second.cachedStages, ['S0', 'S4', 'S5', 'S6']);

  // edit ONE frame's bytes: the frame stages re-run, the reference stage does not
  const victim = ctx.frames[3].abs;
  const png = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
  const image = png.decodePngFile(victim);
  image.data[0] = 255; image.data[1] = 0; image.data[2] = 0; image.data[3] = 255;
  fs.writeFileSync(victim, png.encodePng(image.data, image.width, image.height));

  const third = runPipeline({ ctx, stageIds, cache });
  assert.deepEqual(third.ran, ['S4', 'S5', 'S6'], `only the affected segment re-runs (${JSON.stringify(third.ran)})`);
  assert.deepEqual(third.cachedStages, ['S0'], 'the unrelated upstream stage stays cached');

  // swap the reference: only S0 re-runs
  fs.copyFileSync(path.join(REPO_ROOT, 'photo', 'output_nobg', 'action-jump.png'), ctx.referencePath);
  const fourth = runPipeline({ ctx, stageIds, cache });
  assert.deepEqual(fourth.ran, ['S0'], `a reference change re-runs the reference stage alone (${JSON.stringify(fourth.ran)})`);
  assert.deepEqual(fourth.cachedStages, ['S4', 'S5', 'S6']);

  const stats = cache.stats();
  assert.ok(stats.entries >= 4, `entries accumulate (${stats.entries})`);
});

test('the cache verifies its outputs: a hand-edited entry is a miss, not a lie', (t) => {
  const dir = sandbox(t);
  const cache = cacheLib.createCache({ repoRoot: dir, cacheDir: path.join(dir, '.studio-cache') });
  const source = path.join(dir, 'input.bin');
  fs.writeFileSync(source, 'original');
  const { key } = cache.keyFor({ stage: 'demo', params: { a: 1 }, inputs: { source } });
  const { dir: entryDir } = cache.put({ stage: 'demo', key, meta: { params: { a: 1 } }, outputs: { 'out.txt': Buffer.from('first') } });
  assert.equal(cache.get({ stage: 'demo', key }).hit, true);
  fs.writeFileSync(path.join(entryDir, 'out.txt'), 'tampered');
  const after = cache.get({ stage: 'demo', key });
  assert.equal(after.hit, false, 'a mutated cache output invalidates the entry');
  assert.equal(after.reason, 'CACHE_OUTPUT_CHANGED');
});

test('cache keys are content-addressed: a re-saved identical file still hits', (t) => {
  const dir = sandbox(t);
  const cache = cacheLib.createCache({ repoRoot: dir, cacheDir: path.join(dir, '.studio-cache') });
  const file = path.join(dir, 'frame.png');
  fs.copyFileSync(path.join(FRAME_DIR, 'walk-left-b01.png'), file);
  const first = cache.keyFor({ stage: 'S4', params: {}, inputs: { frames: [file] } });
  fs.copyFileSync(path.join(FRAME_DIR, 'walk-left-b01.png'), file); // same bytes, new mtime
  const second = cache.keyFor({ stage: 'S4', params: {}, inputs: { frames: [file] } });
  assert.equal(second.key, first.key, 'mtime does not enter the key');
  fs.copyFileSync(path.join(FRAME_DIR, 'walk-left-b02.png'), file);
  const third = cache.keyFor({ stage: 'S4', params: {}, inputs: { frames: [file] } });
  assert.notEqual(third.key, first.key, 'content does');
});

// ---- 4. the provider gate -----------------------------------------------------

test('the provider gate maps models to providers and refuses a mismatch before any call', () => {
  assert.equal(providers.providerOfModel('gpt-image-2'), 'hebox');
  assert.equal(providers.providerOfModel('qwen-image-edit'), 'dashscope');
  assert.equal(providers.providerOfModel('gemini-3-pro'), 'tu-zi');
  assert.equal(providers.providerOfModel('grok-9'), null);

  const unknown = providers.resolveProvider({ model: 'grok-9', klass: 'image', env: {} });
  assert.equal(unknown.code, providers.MODEL_UNKNOWN);

  const missingKey = providers.resolveProvider({ model: 'qwen-image-edit', klass: 'image', env: {} });
  assert.equal(missingKey.code, providers.KEY_MISSING, 'a model without its key is refused');

  const wrongClass = providers.resolveProvider({ model: 'qwen-image-edit', klass: 'video', env: { DASHSCOPE_API_KEY: 'x'.repeat(24) } });
  assert.equal(wrongClass.code, providers.MODEL_KEY_MISMATCH, 'an image model cannot be used as a video model');

  const resolved = providers.resolveProvider({ model: 'qwen-image-edit', klass: 'image', env: { DASHSCOPE_API_KEY: `${'k'.repeat(24)}` } });
  assert.equal(resolved.ok, true);
  assert.match(resolved.keyFingerprint, /^kkkk…len=\d+sha=[0-9a-f]{12}$/, `the report carries a fingerprint (${resolved.keyFingerprint})`);
  assert.equal(JSON.stringify(resolved).includes('k'.repeat(24)), false, 'the key value never appears in the result object');
});

test('a payload carrying a live key is refused before it can be written', () => {
  const live = `${'s'.repeat(4)}-${'z'.repeat(30)}`;
  assert.throws(
    () => providers.assertNoKeyInPayload(`{"note":"${live}"}`, [live], 'params.json'),
    /PROVIDER_KEY_LEAK_SHAPE|PROVIDER_KEY_LEAK/,
  );
  assert.equal(providers.assertNoKeyInPayload('{"model":"qwen-image-edit"}', [], 'params.json'), true);
  // a report may carry a fingerprint
  const described = providers.describeRegistry(providers.DEFAULT_REGISTRY, {});
  assert.deepEqual(described.map((entry) => entry.keyStatus), ['missing', 'missing', 'missing', 'missing']);
});

test('model stages refuse without a provider and never fabricate a result', () => {
  const outcome = stages.stageById('S3').run({ ctx: { env: {} }, params: { model: 'wan2.2-animate' } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'PROVIDER_KEY_MISSING');
  assert.ok(outcome.plan, 'the request plan is built (and cacheable) even when the call cannot run');
  assert.equal(outcome.plan.beats.length, 10, 'the plan is a per-second beat sheet');
  assert.ok(outcome.plan.guardrails.some((line) => line.includes('no depth or perspective')), 'the prompt guardrails travel with the plan');
});

// ---- 5. video QC and the alpha encode ------------------------------------------

test('video QC measures the real source clips (and refuses honestly without ffmpeg)', () => {
  const qcVideo = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'qc-video.js'));
  const clip = path.join(REPO_ROOT, 'photo', 'video-matting-kit', 'videos', 'walk-left.mp4');
  if (!fs.existsSync(clip)) return; // the private photo tree is absent in some checkouts
  const report = qcVideo.qcVideo({ file: clip, expect: { fps: 24 } });
  assert.ok(['green', 'yellow'].includes(report.verdict), `the real clip is usable (${report.verdict}: ${JSON.stringify(report.findings)})`);
  assert.equal(report.probe.fps, 24, 'the source really is 24fps');
  assert.ok(report.probe.durationSec > 5, `duration measured (${report.probe.durationSec}s)`);
  assert.equal(report.blackSegments.length, 0, 'no black frames in the source');
  // the alpha expectation is what catches a lost alpha channel at encode time
  const noAlpha = qcVideo.qcVideo({ file: clip, expect: { alpha: true } });
  assert.equal(noAlpha.verdict, 'red');
  assert.ok(noAlpha.findings.some((finding) => finding.code === 'qc.alpha-lost'), 'an h264 source fails the alpha expectation');
});

test('S7 encodes a VP9-alpha WebM the decoder agrees with', (t) => {
  const dir = sandbox(t);
  const names = series('b').slice(0, 6);
  const frames = names.map((name) => ({ file: name, abs: path.join(FRAME_DIR, name) }));
  const out = path.join(dir, 'clip.webm');
  const outcome = stages.s7Encode({ frames, outFile: out, fps: 24 });
  if (!outcome.ok && outcome.code === 'QC_FFMPEG_UNAVAILABLE') return; // honest skip
  if (outcome.code === 'S7_ALPHA_PLANE_MISSING') {
    // This machine's ffmpeg tags alpha_mode=1 but writes no alpha plane (verified
    // across crf/lossless/auto-alt-ref variants). The gate must say so instead of
    // shipping a clip that only claims transparency.
    assert.ok(fs.existsSync(out), 'the encoded bytes exist (the container is valid, the plane is not)');
    assert.equal(outcome.findings[0].code, 'qc.alpha-lost');
    assert.match(outcome.findings[0].fix, /ffmpeg|frame track/, 'the failure names the fallback');
    return;
  }
  assert.equal(outcome.ok, true, `encode succeeded (${outcome.code || ''} ${outcome.message || ''})`);
  assert.ok(fs.existsSync(out) && fs.statSync(out).size > 1000, 'the clip has bytes');
  assert.equal(outcome.probe.fps, 24);
  assert.equal(outcome.alpha.present, true, 'the alpha plane is verified by decoding, not by the container tag');
  // a plain h264 source fails the same expectation — the tag is not evidence
  const qcVideo = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'qc-video.js'));
  const opaque = qcVideo.qcVideo({ file: path.join(REPO_ROOT, 'photo', 'video-matting-kit', 'videos', 'walk-left.mp4'), expect: { alpha: true } });
  assert.equal(opaque.verdict, 'red', 'an opaque source is refused when alpha is expected');
});

// ---- 6. the gate that blocks publish ------------------------------------------

test('a RED QC report on disk blocks the publish (S8)', (t) => {
  const dir = sandbox(t);
  const contentDir = path.join(dir, 'content');
  fs.mkdirSync(path.join(contentDir, 'build', 'qc'), { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'build', 'qc', 'walk-left.qc.json'), JSON.stringify({ verdict: 'red', findings: [{ code: 'qc.foot-drift', severity: 'red', message: 'sole line moved' }] }));
  const outcome = stages.s8Publish({ ctx: { contentDir, charactersRoot: path.join(dir, 'characters') }, actionId: 'walk-left' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'PUBLISH_BLOCKED_BY_QC');
  assert.match(outcome.findings[0].message, /RED QC report/);
});

test('the orchestrator sends an unfixable red finding to triage instead of looping forever', (t) => {
  const dir = sandbox(t);
  const names = series('c'); // the C-card set: a real gap + margin breach
  const ctx = pipelineContext(dir, names);
  const cache = cacheLib.createCache({ repoRoot: dir, cacheDir: path.join(dir, '.studio-cache') });
  // a broken frame that no parameter change can repair: 1×1 px of alpha
  const png = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
  const broken = Buffer.alloc(8 * 8 * 4);
  broken[3] = 255;
  fs.writeFileSync(ctx.frames[1].abs, png.encodePng(broken, 8, 8));
  const outcome = runPipeline({ ctx, stageIds: ['S4', 'S5'], cache, maxRetries: 2 });
  assert.equal(outcome.ok, false, 'a red finding fails the run');
  assert.ok(outcome.triage.length >= 1, `triage captured the failure (${JSON.stringify(outcome.triage.map((entry) => entry.code))})`);
  const triage = outcome.triage[0];
  assert.ok(triage.attempts >= 1, 'the retry budget was spent before triage');
  assert.ok(triage.findings.length > 0, 'the triage entry carries the evidence');
  assert.equal(outcome.stages.find((stage) => stage.id === 'S6'), undefined, 'downstream stages do not run on a failed upstream stage');
});
