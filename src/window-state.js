// src/window-state.js — persist and restore main window bounds.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && [s.x, s.y, s.width, s.height].every(Number.isFinite)) return s;
  } catch { /* first run / corrupt */ }
  return null;
}

function save(file, bounds) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bounds));
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
}

module.exports = { load, save };
