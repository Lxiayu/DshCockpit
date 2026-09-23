'use strict';

// src/office/runtime/approval-risk.js — approval risk classification.
//
// P1 data pipeline of the office right-panel spec (docs/strategy/
// 2026-09-23-office-right-panel-spec.md §5), cross-checked against
// 2026-09-23-approval-ux-cross-tool.md (Warp denylist / Devin Smart
// "never auto-approved" list / Anthropic incident log — three independent
// sources for every added high-risk category).
//
// Pure deterministic CommonJS: no Electron, DOM, filesystem, network or clock
// access. Input is what the office `pending` entry carries plus the session's
// current harness preset (`read-only` / `workspace-write` / `danger-full-access`
// from @deepseek-ai/dsh-permission-presets — a preset bundles one sandbox mode
// with one approval policy). Output is exactly 'low' | 'medium' | 'high'.
//
// IMPORTANT harness constraint (dsh-user-approval Known Limitations, quoted in
// the cross-tool memo §1): "The request carries no tool arguments — an answerer
// sees the tool name, reason, and optional call id." So with ONLY toolName +
// preset the command-shape criteria (deletion inside a bash command, mutating
// git subcommand, package install, db/cloud CLI, secret paths) cannot fire; the
// tool-NAME level list below covers the tools whose name IS the dangerous
// operation. `command` / `targetPath` + `workspacePath` are OPTIONAL seams for
// P3, which reads the real arguments through spec §4's `detailRef`
// ('office:pending-detail') — when present, the full §5 explicit list applies.

const RISK = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });

const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2 });

// Harness 0.1.5 preset names (dsh-permission-presets README): the shipped table
// includes read-only / workspace-write / danger-full-access.
const PRESETS = Object.freeze({
  READ_ONLY: 'read-only',
  WORKSPACE_WRITE: 'workspace-write',
  DANGER_FULL_ACCESS: 'danger-full-access',
});

const LOW_CLASS = 'low';       // read-only tools + ask_user_question
const WRITE_CLASS = 'write';   // workspace writes
const EXEC_CLASS = 'exec';     // command execution
const UNKNOWN_CLASS = 'unknown';

// ---- tool-name vocabulary -----------------------------------------------------

// Read-only tools (spec §5 low row: read/grep/fs-search/web-search/…). Under
// any preset these modify no state, so they never need more than the inline
// one-click approval.
const READ_ONLY_TOOLS = new Set([
  'read', 'readfile', 'read_file', 'view', 'cat', 'open', 'ls', 'dir',
  'glob', 'grep', 'rg', 'find', 'fs-search', 'fs_search', 'code-search',
  'code_search', 'file-search', 'file_search', 'search', 'web-search',
  'websearch', 'web_search', 'search-web', 'list', 'tree', 'diff-show',
]);

// Ask-user-question style tools (spec §5 low row). A question is not an
// approval at all; it renders as an inline form (spec §3).
const QUESTION_TOOLS = new Set([
  'ask_user_question', 'ask-user', 'askuserquestion', 'ask-user-question',
  'question', 'user-questions/request',
]);

// Workspace writes (spec §5 medium row: write/edit with the target inside the
// workspace — Codex "workspace-write" and Claude Code Tier 2 "in-project file
// operations" are the same tier).
const WRITE_TOOLS = new Set([
  'write', 'edit', 'apply-patch', 'apply_patch', 'patch', 'multi-edit',
  'multi_edit', 'notebook-edit', 'notebook_edit', 'str-replace', 'str_replace',
  'create-file', 'create_file', 'update-file', 'update_file', 'insert',
  'replace', 'save',
]);

// Command execution (spec §5 / cross-tool §3.1 T2 "sandboxed execution").
// Medium by default: the harness sandbox still bounds the blast radius, and the
// user gets the zero-thought inline approval. Escalates to high under
// danger-full-access (the cross-tool memo's T3) or on a command-shape hit.
const EXEC_TOOLS = new Set([
  'bash', 'shell', 'sh', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd', 'exec',
  'execute', 'terminal', 'run', 'process', 'spawn', 'command', 'eval', 'git',
]);

