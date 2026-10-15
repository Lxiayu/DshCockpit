'use strict';

// studio/test/studio-services.test.js — the studio service bundle + the export
// secret scan. Pure Node (no Electron): every assertion either reads the REAL
// repo or a mkdtemp sandbox; nothing here writes into content/**.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(STUDIO_ROOT, '..');

const { createStudioServices, STUDIO_VERSION } = require(path.join(STUDIO_ROOT, 'lib', 'studio-services.js'));
const provenance = require(path.join(STUDIO_ROOT, 'lib', 'provenance.js'));
const scan = require(path.join(STUDIO_ROOT, 'lib', 'scan.js'));

function realServices() {
  return createStudioServices({
    repoRoot: REPO_ROOT,
    contentDir: path.join(REPO_ROOT, 'content'),
    charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
    packId: provenance.DEFAULT_PACK_ID,
  });
}

test('studio info describes the capability domains and the passport vocabulary', () => {
  const services = realServices();
  const info = services.info();
  assert.equal(info.ok, true);
  assert.equal(info.studio, true);
  assert.equal(info.version, STUDIO_VERSION);
  assert.equal(info.packId, 'deepseek-default');
  assert.equal(info.characterDir, path.join(REPO_ROOT, 'content', 'characters', 'whale-girl'));
  assert.deepEqual(info.segments, ['generation', 'matting', 'normalize', 'publish', 'on-disk'], 'five-segment chain');
  assert.deepEqual(info.statuses, ['traceable', 'traceable-in-history', 'lost', 'not-recorded'], 'honest status vocabulary');
  assert.equal(info.paramsDirRelative, 'provenance/generation');
});

test('the passport reports a real action from the real trees (no fabrication)', () => {
  const services = realServices();
  const report = services.provenanceReport('walk-left');
  assert.equal(report.ok, true, 'walk-left is a known action');
  assert.equal(report.kind, 'action');
  assert.deepEqual(report.segments.map((segment) => segment.id), ['generation', 'matting', 'normalize', 'publish', 'on-disk']);
  for (const segment of report.segments) {
    assert.ok(provenance.STATUSES.includes(segment.status), `${segment.id} uses a declared status (${segment.status})`);
  }
  // the bytes exist on disk — that segment must be provable, not asserted away
  assert.equal(report.segments.find((segment) => segment.id === 'on-disk').status, 'traceable');
  assert.ok(['green', 'yellow', 'red'].includes(report.reproducible));
  // the generation segment is the known breakpoint: it may be yellow today, and
  // the moment someone records the params ledger it must go green — so this
  // assertion pins the VOCABULARY, never a fake green.
  const generation = report.segments.find((segment) => segment.id === 'generation');
  assert.notEqual(generation.status, 'traceable', 'no generation params ledger exists yet — claiming traceable would be a fabrication');
  assert.equal(generation.status, 'traceable-in-history', 'the publish record proves a run happened (params still unrecorded)');
});

test('an unknown asset id fails loudly with the known-id list instead of inventing a report', () => {
  const services = realServices();
  const report = services.provenanceReport('definitely-not-an-asset');
  assert.equal(report.ok, false);
  assert.equal(report.reproducible, 'red');
  assert.deepEqual(report.segments, []);
  assert.ok(Array.isArray(report.known) && report.known.length > 10, 'the failure names what IS known');
});

test('verify() counts agree with its own rows (no orphan totals)', () => {
  const services = realServices();
  const outcome = services.provenanceVerify();
  assert.equal(outcome.ok, true);
  const counts = outcome.counts;
  const total = counts.traceable + counts.traceableInHistory + counts.lost + counts.notRecorded;
  assert.equal(total, outcome.rows.length, 'counts sum to rows');
  assert.equal(counts.lost, 0, 'nothing is known-lost in this tree today');
});

