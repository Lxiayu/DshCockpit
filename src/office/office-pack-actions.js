// src/office/office-pack-actions.js — 角色包的 IPC action 校验与分派（Issue #24）。
//
// 第一性原理：为什么这层要独立成文件，而不是塞在 office-module.js 里
//
//   office-module.js 有 4800 行硬上限（test/office-runtime-boundary.test.js）。
//   我第一版把 8 个 pack action 的校验和分派直接写进去，结果 4806 行 —— **超限**。
//   门禁的信息很明确：「超限 = 需要拆分而不是继续堆」（first-principles P1）。
//
//   而且拆分本身是对的：角色包能力有三块清晰边界
//     · payload 校验（本文件）—— IPC 传输契约
//     · 分派（本文件）—— action → manager 方法
//     · 业务不变量（character-pack-manager.js）—— 安装/激活/卸载语义
//   office-module 只需要在 office:settings 的 switch 里转一次手。
//
// 设计约束（与 office-module 一致）
//
//   · **不碰文件系统**：所有磁盘操作在注入的 packManager 里。
//   · **白名单校验**：只允许列出的 key，多余的 key 一律 PAYLOAD_INVALID。
//   · **base64 转换只在这一层**：manager 只接受 Buffer，不该知道传输编码。
'use strict';

/** 单个路径字段的长度上限（防止超大字符串进 IPC）。 */
const MAX_PATH_LENGTH = 4096;
/** packId / importId 的长度上限。 */
const MAX_ID_LENGTH = 128;

/**
 * 校验 office:settings 里 pack 相关 action 的 payload。
 *
 * @param {object} payload 已确认是 plain object 且大小合规
 * @param {string[]} keys payload 的 key 列表
 * @param {number} maxPayloadBytes IPC 载荷上限（用于 base64 长度约束）
 * @returns {{ok:true, value:object} | {ok:false, code:string}}
 */
function validatePackAction(payload, keys, maxPayloadBytes) {
  if (payload.action === 'packsList' && keys.length === 1) {
    return { ok: true, value: { action: 'packsList' } };
  }
  if (payload.action === 'packImportFolder'
    && keys.length === 2 && typeof payload.folderPath === 'string'
    && payload.folderPath !== '' && payload.folderPath.length <= MAX_PATH_LENGTH) {
    return { ok: true, value: { action: 'packImportFolder', folderPath: payload.folderPath } };
  }
  if (payload.action === 'packImportZip'
    && keys.length === 2 && typeof payload.zipBase64 === 'string'
    && payload.zipBase64 !== '' && payload.zipBase64.length <= maxPayloadBytes) {
    return { ok: true, value: { action: 'packImportZip', zipBase64: payload.zipBase64 } };
  }
  if ((payload.action === 'packCommitImport' || payload.action === 'packCancelImport')
    && keys.length === 2 && typeof payload.importId === 'string'
    && payload.importId !== '' && payload.importId.length <= MAX_ID_LENGTH) {
    return { ok: true, value: { action: payload.action, importId: payload.importId } };
  }
  if (payload.action === 'packSelect'
    && keys.length === 2 && typeof payload.packId === 'string'
    && payload.packId !== '' && payload.packId.length <= MAX_ID_LENGTH) {
    return { ok: true, value: { action: 'packSelect', packId: payload.packId } };
  }
  if (payload.action === 'packUninstall'
    && keys.length === 2 && typeof payload.packId === 'string'
    && payload.packId !== '' && payload.packId.length <= MAX_ID_LENGTH) {
    return { ok: true, value: { action: 'packUninstall', packId: payload.packId } };
  }
  return { ok: false, code: 'PAYLOAD_INVALID' };
}

/** 这个 action 是不是 pack 相关的（用于 office-module 的快速分派）。 */
function isPackAction(action) {
  return typeof action === 'string' && (
    action === 'packsList'
    || action === 'packImportFolder'
    || action === 'packImportZip'
    || action === 'packCommitImport'
    || action === 'packCancelImport'
    || action === 'packSelect'
    || action === 'packUninstall'
  );
}

/**
 * 执行一个已校验的 pack action。
 *
 * 未注入 packManager 时如实报 `OFFICE_PACKS_UNAVAILABLE`——
 * 不返回 ok:true 让 UI 以为成功。
 */
function runPackAction(value, packManager) {
  if (!packManager) return { ok: false, code: 'OFFICE_PACKS_UNAVAILABLE' };
  switch (value.action) {
    case 'packsList':
      return { ok: true, packs: packManager.listPacks() };
    case 'packImportFolder':
      return packManager.beginImport({ folderPath: value.folderPath });
    case 'packImportZip': {
      // base64 → Buffer 在**这一层**转换：manager 只接受 Buffer。
      let buf;
      try {
        buf = Buffer.from(value.zipBase64, 'base64');
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'PACK_LOAD_FAILED',
            title: '包无法解析',
            hint: '文件可能已损坏，请重新获取。',
            detail: String(error && error.message),
          },
        };
      }
      return packManager.beginImport({ zipBuffer: buf });
    }
    case 'packCommitImport':
      return packManager.commitImport({ importId: value.importId });
    case 'packCancelImport':
      return packManager.cancelImport(value.importId);
    case 'packSelect':
      return packManager.selectPack(value.packId);
    case 'packUninstall':
      return packManager.uninstallPack(value.packId);
    default:
      return { ok: false, code: 'PAYLOAD_INVALID' };
  }
}

module.exports = {
  MAX_PATH_LENGTH,
  MAX_ID_LENGTH,
  validatePackAction,
  isPackAction,
  runPackAction,
};