// The §5 high-risk EXPLICIT list, at tool-name granularity: every entry is one
// of "deletion / privilege escalation / dependency install-or-change / mutating
// git / database or cloud CLI / secret & config read-write" whose tool name IS
// the operation (e.g. an MCP or wrapper tool literally named rm/sudo/psql).
const HIGH_RISK_TOOLS = new Set([
  // deletion — Claude Code "rm and rmdir removals targeting a critical path,
  // which no allow rule approves"; Warp default denylist
  'rm', 'rmdir', 'unlink', 'shred', 'delete', 'remove', 'mv-trash',
  // privilege escalation
  'sudo', 'su', 'doas', 'pkexec', 'runas',
  // dependency install / change — Devin Smart "never auto-approved" package
  // installs; Anthropic drops package-manager run rules on auto-mode entry
  'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'poetry', 'conda', 'cargo', 'gem',
  'brew', 'apt', 'apt-get', 'dnf', 'apk', 'composer', 'install', 'add',
  // database / cloud CLIs — Devin Smart kubectl delete / aws / gcloud / az /
  // terraform variants
  'psql', 'mysql', 'mongo', 'mongosh', 'sqlite3', 'kubectl', 'helm', 'aws',
  'gcloud', 'az', 'terraform', 'oci', 'flyctl', 'heroku', 'kubectl-delete',
]);

// Same explicit list as a NAME-SHAPE test, so wrapper/MCP tools named after the
// operation (npm_install, pip-install, read_env, edit_credentials…) classify
// correctly instead of falling through to the medium default. Word-boundary
// anchored so innocent names (environment, prevent, tokenize) do not match.
const HIGH_RISK_TOOL_RE = new RegExp(
  '(^|[-_.])(' + [
    'install', 'uninstall',          // dependency install/change
    'delete', 'remove', 'unlink', 'rm', 'rmdir', 'shred', // deletion
    'sudo', 'su', 'doas',            // privilege escalation
    'psql', 'mysql', 'mongo', 'sqlite', 'kubectl', 'helm', // db / cloud CLI
    'aws', 'gcloud', 'terraform',
    'env', 'credential', 'credentials', 'secret', 'secrets', 'token', // secrets
    'ssh', 'netrc', 'gitconfig', 'npmrc',                     // key material
    'settings', 'config',                                    // config files
  ].join('|') + ')([-_.]|$)', 'i');

// Command-shape evidence (optional seam; harness requests carry no arguments).
// Every regex maps to one line of the §5 explicit high list. Matches are
// deliberately over-inclusive: a false high costs one modal, a false low lets
// an irreversible action through with a single click.
const HIGH_COMMAND_RES = [
  // deletion — Claude Code "rm and rmdir removals targeting a critical path,
  // which no allow rule or PreToolUse hook approves"; Warp default denylist
  /\brm\s+-/,            // rm with flags (rm -rf …)
  /\brmdir\b/,           // rmdir
  /(^|[;&|]\s*)rm\s+[^-;&|]/, // bare `rm <target>` at a command boundary
  // privilege escalation
  /\bsudo\b/, /\bdoas\b/, /(^|[;&|]\s*)su\s+[^-;&|]/,
  // dependency install / change — Devin Smart "never auto-approved" package
  // installs; Anthropic drops package-manager run rules on auto-mode entry
  /\b(npm|pnpm|yarn|pip3?|poetry|conda|cargo|gem|brew|apt|apt-get|dnf|apk|composer)\s+(install|add|i|rm|remove|uninstall|update|upgrade|link)\b/,
  // mutating git (push --force / reset --hard / clean / branch or tag delete /
  // discard / history rewrite) — read-only subcommands (status/log/diff) stay
  // eligible (Devin Smart "mutating git operations")
  /\bgit\s+push\s+[^;|&]*(-f\b|--force\b)/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\b/,
  /\bgit\s+(branch|tag)\s+-[dD]\b/, /\bgit\s+checkout\s+--\b/, /\bgit\s+filter-branch\b/,
  /\bgit\s+update-ref\s+-d\b/,
  // database / cloud CLIs — Devin Smart kubectl delete / aws / gcloud / az /
  // terraform ('az' stays tool-name-only: too ambiguous inside command text)
  /\b(psql|mysql|mongo(sh)?|sqlite3|kubectl|helm|aws|gcloud|terraform|oci|flyctl|heroku)\b/,
  // key material & config read/write (.env / credentials / settings-like)
  /(^|[^\w])(\.env\b|\.env\.)/, /(^|[^\w])\.ssh\//, /\bid_rsa\b/, /\bcredential/i,
  /(^|[^\w])(\.gitconfig|\.npmrc|\.netrc|settings\.json|settings\.local\.json)\b/,
];

