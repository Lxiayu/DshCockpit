// test/tdz-guard.test.js — static guard for the A1 extraction era: every
// top-level factory block (createXxx({...})) must only shorthand-reference
// identifiers that are already initialized (hoisted functions or earlier
// const/let). Catches the "Cannot access X before initialization" class of
// load-time crashes that npm test cannot see (it never loads main.js).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('top-level factory blocks have no TDZ / missing-symbol references', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const lines = src.split('\n');
  const fnDecl = new Set();
  const varDecl = new Map();
  lines.forEach((l, i) => {
    let m;
    if ((m = l.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) fnDecl.add(m[1]);
    else if ((m = l.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/))) varDecl.set(m[1], Math.min(varDecl.get(m[1]) ?? Infinity, i));
  });
  // multi-line destructuring bindings
  const destr = /(?:^|\n)(?:const|let)\s*\{([^}]*)\}\s*=/g;
  let dm;
  while ((dm = destr.exec(src))) {
    const line = src.slice(0, dm.index).split('\n').length - 1;
    for (const part of dm[1].split(',')) {
      const name = part.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) varDecl.set(name, Math.min(varDecl.get(name) ?? Infinity, line));
    }
  }

  const factoryRe = /const\s+(\w+)\s*=\s*(create\w+)\(\{\n([\s\S]*?)\n\}\);/g;
  let m; const issues = [];
  while ((m = factoryRe.exec(src))) {
    const blockLine = src.slice(0, m.index).split('\n').length - 1;
    for (const line of m[3].split('\n')) {
      const t = line.trim().replace(/,\s*$/, '');
      if (!/^[A-Za-z_$][\w$]*$/.test(t)) continue;
      if (fnDecl.has(t)) continue; // hoisted function declarations are safe
      const d = varDecl.get(t);
      if (d === undefined) issues.push(`${m[1]}: "${t}" has no top-level declaration`);
      else if (d > blockLine) issues.push(`${m[1]}: "${t}" declared at line ${d + 1}, used at line ${blockLine + 1} (TDZ)`);
    }
  }
  assert.deepStrictEqual(issues, [],
    'load-time reference errors found in top-level factory blocks:\n' + issues.join('\n'));
});
