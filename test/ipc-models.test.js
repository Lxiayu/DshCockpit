// test/ipc-models.test.js — Issue #22 Phase 1：模型配置域。
//
// 第一性原理：为什么"未就绪"的返回形状**不能统一**
//
//   modelsMgr 在启动早期是 null。此时六个 handler 的降级形状各不相同，
//   而且都是设置页依赖的：
//     · models-list    → presets 常量（面板要能显示可选项，不能空白）
//     · save/remove/set-default → {ok:false, reason:'not ready'}
//     · models-test    → **额外带 kind:'other'**（结果卡靠它分类）
//     · ollama-status  → {installed,version,models,registered,reason}（卡片专用结构）
//
//   把它们"顺手统一成 {ok:false}"会破坏既有 UI 判断。这类错误在 review 时
//   几乎看不出来（都是"返回一个对象"），只有真机点开面板才会发现空白或崩溃。
//   所以这里逐条锁住四种形状。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerModelsIpc } = require('../src/ipc-models.js');

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

const PRESETS = { deepseek: { label: 'DeepSeek' } };
const OLLAMA = { label: 'Ollama', provider: 'ollama' };

function fakeCtx(over = {}) {
  const state = { notifications: [], logs: [] };
  const base = {
    modelsMgr: {
      list: () => ({ presets: PRESETS, ollamaPreset: OLLAMA, profiles: [{ id: 'p1' }], default: 'p1' }),
      save: (profile, apiKey) => ({ ok: true, profile, hasKey: !!apiKey }),
      remove: (id) => ({ ok: true, removed: id }),
      test: async (target) => ({ ok: true, kind: 'chat', target }),
      ollamaStatus: async () => ({ installed: true, version: '0.3.0', models: ['llama3'], registered: true }),
      setDefault: (provider, model) => ({ ok: true, provider, model }),
    },
    MODELS_PRESETS: PRESETS,
    MODELS_OLLAMA_PRESET: OLLAMA,
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
  registerModelsIpc(ipc, ctx);
  return { ipc, state };
}

// ------------------------------------------------------------------ 注册范围

test('ipc-models: registers exactly the 6 model channels', () => {
  // 注意 ollama-status 也在这一组：它由 modelsMgr 提供，不是独立域。
  const { ipc } = register();
  assert.deepEqual(ipc.channels(), [
    'shell:models-list', 'shell:models-remove', 'shell:models-save',
    'shell:models-set-default', 'shell:models-test', 'shell:ollama-status',
  ]);
});

// ------------------------------------------- 四种"未就绪"形状（关键）

test('ipc-models: models-list degrades to PRESETS (the panel must not be blank)', async () => {
  const { ipc } = register({ modelsMgr: null });
  const out = await ipc.invoke('shell:models-list');
  assert.deepStrictEqual(out.presets, PRESETS, 'presets must still be offered before the manager exists');
  assert.deepStrictEqual(out.ollamaPreset, OLLAMA);
  assert.deepStrictEqual(out.profiles, []);
  assert.strictEqual(out.default, null);
});

test('ipc-models: mutations degrade to {ok:false, reason:"not ready"}', async () => {
  const { ipc } = register({ modelsMgr: null });
  for (const ch of ['shell:models-save', 'shell:models-remove', 'shell:models-set-default']) {
    const out = await ipc.invoke(ch, 'x', 'y');
    assert.strictEqual(out.ok, false, `${ch} must report failure`);
    assert.strictEqual(out.reason, 'not ready');
  }
});

test('ipc-models: models-test carries kind:"other" when not ready (the result card needs it)', async () => {
  // 缺 kind 会让测试结果卡渲染成"未知类型"。
  const { ipc } = register({ modelsMgr: null });
  const out = await ipc.invoke('shell:models-test', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.kind, 'other', 'the kind discriminator is load-bearing for the UI');
  assert.strictEqual(out.reason, 'not ready');
});

test('ipc-models: ollama-status has its OWN shape, not {ok:false}', async () => {
  // Ollama 卡片读的是 installed/version/models/registered，不是 ok。
  const { ipc } = register({ modelsMgr: null });
  const out = await ipc.invoke('shell:ollama-status');
  assert.strictEqual(out.installed, false);
  assert.strictEqual(out.version, null);
  assert.deepStrictEqual(out.models, []);
  assert.strictEqual(out.registered, false);
  assert.strictEqual(out.reason, 'not ready');
  assert.ok(!('ok' in out), 'this handler does not use the ok envelope');
});

// ------------------------------------------------------------------ 正常路径

test('ipc-models: models-save forwards profile and api key', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('shell:models-save', { provider: 'x' }, 'sk-123');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.hasKey, true);
});

test('ipc-models: a throwing save becomes {ok:false} and is logged', async () => {
  const { ipc, state } = register({
    modelsMgr: { ...fakeCtx().ctx.modelsMgr, save: () => { throw new Error('vault locked'); } },
  });
  const out = await ipc.invoke('shell:models-save', {}, 'k');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /vault locked/);
  assert.ok(state.logs.some((l) => /save failed/.test(l)));
});

test('ipc-models: removing a model notifies only on success', async () => {
  const ok = register();
  await ok.ipc.invoke('shell:models-remove', 'p1');
  assert.strictEqual(ok.state.notifications.length, 1);

  const fail = register({
    modelsMgr: { ...fakeCtx().ctx.modelsMgr, remove: () => ({ ok: false, reason: 'in use' }) },
  });
  await fail.ipc.invoke('shell:models-remove', 'p1');
  assert.strictEqual(fail.state.notifications.length, 0, 'a failed removal must not claim success');
});

test('ipc-models: setting the default notifies with provider and model', async () => {
  const { ipc, state } = register();
  await ipc.invoke('shell:models-set-default', 'deepseek', 'deepseek-v4');
  assert.strictEqual(state.notifications.length, 1);
  assert.match(state.notifications[0].body, /deepseek/);
  assert.match(state.notifications[0].body, /deepseek-v4/);
});

test('ipc-models: a FAILED set-default does not notify', async () => {
  const { ipc, state } = register({
    modelsMgr: { ...fakeCtx().ctx.modelsMgr, setDefault: () => ({ ok: false, reason: 'unknown provider' }) },
  });
  await ipc.invoke('shell:models-set-default', 'nope', 'x');
  assert.strictEqual(state.notifications.length, 0);
});

test('ipc-models: models-test forwards the target unchanged', async () => {
  const { ipc } = register();
  const target = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3' };
  const out = await ipc.invoke('shell:models-test', target);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.target, target);
});
