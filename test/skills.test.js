// test/skills.test.js — Skills center (C4, v0.2.4): SKILL.md validation
// matrix, dependency-free zip extraction, atomic installs via a mocked
// codeload pipeline, installed-scan/upgrade/remove, local import and the
// market payload mapping.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  validateSkillMd,
  extractZipBuffer,
  stripZipRoot,
  findSkillCandidates,
  buildSkillsMarketPayload,
  createSkillsManager,
} = require('../src/skills');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skills-'));

const md = (name, desc, extra = '', body = 'Instructions go here.') =>
  `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n${body}\n`;

// ------------------------------------------------------------ zip builder
// Minimal zip writer (store + deflateRaw) — the reader ignores CRC fields,
// so this exercises exactly the structures extractZipBuffer parses.
function buildZip(files) {
  const parts = [];
  const centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    let data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    let method = 0;
    if (f.deflate) { data = zlib.deflateRawSync(data); method = 8; }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);  // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries — what the reader counts
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ------------------------------------------------------- validation matrix

test('validateSkillMd: valid file passes; E2–E7 and W1–W2 each map to their code', () => {
  // valid (with quoted description and an unknown-but-harmless extra key)
  const ok = validateSkillMd('---\nname: my-skill\ndescription: "Does things"\nallowed-tools: Bash\n---\n\nBody.\n');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.name, 'my-skill');
  assert.equal(ok.description, 'Does things');
  assert.equal(ok.content, 'Body.');

  // E2: no frontmatter fence
  const e2 = validateSkillMd('# Just markdown\nno frontmatter\n');
  assert.equal(e2.ok, false);
  assert.equal(e2.errors[0].code, 'e2');

  // E3: missing required fields (both called out)
  const e3 = validateSkillMd('---\nlicense: MIT\n---\nBody\n');
  assert.equal(e3.errors[0].code, 'e3');
  assert.match(e3.errors[0].params.field, /name/);
  assert.match(e3.errors[0].params.field, /description/);

  // E4: invalid name shape (camelCase / uppercase / > 64 chars)
  for (const bad of ['Bad_Name', 'UPPER', 'a'.repeat(65)]) {
    const e4 = validateSkillMd(md(bad, 'd'));
    assert.equal(e4.ok, false, `${bad} must be rejected`);
    assert.equal(e4.errors[0].code, 'e4');
  }
  // …while long-but-legal kebab names pass
  assert.equal(validateSkillMd(md(`${'a'.repeat(32)}-${'b'.repeat(31)}`, 'd')).ok, true);

  // E5: unparseable frontmatter line
  const e5 = validateSkillMd('---\nname: x\nthis line has no colon\n---\n');
  assert.equal(e5.errors[0].code, 'e5');
  assert.match(e5.errors[0].params.msg, /no colon/);

  // E7: legacy camelCase invocation keys (runtime would drop the whole skill)
  const e7 = validateSkillMd(md('x-skill', 'd', 'disableModelInvocation: true\n'));
  assert.equal(e7.ok, false);
  assert.equal(e7.errors[0].code, 'e7');
  assert.equal(e7.errors[0].params.canonical, 'disable-model-invocation');

  // W1: dir name ≠ skill name (non-blocking; install aligns to the name)
  const w1 = validateSkillMd(md('real-name', 'd'), { dirName: 'dirname' });
  assert.equal(w1.ok, true);
  assert.equal(w1.warnings[0].code, 'w1');
  assert.equal(w1.warnings[0].params.name, 'real-name');

  // W2: bundled scripts dir OR command-style instructions
  const w2a = validateSkillMd(md('s', 'd'), { hasScripts: true });
  assert.equal(w2a.warnings.some((w) => w.code === 'w2'), true);
  const w2b = validateSkillMd(md('s', 'd', '', 'Run `curl http://example.com` first.'));
  assert.equal(w2b.warnings.some((w) => w.code === 'w2'), true);
});

