'use strict';

// studio/test/contrast.test.js — the WCAG check the quality bar asks for (brief §11:
// 浅/深对比度 ≥4.5:1). The shell's colours all live in CSS custom properties, so this
// suite PARSES the real stylesheet (no duplicated palette that could drift) and computes
// the contrast of the pairs the UI actually renders, in every theme the file defines:
// system-light, system-dark, and the two explicit overrides.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', '..', 'src', 'workbench', 'workbench.css');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');

// ---- parse the token blocks -----------------------------------------------------

function blockAfter(selector, source = CSS) {
  const index = source.indexOf(selector);
  if (index < 0) return null;
  const open = source.indexOf('{', index);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

function tokensOf(block) {
  const tokens = {};
  for (const match of String(block || '').matchAll(/(--wb-[a-z-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

const lightTokens = tokensOf(blockAfter(':root {'));
const explicitLight = tokensOf(blockAfter('body[data-theme="light"]'));
const mediaIndex = CSS.indexOf('@media (prefers-color-scheme: dark)');
const darkTokens = tokensOf(blockAfter(':root {', CSS.slice(mediaIndex)));
const explicitDark = tokensOf(blockAfter('body[data-theme="dark"]'));

const THEMES = {
  'system-light': lightTokens,
  'system-dark': darkTokens,
  'explicit-light': { ...lightTokens, ...explicitLight },
  'explicit-dark': { ...darkTokens, ...explicitDark },
};

// ---- contrast maths ------------------------------------------------------------

function parseColour(value) {
  const text = String(value).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].split('').map((char) => char + char).join('') : hex[1];
    return [0, 2, 4].map((offset) => parseInt(raw.slice(offset, offset + 2), 16));
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number(part.trim()));
    return parts.slice(0, 3);
  }
  return null;
}

function relativeLuminance([r, g, b]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(parseColour(foreground));
  const b = relativeLuminance(parseColour(background));
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

// The pairs the UI really draws: body text on every surface it sits on, secondary text,
// the accent (links, active values, statuses), the active pill's own label, and the
// semantic status colours (ok/bad/warn) which are always rendered as text on a panel.
const TEXT_PAIRS = [
  ['--wb-ink', '--wb-bg'],
  ['--wb-ink', '--wb-panel'],
  ['--wb-ink', '--wb-zebra'],
  ['--wb-ink', '--wb-hover'],
  ['--wb-dim', '--wb-panel'],
  ['--wb-dim', '--wb-bg'],
  ['--wb-accent', '--wb-panel'],
  ['--wb-accent', '--wb-bg'],
  ['--wb-accent', '--wb-accent-soft'],
  ['--wb-on-accent', '--wb-accent'],
  ['--wb-ok', '--wb-panel'],
  ['--wb-bad', '--wb-panel'],
  ['--wb-warn', '--wb-panel'],
];

test('the stylesheet defines both themes with a full token set', () => {
  for (const [name, tokens] of Object.entries(THEMES)) {
    for (const token of ['--wb-bg', '--wb-panel', '--wb-ink', '--wb-dim', '--wb-accent', '--wb-on-accent', '--wb-ok', '--wb-bad', '--wb-warn', '--wb-zebra']) {
      assert.ok(tokens[token], `${name} defines ${token}`);
    }
  }
  assert.notEqual(THEMES['system-light']['--wb-ink'], THEMES['system-dark']['--wb-ink'], 'the dark theme really differs');
});

test('every text pair meets the 4.5:1 quality bar in every theme', () => {
  const failures = [];
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const [foreground, background] of TEXT_PAIRS) {
      const ratio = contrastRatio(tokens[foreground], tokens[background]);
      if (ratio < 4.5) failures.push(`${themeName}: ${foreground} on ${background} = ${ratio}:1`);
    }
  }
  assert.deepEqual(failures, [], `pairs below 4.5:1:\n${failures.join('\n')}`);
});

test('the ratio maths is the standard one (sanity checks against known values)', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  // the classic mid grey pair: #767676 on white is the WCAG AA boundary
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.05, `#767676 on white ≈ 4.54 (${contrastRatio('#767676', '#ffffff')})`);
  assert.equal(parseColour('rgba(18, 32, 48, 0.06)').length, 3);
});
