'use strict';

// test/work-workspace-store.test.js — v0.7 P1 WP1：工作区与 Work Product 索引。
//
// 纪律：所有测试在系统临时目录里建真实工作区（fs 注入只用于故障场景），
// 断言"只写 .dsh/"、"索引只存相对路径"、"损坏索引 fail-closed"。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createWorkspaceStore, isSafeRelPath, resolveInside } = require('../src/work/workspace-store.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-work-'));
}

function makeStore(overrides = {}) {
  const home = overrides.home || tmpHome();
  const store = createWorkspaceStore({ homeDir: home, ...overrides });
  return { store, home };
}

function digestOf(text) {
  return `exec-sha256:${crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 16)}`;
}

function writeArtifact(workspace, jobId, kind, text) {
  const dir = path.join(workspace.path, '.dsh', 'artifacts', jobId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}.md`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

test('work-store: create initialises only .dsh (no other files touched)', () => {
  const { store, home } = makeStore();
  const workspace = store.open({ create: 'demo' });
  assert.equal(workspace.path, path.join(home, 'DshWorkspaces', 'demo'));
  assert.ok(fs.existsSync(path.join(workspace.path, '.dsh', 'work.json')));
  assert.ok(fs.existsSync(path.join(workspace.path, '.dsh', 'artifacts')));
  const index = JSON.parse(fs.readFileSync(path.join(workspace.path, '.dsh', 'index.json'), 'utf8'));
  assert.deepEqual(index, { schemaVersion: 1, workspaceId: workspace.workspaceId, items: [], artifacts: [] });
  // reopen is idempotent
  const again = store.open({ path: workspace.path });
  assert.equal(again.workspaceId, workspace.workspaceId);
});

test('work-store: opening an existing project leaves user files untouched', () => {
  const root = tmpHome();
  fs.writeFileSync(path.join(root, 'README.md'), '# user project\n');
  const { store } = makeStore();
  const workspace = store.open({ path: root });
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# user project\n');
  const topLevel = fs.readdirSync(root).sort();
  assert.deepEqual(topLevel, ['.dsh', 'README.md'], 'only .dsh was added');
});

test('work-store: workspace name is validated and a non-empty target is refused', () => {
  const { store, home } = makeStore();
  assert.throws(() => store.open({ create: '' }), /WORK_NAME_INVALID/);
  assert.throws(() => store.open({ create: '../escape' }), /WORK_NAME_INVALID/);
  const taken = path.join(home, 'DshWorkspaces', 'taken');
  fs.mkdirSync(taken, { recursive: true });
  fs.writeFileSync(path.join(taken, 'x.txt'), 'x');
  assert.throws(() => store.open({ create: 'taken' }), /WORK_NAME_TAKEN/);
});

test('work-store: relative paths, missing dirs and forbidden roots are refused', () => {
  const home = tmpHome();
  const { store } = makeStore({ home, forbiddenRoots: [path.join(home, 'appdata')] });
  assert.throws(() => store.open({ path: 'relative/dir' }), /WORK_PATH_INVALID/);
  assert.throws(() => store.open({ path: path.join(home, 'nope') }), /WORK_PATH_MISSING/);
  fs.mkdirSync(path.join(home, 'appdata'), { recursive: true });
  assert.throws(() => store.open({ path: path.join(home, 'appdata') }), /WORK_PATH_FORBIDDEN/);
});

test('work-store: artifact registration is idempotent and stores relative paths only', () => {
  const { store } = makeStore();
  const workspace = store.open({ create: 'artifacts' });
  const text = '# notes\n\nbody\n';
  const file = writeArtifact(workspace, 'job-1', 'research-notes', text);
  const rec = {
    jobId: 'job-1', kind: 'research-notes', role: 'researcher',
    runRef: 'exec-run:0123456789abcdef', attempt: 0,
    digest: digestOf(text), artifactPath: file, bytes: Buffer.byteLength(text),
  };
  store.registerArtifact(workspace, rec);
  store.registerArtifact(workspace, rec); // idempotent
  const index = store.readIndex(workspace);
  assert.equal(index.artifacts.length, 1);
  const entry = index.artifacts[0];
  assert.equal(entry.key, 'job-1:research-notes');
  assert.equal(entry.ref, 'ref:researcher-research-notes');
  assert.equal(entry.relPath, '.dsh/artifacts/job-1/research-notes.md');
  assert.equal(path.isAbsolute(entry.relPath), false, 'the index never stores absolute paths');
  const raw = JSON.parse(fs.readFileSync(path.join(workspace.path, '.dsh', 'index.json'), 'utf8'));
  assert.equal(JSON.stringify(raw).includes(workspace.path), false, 'no absolute path anywhere in the index');
  // persistence is owned by registerArtifact itself: a fresh store (new process) must see it.
  const fresh = createWorkspaceStore({ homeDir: path.dirname(path.dirname(workspace.path)) });
  const reopened = fresh.open({ path: workspace.path });
  assert.equal(fresh.readIndex(reopened).artifacts.length, 1, 'registration itself persists (not a later write)');
});

test('work-store: an artifact outside the workspace or with a bad digest is refused', () => {
  const { store } = makeStore();
  const workspace = store.open({ create: 'boundary' });
  const outside = path.join(tmpHome(), 'outside.md');
  fs.writeFileSync(outside, 'x');
  assert.throws(() => store.registerArtifact(workspace, {
    jobId: 'job-1', kind: 'research-notes', role: 'researcher', digest: digestOf('x'), artifactPath: outside,
  }), /WORK_PATH_INVALID/);
  assert.throws(() => store.registerArtifact(workspace, {
    jobId: 'job-1', kind: 'research-notes', role: 'researcher', digest: 'sha256:abc', artifactPath: outside,
  }), /WORK_ARTIFACT_INVALID/);
});

test('work-store: read validates existence and digest, and bounds the text', () => {
  const { store } = makeStore();
  const workspace = store.open({ create: 'read' });
  const text = 'x'.repeat(5000);
  const file = writeArtifact(workspace, 'job-2', 'research-notes', text);
  store.registerArtifact(workspace, {
    jobId: 'job-2', kind: 'research-notes', role: 'researcher', digest: digestOf(text), artifactPath: file,
  });
  const full = store.readArtifact(workspace, 'job-2:research-notes');
  assert.equal(full.ok, true);
  assert.equal(full.truncated, false);
  assert.equal(full.text.length, 5000);
  const bounded = store.readArtifact(workspace, 'job-2:research-notes', { maxBytes: 100 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.text.length, 100);
  // tampering is caught
  fs.writeFileSync(file, `${text}!`, 'utf8');
  assert.throws(() => store.readArtifact(workspace, 'job-2:research-notes'), /WORK_ARTIFACT_DIGEST_MISMATCH/);
});

test('work-store: a corrupted index is refused and left untouched (no silent rebuild)', () => {
  const { store } = makeStore();
  const workspace = store.open({ create: 'corrupt' });
  const indexPath = path.join(workspace.path, '.dsh', 'index.json');
  fs.writeFileSync(indexPath, '{ not json', 'utf8');
  assert.throws(() => store.reload(workspace), /WORK_INDEX_INVALID/);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), '{ not json', 'the broken index is preserved for recovery');
  // wrong workspace id is also refused
  fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, workspaceId: 'ws-deadbeef', items: [], artifacts: [] }));
  assert.throws(() => store.reload(workspace), /WORK_INDEX_INVALID/);
});

test('work-store: index validation rejects escaping artifact paths', () => {
  const { store } = makeStore();
  const workspace = store.open({ create: 'escape' });
  const indexPath = path.join(workspace.path, '.dsh', 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    items: [],
    artifacts: [{ key: 'a:b', relPath: '../outside.md', digest: 'exec-sha256:0123456789abcdef' }],
  }));
  assert.throws(() => store.reload(workspace), /WORK_INDEX_INVALID/);
  assert.equal(isSafeRelPath('../outside.md'), false);
  assert.equal(isSafeRelPath('a/../../b'), false);
  assert.equal(isSafeRelPath('.dsh/artifacts/x.md'), true);
  // resolveInside is the last line of defence: it must refuse on its own (not rely on callers).
  assert.throws(() => resolveInside('/tmp/ws', '../outside.md'), /WORK_PATH_INVALID/);
  assert.throws(() => resolveInside('/tmp/ws', '/etc/passwd'), /WORK_PATH_INVALID/);
  assert.throws(() => resolveInside('/tmp/ws', ''), /WORK_PATH_INVALID/);
  assert.equal(resolveInside('/tmp/ws', 'a/b.txt'), path.join('/tmp/ws', 'a/b.txt'));
});

test('work-store: item lifecycle persists; writes are atomic (no temp files left)', () => {
  const { store } = makeStore();
  const workspace = store.open({ create: 'items' });
  store.appendItem(workspace, {
    workItemId: 'wi-1', goal: '研究主题', templateId: 'research-review',
    status: 'running', runRef: null, startedAtMs: 1, finishedAtMs: null, artifactRefs: [], phase: null,
  });
  store.updateItem(workspace, 'wi-1', { status: 'completed', finishedAtMs: 2 });
  store.attachArtifactToItem(workspace, 'wi-1', 'job-1:research-notes');
  const index = JSON.parse(fs.readFileSync(path.join(workspace.path, '.dsh', 'index.json'), 'utf8'));
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].status, 'completed');
  assert.deepEqual(index.items[0].artifactRefs, ['job-1:research-notes']);
  const leftovers = fs.readdirSync(path.join(workspace.path, '.dsh')).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'atomic writes never leave temp files behind');
  assert.throws(() => store.updateItem(workspace, 'wi-unknown', { status: 'failed' }), /WORK_ITEM_UNKNOWN/);
});
