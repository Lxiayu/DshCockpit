// src/preload.js — minimal bridge + injected shell chrome for the DSH web
// surface: a draggable settings button + token-usage pill.
//
// Chrome positioning: smart default below the page's top-right controls, then
// draggable; the user's position persists in localStorage (isolated world).
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ---------------------------------------------------------------------------
// injected chrome (floating, draggable)
// ---------------------------------------------------------------------------
const CHROME_ID = 'dsh-shell-chrome';
const POS_KEY = 'dsh-shell-chrome-pos';

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** Guess a default position that avoids the page's top-right controls. */
function smartDefaultPos() {
  let maxBottom = 0;
  let found = 0;
  const hits = document.querySelectorAll('button, [role="button"], a, [class*="action"], [class*="toolbar"]');
  for (const el of hits) {
    if (el.closest('#' + CHROME_ID)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // top strip (title/header zone) and right side of the window
    if (r.top < 130 && r.right > window.innerWidth - 220) {
      maxBottom = Math.max(maxBottom, r.bottom);
      found += 1;
    }
  }
  const top = found ? Math.round(maxBottom + 10) : 10;
  return { top: clamp(top, 10, Math.max(10, window.innerHeight - 60)), right: 12, found };
}

function loadSavedPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.top === 'number' && typeof p.right === 'number') return p;
    }
  } catch { /* ignore */ }
  return null;
}

function savePos(p) {
  try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

let chromeTop = 10;
let chromeRight = 12;
let dragState = null;
let userDragged = false;

function applyPos(top, right) {
  chromeTop = top;
  chromeRight = right;
  const wrap = document.getElementById(CHROME_ID);
  if (wrap) {
    wrap.style.top = `${top}px`;
    wrap.style.right = `${right}px`;
  }
}

/**
 * The harness is an SPA: at DOMContentLoaded its header does not exist yet, so
 * the initial smart position often lands on top of the top-right controls.
 * Re-measure a few times after load and shift below them until found (unless
 * the user already dragged the chrome to their own spot).
 */
function scheduleSmartReposition(savedPos) {
  if (savedPos) return; // user has a saved position; respect it
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (userDragged) { clearInterval(timer); return; }
    const p = smartDefaultPos();
    if (p.found > 0) {
      applyPos(p.top, p.right);
      clearInterval(timer);
      ipcRenderer.send('chrome:report', { top: p.top, right: p.right, found: p.found, saved: false, pass: attempts });
    } else if (attempts >= 12) {
      clearInterval(timer);
    }
  }, 700);
}

function injectChrome() {
  if (document.getElementById(CHROME_ID)) return;

  const saved = loadSavedPos();
  const def = saved || smartDefaultPos();
  chromeTop = def.top;
  chromeRight = def.right;

  const wrap = document.createElement('div');
  wrap.id = CHROME_ID;
  wrap.style.cssText = [
    'position:fixed; z-index:2147483647;',
    `top:${chromeTop}px; right:${chromeRight}px;`,
    'display:flex; align-items:center; gap:8px;',
    'font:12px/1.4 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
    'opacity:.72; transition:opacity .15s; cursor:grab; user-select:none;',
  ].join(' ');
  wrap.addEventListener('mouseenter', () => { wrap.style.opacity = '1'; });
  wrap.addEventListener('mouseleave', () => { wrap.style.opacity = '.72'; });

  // token pill
  const pill = document.createElement('div');
  pill.id = 'dsh-shell-tokens';
  pill.textContent = '⛁ …';
  pill.style.cssText = [
    'background:rgba(20,23,28,.85); color:#8b949e; border:1px solid rgba(255,255,255,.12);',
    'border-radius:999px; padding:3px 10px; white-space:nowrap;',
  ].join(' ');

  // settings button
  const gear = document.createElement('button');
  gear.id = 'dsh-shell-settings';
  gear.textContent = '⚙';
  gear.title = '设置';
  gear.style.cssText = [
    'width:26px; height:26px; border-radius:8px; border:1px solid rgba(255,255,255,.12);',
    'background:rgba(20,23,28,.85); color:#e6edf3; font-size:14px; cursor:pointer;',
    'display:flex; align-items:center; justify-content:center;',
  ].join(' ');
  gear.addEventListener('click', () => ipcRenderer.send('chrome:open-settings'));

  wrap.appendChild(pill);
  wrap.appendChild(gear);
  document.body.appendChild(wrap);

  // drop a folder onto the chrome bar to switch the runtime workspace
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    try {
      const p = webUtils.getPathForFile(f);
      if (p) ipcRenderer.send('chrome:set-workspace', p);
    } catch { /* ignore */ }
  });

  // drag (pointer events); pill click still refreshes tokens
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === gear) return; // let the gear handle its own click
    dragState = { x: e.clientX, y: e.clientY, top: chromeTop, right: chromeRight, moved: false };
    try { wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.x;
    const dy = e.clientY - dragState.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
    if (dragState.moved) {
      applyPos(
        clamp(dragState.top + dy, 8, Math.max(8, window.innerHeight - 48)),
        clamp(dragState.right - dx, 8, Math.max(8, window.innerWidth - 120))
      );
    }
  });
  const endDrag = (e) => {
    if (!dragState) return;
    const wasClick = !dragState.moved;
    const targetPill = e.target === pill;
    dragState = null;
    if (wasClick && targetPill) ipcRenderer.send('chrome:refresh-tokens');
    if (!wasClick) {
      userDragged = true;
      savePos({ top: chromeTop, right: chromeRight });
    }
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  // report placement once (for shell diagnostics)
  ipcRenderer.send('chrome:report', { top: chromeTop, right: chromeRight, found: def.found, saved: !!saved });
  scheduleSmartReposition(saved);
}

