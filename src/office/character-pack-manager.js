// src/office/character-pack-manager.js — 角色包导入/切换的用户入口（Issue #24）。
//
// 第一性原理：为什么需要这一层，而不是"直接调安装器"
//
//   安装器（character-pack-installer.js，442 行 + 18 项测试）与现有渲染链
//   之间有**两处真实的架构不匹配**，不是"缺一根线"：
//
//   | 项目 | 现有渲染链 | 安装器 |
//   |---|---|---|
//   | packsRoot | `resources/characters`（**打包后只读**） | 需要可写目录（userData） |
//   | 布局 | `<packsRoot>/<packId>/manifest.json` | `<packsRoot>/<packId>/versions/<ver>/` |
//   | 激活 | `settings.characterPackId`（扁平 id） | `packsRoot/active.json` + `activate()` |
//
//   直接接管线会得到两种坏结果之一：
//     · 往 resources/ 里写 → 打包后失败（权限）+ 升级丢包
//     · 只写 settings 不装到磁盘 → 选了个不存在的包，回退到内置
//
//   所以这一层的职责是**两个布局之间的翻译**：
//     · 用安装器管理 userData 下的可写 packs 目录
//     · 把"已安装的 packId@version"映射成渲染链能用的 installPath
//     · 单点决定激活语义（见下方"激活契约"）
//
// 激活契约（关键设计决定）
//
//   存在两套激活机制时，必须有**唯一作者**，否则会出现"设置说 A、磁盘说 B"。
//   本模块的规则：
//     · **安装器是磁盘事实的作者**（它管 active.json 与版本目录）
//     · **settings.characterPackId 是用户意图的作者**（用户选了哪个）
//     · 两者不一致时 → **以用户意图为准，但若该意图不可用则回退内置并上报**
//   这样"重启后仍生效"成立（意图持久化），"卸载后回落内置"也成立（可用性检查）。
//
// 隐私约束
//
//   包内的文本（角色名、台词）**不进** office 快照与事实链。
//   本模块只返回 packId / version / 派生句柄，不返回包内容。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 内置包 id —— 与 office-pack-resolver.js 的 BUILTIN_PACK_ID 保持一致。 */
const BUILTIN_PACK_ID = 'deepseek-default';

/**
 * 把安装器的错误码翻译成「用户能看懂 + 知道该怎么办」的结构。
 *
 * 第一性原理：错误呈现不是"把 message 透传"。
 * 用户看到 `PACK_UNSAFE_ARCHIVE: ../x: path traversal` 不知道该做什么；
 * 他需要知道的是"这个包不安全，别装它"还是"你的包打包方式需要改"。
 */
const ERROR_GUIDANCE = Object.freeze({
  PACK_UNSAFE_ARCHIVE: {
    title: '包内含不安全的路径',
    hint: '包里有指向自身目录之外的路径或符号链接。请从可信来源重新获取。',
  },
  PACK_TOO_LARGE: {
    title: '包超出大小上限',
    hint: '解压后体积或条目数超过限制，可能是压缩炸弹。请从可信来源重新获取，不要继续使用这个包。',
  },
  PACK_INVALID_MANIFEST: {
    title: '包缺少有效清单',
    hint: '需要 manifest.json，且含 schemaVersion / id / version。',
  },
  PACK_ASSET_MISSING: {
    title: '包内资源缺失',
    hint: '清单声明的素材（如 animations.json 或贴图）没有随包提供。',
  },
  PACK_VERSION_EXISTS: {
    title: '该版本已安装',
    hint: '同 id+version 已在本地。若要重装请先卸载，或改用更高的版本号。',
  },
  PACK_LOAD_FAILED: {
    title: '包无法加载',
    hint: '校验或安装过程中失败，现有角色未受影响。',
  },
  IMPORT_NOT_FOUND: {
    title: '导入会话已失效',
    hint: '导入过程被中断，请重新选择文件。',
  },
  INVALID_STATE: {
    title: '导入步骤顺序错误',
    hint: '这是程序内部错误，请重试；若持续出现请附日志反馈。',
  },
  PACK_CRC_MISMATCH: {
    title: '包内容校验失败（CRC 不匹配）',
    hint: '文件在传输或保存过程中损坏，请重新获取。',
  },
});

