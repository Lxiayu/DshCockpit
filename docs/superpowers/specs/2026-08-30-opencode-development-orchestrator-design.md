# OpenCode Development Orchestrator Design

## Status

- Status: approved design, implementation not started
- Date: 2026-08-30
- Scope: local development-task orchestration only
- Owner: DshCockpit development tooling

## 1. Goal

Use OpenCode as the primary implementation worker while keeping the current Codex agent as the supervisor and final reviewer. In this repository, `DshCockpit-s1` is already a dedicated development checkout separated from the public `DshCockpit` repository, so the first version runs serial tasks directly in this checkout by default, collects machine-readable evidence, and never merges, pushes, or resets automatically.

This tool is deliberately separate from Virtual Office Runtime. It does not import office modules and does not provide Agent state to the product UI.

## 2. Decisions

### 2.1 Selected architecture

Use a dedicated OpenCode Server started by a local orchestrator and controlled through the official OpenCode JavaScript SDK. Do not depend on the OpenCode Desktop sidecar as a product integration point.

The Desktop sidecar uses a dynamic local port and internal authentication. It is useful for the Desktop itself, but it is not a stable contract for repository automation.

### 2.2 Repository isolation

By default, exactly one task runs at a time in the current `DshCockpit-s1` checkout. The orchestrator requires a clean starting tree, records the branch, HEAD, refs, config checksum, and hook files, and asserts that protected repository state remains unchanged after the run. It never targets the sibling public `DshCockpit` checkout. An optional `clone` isolation mode may create a disposable clone based on an immutable commit for high-risk or untrusted work, but clone mode is not the default because it duplicates repository storage.

### 2.3 Review gate

OpenCode results are evidence for review, not an approval to merge. The current Codex supervisor reviews the result package, diff, changed-file boundaries, and verification output. The first version does not launch a second Codex process automatically.

## 3. Directory layout

```text
tools/opencode-orchestrator/
  bin/
    opencode-task.js
  lib/
    config.js
    server-manager.js
    session-runner.js
    event-stream.js
    worktree-manager.js
    result-writer.js
  package.json
  README.md

test/opencode-orchestrator/
```

The nested package uses npm, pins `@opencode-ai/sdk` exactly to `1.18.21` with a committed `package-lock.json`, and declares its Node engine and ESM module format. The currently verified OpenCode CLI/server is `1.18.25`; the CLI/SDK compatibility pair must be revalidated before changing either version. The root test script invokes the nested test command explicitly; no provider SDK dependency is added to the application runtime package.

The tool must not be coupled to `src/office/`. It may read repository documentation and SPEC files supplied by a task, but it must not alter office runtime code unless the task explicitly names those files.

## 4. Runtime flow

```text
Validate task
  -> snapshot development checkout
  -> optionally create isolated clone checkout
  -> discover OPENCODE_BIN
  -> start loopback-only OpenCode Server
  -> wait for health response
  -> create Session
  -> submit prompt and subscribe to events
  -> collect final message, status, and diff
  -> run configured verification preset
  -> write result package
  -> abort/delete Session and stop Server
```

The Server is bound to `127.0.0.1`. Its process working directory and every SDK request's `directory` value must equal the canonical task checkout path (the current checkout in workspace mode, the clone in clone mode). A per-run password is held in memory and passed through the child process environment. Authentication headers, credentials, and full environment variables must never be written to logs.

## 5. Components

### `config`

Reads CLI arguments and environment variables, validates paths and numeric limits, and produces an immutable run configuration. Supported settings include:

- `OPENCODE_BIN`: explicit executable path; otherwise discover from `PATH`.
- `OPENCODE_MODEL`: optional provider/model selection.
- `OPENCODE_AGENT`: optional Agent selection.
- `OPENCODE_SERVER_PASSWORD`: optional caller-supplied password; otherwise generate an ephemeral one.
- `OPENCODE_SERVER_USERNAME`: optional Basic Auth username; otherwise use OpenCode's documented default.
- `OPENCODE_RUNS_DIR`: optional location for retained run packages.

No secret is committed to the repository or included in a result object.

### `server-manager`

Starts the pinned OpenCode `1.18.21` binary as `opencode serve --hostname=127.0.0.1 --port=0` with the selected checkout as `cwd`, captures startup output without leaking secrets, parses the selected URL, and waits for an authenticated `/global/health` response containing `healthy: true` and a version. The process receives `OPENCODE_SERVER_USERNAME` (default `opencode`) and an ephemeral `OPENCODE_SERVER_PASSWORD`. The SDK client is created with `baseUrl`, the same canonical `directory`, and Basic Auth constructed as `Authorization: Basic base64(username:password)`. The fake executable verifies args, cwd, allowlisted environment, auth, and startup URL. Missing executables, version mismatch, and authentication failures are setup errors, not task failures.

### `worktree-manager`

