// test/mission-workspace-gitignore.test.js — `.dsh/` 必须自我忽略（TD-14）。
//
// 第一性原理：我们是在**用户的 git 仓库**里写数据
//
//   DshCockpit 会往 `<ws>/.dsh/**` 写 mission / grants / artifacts / audit / ui-seen。
//   那是用户的仓库，不是我们的数据目录。
//
//   如果什么都不做，用户 `git status` 就会看到一堆 `.dsh/` 下的未跟踪文件：
//   要么他手动加 .gitignore（多数人不会），要么哪天在一个 PR 里不小心提交进去
//   （里面可能有他的 Mission 记录、决策、审计）。
//   **这等于我们往别人的仓库里塞东西，还让他收拾。**
//
//   修法：每次创建 `.dsh/` 时顺手放一个自我忽略的 `.gitignore`。
//   放在 `<ws>/.dsh/.gitignore` 而不是改用户根目录的那个 ——
//   不动用户的文件，删掉 `.dsh/` 就一切复原。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { ensureDshDir, ensureSelfIgnore, SELF_IGNORE } = require('../src/mission/workspace-dir.js');
const { createMissionStore } = require('../src/mission/store.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gi-')); }

/** 真实的 Mission 事件（字段必须齐全，否则 append 会被 schema 拒绝）。 */
function appendOne(store) {
  return store.append('mission.created', {
    missionId: 'mis-abc123',
    workspaceId: 'ws-abc123',
    title: 't',
    intent: 'i',
    status: 'active',
    createdAtMs: 1_000_000,
    updatedAtMs: 1_000_000,
  });
}

test('gitignore: ensureDshDir creates .dsh + a self-ignore file', () => {
  const dir = tmp();
  try {
    const dsh = ensureDshDir(dir);
    assert.equal(dsh, path.join(dir, '.dsh'));
    const gi = path.join(dsh, '.gitignore');
    assert.ok(fs.existsSync(gi), '.dsh/.gitignore must exist');
    const body = fs.readFileSync(gi, 'utf8');
    assert.match(body, /^\*$/m, 'it must ignore everything in the directory');
    // ⚠️ 刻意**不**加 `!.gitignore`。
    //   实测：`*` + `!.gitignore` 会让 git 认为目录里有该跟踪的文件，
    //   于是 `git status` 仍显示 `?? .dsh/`；只有纯 `*` 才能让目录彻底消失。
    //   （下面那条"git ACTUALLY ignores"就是在守这个。）
    assert.doesNotMatch(body, /^!\.gitignore$/m,
      'keeping .gitignore visible makes git traverse the dir and report "?? .dsh/"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitignore: writing a mission event creates it automatically', () => {
  // 这是真正的端到端行为：用户什么都没做，只是用了产品。
  const dir = tmp();
  try {
    const store = createMissionStore({ workspaceDir: dir, now: () => 1_000_000, log: () => {} });
    const r = appendOne(store);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(dir, '.dsh', '.gitignore')),
      'writing the first event must bring the self-ignore with it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitignore: git ACTUALLY ignores the runtime data (not just a file on disk)', () => {
  // 前两条只证明"文件存在"。真正要证明的是 **git 会忽略它** ——
  // 否则我们只是往仓库里多塞了三个文件而已。
  const dir = tmp();
  try {
    if (process.env.CI === '1') {
      // CI 里没有保证 git 可用；不把环境缺失当成通过。
      return;
    }
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return; }

    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    const store = createMissionStore({ workspaceDir: dir, now: () => 1_000_000, log: () => {} });
    assert.equal(appendOne(store).ok, true);

    // 写一个不该被忽略的文件做对照
    fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'x');

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    assert.ok(!status.includes('.dsh/'),
      `.dsh/ runtime data must not show up in git status, got:\n${status}`);
    assert.ok(status.includes('keep-me.txt'),
      'the control file must still show up — otherwise the test proves nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitignore: an existing .gitignore is never overwritten', () => {
  // 用户可能自己改过（比如 `!重要文件`）。覆盖它等于篡改用户文件。
  const dir = tmp();
  try {
    const dsh = path.join(dir, '.dsh');
    fs.mkdirSync(dsh, { recursive: true });
    const custom = '# mine\n*\n!keep.json\n';
    fs.writeFileSync(path.join(dsh, '.gitignore'), custom);
    ensureSelfIgnore(dsh);
    assert.equal(fs.readFileSync(path.join(dsh, '.gitignore'), 'utf8'), custom,
      'a user-edited .gitignore must be left alone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitignore: a failure to write it never blocks the actual data write', () => {
  // 数据能写进去比"记得忽略"重要得多。
  // 这里用一个只读的 .dsh 目录模拟失败：ensureSelfIgnore 不得抛错。
  const dir = tmp();
  try {
    const dsh = path.join(dir, '.dsh');
    fs.mkdirSync(dsh, { recursive: true });
    fs.chmodSync(dsh, 0o500); // read + execute, no write
    assert.doesNotThrow(() => ensureSelfIgnore(dsh));
  } finally {
    try { fs.chmodSync(path.join(dir, '.dsh'), 0o700); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore: the ignore body explains itself (not just a bare *)', () => {
  assert.match(SELF_IGNORE, /DshCockpit/, 'a user opening this file must know who wrote it');
  assert.match(SELF_IGNORE, /不要提交|不要/, 'and why it exists');
});

test('gitignore: every module that writes under .dsh/ uses the shared helper', () => {
  // 各模块各写一遍是不可能不漏的。这条保证写入点都走同一个实现。
  const writers = ['event-log.js', 'audit-store.js', 'brief-sync.js', 'grant.js'];
  for (const name of writers) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mission', name), 'utf8');
    assert.match(src, /require\('\.\/workspace-dir'\)/,
      `${name} writes under .dsh/ and must use the shared ensureSelfIgnore`);
  }
});