// --------------------------------------------- zip extraction + repo scan

test('extractZipBuffer + stripZipRoot + findSkillCandidates: store/deflate roundtrip and one-level skill discovery', () => {
  const zip = buildZip([
    { path: 'repo-abc/SKILL.md', data: md('root-skill', 'root') },                       // store
    { path: 'repo-abc/alpha/SKILL.md', data: md('alpha-skill', 'a'), deflate: true },    // deflate
    { path: 'repo-abc/alpha/scripts/run.sh', data: '#!/bin/sh\necho hi\n', deflate: true },
    { path: 'repo-abc/beta/SKILL.md', data: md('beta-skill', 'b') },
    { path: 'repo-abc/.github/SKILL.md', data: md('hidden', 'dot-dir noise') },           // skipped
    { path: 'repo-abc/deep/nested/SKILL.md', data: md('nested', 'two levels — not discovered') },
    { path: 'repo-abc/docs/', data: '' },                                                  // dir marker
    { path: 'repo-abc/README.md', data: '# repo\n' },
  ]);
  const files = stripZipRoot(extractZipBuffer(zip));
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.data.toString('utf8')]));
  assert.equal(files.every((f) => !f.path.startsWith('repo-abc/')), true, 'zip root must be stripped');
  assert.equal(byPath['alpha/SKILL.md'], md('alpha-skill', 'a'), 'deflate entry roundtrip');
  assert.equal(byPath['README.md'], '# repo\n', 'store entry roundtrip');
  assert.equal(byPath['docs'], undefined, 'directory markers are skipped');

  // exactly the two shapes dsh discovers: root + one-level dirs, dot-dirs out
  assert.deepEqual(findSkillCandidates(files.map((f) => f.path)), ['', 'alpha', 'beta']);
  assert.deepEqual(findSkillCandidates(['SKILL.md']), ['']);
  assert.deepEqual(findSkillCandidates(['a/b/SKILL.md', 'x.txt']), []);

  // corrupt input is rejected, not silently mis-parsed
  assert.throws(() => extractZipBuffer(Buffer.from('not a zip at all')), /end-of-central-directory/);
});

// ------------------------------------------ manager: mocked market pipeline

/** Mock GitHub: repos → default branch, commits → queued shas, codeload → zip. */
function ghMock(routes) {
  const json = (obj) => ({ ok: true, json: async () => obj });
  return async (url) => {
    for (const [re, resp] of routes) {
      if (re.test(url)) {
        const v = typeof resp === 'function' ? resp(url) : resp;
        if (typeof v === 'object' && v && (v.json || v.arrayBuffer)) return v;
        return json(v);
      }
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function newManager(fetchImpl) {
  const home = tmpDir();
  const staging = tmpDir();
  const mgr = createSkillsManager({
    dshHomeOf: () => home,
    stagingRoot: () => staging,
    log: () => {},
    fetchImpl,
  });
  return { mgr, home, staging, root: path.join(home, 'skills') };
}

const MULTI_ZIP = () => buildZip([
  { path: 'r-main/alpha/SKILL.md', data: md('alpha-skill', 'Alpha things.'), deflate: true },
  { path: 'r-main/alpha/references/api.md', data: 'api notes\n' }, // whole tree is kept
  { path: 'r-main/beta/SKILL.md', data: md('beta-skill', 'Beta things.') },
  { path: 'r-main/README.md', data: '# multi\n' },
]);

test('manager install: multi-skill repo → picker, pick-all installs atomically with pinned commit in the registry', async () => {
  let commits = 0;
  const { mgr, root } = newManager(ghMock([
    [/^https:\/\/api\.github\.com\/repos\/o\/multi$/, { default_branch: 'main' }],
    [/\/repos\/o\/multi\/commits\/main$/, () => ({ sha: commits++ === 0 ? '11111111111111111111' : '22222222222222222222' })],
    [/^https:\/\/codeload\.github\.com\/o\/multi\/zip\//, { ok: true, arrayBuffer: async () => MULTI_ZIP() }],
  ]));

  // no pick on a multi-skill repo → the candidate list for the UI picker
  const first = await mgr.install('o/multi', null);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'multi');
  assert.deepEqual(first.candidates.map((c) => c.name).sort(), ['alpha-skill', 'beta-skill']);
  assert.equal(fs.existsSync(root), false, 'nothing is written before a pick');

  // pick one / pick all — staging survives installs (it is a cache)
  const one = await mgr.install('o/multi', 'alpha');
  assert.equal(one.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'alpha-skill', 'references', 'api.md')), true, 'bundled files keep their tree');
  const all = await mgr.install('o/multi', 'all');
  assert.equal(all.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'beta-skill', 'SKILL.md')), true);

  // atomicity: no half-written .tmp-* trees remain
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.tmp-')), []);
  // version record: repo + pinned commit land in the registry dotfile
  const reg = JSON.parse(fs.readFileSync(path.join(root, '.dsh-cockpit-skills.json'), 'utf8'));
  assert.equal(reg['alpha-skill'].repo, 'o/multi');
  assert.equal(reg['alpha-skill'].commit, '11111111111111111111');

  // installed scan joins fs truth with registry metadata
  const installed = mgr.listInstalled();
  assert.deepEqual(installed.map((s) => s.name), ['alpha-skill', 'beta-skill']);
  assert.equal(installed[0].repo, 'o/multi');
  assert.equal(installed[0].source, 'market');
});

