'use strict';

// studio/test/provenance.test.js — 复现链引擎测试（`node --test studio/test/provenance.test.js`）。
//
// 纪律：
//   - 任何写操作都发生在 fs.mkdtempSync(os.tmpdir()) 沙箱里，t.after 清理；
//   - 绝不写 content/** / resources/** / photo/**：对真实树只读，断言的是真实字节与真实台账；
//   - 不依赖机器 git 历史：涉及历史找回的断言只接受"lost 或 traceable-in-history"两种诚实结论；
//   - 断言"没有台账时说 not-recorded / traceable-in-history"，而不是把报告刷绿。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  createProvenance,
  readParamsLedger,
  writeParamsRecord,
  PARAMS_DIR_RELATIVE,
  PARAMS_SCHEMA_VERSION,
  PARAMS_FILE_SUFFIX,
  STATUSES,
  SEGMENTS,
  RECORD_KINDS,
  DEFAULT_CHARACTER_ID,
  DEFAULT_PACK_ID,
  DEFAULT_INDEX_OUT_RELATIVE,
  TOOLS,
  sha256File,
  sha256Text,
  hashPrompt,
  normalizeParamsRecord,
  toolStatus,
  relFrom,
} = require('../lib/provenance.js');

const cli = require('../bin/provenance.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const realEngine = createProvenance({ repoRoot: REPO_ROOT });
const REAL_CONTENT_DIR = path.join(REPO_ROOT, 'content', 'characters', DEFAULT_CHARACTER_ID);

// ---------------------------------------------------------------------------
// 沙箱夹具：一棵"最小但真实形状"的 s1 树（pack + content + office + photo + catalog）
// ---------------------------------------------------------------------------

const FRAME_REL = 'assets/animations/walk/left/walk-left-b01.png';
const FRAME_BYTES = Buffer.from('fixture-walk-left-frame-bytes-v1');

function sandbox(prefix = 'provenance-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildFixture(root, opts = {}) {
  const { withPublishRecord = true, writeFrameFile = true, tools = true } = opts;
  const pack = path.join(root, 'resources', 'characters', DEFAULT_PACK_ID);
  fs.mkdirSync(path.join(pack, 'animation'), { recursive: true });
  fs.mkdirSync(path.join(pack, path.dirname(FRAME_REL)), { recursive: true });
  fs.writeFileSync(path.join(pack, 'animation', 'animations.json'), JSON.stringify({
    schemaVersion: 1,
    defaultFrameDurationMs: 1000,
    animations: {
      'walk-left': {
        loop: true,
        direction: 'left',
        frames: [{ file: FRAME_REL, durationMs: 83, anchor: { x: 178, y: 296 } }],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(pack, 'animation', 'anchors.json'), JSON.stringify({
    schemaVersion: 1,
    frames: { [FRAME_REL]: { outputAnchor: { x: 178, y: 296 } } },
  }, null, 2));
  fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: DEFAULT_PACK_ID, version: '1.1.0' }, null, 2));
  if (writeFrameFile) fs.writeFileSync(path.join(pack, FRAME_REL), FRAME_BYTES);

  const content = path.join(root, 'content', 'characters', DEFAULT_CHARACTER_ID);
  fs.mkdirSync(path.join(content, 'actions'), { recursive: true });
  fs.writeFileSync(path.join(content, 'actions', 'walk-left.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'walk-left',
    loop: true,
    direction: 'left',
    frames: [{ file: FRAME_REL, durationMs: 83 }],
  }, null, 2));
  if (withPublishRecord) {
    const provDir = path.join(content, 'provenance');
    fs.mkdirSync(provDir, { recursive: true });
    fs.writeFileSync(path.join(provDir, '2026-09-21T18-35-34-754Z-walk-left.json'), JSON.stringify({
      schemaVersion: 1,
      actionId: 'walk-left',
      packId: DEFAULT_PACK_ID,
      publishedAt: '2026-09-21T18:35:34.762Z',
      backupDirRelative: 'build/backups/2026-09-21T18-35-34-754Z',
      summary: 'sync 1 frame file(s) into the pack',
      frames: [FRAME_REL],
      files: { rewritten: [FRAME_REL], added: [] },
      changes: ['sync 1 frame file(s) into the pack'],
    }, null, 2));
  }

  // office：一个目录资产 + 一个在盘/缺失可控的 PNG
  fs.mkdirSync(path.join(root, 'src', 'office'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'office', 'layout-assets.js'), `'use strict';\nmodule.exports = {\n  LAYOUT_ASSETS: [{ id: 'prop-plant', kind: 'prop', label: '绿植', direction: 'none', src: './office-assets/prop-plant.png', directional: false }],\n  ARCHIVED_LAYOUT_ASSETS: [],\n};\n`);
  const office = path.join(root, 'resources', 'office');
  fs.mkdirSync(office, { recursive: true });
  if (!opts.omitOfficeFile) fs.writeFileSync(path.join(office, 'prop-plant.png'), Buffer.from('fixture-prop-plant-bytes'));

  // 链上工具（只建空文件：引擎只核查"在盘/历史可找回"，从不执行它们）
  if (tools) {
    for (const rel of [TOOLS.genFrames, TOOLS.removeBg, TOOLS.genProps, TOOLS.normalizeCharacter, TOOLS.actionPublisher, TOOLS.validator]) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# sandbox fixture tool: ${rel}\n`);
    }
  }

  // photo：只读素材树的锚点（测试里也只在沙箱里造）
  const photo = path.join(root, 'photo', 'output');
  fs.mkdirSync(photo, { recursive: true });
  fs.writeFileSync(path.join(photo, 'walk-left-01.png'), Buffer.from('fixture-photo-candidate'));

  return createProvenance({
    repoRoot: root,
    contentDir: content,
    charactersRoot: path.join(root, 'resources', 'characters'),
    officeRoot: office,
    photoRoot: path.join(root, 'photo'),
  });
}

