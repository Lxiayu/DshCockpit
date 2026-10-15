#!/usr/bin/env node
'use strict';

// studio/bin/video.js — the video track CLI (P5).
//
//   node studio/bin/video.js encode <actionId> [--out <webm>] [--size 640x360] [--fps 24] [--crf 40]
//   node studio/bin/video.js probe <clip.webm>          Chromium 实测 alpha（权威）
//   node studio/bin/video.js ab <actionId> [--frame-ms 200] [--measure 2500] [--out-dir <dir>]
//   node studio/bin/video.js plan <actionId>            这条动作该用哪条轨（含理由）
//
// 编码 = VP9-alpha（yuva420p）；alpha 必须**解码验证**（容器标签会说谎，ffmpeg 的默认解码器也会漏掉 alpha 平面）。

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const { createStudioServices } = require(path.join(STUDIO_ROOT, 'lib', 'studio-services.js'));
const videoLib = require(path.join(STUDIO_ROOT, 'lib', 'video', 'action-video.js'));
const alphaProbe = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'alpha-probe.js'));
const qcVideo = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'qc-video.js'));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; index += 1; }
    } else positional.push(token);
  }
  return { positional, flags };
}

const USAGE = `usage:
  video encode <actionId> [--out <webm>] [--size 640x360] [--fps 24] [--crf 40]
  video probe <clip.webm>
  video ab <actionId> [--frame-ms 200] [--measure 2500] [--out-dir <dir>]
  video plan <actionId>`;

function electronBin() {
  const bin = path.join(REPO_ROOT, 'node_modules', '.bin', 'electron');
  return fs.existsSync(bin) ? bin : null;
}

