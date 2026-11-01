// test/check-licenses.test.js — Issue #14：许可证合规门禁。
//
// 为什么必须测这个：
//   DshCockpit 是 MIT。要集成的生态里有 AGPL-3.0-only（Obelisk）、AGPL 主仓
//   （OpenViking）、专有 SDK（Live2D Cubism Core）。一旦其中任何一个被打进
//   分发包，MIT 的授权承诺就不再成立——而这类问题**不会**在任何功能测试里
//   暴露出来。许可证门禁是唯一能拦住它的机制。
//
//   用户明确要求三件事：
//     1. 检查直接依赖
//     2. 检查间接（传递）依赖
//     3. 检查最终实际分发内容
//   以及："支持有依据的许可证例外，不允许未知或特殊许可证静默放过"。
//
// 本套件锁死：分类正确性、三个 gate 各自生效、例外必须有依据、
// 以及"未知不等于放行"。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { classify, check, LICENSE_EXCEPTIONS } = require('../scripts/check-licenses.js');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------- classification

test('classify: permissive licences are allowed', () => {
  for (const lic of ['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0']) {
    assert.strictEqual(classify(lic), 'allowed', `${lic} should be allowed`);
  }
});

test('classify: copyleft / commercial restrictions are denied', () => {
  for (const lic of ['AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'GPL-2.0', 'GPL-3.0-only', 'SSPL-1.0', 'BUSL-1.1', 'CC-BY-NC-SA-4.0']) {
    assert.strictEqual(classify(lic), 'denied', `${lic} must be denied`);
  }
});

test('classify: unknown / missing / NOASSERTION land in review, never silently allowed', () => {
  assert.strictEqual(classify(''), 'unknown');
  assert.strictEqual(classify(undefined), 'unknown');
  assert.strictEqual(classify(null), 'unknown');
  assert.strictEqual(classify('NOASSERTION'), 'review');
  assert.strictEqual(classify('SomeCustomProprietary'), 'review');
});

test('classify: SPDX OR is satisfied by either side; AND requires the strict side', () => {
  assert.strictEqual(classify('MIT OR Apache-2.0'), 'allowed');
  assert.strictEqual(classify('(MIT OR GPL-3.0)'), 'allowed', 'a GPL alternative does not poison a usable MIT option');
  assert.strictEqual(classify('MIT AND GPL-3.0'), 'denied', 'AND means both apply');
  assert.strictEqual(classify('MIT AND Apache-2.0'), 'allowed');
});

// ------------------------------------------------------------------ fixtures

function writeFixture({ pkg, lock }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lic-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
  return dir;
}

function basePkg(extraDeps = {}, extraDev = {}) {
  return {
    name: 'fixture', version: '1.0.0', license: 'MIT',
    dependencies: { good: '^1.0.0', ...extraDeps },
    devDependencies: { tool: '^1.0.0', ...extraDev },
  };
}

function baseLock({ prod = {}, dev = {} } = {}) {
  const packages = {
    '': { name: 'fixture', version: '1.0.0', license: 'MIT' },
  };
  const all = { ...prod, ...dev };
  for (const [name, meta] of Object.entries(all)) {
    packages[`node_modules/${name}`] = { version: meta.version || '1.0.0', license: meta.license, dev: !!meta.dev };
  }
  return { lockfileVersion: 3, packages };
}

// ------------------------------------------------------------------ gate tests

test('gate: a clean tree passes all three checks', () => {
  const dir = writeFixture({
    pkg: basePkg(),
    lock: baseLock({ prod: { good: { license: 'MIT' }, transitively: { license: 'Apache-2.0' } }, dev: { tool: { license: 'ISC', dev: true } } }),
  });
  const r = check({ root: dir });
  assert.strictEqual(r.ok, true, JSON.stringify({ f: r.failures, rev: r.reviews }));
});

test('gate: an AGPL TRANSITIVE dependency fails (would be missed if only direct deps were checked)', () => {
  const dir = writeFixture({
    pkg: basePkg(),
    lock: baseLock({ prod: { good: { license: 'MIT' }, sneaky: { license: 'AGPL-3.0-only' } } }),
  });
  const r = check({ root: dir });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'sneaky' && f.gate === 'transitive'),
    `expected transitive AGPL failure, got ${JSON.stringify(r.failures)}`);
});

