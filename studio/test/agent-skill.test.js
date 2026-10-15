'use strict';

// studio/test/agent-skill.test.js — the AGENT SKILL is code-adjacent, so it is tested.
//
// The skill (studio/skills/workbench/SKILL.md) tells an external coding agent how to develop
// this workbench from the command line. A skill that drifts from the code is worse than no
// skill: the agent proposes operations that no longer exist, or reads a table that promises
// something the services stopped doing. So the contract is:
//
//   1. every operation in studio/bin/agent.js maps onto a service method that EXISTS on the
//      real service bundle (checked by calling createStudioServices and reading the method);
//   2. the generated reference (reference/operations.md) is byte-identical to what the CLI
//      prints today — the file is generated, and a hand edit fails the test;
//   3. the four content domains (scene / action / dialogue / graph) are all represented, so
//      "I could not find an operation for X" is never caused by a missing domain;
//   4. the skill documents the loop (capabilities → diff → apply → check), names the CLI and
//      carries the red lines (no direct content writes, no secrets) — the parts an agent that
//      only reads SKILL.md must not miss;
//   5. the discovery pointers exist where external tools look for them (.claude/skills/…,
//      studio/AGENTS.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STUDIO_ROOT = path.join(__dirname, '..');
const ROOT = path.resolve(STUDIO_ROOT, '..');
const { OPERATIONS, services } = require(path.join(STUDIO_ROOT, 'bin', 'agent.js'));

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('every agent operation drives a service method that really exists', () => {
  // the CLI's OWN bundle: re-assembling it here would let the test pass while the CLI resolved
  // nothing (which is exactly what happened before this line existed)
  const bundle = services();
  assert.ok(OPERATIONS.length >= 12, `the table carries the surface (${OPERATIONS.length} operations)`);
  for (const entry of OPERATIONS) {
    assert.equal(typeof entry.run, 'function', `${entry.domain}.${entry.op} has a runner`);
    assert.ok(entry.summary && entry.summary.length > 4, `${entry.domain}.${entry.op} explains itself`);
    assert.ok(entry.params && typeof entry.params === 'object', `${entry.domain}.${entry.op} shows an example`);
    // the name may be dotted (tool.actionOp) because two bundles serve the CLI: the studio's
    // own services and the shared workbench ones the action panel drives
    const resolved = entry.service.split('.').reduce((value, key) => (value ? value[key] : undefined), bundle);
    assert.equal(typeof resolved, 'function', `${entry.domain}.${entry.op} names a real service (${entry.service})`);
  }
  // all four content domains an agent may need to touch
  const domains = new Set(OPERATIONS.map((entry) => entry.domain));
  for (const domain of ['scene', 'action', 'dialogue', 'graph']) assert.ok(domains.has(domain), `${domain} is covered`);
  // write paths must be honest about writing
  for (const entry of OPERATIONS.filter((row) => ['dialogue.save', 'graph.save', 'scene.sync-zones'].includes(`${row.domain}.${row.op}`))) {
    assert.equal(entry.writes, true, `${entry.domain}.${entry.op} is marked as a write`);
  }
});

test('`diff` writes NOTHING for every write-capable operation (the CLI\'s central promise)', () => {
  // The promise is what makes the skill usable: an agent can propose freely and only "apply"
  // changes anything. It is also the promise that was BROKEN at first — the M1 action kernel has
  // no dry-run mode, so a naive diff really did write the file. This test hashes the whole
  // content tree (minus tool output) before and after each diff and compares.
  const crypto = require('node:crypto');
  const contentDir = path.join(ROOT, 'content');
  const digestTree = () => {
    const parts = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'build') continue;                      // tool output, not content
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) parts.push(`${path.relative(contentDir, abs)}:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
      }
    };
    walk(contentDir);
    return parts.join('\n');
  };
  const writeRows = OPERATIONS.filter((entry) => entry.writes === true);
  assert.ok(writeRows.length >= 8, `the write surface is covered (${writeRows.length} operations)`);
  for (const entry of writeRows) {
    const before = digestTree();
    // a diff may legitimately FAIL (a refused edit) — what matters is that it wrote nothing
    try {
      execFileSync(process.execPath, [
        path.join(STUDIO_ROOT, 'bin', 'agent.js'), 'diff',
        '--domain', entry.domain, '--op', entry.op,
        '--params', JSON.stringify(entry.params),
      ], { cwd: STUDIO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* exit 1 = refused, which is fine here */ }
    assert.equal(digestTree(), before, `${entry.domain}.${entry.op}: diff must not touch content`);
  }
  // and the journal (tool output, under content/build) must not appear in that digest
  assert.ok(fs.existsSync(path.join(contentDir, 'build', 'agent-log.jsonl')), 'the journal exists under content/build (ignored on purpose)');
});

test('the generated operation reference is what the CLI prints today (no hand edits)', () => {
  const generated = execFileSync(process.execPath, [path.join(STUDIO_ROOT, 'bin', 'agent.js'), 'capabilities', '--md'], { cwd: STUDIO_ROOT, encoding: 'utf8' });
  const onDisk = read('studio/skills/workbench/reference/operations.md');
  assert.equal(onDisk, generated, 'reference/operations.md is generated — run: node bin/agent.js capabilities --md > studio/skills/workbench/reference/operations.md');
  assert.match(onDisk, /由 `node studio\/bin\/agent\.js capabilities --md` 生成/, 'the file says it is generated');
  for (const domain of ['scene', 'action', 'dialogue', 'graph']) assert.ok(onDisk.includes(`## ${domain}`), `${domain} has a section`);
});

