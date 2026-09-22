# OpenCode Development Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated, auditable CLI that runs serial OpenCode development tasks in the current `DshCockpit-s1` checkout by default, optionally in a disposable clone, and produces evidence for Codex review without automatic merge or push.

**Architecture:** A small ESM package under `tools/opencode-orchestrator/` owns configuration, workspace locking, OpenCode Server lifecycle, SDK Session/event handling, verification, and result artifacts. Workspace mode is the default for this already-separated development repository; clone mode is an opt-in safety boundary. The root application and Virtual Office Runtime remain untouched.

**Tech Stack:** Node.js ESM, `@opencode-ai/sdk` exactly `1.18.21`, npm lockfile, Git CLI, Node test runner, loopback HTTP/SSE.

**Source spec:** `docs/superpowers/specs/2026-08-30-opencode-development-orchestrator-design.md`

---

## File map

- Create: `tools/opencode-orchestrator/package.json` with exact SDK dependency, Node engine, ESM type, and test script.
- Create: `tools/opencode-orchestrator/package-lock.json` with reproducible npm resolution.
- Create: `tools/opencode-orchestrator/lib/config.js` for task parsing, defaults, bounds, and secret policy.
- Create: `tools/opencode-orchestrator/lib/worktree-manager.js` for workspace lock, snapshots, optional clone, path policy, and cleanup ownership.
- Create: `tools/opencode-orchestrator/lib/server-manager.js` for executable discovery, Server startup, health/auth, and process-tree shutdown.
- Create: `tools/opencode-orchestrator/lib/session-runner.js` for SDK Session creation, prompt submission, status, messages, and abort/delete cleanup.
- Create: `tools/opencode-orchestrator/lib/event-stream.js` for filtered SSE event normalization and JSONL persistence.
- Create: `tools/opencode-orchestrator/lib/verification.js` for versioned verification presets and bounded subprocess output.
- Create: `tools/opencode-orchestrator/lib/artifacts.js` for redaction, baseline capture, complete patch generation, result schema, and error aggregation.
- Create: `tools/opencode-orchestrator/bin/opencode-task.js` as the only public CLI entry point.
- Create: `tools/opencode-orchestrator/README.md` with setup, task JSON, environment variables, modes, and review workflow.
- Create: `test/opencode-orchestrator/*.test.js` for unit and fake-process integration coverage.
- Modify: `package.json` only to add an explicit test command for `test/opencode-orchestrator/*.test.js` if root discovery does not already include it.
- Modify: `.gitignore` only if needed to ignore local run output without ignoring committed fixtures or lock metadata.

## Task 1: Package scaffold and configuration contract

**Files:** `tools/opencode-orchestrator/package.json`, `tools/opencode-orchestrator/lib/config.js`, `test/opencode-orchestrator/config.test.js`