function withSandbox(t, opts, fn) {
  const root = sandbox();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = buildFixture(root, opts);
  return fn(root, engine);
}

// ---------------------------------------------------------------------------
// 模块形状与常量
// ---------------------------------------------------------------------------

test('module shape: constants, statuses, segments, engine surface', () => {
  assert.equal(PARAMS_DIR_RELATIVE, 'provenance/generation');
  assert.equal(PARAMS_SCHEMA_VERSION, 1);
  assert.equal(PARAMS_FILE_SUFFIX, '.params.json');
  assert.deepEqual([...STATUSES], ['traceable', 'traceable-in-history', 'lost', 'not-recorded']);
  assert.deepEqual([...SEGMENTS], ['generation', 'matting', 'normalize', 'publish', 'on-disk']);
  assert.deepEqual([...RECORD_KINDS], ['image', 'video', 'frame-sheet']);
  assert.equal(DEFAULT_CHARACTER_ID, 'whale-girl');
  assert.equal(DEFAULT_PACK_ID, 'deepseek-default');
  assert.equal(DEFAULT_INDEX_OUT_RELATIVE, 'studio/build/provenance-index.json');
  assert.equal(typeof createProvenance, 'function');
  assert.equal(typeof readParamsLedger, 'function');
  assert.equal(typeof writeParamsRecord, 'function');
  assert.equal(typeof sha256File, 'function');
  assert.equal(typeof sha256Text, 'function');
  assert.equal(typeof hashPrompt, 'function');
  assert.equal(typeof normalizeParamsRecord, 'function');
  assert.equal(typeof toolStatus, 'function');
  assert.equal(typeof relFrom, 'function');
  assert.equal(typeof TOOLS.genFrames, 'string');

  const engine = createProvenance({ repoRoot: REPO_ROOT });
  for (const method of ['report', 'verify', 'index', 'lost', 'record', 'resolve', 'actionIds', 'officeAssets', 'readParams', 'toolChainStatus', 'snapshot']) {
    assert.equal(typeof engine[method], 'function', `engine.${method} must be a function`);
  }
  assert.equal(engine.indexDefaultOut, path.join(REPO_ROOT, 'studio', 'build', 'provenance-index.json'));
  const snap = engine.snapshot();
  assert.equal(snap.catalog.exists, true);
  assert.equal(snap.catalog.loadError, null);
  assert.ok(snap.catalog.active > 0 && snap.catalog.archived > 0);
  assert.equal(snap.pack.animations, true);
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('pure helpers: sha256File / sha256Text / hashPrompt / relFrom', (t) => {
  const root = sandbox('provenance-hash-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'bytes.bin');
  const bytes = Buffer.from('hello provenance');
  fs.writeFileSync(file, bytes);
  assert.equal(sha256File(file), sha256Text(bytes));
  assert.equal(hashPrompt('walk-left b-series'), sha256Text('walk-left b-series'));
  assert.match(hashPrompt('x'), /^[0-9a-f]{64}$/);
  assert.equal(relFrom(root, path.join(root, 'a', 'b.png')), 'a/b.png');
  assert.equal(relFrom(root, path.join(path.dirname(root), 'outside.png')), null);
  assert.throws(() => sha256File(path.join(root, 'missing.bin')));
});

// ---------------------------------------------------------------------------
// 参数台账：提示词默认只存哈希
// ---------------------------------------------------------------------------

test('normalizeParamsRecord hashes the prompt and stores text only on request', () => {
  const base = { actionId: 'walk-left', kind: 'frame-sheet', provider: 'openai-compatible', model: 'gpt-image-2', prompt: 'side view walking left' };
  const hashed = normalizeParamsRecord(base);
  assert.equal(hashed.ok, true);
  assert.equal(hashed.record.promptHash, hashPrompt('side view walking left'));
  assert.equal(Object.prototype.hasOwnProperty.call(hashed.record, 'prompt'), false, 'prompt text must NOT be stored by default');
  assert.equal(hashed.record.actionId, 'walk-left');
  assert.equal(hashed.record.kind, 'frame-sheet');
  assert.equal(hashed.record.schemaVersion, PARAMS_SCHEMA_VERSION);
  assert.match(hashed.record.recordedAt, /^\d{4}-\d{2}-\d{2}T/);

  const withText = normalizeParamsRecord({ ...base, storePromptText: true });
  assert.equal(withText.record.prompt, 'side view walking left');
  assert.equal(withText.record.promptHash, hashPrompt('side view walking left'));

  assert.equal(normalizeParamsRecord({ actionId: '../../etc/passwd' }).ok, false);
  assert.equal(normalizeParamsRecord({ actionId: 'walk-left', kind: 'audio' }).ok, false);
  assert.equal(normalizeParamsRecord({ actionId: 'walk-left' }).record.kind, 'image', 'kind defaults to image');
});

test('normalizeParamsRecord hashes an output path on the spot, and never invents one', (t) => {
  const root = sandbox('provenance-autohash-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'frame.png');
  fs.writeFileSync(file, FRAME_BYTES);
  const present = normalizeParamsRecord({
    actionId: 'walk-left',
    outputs: [{ path: file }, { path: path.join(root, 'missing.png') }],
  });
  assert.equal(present.record.outputs[0].sha256, sha256Text(FRAME_BYTES), 'path-only output gets hashed in place');
  assert.equal(present.record.outputs[0].path, file);
  assert.equal(Object.prototype.hasOwnProperty.call(present.record.outputs[1], 'sha256'), false, 'missing file must not get a fabricated hash');
});

test('writeParamsRecord appends without rewriting, and refuses bad input', (t) => {
  return withSandbox(t, {}, (root, engine) => {
    const first = writeParamsRecord({
      repoRoot: root,
      characterId: 'whale-girl',
      actionId: 'walk-left',
      record: { kind: 'frame-sheet', provider: 'p', model: 'm', prompt: 'prompt-1', outputs: [{ path: FRAME_REL, sha256: sha256Text(FRAME_BYTES) }] },
    });
    assert.equal(first.ok, true);
    assert.equal(first.file, path.join(root, 'content', 'characters', 'whale-girl', PARAMS_DIR_RELATIVE, 'walk-left.params.json'));
    assert.equal(fs.existsSync(first.file), true);
    const onDisk = JSON.parse(fs.readFileSync(first.file, 'utf8'));
    assert.equal(onDisk.schemaVersion, PARAMS_SCHEMA_VERSION);
    assert.equal(onDisk.actionId, 'walk-left');
    assert.equal(onDisk.records.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk.records[0], 'prompt'), false);

    const second = writeParamsRecord({
      repoRoot: root,
      characterId: 'whale-girl',
      actionId: 'walk-left',
      record: { kind: 'video', prompt: 'prompt-2', storePromptText: true, outputs: [{ path: FRAME_REL, sha256: sha256Text(FRAME_BYTES) }] },
    });
    assert.equal(second.ok, true);
    const appended = readParamsLedger({ repoRoot: root, characterId: 'whale-girl', actionId: 'walk-left' });
    assert.equal(appended.ok, true);
    assert.equal(appended.exists, true);
    assert.equal(appended.dir, path.join(root, 'content', 'characters', 'whale-girl', PARAMS_DIR_RELATIVE));
    assert.equal(appended.records.length, 2);
    assert.equal(appended.records[0].promptHash, hashPrompt('prompt-1'), 'first record must be untouched (append-only)');
    assert.equal(appended.records[0].kind, 'frame-sheet');
    assert.equal(appended.records[1].prompt, 'prompt-2');

    // 引擎只写台账，不碰包字节
    const packFile = path.join(root, 'resources', 'characters', DEFAULT_PACK_ID, FRAME_REL);
    assert.equal(sha256File(packFile), sha256Text(FRAME_BYTES), 'pack bytes must not be rewritten');

    // 坏输入：不落盘、不抛异常、返回 ok:false
    const bad = writeParamsRecord({ repoRoot: root, characterId: 'whale-girl', actionId: '../evil', record: { kind: 'image' } });
    assert.equal(bad.ok, false);
    assert.equal(fs.existsSync(path.join(root, 'content', 'characters', 'whale-girl', PARAMS_DIR_RELATIVE, 'evil.params.json')), false);
    const badKind = writeParamsRecord({ repoRoot: root, actionId: 'walk-left', record: { kind: 'nope' } });
    assert.equal(badKind.ok, false);

    // 台账损坏时拒绝改写（宁可失败也不覆盖历史）
    const ledgerFile = path.join(root, 'content', 'characters', 'whale-girl', PARAMS_DIR_RELATIVE, 'walk-left.params.json');
    const corrupted = '{ this is not json';
    fs.writeFileSync(ledgerFile, corrupted);
    const refused = writeParamsRecord({ repoRoot: root, actionId: 'walk-left', record: { kind: 'image' } });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /unparseable/);
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), corrupted, 'corrupt ledger must never be rewritten');
    const broken = readParamsLedger({ repoRoot: root, characterId: 'whale-girl', actionId: 'walk-left' });
    assert.equal(broken.ok, false);
    assert.equal(broken.exists, true);
    assert.match(broken.reason, /unparseable/);
  });
});

