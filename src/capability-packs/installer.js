// src/capability-packs/installer.js — Capability Pack 的安装/卸载/健康检查（P3 S3）。
//
// 第一性原理：安装到底是什么
//
//   大多数"插件系统"的安装 = 复制文件到系统目录。于是卸载要逐个删，
//   一旦漏一个就留下残骸，而且"无残留"无法验证。
//
//   Capability Pack 不同：它**没有需要复制的文件**——包本身就是一份
//   manifest（声明）+ 一个 verify（证明）。所以：
//
//     安装 = 校验 manifest + 检查平台/依赖 + 写一条安装记录 + 跑一次 verify
//     卸载 = 删掉那条记录
//
//   这样"卸载无残留"是**可验证的**：记录删了，目录空了，就是无残留。
//   不需要"猜哪些文件是装的"。
//
// 第二性原理：为什么安装记录是 JSON 而不是散落的标记文件
//
//   一条记录里包含：装了什么、什么时候、verify 当时的结果。
//   这是"用户装的东西现在还好吗"的唯一信息源。
//   散落标记文件做不到这件事，且清理时容易漏。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateManifest, platformSupport } = require('./manifest');
const { runVerify } = require('./verify');

/** 安装记录的 schema 版本。 */
const RECORD_SCHEMA_VERSION = 1;

/** 记录文件名（放在数据目录根）。 */
const RECORD_FILE = 'installed.json';

function emptyRecord() {
  return { schemaVersion: RECORD_SCHEMA_VERSION, packs: {} };
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir   可写目录（通常 userData/capability-packs）
 * @param {object} opts.runner    command-runner 实例
 * @param {string} [opts.platform]
 * @param {Function} [opts.log]
 */
function createCapabilityInstaller(opts = {}) {
  const { dataDir, runner, platform = process.platform, log = () => {} } = opts;
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createCapabilityInstaller requires dataDir');
  }

  const recordPath = path.join(dataDir, RECORD_FILE);

  function readRecord() {
    try {
      const raw = fs.readFileSync(recordPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.packs || typeof parsed.packs !== 'object') {
        return emptyRecord();
      }
      return { schemaVersion: RECORD_SCHEMA_VERSION, packs: { ...parsed.packs } };
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyRecord();
      // 记录损坏：不静默重建（那会丢用户数据），而是报错让调用方决定
      log(`[packs] install record is unreadable: ${error && error.message}`);
      return { ...emptyRecord(), corrupt: true };
    }
  }

  function writeRecord(record) {
    fs.mkdirSync(dataDir, { recursive: true });
    // 原子写：先写临时文件再 rename，避免半写状态
    const tmp = `${recordPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, recordPath);
  }

  /**
   * 安装一个 Pack。
   *
   * 幂等：同 id 同版本重复安装返回 already-installed（不报错、不改记录）。
   * 同 id 不同版本视为升级（覆盖记录）。
   *
   * @returns {Promise<{ok:boolean, code?:string, reason?:string, verify?:object}>}
   */
  async function install(rawManifest) {
    const validated = validateManifest(rawManifest);
    if (!validated.ok) {
      return { ok: false, code: 'MANIFEST_INVALID', reason: validated.errors.join('; ') };
    }
    const manifest = validated.value;

    // ---- 平台检查：明确拒绝，不是崩溃 ----
    const support = platformSupport(manifest, platform);
    if (!support.supported) {
      return { ok: false, code: 'PLATFORM_UNSUPPORTED', reason: support.reason };
    }

    const record = readRecord();
    if (record.corrupt) {
      return { ok: false, code: 'RECORD_CORRUPT', reason: 'install record is unreadable; refusing to overwrite it' };
    }
    const existing = record.packs[manifest.id];
    if (existing && existing.version === manifest.version) {
      // 幂等：重复安装不报错
      return { ok: true, code: 'ALREADY_INSTALLED', verify: existing.verify || null };
    }

    // ---- 跑一次 verify：装完立刻知道能不能用 ----
    const verify = await runVerify(manifest, { runner, platform });
    if (verify.state === 'skipped' || verify.state === 'not-verified') {
      // 不能安装一个"验证不了"的包——那等于装了个不知道能不能用的东西
      return { ok: false, code: 'VERIFY_NOT_POSSIBLE', reason: verify.reason, verify };
    }
    if (verify.state === 'failed') {
      return { ok: false, code: 'VERIFY_FAILED', reason: verify.reason, verify };
    }

    record.packs[manifest.id] = {
      id: manifest.id,
      version: manifest.version,
      title: manifest.title,
      installedAtMs: Date.now(),
      // 记录安装时的验证结果——这是"现在还好吗"的基线
      verify: { state: verify.state, atMs: Date.now() },
    };
    writeRecord(record);
    log(`[packs] installed ${manifest.id}@${manifest.version}`);
    return { ok: true, code: 'INSTALLED', verify };
  }

  /**
   * 卸载一个 Pack。
   *
   * 幂等：未安装时返回 not-installed（不报错）。
   * 由于安装不复制文件，卸载 = 删记录，所以"无残留"可验证。
   */
  function uninstall(id) {
    const record = readRecord();
    if (record.corrupt) {
      return { ok: false, code: 'RECORD_CORRUPT', reason: 'install record is unreadable' };
    }
    if (!record.packs[id]) {
      return { ok: true, code: 'NOT_INSTALLED' };
    }
    delete record.packs[id];
    writeRecord(record);
    log(`[packs] uninstalled ${id}`);
    return { ok: true, code: 'UNINSTALLED' };
  }

  /** 列出已安装的 Pack。 */
  function list() {
    const record = readRecord();
    if (record.corrupt) return { ok: false, code: 'RECORD_CORRUPT', packs: [] };
    return { ok: true, packs: Object.values(record.packs) };
  }

  /**
   * 健康检查：对每个已安装的 Pack 重跑 verify。
   *
   * 这是"用户装的东西现在还好吗"的答案。官方能力变化、
   * 依赖命令被卸载、工作区被移动，都会在这里显形。
   */
  async function healthCheck(manifestsById = {}) {
    const record = readRecord();
    if (record.corrupt) return { ok: false, code: 'RECORD_CORRUPT', results: [] };
    const results = [];
    for (const entry of Object.values(record.packs)) {
      const manifest = manifestsById[entry.id];
      if (!manifest) {
        results.push({ id: entry.id, state: 'not-verified', reason: 'manifest not available' });
        continue;
      }
      const verify = await runVerify(manifest, { runner, platform });
      results.push({ id: entry.id, version: entry.version, state: verify.state, reason: verify.reason });
    }
    return { ok: true, results };
  }

  /**
   * 确认卸载后无残留：记录里没有它，目录里也没有它的痕迹。
   * 因为安装不复制文件，这里只需检查记录。
   */
  function assertClean(id) {
    const record = readRecord();
    if (record.corrupt) return { clean: false, reason: 'install record is unreadable' };
    if (record.packs[id]) return { clean: false, reason: `${id} is still recorded as installed` };
    return { clean: true, reason: null };
  }

  return { install, uninstall, list, healthCheck, assertClean, recordPath };
}

module.exports = { RECORD_SCHEMA_VERSION, RECORD_FILE, createCapabilityInstaller };
