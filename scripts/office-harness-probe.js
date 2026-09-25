'use strict';

// scripts/office-harness-probe.js — Task 1 / SPEC-01 Harness compatibility probe.
//
// Usage:
//   node scripts/office-harness-probe.js --redact                 (fixture replay, default)
//   node scripts/office-harness-probe.js --redact --runtime --base-url http://127.0.0.1:PORT
//
// Output contract (SPEC-01): exactly one JSON object on stdout, stable exit
// codes (0 passed / 4 mismatch / 3 failed), no raw payloads, no prompt text,
// no Session IDs, no paths, no token counts, no secrets. Fixture replay is the
// default and reports the research baseline; it never claims runtime proof.
// Runtime mode is read-only (session.list + session.history of the first
// session); it never prompts, never cancels, and reports honestly when the
// runtime is unreachable (PROBE_RUNTIME_UNAVAILABLE).

const { randomUUID } = require('node:crypto');

const RESEARCH_BASELINE = Object.freeze({
  repo: 'deepseek-ai/deepseek-harness',
  commit: 'cd5ef8148158c3a752a658978873241fdf8e2bbc',
  version: '0.1.2-alpha.1',
  report: 'docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md',
});

const EXIT_CODES = Object.freeze({ passed: 0, mismatch: 4, failed: 3 });
const PROBE_ERROR_CODES = Object.freeze({
  RUNTIME_UNAVAILABLE: 'PROBE_RUNTIME_UNAVAILABLE',
  EVENT_SHAPE_MISMATCH: 'PROBE_EVENT_SHAPE_MISMATCH',
  CONTROL_UNSUPPORTED: 'PROBE_CONTROL_UNSUPPORTED',
});

// Synthetic, self-labeled fixture events. They carry deliberately sensitive
// looking values (FIXTURE-*) so tests can prove the probe output never leaks
// payloads, session ids, paths, tool arguments or token counts.
const FIXTURE_EVENTS = Object.freeze([
  { type: 'agent/status', seq: 1, time: 0, data: { status: 'idle' } },
  { type: 'agent/status', seq: 2, time: 1, data: { status: 'running' } },
  {
    type: 'user/message',
    seq: 3,
    time: 2,
    data: { sessionId: 'sess-FIXTURE-001', parts: [{ type: 'text', text: 'FIXTURE-PROMPT' }] },
  },
  {
    type: 'tool/call',
    seq: 4,
    time: 3,
    data: { tool: 'bash', args: { command: 'FIXTURE-TOOL-ARG' }, cwd: '/Users/FIXTURE/path' },
  },
  { type: 'tool/result', seq: 5, time: 4, data: { output: 'FIXTURE-TOOL-OUTPUT', tokens: 987654 } },
  { type: 'turn/end', seq: 6, time: 5, data: { reason: 'completed' } },
  {
    type: 'subagent/start',
    seq: 7,
    time: 6,
    data: { runId: 'run-FIXTURE-1', provider: 'deepseek', id: 'sess-FIXTURE-002', local: false },
  },
  {
    type: 'subagent/end',
    seq: 8,
    time: 7,
    data: {
      runId: 'run-FIXTURE-1',
      stopReason: 'completed',
      lastAssistantMessage: { text: 'FIXTURE-SUBAGENT-TEXT' },
    },
  },
  { type: 'turn/end', seq: 9, time: 8, data: { reason: 'aborted' } },
  { type: 'agent/status', seq: 10, time: 9, data: { status: 'idle' } },
]);

function normalizeHarnessEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.type !== 'string' || !raw.type) return null;
  if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) return null;
  if (typeof raw.time !== 'number' || !Number.isFinite(raw.time)) return null;
  if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) return null;
  return {
    type: raw.type,
    seq: raw.seq,
    time: raw.time,
    dataKeys: Object.keys(raw.data).sort(),
  };
}

function classifySequence(events) {
  const seqs = events.map((e) => e.seq).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!seqs.length) return { observed: false, monotonic: false, gaps: [] };
  const monotonic = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
  const min = Math.min(...seqs);
  const max = Math.max(...seqs);
  const present = new Set(seqs);
  const gaps = [];
  for (let s = min; s <= max; s += 1) {
    if (!present.has(s)) gaps.push(s);
  }
  return { observed: true, monotonic, gaps };
}

// TurnEndReason values proven by the research baseline. Anything else is
// recorded as unknown:<value> so the report never pretends to know it.
const KNOWN_TURN_END_REASONS = Object.freeze([
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
]);

function collectTerminalReasons(events) {
  const reasons = [];
  for (const event of events) {
    if (event.type !== 'turn/end') continue;
    const reason = event.data && event.data.reason;
    if (typeof reason === 'string' && reason) {
      reasons.push(KNOWN_TURN_END_REASONS.includes(reason) ? reason : `unknown:${reason}`);
    } else if (reason === undefined || reason === null) {
      reasons.push('unknown:missing');
    } else {
      reasons.push(`unknown:${String(reason)}`);
    }
  }
  return reasons;
}