test('readParamsLedger reports an absent ledger honestly (real repo, no writes)', () => {
  // 真实树里 segment 1 台账还没建：必须是 ok:false / records:[]，而不是一个凭空可复现的绿灯
  for (const actionId of realEngine.actionIds()) {
    const ledger = readParamsLedger({ repoRoot: REPO_ROOT, characterId: 'whale-girl', actionId });
    assert.equal(ledger.ok, false, `${actionId} must not have a params ledger in the real repo`);
    assert.equal(ledger.exists, false);
    assert.deepEqual(ledger.records, []);
    assert.equal(ledger.dir, path.join(REAL_CONTENT_DIR, PARAMS_DIR_RELATIVE));
  }
});

// ---------------------------------------------------------------------------
// 引擎 record()（写）与 report()（读）闭环
// ---------------------------------------------------------------------------

test('engine.record closes the generation gap and flips segment 1 to traceable', (t) => {
  return withSandbox(t, {}, (root, engine) => {
    const before = engine.report('walk-left');
    assert.equal(before.kind, 'action');
    assert.equal(before.segments.length, 5);
    assert.equal(before.segments[0].id, 'generation');
    assert.equal(before.segments[0].status, 'traceable-in-history', 'publish record proves a run, but no params ledger yet');

    const packFile = path.join(root, 'resources', 'characters', DEFAULT_PACK_ID, FRAME_REL);
    const written = engine.record({
      actionId: 'walk-left',
      kind: 'frame-sheet',
      provider: 'openai-compatible',
      model: 'gpt-image-2',
      prompt: 'Walk-cycle sheet: side view facing left',
      params: { grid: '3x1', mode: 'edit', tolerance: 15 },
      seed: 4242,
      references: [{ path: 'photo/output/walk-left-01.png', sha256: sha256File(path.join(root, 'photo', 'output', 'walk-left-01.png')) }],
      outputs: [{ path: packFile, sha256: sha256File(packFile) }],
      command: 'node scripts/gen-frames.js --action walk-left --mode edit',
    });
    assert.equal(written.ok, true);
    assert.equal(written.fileRelative, `content/characters/whale-girl/${PARAMS_DIR_RELATIVE}/walk-left.params.json`);
    assert.equal(written.record.promptHash, hashPrompt('Walk-cycle sheet: side view facing left'));
    assert.equal(Object.prototype.hasOwnProperty.call(written.record, 'prompt'), false);
    assert.equal(written.record.references.length, 1);
    assert.equal(written.record.outputs.length, 1);

    const after = engine.report('walk-left');
    assert.equal(after.segments[0].status, 'traceable', 'ledger + matching output sha256 must make segment 1 traceable');
    assert.equal(after.segments[0].evidence.matchedOutputs, 1);
    assert.equal(after.segments[0].evidence.recordedOutputs, 1);
    assert.equal(after.segments[0].evidence.ledger.records, 1);
    assert.equal(after.segments[0].evidence.ledger.exists, true);
    assert.equal(after.reproducible, 'yellow', 'matting/normalize notes keep it off pure green — that is honest');
    assert.equal(after.segments[4].status, 'traceable');

    // 台账只追加
    const again = engine.record({ actionId: 'walk-left', kind: 'image', prompt: 'second call', outputs: [{ path: packFile, sha256: sha256File(packFile) }] });
    assert.equal(again.ok, true);
    assert.equal(engine.readParams('walk-left').records.length, 2);
    assert.equal(engine.readParams('walk-left').records[0].promptHash, hashPrompt('Walk-cycle sheet: side view facing left'));

    // 坏参数不落盘
    assert.equal(engine.record({ actionId: '../../../etc/passwd', kind: 'image' }).ok, false);
    assert.equal(engine.record({ actionId: 'walk-left', kind: 'audio' }).ok, false);
    assert.equal(fs.existsSync(path.join(root, 'content', 'characters', 'whale-girl', PARAMS_DIR_RELATIVE, 'passwd.params.json')), false);
  });
});

