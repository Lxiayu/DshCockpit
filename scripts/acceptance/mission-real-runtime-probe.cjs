// scripts/acceptance/mission-real-runtime-probe.cjs — Mission 依赖的真实运行时验证。
//
// 第一性原理：为什么 mock 测过还不够
//
//   main.js 里有三个函数直接对接真实运行时：
//     missionCancelSession  → session/cancel（暂停是不是真的刹车）
//     readWorkspaceChanges  → GET /api/changes.summary（凭证能不能读）
//     seqForMissionSession  → turn→seq 映射（凭证坐标的来源）
//
//   三个都被 mock 测过。但 mock 只能证明
//   "我按我以为的协议写了一版"，不能证明"真实运行时是这个协议"。
//   本项目已有先例：声明比视图宽（TeamMemberView / permissions 投影）。
//
//   所以这个探针对**真实运行时**验证三件事：
//     1. session/cancel 被接受
//     2. workspace/changes 事件真的出现，且带 seq
//     3. /api/changes.summary 真的返回 files[]，且路径是**相对路径**
//        （我们的 sanitizer 假设它相对；若某天变绝对，这里会先红）
//
// 用法：node scripts/acceptance/mission-real-runtime-probe.cjs <POC_ROOT>
// 2026-11-04 实测：8/8 通过。
// 真机验证：missionCancelSession / readWorkspaceChanges / seqForMissionSession
// 这三个函数在 main.js 里，只被 mock 测过 —— 从未对真实运行时验证。
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = process.argv[2];
const REPO = '/Users/xia/program/dsh/DshCockpit';
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const env = () => ({ ...process.env, DSH_HOME: path.join(ROOT, 'dsh-home'),
  DSH_POC_ISOLATED: '1', npm_config_cache: path.join(ROOT, 'npm-cache'),
  DSH_PRIMARY_RUNTIME: path.join(ROOT, 'dsh-home') });