function collectAgentStatuses(events) {
  const statuses = [];
  for (const event of events) {
    if (event.type !== 'agent/status') continue;
    const status = event.data && event.data.status;
    if (typeof status === 'string' && status) statuses.push(status);
  }
  return [...new Set(statuses)];
}

function pairSubagents(events) {
  const openStarts = new Set();
  let paired = 0;
  let unmatchedEnds = 0;
  const stopReasons = [];
  for (const event of events) {
    if (event.type === 'subagent/start') {
      const runId = event.data && event.data.runId;
      if (typeof runId === 'string' && runId) openStarts.add(runId);
    } else if (event.type === 'subagent/end') {
      const runId = event.data && event.data.runId;
      if (openStarts.has(runId)) {
        openStarts.delete(runId);
        paired += 1;
      } else {
        unmatchedEnds += 1;
      }
      const stopReason = event.data && event.data.stopReason;
      stopReasons.push(
        typeof stopReason === 'string' && stopReason ? stopReason : 'unknown:missing'
      );
    }
  }
  return {
    paired,
    unmatchedStarts: openStarts.size,
    unmatchedEnds,
    stopReasons: [...new Set(stopReasons)],
  };
}

function assessControls() {
  const proven = (api, note) => ({
    available: true,
    evidence: `research-baseline:${RESEARCH_BASELINE.commit} ${api}${note ? ` — ${note}` : ''} (source-level proof; runtime behavior to be exercised by SPEC-05)`,
  });
  const unsupported = (detail) => ({
    available: false,
    evidence: `${PROBE_ERROR_CODES.CONTROL_UNSUPPORTED}: ${detail}`,
  });
  return {
    cancel: proven('Agent.cancel(cause, { keepInbox })', 'terminal evidence = turn/end aborted or subagent/end stopReason; cancel() return is NOT termination'),
    interrupt: proven('subagent.interrupt()', 'implemented as cancel(..., { keepInbox: true }); waits for subagent/end'),
    followup: proven('Agent.followup()', 'queues next input; does not change prior runtime facts'),
    steer: proven('Agent.steer()', 'guides at the next step boundary'),
    inject: proven('Agent.inject()', 'next-step context injection only'),
    pause: unsupported('no native pause RPC/event found in the research baseline; first version must not expose or fake a paused runtime state'),
    resume: unsupported('no native resume paired with pause; followup/steer must not impersonate resume'),
    preempt: unsupported('not a Harness operation; Office queue policy only (cancel current + wait for terminal evidence + redispatch)'),
  };
}

function buildReport({ events, source, runtimeVersion, electronVersion, wireDifferences }) {
  const extraWireDifferences = Array.isArray(wireDifferences) ? wireDifferences : [];
  const normalized = events.map(normalizeHarnessEvent);
  const shapeFailures = normalized.filter((n) => n === null).length;
  const valid = normalized.filter(Boolean);
  // Collectors read coarse enum values from raw (shape-valid) events; the
  // emitted report only carries the normalized shape, so no payload leaks.
  const rawValid = events.filter((e) => normalizeHarnessEvent(e) !== null);
  const sequence = classifySequence(valid);
  const terminalReasons = collectTerminalReasons(rawValid);
  const agentStatuses = collectAgentStatuses(rawValid);
  const subagents = pairSubagents(rawValid);

  const mismatches = [...extraWireDifferences];
  if (shapeFailures > 0) {
    mismatches.push(`${PROBE_ERROR_CODES.EVENT_SHAPE_MISMATCH}: ${shapeFailures} event(s) missing type/seq/time/data`);
  }
  if (sequence.observed && !sequence.monotonic) mismatches.push('sequence is not monotonic in stream order');
  if (sequence.gaps.length) mismatches.push(`sequence gaps: ${JSON.stringify(sequence.gaps)}`);
  if (terminalReasons.some((r) => r.startsWith('unknown:'))) mismatches.push('turn/end missing or unknown reason value');
  if (sequence.observed && agentStatuses.length === 0) mismatches.push('no agent/status events observed');
  if (sequence.observed && subagents.stopReasons.length === 0) mismatches.push('no subagent/end stopReason observed');

  let probeStatus;
  if (shapeFailures > 0 || !sequence.observed) probeStatus = 'failed';
  else if (mismatches.length) probeStatus = 'mismatch';
  else probeStatus = 'passed';

  return {
    schemaVersion: 1,
    runtimeVersion: runtimeVersion === undefined ? null : runtimeVersion,
    electronVersion: electronVersion === undefined ? null : electronVersion,
    source,
    events: valid,
    agentStatuses,
    sequence,
    terminalReasons,
    subagentStopReasons: subagents.stopReasons,
    subagentPairing: { paired: subagents.paired, unmatchedStarts: subagents.unmatchedStarts, unmatchedEnds: subagents.unmatchedEnds },
    controls: assessControls(),
    sessionStreams: {
      follow: true,
      page: true,
      control: true,
      evidence: `research-baseline:${RESEARCH_BASELINE.commit} session.control/follow/page (source-level proof; fixture replay is not runtime verification — not-runtime-verified)`,
    },
    redaction: { prompts: 0, secrets: 0 },
    mismatches,
    probeStatus,
  };
}

