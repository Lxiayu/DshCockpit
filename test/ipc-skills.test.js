// test/ipc-skills.test.js — Issue #22 Phase 1：skills 域的行为测试。
//
// 第一性原理：为什么 shell:* 按"域"搬而不是按"前缀"搬
//
//   shell:* 有 74 个 handler，看起来像整体，实际是 20+ 个互不相关的业务域
//   被同一个前缀拴在一起。按前缀批量搬只有两种结局：搬不动（域间共享辅助），
//   或搬出一个新的巨型文件（问题一点没解决）。
//
//   正确粒度是**域**：handler + 它**专用的**辅助函数一起走，
//   与其它域共用的通过 ctx 注入。
//
// 本套件锁住 skills 域最容易被重构破坏的语义：
//   1. 串行化守卫：并发操作必须被挡住（tryBegin/release 必须配对）
//   2. bundle-plugin 型技能包必须**委派**给插件流水线，而不是当普通技能装
//   3. 错误码 → i18n key 的 kebab→camel 映射
//   4. 通知只在合适的时机发（成功/失败，但 preview 不发）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerSkillsIpc } = require('../src/ipc-skills.js');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
      handlers.set(channel, fn);
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null }, ...args);
    },
    channels() { return [...handlers.keys()].sort(); },
  };
}

function fakeCtx(over = {}) {
  const state = { notifications: [], logs: [], begun: [], released: 0 };
  const base = {
    skillsMgr: {
      listInstalled: () => [{ name: 's1', repo: 'r/s1' }],
      preview: async (n) => ({ ok: true, name: n }),
      install: async (n) => ({ ok: true, installed: [{ name: n }] }),
      remove: (n) => ({ ok: true, removed: n }),
      upgrade: async (n) => ({ ok: true, installed: [{ name: n }] }),
      importLocal: async (d) => ({ ok: true, installed: [{ name: `imported-${d}` }] }),
    },
    skillsGuard: {
      tryBegin: (op, arg) => { state.begun.push(`${op}:${arg}`); return true; },
      release: () => { state.released += 1; },
    },
    fetchMarketData: async (force) => ({ source: 'live', entries: [{ fullName: 'a/b' }], fetchedAt: force ? 2 : 1 }),
    fetchStarMap: async () => ({ 'a/b': { stars: 5 } }),
    buildSkillsMarketPayload: (entries, starMap, repos) => ({ plugins: entries, stars: starMap, repoCount: repos.size }),
    pluginAction: async (op, arg) => ({ ok: true, delegatedTo: 'plugin', op, arg }),
    notify: (title, body) => { state.notifications.push({ title, body }); },
    t: (lang, key, vars) => (vars ? `${key}|${JSON.stringify(vars)}` : key),
    lang: () => 'zh',
    log: (m) => { state.logs.push(m); },
  };
  return { ctx: { ...base, ...over }, state };
}

function register(over) {
  const ipc = fakeIpcMain();
  const { ctx, state } = fakeCtx(over);
  registerSkillsIpc(ipc, ctx);
  return { ipc, state };
}

// ------------------------------------------------------------------ 注册范围

test('ipc-skills: registers exactly the 6 skills channels', () => {
  const { ipc } = register();
  assert.deepEqual(ipc.channels(), [
    'shell:skills-import', 'shell:skills-install', 'shell:skills-list',
    'shell:skills-preview', 'shell:skills-remove', 'shell:skills-upgrade',
  ]);
});

test('ipc-skills: registering twice throws', () => {
  const ipc = fakeIpcMain();
  const { ctx } = fakeCtx();
  registerSkillsIpc(ipc, ctx);
  assert.throws(() => registerSkillsIpc(ipc, ctx), /duplicate/);
});

// ------------------------------------------------------------------ 守卫

test('ipc-skills: every mutating action goes through the serialisation guard', async () => {
  // 技能安装会写文件；并发两个安装会互相踩。守卫是必需的，不是装饰。
  const { ipc, state } = register();
  await ipc.invoke('shell:skills-install', 'a/b');
  await ipc.invoke('shell:skills-remove', 'x');
  await ipc.invoke('shell:skills-upgrade', 'y');
  await ipc.invoke('shell:skills-import', '/tmp/d');
  assert.strictEqual(state.begun.length, 4, 'each action must acquire the guard');
  assert.strictEqual(state.released, 4, 'and every acquire must be released (even preview/errors)');
});

test('ipc-skills: a busy guard returns {ok:false, code:"busy"} WITHOUT running the operation', async () => {
  let ran = false;
  const { ipc, state } = register({
    skillsGuard: {
      tryBegin: () => false,
      release: () => { state.released += 1; },
    },
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      install: async () => { ran = true; return { ok: true }; },
    },
  });
  const out = await ipc.invoke('shell:skills-install', 'a/b');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'busy');
  assert.strictEqual(ran, false, 'the operation must not run while busy');
});

test('ipc-skills: the guard is released even when the manager throws', async () => {
  const { ipc, state } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      install: async () => { throw new Error('disk full'); },
    },
  });
  await assert.rejects(() => ipc.invoke('shell:skills-install', 'a/b'), /disk full/);
  assert.strictEqual(state.released, 1, 'the finally block must still release');
});

// ---------------------------------------------------------- bundle 委派

test('ipc-skills: a bundle-plugin skill pack is DELEGATED to the plugin pipeline', async () => {
  // 这类包（package.json + dsh bundle）需要重启才生效，走技能路径装不上。
  // 不委派的话用户会看到一个装成功但永远不生效的技能。
  const { ipc, state } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      install: async () => ({ ok: false, code: 'plugin-form' }),
    },
  });
  const out = await ipc.invoke('shell:skills-install', 'owner/bundle-pack');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.delegated, 'plugin');
  assert.strictEqual(out.delegatedTo, 'plugin');
  assert.ok(state.logs.some((l) => /delegating to plugin install/.test(l)));
});

