'use strict';
// scripts/acceptance/brief-cross-session-acceptance.js — P1 最后一项：Brief 真被下次会话读到。
//
// 第一性原理：要证明的是"跨会话记忆真的生效"，不是"文件写对了"
//
//   前三层证据（写入正确 / 官方读 AGENTS.md / 读取时机）都是**代码级**的。
//   它们证明"机制存在"，但不证明"机制在这个应用里跑通了"。
//
//   唯一的直接证据是：写一个随机暗号进 AGENTS.md，然后开一次真实 Agent 会话，
//   问它暗号是什么。暗号答对 ⇒ 它真的读了那个文件。
//   暗号是随机的，不可能从别处推断出来——这排除了"猜对"。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const POC = process.env.DSH_POC_ROOT
  || '/var/folders/bk/b3ld_mbj0g57yy7my8wg69fc0000gn/T/dsh-poc/0.2.1-rc.5';
const BIN = path.join(POC, 'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js');
const HOME = path.join(POC, 'dsh-home');
const EVIDENCE = path.join(os.tmpdir(), 'brief-cross-session-acceptance');

const results = [];
let failed = 0;
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function finish() {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'results.json'),
      JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
    console.log(`EVIDENCE: ${EVIDENCE}`);
  } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);
  process.exit(failed === 0 ? 0 : 1);
}

/** 从 ~/.dsh/.credentials.yaml 的 refs 段取 key（与 runtime 同规则）。 */
function readRef(ref) {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (!/^\s+/.test(l)) break;
    const m = l.match(new RegExp(`^\\s+${ref}:\\s*(.+)$`));
    if (m) return m[1].trim();
  }
  return null;
}

/** unary RPC over HTTP（0.2.1 的 unary 不走 WS 流）。 */
async function rpc(base, cookie, method, args) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload: { args },
    }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep null */ }
  const value = parsed && parsed.result;
  if (res.status === 200 && value && value.ok === true) return { ok: true, value: value.value };
  return { ok: false, reason: (value && value.error && value.error.message) || `HTTP ${res.status}`, raw: text.slice(0, 300) };
}

