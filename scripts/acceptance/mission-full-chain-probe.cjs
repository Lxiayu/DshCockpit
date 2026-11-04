// scripts/acceptance/mission-full-chain-probe.cjs — Mission 全链路端到端探针。
//
// 第一性原理：为什么需要它，尽管每个模块都有单测
//
//   本项目反复出现同一个模式：**模块各自全绿，合起来静默失效**。
//     · presented-collector 产出 {relPath}，deliverable-signal 消费 {rawPath}
//     · projection 里 `if (!v.ok) break;` 对数组判断，永远 break
//     · 指令渲染只读了 Mission.constraints，静默丢弃合同里的约束
//
//   三者单测都是绿的。发现它们靠的都是**真的跑一遍链路看输出**。
//
//   这个探针覆盖：建 Mission → 授权 → 存合同 → 派发 → 确认 → 凭证 →
//   持久化 → 审计 → 隐私。每一步都断言具体内容，不只是"接口返回 ok"。
//
// 用法：node scripts/acceptance/mission-full-chain-probe.cjs
// 退出码 0 = 全通过，1 = 有失败项（会列出）。
// 全链路端到端探针：建 Mission → 授权 → 存合同 → 派发 → 确认 → 查凭证
// 目的：系统性暴露"单测全绿但链路断裂"的问题。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = path.join(__dirname, "..", "..");
const { registerMissionIpc } = require(path.join(REPO, 'src/ipc-mission.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-chain-'));
const handlers = new Map();
const prompts = [];
let now = 1000;
registerMissionIpc(
  { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
  {
    workspaceDirOf: () => dir,
    clock: () => now,
    log: () => {},
    snapshotOf: () => ({ observedAtMs: now, pendingItems: [] }),
    ensureSession: async () => ({ ok: true, sessionId: 'session-x' }),
    promptSession: async (sid, text) => { prompts.push(text); return { ok: true }; },
    projectionsOf: async () => ({
      ok: true,
      value: {
        values: {
          sessionStats: { turns: 2, steps: 7 },
          turnOutline: [{ turn: 2, response: '已完成' }],
          agentTeam: {
            members: [{ id: 'm0', name: 'lead', role: 'lead', phase: 'active' }],
            tasks: [{ id: 'task-1', revision: 1, subject: '干活 [KEY]', status: 'pending', ready: true, blockedBy: [] }],
          },
        },
      },
    }),
    seqOfTurn: () => 29,
    changesSummaryOf: async () => ({
      ok: true,
      value: { turn: 2, total: 1, added: 10, deleted: 2, files: [{ path: 'src/a.js', added: 10, deleted: 2 }] },
    }),
  },
);
const inv = handlers.get('mission:invoke');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  // 1. 建 Mission
  const created = await inv(null, 'create', { title: '端到端测试', intent: '验证全链路' });
  check('1. mission created', created.ok && created.missionId, created.missionId || created.reason);
  const mid = created.missionId;

  // 2. 授权
  const g = await inv(null, 'createGrant', { subdir: 'work/e2e', access: 'write' });
  check('2. grant created', g.ok && /^gr-/.test(g.grant.grantId), g.grant && g.grant.grantId);
  check('2b. grant dir created', fs.existsSync(path.join(dir, 'work', 'e2e')), path.join(dir, 'work', 'e2e'));

  // 3. 存合同（带 Grant 引用 + 约束 + 预算）
  const c = await inv(null, 'saveContract', {
    missionId: mid,
    contract: {
      acceptance: [{ id: 'a1', text: 'npm test 全绿', kind: 'command', command: 'npm test' }],
      constraints: [{ text: '不改官方代码' }],
      budget: { maxTokens: 50000 },
      grantId: g.grant.grantId,
    },
  });
  check('3. contract saved', c.ok, c.reason || '');

  // 4. 派发
  now = 2000;
  const sw = await inv(null, 'startWork', { missionId: mid, task: '实现功能' });
  check('4. startWork ok', sw.ok, sw.reason || '');
  check('4b. dispatchKey returned', typeof sw.dispatchKey === 'string' && sw.dispatchKey, sw.dispatchKey);
  check('4c. prompt sent', prompts.length === 1, `prompts=${prompts.length}`);

  // 5. 指令内容检查（这是上轮抓到 bug 的地方）
  const text = prompts[0] || '';
  check('5a. instruction has dispatch key', text.includes('[mission-dispatch:'), '');
  check('5b. instruction has acceptance', text.includes('npm test 全绿'), '');
  check('5c. instruction has constraint', text.includes('不改官方代码'), '');
  check('5d. instruction has budget', /50000|50,000/.test(text), '');
  check('5e. instruction has execution scale', text.includes('【执行规模】'), '');
  check('5f. NO absolute path in instruction', !text.includes(dir), 'leak check');

  // 6. 派发确认
  now = 3000;
  const conf = await inv(null, 'confirmDispatch', {
    missionId: mid, dispatchKey: sw.dispatchKey, startedAtMs: 1500,
  });
  check('6. confirmDispatch answered', conf.ok, conf.reason || '');
  check('6b. state is a known state', ['pending', 'confirmed', 'unconfirmed', 'rejected'].includes(conf.state), conf.state);

  // 7. 凭证
  now = 4000;
  const ws = await inv(null, 'workStatus', { missionId: mid });
  check('7. workStatus ok', ws.ok, ws.reason || '');
  check('7b. receipt present', !!ws.receipt, JSON.stringify(ws.receipt).slice(0, 120));
  check('7c. receipt state valid', ['claimed', 'verified', 'stale'].includes(ws.receipt && ws.receipt.state), ws.receipt && ws.receipt.state);

  // 8. 持久化：重开 store 看合同/凭证还在不在
  const { createMissionStore } = require(path.join(REPO, 'src/mission/store.js'));
  const reopened = createMissionStore({ workspaceDir: dir, now: () => 9999, log: () => {} });
  const mv = reopened.missionView(mid);
  check('8a. contract persisted', !!(mv && mv.mission && mv.mission.contract), '');
  check('8b. receipt persisted (only if verified)', (ws.receipt.state !== 'verified') || !!mv.mission.receipt, ws.receipt.state);

  // 9. 干预审计
  const hist = await inv(null, 'interventionHistory', { missionId: mid });
  check('9. interventionHistory ok', hist.ok, '');
  check('9b. audit has no raw sessionId', !JSON.stringify(hist).includes('session-x'), 'privacy');

  // 10. 隐私检查 —— 边界必须**分开**判，不能一刀切。
  //
  //   GRANT 是唯一合法携带绝对路径的实体：用户必须看见"授权了哪个目录"
  //   才知道该撤销哪一条（藏起来等于让他盲撤）。
  //   但路径绝不能进 Mission 事实链或派发指令。
  const factChain = JSON.stringify({ created, c, sw: { ok: sw.ok, dispatchKey: sw.dispatchKey }, conf, ws, hist });
  check('10a. no absolute path in mission/instruction/audit', !factChain.includes(dir), 'privacy: fact chain');
  check('10b. no raw sessionId leaked', !factChain.includes('session-x'), 'privacy');
  // 这一步授权的是子目录 work/e2e，所以断言用 expectedDir 而不是根目录。
  const expectedDir = path.join(dir, 'work', 'e2e');
  check('10c. grant DOES expose the directory (user must see what to revoke)',
    !!g.grant && g.grant.workspaceDir === expectedDir, 'privacy: grant is the one exception');
  // 指令里也不许有路径
  check('10d. instruction has no absolute path', !(prompts[0] || '').includes(dir), 'privacy: prompt');
  // 事件日志里也不许有
  const logPath = path.join(dir, '.dsh', 'mission', 'events.jsonl');
  const logRaw = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  check('10e. event log has no absolute path', !logRaw.includes(dir), 'privacy: events.jsonl');
  check('10f. event log DOES have the grantId reference', logRaw.includes(g.grant.grantId), '');

  // 11. 暂停应真的停
  now = 5000;
  const paused = await inv(null, 'updateStatus', { missionId: mid, to: 'paused' });
  check('11. pause reports stop state', paused.ok && paused.stopped !== undefined, `stopped=${paused.stopped}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
