'use strict';

// scripts/workbench-publish.js — Workbench M0 "发布" = 校验（D5: M0 does NOT
// sync any resources/** production file; the sync belongs to M2+).
//
// Validates the whole content/** tree through the shared kernel
// (src/workbench/lib/content-validator.js):
// - coarse schema validation for every content JSON (character / layout /
//   scene / zones)
// - referenced assets exist (character frames via the provenance source
//   pack; layout assets via the managed production catalog)
// - contentBbox vs freshly measured PNG alpha bounds: drift <= 0.002
// - path red lines: no fixtures/, photo/, artifacts/, file://, ..-escapes,
//   absolute filesystem paths anywhere inside content/**
// On success it writes content/build/report.json (every entry, every check)
// and exits 0. On ANY violation it lists ALL of them on stderr and exits 1 —
// fail-closed, never partial.
//
// Usage:
//   node scripts/workbench-publish.js
//   node scripts/workbench-publish.js --content-dir <dir> --repo-root <dir>
//        --report <file> --quiet

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_CONTENT_DIR = path.join(REPO_ROOT, 'content');

function parseArgs(argv) {
  const args = { contentDir: DEFAULT_CONTENT_DIR, repoRoot: REPO_ROOT, report: null, quiet: false };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--content-dir') args.contentDir = path.resolve(value);
    else if (key === '--repo-root') args.repoRoot = path.resolve(value);
    else if (key === '--report') args.report = path.resolve(value);
    else if (key === '--quiet') { args.quiet = true; i -= 1; } else {
      console.error(`workbench-publish: unknown argument ${key}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const { validateContentTree } = require(path.join(__dirname, '..', 'src', 'workbench', 'lib', 'content-validator.js'));

  if (!fs.existsSync(args.contentDir)) {
    console.error(`workbench-publish: content dir does not exist: ${args.contentDir}`);
    process.exit(2);
  }
  const report = validateContentTree({ repoRoot: args.repoRoot, contentDir: args.contentDir });
  const reportPath = args.report || path.join(args.contentDir, 'build', 'report.json');

  // The build output directory is workbench-owned (gitignored); the report
  // is the machine-readable evidence of THIS validation run.
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`workbench-publish: cannot write report ${reportPath}: ${error.message}`);
    process.exit(2);
  }

  const counts = report.entries.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'} ${entry.file} (${entry.checks.filter((c) => c.ok).length}/${entry.checks.length})`);
  if (!args.quiet) {
    for (const line of counts) console.log(line);
    console.log(`report: ${reportPath}`);
  }

  if (!report.ok) {
    console.error(`workbench-publish: ${report.violations.length} violation(s) — content/** NOT publishable:`);
    for (const violation of report.violations) {
      console.error(`  [${violation.file}] ${violation.check}: ${typeof violation.detail === 'string' ? violation.detail : JSON.stringify(violation.detail)}`);
    }
    process.exit(1);
  }
  if (!args.quiet) console.log(`workbench-publish: OK — ${report.filesScanned} files validated, ${report.entries.length} entries all green`);
  process.exit(0);
}

main();