test('a ledger whose outputs are no longer on disk is never called traceable', (t) => {
  return withSandbox(t, {}, (root, engine) => {
    engine.record({
      actionId: 'walk-left',
      kind: 'frame-sheet',
      prompt: 'stale call',
      outputs: [{ path: FRAME_REL, sha256: 'f'.repeat(64) }],
    });
    const report = engine.report('walk-left');
    const generation = report.segments[0];
    assert.equal(generation.status, 'traceable-in-history');
    assert.equal(generation.evidence.matchedOutputs, 0);
    assert.equal(generation.evidence.unmatchedOutputs.length, 1);
    assert.ok(report.findings.some((f) => f.code === 'generation-outputs-not-on-disk' && f.level === 'yellow'));
  });
});

test('a missing frame is lost and red, not quietly green', (t) => {
  return withSandbox(t, { writeFrameFile: false }, (root, engine) => {
    const report = engine.report('walk-left');
    assert.equal(report.segments[4].status, 'lost');
    assert.equal(report.reproducible, 'red');
    assert.ok(report.findings.some((f) => f.code === 'frames-missing-on-disk' && f.level === 'red'));
    const verify = engine.verify();
    assert.equal(verify.counts.lost, 1);
    assert.equal(verify.ok, false);
    const lost = engine.lost();
    const entry = lost.entries.find((e) => e.id === 'walk-left' && e.segment === 'on-disk');
    assert.ok(entry, 'lost() must surface the missing frame');
    assert.equal(entry.status, 'lost');
    assert.ok(entry.anchors.some((a) => a.includes('walk-left-b01.png')));
  });
});

