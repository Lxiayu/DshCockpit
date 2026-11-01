// src/ipc-skills.js — Skills 域的 IPC 注册与操作编排（Issue #22 Phase 1）。
//
// 第一性原理：为什么 shell:* 不能"按前缀批量搬"，而要按**域**搬
//
//   shell:* 有 74 个 handler，看起来像个整体，实际是 20+ 个互不相关的业务域
//   被同一个前缀拴在一起（skills / scheduled / models / channels / memory /
//   compact / public-remote / storage / balance / backup / runtime …）。
//
//   按前缀批量搬的后果：要么搬不动（域间共享辅助函数），要么搬出一个新的
//   巨型文件（把 74 个 handler 挪到另一个 3000 行文件，问题一点没解决）。
//
//   正确的粒度是**域**：一个域的 handler + 它**专用的**辅助函数一起走，
//   与其它域共用的东西通过 ctx 注入。
//
//   选 skills 作为第一批，因为：
//     1. 6 个 handler + 4 个专用辅助函数，边界清楚
//     2. 有独立的 skillsMgr / skillsGuard，不碰窗口/广播/生命周期
//     3. 唯一的跨域依赖是 fetchMarketData（与 plugins 共用）→ 可注入
//
// 第二性原理：为什么 skillsAction 也要搬
//
//   它看起来像"main.js 的私有函数"，实际是 skills 域的核心编排逻辑
//   （串行化守卫、结果码→i18n 映射、bundle-plugin 委派、通知）。
//   留在 main.js 意味着"域逻辑"和"域 IPC"被切成两半，下次改技能安装流程
//   还是得动 main.js —— 那就没有真正解耦。
'use strict';

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {object} ctx.skillsMgr        技能管理器（listInstalled/preview/install/remove/upgrade/importLocal）
 * @param {object} ctx.skillsGuard      串行化守卫（tryBegin/release）
 * @param {Function} ctx.fetchMarketData 精选市场数据（与 plugins 域共用 → 注入）
 * @param {Function} ctx.fetchStarMap    GitHub star 数（装饰性，失败返回 {}）
 * @param {Function} ctx.buildSkillsMarketPayload 市场载荷组装（来自 ./skills）
 * @param {Function} ctx.pluginAction   插件操作（用于 bundle-plugin 型技能包委派）
 * @param {Function} ctx.notify         系统通知
 * @param {Function} ctx.t              i18n 翻译
 * @param {Function} ctx.lang           当前语言
 * @param {Function} ctx.log
 */
function registerSkillsIpc(ipcMain, ctx) {
  const {
    skillsMgr, skillsGuard,
    fetchMarketData, fetchStarMap, buildSkillsMarketPayload,
    pluginAction, notify, t, lang, log,
  } = ctx;

  /** skills.js 的错误码是 kebab-case（'plugin-form'），i18n key 是 camelCase
   * （skills.pluginForm）—— 这里搭桥。 */
  function skillsCodeKey(code) {
    return String(code || '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  function skillsErrorReason(errors) {
    return (Array.isArray(errors) ? errors : [])
      .map((e) => t(lang(), `skills.${e.code}`, e.params || {}))
      .join('；');
  }

  /**
   * 串行化技能操作（install/upgrade/remove/import/preview）。
   *
   * 技能是纯文件——不重启 runtime；dsh 通过它的 skills watcher 拾取，
   * 对新会话生效。bundle-plugin 型技能包（package.json + dsh bundle）
   * 委派给插件流水线（那里需要重启才生效）。
   */
  async function skillsAction(op, arg, pick) {
    if (!skillsGuard.tryBegin(op, String(arg || ''))) {
      return { ok: false, code: 'busy', reason: t(lang(), 'skills.busy') };
    }
    try {
      let r;
      if (op === 'preview') r = await skillsMgr.preview(String(arg || ''));
      else if (op === 'install') r = await skillsMgr.install(String(arg || ''), pick === undefined ? null : pick);
      else if (op === 'remove') r = skillsMgr.remove(String(arg || ''));
      else if (op === 'upgrade') r = await skillsMgr.upgrade(String(arg || ''));
      else if (op === 'import') r = await skillsMgr.importLocal(String(arg || ''));
      else r = { ok: false, code: 'invalid', reason: 'unknown op' };

      // bundle-plugin skill packs live in the plugin pipeline (restart applies)
      if (!r.ok && r.code === 'plugin-form' && op === 'install') {
        log(`[skills] ${arg} is a bundle-plugin skill pack; delegating to plugin install`);
        const pr = await pluginAction('add', String(arg));
        return { ...pr, delegated: 'plugin' };
      }

      if (!r.ok && Array.isArray(r.errors) && !r.reason) {
        r.reason = skillsErrorReason(r.errors) || t(lang(), `skills.${skillsCodeKey(r.code) || 'e1'}`);
      } else if (!r.ok && !r.reason && r.code) {
        const key = `skills.${skillsCodeKey(r.code)}`;
        const text = t(lang(), key);
        r.reason = text !== key ? text : r.code;
      }

      if (r.ok && op === 'remove') {
        notify(t(lang(), 'skills.removed'), t(lang(), 'skills.removedBody', { name: String(arg) }));
        log(`[skills] removed ${arg}`);
      } else if (r.ok && op !== 'preview') {
        const names = (r.installed || []).map((i) => i.name).join(', ') || String(arg);
        const warnings = (r.installed || []).flatMap((i) => i.warnings || []);
        const body = t(lang(), 'skills.installedBody', { name: names })
          + (warnings.length ? `\n${warnings.map((w) => t(lang(), `skills.${w.code}`, w.params || {})).join('\n')}` : '');
        notify(t(lang(), 'skills.installed'), body);
        log(`[skills] ${op} ok: ${names}`);
      } else if (!r.ok && r.code !== 'multi' && r.code !== 'busy' && op !== 'preview') {
        notify(t(lang(), 'skills.failed'), t(lang(), 'skills.failedBody', { name: String(arg), reason: r.reason || r.code }));
        log(`[skills] ${op} ${arg} failed (${r.code}): ${r.reason || ''}`);
      }
      return r;
    } finally {
      skillsGuard.release();
    }
  }

  ipcMain.handle('shell:skills-list', async (_e, force) => {
    try {
      const installed = skillsMgr.listInstalled();
      const { source, entries, fetchedAt } = await fetchMarketData(Boolean(force));
      const starMap = await fetchStarMap();
      const repos = new Set(installed.filter((s) => s.repo).map((s) => s.repo));
      return { ok: true, source, fetchedAt, installed, ...buildSkillsMarketPayload(entries, starMap, repos) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:skills-preview', (_e, fullName) => skillsAction('preview', fullName));
  ipcMain.handle('shell:skills-install', (_e, fullName, pick) => skillsAction('install', fullName, pick));
  ipcMain.handle('shell:skills-remove', (_e, name) => skillsAction('remove', name));
  ipcMain.handle('shell:skills-upgrade', (_e, name) => skillsAction('upgrade', name));
  ipcMain.handle('shell:skills-import', (_e, dir, pick) => skillsAction('import', dir, pick));
}

module.exports = { registerSkillsIpc };
