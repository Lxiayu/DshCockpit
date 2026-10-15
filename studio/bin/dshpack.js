#!/usr/bin/env node
'use strict';

// studio/bin/dshpack.js — the project/asset CLI (the headless form of the
// 护照面板 buttons). Same services as the window, so a batch run and a click
// cannot disagree.
//
//   node studio/bin/dshpack.js info                        项目概览 + 内容 digest
//   node studio/bin/dshpack.js export [--out <file>]       导出 .dshpack（导出前跑密钥形状扫描）
//   node studio/bin/dshpack.js inspect <file> [--json]     检查包（清单/哈希/兼容性）
//   node studio/bin/dshpack.js import <file> --dest <dir> [--overwrite]
//   node studio/bin/dshpack.js roundtrip [--tmp <dir>]     导出→导入→逐文件 sha256 比对
//
// Exit codes: 0 ok · 1 refused/failed (the reason is printed) · 2 usage.

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');

const { createStudioServices } = require(path.join(STUDIO_ROOT, 'lib', 'studio-services.js'));

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
  dshpack info
  dshpack export [--out <file>]
  dshpack inspect <file> [--json]
  dshpack import <file> --dest <dir> [--overwrite] [--dry-run]
  dshpack roundtrip [--tmp <dir>]`;

function services() {
  return createStudioServices({
    repoRoot: REPO_ROOT,
    contentDir: path.join(REPO_ROOT, 'content'),
    charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
  });
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const studio = services();

  if (command === 'info') {
    const info = studio.projectInfo();
    if (!info.ok) { console.error(`project unreadable: ${info.code} ${info.message || ''}`); return 1; }
    console.log(`${info.id} · ${info.label} · schemaVersion ${info.schemaVersion}`);
    console.log(`root: ${info.root}`);
    console.log(`files: ${info.fileCount} (${(info.totalBytes / 1048576).toFixed(2)} MB) · actions ${info.counts.actions} · scenes ${info.counts.scenes}`);
    console.log(`digest: ${info.digest}`);
    console.log(`declared-but-missing: ${info.missing.length}${info.missing.length ? ` (${info.missing.map((entry) => entry.path).join(', ')})` : ''}`);
    return 0;
  }

  if (command === 'export') {
    const out = flags.out ? path.resolve(String(flags.out)) : null;
    const outcome = studio.packExport({ out });
    if (!outcome.ok) {
      console.error(`export refused: ${outcome.code}`);
      for (const violation of outcome.violations || []) console.error(`  ✗ ${violation.path || ''} ${violation.check} ${violation.detail || ''}`);
      return 1;
    }
    console.log(`exported: ${outcome.out}`);
    console.log(`bytes: ${outcome.bytes} · entries: ${outcome.entries} · pack sha256: ${outcome.packSha256}`);
    console.log(`content digest: ${outcome.digest}`);
    return 0;
  }

  if (command === 'inspect') {
    const file = positional[1];
    if (!file) { console.error(USAGE); return 2; }
    const outcome = studio.packInspect({ file });
    if (flags.json) { console.log(JSON.stringify(outcome, null, 2)); return outcome.ok ? 0 : 1; }
    if (!outcome.ok && !outcome.manifest) { console.error(`unreadable: ${outcome.code} ${outcome.message}`); return 1; }
    const manifest = outcome.manifest;
    console.log(`${manifest.id} · ${manifest.label} · manifest schemaVersion ${manifest.schemaVersion} · compatible: ${outcome.compatible}`);
    console.log(`files: ${manifest.files ? manifest.files.length : '?'} · createdAt ${manifest.createdAt || '?'} · studio ${manifest.studioVersion || '?'}`);
    if (outcome.problems && outcome.problems.length) {
      console.error(`problems: ${outcome.problems.length}`);
      for (const problem of outcome.problems) console.error(`  ✗ ${problem.check} ${problem.path || ''} ${problem.detail || ''}`);
      return 1;
    }
    console.log('problems: none');
    return 0;
  }

  if (command === 'import') {
    const file = positional[1];
    const dest = flags.dest;
    if (!file || !dest) { console.error(USAGE); return 2; }
    const outcome = studio.packImport({ file, dest, overwrite: Boolean(flags.overwrite), dryRun: Boolean(flags['dry-run']) });
    if (!outcome.ok) {
      console.error(`import refused: ${outcome.code} ${outcome.message || ''}`);
      for (const problem of outcome.problems || []) console.error(`  ✗ ${problem.check} ${problem.path || ''} ${problem.detail || ''}`);
      return 1;
    }
    console.log(`imported: ${outcome.counts.files} file(s) → ${outcome.dest}${outcome.dryRun ? ' (dry run)' : ''}`);
    return 0;
  }

  if (command === 'roundtrip') {
    const owned = !flags.tmp;
    const tmpDir = owned ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dshpack-cli-')) : path.resolve(String(flags.tmp));
    let outcome;
    try {
      outcome = studio.packRoundTrip({ tmpDir });
    } finally {
      if (owned) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (!outcome.ok) {
      console.error(`round trip FAILED at stage ${outcome.stage}`);
      console.error(JSON.stringify(outcome.changed || outcome.detail || outcome, null, 2).slice(0, 2000));
      return 1;
    }
    console.log(`round trip ok · files ${outcome.files}`);
    console.log(`pack sha256: ${outcome.packSha256}`);
    console.log(`content digest (before === after): ${outcome.beforeDigest}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, USAGE };