test('index() writes the machine-readable index into the studio build directory', () => {
  const services = realServices();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-index-')), 'index.json');
  try {
    const outcome = services.provenanceIndex({ out });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.out, out);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(Array.isArray(written.entries) && written.entries.length > 50, `real index has entries (${written.entries.length})`);
    const ids = new Set(written.entries.map((entry) => entry.id));
    assert.ok(ids.has('walk-left') && ids.has('flat-desk'), 'both character actions and office catalog assets are indexed');
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('the params ledger reads as an empty list (never a throw) when nothing was recorded', () => {
  const services = realServices();
  const ledger = services.paramsLedger('walk-left');
  assert.ok(Array.isArray(ledger.records));
  assert.equal(ledger.dir, path.join(REPO_ROOT, 'content', 'characters', 'whale-girl', 'provenance', 'generation'));
  assert.equal(ledger.ok, fs.existsSync(ledger.dir));
});

test('recordParams fills the generation breakpoint in a sandbox repo (real files, temp tree)', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-params-'));
  try {
    const services = createStudioServices({
      repoRoot: sandbox,
      contentDir: path.join(sandbox, 'content'),
      charactersRoot: path.join(sandbox, 'resources', 'characters'),
      packId: provenance.DEFAULT_PACK_ID,
    });
    const outcome = services.recordParams({
      actionId: 'walk-left',
      kind: 'image',
      provider: 'dashscope',
      model: 'qwen-image-edit',
      prompt: 'green screen, front view, feet locked to the anchor',
      seed: 42,
      outputs: [],
      params: { size: '1024x1024' },
    });
    assert.equal(outcome.ok, true, `record written (${JSON.stringify(outcome)})`);
    const ledgerFile = path.join(sandbox, 'content', 'characters', 'whale-girl', 'provenance', 'generation', 'walk-left.params.json');
    assert.equal(outcome.file, ledgerFile);
    const stored = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.actionId, 'walk-left');
    assert.equal(stored.records.length, 1);
    const record = stored.records[0];
    assert.equal(record.model, 'qwen-image-edit');
    assert.equal(record.seed, 42);
    assert.match(record.promptHash, /^[0-9a-f]{64}$/, 'the prompt is stored as a hash by default');
    assert.equal(record.prompt, undefined, 'prompt text is NOT stored unless explicitly requested');
    // appending never rewrites the first record
    services.recordParams({ actionId: 'walk-left', kind: 'video', model: 'wan2.2-animate', prompt: 'second call' });
    const after = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.equal(after.records.length, 2, 'records append');
    assert.equal(after.records[0].model, 'qwen-image-edit', 'the earlier record survives');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the secret scan refuses key shapes, reports fingerprints, and tolerates placeholders', () => {
  const clean = scan.scanForSecrets('{"model":"gpt-image-2","note":"no secrets here"}');
  assert.equal(clean.ok, true);

  const fakeKey = `sk-${'a'.repeat(32)}`;
  const dirty = scan.scanForSecrets(`Authorization: Bearer ${fakeKey}\n`);
  assert.equal(dirty.ok, false);
  assert.deepEqual([...new Set(dirty.hits.map((hit) => hit.code))].sort(), ['SECRET_BEARER_HEADER', 'SECRET_SK_PREFIX']);
  for (const hit of dirty.hits) {
    assert.doesNotMatch(hit.fingerprint, /a{12}/, 'the report carries a fingerprint, never the value');
    assert.match(hit.fingerprint, /^.{1,4}…len=\d+sha=[0-9a-f]{12}$/);
  }

  assert.equal(scan.scanForSecrets('api_key = "sk-PLACEHOLDER-value-1234"').ok, true, 'placeholders do not trip the scan');
  // Fixtures are assembled from fragments on purpose: this file is scanned by
  // its own "studio tree carries no secret shapes" test below, so a literal
  // secret shape may not appear here even as test data.
  const digits = 'abcdefgh12345678';
  assert.equal(scan.scanForSecrets(`?token=${digits}`).ok, false, 'query token shapes are caught');
  assert.equal(scan.scanForSecrets(`Cookie: s=${digits}`).ok, false, 'cookie headers are caught');

  assert.throws(() => scan.assertNoSecrets(`x=${fakeKey}`, 'diagnostics.json'), /SECRET_SHAPE_REFUSED diagnostics\.json/);
});

test('the studio tree itself carries no secret shapes', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'build' || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(js|json|md|html|css)$/.test(entry.name)) files.push(abs);
    }
  };
  walk(STUDIO_ROOT);
  assert.ok(files.length >= 8, `studio files scanned (${files.length})`);
  const offenders = [];
  for (const file of files) {
    const outcome = scan.scanForSecrets(fs.readFileSync(file, 'utf8'));
    if (!outcome.ok) offenders.push({ file: path.relative(REPO_ROOT, file), hits: outcome.hits.map((hit) => hit.code) });
  }
  assert.deepEqual(offenders, [], 'no secret shapes anywhere under studio/**');
});

