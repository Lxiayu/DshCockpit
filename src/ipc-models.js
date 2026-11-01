// src/ipc-models.js — 模型配置域的 IPC 注册（Issue #22 Phase 1）。
//
// 第一性原理：为什么 models 是 shell:* 里第二批适合提取的域
//
//   与 skills 同样的判据（见 ipc-skills.js）：
//     1. 6 个 handler，边界清楚（models-list/save/remove/test/set-default + ollama-status）
//     2. 有独立的 modelsMgr，不碰窗口/广播/生命周期
//     3. 依赖集合小：modelsMgr + 两个 PRESETS 常量 + notify/t/lang/log
//
// 第二性原理：为什么"未就绪"时的返回值**不能统一**
//
//   modelsMgr 在启动早期是 null。此时六个 handler 的降级形状**各不相同**，
//   而且都是 UI 依赖的：
//     · models-list      → 返回 presets 常量（面板要能显示可选项，不能空白）
//     · models-save/remove/set-default → {ok:false, reason:'not ready'}
//     · models-test      → **额外带 kind:'other'**（测试结果渲染需要这个字段）
//     · ollama-status    → {installed:false, version:null, models:[], registered:false, reason}
//                          （这是 Ollama 卡片的结构，缺字段会让卡片渲染崩）
//
//   把它们"顺手统一成 {ok:false}" 会破坏设置页的既有判断逻辑——
//   这是提取时最容易犯、且很难在 review 中看出来的错误。
//   测试逐条锁住了这四种不同形状。
'use strict';

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {object|null} ctx.modelsMgr          模型管理器（启动早期可能为 null）
 * @param {object} ctx.MODELS_PRESETS          内置 provider 预设
 * @param {object} ctx.MODELS_OLLAMA_PRESET    Ollama 预设
 * @param {Function} ctx.notify
 * @param {Function} ctx.t
 * @param {Function} ctx.lang
 * @param {Function} ctx.log
 */
function registerModelsIpc(ipcMain, ctx) {
  const { modelsMgr, MODELS_PRESETS, MODELS_OLLAMA_PRESET, notify, t, lang, log } = ctx;

  ipcMain.handle('shell:models-list', () => (modelsMgr ? modelsMgr.list() : {
    presets: MODELS_PRESETS, ollamaPreset: MODELS_OLLAMA_PRESET, profiles: [], default: null,
  }));
  ipcMain.handle('shell:models-save', (_e, profile, apiKey) => {
    if (!modelsMgr) return { ok: false, reason: 'not ready' };
    try {
      const r = modelsMgr.save(profile, apiKey);
      return r;
    } catch (e) {
      log(`[models] save failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:models-remove', (_e, id) => {
    if (!modelsMgr) return { ok: false, reason: 'not ready' };
    try {
      const r = modelsMgr.remove(String(id || ''));
      if (r.ok) {
        notify(t(lang(), 'notify.modelsRemoved'), t(lang(), 'notify.modelsRemovedBody', { id: String(id || '') }));
      }
      return r;
    } catch (e) {
      log(`[models] remove failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:models-test', async (_e, target) => {
    // 注意 kind：测试结果卡需要它来分类展示，缺了会渲染成"未知类型"
    if (!modelsMgr) return { ok: false, kind: 'other', reason: 'not ready' };
    return modelsMgr.test(target || {});
  });
  ipcMain.handle('shell:ollama-status', async () => {
    // 注意：这不是 {ok:...} 形状，是 Ollama 卡片的专用结构
    if (!modelsMgr) return { installed: false, version: null, models: [], registered: false, reason: 'not ready' };
    return modelsMgr.ollamaStatus();
  });
  ipcMain.handle('shell:models-set-default', (_e, provider, model) => {
    if (!modelsMgr) return { ok: false, reason: 'not ready' };
    const r = modelsMgr.setDefault(provider, model);
    if (r.ok) {
      notify(t(lang(), 'notify.modelsDefaultSet'), t(lang(), 'notify.modelsDefaultSetBody', {
        provider: String(provider || ''), model: String(model || ''),
      }));
    }
    return r;
  });
}

module.exports = { registerModelsIpc };