test('gate: a devDependency AGPL does not fail (it never ships)', () => {
  const dir = writeFixture({
    pkg: basePkg({}, { devtool: '^1.0.0' }),
    lock: baseLock({ prod: { good: { license: 'MIT' } }, dev: { tool: { license: 'MIT', dev: true }, devtool: { license: 'AGPL-3.0-only', dev: true } } }),
  });
  const r = check({ root: dir });
  assert.strictEqual(r.ok, true, 'dev-only copyleft is out of the distribution, so it must not block the gate');
});

test('gate: an unknown licence in the production tree requires review (never silently passes)', () => {
  const dir = writeFixture({
    pkg: basePkg(),
    lock: baseLock({ prod: { good: { license: 'MIT' }, mystery: { license: '' } } }),
  });
  const r = check({ root: dir });
  assert.strictEqual(r.ok, false, 'an empty/unknown licence must not be treated as fine');
  assert.ok(r.reviews.some((x) => x.name === 'mystery'));
});

test('gate: distribution consistency notices a prod dependency missing from the lockfile', () => {
  const dir = writeFixture({
    pkg: basePkg({ ghost: '^1.0.0' }),
    lock: baseLock({ prod: { good: { license: 'MIT' } } }),
  });
  const r = check({ root: dir });
  assert.ok(r.warnings.some((w) => /ghost/.test(w) && /absent from lockfile/.test(w)),
    `expected a distribution warning for ghost, got ${JSON.stringify(r.warnings)}`);
});

test('exceptions: the registry is structured (reason + approver), not a bare allowlist', () => {
  // Even if empty, the contract is that every entry carries evidence.
  for (const [key, ex] of Object.entries(LICENSE_EXCEPTIONS)) {
    assert.ok(ex.reason && ex.reason.length > 0, `exception ${key} must explain itself`);
    assert.ok(ex.approvedBy && ex.approvedBy.length > 0, `exception ${key} must name an approver`);
    assert.ok(ex.since && /^\d{4}-\d{2}-\d{2}$/.test(ex.since), `exception ${key} must be dated`);
  }
});

// -------------------------------------------------------------------- CLI

test('CLI: --self-test passes', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-licenses.js'), '--self-test'], { encoding: 'utf8' });
  assert.match(out, /self-test OK/);
});

test('CLI: exits 1 on a denied licence and names the package', () => {
  const dir = writeFixture({
    pkg: basePkg(),
    lock: baseLock({ prod: { bad: { license: 'SSPL-1.0' } } }),
  });
  let code = 0; let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-licenses.js'), '--root', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { code = err.status; out = `${err.stdout || ''}${err.stderr || ''}`; }
  assert.strictEqual(code, 1);
  assert.match(out, /SSPL-1\.0/);
  assert.match(out, /DENIED/);
});

test('CLI: missing lockfile is a hard error, not a silent pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lic-nolock-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(basePkg()));
  let code = 0; let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-licenses.js'), '--root', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { code = err.status; out = `${err.stdout || ''}${err.stderr || ''}`; }
  assert.strictEqual(code, 2, 'a missing lockfile must not be treated as "nothing to check"');
  assert.match(out, /package-lock\.json/);
});

// --------------------------------------------------- the real repository

test('REAL: this repository currently passes its own licence gate', () => {
  const r = check({ root: ROOT });
  assert.strictEqual(r.ok, true,
    `the repo must stay licence-clean; failures=${JSON.stringify(r.failures)} reviews=${JSON.stringify(r.reviews)}`);
});

test('REAL: the gate actually inspects transitive packages (not just the 10 direct deps)', () => {
  const r = check({ root: ROOT });
  assert.ok(r.gates.transitive.count > 50,
    `expected a meaningful transitive tree, got ${r.gates.transitive.count}`);
  assert.ok(r.gates.transitive.count > r.gates.direct.prod,
    'transitive count must exceed direct, otherwise gate 2 is doing nothing');
});