test('an office catalog asset missing on disk is a red reverse gap', (t) => {
  return withSandbox(t, { omitOfficeFile: true }, (root, engine) => {
    const report = engine.report('prop-plant');
    assert.equal(report.kind, 'office-asset');
    assert.equal(report.segments[4].status, 'lost');
    assert.equal(report.reproducible, 'red');
    assert.ok(report.findings.some((f) => f.code === 'office-texture-missing-on-disk'));
    assert.equal(report.file.exists, false);
    assert.equal(engine.verify().counts.lost, 1);
  });
});

test('unknown ids fail closed and list what is known', (t) => {
  return withSandbox(t, {}, (root, engine) => {
    const report = engine.report('no-such-asset');
    assert.equal(report.ok, false);
    assert.match(report.error, /unknown id/);
    assert.ok(report.known.includes('walk-left'));
    assert.ok(report.known.includes('prop-plant'));
    assert.deepEqual(report.segments, []);
    const hit = engine.resolve('prop-plant');
    assert.equal(hit.ok, true);
    assert.equal(hit.kind, 'office-asset');
  });
});

test('sandbox engine: tool chain status is a fact check, not a registry echo', (t) => {
  // 真实仓：工具在盘 → traceable（这是可复核的事实）
  assert.equal(toolStatus(REPO_ROOT, TOOLS.genFrames).status, 'traceable');
  assert.equal(realEngine.toolChainStatus('scripts/remove-bg.py').status, 'traceable');

  // 沙箱：把脚本目录整个拿掉 → 只能是 lost / traceable-in-history，绝不许说 traceable
  return withSandbox(t, { tools: false }, (root, engine) => {
    for (const rel of [TOOLS.genFrames, TOOLS.removeBg, TOOLS.actionPublisher]) {
      const status = engine.toolChainStatus(rel);
      assert.ok(['lost', 'traceable-in-history'].includes(status.status), `${rel} must not be claimed traceable`);
      assert.equal(status.onDisk, false);
      assert.ok(typeof status.note === 'string' && status.note.length > 0);
      if (status.status === 'traceable-in-history') assert.match(status.note, /git/);
    }
    const present = engine.toolChainStatus('src/office/layout-assets.js');
    assert.equal(present.status, 'traceable');
    assert.equal(present.onDisk, true);
  });
});

