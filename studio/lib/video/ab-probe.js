'use strict';

// studio/lib/video/ab-probe.js — the video-direct A/B harness (P5).
//
// One Electron window, one question: should an action ship as a FRAME SEQUENCE or as
// a VP9-alpha VIDEO? It plays both, side by side, over a checkerboard (so
// transparency is visible rather than inferred), measures what a renderer actually
// achieves (rAF cadence while the clip plays vs while the frames cycle) and captures
// a screenshot. The numbers — plus the bytes on disk — are the A/B data.
//
// The feel layer is demonstrated in the same window: a sprite driven by
// `video.currentTime` (playback-time displacement + landing squash), which is the
// point of the video track — 位移由播放时间驱动，步频天然同步.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>PROBE 临时数据（可关闭）</title>
<style>
  body { margin: 0; background: #101418; color: #e8eef5; font: 13px/1.4 -apple-system, "PingFang SC", sans-serif; }
  h2 { margin: 8px 12px; font-size: 14px; }
  #stage { position: relative; margin: 8px 12px; width: 960px; height: 360px;
           background: repeating-conic-gradient(#2a3038 0% 25%, #1d2228 0% 50%) 50% / 24px 24px; }
  .lane { position: absolute; top: 0; height: 360px; }
  #lane-video { left: 0; width: 640px; }
  #lane-frames { left: 640px; width: 320px; }
  canvas { position: absolute; top: 0; left: 0; }
  #feel { position: absolute; right: 8px; top: 8px; font-variant-numeric: tabular-nums; text-align: right; }
  #verdict { margin: 8px 12px; font-variant-numeric: tabular-nums; }
</style></head>
<body>
<h2>P5 A/B：左＝VP9-alpha 视频轨（含手感层：位移由 currentTime 驱动）· 右＝帧序列轨</h2>
<div id="stage">
  <div class="lane" id="lane-video"><canvas id="cv-video" width="640" height="360"></canvas></div>
  <div class="lane" id="lane-frames"><canvas id="cv-frames" width="320" height="360"></canvas></div>
  <div id="feel">feel: -</div>
</div>
<div id="verdict">measuring…</div>
<script>
(async () => {
  const result = { ok: false, stage: 'start' };
  const params = new URLSearchParams(location.search);
  const clip = params.get('clip');
  const frameUrls = (params.get('frames') || '').split(',').filter(Boolean);
  const frameMs = Number(params.get('frameMs') || 200);
  const measureMs = Number(params.get('measure') || 2500);

  const feel = {
    squashScale(progress) { return progress < 0.45 ? 1 - 0.55 * Math.pow(progress / 0.45, 2) : 0.45 + 0.55 * Math.min(1.12, 1 + 2.70158 * Math.pow((progress - 0.45) / 0.55 - 1, 3) + 1.70158 * Math.pow((progress - 0.45) / 0.55 - 1, 2)); },
    // The peer's constants (lead/tail = 2s) describe a ~10s clip. A short A/B clip
    // would spend its whole life in lead/tail, so below 5s the same shape is applied
    // as shares (20%/20%) — the probe reports which mode it used.
    displacement({ t, duration, distance }) {
      const fixed = duration >= 5;
      const lead = fixed ? 2 : duration * 0.2;
      const tail = fixed ? 2 : duration * 0.2;
      result.feelMode = fixed ? 'lead/tail 2s (peer constants)' : 'lead/tail 20% shares (short clip)';
      const span = Math.max(0.0001, duration - lead - tail);
      if (t <= lead) return { progress: 0, phase: 'lead' };
      if (t >= duration - tail) return { progress: 1, phase: 'tail' };
      return { progress: (t - lead) / span, phase: 'moving' };
    },
  };

  const videoCanvas = document.getElementById('cv-video');
  const framesCanvas = document.getElementById('cv-frames');
  const vctx = videoCanvas.getContext('2d');
  const fctx = framesCanvas.getContext('2d');
  const feelEl = document.getElementById('feel');

  // ---- the video lane (with the feel layer driven by playback time) ----
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.loop = true; video.preload = 'auto';
  video.src = clip;
  const videoReady = new Promise((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('video load failed'));
  });

  // ---- the frame lane ----
  const images = [];
  for (const url of frameUrls) {
    const img = new Image();
    img.src = url;
    images.push(img);
  }
  const framesReady = Promise.all(images.map((img) => new Promise((resolve) => {
    if (img.complete) resolve(); else { img.onload = resolve; img.onerror = resolve; }
  })));

  await Promise.all([videoReady, framesReady]);
  result.video = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, frames: frameUrls.length };
  result.tracks = { videoClip: clip, frameCount: frameUrls.length, frameMs };

  const intervals = { video: [], frames: [] };
  const laneClock = { video: performance.now(), frames: performance.now() };
  const sampler = (lane) => (now) => {
    const delta = now - laneClock[lane];
    laneClock[lane] = now;
    intervals[lane].push(delta);
  };

  function drawVideoLane() {
    const distance = 120;
    const { progress, phase } = feel.displacement({ t: video.currentTime, duration: video.duration || 10, distance });
    const landed = video.currentTime % 2 < 0.22;
    const squash = landed ? feel.squashScale((video.currentTime % 2) / 0.22) : 1;
    vctx.clearRect(0, 0, 640, 360);
    vctx.save();
    vctx.translate(progress * distance, 0);
    vctx.translate(320, 340);
    vctx.scale(1, squash);
    vctx.drawImage(video, -200, -320, 400, 320);
    vctx.restore();
    feelEl.textContent = 'feel: ' + phase + ' · progress ' + progress.toFixed(2)
      + ' · offset ' + (progress * distance).toFixed(0) + 'px · squash ' + squash.toFixed(3)
      + ' · t=' + video.currentTime.toFixed(2) + 's';
    result.feelSample = { phase, progress: Number(progress.toFixed(3)), offsetPx: Number((progress * distance).toFixed(1)), squash: Number(squash.toFixed(4)), currentTime: Number(video.currentTime.toFixed(2)) };
  }

  let frameTimer = null;
  function startFrameLane() {
    let index = 0;
    frameTimer = setInterval(() => {
      fctx.clearRect(0, 0, 320, 360);
      const img = images[index % Math.max(1, images.length)];
      if (img && img.complete) fctx.drawImage(img, 0, 0, 320, 360);
      index += 1;
    }, frameMs);
    return () => clearInterval(frameTimer);
  }

  // ---- measure: video lane first, then the frame lane ----
  async function measure(lane, draw, stop) {
    laneClock[lane] = performance.now();
    let running = true;
    const raf = (now) => {
      if (!running) return;
      sampler(lane)(now);
      draw();
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
    await new Promise((resolve) => setTimeout(resolve, measureMs));
    running = false;
    if (stop) stop();
    result.sampleCounts = { video: intervals.video.length, frames: intervals.frames.length };
  }

  video.currentTime = 0;
  await video.play().catch(() => {});
  await measure('video', drawVideoLane, null);
  const stopFrames = startFrameLane();
  await measure('frames', () => {}, stopFrames);
  video.pause();

  const summarize = (list) => {
    const clean = list.slice(2).filter((value) => value > 0);
    if (clean.length === 0) return null;
    const sorted = [...clean].sort((a, b) => a - b);
    const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
    return {
      samples: clean.length,
      fpsMean: Number((1000 / mean).toFixed(2)),
      fpsP95Low: Number((1000 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(2)),
      worstFrameMs: Number(sorted[sorted.length - 1].toFixed(2)),
      jitterMs: Number((sorted[sorted.length - 1] - sorted[0]).toFixed(2)),
    };
  };
  result.cadence = { video: summarize(intervals.video), frames: summarize(intervals.frames) };

  // final visual: video lane drawn over the checkerboard (transparency visible)
  drawVideoLane();
  result.ok = true;
  window.__abResult = result;
})();
</script>
</body></html>`;

const MAIN = `const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const OUT = process.env.AB_OUT;
const DATA = process.env.AB_DATA;
app.setPath('userData', DATA);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000, height: 470, show: false, title: 'PROBE 临时数据（可关闭）',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false },
  });
  const { writeFileSync } = fs;
  try {
    await win.loadURL(process.env.AB_URL);
    let payload = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      payload = await win.webContents.executeJavaScript('window.__abResult || null', true);
      if (payload) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (payload) {
      const image = await win.webContents.capturePage();
      writeFileSync(path.join(DATA, 'ab.png'), image.toPNG());
    }
    writeFileSync(OUT, JSON.stringify(payload || { ok: false, stage: 'timeout' }, null, 2));
  } catch (error) {
    writeFileSync(OUT, JSON.stringify({ ok: false, stage: 'main-error', error: String((error && error.message) || error) }, null, 2));
  } finally {
    win.destroy();
    app.exit(0);
  }
});
`;

function abProbe({ electronBin, clip, framePaths, frameMs = 200, measureMs = 2500, timeoutMs = 180000, screenshotPath = null }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-probe-'));
  const pagePath = path.join(workDir, 'ab.html');
  const mainPath = path.join(workDir, 'main.js');
  const outPath = path.join(workDir, 'ab.json');
  const dataDir = path.join(workDir, 'profile');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pagePath, PAGE);
  fs.writeFileSync(mainPath, MAIN);
  const frames = framePaths.map((file) => `file://${path.resolve(file).split(path.sep).join('/')}`).join(',');
  const url = `file://${pagePath.split(path.sep).join('/')}?clip=${encodeURIComponent(`file://${path.resolve(clip).split(path.sep).join('/')}`)}&frames=${encodeURIComponent(frames)}&frameMs=${frameMs}&measure=${measureMs}`;
  try {
    execFileSync(electronBin, [mainPath], {
      timeout: timeoutMs,
      stdio: 'ignore',
      env: { ...process.env, AB_OUT: outPath, AB_DATA: dataDir, AB_URL: url },
    });
    if (!fs.existsSync(outPath)) return { ok: false, stage: 'no-result' };
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const captured = path.join(dataDir, 'ab.png');
    if (fs.existsSync(captured)) {
      report.screenshot = screenshotPath ? path.resolve(screenshotPath) : captured;
      if (screenshotPath) {
        fs.mkdirSync(path.dirname(report.screenshot), { recursive: true });
        fs.copyFileSync(captured, report.screenshot);
      }
    }
    return report;
  } finally {
    // keep the screenshot (the caller copies it), remove everything else
    for (const name of ['ab.html', 'main.js', 'ab.json', 'profile']) {
      fs.rmSync(path.join(workDir, name), { recursive: true, force: true });
    }
    setTimeout(() => fs.rmSync(workDir, { recursive: true, force: true }), 5000);
  }
}

module.exports = { MAIN, PAGE, abProbe };