// ---- P1: project & .dshpack through the service bundle -----------------------

test('projectInfo() adopts the real tree and reports a content digest', () => {
  const services = realServices();
  const info = services.projectInfo();
  assert.equal(info.ok, true, `real project loads (${info.code || ''})`);
  assert.equal(info.id, 'whale-office');
  assert.equal(info.schemaVersion, 1);
  assert.equal(info.root, path.join(REPO_ROOT, 'content'));
  assert.ok(info.fileCount > 50, `real file count (${info.fileCount})`);
  assert.deepEqual(info.missing, [], 'every declared path exists');
  assert.match(info.digest, /^[0-9a-f]{64}$/);
  assert.equal(info.counts.characters, 1);
  assert.equal(info.counts.actions, 8, 'the whole action set travels with the project');
});

test('info() carries the project handshake the panel shows', () => {
  const info = realServices().info();
  assert.deepEqual(info.project, { id: 'whale-office', label: '鲸鱼娘办公室', schemaVersion: 1 });
  assert.equal(info.projectRoot, path.join(REPO_ROOT, 'content'));
  assert.match(info.packsOutDir, /content[/\\]build[/\\]packs$/, 'default pack output is tool-owned space');
});

test('packRoundTrip() proves the real assets survive a pack cycle (hash-stable)', () => {
  const services = realServices();
  const outcome = services.packRoundTrip({});
  assert.equal(outcome.ok, true, `round trip clean (${outcome.stage} ${JSON.stringify(outcome.changed || [])})`);
  assert.equal(outcome.beforeDigest, outcome.afterDigest);
  assert.ok(outcome.files > 50);
});

test('a dry-run export reports size and digest without writing anything', () => {
  const services = realServices();
  const before = fs.existsSync(services.packsOutDir) ? fs.readdirSync(services.packsOutDir) : [];
  const outcome = services.packExport({ dryRun: true });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.bytes > 1_000_000);
  assert.match(outcome.packSha256, /^[0-9a-f]{64}$/);
  assert.equal(outcome.out, null, 'a dry run names no output file');
  const after = fs.existsSync(services.packsOutDir) ? fs.readdirSync(services.packsOutDir) : [];
  assert.deepEqual(after, before, 'the dry run leaves the packs directory untouched');
});