function actionFrames(actionId) {
  const studio = createStudioServices({
    repoRoot: REPO_ROOT,
    contentDir: path.join(REPO_ROOT, 'content'),
    charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
  });
  const bench = studio.actionBench(actionId);
  if (!bench.ok) return { ok: false, code: bench.code, message: bench.message };
  const frames = bench.frames.filter((frame) => frame.abs).map((frame) => ({ file: frame.file, abs: frame.abs }));
  if (frames.length === 0) return { ok: false, code: 'ACTION_NO_FRAMES', message: actionId };
  return { ok: true, frames, bench };
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (command === 'encode') {
    const actionId = positional[1];
    if (!actionId) { console.error(USAGE); return 2; }
    const loaded = actionFrames(actionId);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message || ''}`); return 1; }
    const out = flags.out ? path.resolve(String(flags.out)) : path.join(REPO_ROOT, 'content', 'build', 'video', `${actionId}.webm`);
    const outcome = videoLib.encodeActionVideo({
      frames: loaded.frames,
      outFile: out,
      size: flags.size ? String(flags.size) : undefined,
      fps: flags.fps ? Number(flags.fps) : undefined,
      crf: flags.crf ? Number(flags.crf) : undefined,
      verifyRuntime: Boolean(electronBin()),
      electronBin: electronBin(),
    });
    if (!outcome.ok) { console.error(`${outcome.code}: ${outcome.message || ''}`); return 1; }
    console.log(`已编码 ${out}`);
    console.log(`  ${outcome.probe.codec}/${outcome.probe.pixFmt} ${outcome.probe.width}×${outcome.probe.height} ${outcome.probe.fps}fps ${outcome.probe.durationSec}s · ${(outcome.bytes / 1024).toFixed(1)} KiB`);
    console.log(`  alpha（libvpx 解码）：${outcome.alpha.present ? `存在（${outcome.alpha.transparentPixels} 透明像素）` : '缺失'}`);
    if (outcome.runtimeAlpha) console.log(`  alpha（Chromium 实测）：${outcome.runtimeAlpha.verdict}（${outcome.runtimeAlpha.alpha ? outcome.runtimeAlpha.alpha.transparent : '-'} 透明像素）`);
    const sourceBytes = loaded.frames.reduce((sum, frame) => sum + fs.statSync(frame.abs).size, 0);
    console.log(`  体积对比：帧 ${(sourceBytes / 1024).toFixed(1)} KiB → 视频 ${(outcome.bytes / 1024).toFixed(1)} KiB（${(sourceBytes / outcome.bytes).toFixed(2)}×）`);
    return 0;
  }

  if (command === 'probe') {
    const clip = positional[1];
    if (!clip) { console.error(USAGE); return 2; }
    const bin = electronBin();
    if (!bin) { console.error('electron is not installed — the runtime alpha probe needs it'); return 1; }
    const report = alphaProbe.probeAlpha({ electronBin: bin, clip: path.resolve(clip) });
    console.log(JSON.stringify(report, null, 2));
    return report.verdict === 'alpha-present' ? 0 : 1;
  }

  if (command === 'ab') {
    const actionId = positional[1];
    if (!actionId) { console.error(USAGE); return 2; }
    const bin = electronBin();
    if (!bin) { console.error('electron is not installed — the A/B probe needs it'); return 1; }
    const loaded = actionFrames(actionId);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message || ''}`); return 1; }
    const outDir = flags['out-dir'] ? path.resolve(String(flags['out-dir'])) : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'video-ab-'));
    fs.mkdirSync(outDir, { recursive: true });
    const report = videoLib.abCompare({
      actionId,
      frames: loaded.frames,
      electronBin: bin,
      frameMs: flags['frame-ms'] ? Number(flags['frame-ms']) : 200,
      measureMs: flags.measure ? Number(flags.measure) : 2500,
      workDir: outDir,
    });
    if (!report.ok) { console.error(`A/B failed: ${report.stage} ${JSON.stringify(report.detail || {})}`); return 1; }
    const reportFile = path.join(outDir, `${actionId}-ab.json`);
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`A/B ${actionId}`);
    console.log(`  帧轨：${report.tracks.frames.files} 文件 / ${(report.tracks.frames.bytes / 1024).toFixed(1)} KiB`);
    console.log(`  视频轨：${report.tracks.video.codec} ${report.tracks.video.width}×${report.tracks.video.height} ${report.tracks.video.fps}fps / ${(report.tracks.video.bytes / 1024).toFixed(1)} KiB`);
    console.log(`  体积比：${report.sizeRatio}× ${report.sizeRatio >= 2 ? '（视频更小）' : ''}`);
    console.log(`  alpha：libvpx ${report.alpha.ffmpeg.present ? '有' : '无'} · Chromium ${report.alpha.verdict}`);
    console.log(`  节奏：视频 ${report.cadence && report.cadence.video ? `${report.cadence.video.fpsMean}fps（抖动 ${report.cadence.video.jitterMs}ms）` : '-'} · 帧 ${report.cadence && report.cadence.frames ? `${report.cadence.frames.fpsMean}fps（抖动 ${report.cadence.frames.jitterMs}ms）` : '-'}`);
    console.log(`  手感层：${report.feel.mode} · ${JSON.stringify(report.feel.sample)}`);
    console.log(`  判定：用 ${report.verdict.track} — ${report.verdict.reason}`);
    console.log(`  报告：${reportFile}${report.screenshot ? ` · 截图：${report.screenshot}` : ''}`);
    return 0;
  }

  if (command === 'plan') {
    const actionId = positional[1];
    if (!actionId) { console.error(USAGE); return 2; }
    const studio = createStudioServices({ repoRoot: REPO_ROOT, contentDir: path.join(REPO_ROOT, 'content'), charactersRoot: path.join(REPO_ROOT, 'resources', 'characters') });
    const shown = studio.actionShow(actionId);
    if (!shown.ok) { console.error(`${shown.code}: ${shown.message}`); return 1; }
    const plan = videoLib.planTrack({ actionId, summary: shown.summary, tags: shown.doc.tags, hasVideoSource: /video/i.test(String(shown.doc.notes || '')) });
    console.log(`${actionId} → ${plan.track}`);
    for (const reason of plan.reasons) console.log(`  · ${reason}`);
    if (plan.playback) console.log(`  播放参数：${JSON.stringify(plan.playback)}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, main, parseArgs };
