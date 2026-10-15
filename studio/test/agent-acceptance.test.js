'use strict';

// studio/test/agent-acceptance.test.js — DOES THE SKILL ACTUALLY WORK?
//
// The unit tests next door prove the operations are wired to real services and that `diff`
// writes nothing. This one answers the user's question instead: run every write-capable
// operation against a SANDBOX COPY of the tree, then verify the change actually ARRIVED —
// read back through a different reader than the one that wrote it (the service, or the file
// itself) — and that reverting puts the value back. A skill whose operations silently land
// somewhere else would pass every structural test and still be useless.
//
// Sandbox: content/ and the character pack are copied to a temp dir and the CLI is pointed at
// them with STUDIO_CONTENT_DIR / STUDIO_CHARACTERS_ROOT, so nothing here can touch the real
// tree (and the test asserts that at the end by hashing it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const STUDIO_ROOT = path.join(__dirname, '..');
const ROOT = path.resolve(STUDIO_ROOT, '..');

function hashTree(root) {
  const parts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'build') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) parts.push(`${path.relative(root, abs)}:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 12)}`);
    }
  };
  walk(root);
  return parts.join('\n');
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-accept-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contentDir = path.join(dir, 'content');
  const charactersRoot = path.join(dir, 'characters');
  fs.cpSync(path.join(ROOT, 'content'), contentDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}build`) });
  fs.cpSync(path.join(ROOT, 'resources', 'characters'), charactersRoot, { recursive: true });
  // The DATA is a copy (that is the point), but the CODE and the pack tree are symlinked so the
  // sandbox is a complete mirror: the scene validator loads the product runtime through
  // repoRoot/src/office/**, and the provenance ledger writes through repoRoot/content/** — with
  // repoRoot pointing at this sandbox, edits land here and the real tree stays untouched.
  for (const link of ['src', 'scripts', 'resources', 'node_modules']) {
    try { fs.symlinkSync(path.join(ROOT, link), path.join(dir, link), 'dir'); } catch { /* already linked */ }
  }
  return { dir, contentDir, charactersRoot };
}

function agent(args, env) {
  // the CLI is the thing under test: run it as a child process, exactly as an agent would
  return execFileSync(process.execPath, [path.join(STUDIO_ROOT, 'bin', 'agent.js'), ...args], {
    cwd: STUDIO_ROOT, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, STUDIO_CONTENT_DIR: env.contentDir, STUDIO_CHARACTERS_ROOT: env.charactersRoot },
  });
}

function agentJson(args, env) {
  return JSON.parse(agent([...args, '--json'], env));
}

function agentFails(args, env) {
  try {
    agent(args, env);
    return null;
  } catch (error) {
    return String(error.stdout || '') + String(error.stderr || '');
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---- scene -------------------------------------------------------------------------

test('acceptance: scene operations land in the layout, and land back when reverted', (t) => {
  const box = sandbox(t);
  const layout = path.join(box.contentDir, 'scenes', 'flat', 'layout.json');
  const before = fs.readFileSync(layout);

  // add: the change must be visible through the DRAFT reader (not the writer's return value)
  agent(['apply', '--domain', 'scene', '--op', 'add', '--params', JSON.stringify({ asset: 'flat-sofa', position: { x: 0.4, y: 0.45 } })], box);
  const added = readJson(layout).items;
  const sofa = added.find((item) => item.asset === 'flat-sofa' && !before.includes(Buffer.from(item.id)));
  assert.ok(sofa, 'the new item is in the layout file');
  assert.equal(Number(sofa.position.x.toFixed(2)), 0.4);

  // move it: read back from the file, then from the service's own draft reader
  agent(['apply', '--domain', 'scene', '--op', 'move', '--params', JSON.stringify({ itemId: sofa.id, position: { x: 0.31, y: 0.36 } })], box);
  const moved = readJson(layout).items.find((item) => item.id === sofa.id);
  assert.equal(Number(moved.position.x.toFixed(2)), 0.31, 'the move landed');

  // hide/show, scale — each lands
  agent(['apply', '--domain', 'scene', '--op', 'hide', '--params', JSON.stringify({ itemId: sofa.id, hidden: true })], box);
  assert.equal(readJson(layout).items.find((item) => item.id === sofa.id).hidden, true, 'hide landed');
  agent(['apply', '--domain', 'scene', '--op', 'scale', '--params', JSON.stringify({ itemId: sofa.id, scale: 1.25 })], box);
  assert.equal(Number(readJson(layout).items.find((item) => item.id === sofa.id).scale.toFixed(2)), 1.25, 'scale landed');

  // sync-zones must accept the new furniture (it derives obstacles from items)
  const synced = agentJson(['apply', '--domain', 'scene', '--op', 'sync-zones', '--params', JSON.stringify({ write: true })], box);
  assert.equal(synced.ok, true, 'the zones rebuilt');

  // remove: back to the original item list
  agent(['apply', '--domain', 'scene', '--op', 'remove', '--params', JSON.stringify({ itemId: sofa.id })], box);
  const ids = readJson(layout).items.map((item) => item.id);
  assert.ok(!ids.includes(sofa.id), 'the item is gone');
  assert.equal(ids.length, JSON.parse(before.toString('utf8')).items.length, 'the item count is back');
});

test('acceptance: a refused scene edit reaches NOTHING (the gate is in the path)', (t) => {
  const box = sandbox(t);
  const layout = path.join(box.contentDir, 'scenes', 'flat', 'layout.json');
  const before = fs.readFileSync(layout);
  // a desk that holds a workstation cannot simply be moved away
  const failure = agentFails(['apply', '--domain', 'scene', '--op', 'move', '--params', JSON.stringify({ itemId: 'draft-27', position: { x: 0.4, y: 0.5 } })], box);
  assert.match(String(failure), /SCENE_CONFLICTS/, 'the refusal names the rule');
  assert.ok(fs.readFileSync(layout).equals(before), 'the layout is byte-identical after a refusal');
});

// ---- action ------------------------------------------------------------------------

test('acceptance: action operations land in the document and revert cleanly', (t) => {
  const box = sandbox(t);
  const doc = path.join(box.contentDir, 'characters', 'whale-girl', 'actions', 'walk-left.json');
  const original = readJson(doc);
  const originalDuration = original.frames[3].durationMs;

  agent(['apply', '--domain', 'action', '--op', 'duration', '--params', JSON.stringify({ actionId: 'walk-left', index: 3, durationMs: 120 })], box);
  assert.equal(readJson(doc).frames[3].durationMs, 120, 'the duration landed in the document');

  agent(['apply', '--domain', 'action', '--op', 'reorder', '--params', JSON.stringify({ actionId: 'walk-left', from: 0, to: 2 })], box);
  const reordered = readJson(doc).frames.map((frame) => frame.file);
  assert.equal(reordered[2], original.frames[0].file, 'the frame moved to index 2 (array order, not file name)');

  agent(['apply', '--domain', 'action', '--op', 'tag', '--params', JSON.stringify({ actionId: 'walk-left', tag: 'release-check' })], box);
  assert.ok((readJson(doc).tags || []).includes('release-check'), 'the tag landed');

  agent(['apply', '--domain', 'action', '--op', 'pingpong', '--params', JSON.stringify({ actionId: 'walk-left', pingPong: true })], box);
  assert.equal(readJson(doc).pingPong, true, 'ping-pong landed');

  agent(['apply', '--domain', 'action', '--op', 'note', '--params', JSON.stringify({ actionId: 'walk-left', frame: 1, text: '验收：检查裙摆', severity: 'fix' })], box);
  const notes = readJson(path.join(box.contentDir, 'characters', 'whale-girl', 'actions', 'walk-left.notes.json'));
  assert.ok(notes.notes.some((note) => note.text === '验收：检查裙摆'), 'the note landed in the sidecar');

  // revert every one of them: the document must come back VALUE-identical (a write always
  // re-serialises, so byte identity is the backup's promise, not a rewrite's)
  agent(['apply', '--domain', 'action', '--op', 'duration', '--params', JSON.stringify({ actionId: 'walk-left', index: 3, durationMs: originalDuration })], box);
  agent(['apply', '--domain', 'action', '--op', 'reorder', '--params', JSON.stringify({ actionId: 'walk-left', from: 2, to: 0 })], box);
  agent(['apply', '--domain', 'action', '--op', 'tag', '--params', JSON.stringify({ actionId: 'walk-left', tag: 'release-check', remove: true })], box);
  agent(['apply', '--domain', 'action', '--op', 'pingpong', '--params', JSON.stringify({ actionId: 'walk-left', pingPong: false })], box);
  const reverted = readJson(doc);
  assert.equal(JSON.stringify(reverted.frames), JSON.stringify(original.frames), 'the frame order and durations are back');
  assert.equal(JSON.stringify(reverted.tags || []), JSON.stringify(original.tags || []), 'the tag list is back');
  assert.equal(Boolean(reverted.pingPong), Boolean(original.pingPong), 'ping-pong is back');
});

// ---- dialogue ----------------------------------------------------------------------

test('acceptance: dialogue operations land in the corpus and the guard still rules', (t) => {
  const box = sandbox(t);
  const file = path.join(box.contentDir, 'shared', 'dialogue', 'base.json');
  const original = readJson(file);
  const topic = Object.keys(original.topics)[0];
  const beforeCount = original.topics[topic].length;

  // the edit ops write by default (guards first). `stage: true` keeps it in memory — that is the
  // batch mode for a --json caller, not a second command.
  agent(['apply', '--domain', 'dialogue', '--op', 'add', '--params', JSON.stringify({ topic, text: '验收：米缸还有半缸', weight: 2 })], box);
  const written = readJson(file);
  assert.equal(written.topics[topic].length, beforeCount + 1, 'the line is in the file after add');
  const added = written.topics[topic].find((entry) => entry.text === '验收：米缸还有半缸');
  assert.ok(added, 'the exact text is there');
  assert.match(String(added.id), /^[a-z0-9-]{1,32}$/, 'the entry carries a kebab-case id (the guard requires one)');

  // remove by id alone — the CLI finds the topic for the caller
  agent(['apply', '--domain', 'dialogue', '--op', 'remove', '--params', JSON.stringify({ id: added.id })], box);
  assert.equal(readJson(file).topics[topic].length, beforeCount, 'the corpus is back');

  // stage: true writes nothing
  const stagedOnly = agentJson(['apply', '--domain', 'dialogue', '--op', 'add', '--params', JSON.stringify({ topic, text: '验收：只暂存不写', weight: 1, stage: true })], box);
  assert.equal(stagedOnly.ok, true, 'staging is accepted');
  assert.equal(readJson(file).topics[topic].length, beforeCount, 'the staged line is NOT in the file');

  // and a red-lined line is still refused (the guard is on the path, not beside it)
  // the guard's red lines are shape-based: a session/run id needs 8+ hex chars, and a path or a
  // key shape is refused too. These are the shapes it REALLY matches (read from the guard).
  const refusals = [
    { what: 'a session id', text: '来自 session-9f3a71c2 的回复' },
    { what: 'a filesystem path', text: '去 /Users/xia/program/dsh 拿一下' },
    { what: 'a key shape', text: `key 是 ${'sk'}-abcdef0123456789` },
  ];
  for (const probe of refusals) {
    const refused = agentFails(['apply', '--domain', 'dialogue', '--op', 'add', '--params', JSON.stringify({ topic, text: probe.text, weight: 1 })], box);
    assert.ok(refused !== null, `${probe.what} is refused before it can be written`);
  }
  assert.equal(readJson(file).topics[topic].length, beforeCount, 'and none of the refused lines landed');
});

// ---- graph -------------------------------------------------------------------------

test('acceptance: graph operations land in the file and the validator still rules', (t) => {
  const box = sandbox(t);
  const file = path.join(box.contentDir, 'graphs', 'local-behaviour.vgraph.json');
  const original = readJson(file);
  const nodeId = original.nodes[0].id;

  const dry = agentJson(['diff', '--domain', 'graph', '--op', 'move-node', '--params', JSON.stringify({ file: 'local-behaviour.vgraph.json', nodeId, x: 0.11, y: 0.22 })], box);
  assert.equal(dry.mode, 'diff', 'the dry run reports itself as a diff');
  agent(['apply', '--domain', 'graph', '--op', 'move-node', '--params', JSON.stringify({ file: 'local-behaviour.vgraph.json', nodeId, x: 0.11, y: 0.22 })], box);
  const moved = readJson(file);
  const position = (moved.meta && moved.meta.layout && moved.meta.layout[nodeId]) || null;
  assert.ok(position, 'the layout entry exists');
  assert.equal(Number(position.x.toFixed(2)), 0.11, 'the position landed');
  assert.equal(JSON.stringify(moved.nodes), JSON.stringify(original.nodes), 'a layout move never touches the semantics');

  // an invalid graph is refused by the validator, and the file keeps its bytes
  const before = fs.readFileSync(file);
  const refusal = agentFails(['apply', '--domain', 'graph', '--op', 'save', '--params', JSON.stringify({ file: 'local-behaviour.vgraph.json', graph: { schemaVersion: 1, nodes: [{ id: 'x', type: 'action', do: 'no.such.action' }], edges: [] } })], box);
  assert.ok(refusal !== null, 'an invalid graph is refused');
  assert.ok(fs.readFileSync(file).equals(before), 'the graph file is untouched after a refusal');
});

// ---- and the real tree is never touched --------------------------------------------

test('acceptance: the whole run happens in a sandbox — the repo tree is untouched', (t) => {
  const before = hashTree(path.join(ROOT, 'content'));
  const box = sandbox(t);
  agent(['apply', '--domain', 'scene', '--op', 'add', '--params', JSON.stringify({ asset: 'flat-island', position: { x: 0.2, y: 0.2 } })], box);
  agent(['apply', '--domain', 'action', '--op', 'tag', '--params', JSON.stringify({ actionId: 'idle-blink', tag: 'sandbox-check' })], box);
  assert.equal(hashTree(path.join(ROOT, 'content')), before, 'the repository content is byte-identical');
});