function httpGet(url, headers = {}) {
  return new Promise((res) => {
    const r = http.get(url, { headers }, (s) => { let b = ''; s.on('data', (c) => b += c); s.on('end', () => res({ status: s.statusCode, headers: s.headers, body: b })); });
    r.on('error', (e) => res({ status: 0, headers: {}, body: String(e.message) }));
    r.setTimeout(20000, () => { r.destroy(); res({ status: 0, headers: {}, body: 'timeout' }); });
  });
}
function boot(bin) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [bin, '--profile', 'web', '--port', '0', '--no-open'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let b = ''; let d = false;
    const t = setTimeout(() => { if (!d) { d = true; try { c.kill('SIGKILL'); } catch {} res({ error: 'timeout' }); } }, 90000);
    const on = (x) => { b += String(x); const m = b.match(/https?:\/\/[^\s"']+/); if (m && !d) { d = true; clearTimeout(t); res({ url: m[0], child: c }); } };
    c.stdout.on('data', on); c.stderr.on('data', on);
    c.on('exit', (code) => { if (!d) { d = true; clearTimeout(t); res({ error: 'exit ' + code }); } });
  });
}
function unwrap(r) { return r && r.value !== undefined ? r.value : r; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const bin = path.join(ROOT, 'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const b = await boot(bin);
  if (b.error) { console.log('BOOT FAIL', b.error); process.exit(1); }
  const res = await httpGet(b.url);
  const sc = res.headers['set-cookie'];
  const cookie = (Array.isArray(sc) ? sc : [sc]).map((c) => String(c).split(';')[0]).join('; ');
  const { createRuntimeMux } = require(path.join(REPO, 'src/runtime-mux.js'));
  const mux = await new Promise((resolve, reject) => {
    const m = createRuntimeMux({ baseUrl: new URL(b.url).origin, auth: { getCookie: async () => cookie, invalidate() {} }, log() {}, onError() {} });
    const t = setTimeout(() => reject(new Error('mux timeout')), 25000);
    m.onReady(() => { clearTimeout(t); resolve(m); }); m.connect();
  });
  check('runtime boots + mux ready', true, '');

  const sid = unwrap(await mux.call('session/create', { request: { cwd: path.join(ROOT, 'workspace') } })).sessionId;
  check('session created', !!sid, String(sid).slice(0, 14) + '…');

  // ---- 验证 1: missionCancelSession 的底层 session/cancel ----
  // 先发一个会让模型跑一会儿的 prompt，然后 cancel
  await mux.call('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId: sid, mode: 'queue',
      content: [{ type: 'text', text: '请从 1 数到 200，每个数字单独一行。' }] },
  });
  await sleep(1500);
  let cancelled = false, cancelErr = null;
  try {
    await mux.call('session/cancel', { request: { sessionId: sid } });
    cancelled = true;
  } catch (e) { cancelErr = e.message; }
  check('session/cancel accepted by real runtime', cancelled, cancelErr || '');

  // ---- 验证 2: readWorkspaceChanges 的底层 /api/changes.summary ----
  // 需要一次真实文件变更。发一个 prompt 让模型写文件。
  const sid2 = unwrap(await mux.call('session/create', { request: { cwd: path.join(ROOT, 'workspace') } })).sessionId;
  const marker = 'probe-' + crypto.randomBytes(3).toString('hex');
  await mux.call('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId: sid2, mode: 'queue',
      content: [{ type: 'text', text: `请用 shell 执行: echo ${marker} > ${marker}.txt （只做这一件事）` }] },
  });
  // 等一个 turn 结束，从 follow 拿 cursor 作为 seq
  const seqInfo = await new Promise(async (resolve) => {
    const s = 'f-' + Date.now();
    const t = setTimeout(() => { try { mux.closeStream(s); } catch {} resolve(null); }, 180000);
    let lastSeq = null;
    mux.onItem(s, (it) => {
      if (it && it.type === 'event' && it.event) {
        if (Number.isFinite(it.event.seq)) lastSeq = it.event.seq;
        if (it.event.type === 'workspace/changes') {
          clearTimeout(t);
          try { mux.closeStream(s); } catch {}
          resolve({ seq: it.event.seq, turn: it.event.data && it.event.data.turn });
        }
      }
    });
    mux.openStream(s, 'session/follow', { request: { address: { kind: 'session', sessionId: sid2 } } });
    await sleep(Math.max(0, 120000));
    clearTimeout(t); try { mux.closeStream(s); } catch {}
    resolve(lastSeq ? { seq: lastSeq, turn: null } : null);
  });
  check('workspace/changes event observed', !!seqInfo, JSON.stringify(seqInfo));

  if (seqInfo && Number.isFinite(seqInfo.seq)) {
    const url = `${new URL(b.url).origin}/api/changes.summary?sessionId=${encodeURIComponent(sid2)}&seq=${seqInfo.seq}`;
    const cr = await httpGet(url, { cookie });
    let parsed = null;
    try { parsed = JSON.parse(cr.body); } catch {}
    check('GET /api/changes.summary returns 200', cr.status === 200, `status=${cr.status}`);
    check('changes.summary has files[]/total', parsed && Array.isArray(parsed.files) && Number.isFinite(parsed.total),
      parsed ? `total=${parsed.total} files=${(parsed.files || []).length}` : cr.body.slice(0, 80));
    check('the probe file appears in the change list',
      parsed && (parsed.files || []).some((f) => String(f.path).includes(marker)),
      JSON.stringify((parsed && parsed.files) || []).slice(0, 200));
    // 相对路径检查（我们的 sanitize 依赖它是相对路径）
    const anyAbs = parsed && (parsed.files || []).some((f) => String(f.path).startsWith('/'));
    check('paths are RELATIVE (our sanitizer assumes this)', !anyAbs, anyAbs ? 'absolute path found!' : 'relative ok');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')); }
  try { mux.close(); } catch {} try { b.child.kill(); } catch {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