// ---------------------------------------------------------------------------
// 真实树（只读）：walk-left / working-back / idle-lunch / prop-plant / flat-desk
// ---------------------------------------------------------------------------

test('real repo: report("walk-left") has the five segments and an honest chain', () => {
  const report = realEngine.report('walk-left');
  assert.equal(report.ok, true);
  assert.equal(report.kind, 'action');
  assert.equal(report.id, 'walk-left');
  assert.equal(report.characterId, 'whale-girl');
  assert.equal(report.pack, 'deepseek-default');
  assert.deepEqual(report.segments.map((s) => s.id), [...SEGMENTS]);
  for (const segment of report.segments) {
    assert.ok(STATUSES.includes(segment.status), `${segment.id} status ${segment.status} is not a legal status`);
    assert.equal(typeof segment.evidence, 'object');
    assert.ok(Array.isArray(segment.notes));
  }
  assert.equal(report.segments[0].status, 'traceable-in-history', 'no params ledger in the real repo; the publish record proves a run');
  assert.equal(report.segments[0].evidence.ledger.exists, false);
  // the publish record is referenced by SHAPE, not by a frozen timestamp: re-publishing
  // an action (which this project does) must not break the passport test — the newest
  // record for the action is what should be cited, and it must exist on disk
  const publishRecord = report.segments[0].evidence.publishRecord.entry;
  assert.match(String(publishRecord), /\d{4}-\d{2}-\d{2}T[\d-]+Z-walk-left\.json$/, `the newest publish record is cited (${publishRecord})`);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'content', 'characters', 'whale-girl', 'provenance', path.basename(publishRecord))), true, 'the cited record exists');
  assert.equal(report.segments[4].status, 'traceable');
  assert.equal(report.animation.frameCount, 15);
  assert.ok(report.frames.every((f) => f.exists && typeof f.sha256 === 'string' && f.anchorRecorded));
  assert.equal(report.reproducible, 'yellow');
  assert.ok(report.findings.some((f) => f.code === 'generation-params-not-ledgered'));
  // 每帧都带 sha256 与 anchors 几何：在盘即"跑的就是这一份"可核对
  assert.equal(report.frames.filter((f) => f.anchor).length, 15);
});

test('real repo: working-back and idle-lunch reports resolve with 5 segments', () => {
  for (const id of ['working-back', 'idle-lunch', 'walk-up', 'sleeping']) {
    const report = realEngine.report(id);
    assert.equal(report.ok, true, `${id} must resolve`);
    assert.equal(report.kind, 'action');
    assert.equal(report.segments.length, 5);
    assert.ok(['green', 'yellow', 'red'].includes(report.reproducible));
    for (const segment of report.segments) assert.ok(STATUSES.includes(segment.status));
  }
});

test('real repo: office catalog assets report kind office-asset', () => {
  const flat = realEngine.report('flat-desk');
  assert.equal(flat.ok, true);
  assert.equal(flat.kind, 'office-asset');
  assert.deepEqual(flat.segments.map((s) => s.id), [...SEGMENTS]);
  assert.equal(flat.segments[0].status, 'not-recorded', 'flat/ art has no generator record — the honest answer');
  assert.equal(flat.segments[3].status, 'traceable', 'catalog registration is the publish record');
  assert.equal(flat.segments[4].status, 'traceable');
  assert.equal(typeof flat.file.sha256, 'string');
  assert.ok(flat.findings.some((f) => f.code === 'office-art-generation-not-recorded'));
  assert.equal(flat.contentBbox.w, 0.8261719);

  const prop = realEngine.report('prop-plant');
  assert.equal(prop.segments[0].status, 'traceable', 'gen-props.js is on disk in s1');
  assert.equal(prop.segments[0].evidence.tool, TOOLS.genProps);
  assert.equal(prop.segments[4].status, 'traceable');
  assert.ok(prop.findings.some((f) => f.code === 'office-prop-generation-params-unrecorded'));

  const archived = realEngine.report('prop-desk-front');
  assert.equal(archived.kind, 'office-asset');
  assert.equal(archived.archived, true);
});

test('real repo: catalog character images point back at their action chain', () => {
  const report = realEngine.report('whale-girl-front');
  assert.equal(report.kind, 'office-asset');
  assert.equal(report.segments[0].status, 'not-recorded');
  assert.equal(report.segments[0].evidence.followUp, 'report idle');
  assert.ok(report.findings.some((f) => f.code === 'office-character-asset-follows-action-chain'));
});