async function main() {
  // ---- 1. 写 Brief（走真实实现）----
  const { syncToWorkspace, BEGIN_MARK, END_MARK } = require(path.join(REPO, 'src', 'mission', 'brief-sync.js'));
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-e2e-'));
  // 官方用 .git 判定项目根；没有它 AGENTS.md 可能不被加载（这是我们发现的真实风险）
  fs.mkdirSync(path.join(WS, '.git'));
  fs.writeFileSync(path.join(WS, 'AGENTS.md'), '# 工作区\n\n<!-- 用户内容不许丢 -->\n');

  const TOKEN = `ZEBRA-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const sync = syncToWorkspace({
    workspaceDir: WS,
    briefText: `当前项目暗号是 ${TOKEN}。如果被问到暗号，只回答这个 token 本身。`,
  });
  const agentsText = fs.readFileSync(path.join(WS, 'AGENTS.md'), 'utf8');
  console.log('TOKEN:', TOKEN);
  record('the brief is written into <workspace>/AGENTS.md',
    sync.ok === true && agentsText.includes(BEGIN_MARK) && agentsText.includes(END_MARK),
    `sync=${sync.ok} action=${sync.action || '-'}`);
  record('the user\'s own content survives the brief write',
    agentsText.includes('用户内容不许丢'), 'ok');

  // ---- 1.5 确保隔离 HOME 里有可用的模型 provider ----
  //
  // 这一步是第一版失败的原因：POC 的 dsh-home 有 .credentials.yaml（key 在），
  // 但没有 settings.yaml（provider route 声明不在）。于是 session/prompt 被
  // 接受、会话被创建，但**没有模型可调用** —— 事件流里只有 seq=0 的初始事件。
  //
  // 这是一个很有代表性的失败：每一步都"成功"，但整条链路没通。
  // 所以探针必须自己保证前置条件，而不是假设环境已配好。
  const stepKey = readRef('STEP_API_KEY');
  if (stepKey) {
    const settingsPath = path.join(HOME, 'settings.yaml');
    let st = '';
    try { st = fs.readFileSync(settingsPath, 'utf8'); } catch { /* first run */ }
    if (!st.includes('stepfun')) {
      st += [
        'llm-pi-ai:',
        '  providers:',
        '    stepfun:',
        '      displayName: "StepFun Step Plan"',
        '      apiKeyEnv: STEP_API_KEY',
        '      api: openai-completions',
        '      baseURL: "https://api.stepfun.com/step_plan/v1"',
        '      models:',
        '        - id: "step-5-preview"',
        '',
      ].join('\n');
      fs.writeFileSync(settingsPath, st);
    }
    const credPath = path.join(HOME, '.credentials.yaml');
    let creds = '';
    try { creds = fs.readFileSync(credPath, 'utf8'); } catch { creds = 'version: 1\nrefs:\n'; }
    if (!creds.includes('STEP_API_KEY')) {
      creds = /^refs:\s*$/m.test(creds)
        ? creds.replace(/^refs:\s*$/m, `refs:\n  STEP_API_KEY: ${stepKey}`)
        : `${creds}\nrefs:\n  STEP_API_KEY: ${stepKey}\n`;
      fs.writeFileSync(credPath, creds, { mode: 0o600 });
    }
  }
  record('the isolated runtime has a usable model provider configured',
    !!stepKey, stepKey ? 'stepfun/step-5-preview' : 'no STEP_API_KEY in ~/.dsh');

  // ---- 2. 起隔离的 dsh web ----
  const logFile = path.join(WS, 'dsh.log');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [BIN, '--profile', 'web', '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: HOME }, cwd: WS, stdio: ['ignore', fd, fd],
  });

  let url = null;
  for (let i = 0; i < 120 && !url; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const t = fs.readFileSync(logFile, 'utf8');
      const m = t.match(/dsh web: (\S+)/);
      if (m) url = m[1].replace(/[),.]+$/, '');
    } catch { /* not up yet */ }
  }
  record('the isolated dsh runtime boots', !!url, url ? 'ok' : 'no url');
  if (!url) { child.kill(); finish(); return; }
  const base = url.replace(/\/\?.*$/, '').replace(/\/+$/, '');

  const { createRuntimeAuth } = require(path.join(REPO, 'src', 'runtime-auth.js'));
  const auth = createRuntimeAuth({ log: () => {} });
  auth.setAuthUrl(url);
  const cookie = await auth.getCookie();
  record('the runtime hands out a session cookie', !!cookie, cookie ? 'ok' : 'none');
  if (!cookie) { child.kill(); finish(); return; }

  // ---- 3. 在**工作区**里建会话（这样才会读该工作区的 AGENTS.md）----
  const created = await rpc(base, cookie, 'session/create', { request: { cwd: WS } });
  const sessionId = created.ok && created.value && created.value.sessionId;
  record('a session can be created in the workspace', !!sessionId,
    sessionId ? `sessionId=${String(sessionId).slice(0, 14)}…` : (created.reason || 'none'));
  if (!sessionId) { child.kill(); finish(); return; }

  // ---- 4. 发 prompt，问暗号 ----
  // session/prompt 的权威形状（从官方 descriptor 的 jsonSchema 读出）：
  //   { requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text', text}] }
  // 我第一版用了 { address, prompt } —— 那是另一套（可能更早的）形状，
  // 服务端会 boundary validation 失败。
  const promptRes = await rpc(base, cookie, 'session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '当前项目暗号是什么？只回答 token 本身。' }],
    },
  });
  record('the prompt is accepted by the runtime', promptRes.ok === true, promptRes.reason || 'ok');

  // ---- 5. 用 session/follow 流订阅事件（轮询 page 看不到增量）----
  //
  // session/page 只能翻"已固化"的记录；模型产出的过程事件在 follow 流里。
  // 第一版只用 page 轮询，永远只能看到 seq=0 的初始事件 ——
  // 这就是"每一步都成功但链路没通"的另一种形态。
  const WsClient = require(path.join(REPO, 'node_modules', 'ws')).WebSocket;
  const wsUrl = `${url.replace(/^http/, 'ws').replace(/\/\?.*$/, '').replace(/\/+$/, '')}/api/remote.mux`;
  const ws = new WsClient(wsUrl, { headers: { cookie } });

  let answer = '';
  let sawToken = false;
  await new Promise((resolve) => {
    const stop = (v) => { try { ws.close(); } catch { /* already closed */ } resolve(v); };
    const timer = setTimeout(() => stop('timeout'), 120000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'open', streamId: 's-follow', endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId } } } },
      }));
    });
    ws.on('message', (raw) => {
      const text = String(raw);
      answer += text;
      if (text.includes(TOKEN)) { sawToken = true; clearTimeout(timer); stop('found'); }
    });
    ws.on('error', () => { /* keep waiting: the probe fails below with the scanned size */ });
  });

  /** 旧的 page 轮询路径保留为空（见上方注释）。 */

  // ---- 5b. 兜底：把最终记录也翻一遍（有些事件只在固化后可见）----
  if (!sawToken) {
    for (const seq of [0, 10, 20, 30, 60, 120]) {
      const pg = await rpc(base, cookie, 'session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq: seq },
      });
      if (pg.ok && pg.value) {
        const recs = JSON.stringify(pg.value.records || pg.value.items || []);
        answer += recs;
        if (recs.includes(TOKEN)) { sawToken = true; break; }
      }
    }
  }

  // ---- 5c（旧轮询实现已移除）----

  record('the real model read the brief and answered with the secret token',
    sawToken === true,
    sawToken ? 'the model echoed the token — cross-session memory works' : `not found (${answer.length} bytes scanned)`);

  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'session-records.json'), answer);
    fs.writeFileSync(path.join(EVIDENCE, 'agents-md.txt'), agentsText);
  } catch { /* best effort */ }

  child.kill();
  finish();
}

main().catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
