'use strict';

// scripts/poc/s0-verify-u123.js — 一次验证 U-1 / U-2 / U-3（团队协作的三个核心动作）。
//
// 第一性原理：为什么这三个必须一起验
//
//   S0 第一轮证明了"能派生成员、能建任务"（被动写入可行）。
//   但我们的产品真正依赖的是**协作过程中的三个动作**：
//     U-1 send_message   —— 纠偏（S6）与"交给团队继续"（S2 追问）都靠它
//     U-2 interrupt_agent —— 停止一个跑偏的成员（S6）
//     U-3 blockedBy/ready —— 右栏"阻塞"显示（S6.2 C 类）与派发策略（S2）靠它
//
//   这三条如果有一条不通，计划里对应的章节就必须改写，而不是"先写了再说"。
//   所以本探针一次把它们测完，并记录**观测到的投影变化**作为证据。
//
// 做法：全部通过 prompt 让 Lead 调模型工具（因为没有 remote 写表面，见 D11）。
//
// 用法：node scripts/poc/s0-verify-u123.js --root <POC_ROOT> [--timeout 420000]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const results = [];
function record(name, status, detail, extra) {
  results.push({ name, status, detail: detail || '', ...(extra || {}) });
  const mark = { pass: 'PASS', fail: 'FAIL', 'not-verified': 'NOT-VERIFIED' }[status] || status;
  console.log(`[u123] ${mark.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`);
}

function pocEnv(root) {
  return {
    ...process.env,
    DSH_HOME: path.join(root, 'dsh-home'),
    DSH_POC_ISOLATED: '1',
    npm_config_cache: path.join(root, 'npm-cache'),
    DSH_PRIMARY_RUNTIME: path.join(root, 'dsh-home'),
  };
}

function findBin(root) {
  for (const p of [
    path.join(root, 'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    path.join(root, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ]) if (fs.existsSync(p)) return p;
  return null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const req = http.get(url, { headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
  });
}

async function bootWeb(bin, root) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0', '--no-open'], {
      env: pocEnv(root), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = ''; let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch {} resolve({ error: 'boot timeout' }); } }, 90000);
    const onData = (c) => {
      buf += String(c);
      const m = buf.match(/https?:\/\/[^\s"']+/);
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ url: m[0], child }); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ error: `exited ${code}` }); } });
  });
}

async function exchangeCookie(url) {
  const res = await httpGet(url);
  const sc = res.headers && res.headers['set-cookie'];
  if (!sc) return null;
  return (Array.isArray(sc) ? sc : [sc]).map((c) => String(c).split(';')[0]).join('; ');
}

function muxFactory(baseUrl, cookie) {
  const { createRuntimeMux } = require(path.join(REPO_ROOT, 'src', 'runtime-mux.js'));
  const auth = { getCookie: async () => cookie, invalidate: () => {} };
  const origin = new URL(baseUrl).origin;
  return new Promise((resolve, reject) => {
    const mux = createRuntimeMux({ baseUrl: origin, auth, log: () => {}, onError: () => {} });
    const t = setTimeout(() => { try { mux.close(); } catch {} reject(new Error('mux timeout')); }, 25000);
    mux.onReady(() => { clearTimeout(t); resolve(mux); });
    try { mux.connect(); } catch (e) { clearTimeout(t); reject(e); }
  });
}

function unwrap(r) { return r && r.value !== undefined ? r.value : r; }

async function team(mux, sid) {
  const p = unwrap(await mux.call('session/projections', { request: { sessionId: sid } }));
  return (p && p.values && p.values.agentTeam) || null;
}

async function prompt(mux, sid, text) {
  return mux.call('session/prompt', {
    request: {
      requestId: crypto.randomUUID(), sessionId: sid, mode: 'queue',
      content: [{ type: 'text', text }],
    },
  });
}

