// test/mission-desk-action-parity.test.js — Desk 的 action 全覆盖（P4 收尾）。
//
// 第一性原理：覆盖率不是"18/20 比 17/20 好"
//
//   满覆盖不是目标，**每个缺失都有理由**才是。所以本文件断言三件事：
//
//     1. 所有"用户真需要做"的 action 都有 UI
//     2. 没有 UI 的 action 必须是**有理由的**（不是忘了）
//     3. 不为了凑数而加冗余入口（冗余入口本身就是负担）
//
//   第 2 条尤其重要：一个"忘了做"的缺口和一个"刻意不做"的缺口
//   在代码里长得一模一样，只有写下来才能区分。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { ACTIONS } = require(path.join(ROOT, 'src', 'ipc-mission.js'));
const deskHtml = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');
const deskCode = deskHtml.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function usedActions() {
  const found = new Set([...deskCode.matchAll(/api\('([a-zA-Z]+)'/g)].map((m) => m[1]));
  // 2026-11-02 重构：发现/假设/证据走统一的 renderEntitySection，
  // action 名变成了**配置参数**（apiAction: 'updateFindingStatus'），
  // 不再是字面量 api('xxx')。所以这里也要认配置形式。
  //
  // 这不是放宽标准——配置里的 apiAction 仍然必须真的被调用，
  // 只是写在了 renderEntitySection/EntityForm 的实现里。
  for (const m of deskCode.matchAll(/apiAction:\s*'([a-zA-Z]+)'/g)) found.add(m[1]);
  // renderEntityForm 用 submit('recordXxx', ...) 的形式
  for (const m of deskCode.matchAll(/submit\('([a-zA-Z]+)'/g)) found.add(m[1]);
  return found;
}

// ============================================ 刻意不做 UI 的 action（白名单）

/** action → 为什么 Desk 不需要单独调它。新增条目必须写理由。 */
const DELIBERATELY_NO_UI = {
  listTaskRefs: 'the desk reads taskRefs straight off missionView(); a second fetch would be redundant',
  openDesk: 'the desk IS the desk — it has no reason to open itself (office:open-desk covers that)',
  // bindSession 是给**未来**的"用已有会话继续"用的。当前 startWork 会自动绑定，
  // 用户不需要手动指定会话——暴露一个"手填 sessionId"的输入框反而是把
  // 内部 id 暴露给用户，违背隐私规则。等真有"跨设备接管会话"的需求再开 UI。
  bindSession: 'manual session binding is internal: startWork binds automatically, and exposing a raw sessionId field would leak an internal id to users',
};

test('parity: every action either has a UI entry point or a documented reason not to', () => {
  const used = usedActions();
  const missing = ACTIONS.filter((a) => !used.has(a) && !(a in DELIBERATELY_NO_UI));
  assert.deepEqual(missing, [],
    `these actions have no UI and no documented reason: ${missing.join(', ')}`);
});

test('parity: the "no UI" whitelist is small and justified', () => {
  // 白名单不能变成"什么都往里塞"的垃圾桶。
  // 上限从 2 提到 3（2026-11-02）：新增 bindSession 带真实理由，
  // 且它不是"懒得做 UI"，是"做 UI 会泄露内部 id"。
  assert.ok(Object.keys(DELIBERATELY_NO_UI).length <= 3,
    'only actions with a real structural reason may skip the UI');
  for (const [action, reason] of Object.entries(DELIBERATELY_NO_UI)) {
    assert.ok(ACTIONS.includes(action), `${action} must be a real action`);
    assert.ok(typeof reason === 'string' && reason.length > 20, `${action} needs a real reason`);
  }
});

test('parity: the two write gaps from the audit are now covered', () => {
  // 审计指出的真缺口。
  const used = usedActions();
  assert.ok(used.has('update'), 'title/intent must be editable — otherwise a typo forces a rebuild');
  assert.ok(used.has('openQuestion'), 'the user must be able to record their own open questions');
});

// ============================================ update 的边界

test('parity: update does NOT offer a status field (status has its own action)', () => {
  // 接口约定里 update 刻意不支持 status —— 状态变更是独立事实。
  // UI 若混进去，会让"改标题"顺手改了状态，产生两条路径。
  //
  // 断言范围要覆盖**调用点前后**：patch 对象在调用前组装，
  // 但也可以有人写 `const patch = {...}; api('update', patch)` 之后再加。
  const idx = deskCode.indexOf("api('update'");
  assert.ok(idx !== -1);
  // 从"目标"区块开头到 update 调用之后，整段都不能出现 status
  // 锚点：这个区块的标题（2026-11-04 从 '目标' 改为 '编辑标题与目标'，
  // 因为头部已经有"目标"展示，重复标题会让用户以为页面上有两个目标）。
  const blockStart = deskCode.indexOf("text: '编辑标题与目标'");
  assert.ok(blockStart !== -1 && blockStart < idx);
  const body = deskCode.slice(blockStart, idx + 300);
  assert.doesNotMatch(body, /\.status\s*=|status\s*:/,
    'the update form must not send a status field (status goes through updateStatus)');
});

test('parity: update reports why it failed when there is nothing to change', () => {
  const idx = deskCode.indexOf("api('update'");
  const body = deskCode.slice(Math.max(0, idx - 1500), idx + 200);
  assert.match(body, /没有改动/, 'an empty patch must be caught before calling the API');
});

// ============================================ openQuestion 与 answerQuestion 闭环

test('parity: asking and answering live in the same section (closed loop)', () => {
  // 只能答不能问 = 这一节的内容全部来自外部。所以两者必须在同一节。
  // strip 已去掉注释，所以按**渲染出的标题文本**定位区块边界。
  const qBlockStart = deskCode.indexOf('未决问题');
  const wsBlockStart = deskCode.indexOf("text: '工作流'");
  assert.ok(qBlockStart !== -1, 'the questions section must exist');
  assert.ok(wsBlockStart > qBlockStart, 'the questions section must come before workstreams');
  const block = deskCode.slice(qBlockStart, wsBlockStart);
  assert.match(block, /api\('openQuestion'/, 'the question section must let the user ASK');
  assert.match(block, /api\('answerQuestion'/, 'and also ANSWER');
});

test('parity: a newly asked question becomes answerable (same render path)', () => {
  // 提问后走 refresh()，回答入口由同一个渲染函数产出，所以闭环成立。
  const idx = deskCode.indexOf("api('openQuestion'");
  const body = deskCode.slice(idx, idx + 700);
  assert.match(body, /refresh\(\)/, 'after asking, the list must re-render so the answer input appears');
});

// ============================================ 端到端

test('parity e2e: update changes the title and it survives a reload', () => {
  const { createMissionStore } = require(path.join(ROOT, 'src', 'mission', 'store.js'));
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  const store = createMissionStore({ workspaceDir: dir });
  const missionId = 'mis-par1';
  store.append('mission.created', {
    missionId, workspaceId: 'wsp-par1', title: '旧标题', intent: '旧目标',
    status: 'active', createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });

  assert.strictEqual(store.append('mission.updated',
    { missionId, title: '新标题', intent: '新目标' }, { missionId }).ok, true);

  // 重新打开（模拟重启）
  const reopened = createMissionStore({ workspaceDir: dir });
  const view = reopened.missionView(missionId);
  assert.strictEqual(view.mission.title, '新标题');
  assert.strictEqual(view.mission.intent, '新目标');
});

test('parity e2e: a question asked by the user can then be answered', () => {
  const { createMissionStore } = require(path.join(ROOT, 'src', 'mission', 'store.js'));
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity2-'));
  const store = createMissionStore({ workspaceDir: dir });
  const missionId = 'mis-par2';
  store.append('mission.created', {
    missionId, workspaceId: 'wsp-par2', title: 'T', intent: 'I',
    status: 'active', createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });

  // 用户自己提问
  store.append('question.opened', {
    questionId: 'q-par1', missionId, text: '要不要拆成两个包？', status: 'open', askedAtMs: Date.now(),
  }, { missionId });
  let view = store.missionView(missionId);
  assert.strictEqual(view.questions[0].status, 'open');
  assert.strictEqual(view.questions[0].text, '要不要拆成两个包？');

  // 然后回答它
  store.append('question.answered', {
    questionId: 'q-par1', answer: '先不拆，验证需求再拆',
  }, { missionId });
  view = store.missionView(missionId);
  assert.strictEqual(view.questions[0].status, 'answered');
  assert.strictEqual(view.questions[0].answer, '先不拆，验证需求再拆');
});
