'use strict';

// src/settings-persistence.js — Settings 数据保护（Issue #19）。
//
// 第一性原理：为什么不能"等以后用 SQLite 再统一处理"
//
//   用户明确要求：「先保护现有数据，不要因为计划使用 SQLite，就一次性迁移
//   全部旧设置。」这是对的，因为现有实现有三个会**静默毁数据**的缺陷：
//
//     1. 没有 schemaVersion —— 无法判断文件是哪个版本写的，也就无法迁移
//     2. 损坏时 `catch {}` 静默回落默认值 —— 用户丢 53 个设置而毫不知情，
//        且下一次 save() 会直接覆盖原文件，**原数据永久消失**
//     3. 没有 .bak —— 就算发现坏了也没有回退点
//
//   本模块只做"保护"，不做"迁移到新存储"：
//     - 读：分层回退 主文件 → .bak → .bak.1 → .bak.2，每一层都记录来源
//     - 写：写入前把当前有效文件轮转为 .bak 链（保留 3 份）
//     - 损：解析失败时把损坏文件**另存**为 .corrupt-<ts>，绝不覆盖
//     - 报：所有降级/损坏都有明确的 status 对象，供 UI 如实告知用户
//
//   刻意**不**碰 `data` 的形状 —— 保存与迁移是两件事，混在一起会让回滚变难。
//   SettingsStore 继续负责数据语义（DEFAULTS / patch 白名单 / V41 迁移），
//   本模块只负责"文件怎么安全地读写"。这是职责分离，不是新抽象层：
//   它只服务 settings 一个调用方，没有第二个实现，因此不做接口抽象。

const fs = require('node:fs');
const path = require('node:path');

/** 当前 settings 文件格式版本。字段含义变化时才 +1，并在 migrate() 里补转换。 */
const SETTINGS_SCHEMA_VERSION = 1;

/** 保留几份历史备份（.bak / .bak.1 / .bak.2）。 */
const BACKUP_DEPTH = 3;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 原子写：临时文件 + rename。使用**唯一**临时名，避免两次并发写互踩
 * （TD-11 里 3 处固定 .tmp 的真问题）。
 */
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/** 把当前文件轮转到 .bak 链：x → x.bak, x.bak → x.bak.1, ... */
function rotateBackups(file) {
  for (let i = BACKUP_DEPTH - 1; i >= 0; i -= 1) {
    const from = i === 0 ? file : `${file}.bak${i === 1 ? '' : `.${i - 1}`}`;
    const to = i === 0 ? `${file}.bak` : `${file}.bak${i === 1 ? '.1' : `.${i}`}`;
    if (!fs.existsSync(from)) continue;
    try { fs.copyFileSync(from, to); } catch { /* a failed rotation must not block the write */ }
  }
}

/** 备份路径候选，按新鲜度排序。 */
function backupCandidates(file) {
  return [
    `${file}.bak`,
    `${file}.bak.1`,
    `${file}.bak.2`,
  ];
}

/**
 * 读取 settings 文件，带分层回退与诚实的来源报告。
 *
 * @returns {{
 *   data: object|null,      // 解析成功的原始对象（未合默认值）
 *   source: 'primary'|'backup'|'none',
 *   backupIndex: number|null,
 *   corruptPath: string|null,   // 损坏文件被另存到哪里（供用户找回）
 *   error: string|null,
 *   warnings: string[],
 * }}
 */
function readSettings(file, { log = () => {} } = {}) {
  const warnings = [];
  // 损坏文件的另存路径必须贯穿整个函数——即使随后从备份恢复成功，
  // 用户仍然需要知道"原文件坏了，我已把它放在这里"。
  let corruptPath = null;
  const tryParse = (p) => {
    const text = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
    return parsed;
  };

  // 1) 主文件
  if (fs.existsSync(file)) {
    try {
      const data = tryParse(file);
      return { data, source: 'primary', backupIndex: null, corruptPath: null, error: null, warnings };
    } catch (err) {
      // 关键：**不要**直接吞掉。把损坏文件另存，保留证据与用户数据。
      corruptPath = `${file}.corrupt-${nowStamp()}`;
      try {
        fs.copyFileSync(file, corruptPath);
        warnings.push(`settings 文件损坏（${err.message}）；原文件已另存为 ${path.basename(corruptPath)}`);
      } catch (copyErr) {
        warnings.push(`settings 文件损坏（${err.message}）且无法另存备份：${copyErr.message}`);
      }
      log(`[settings] primary unreadable (${err.message}); preserved as ${corruptPath}`);
    }
  }

  // 2) 分层回退
  const candidates = backupCandidates(file);
  for (let i = 0; i < candidates.length; i += 1) {
    const p = candidates[i];
    if (!fs.existsSync(p)) continue;
    try {
      const data = tryParse(p);
      warnings.push(`已从备份恢复设置：${path.basename(p)}`);
      return { data, source: 'backup', backupIndex: i, corruptPath, error: null, warnings };
    } catch {
      warnings.push(`备份 ${path.basename(p)} 也不可读，继续尝试更早的备份`);
    }
  }

  // 3) 全部失败：没有可恢复的数据
  const err = fs.existsSync(file) ? 'settings 文件及其全部备份均不可读' : 'settings 文件不存在（首次运行）';
  return { data: null, source: 'none', backupIndex: null, corruptPath, error: err, warnings };
}

/**
 * 保存 settings，写入前轮转备份。
 * @param {string} file
 * @param {object} data  不含 schemaVersion 的纯设置对象（本函数负责注入）
 * @param {object} [opts]
 * @param {() => object} [opts.log]
 */
function writeSettings(file, data, { log = () => {} } = {}) {
  const payload = { schemaVersion: SETTINGS_SCHEMA_VERSION, ...data };
  // 轮转必须在写之前：此刻 file 里还是上一份**有效**内容。
  rotateBackups(file);
  atomicWrite(file, `${JSON.stringify(payload, null, 2)}\n`);
  log(`[settings] saved (schema ${SETTINGS_SCHEMA_VERSION}) to ${file}`);
  return payload;
}

/**
 * 判断读到的数据是否需要迁移。
 * 当前只有 v1，因此只需处理"没有 schemaVersion 的旧文件"→ 视为 v0 → 升到 v1。
 *
 * 迁移是**纯函数**，便于测试与回滚；返回 {data, from, to, changed}。
 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return { data: raw, from: null, to: SETTINGS_SCHEMA_VERSION, changed: false };
  const from = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
  const out = { ...raw };
  let changed = false;

  if (from < 1) {
    // v0 → v1：没有结构变化，只是补版本号。**不要**在这里顺手改字段值——
    // 那是 SettingsStore 的 V41_MIGRATIONS 的职责，两者语义不同：
    // 前者是"文件格式版本"，后者是"默认值随上游定价变化而更新"。
    delete out.schemaVersion;
    changed = true;
  }

  out.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return { data: out, from, to: SETTINGS_SCHEMA_VERSION, changed: changed || from !== SETTINGS_SCHEMA_VERSION };
}

module.exports = {
  SETTINGS_SCHEMA_VERSION,
  BACKUP_DEPTH,
  atomicWrite,
  rotateBackups,
  backupCandidates,
  readSettings,
  writeSettings,
  migrate,
};