function updatePill(tokens) {
  injectChrome();
  const pill = document.getElementById('dsh-shell-tokens');
  const gear = document.getElementById('dsh-shell-settings');
  if (!pill) return;
  const lang = tokens.lang === 'en' ? 'en' : 'zh';
  // gear: a small red DOT badge (not a color ring) when no API key is configured
  if (gear) {
    gear.style.position = 'relative';
    let dot = gear.querySelector('.dsh-dot');
    if (tokens.needsSetup) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'dsh-dot';
        dot.style.cssText = 'position:absolute; top:-2px; right:-2px; width:9px; height:9px; border-radius:50%; background:#f85149; border:1.5px solid #14171c;';
        gear.appendChild(dot);
      }
      gear.title = lang === 'en' ? '⚙ Settings — API key not configured' : '⚙ 设置 — 尚未配置 API Key';
    } else {
      if (dot) dot.remove();
      gear.title = lang === 'en' ? 'Settings' : '设置';
    }
  }
  // context-pressure: tint BOTH border and background of the token pill (visible)
  const pct = tokens.pressurePct || 0;
  if (pct >= 85) {
    pill.style.borderColor = '#f85149';
    pill.style.background = 'rgba(248,81,73,.18)';
    pill.style.color = '#f85149';
  } else if (pct >= 60) {
    pill.style.borderColor = '#d29922';
    pill.style.background = 'rgba(210,153,34,.15)';
    pill.style.color = '#d29922';
  } else {
    pill.style.borderColor = 'rgba(255,255,255,.12)';
    pill.style.background = 'rgba(20,23,28,.85)';
    pill.style.color = '#8b949e';
  }
  const cur = tokens.current;
  const tot = tokens.totals;
  if (!cur) {
    pill.textContent = lang === 'en' ? '⛁ no sessions' : '⛁ 暂无会话';
    pill.title = '';
    return;
  }
  pill.textContent = `⛁ ${fmt(cur.input)}→${fmt(cur.output)}`;
  const pressureLine = lang === 'en' ? `Context pressure: ${pct}%` : `上下文压力：${pct}%`;
  const lines = (lang === 'en'
    ? [pressureLine,
       `Current: in ${fmt(cur.input)} · out ${fmt(cur.output)} · cache ${fmt(cur.cacheRead + cur.cacheWrite)}`,
       `All (${tokens.sessionCount}): in ${fmt(tot.input)} · out ${fmt(tot.output)} · cache ${fmt(tot.cacheRead + tot.cacheWrite)}`]
    : [pressureLine,
       `当前会话：输入 ${fmt(cur.input)} · 输出 ${fmt(cur.output)} · 缓存 ${fmt(cur.cacheRead + cur.cacheWrite)}`,
       `全部会话（${tokens.sessionCount} 个）：输入 ${fmt(tot.input)} · 输出 ${fmt(tot.output)} · 缓存 ${fmt(tot.cacheRead + tot.cacheWrite)}`]);
  pill.title = lines.join('\n');
}

window.addEventListener('DOMContentLoaded', injectChrome);
ipcRenderer.on('chrome:tokens', (_e, tokens) => updatePill(tokens));

// ---------------------------------------------------------------------------
// bridge
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('dshChrome', {
  openSettings: () => ipcRenderer.send('chrome:open-settings'),
  refreshTokens: () => ipcRenderer.send('chrome:refresh-tokens'),
  platform: process.platform,
});