test('manager failure paths: network error → E6 with no half-written tree; non-skill repo → E1; bundle-plugin repo → plugin-form', async () => {
  const emptyZip = () => buildZip([{ path: 'r-main/README.md', data: '# docs\n' }]);
  const pluginZip = () => buildZip([
    { path: 'r-main/package.json', data: JSON.stringify({ name: 'x', dsh: {} }) },
    { path: 'r-main/src/index.js', data: '// plugin\n' },
  ]);
  const routes = [
    [/^https:\/\/api\.github\.com\/repos\/o\/down$/, () => { throw new Error('socket hang up'); }],
    [/^https:\/\/api\.github\.com\/repos\/o\/docs$/, { default_branch: 'main' }],
    [/\/repos\/o\/docs\/commits\/main$/, { sha: 'aaaaaaaaaaaaaaaaaaaa' }],
    [/^https:\/\/codeload\.github\.com\/o\/docs\/zip\//, { ok: true, arrayBuffer: async () => emptyZip() }],
    [/^https:\/\/api\.github\.com\/repos\/o\/pluginform$/, { default_branch: 'main' }],
    [/\/repos\/o\/pluginform\/commits\/main$/, { sha: 'bbbbbbbbbbbbbbbbbbbb' }],
    [/^https:\/\/codeload\.github\.com\/o\/pluginform\/zip\//, { ok: true, arrayBuffer: async () => pluginZip() }],
  ];
  const { mgr, root } = newManager(ghMock(routes));

  const e6 = await mgr.install('o/down', null);
  assert.equal(e6.ok, false);
  assert.equal(e6.code, 'e6');
  assert.equal(e6.errors[0].code, 'e6');
  assert.match(e6.errors[0].params.msg, /socket hang up/);

  const e1 = await mgr.install('o/docs', null);
  assert.equal(e1.ok, false);
  assert.equal(e1.code, 'e1');

  const pf = await mgr.preview('o/pluginform');
  assert.equal(pf.ok, false);
  assert.equal(pf.code, 'plugin-form'); // UI routes this to the plugin market

  // no skill ever landed — the skills root was never even created
  assert.equal(fs.existsSync(root), false);
});

test('fetchRepoZip abort budgets: hung connect and stalled body both surface as E6 with a readable timeout', async () => {
  const ghRoutes = ghMock([
    [/^https:\/\/api\.github\.com\/repos\/o\/hang$/, { default_branch: 'main' }],
    [/\/repos\/o\/hang\/commits\/main$/, { sha: '11111111111111111111' }],
  ]);
  const hangOnSignal = (signal, reject) => {
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
    }
  };
  const mk = (fetchImpl, timeouts) => createSkillsManager({
    dshHomeOf: () => tmpDir(),
    stagingRoot: () => tmpDir(),
    log: () => {},
    fetchImpl,
    ...timeouts,
  });

  // hung connect: the zip fetch never answers — only the abort signal stops it
  const hungConnect = async (url, opts) => {
    if (/codeload/.test(url)) return new Promise((_, reject) => hangOnSignal(opts.signal, reject));
    return ghRoutes(url, opts);
  };
  const r1 = await mk(hungConnect, { zipConnectTimeoutMs: 60, zipTotalTimeoutMs: 5_000 })
    .install('o/hang', null);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'e6');
  assert.match(r1.errors[0].params.msg, /zip download timed out \(no response within/);

  // stalled body: headers arrive, arrayBuffer never does — the total cap fires
  const stalledBody = async (url, opts) => {
    if (/codeload/.test(url)) {
      return { ok: true, arrayBuffer: () => new Promise((_, reject) => hangOnSignal(opts.signal, reject)) };
    }
    return ghRoutes(url, opts);
  };
  const r2 = await mk(stalledBody, { zipConnectTimeoutMs: 5_000, zipTotalTimeoutMs: 60 })
    .install('o/hang', null);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'e6');
  assert.match(r2.errors[0].params.msg, /zip download timed out \(not finished within/);
});

test('manager remove + upgrade: uninstall deletes dir and record; upgrade re-pins the newest commit', async () => {
  let sha = '11111111111111111111';
  const singleZip = () => buildZip([
    { path: 'r-main/SKILL.md', data: md('solo-skill', 'Solo.') },
  ]);
  const { mgr, root } = newManager(ghMock([
    [/^https:\/\/api\.github\.com\/repos\/o\/solo$/, { default_branch: 'main' }],
    [/\/repos\/o\/solo\/commits\/main$/, () => ({ sha })],
    [/^https:\/\/codeload\.github\.com\/o\/solo\/zip\//, { ok: true, arrayBuffer: async () => singleZip() }],
  ]));

  const inst = await mgr.install('o/solo', null); // single candidate auto-installs
  assert.equal(inst.ok, true);
  assert.deepEqual(inst.installed.map((i) => i.name), ['solo-skill']);

  sha = '22222222222222222222';
  const up = await mgr.upgrade('solo-skill');
  assert.equal(up.ok, true);
  assert.equal(up.commit, '22222222222222222222');
  const after = mgr.listInstalled();
  assert.equal(after[0].commit, '22222222222222222222');
  assert.equal(fs.existsSync(path.join(root, 'solo-skill', 'SKILL.md')), true);

  const rm = mgr.remove('solo-skill');
  assert.equal(rm.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'solo-skill')), false);
  assert.deepEqual(mgr.listInstalled(), []);
  const reg = JSON.parse(fs.readFileSync(path.join(root, '.dsh-cockpit-skills.json'), 'utf8'));
  assert.equal('solo-skill' in reg, false, 'registry entry must be dropped with the dir');
  assert.equal(mgr.remove('solo-skill').ok, false); // gone → missing
  assert.equal(mgr.remove('../escape').ok, false); // path-shaped names rejected
});