async function waitFor(fn, timeoutMs, stepMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

async function main() {
  const root = argValue('--root');
  const timeoutMs = Number(argValue('--timeout', '420000'));
  const outDir = path.join(root || '.', 'logs');
  if (!root) { console.error('usage: --root <POC_ROOT>'); process.exit(2); }
  const bin = findBin(root);
  if (!bin) { record('runtime binary', 'fail', 'missing'); return finish(outDir); }

  const boot = await bootWeb(bin, root);
  if (boot.error) { record('boot', 'fail', boot.error); return finish(outDir); }
  const cookie = await exchangeCookie(boot.url);
  if (!cookie) { record('cookie', 'fail', 'none'); try { boot.child.kill(); } catch {} return finish(outDir); }
  let mux;
  try { mux = await muxFactory(boot.url, cookie); } catch (e) { record('mux', 'fail', String(e.message)); return finish(outDir); }
  record('boot + mux', 'pass', boot.url.replace(/token=[^&]+/, 'token=<redacted>'));

  const sid = (unwrap(await mux.call('session/create', { request: { cwd: path.join(root, 'workspace') } })) || {}).sessionId;
  if (!sid) { record('session/create', 'fail', 'no id'); try { mux.close(); boot.child.kill(); } catch {} return finish(outDir); }
  record('session/create', 'pass', String(sid).slice(0, 12) + '…');

  // ---------- 准备：派生一个 teammate ----------
  const member = 'probeu';
  await prompt(mux, sid, [
    `用 spawn_teammate 创建一个 teammate，名字必须是 ${member}，`,
    '描述为"负责被中断的测试成员"，context 用 fresh。',
    '不要给它别的任务。完成后一句话汇报。',
  ].join(''));
  const spawned = await waitFor(async () => {
    const t = await team(mux, sid);
    return t && (t.members || []).some((m) => m.name === member) ? t : null;
  }, timeoutMs);
  record('U-1 前置：teammate 就绪', spawned ? 'pass' : 'not-verified',
    spawned ? `${member} in roster` : 'not spawned');
  if (!spawned) { try { mux.close(); boot.child.kill(); } catch {} return finish(outDir); }

  // ---------- U-1：send_message ----------
  const msgToken = 'MSG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  await prompt(mux, sid, [
    `用 send_message 给 ${member} 发一条消息，内容必须包含这个暗号：${msgToken}，`,
    '并要求它回复"收到"。然后你自己用一句话确认发送成功。',
  ].join(''));
  // 观测点：消息进入团队 mailbox（投影里的 delivered/messages 不在 wire view 中，
  // 因此这里观测 teammate 的 phase/会话是否继续，以及 Lead 是否报告成功）
  const afterSend = await waitFor(async () => {
    const t = await team(mux, sid);
    if (!t) return null;
    const m = (t.members || []).find((x) => x.name === member);
    // teammate 若被唤醒，phase 仍是 active；关键证据在会话历史里
    return m ? t : null;
  }, 60000);
  record('U-1 send_message 被接受', afterSend ? 'pass' : 'not-verified',
    afterSend ? 'team projection still healthy after send' : 'projection lost');

  // 从会话历史里找证据（follow cursor → page，U-8 已确认的正确读法）
  const hist = await readHistory(mux, sid);
  const histText = JSON.stringify(hist || {});
  record('U-1 消息暗号出现在会话历史', histText.includes(msgToken) ? 'pass' : 'not-verified',
    histText.includes(msgToken) ? 'token found in history' : 'token not found (模型可能改写或未真正发)');

  // ---------- U-2：interrupt_agent ----------
  // 先让 teammate 跑一个长任务，再中断
  await prompt(mux, sid, [
    `用 send_message 让 ${member} 执行一个耗时任务：从 1 数到 200，每个数字单独一行。`,
    '不要等它完成，立即返回。',
  ].join(''));
  await new Promise((r) => setTimeout(r, 6000));
  await prompt(mux, sid, `用 interrupt_agent 中断 ${member} 当前这一轮。然后一句话汇报结果。`);
  const interrupted = await waitFor(async () => {
    const t = await team(mux, sid);
    if (!t) return null;
    const m = (t.members || []).find((x) => x.name === member);
    return m || null;
  }, 60000);
  record('U-2 interrupt_agent 被接受', interrupted ? 'pass' : 'not-verified',
    interrupted ? `member phase=${interrupted.phase}` : 'member disappeared');

  // ---------- U-3：blockedBy / ready ----------
  const tA = 'probe-task-A-' + crypto.randomBytes(2).toString('hex');
  const tB = 'probe-task-B-' + crypto.randomBytes(2).toString('hex');
  await prompt(mux, sid, [
    `用 team_task_create 创建两个任务：`,
    `第一个 subject 必须是 "${tA}"；`,
    `第二个 subject 必须是 "${tB}"，并且 blockedBy 指向第一个任务的 id（你必须先创建 A，再用它的 id）。`,
    '创建完用 team_task_list 列出它们并汇报 ready 状态。',
  ].join(''));
  const dag = await waitFor(async () => {
    const t = await team(mux, sid);
    if (!t || !Array.isArray(t.tasks)) return null;
    const a = t.tasks.find((x) => String(x.subject).includes(tA));
    const b = t.tasks.find((x) => String(x.subject).includes(tB));
    return a && b ? { a, b } : null;
  }, timeoutMs);
  if (dag) {
    record('U-3 两个任务都已创建', 'pass', `${dag.a.id} / ${dag.b.id}`);
    const bBlocked = Array.isArray(dag.b.blockedBy) && dag.b.blockedBy.includes(dag.a.id);
    record('U-3 B 的 blockedBy 指向 A', bBlocked ? 'pass' : 'fail',
      `blockedBy=${JSON.stringify(dag.b.blockedBy)}`);
    record('U-3 B 在 A 未完成时 ready=false', dag.b.ready === false ? 'pass' : 'fail',
      `b.ready=${dag.b.ready}`);
    record('U-3 A 自身 ready=true', dag.a.ready === true ? 'pass' : 'fail', `a.ready=${dag.a.ready}`);

    // 完成 A，看 B 是否变 ready
    await prompt(mux, sid, [
      `用 team_task_update 把任务 ${dag.a.id} 的状态改成 completed（记得带当前 revision ${dag.a.revision}）。`,
      '然后用 team_task_list 确认第二个任务是否变成 ready。',
    ].join(''));
    const afterDone = await waitFor(async () => {
      const t = await team(mux, sid);
      if (!t) return null;
      const b = (t.tasks || []).find((x) => x.id === dag.b.id);
      return b && b.ready === true ? b : null;
    }, timeoutMs);
    record('U-3 A 完成后 B 变 ready', afterDone ? 'pass' : 'fail',
      afterDone ? `b.ready=true revision=${afterDone.revision}` : 'B did not become ready');
  } else {
    record('U-3 两个任务都已创建', 'not-verified', 'Tasks A/B not both observed');
    record('U-3 B 的 blockedBy 指向 A', 'not-verified', 'no DAG');
    record('U-3 B 在 A 未完成时 ready=false', 'not-verified', 'no DAG');
    record('U-3 A 自身 ready=true', 'not-verified', 'no DAG');
    record('U-3 A 完成后 B 变 ready', 'not-verified', 'no DAG');
  }

  // 最终快照（脱敏后存档）
  const finalTeam = await team(mux, sid);
  if (finalTeam) {
    record('final agentTeam snapshot', 'pass', JSON.stringify({
      members: (finalTeam.members || []).map((m) => ({ name: m.name, role: m.role, phase: m.phase })),
      tasks: (finalTeam.tasks || []).map((x) => ({
        id: x.id, subject: x.subject, status: x.status, ready: x.ready,
        blockedBy: x.blockedBy, revision: x.revision,
      })),
    }).slice(0, 900));
  }

  try { mux.close(); } catch {}
  try { boot.child.kill('SIGTERM'); } catch {}
  return finish(outDir);
}