- [ ] Write failing tests for task JSON parsing, filesystem-safe `taskId`, workspace/clone mode, required `allowedPaths` for write tasks, finite timeout bounds, model/Agent defaults, and environment-variable precedence.
- [ ] Run `node --test test/opencode-orchestrator/config.test.js`; expect failures because the module does not exist.
- [ ] Implement ESM config parsing without reading arbitrary files or inheriting secrets. Accept `OPENCODE_BIN`, `OPENCODE_MODEL`, `OPENCODE_AGENT`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_RUNS_DIR`, and `OPENCODE_MODE`.
- [ ] Add exact dependency `@opencode-ai/sdk: 1.18.21`, Node engine declaration, and nested npm test script. Install dependencies in the nested package and commit the lockfile.
- [ ] Run the focused test and then `node --test test/opencode-orchestrator/config.test.js`; expect PASS.
- [ ] Commit: `feat: add OpenCode orchestrator configuration contract`.

## Task 2: Workspace safety, clone mode, and path boundaries

**Files:** `tools/opencode-orchestrator/lib/worktree-manager.js`, `test/opencode-orchestrator/worktree-manager.test.js`

- [ ] Write failing tests for clean workspace acquisition, `busy` on concurrent invocation, main branch/HEAD/ref/config/hook snapshot, refusal of the sibling `../DshCockpit` public checkout, immutable baseline capture, normalized `allowedPaths`, new files, renames, symlinks, case variants, and boundary violations.
- [ ] Add fake Git fixtures covering tracked, untracked, ignored, binary, mode, symlink, deletion, and worker-commit changes.
- [ ] Implement workspace mode with an exclusive lock and clean-tree requirement. Never reset, clean, merge, push, or overwrite existing run data.
- [ ] Implement optional clone mode using canonical source validation, immutable baseline SHA, `git clone --no-local`, detached checkout, and owner manifest. Reject symlink escapes and foreign cleanup targets.
- [ ] Implement explicit cleanup ownership checks, orphan marking, and force-cleanup handling without following symlinks.
- [ ] Run the focused tests; expect PASS and prove the main checkout remains unchanged.
- [ ] Commit: `feat: enforce OpenCode workspace and path isolation`.

## Task 3: OpenCode Server lifecycle and authentication

**Files:** `tools/opencode-orchestrator/lib/server-manager.js`, `test/opencode-orchestrator/server-manager.test.js`, `test/opencode-orchestrator/fixtures/fake-opencode.js`

- [ ] Write failing tests for executable discovery, exact `serve --hostname=127.0.0.1 --port=0` arguments, task-checkout cwd, environment allowlist, ephemeral password, Basic Auth construction, startup URL parsing, authenticated `/global/health`, version mismatch, startup timeout, and process-tree shutdown.
- [ ] Implement a fake executable that starts a local test HTTP server, records received cwd/args/env, emits a parseable listening URL, and supports controlled exit/signals.
- [ ] Implement Server startup for OpenCode `1.18.21`, loopback binding, `OPENCODE_SERVER_USERNAME` (default `opencode`), and ephemeral `OPENCODE_SERVER_PASSWORD`.
- [ ] Create the SDK client with `baseUrl`, canonical `directory`, and `Authorization: Basic base64(username:password)`; never log the header or password.
- [ ] Implement bounded health polling and process-group termination on completion, abort, timeout, SIGINT, and SIGTERM.
- [ ] Run focused tests; expect PASS without network access or a real model.
- [ ] Commit: `feat: manage authenticated OpenCode Server lifecycle`.

## Task 4: Session, event stream, and terminal state machine

**Files:** `tools/opencode-orchestrator/lib/session-runner.js`, `tools/opencode-orchestrator/lib/event-stream.js`, `test/opencode-orchestrator/session-runner.test.js`, `test/opencode-orchestrator/event-stream.test.js`

- [ ] Write failing tests for Session creation, `directory` propagation, optional `providerID/modelID`, Agent selection, asynchronous prompt submission, final message retrieval, status polling, `session.abort`, Session deletion, filtered `/global/event` records, disconnects, `session.error`, and late events.
- [ ] Implement SDK calls against the pinned API: `session.create`, `session.promptAsync`, `session.status`, `session.messages`, `session.abort`, `session.delete`, and event subscription.
- [ ] Normalize events to bounded JSONL records with timestamp, type, Session ID, and redacted summary. Ignore unrelated Session events.
- [ ] Implement one terminal-state controller with precedence: setup failure, explicit abort, timeout, boundary violation, Session/event failure, verification unavailable/timeout/failure, result-write failure, success. Preserve secondary cleanup errors separately.
- [ ] Add SIGINT/SIGTERM handlers with bounded abort grace period and late-event suppression after terminal state.
- [ ] Run focused tests; expect PASS.
- [ ] Commit: `feat: run OpenCode sessions with event tracking`.

## Task 5: Verification presets and artifact generation

**Files:** `tools/opencode-orchestrator/lib/verification.js`, `tools/opencode-orchestrator/lib/artifacts.js`, `test/opencode-orchestrator/artifacts.test.js`, `test/opencode-orchestrator/verification.test.js`

- [ ] Write failing tests for versioned `node` preset execution, checkout cwd, scrubbed environment, no shell interpolation, timeout, signal exit, unavailable command, output limits, redaction, and status mapping.
- [ ] Implement the initial preset as a committed command definition running `node --test` from the selected checkout with bounded stdout/stderr and finite timeout. Report `passed`, `failed`, `timed_out`, and `unavailable` distinctly.
- [ ] Implement immutable baseline manifest capture and complete patch generation: temporary index from baseline, stage final tracked/untracked paths, exclude ignored files unless allowed, and run `git diff --cached --binary --full-index`. Record commits separately.
- [ ] Implement changed-file boundary enforcement for tracked/untracked/renamed/symlink/mode changes and return `boundary_violation` before success.
- [ ] Implement redaction for configured values, Bearer/Basic credentials, common API-key shapes, password fields, prompts, event summaries, crash output, and verification output. Apply byte caps before writing.
- [ ] Write `task.json`, `baseline.json`, `commits.json`, `events.jsonl`, `verification.json`, `diff.patch`, and `result.json` atomically enough to preserve partial artifacts.
- [ ] Run focused tests; inspect actual patch content for all file kinds.
- [ ] Commit: `feat: generate auditable OpenCode run artifacts`.

## Task 6: CLI orchestration and documentation

**Files:** `tools/opencode-orchestrator/bin/opencode-task.js`, `tools/opencode-orchestrator/README.md`, root `package.json` if required, `.gitignore` if required, `test/opencode-orchestrator/cli.test.js`

- [ ] Write failing CLI tests for task-file loading, serial lock behavior, workspace default, opt-in clone mode, structured stdout result, nonzero exit mapping, retained failure worktree, and cleanup command ownership.
- [ ] Implement the CLI as the only public entry point. It must compose config, workspace manager, Server manager, Session runner, event stream, verification, and artifact writer without importing application or office modules.
- [ ] Prefix every OpenCode prompt with the mandatory handoff instruction: read the repository handoff, SPEC index, selected plan, and referenced SPEC files completely; state the allowed paths and acceptance checks; only then inspect or modify code. Require a final response containing changed files, tests, known risks, and follow-up needs.
- [ ] Support `run <task.json>` and explicit `cleanup <runId>` commands. Never auto-merge, commit to public remotes, push, reset, or delete a failed run.
- [ ] Document the exact setup, `npm install` location, environment variables, task schema, workspace/clone modes, OpenCode version, review handoff, and examples that do not contain secrets.
- [ ] Run the focused CLI tests; expect PASS.
- [ ] Commit: `feat: add OpenCode task orchestration CLI`.

## Task 7: Full verification and handoff

**Files:** all implementation and test files above

- [ ] Run `node --test test/opencode-orchestrator/*.test.js`.
- [ ] Run the nested package test command from `tools/opencode-orchestrator/`.
- [ ] Run the repository's full `npm test` and confirm unrelated tests remain green.
- [ ] Run `git diff --check` and `node --check` on any CommonJS compatibility shims or generated entry scripts as applicable.
- [ ] Execute the opt-in real smoke test only when `OPENCODE_BIN` and credentials are explicitly configured; never include it in default CI.
- [ ] Produce a Codex review handoff containing the final result JSON, patch summary, verification output, and known residual risks. Do not apply or merge until Codex approves.
- [ ] Commit: `test: verify OpenCode orchestrator end to end`.

## OpenCode worker prompt requirements

Every delegated task must include these instructions verbatim in substance:

1. Read `docs/superpowers/specs/2026-08-30-office-agent-handoff.md`, `docs/superpowers/specs/2026-08-30-office-development-spec-index.md`, the selected plan, and every referenced SPEC before editing.
2. Read the current repository status and the exact files named by the task.
3. Do not modify files outside `allowedPaths`; do not touch the public sibling checkout; do not add secrets.
4. Implement the smallest test-backed change, run the task's exact verification commands, and report failures honestly.
5. Do not reset, clean, merge, push, or rewrite unrelated user changes.
6. End with changed files, tests run, results, assumptions, residual risks, and any document updates required.