function runFixtureReplay() {
  return buildReport({ events: FIXTURE_EVENTS, source: 'fixture' });
}

// Read-only runtime probe: session.list, then session.history of the first
// session. Never prompts, never cancels, never writes. Fails honestly.
async function probeRuntime({ baseUrl, fetchImpl, timeoutMs = 8000 } = {}) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  const readResult = async (method, payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body;
    try {
      const response = await doFetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
        signal: controller.signal,
      });
      body = await response.json();
    } finally {
      clearTimeout(timer);
    }
    const result = body && body.result ? body.result : {};
    if (!result.ok) {
      throw new Error(`${method} rejected${result.error && result.error.code ? ` (${result.error.code})` : ''}`);
    }
    return result.value;
  };
  try {
    const listed = await readResult('session.list', {});
    const items = (listed && listed.items) || [];
    const first = items.find((s) => s && (s.id || s.sessionId || s.agentId));
    const sessionId = first ? first.id || first.sessionId || first.agentId : '';
    let events = [];
    const wireDifferences = [];
    if (sessionId) {
      const history = await readResult('session.history', { sessionId });
      events = (history && history.events) || [];
      // Runtime wire difference (observed on 0.1.1-rc.2): history events may be
      // wrapped as { event: { type, seq, time, data } } instead of the bare
      // SessionEvent shape documented by the research baseline. Unwrap for
      // analysis and record the difference — never silently hide it.
      const wrappedCount = events.filter(
        (e) => e && typeof e === 'object' && e.event && typeof e.event === 'object' && !Array.isArray(e.event)
      ).length;
      if (wrappedCount > 0) {
        wireDifferences.push(
          `${PROBE_ERROR_CODES.EVENT_SHAPE_MISMATCH}: ${wrappedCount}/${events.length} session.history event(s) wrapped as {event:{type,seq,time,data}} — runtime wire difference vs research baseline (cd5ef814); unwrapped for analysis only`
        );
        events = events.map((e) =>
          e && typeof e === 'object' && e.event && typeof e.event === 'object' && !Array.isArray(e.event)
            ? e.event
            : e
        );
      }
    }
    return buildReport({ events, source: 'runtime', wireDifferences });
  } catch (error) {
    return {
      schemaVersion: 1,
      runtimeVersion: null,
      electronVersion: null,
      source: 'runtime',
      events: [],
      agentStatuses: [],
      sequence: { observed: false, monotonic: false, gaps: [] },
      terminalReasons: [],
      subagentStopReasons: [],
      subagentPairing: { paired: 0, unmatchedStarts: 0, unmatchedEnds: 0 },
      controls: assessControls(),
      sessionStreams: {
        follow: false,
        page: false,
        control: false,
        evidence: 'runtime unreachable; stream capabilities unverified (not-runtime-verified)',
      },
      redaction: { prompts: 0, secrets: 0 },
      mismatches: [`${PROBE_ERROR_CODES.RUNTIME_UNAVAILABLE}: ${String(error && error.message).slice(0, 200)}`],
      probeStatus: 'failed',
    };
  }
}

function statusExitCode(status) {
  return Object.prototype.hasOwnProperty.call(EXIT_CODES, status) ? EXIT_CODES[status] : EXIT_CODES.failed;
}

function parseArgs(argv) {
  const args = { redact: false, runtime: false, baseUrl: undefined, timeoutMs: undefined };
  const list = argv || [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--redact') args.redact = true;
    else if (arg === '--runtime') args.runtime = true;
    else if (arg === '--base-url') args.baseUrl = list[i + 1];
    else if (arg.startsWith('--base-url=')) args.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--timeout') args.timeoutMs = Number(list[i + 1]);
    else if (arg.startsWith('--timeout=')) args.timeoutMs = Number(arg.slice('--timeout='.length));
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  let report;
  if (args.runtime) {
    report = await probeRuntime({
      baseUrl: args.baseUrl || process.env.DSH_OFFICE_PROBE_URL || 'http://127.0.0.1:18723',
      timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : 8000,
    });
  } else {
    report = runFixtureReplay();
  }
  report.redactionNote = args.redact
    ? 'redaction explicitly requested; output is structural/coarse only'
    : 'output is structural/coarse only; no payloads are included';
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = statusExitCode(report.probeStatus);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        source: 'runtime',
        probeStatus: 'failed',
        mismatches: [`PROBE_RUNTIME_UNAVAILABLE: ${String(error && error.message).slice(0, 200)}`],
      })
    );
    process.exitCode = EXIT_CODES.failed;
  });
} else {
  module.exports = {
    RESEARCH_BASELINE,
    FIXTURE_EVENTS,
    PROBE_ERROR_CODES,
    normalizeHarnessEvent,
    classifySequence,
    collectTerminalReasons,
    collectAgentStatuses,
    pairSubagents,
    assessControls,
    buildReport,
    runFixtureReplay,
    probeRuntime,
    statusExitCode,
    parseArgs,
  };
}
