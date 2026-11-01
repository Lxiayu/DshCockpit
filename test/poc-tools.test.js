// test/poc-tools.test.js — Issue #9：POC 隔离工具的契约。
//
// 为什么 POC 工具也要有测试：
//   本轮 POC 首次运行时 mux 连接失败，差点被误读成"0.2.1 协议不兼容"。
//   真正的根因是**探针自身**把带 `?token=` 的启动 URL 传给了 createRuntimeMux
//   （生产代码传的是 origin）。如果当时没有先跑基线（0.1.5）做对照，
//   这个工具 bug 就会变成一个错误的架构结论——方向完全反过来。
//
//   所以 POC 工具的 URL 归一化与隔离边界必须有测试锁住。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'poc', 'protocol-probe.js');
const SH = path.join(ROOT, 'scripts', 'poc', 'runtime-poc.sh');

test('poc: the probe script and shell helper both exist', () => {
  assert.ok(fs.existsSync(PROBE), 'protocol-probe.js must exist');
  assert.ok(fs.existsSync(SH), 'runtime-poc.sh must exist');
});

test('poc: the shell helper passes `bash -n` (syntax gate)', () => {
  execFileSync('bash', ['-n', SH], { stdio: 'pipe' });
});

test('poc: the shell helper refuses to tear down a path outside the POC base', () => {
  // Safety property: teardown does `rm -rf`. It must never accept an arbitrary path.
  const src = fs.readFileSync(SH, 'utf8');
  assert.match(src, /case "\$root" in/, 'teardown must guard the target path');
  assert.match(src, /refusing to remove unexpected path/, 'and must refuse unexpected targets');
});

test('poc: isolation is structural — every path derives from POC_BASE', () => {
  const src = fs.readFileSync(SH, 'utf8');
  // DSH_HOME / workspace / logs / npm cache must all live under the POC root.
  for (const varName of ['DSH_HOME', 'DSH_WORKSPACE', 'DSH_POC_LOGS', 'npm_config_cache']) {
    assert.match(src, new RegExp(`export ${varName}='\\$\\{root\\}`), `${varName} must be rooted at the POC dir`);
  }
});

test('poc: the probe normalises a token URL to an origin before opening the mux', () => {
  // Regression guard for the exact defect found during the P0 POC run.
  // createRuntimeMux builds `wsUrl` by string-concatenating MUX_PATH, so a
  // baseUrl containing `?token=…` produces `ws://host/?token=…/api/remote.mux`
  // and the handshake hangs up. Production passes an origin (main.js).
  const src = fs.readFileSync(PROBE, 'utf8');
  assert.match(src, /new URL\(baseUrl\)/, 'the probe must parse the base url');
  assert.match(src, /u\.search = ''/, 'and strip the query string (the token)');
  assert.match(src, /origin/, 'keeping only the origin for the mux');
});

test('poc: the probe records failure states distinctly from success', () => {
  const src = fs.readFileSync(PROBE, 'utf8');
  // 四态纪律：not-verified / skipped 不得与 pass 混淆
  assert.match(src, /'not-verified'/, 'unverified capabilities must be recorded as not-verified');
  assert.match(src, /record\(/, 'results go through the record() helper');
  // 状态可以出现在字符串字面量或对象键位置，两种都接受
  const statuses = ['pass', 'fail', 'not-verified', 'skipped'];
  for (const st of statuses) {
    assert.ok(
      src.includes(`'${st}'`) || src.includes(`${st}:`) || src.includes(`${st} `),
      `status "${st}" must be representable in the probe`,
    );
  }
});

test('poc: the probe never writes outside the POC root', () => {
  const src = fs.readFileSync(PROBE, 'utf8');
  // All fs.write*/mkdir must be rooted at `root` (the POC dir).
  const writes = src.match(/fs\.(writeFileSync|mkdirSync|openSync)\(([^)]*)/g) || [];
  assert.ok(writes.length > 0, 'the probe does write reports');
  for (const w of writes) {
    assert.ok(
      /root|outFile|logsDir|mdPath|jsonPath|fd\b|path\.dirname\(outFile\)/.test(w),
      `write must target the POC root, got: ${w.slice(0, 120)}`,
    );
  }
});

test('poc: capability probing covers the six packages ADR-0002/0003 rely on', () => {
  const src = fs.readFileSync(PROBE, 'utf8');
  for (const pkg of [
    'dsh-experimental-agent-team',
    'dsh-experimental-worktree',
    'dsh-workspace-changes',
    'dsh-goal',
    'dsh-session-query-sqlite',
    'dsh-experimental-session-search',
  ]) {
    assert.ok(src.includes(pkg), `capability probe must check ${pkg}`);
  }
});