test('the skill teaches the loop, the CLI and the red lines', () => {
  const skill = read('studio/skills/workbench/SKILL.md');
  // frontmatter that a skill loader can read
  assert.match(skill, /^---\nname: [a-z0-9-]+\ndescription: .+\n---/m, 'the skill has frontmatter');
  // the loop, in order
  for (const step of ['capabilities', 'diff', 'apply', 'check']) {
    assert.ok(skill.includes(`bin/agent.js ${step}`), `the loop names ${step}`);
  }
  assert.match(skill, /退出码/, 'the exit codes are documented');
  // the red lines an agent-only reader must not miss
  assert.match(skill, /不要直接写 `content\/\*\*`|不直接写 `content\/\*\*`/, 'no direct content writes');
  assert.match(skill, /src\/office\/\*\*/, 'the product runtime is named as read-only');
  assert.match(skill, /密钥/, 'secrets are mentioned');
  assert.match(skill, /npm test/, 'the verification command is named');
  assert.match(skill, /git status --short content\//, 'the "content must be clean" check is named');
  // and it points at the real sources of truth
  for (const doc of ['studio/docs/handover.md', 'studio/docs/contracts.md', 'reference/operations.md']) {
    assert.ok(skill.includes(doc), `the skill points at ${doc}`);
  }
});

test('the generation handoff is a real recipe, generated from the pipeline plan', () => {
  // R5: generation happens in the user's own agent, so the recipe it reads must be the SAME
  // plan the pipeline's model stages would use — compared field by field here, so the doc
  // cannot drift away from the guardrails the workbench enforces after delivery.
  const handoff = read('studio/skills/workbench/reference/generation-handoff.md');
  const { buildPromptPlan } = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'stages.js'));
  const plan = buildPromptPlan({ kind: 's3', action: 'walk-left', direction: 'left', beatSeconds: 10 });
  for (const guardrail of plan.guardrails) assert.ok(handoff.includes(guardrail), `the recipe carries the guardrail: ${guardrail}`);
  for (const negative of plan.negative) assert.ok(handoff.includes(negative), `the recipe carries the negative: ${negative}`);
  for (const beat of plan.beats.slice(0, 3)) assert.ok(handoff.includes(beat.instruction), `the recipe carries the beat sheet (second ${beat.second})`);
  assert.match(handoff, /content\/incoming\//, 'the delivery door is named');
  assert.match(handoff, /node bin\/agent\.js intake/, 'the intake command is named');
  assert.match(handoff, /provenance\/generation/, 'the parameters ledger is named (the breakpoint this closes)');
  // and the skill points at it, names both commands, and says the key path is optional
  const skill = read('studio/skills/workbench/SKILL.md');
  assert.ok(skill.includes('reference/generation-handoff.md'), 'the skill points at the handoff');
  assert.ok(skill.includes('bin/agent.js prompts'), 'the skill names the recipe command');
  assert.ok(skill.includes('bin/agent.js intake'), 'the skill names the intake command');
  assert.match(skill, /不持有/, 'the skill says the workbench holds no generation key');
  // the app's own guidance names the handoff first, and keeps the provider path as the alternative
  const stages = fs.readFileSync(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'stages.js'), 'utf8');
  assert.match(stages, /bin\/agent\.js prompts/, 'the pipeline finding points at the recipe');
  assert.match(stages, /generation-handoff\.md/, 'the pipeline finding points at the handoff doc');
  assert.match(stages, /OPTIONAL in-app path/, 'the provider key path is marked optional');
});