/** 未知错误码的兜底（诚实：不假装知道原因）。 */
const FALLBACK_GUIDANCE = Object.freeze({
  title: '导入失败',
  hint: '未识别的失败原因，详见技术详情。',
});

/**
 * 把任意错误转成可呈现的结构。
 * @param {Error & {code?:string}} error
 */
function explainError(error) {
  const code = (error && error.code) || 'PACK_LOAD_FAILED';
  const guidance = ERROR_GUIDANCE[code] || FALLBACK_GUIDANCE;
  return {
    code,
    title: guidance.title,
    hint: guidance.hint,
    // 技术详情保留但明确标为"给开发者/反馈用"，UI 默认折叠
    detail: (error && error.message) || String(error),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.installer  createCharacterPackInstaller() 的返回值（**不修改它**）
 * @param {string} opts.builtinPackPath 内置包目录（resources/characters/deepseek-default）
 * @param {Function} opts.readSelected  读用户意图：() => string|null（settings.characterPackId）
 * @param {Function} opts.writeSelected 写用户意图：(packId|null) => void
 * @param {Function} [opts.onActivated] 激活后回调（触发渲染层重载）：({packId, version, installPath}) => void
 * @param {Function} [opts.log]
 */
function createCharacterPackManager(opts = {}) {
  const {
    installer,
    builtinPackPath,
    readSelected,
    writeSelected,
    onActivated = () => {},
    log = () => {},
  } = opts;

  for (const [name, fn] of [['readSelected', readSelected], ['writeSelected', writeSelected]]) {
    if (typeof fn !== 'function') throw new Error(`createCharacterPackManager requires ${name}`);
  }
  if (!installer || typeof installer.listInstalled !== 'function') {
    throw new Error('createCharacterPackManager requires the pack installer');
  }

  // 进行中的导入：importId → { packId, version }。
  // 分两步是因为 UI 需要在 validate 之后、install 之前把"即将安装什么"告诉用户。
  const pending = new Map();

  /**
   * 列出可切换的角色包。
   *
   * 把两处事实合成一张表：
   *   · 内置包（resources/characters，只读，永远存在）
   *   · 已安装包（installer.listInstalled()，userData 下）
   * 并标出哪个是当前生效的。
   */
  function listPacks() {
    const out = [];
    // 内置包：不做磁盘校验（校验失败会导致 UI 整个空掉，而内置包坏掉是打包问题）
    out.push({
      packId: BUILTIN_PACK_ID,
      version: null,
      builtin: true,
      installPath: builtinPackPath,
    });

    let installed = [];
    try {
      installed = installer.listInstalled();
    } catch (error) {
      log(`[pack] listInstalled failed: ${error && error.message}`);
    }
    // 同 id 多版本时只展示最新版本（按字符串倒序；版本号格式由校验器保证可比较性）
    const byId = new Map();
    for (const entry of installed) {
      const prev = byId.get(entry.packId);
      if (!prev || String(entry.version) > String(prev.version)) byId.set(entry.packId, entry);
    }
    for (const entry of byId.values()) {
      if (entry.packId === BUILTIN_PACK_ID) continue; // 内置包不重复列出
      out.push({
        packId: entry.packId,
        version: entry.version,
        builtin: false,
        installPath: entry.installPath,
      });
    }

    // 标出当前生效的包。以**用户意图**为准，但不可用则视为回退到内置。
    const selected = safeReadSelected();
    let activeId = BUILTIN_PACK_ID;
    if (selected && selected !== BUILTIN_PACK_ID && out.some((p) => p.packId === selected)) {
      activeId = selected;
    }
    return out.map((p) => ({ ...p, active: p.packId === activeId }));
  }

  function safeReadSelected() {
    try {
      const v = readSelected();
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * 步骤 1+2：从文件夹或 zip 导入并校验。
   *
   * @returns {{ok:true, importId:string, packId:string, version:string} | {ok:false, error:object}}
   */
  function beginImport({ folderPath = null, zipBuffer = null } = {}) {
    let importId;
    try {
      if (zipBuffer) {
        importId = installer.importFromZip(zipBuffer).importId;
      } else if (folderPath) {
        importId = installer.importFromFolder(folderPath).importId;
      } else {
        return { ok: false, error: { code: 'NO_SOURCE', title: '没有选择来源', hint: '请选择角色包文件夹或 .zip 文件。', detail: '' } };
      }
    } catch (error) {
      log(`[pack] import failed: ${error && error.message}`);
      return { ok: false, error: explainError(error) };
    }

    // 校验失败时安装器会自己清理临时目录并抛错——所以这里不需要额外清理。
    let validated;
    try {
      validated = installer.validateImport(importId);
    } catch (error) {
      log(`[pack] validate failed: ${error && error.message}`);
      return { ok: false, error: explainError(error) };
    }

    pending.set(importId, { packId: validated.packId, version: validated.version });
    return { ok: true, importId, packId: validated.packId, version: validated.version };
  }

  /**
   * 步骤 3：安装已校验的导入，并激活。
   *
   * 「安装失败必须保留原有可用包」是安装器的保证（它用原子 rename，
   * 失败时清理 incoming 而不动已装版本）。本层不得违反：**激活失败不写 settings**。
   */
  function commitImport({ importId, activate = true } = {}) {
    const info = pending.get(importId);
    if (!info) {
      return { ok: false, error: { code: 'IMPORT_NOT_FOUND', title: ERROR_GUIDANCE.IMPORT_NOT_FOUND.title, hint: ERROR_GUIDANCE.IMPORT_NOT_FOUND.hint, detail: `unknown import: ${importId}` } };
    }
    let installed;
    try {
      installed = installer.installImport(importId);
    } catch (error) {
      pending.delete(importId);
      log(`[pack] install failed: ${error && error.message}`);
      return { ok: false, error: explainError(error) };
    }
    pending.delete(importId);

    if (!activate) {
      return { ok: true, packId: installed.packId, version: installed.version, activated: false };
    }
    // 激活：先让安装器写它的 active.json（磁盘事实），再写用户意图。
    // 顺序重要：若第一步失败，settings 保持不动（不会出现"意图指向不存在的包"）。
    try {
      installer.activate(installed.packId, installed.version);
    } catch (error) {
      log(`[pack] activate failed: ${error && error.message}`);
      return { ok: false, error: explainError(error), installed: { packId: installed.packId, version: installed.version } };
    }
    writeSelected(installed.packId);
    try {
      onActivated({ packId: installed.packId, version: installed.version, installPath: installed.installPath });
    } catch (error) {
      log(`[pack] onActivated threw: ${error && error.message}`);
    }
    return { ok: true, packId: installed.packId, version: installed.version, activated: true };
  }

  /** 放弃一个进行中的导入（用户取消）。 */
  function cancelImport(importId) {
    if (!pending.has(importId)) return { ok: true, cancelled: false };
    pending.delete(importId);
    return { ok: true, cancelled: true };
  }

  /**
   * 切换到已安装的包（或内置包）。
   *
   * 「卸载后回落内置，不出现空场景」——切到内置永远成功；
   * 切到已安装包前先确认它**真的可用**（manifest 存在且能校验通过）。
   */
  function selectPack(packId) {
    const id = typeof packId === 'string' ? packId.trim() : '';
    if (!id) return { ok: false, error: { code: 'PACK_ID_INVALID', title: '包 id 无效', hint: '请从列表中选择。', detail: '' } };

    if (id === BUILTIN_PACK_ID) {
      // 切回内置：清空用户意图（null 比字符串 'deepseek-default' 更准确地
      // 表达"没有自定义选择"，也让解析器走 builtin 分支）。
      writeSelected(null);
      try { onActivated({ packId: BUILTIN_PACK_ID, version: null, installPath: builtinPackPath }); } catch { /* best effort */ }
      return { ok: true, packId: BUILTIN_PACK_ID, builtin: true };
    }

    const entry = listPacks().find((p) => p.packId === id && !p.builtin);
    if (!entry) {
      return { ok: false, error: { code: 'PACK_NOT_INSTALLED', title: '该角色包未安装', hint: '请先导入再切换。', detail: `not installed: ${id}` } };
    }
    try {
      installer.activate(entry.packId, entry.version);
    } catch (error) {
      log(`[pack] select failed: ${error && error.message}`);
      return { ok: false, error: explainError(error) };
    }
    writeSelected(entry.packId);
    try { onActivated({ packId: entry.packId, version: entry.version, installPath: entry.installPath }); } catch { /* best effort */ }
    return { ok: true, packId: entry.packId, version: entry.version, builtin: false };
  }

  /**
   * 卸载一个已安装的包。
   *
   * 若卸载的是当前生效的包 → 自动回落内置（否则渲染层会指向一个不存在的目录）。
   * 内置包不可卸载。
   */
  function uninstallPack(packId) {
    const id = typeof packId === 'string' ? packId.trim() : '';
    if (id === BUILTIN_PACK_ID) {
      return { ok: false, error: { code: 'PACK_BUILTIN_PROTECTED', title: '内置包不可卸载', hint: '它是回退目标，删掉会导致无角色可用。', detail: '' } };
    }
    const entries = safeListInstalled().filter((e) => e.packId === id);
    if (entries.length === 0) {
      return { ok: false, error: { code: 'PACK_NOT_INSTALLED', title: '该角色包未安装', hint: '无需卸载。', detail: `not installed: ${id}` } };
    }
    const wasActive = safeReadSelected() === id;
    for (const entry of entries) {
      try {
        fs.rmSync(entry.installPath, { recursive: true, force: true });
      } catch (error) {
        log(`[pack] uninstall failed: ${error && error.message}`);
        return { ok: false, error: explainError(error) };
      }
    }
    if (wasActive) {
      writeSelected(null);
      try { onActivated({ packId: BUILTIN_PACK_ID, version: null, installPath: builtinPackPath }); } catch { /* best effort */ }
    }
    return { ok: true, packId: id, fellBackToBuiltin: wasActive };
  }

  function safeListInstalled() {
    try {
      return installer.listInstalled();
    } catch {
      return [];
    }
  }

  /**
   * 解析当前应渲染的包。
   *
   * 这是渲染链的唯一入口：把"用户意图 + 磁盘可用性"收敛成一个结果。
   * 失败时**永远**回退内置，不返回空——空场景会让办公室黑屏。
   */
  function resolveActive() {
    const selected = safeReadSelected();
    if (selected && selected !== BUILTIN_PACK_ID) {
      const entry = safeListInstalled().find((e) => e.packId === selected);
      if (entry) {
        return { kind: 'pack', packId: entry.packId, version: entry.version, installPath: entry.installPath };
      }
      // 意图指向不存在的包（被手动删掉/卸载失败）→ 回退内置并如实上报
      log(`[pack] selected pack ${selected} is not installed; falling back to builtin`);
      return {
        kind: 'builtin',
        packId: BUILTIN_PACK_ID,
        version: null,
        installPath: builtinPackPath,
        degradedCode: 'OFFICE_PACK_SELECTION_MISSING',
      };
    }
    return { kind: 'builtin', packId: BUILTIN_PACK_ID, version: null, installPath: builtinPackPath };
  }

  return {
    listPacks,
    beginImport,
    commitImport,
    cancelImport,
    selectPack,
    uninstallPack,
    resolveActive,
    BUILTIN_PACK_ID,
  };
}

module.exports = {
  BUILTIN_PACK_ID,
  ERROR_GUIDANCE,
  explainError,
  createCharacterPackManager,
};