test('ipc-skills: delegation only happens for INSTALL (not remove/upgrade)', async () => {
  const { ipc } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      upgrade: async () => ({ ok: false, code: 'plugin-form' }),
    },
  });
  const out = await ipc.invoke('shell:skills-upgrade', 'x');
  assert.strictEqual(out.ok, false, 'upgrade must not be delegated');
  assert.strictEqual(out.delegated, undefined);
});

// ------------------------------------------------------- 错误码 → i18n

test('ipc-skills: kebab-case result codes map to camelCase i18n keys', async () => {
  // skills.js 用 'plugin-form' / 'no-source'，i18n 用 skills.pluginForm / skills.noSource。
  //
  // 桩必须模拟**真实** t()：命中 key 时返回译文。否则测的就不是映射，
  // 而是"没翻译时如何降级"（那是下一条用例的事）。
  const seenKeys = [];
  const { ipc } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      remove: () => ({ ok: false, code: 'no-source' }),
    },
    t: (lang, key) => {
      seenKeys.push(key);
      // 只有真实存在的 camelCase key 才"有译文"
      return key === 'skills.noSource' ? '该技能不是由市场安装' : key;
    },
  });
  const out = await ipc.invoke('shell:skills-remove', 'x');
  assert.strictEqual(out.ok, false);
  assert.ok(seenKeys.includes('skills.noSource'),
    `the kebab code must be converted to camelCase; saw: ${seenKeys.join(', ')}`);
  assert.match(out.reason, /该技能不是由市场安装/, 'the translated reason must reach the caller');
});

test('ipc-skills: an unknown code falls back to the code itself (not a broken key)', async () => {
  const { ipc } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      remove: () => ({ ok: false, code: 'weird-code' }),
    },
  });
  const out = await ipc.invoke('shell:skills-remove', 'x');
  // t() 在本测试里返回 key 本身，所以"翻译不存在"会被检测为 key === text
  assert.strictEqual(out.reason, 'weird-code', 'an untranslated code must surface as the code');
});

test('ipc-skills: a multi-error result gets a joined reason', async () => {
  const { ipc } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      install: async () => ({ ok: false, errors: [{ code: 'e1' }, { code: 'e2' }] }),
    },
  });
  const out = await ipc.invoke('shell:skills-install', 'a/b');
  assert.match(out.reason, /skills\.e1/);
  assert.match(out.reason, /；/, 'multiple errors are joined with a separator');
});

// ------------------------------------------------------------------ 通知

test('ipc-skills: a successful install notifies the user', async () => {
  const { ipc, state } = register();
  await ipc.invoke('shell:skills-install', 'a/b');
  assert.strictEqual(state.notifications.length, 1);
  assert.match(state.notifications[0].title, /skills\.installed/);
});

test('ipc-skills: PREVIEW never notifies (it is a read, not a change)', async () => {
  const { ipc, state } = register();
  await ipc.invoke('shell:skills-preview', 'a/b');
  assert.strictEqual(state.notifications.length, 0, 'a preview must not produce a notification');
});

test('ipc-skills: a remove notifies with the removed name', async () => {
  const { ipc, state } = register();
  await ipc.invoke('shell:skills-remove', 'old-skill');
  assert.strictEqual(state.notifications.length, 1);
  assert.match(state.notifications[0].body, /old-skill/);
});

test('ipc-skills: a failure notifies, EXCEPT for multi/busy/preview', async () => {
  for (const code of ['multi', 'busy']) {
    const { ipc, state } = register({
      skillsMgr: {
        ...fakeCtx().ctx.skillsMgr,
        install: async () => ({ ok: false, code, reason: 'x' }),
      },
    });
    await ipc.invoke('shell:skills-install', 'a/b');
    assert.strictEqual(state.notifications.length, 0,
      `code "${code}" is handled elsewhere — it must not double-notify`);
  }

  const { ipc, state } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      install: async () => ({ ok: false, code: 'e9', reason: 'boom' }),
    },
  });
  await ipc.invoke('shell:skills-install', 'a/b');
  assert.strictEqual(state.notifications.length, 1, 'a real failure must notify');
});

test('ipc-skills: install warnings are surfaced in the notification body', async () => {
  const { ipc, state } = register({
    skillsMgr: {
      ...fakeCtx().ctx.skillsMgr,
      install: async () => ({ ok: true, installed: [{ name: 's', warnings: [{ code: 'w1' }] }] }),
    },
  });
  await ipc.invoke('shell:skills-install', 'a/b');
  assert.match(state.notifications[0].body, /skills\.w1/, 'warnings must not be swallowed');
});

// ------------------------------------------------------------------ 市场

test('ipc-skills: skills-list merges installed + market and reports the source', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('shell:skills-list', false);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.source, 'live');
  assert.deepStrictEqual(out.installed, [{ name: 's1', repo: 'r/s1' }]);
  assert.strictEqual(out.repoCount, 1, 'the installed repos are passed as a Set to the payload builder');
});

test('ipc-skills: skills-list forwards the force flag to the market fetch', async () => {
  let sawForce = null;
  const { ipc } = register({
    fetchMarketData: async (force) => { sawForce = force; return { source: 'live', entries: [], fetchedAt: 1 }; },
  });
  await ipc.invoke('shell:skills-list', true);
  assert.strictEqual(sawForce, true);
});

test('ipc-skills: a market failure becomes {ok:false}, never a thrown IPC error', async () => {
  const { ipc } = register({
    fetchMarketData: async () => { throw new Error('offline'); },
  });
  const out = await ipc.invoke('shell:skills-list', false);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /offline/);
});