// ------------------------------------------------------------- local import

test('importLocal: root dir installs; collections multi → pick one/all; W1 aligns dir to name; bad dirs give E1/E3', () => {
  const { mgr, root } = newManager(async () => { throw new Error('network must not be touched'); });

  // root SKILL.md — imports as-is, recorded as a local source
  const solo = tmpDir();
  fs.writeFileSync(path.join(solo, 'SKILL.md'), md('local-skill', 'From my disk.'));
  const r1 = mgr.importLocal(solo);
  assert.equal(r1.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'local-skill', 'SKILL.md')), true);
  assert.equal(mgr.listInstalled()[0].source, 'local');

  // collection: 2 subdirs → multi with candidates (same picker as the market)
  const coll = tmpDir();
  fs.mkdirSync(path.join(coll, 'oldname'), { recursive: true });
  fs.writeFileSync(path.join(coll, 'oldname', 'SKILL.md'), md('aligned-name', 'dir differs from name'));
  fs.mkdirSync(path.join(coll, 'second'), { recursive: true });
  fs.writeFileSync(path.join(coll, 'second', 'SKILL.md'), md('second-skill', 'two'));
  const r2 = mgr.importLocal(coll);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'multi');
  assert.equal(r2.candidates.length, 2);

  // pick one: destination aligns to the frontmatter name (W1)
  const r3 = mgr.importLocal(coll, 'oldname');
  assert.equal(r3.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'aligned-name', 'SKILL.md')), true, 'dir renamed to skill name');
  assert.equal(fs.existsSync(path.join(root, 'oldname')), false);
  assert.equal(r3.installed[0].warnings.some((w) => w.code === 'w1'), true);
  // the source dir is never consumed
  assert.equal(fs.existsSync(path.join(coll, 'oldname', 'SKILL.md')), true);

  // pick all
  const r4 = mgr.importLocal(coll, 'all');
  assert.equal(r4.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'second-skill', 'SKILL.md')), true);

  // no SKILL.md → E1; nonexistent path → E1 wrapped as invalid; invalid frontmatter → invalid
  const plain = tmpDir();
  fs.writeFileSync(path.join(plain, 'README.md'), '# not a skill\n');
  assert.equal(mgr.importLocal(plain).code, 'e1');
  const gone = mgr.importLocal(path.join(plain, 'nope'));
  assert.equal(gone.code, 'invalid');
  assert.equal(gone.errors[0].code, 'e1');
  const bad = tmpDir();
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: x\n---\n'); // description missing
  const r5 = mgr.importLocal(bad);
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'invalid');
  assert.equal(r5.errors[0].code, 'e3');
});

