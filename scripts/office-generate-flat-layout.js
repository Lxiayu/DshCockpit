'use strict';

// scripts/office-generate-flat-layout.js — Task E4.
//
// Regenerates src/office/fixtures/office-layout-flat.json by compiling the
// COMMITTED hermetic copy of the user-approved flat editor draft
// (test/fixtures/office-layout-flat-draft.json) with the production compiler.
// The fixture is always compiler output — never hand-edited. Provenance
// (source hash, import date) lives next to the draft copy in
// test/fixtures/office-layout-flat-draft.provenance.json.
//
// Usage: node scripts/office-generate-flat-layout.js

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { compileOfficeLayout } = require('../src/office/runtime/office-layout-compiler.js');
const { LAYOUT_ASSETS, DRAFT_WIDTHS, CHARACTER_FOOT_RATIO } = require('../src/office/layout-assets.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const DRAFT_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'office-layout-flat-draft.json');
const TOPOLOGY_PATH = path.join(REPO_ROOT, 'src', 'office', 'fixtures', 'office-layout.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json');

const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
const topology = JSON.parse(fs.readFileSync(TOPOLOGY_PATH, 'utf8'));

const sourceDraftSha256 = crypto.createHash('sha256').update(fs.readFileSync(DRAFT_PATH)).digest('hex');
const result = compileOfficeLayout({
  draft,
  assets: LAYOUT_ASSETS,
  draftWidths: DRAFT_WIDTHS,
  characterFoot: CHARACTER_FOOT_RATIO,
  topology: { nodes: topology.nodes, edges: topology.edges },
  sourceDraftSha256,
});

if (!result.ok) {
  console.error(`OFFICE_FLAT_LAYOUT_GENERATION_FAILED ${result.code}: ${JSON.stringify(result.detail)}`);
  process.exit(1);
}

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(result.layout, null, 2)}\n`);
console.log(`OFFICE_FLAT_LAYOUT_GENERATED ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