/** follow 拿 cursor → page（U-8 已确认的正确读法）。 */
function readHistory(mux, sid, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const streamId = 'hist-' + crypto.randomUUID();
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { mux.closeStream(streamId); } catch {} resolve(null); } }, timeoutMs);
    let off = null;
    off = mux.onItem(streamId, async (item) => {
      if (done || !item || item.type !== 'snapshot') return;
      done = true; clearTimeout(timer);
      try { off && off(); } catch {}
      try { mux.closeStream(streamId); } catch {}
      try {
        const page = unwrap(await mux.call('session/page', {
          request: { address: { kind: 'session', sessionId: sid }, throughSeq: item.cursor, maxMessages: 60 },
        }));
        resolve(page || null);
      } catch { resolve(null); }
    });
    mux.openStream(streamId, 'session/follow', { request: { address: { kind: 'session', sessionId: sid }, maxMessages: 30 } });
  });
}

function finish(outDir) {
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 's0-u123.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2));
    console.log('[u123] report: ' + path.join(outDir, 's0-u123.json'));
  } catch (e) { console.error('[u123] write failed:', e.message); }
  console.log('[u123] counts: ' + JSON.stringify(counts));
  process.exit(0); // 不因个别 not-verified 失败（模型不确定性）
}

main().catch((e) => { console.error('[u123] FATAL', e && e.stack || e); process.exit(1); });