// ------------------------------------------------------------ market mapping

test('buildSkillsMarketPayload: keeps only the skills category (both repo forms), joins stars and installed state', () => {
  const entries = [
    { fullName: 'a/pure-skill-repo', category: 'skills', desc: 'pure SKILL.md repo', descZh: '纯技能仓库' },
    { fullName: 'a/bundle-skill-pack', category: 'skills', desc: 'bundle plugin form' }, // form detected at install
    { fullName: 'a/ui-plugin', category: 'ui', desc: 'not a skill' },
    { fullName: 'a/theme', category: 'theme', desc: 'also not' },
  ];
  const starMap = { 'a/pure-skill-repo': { stars: 42, updated: '2026-08-01' } };
  const installed = new Set(['a/bundle-skill-pack']);
  const { count, skills } = buildSkillsMarketPayload(entries, starMap, installed);
  assert.equal(count, 2);
  assert.deepEqual(skills.map((s) => s.fullName), ['a/pure-skill-repo', 'a/bundle-skill-pack']);
  const byName = Object.fromEntries(skills.map((s) => [s.fullName, s]));
  assert.equal(byName['a/pure-skill-repo'].stars, 42);
  assert.equal(byName['a/pure-skill-repo'].updated, '2026-08-01');
  assert.equal(byName['a/pure-skill-repo'].installed, false);
  assert.equal(byName['a/bundle-skill-pack'].installed, true);
  assert.equal(byName['a/bundle-skill-pack'].stars, null); // unenriched renders as —
  // zh description preferred, en kept alongside for language switching
  assert.equal(byName['a/pure-skill-repo'].description, '纯技能仓库');
  assert.equal(byName['a/pure-skill-repo'].descriptionEn, 'pure SKILL.md repo');
  // empty inputs degrade to an empty payload
  assert.equal(buildSkillsMarketPayload([], {}, new Set()).count, 0);
});
