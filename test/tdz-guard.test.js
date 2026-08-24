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

test('module exports are fully destructured in main.js (no missing accessors)', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const mainSrc = read('main.js');

  function returnKeys(file, factoryName) {
    const src = read(file);
    const start = src.indexOf(`function ${factoryName}`);
    assert.notStrictEqual(start, -1, `${factoryName} not found in ${file}`);
    const ret = src.indexOf('return {', start);
    assert.notStrictEqual(ret, -1, `${factoryName} has no return block`);
    const end = src.indexOf('};', ret);
    const body = src.slice(ret + 'return {'.length, end);
    return body.split('\n').flatMap((l) => l.split(','))
      .map((x) => x.trim())
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
  }

  function destructureBlock(mainSrc, moduleName) {
    const marker = `} = ${moduleName};`;
    const end = mainSrc.indexOf(marker);
    assert.notStrictEqual(end, -1, `main.js never destructures ${moduleName}`);
    const start = mainSrc.lastIndexOf('const {', end);
    return mainSrc.slice(start + 'const {'.length, end);
  }

  // Three-state check per exported key:
  //   destructured in main.js            -> OK
  //   used via moduleName.key            -> OK (const object stays in scope)
  //   bare reference with neither        -> FAIL (runtime ReferenceError)
  //   completely unused                  -> OK (informational)
  function usageState(mainSrc, moduleName, key) {
    const destr = new RegExp(`\\b${key}\\b`).test(destructureBlock(mainSrc, moduleName));
    const qualified = new RegExp(`\\b${moduleName}\\.${key}\\b`).test(mainSrc);
    // the (?!\s*:) exclusion skips object-LITERAL KEYS (hasQuickAsk: ...)
    // which are not variable references
    const bare = new RegExp(`(?<![\\w$.])${key}(?![\\w$])(?!\\s*:)`).test(
      mainSrc.replace(new RegExp(`\\b${moduleName}\\.[A-Za-z_$][\\w$]*`, 'g'), ''));
    if (destr) return 'ok';
    if (qualified && !bare) return 'ok';
    if (bare) return 'BARE';
    return 'unused';
  }

  const wmKeys = returnKeys('window-manager.js', 'createWindowManager');
  const wmMissing = wmKeys.filter((k) => usageState(mainSrc, 'windowManager', k) === 'BARE');
  assert.deepStrictEqual(wmMissing, [],
    `window-manager exports missing from the main.js destructure (calls would throw at runtime): ${wmMissing.join(', ')}`);

  const auxKeys = returnKeys('aux-windows.js', 'createAuxWindows');
  const auxMissing = auxKeys.filter((k) => usageState(mainSrc, 'auxWindows', k) === 'BARE');
  assert.deepStrictEqual(auxMissing, [],
    `aux-windows exports missing from the main.js destructure: ${auxMissing.join(', ')}`);

  const supKeys = returnKeys('runtime-supervisor.js', 'createRuntimeSupervisor');
  const supMissing = supKeys.filter((k) => usageState(mainSrc, 'supervisor', k) === 'BARE');
  assert.deepStrictEqual(supMissing, [],
    `runtime-supervisor exports missing from the main.js destructure: ${supMissing.join(', ')}`);
});