test('packImport() refuses a missing path and a bad destination loudly', () => {
  const services = realServices();
  assert.equal(services.packImport({}).code, 'PACK_PATH_REQUIRED');
  assert.equal(services.packImport({ file: '/tmp/nope.dshpack' }).code, 'IMPORT_DEST_REQUIRED');
  const unreadable = services.packImport({ file: '/tmp/definitely-not-a-pack.dshpack', dest: '/tmp/x' });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.code, 'PACK_FILE_MISSING', 'a missing pack has a stable, friendly code');
  // and a real file that is not a zip is refused as such
  const notAZip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-notzip-')), 'x.dshpack');
  fs.writeFileSync(notAZip, 'definitely not a zip archive');
  const wrongShape = services.packImport({ file: notAZip, dest: '/tmp/x' });
  assert.equal(wrongShape.ok, false);
  assert.ok(['PACK_NOT_ARCHIVE', 'PACK_MANIFEST_MISSING'].includes(wrongShape.code), `wrong-shape code (${wrongShape.code})`);
  fs.rmSync(path.dirname(notAZip), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the generation loop as a service (R5): stages / plan / run / triage
// ---------------------------------------------------------------------------

// A sandbox copy of the two real trees, so a run can be rehearsed without the
// repo's own content tree moving (the same discipline generation-loop.test.js
// uses for the CLI).
function loopSandbox(t, prefix = 'studio-loop-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const content = path.join(dir, 'content');
  const characters = path.join(dir, 'resources', 'characters');
  fs.mkdirSync(path.dirname(characters), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'content', 'characters'), path.join(content, 'characters'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default'), path.join(characters, 'deepseek-default'), { recursive: true });
  return { root: dir, content, characters };
}

function loopServices(tree) {
  return createStudioServices({
    repoRoot: tree.root,
    contentDir: tree.content,
    charactersRoot: tree.characters,
    packId: provenance.DEFAULT_PACK_ID,
  });
}

function runCli(args, { env = {} } = {}) {
  const { execFileSync } = require('node:child_process');
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [path.join(STUDIO_ROOT, 'bin', 'pipeline.js'), ...args], { cwd: STUDIO_ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 }) };
  } catch (error) {
    return { code: error.status === undefined ? 1 : error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
  }
}

test('pipelineStages() answers with the engine registry: ids, dependencies and cache-key params', () => {
  const services = realServices();
  const registry = services.pipelineStages();
  assert.equal(registry.ok, true);
  assert.deepEqual(registry.stages.map((stage) => stage.id), ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  const byId = Object.fromEntries(registry.stages.map((stage) => [stage.id, stage]));
  // the dependencies the stage view draws come from the engine's own consumes/produces
  assert.deepEqual(byId.S0.produces, ['reference-facts']);
  assert.deepEqual(byId.S4.paramKeys, ['options']);
  assert.ok(byId.S5.consumes.includes('cleaned-frames') && byId.S5.produces.includes('qc-report'));
  assert.ok(byId.S6.paramKeys.includes('packCanvas') && !byId.S6.paramKeys.includes('options'));
  assert.equal(byId.S1.providerClass, 'image', 'the model stages say which provider class they need');
  assert.equal(byId.S8.paramKeys.length, 0, 'publish takes no parameters of its own');
});

test('pipelinePlan() is the engine\'s dry walk: what runs, what hits, and why', (t) => {
  const tree = loopSandbox(t);
  const services = loopServices(tree);
  const plan = services.pipelinePlan({ actionId: 'walk-left', stages: ['S4', 'S5', 'S6'] });
  assert.equal(plan.ok, true, plan.error || plan.message);
  assert.deepEqual(plan.plan.wouldRun, ['S4', 'S5', 'S6'], 'a cold plan says everything will run');
  assert.deepEqual(plan.plan.wouldReuse, []);
  for (const entry of plan.plan.stages) {
    assert.ok(['hit', 'miss', 'stale-upstream', 'unknown-stage'].includes(entry.status), `${entry.id} reports an engine status (${entry.status})`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, `${entry.id} says WHY`);
    // a stage whose upstream will re-run has NO key yet — the engine says so instead
    // of inventing one (the panel must render that, not a fake key)
    if (entry.status === 'stale-upstream') {
      assert.equal(entry.key, null, `${entry.id} is stale-upstream: the key cannot be known yet`);
      assert.match(entry.reason, /upstream will re-run/, `${entry.id} names the upstream reason`);
    } else {
      assert.equal(typeof entry.key, 'string', `${entry.id} carries its cache key`);
    }
  }
  // S4 will run, so its output feeds S5/S6: the chain marks them stale-upstream
  assert.equal(plan.plan.stages[0].status, 'miss');
  assert.equal(plan.plan.stages[1].status, 'stale-upstream', 'S5 waits on S4\'s output bytes');
  assert.equal(plan.plan.stages[2].status, 'stale-upstream', 'S6 waits on S4\'s output bytes');
  // the dry walk executes nothing: no cache entries, no QC report, no triage file
  assert.equal(fs.existsSync(path.join(tree.root, '.studio-cache')), false, 'a plan creates no cache entries');
  assert.equal(fs.existsSync(path.join(tree.content, 'build', 'qc')), false, 'a plan writes no QC report');
  assert.equal(fs.existsSync(path.join(tree.content, 'build', 'triage')), false, 'a plan queues nothing');
});

test('pipelinePlan() on an office asset fails loudly with the CLI\'s own explanation', () => {
  const services = realServices();
  const plan = services.pipelinePlan({ actionId: 'flat-sofa' });
  assert.equal(plan.ok, false);
  assert.match(plan.note, /provenance report <assetId>/, 'the answer points at the passport, not at a fabricated run');
});

test('the service plan and the CLI plan agree field by field (one chain, two doors)', (t) => {
  const tree = loopSandbox(t);
  const env = { STUDIO_CONTENT_DIR: tree.content, STUDIO_CHARACTERS_ROOT: tree.characters };
  // the CLI first, on the cold cache, over the SAME explicit chain: its plan is the
  // reference the service must match (the panel always names its chain, so this is
  // the comparison that matters)
  const cli = runCli(['plan', 'walk-left', '--only', 'S4,S5,S6', '--json'], { env });
  assert.equal(cli.code, 0, cli.stdout);
  const cliPlan = JSON.parse(cli.stdout);
  const servicePlan = loopServices(tree).pipelinePlan({ actionId: 'walk-left', stages: ['S4', 'S5', 'S6'] });
  assert.equal(servicePlan.ok, true);
  assert.deepEqual(servicePlan.plan.wouldRun, cliPlan.wouldRun, 'the same stages will run');
  assert.deepEqual(servicePlan.plan.wouldReuse, cliPlan.wouldReuse, 'the same stages are reused');
  assert.deepEqual(servicePlan.stageIds, ['S4', 'S5', 'S6']);
  const cliById = Object.fromEntries(cliPlan.stages.map((entry) => [entry.id, entry]));
  for (const entry of servicePlan.plan.stages) {
    assert.equal(entry.status, cliById[entry.id].status, `${entry.id}: same status`);
    assert.equal(entry.key, cliById[entry.id].key, `${entry.id}: same cache key`);
    assert.deepEqual(entry.params, cliById[entry.id].params, `${entry.id}: same key params`);
  }
});

test('pipelineRun() executes, the second run is zero execution, and one parameter re-runs one segment', (t) => {
  const tree = loopSandbox(t);
  const services = loopServices(tree);
  const stages = ['S4', 'S5', 'S6'];

  const seen = [];
  const first = services.pipelineRun({ actionId: 'walk-left', stages, onStage: (record) => seen.push(record) });
  assert.equal(first.ok, true, `cold run clean (${JSON.stringify(first.outcome.triage)})`);
  assert.deepEqual(first.outcome.ran, stages);
  assert.deepEqual(first.outcome.cachedStages, []);
  assert.ok(seen.length >= stages.length, 'every stage record was streamed as it happened');
  assert.ok(seen.every((record) => typeof record.id === 'string' && typeof record.status === 'string'));
  assert.equal(first.ledger.enabled, false, 'the repo tree does not record unless asked (the CLI policy)');
  assert.equal(first.ledger.refused, null);
  // the policy is ENFORCED, not just reported: nothing lands in the ledger
  assert.deepEqual(first.ledger.recorded, []);
  assert.equal(fs.existsSync(path.join(tree.content, 'characters', 'whale-girl', 'provenance', 'generation')), false,
    'a run with the ledger off writes no ledger at all — computing the policy and writing anyway is the bug the R5 probe caught');

  const second = services.pipelineRun({ actionId: 'walk-left', stages });
  assert.equal(second.ok, true);
  assert.deepEqual(second.outcome.ran, [], 'nothing re-runs when nothing changed');
  assert.deepEqual(second.outcome.cachedStages, stages, 'every stage hits the cache');

  const changed = services.pipelineRun({ actionId: 'walk-left', stages, params: { packCanvas: 384 } });
  assert.deepEqual(changed.outcome.ran, ['S6'], 'packCanvas is an S6-only parameter');
  assert.deepEqual(changed.outcome.cachedStages, ['S4', 'S5']);

  const forced = services.pipelineRun({ actionId: 'walk-left', stages, force: true });
  assert.deepEqual(forced.outcome.ran, stages, '--force re-runs everything on purpose');
});

test('pipelineRun() ledgers the executed stages when asked, through the params door', (t) => {
  const tree = loopSandbox(t);
  const services = loopServices(tree);
  const first = services.pipelineRun({ actionId: 'walk-left', stages: ['S4', 'S5'], recordParams: true, agent: 'panel-test' });
  assert.equal(first.ok, true, first.error || '');
  assert.deepEqual(first.ledger.recorded, ['S4', 'S5']);
  const ledgerFile = path.join(tree.content, 'characters', 'whale-girl', 'provenance', 'generation', 'walk-left.params.json');
  assert.equal(fs.existsSync(ledgerFile), true, 'the ledger lands where the passport reads it');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(ledger.records.length, 2);
  for (const record of ledger.records) {
    assert.equal(record.agent, 'panel-test');
    assert.match(record.command, /^node studio\/bin\/pipeline\.js run walk-left --only S[45] --params /, 'the record carries the one-click reproduce command');
    assert.ok(record.outputs.every((row) => /^[0-9a-f]{64}$/.test(row.sha256)), 'every output carries a content hash');
  }
  // an identical call is deduped (content-addressed idempotence)
  const again = services.pipelineRun({ actionId: 'walk-left', stages: ['S4', 'S5'], recordParams: true, agent: 'panel-test' });
  assert.deepEqual(again.ledger.recorded, [], 'everything hit the cache — nothing new to record');
});

test('a QC-must-fail delivery goes to the triage queue, and the note is mandatory to resolve', (t) => {
  const tree = loopSandbox(t);
  const services = loopServices(tree);
  // the engine's own 必挂素材: one fully opaque frame — matting cannot invent alpha
  const delivery = path.join(tree.root, 'delivery', 'walk-left');
  fs.mkdirSync(delivery, { recursive: true });
  const png = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
  fs.writeFileSync(path.join(delivery, 'must-fail-01.png'), png.encodePng(Buffer.alloc(256 * 256 * 4, 255), 256, 256));

  const run = services.pipelineRun({ actionId: 'walk-left', stages: ['S4', 'S5'], deliveryDir: delivery });
  assert.equal(run.ok, false, 'a red QC finding fails the run');
  assert.equal(run.outcome.triage.length, 1, 'the item is queued exactly once');
  const entry = run.queued[0];
  assert.ok(entry, 'the queue names the entry id');
  const queueFile = path.join(tree.content, 'build', 'triage', 'walk-left.triage.json');
  assert.equal(run.queueFile, queueFile);
  const queued = JSON.parse(fs.readFileSync(queueFile, 'utf8')).entries[0];
  assert.equal(queued.stage, 'S5');
  assert.equal(queued.attempts, 4, 'the first attempt plus exactly 3 retries');
  assert.equal(queued.maxRetries, 3);
  assert.equal(queued.needsHuman, true);
  assert.match(queued.reason, /background/i, 'the entry says what is wrong');
  assert.match(queued.fix, /matting/i, 'and how to fix it');

  // the panel's list reads the same queue
  const listed = services.pipelineTriageList({ actionId: 'walk-left', status: 'open' });
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].id, queued.id);
  assert.equal(listed.dir, path.join(tree.content, 'build', 'triage'));

  // resolve fails closed without a note, and an unknown id is refused
  assert.equal(services.pipelineTriageResolve({ id: queued.id }).ok, false);
  assert.equal(services.pipelineTriageResolve({ id: queued.id, note: '   ' }).ok, false);
  assert.equal(services.pipelineTriageResolve({ id: 'no-such-id', note: 'x' }).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8')).entries[0].status, 'open', 'a failed resolve changes nothing');

  const resolved = services.pipelineTriageResolve({ id: queued.id, note: 're-issued the frame with a real matte', by: 'panel-test' });
  assert.equal(resolved.ok, true, resolved.error);
  assert.equal(resolved.entry.status, 'resolved');
  assert.equal(resolved.entry.resolution.note, 're-issued the frame with a real matte');
  assert.equal(resolved.entry.resolution.by, 'panel-test');
  const after = services.pipelineTriageList({ actionId: 'walk-left', status: 'open' });
  assert.deepEqual(after.entries, [], 'the open queue is empty once resolved');
  assert.equal(services.pipelineTriageList({ actionId: 'walk-left' }).entries.length, 1, 'and the resolved entry is still there — nothing is silently dropped');
});