test('intake verifies a delivered clip and records its generation parameters', (t) => {
  // A SYNTHETIC green-screen clip (labelled as such: this is a fixture, not evidence): it must
  // pass the delivery contract, land a ledger record, and be REFUSED when the backdrop is not
  // a green screen — the two halves that make "the agent generates, the workbench receives" real.
  const { execFileSync, spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const delivery = path.join(dir, 'walk-left');
  fs.mkdirSync(delivery, { recursive: true });
  const clip = path.join(delivery, 'take-1.mp4');
  const made = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=640x360:d=3:r=24', '-f', 'lavfi', '-i', 'color=c=0xE8E4DC:s=100x180:d=3:r=24', '-filter_complex', '[0:v][1:v]overlay=x=(W-w)/2+20:y=(H-h)-40:shortest=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
  if (made.status !== 0) { t.skip('ffmpeg unavailable'); return; }

  const contentDir = path.join(dir, 'content');
  fs.cpSync(path.join(ROOT, 'content'), contentDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}build`) });
  const charactersRoot = path.join(dir, 'characters');
  fs.cpSync(path.join(ROOT, 'resources', 'characters'), charactersRoot, { recursive: true });
  // the delivery door is INSIDE the (sandbox) content tree
  const incoming = path.join(contentDir, 'incoming', 'walk-left');
  fs.mkdirSync(path.dirname(incoming), { recursive: true });
  fs.cpSync(delivery, incoming, { recursive: true });

  const env = { ...process.env, STUDIO_CONTENT_DIR: contentDir, STUDIO_CHARACTERS_ROOT: charactersRoot };
  const runIntake = (extra = []) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(STUDIO_ROOT, 'bin', 'agent.js'), 'intake', '--dir', incoming, '--action', 'walk-left', '--model', 'fixture-model', '--seed', '7', ...extra], { cwd: STUDIO_ROOT, encoding: 'utf8', env }) };
    } catch (error) {
      return { code: error.status, out: String(error.stdout || '') + String(error.stderr || '') };
    }
  };
  const accepted = runIntake();
  assert.equal(accepted.code, 0, `a green-screen delivery is accepted: ${accepted.out.slice(0, 200)}`);
  const record = JSON.parse(fs.readFileSync(path.join(contentDir, 'build', 'intake', 'walk-left.json'), 'utf8'));
  assert.equal(record.ok, true, 'the intake record says it passed');
  assert.equal(record.clips.length, 1, 'one clip recorded');
  assert.ok(record.clips[0].probe.durationSec >= 2, 'the probe measured the duration');
  assert.ok(record.clips[0].frames.first.greenRatio > 0.5, `the green backdrop was measured (${record.clips[0].frames.first.greenRatio})`);
  assert.ok(record.clips[0].ledger, 'the generation parameters were recorded (the ledger path is in the record)');
  const ledger = path.join(contentDir, 'characters', 'whale-girl', 'provenance', 'generation', 'walk-left.params.json');
  assert.ok(fs.existsSync(ledger), 'the ledger file exists where the passport looks for it');
  const ledgerDoc = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  const entry = (ledgerDoc.records || []).slice(-1)[0] || {};
  assert.equal(entry.model, 'fixture-model', 'the model name is in the ledger');
  assert.equal(entry.seed, 7, 'the seed is in the ledger');
  assert.equal(entry.tool, 'studio/bin/agent.js intake', 'and it says which tool recorded it');
  assert.ok(entry.promptHash, 'the prompt is hashed, not stored verbatim');
  assert.ok((entry.references || []).some((row) => row.path === 'take-1.mp4' && row.sha256), 'the received clip is referenced by path + hash');

  // A DELIVERY DOOR TAKES NAMES FROM OUTSIDE, and a name becomes a command-line value for
  // ffprobe/ffmpeg. Unsafe names must be refused BEFORE anything is spawned (the option-injection
  // class the security review raised), and a symlink pointing outside must not be accepted either.
  const hostile = path.join(contentDir, 'incoming', 'walk-left');
  fs.writeFileSync(path.join(hostile, '-dash.mp4'), fs.readFileSync(clip));
  const withHostile = runIntake();
  assert.equal(withHostile.code, 1, 'a name starting with a dash is refused');
  assert.match(withHostile.out, /INTAKE_UNSAFE_NAME/, `and the reason is named (output: ${withHostile.out.slice(0, 400)})`);
  fs.rmSync(path.join(hostile, '-dash.mp4'), { force: true });

  const outside = path.join(dir, 'outside.mp4');
  fs.writeFileSync(outside, fs.readFileSync(clip));
  fs.symlinkSync(outside, path.join(hostile, 'linked.mp4'));
  const withLink = runIntake();
  assert.equal(withLink.code, 1, 'a symlink pointing outside the delivery dir is refused');
  assert.match(withLink.out, /INTAKE_FILE_ESCAPES_DIR/, 'and that reason is named too');
  fs.rmSync(path.join(hostile, 'linked.mp4'), { force: true });

  // a delivery without a green backdrop must be REFUSED (and still be recorded as refused)
  const bad = path.join(contentDir, 'incoming', 'walk-left');
  const badClip = path.join(bad, 'take-2.mp4');
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x3050A0:s=640x360:d=3:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', badClip], { encoding: 'utf8' });
  const refused = runIntake();
  assert.equal(refused.code, 1, 'a non-green delivery is refused with exit 1');
  assert.match(refused.out, /INTAKE_NOT_GREEN_SCREEN/, 'and says why');
});

test('the discovery pointers exist where external agents look for them', () => {
  const claudeSkill = read('.claude/skills/workbench/SKILL.md');
  assert.match(claudeSkill, /studio\/skills\/workbench\/SKILL\.md/, 'the .claude pointer names the canonical skill');
  const agents = read('studio/AGENTS.md');
  assert.match(agents, /studio\/skills\/workbench\/SKILL\.md/, 'AGENTS.md names the canonical skill');
  assert.match(agents, /bin\/agent\.js/, 'AGENTS.md names the entry point');
  assert.match(agents, /只读/, 'AGENTS.md states the read-only areas');
});