In workspace mode, requires a clean starting tree, records the immutable HEAD as baseline, and acquires an exclusive run lock so concurrent invocations fail with `busy`. In clone mode, resolves `baseRef` to an immutable commit from the canonical source repository, creates a unique run directory using an atomic lock/manifest operation, clones with `--no-local`, checks out the baseline detached, and records the path and baseline tree. Repository and runs paths are canonicalized with `realpath`; symlink escapes are rejected. Run directories use `runId = timestamp + random suffix`. Cleanup refuses active or foreign runs, does not follow symlinks, and verifies immutable owner metadata before removal. Stale partial runs are marked orphaned and require an explicit force-cleanup flag.

### `session-runner`

Uses the pinned `@opencode-ai/sdk` version (currently tested locally against `1.18.21`) to create a Session and sends a prompt containing the approved task handoff. When provided, the request includes `providerID/modelID` and `agent`; every request carries the canonical checkout `directory`. The runner can request asynchronous prompt execution, retrieve messages, query status, and call the documented `session.abort` endpoint. Session deletion is cleanup, not a generic `close` operation.

### `event-stream`

Subscribes to the OpenCode `/global/event` stream through the SDK. It filters events by Session ID and writes normalized JSONL records with timestamps, event type, Session ID, and a redacted summary. Disconnects, `session.error`, and unexpected end-of-stream are terminal errors unless a bounded reconnect policy is explicitly enabled. The stream handle is closed during finalization.

### `result-writer`

Writes the fixed result schema and a patch artifact. It records changed files and verification evidence but never records secrets or unrestricted process environments. Redaction and byte limits are applied before persistence.

## 6. Task contract

The CLI accepts a JSON task file or equivalent flags. The first version supports:

```json
{
  "taskId": "office-runtime-001",
  "baseRef": "feature/s1-office",
  "promptFile": "docs/superpowers/specs/example-handoff.md",
  "model": "provider/model",
  "agent": "build",
  "timeoutMs": 1800000,
  "verification": "node"
}
```

Rules:

- `taskId` is required and must be filesystem-safe.
- In workspace mode, `baseRef` defaults to the current HEAD. In clone mode, it must resolve to an existing local ref and is recorded as an immutable commit SHA before cloning.
- `promptFile` must be inside the repository and readable before the run starts.
- `timeoutMs` has a bounded minimum and maximum; the default is finite.
- Model and Agent are optional. OpenCode defaults apply when absent.
- Verification is a named preset, not an arbitrary shell string, in the first version.
- `taskId` is a human label; every execution also receives a unique `runId`. A repeated task ID never overwrites an earlier run.
- `mode` is `workspace` (default) or `clone`; workspace mode is serial and requires a clean starting tree.
- `allowedPaths` is required for write tasks and contains normalized repository-relative files or directory prefixes. New files, renames, symlinks, case variants, and mode changes are checked against this policy; an out-of-bound change is a terminal `boundary_violation`.

## 7. Result contract

```json
{
  "taskId": "office-runtime-001",
  "status": "succeeded",
  "sessionId": "...",
  "worktree": "...",
  "changedFiles": [],
  "verification": {
    "status": "passed",
    "commands": []
  },
  "logFile": "...",
  "error": null
}
```

Allowed terminal statuses:

```text
succeeded
failed
timed_out
aborted
setup_failed
verification_failed
boundary_violation
result_write_failed
```

Each run also contains `task.json`, `events.jsonl`, `diff.patch`, `verification.json`, `baseline.json`, and `commits.json`. The result package is the handoff artifact for Codex review.

Diff collection is based on the recorded baseline tree, not only `git diff`. The implementation creates a temporary index from the baseline, stages the final tracked and untracked paths into that index, and uses `git diff --cached --binary --full-index` to generate `diff.patch`; ignored files are excluded unless explicitly allowed. Binary files are represented with Git binary patches, symlinks and modes are preserved, and deletions are included. Worker commits are allowed in clone mode and are recorded in `commits.json`; in workspace mode commits are recorded but never pushed. The patch is generated from baseline to the final tree regardless of commit count. The orchestrator fails closed if the baseline ref, source snapshot, or recorded baseline tree is tampered with. Tests inspect the actual patch for tracked, untracked, ignored, binary, symlink, mode, deletion, and committed changes.

## 8. Failure and recovery policy

- Server startup, executable discovery, health, and authentication failures produce `setup_failed`.
- OpenCode Session errors produce `failed` and preserve the worktree.
- Timeouts issue Session abort first, then terminate the process group if needed, producing `timed_out`.
- User cancellation produces `aborted`.
- Verification command failures produce `verification_failed`; the diff remains available for review.
- The orchestrator must be idempotent with respect to its run directory and must not overwrite a prior run with the same `taskId`.
- No automatic retry is enabled in the first version. A future retry must create a new run ID and worktree.
- Terminal state precedence is fixed: `aborted` (explicit cancellation) wins over timeout; `timed_out` wins over verification; `verification_failed` wins over success. A final message received after a terminal state is recorded but cannot change it.
- SIGINT and SIGTERM invoke Session abort, wait a bounded grace period, terminate the process tree, and preserve partial artifacts. Setup failures retain any created checkout unless cleanup succeeds; cleanup errors are recorded separately.
- Full precedence is: `setup_failed` before a Session exists; otherwise explicit `aborted`; then `timed_out`; then `boundary_violation`; then `failed` for Session/event errors; then verification `unavailable`/`timed_out`/`failed`; then `result_write_failed`; finally `succeeded`. Cleanup errors are independent metadata and never replace the primary terminal status. Exactly one primary status is written, with secondary errors in an array.