/** Tool risk class for classification (read-only / question / write / exec /
 * unknown). Exported for diagnostics and the table-driven tests. */
function toolRiskClass(toolName) {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (!name) return UNKNOWN_CLASS;
  if (HIGH_RISK_TOOLS.has(name) || HIGH_RISK_TOOL_RE.test(name)) return 'high';
  if (READ_ONLY_TOOLS.has(name)) return LOW_CLASS;
  if (QUESTION_TOOLS.has(name)) return LOW_CLASS;
  if (WRITE_TOOLS.has(name)) return WRITE_CLASS;
  if (EXEC_TOOLS.has(name)) return EXEC_CLASS;
  return UNKNOWN_CLASS;
}

/** Cheap lexical "outside the workspace" test (prefix containment). No
 * filesystem access — a lexical prefix test is all P1 can honestly do; it
 * exists for the optional targetPath/workspacePath seam (P3 detailRef). */
function isOutsideWorkspace(targetPath, workspacePath) {
  const target = String(targetPath || '').replace(/[\\/]+$/, '');
  const workspace = String(workspacePath || '').replace(/[\\/]+$/, '');
  if (!target || !workspace) return false;
  const windows = target.includes('\\') || workspace.includes('\\');
  const norm = (p) => (windows ? p.replace(/\//g, '\\') : p).toLowerCase();
  const t = norm(target);
  const w = norm(workspace);
  const sep = windows ? '\\' : '/';
  return t !== w && !t.startsWith(w + sep);
}

/**
 * Classify one pending approval/question into low | medium | high.
 *
 * @param {{toolName?: string, preset?: string, command?: string,
 *          targetPath?: string, workspacePath?: string}} [input]
 * @returns {'low'|'medium'|'high'}
 */
function classifyRisk(input = {}) {
  const toolName = typeof input.toolName === 'string' ? input.toolName.trim() : '';
  const preset = typeof input.preset === 'string' ? input.preset.trim() : '';
  const command = typeof input.command === 'string' ? input.command : '';
  const cls = toolRiskClass(toolName);

  // (1) §5 high row — command-shape evidence (optional P3 seam) and an
  // out-of-workspace write target.
  if (command && HIGH_COMMAND_RES.some((re) => re.test(command))) return RISK.HIGH;
  if (typeof input.targetPath === 'string' && input.targetPath
    && typeof input.workspacePath === 'string' && input.workspacePath
    && isOutsideWorkspace(input.targetPath, input.workspacePath)) {
    return RISK.HIGH;
  }

  // (2) §5 high row — tool-name level explicit list.
  if (cls === 'high') return RISK.HIGH;

  // (3) §5 high row — any execution or write under danger-full-access
  // ("--yolo, no sandbox; no approvals": the sandbox can no longer bound the
  // blast radius, so only genuinely state-free tools stay low).
  if (preset === PRESETS.DANGER_FULL_ACCESS && cls !== LOW_CLASS) return RISK.HIGH;

  // (4) §5 high row — sandbox WIDENING request ("After a denied call, the
  // model can request one strictly wider mode for human approval", dsh-sandbox
  // README). A write tool arriving under a read-only preset cannot run inside
  // the read-only sandbox: granting it means widening the sandbox, so the
  // request is high by definition. (Execution under read-only is legitimate —
  // "a command can run without writes" — and stays medium.)
  if (preset === PRESETS.READ_ONLY && cls === WRITE_CLASS) return RISK.HIGH;

  // (5) §5 low row — read-only tools and ask_user_question.
  if (cls === LOW_CLASS) return RISK.LOW;

  // (6) §5 medium row — workspace writes and sandboxed execution. Unknown tool
  // names land here too: fail-closed to the zero-thought inline approval
  // rather than silently green-lighting a tool the table does not know.
  return RISK.MEDIUM;
}

module.exports = {
  classifyRisk,
  toolRiskClass,
  isOutsideWorkspace,
  RISK,
  RISK_ORDER,
  PRESETS,
  READ_ONLY_TOOLS,
  QUESTION_TOOLS,
  WRITE_TOOLS,
  EXEC_TOOLS,
  HIGH_RISK_TOOLS,
  HIGH_COMMAND_RES,
};
