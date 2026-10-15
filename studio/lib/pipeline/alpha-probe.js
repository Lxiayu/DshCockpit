'use strict';

// studio/lib/pipeline/alpha-probe.js — "does this clip really carry alpha?"
//
// Runtime truth over toolchain opinion: ffmpeg's decoders and the container tags can
// both claim things the renderer does not honour (measured on this machine: the WebM
// muxer writes alpha_mode=1 while ffmpeg's own decode shows an opaque frame). The
// ONLY authority for a Chromium runtime is Chromium, so this module boots a headless
// Electron window, draws the clip to a canvas and counts the alpha values.
//
// Usage (Node, spawns Electron):
//   const { probeAlpha } = require('./alpha-probe.js');
//   probeAlpha({ electronBin, clip }) -> { ok, width, height, transparent, semi, opaque, verdict }
//
// It is deliberately a separate PROCESS: the studio's own process must not need a
// GPU/display, and the probe cleans up after itself (temp profile + app.exit).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>PROBE 临时数据（可关闭）</title></head>
<body style="margin:0;background:transparent">
<canvas id="c" width="64" height="64"></canvas>
<script>
(async () => {
  const result = { ok: false, stage: 'start' };
  try {
    const params = new URLSearchParams(location.search);
    const clip = params.get('clip');
    const atSec = Number(params.get('at') || 0);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = clip;
    document.body.appendChild(video);
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video error ' + (video.error && video.error.code)));
    });
    result.video = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    if (atSec > 0) {
      await new Promise((resolve) => { video.onseeked = () => resolve(); video.currentTime = atSec; });
    }
    const canvas = document.getElementById('c');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0, semi = 0, opaque = 0;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      if (a === 0) transparent += 1; else if (a === 255) opaque += 1; else semi += 1;
    }
    result.stage = 'drawn';
    result.alpha = { transparent, semi, opaque, total: data.length / 4 };
    result.supportsVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    result.ok = true;
  } catch (error) {
    result.error = String(error && error.message || error);
  }
  window.__alphaProbeResult = result;
  document.title = 'PROBE 临时数据（可关闭）';
})();
</script>
</body></html>
`;

const MAIN = `const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = process.env.ALPHA_PROBE_OUT;
const CLIP = process.env.ALPHA_PROBE_CLIP;
const AT = process.env.ALPHA_PROBE_AT || '0';
const PAGE = process.env.ALPHA_PROBE_PAGE;
const DATA = process.env.ALPHA_PROBE_DATA;

app.setPath('userData', DATA);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 320, height: 240, show: false,
    title: 'PROBE 临时数据（可关闭）',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false },
  });
  try {
    const clipUrl = 'file://' + CLIP.split(path.sep).join('/');
    await win.loadURL('file://' + PAGE.split(path.sep).join('/') + '?clip=' + encodeURIComponent(clipUrl) + '&at=' + AT);
    let payload = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      payload = await win.webContents.executeJavaScript('window.__alphaProbeResult || null', true);
      if (payload) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    fs.writeFileSync(OUT, JSON.stringify(payload || { ok: false, stage: 'timeout' }, null, 2));
  } catch (error) {
    fs.writeFileSync(OUT, JSON.stringify({ ok: false, stage: 'main-error', error: String(error && error.message || error) }, null, 2));
  } finally {
    win.destroy();
    app.exit(0);
  }
});
`;

// Boots the probe and returns the parsed report.
function probeAlpha({ electronBin, clip, atSec = 0, timeoutMs = 60000 }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-probe-'));
  const pagePath = path.join(workDir, 'page.html');
  const mainPath = path.join(workDir, 'main.js');
  const outPath = path.join(workDir, 'result.json');
  const dataDir = path.join(workDir, 'profile');
  fs.writeFileSync(pagePath, PAGE);
  fs.writeFileSync(mainPath, MAIN);
  try {
    execFileSync(electronBin, [mainPath], {
      timeout: timeoutMs,
      stdio: 'ignore',
      env: {
        ...process.env,
        ALPHA_PROBE_OUT: outPath,
        ALPHA_PROBE_CLIP: path.resolve(clip),
        ALPHA_PROBE_AT: String(atSec),
        ALPHA_PROBE_PAGE: pagePath,
        ALPHA_PROBE_DATA: dataDir,
      },
    });
    if (!fs.existsSync(outPath)) return { ok: false, stage: 'no-result' };
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (report.ok && report.alpha) {
      report.verdict = report.alpha.transparent > 0
        ? 'alpha-present'
        : (report.alpha.semi > 0 ? 'alpha-partial' : 'opaque');
    }
    return report;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { MAIN, PAGE, probeAlpha };