test('real repo: verify() covers every action and catalog asset without fabrication', () => {
  const verify = realEngine.verify();
  assert.equal(verify.ok, true, 'nothing is lost on disk in the real repo');
  const total = verify.counts.traceable + verify.counts.traceableInHistory + verify.counts.lost + verify.counts.notRecorded;
  assert.equal(total, verify.rows.length);
  assert.equal(verify.rows.length, realEngine.actionIds().length + realEngine.officeAssets().length);
  const ids = new Set(verify.rows.map((r) => r.id));
  for (const expected of ['walk-left', 'working-back', 'idle-lunch', 'prop-plant', 'flat-desk', 'whale-girl-back', 'prop-chair-front']) {
    assert.ok(ids.has(expected), `verify() must cover ${expected}`);
  }
  for (const row of verify.rows) {
    assert.ok(['action', 'office-asset'].includes(row.kind));
    assert.ok(STATUSES.includes(row.status), `${row.id} status ${row.status} is not a legal status`);
    assert.equal(row.segments.length, 5);
    assert.match(row.detail, /generation:(traceable|traceable-in-history|lost|not-recorded)/);
  }
  // 真实仓里没有任何 ledger：全部动作要么 not-recorded，只能靠发布记录证明"跑过一次"
  for (const row of verify.rows.filter((r) => r.kind === 'action')) {
    assert.notEqual(row.status, 'traceable', 'no action may claim a fully traceable chain while segment 1 has no ledger');
  }
});

test('real repo: lost() only lists unverifiable links, each with anchors', () => {
  const lost = realEngine.lost();
  assert.equal(lost.ok, true);
  assert.ok(lost.entries.length > 0);
  for (const entry of lost.entries) {
    assert.ok(['action', 'office-asset', 'tool'].includes(entry.kind));
    assert.ok(['traceable-in-history', 'not-recorded', 'lost'].includes(entry.status), `unexpected status ${entry.status}`);
    assert.ok(entry.segment && entry.reason);
    assert.ok(Array.isArray(entry.anchors) && entry.anchors.length > 0, 'every gap needs at least one recovery anchor');
    assert.ok(!entry.anchors.some((a) => typeof a !== 'string' || a.trim() === ''), 'anchors must be non-empty strings');
  }
  const walkLeft = lost.entries.find((e) => e.id === 'walk-left' && e.segment === 'generation');
  assert.ok(walkLeft, 'walk-left generation gap must be listed');
  assert.equal(walkLeft.status, 'traceable-in-history');
  assert.ok(walkLeft.anchors.some((a) => a.includes('provenance/generation/walk-left.params.json')));
  assert.ok(walkLeft.anchors.some((a) => /\d{4}-\d{2}-\d{2}T[\d-]+Z-walk-left\.json/.test(a)), 'a publish record anchor is offered (any dated record, not one frozen filename)');
  assert.ok(lost.entries.every((e) => e.status !== 'traceable'), 'traceable links are never gaps');
});

test('real repo: index writes a JSON index that mirrors verify()', (t) => {
  const out = path.join(sandbox('provenance-index-'), 'nested', 'provenance-index.json');
  t.after(() => fs.rmSync(path.dirname(path.dirname(out)), { recursive: true, force: true }));
  const result = realEngine.index({ out });
  assert.equal(result.ok, true);
  assert.equal(result.out, out);
  assert.equal(fs.existsSync(out), true);
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(onDisk.kind, 'asset-provenance-index');
  assert.equal(onDisk.entries.length, result.entries.length);
  assert.ok(onDisk.entries.length > 0);
  const verify = realEngine.verify();
  assert.equal(onDisk.counts.characterActions, verify.rows.filter((r) => r.kind === 'action').length);
  for (const id of ['walk-left', 'prop-plant', 'flat-desk']) {
    assert.ok(onDisk.entries.some((e) => e.id === id && e.reproducible));
  }
  assert.ok(Array.isArray(onDisk.chainGaps) && onDisk.chainGaps.length > 0);
  assert.equal(onDisk.tools.genFrames.status, 'traceable');
  // 索引落在沙箱，真实树一个字节都没动
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'content', 'characters', 'whale-girl', PARAMS_DIR_RELATIVE)), false);
});