## 9. Codex review protocol

The supervisor reviews each run in this order:

1. Confirm the task file and prompt reference the approved plan/SPEC chain.
2. Confirm the worktree and changed files stay within the task boundary.
3. Inspect `diff.patch` and relevant event/error records.
4. Re-run or independently verify the required project checks.
5. Return one of `approved`, `changes_requested`, or `blocked`.
6. Apply or merge only after an explicit approval decision.

The first version does not invoke a second Codex process. An optional future `CODEX_REVIEW_BIN` integration must remain disabled by default and must preserve the same approval gate.

## 10. Testing strategy

### Unit tests

Test configuration validation, task parsing, path containment, status mapping, timeout transitions, result schema, and log redaction.

### Process integration tests

Use a fake `opencode` executable that asserts its cwd, arguments, environment allowlist, authentication setup, and request payloads, then simulates successful startup, health, SSE events, errors, disconnects, signal cancellation, process-tree cleanup, and clean shutdown. The mandatory matrix covers main-checkout status/ref/config/hook immutability, independent clone metadata, untracked/ignored/binary/symlink/mode/deleted diffs, worker commits, allowed-path violations, duplicate concurrent task IDs, stale cleanup ownership, baseline tampering, abort races, orphan detection, and secret exfiltration paths. These tests must not call a real model or external network.

### Real smoke test

Provide an explicitly opt-in smoke test for a user-managed OpenCode Server. It must be excluded from the default `npm test` run and must never use repository credentials from committed files.

## 11. Non-goals

- No Virtual Office Runtime integration.
- No automatic merge, commit, push, or pull request creation.
- No dependency on OpenCode Desktop's private sidecar port.
- No storage of provider keys, passwords, or complete prompts containing secrets.
- No arbitrary user-provided shell command execution by the orchestrator in the first version.
- No parallel worker tasks in workspace mode.

The default child environment is an allowlist assembled from non-sensitive runtime variables. The worker may use a provider configured in the user's existing OpenCode config, but credentials are not copied into task files, prompts, result objects, or logs. The threat model assumes the Worker can execute tools and access the network; users should only select providers they trust for the task. A future isolated trusted-worker mode may inject narrowly named secrets only after explicit opt-in, with process/network isolation documented as a prerequisite. Redaction covers Bearer credentials, Basic credentials, common API-key shapes, password fields, and configured secret values. All persisted stdout, stderr, event summaries, prompts, crash output, and verification output are size-bounded and redacted before writing. Tests must prove secret-shaped values cannot appear in any artifact.

The child environment is an allowlist assembled from non-sensitive runtime variables. The orchestrator may point OpenCode at the user's existing `OPENCODE_CONFIG` and OpenCode data directory so desktop and terminal provider selections are shared; it does not copy or print credentials. Provider secrets are never placed in task files, prompts, result JSON, or logs. Redaction covers Bearer credentials, Basic credentials, common API-key shapes, password fields, and configured secret values. All persisted stdout, stderr, event summaries, prompts, and verification output are size-bounded and redacted before writing.

Verification presets are versioned. The initial `node` preset runs from the task checkout with a scrubbed environment, finite timeout, and bounded stdout/stderr; it reports `passed`, `failed`, `timed_out`, or `unavailable` distinctly. The preset registry and its commands are tested rather than accepting arbitrary shell strings.

The `node` preset is committed as a versioned command definition: run `node --test` from the task checkout using the allowlisted Node runtime, without shell interpolation, with a finite timeout and capped output. Package-manager and Node-version assumptions are recorded in the preset metadata; signal exit and output-limit cases have separate results.

## 12. References and local evidence

- OpenCode Server API and Basic Auth: https://opencode.ai/docs/zh-cn/server/
- OpenCode JavaScript SDK: https://opencode.ai/docs/zh-cn/sdk/
- Local SDK type definitions expose Session create/prompt/promptAsync/status/abort and event subscription APIs.
- The nested tool package must commit its `package.json` and exact npm `package-lock.json`; the existing root `package-lock.json` remains ignored and is not changed by this tool. The committed root test entry for this tool is `node --test test/opencode-orchestrator/*.test.js` plus the nested package's own test command.
- On 2026-08-30, OpenCode Desktop logs showed a sidecar at a dynamic loopback port; direct health access returned an authentication response. The port and authentication are therefore treated as private Desktop implementation details.
