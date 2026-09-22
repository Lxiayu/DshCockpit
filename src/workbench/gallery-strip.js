'use strict';

// src/workbench/gallery-strip.js — the golden-gallery frame strip page.
//
// Renders the 5 declared walk frames of one direction side by side at the
// requested zoom (1x/2x) from the PROVENANCE SOURCE PACK bytes (served
// read-only at workbench://local/pack/...), with the calibrated foot line
// (character.json pack.footLine, alpha>=128 shoe line = 296) drawn across
// the strip so inter-frame shoe-line drift is visible at a glance. Frame
// ORDER comes from character.json's action metadata (frame order is data,
// never file names).
//
// The main process captures this page for content/build/gallery/ and waits
// on window.__stripReady === true (all images decoded or failed).

(() => {
  const params = new URLSearchParams(window.location.search);
  const direction = params.get('dir') === 'right' ? 'right' : 'left';
  const zoom = Math.max(1, Math.min(4, Number(params.get('zoom') || 1) || 1));

  const strip = document.getElementById('strip');

  fetch('/content/characters/whale-girl/character.json')
    .then((response) => {
      if (!response.ok) throw new Error(`character.json: ${response.status}`);
      return response.json();
    })
    .then((character) => {
      const action = (character.actions || []).find((entry) => entry.id === `walk-${direction}`);
      if (!action) throw new Error(`action walk-${direction} missing`);
      const footLine = character.pack && character.pack.footLine;
      const framePx = character.pack.canvas * zoom;
      for (const frame of action.frames) {
        const cell = document.createElement('div');
        cell.className = 'frame';
        const img = document.createElement('img');
        img.width = framePx;
        img.height = framePx;
        img.src = `/pack/${frame.file}`;
        const caption = document.createElement('span');
        caption.className = 'caption';
        const file = frame.file.split('/').pop();
        caption.textContent = `${file} · 鞋线 ${frame.geometry && frame.geometry.footLine !== undefined ? frame.geometry.footLine : '—'}`;
        cell.append(img, caption);
        strip.appendChild(cell);
        img.addEventListener('error', () => { cell.dataset.error = 'decode-failed'; });
      }
      if (Number.isFinite(footLine)) {
        const line = document.createElement('div');
        line.id = 'footline';
        line.style.top = `${16 + footLine * zoom}px`;
        strip.appendChild(line);
      }
    })
    .catch((error) => {
      strip.textContent = `strip failed: ${error.message}`;
      window.__stripError = String(error.message || error);
    })
    .finally(() => {
      // ready = every <img> settled (decoded or errored); the main process
      // additionally checks for decode-failed markers in evidence mode.
      const images = () => [...document.querySelectorAll('#strip img')];
      const settle = () => {
        if (images().every((img) => img.complete)) window.__stripReady = true;
        else setTimeout(settle, 100);
      };
      settle();
    });
})();