test('real repo: no params ledger was created by these tests (read-only discipline)', () => {
  const genDir = path.join(REAL_CONTENT_DIR, PARAMS_DIR_RELATIVE);
  assert.equal(fs.existsSync(genDir), false, 'the generation ledger stays absent until someone records a real run');
  // 报告里的 sha256 必须等于现场重算的字节哈希（读的是真数据，不是缓存的旧值）
  const report = realEngine.report('walk-left');
  const packRoot = path.join(REPO_ROOT, 'resources', 'characters', DEFAULT_PACK_ID);
  for (const frame of report.frames) {
    assert.equal(frame.sha256, sha256File(path.join(packRoot, frame.file.replace(`resources/characters/${DEFAULT_PACK_ID}/`, ''))));
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(argv) {
  return execFileSync(process.execPath, [path.join(REPO_ROOT, 'studio', 'bin', 'provenance.js'), ...argv], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
}

test('cli.parseArgs parses flags, values and positionals', () => {
  const parsed = cli.parseArgs(['report', 'walk-left', '--json', '--repo=/tmp/x', '--kind', 'image']);
  assert.deepEqual(parsed._, ['report', 'walk-left']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.repo, '/tmp/x');
  assert.equal(parsed.kind, 'image');
  assert.ok(cli.USAGE.includes('provenance.js record --action <id>'));
});

test('cli.run: report / verify / lost / index are machine-readable', (t) => {
  const out = path.join(sandbox('provenance-cli-'), 'provenance-index.json');
  const root = path.dirname(out);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  buildFixture(root, {});

  const stdout = [];
  const originalLog = console.log;
  console.log = (...args) => stdout.push(args.join(' '));
  try {
    assert.equal(cli.run(['--repo', root, 'report', 'walk-left']), 0);
    const report = JSON.parse(stdout.pop());
    assert.equal(report.ok, true);
    assert.equal(report.kind, 'action');
    assert.deepEqual(report.segments.map((s) => s.id), [...SEGMENTS]);
    assert.equal(stdout.length, 0, 'report must print exactly one JSON document');

    assert.equal(cli.run(['--repo', root, 'verify', '--json']), 0);
    const verify = JSON.parse(stdout.pop());
    assert.equal(verify.counts.lost, 0);
    assert.ok(verify.rows.length >= 2);

    assert.equal(cli.run(['--repo', root, 'index', '--out', out, '--json']), 0);
    const indexSummary = JSON.parse(stdout.pop());
    assert.equal(indexSummary.out, out);
    assert.equal(indexSummary.entries, verify.rows.length);
    assert.equal(indexSummary.sample.length, Math.min(3, indexSummary.entries));
    assert.ok(indexSummary.sample.every((s) => typeof s === 'string' && s.includes('(')));
    assert.equal(stdout.length, 0);

    assert.equal(cli.run(['--repo', root, 'lost', '--json']), 0);
    const lost = JSON.parse(stdout.pop());
    assert.ok(lost.entries.length > 0);
    assert.equal(stdout.length, 0);

    assert.equal(cli.run(['--repo', root, 'record', '--action', 'walk-left', '--kind', 'frame-sheet',
      '--prompt', 'side view walking left', '--params', '{"grid":"3x1"}', '--seed', '4242',
      '--output', path.join(root, 'resources', 'characters', DEFAULT_PACK_ID, FRAME_REL), '--json']), 0);
    const recorded = JSON.parse(stdout.pop());
    assert.equal(recorded.ok, true);
    assert.equal(recorded.record.promptHash, hashPrompt('side view walking left'));
    assert.equal(Object.prototype.hasOwnProperty.call(recorded.record, 'prompt'), false);

    assert.equal(cli.run(['--repo', root, 'report', 'nope']), 2);
    assert.equal(cli.run(['--repo', root]), 2);
    assert.equal(cli.run(['--repo', root, 'record', '--action', 'walk-left', '--kind', 'audio']), 2);
    assert.equal(cli.run(['--repo', root, 'record', '--action', 'walk-left', '--params', 'not-json']), 2);
    assert.equal(stdout.length, 0, 'usage errors must stay off stdout');
  } finally {
    console.log = originalLog;
  }

  // 补上台账后 segment 1 才转 traceable（CLI 端到端验证缺口被关掉）
  const after = JSON.parse(runCli(['--repo', root, 'report', 'walk-left']));
  assert.equal(after.segments[0].status, 'traceable');
});

test('cli: verify on the real repo is JSON-parseable and exits 0', () => {
  const raw = runCli(['verify', '--json']);
  const verify = JSON.parse(raw);
  assert.equal(verify.repo, path.basename(REPO_ROOT));
  assert.equal(verify.counts.lost, 0);
  assert.ok(verify.rows.length > 0);
  const report = JSON.parse(runCli(['report', 'prop-plant']));
  assert.equal(report.kind, 'office-asset');
  const lost = JSON.parse(runCli(['lost', '--json']));
  assert.ok(lost.entries.length > 0);
  // 未知 id 的退出码是 2，且 stderr 不给 JSON
  let code = 0;
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'studio', 'bin', 'provenance.js'), 'report', 'nope'], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    code = e.status;
    assert.match(String(e.stderr), /unknown id/);
  }
  assert.equal(code, 2);
});
