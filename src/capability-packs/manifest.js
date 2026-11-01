// src/capability-packs/manifest.js — Capability Pack 的 manifest 校验（P3 S1）。
//
// 第一性原理：为什么 manifest 字段必须少而硬
//
//   一个常见错误是"manifest 支持一切"——加十几个可选字段，将来总有用。
//   后果是：每个 Pack 的 manifest 都不一样，校验器无法 fail-closed，
//   安装器要为每种组合写分支。半年后没人敢改。
//
//   所以本阶段只允许 8 个顶层字段，且**未知字段一律拒绝**。
//   拒绝未知字段不是死板——它是"未来加字段时必须先改这里"的强制提醒。
//   那时我们才知道为什么要加。
//
// 第二性原理：为什么校验要返回"全部错误"而不是第一个
//
//   用户手写 manifest 时，一次看到所有问题比修一个跑一次快得多。
//   这与 schema.js 的纪律一致（见 src/mission/schema.js）。
'use strict';

/** manifest 的 schema 版本。不匹配即拒绝（fail-closed）。 */
const MANIFEST_SCHEMA_VERSION = 1;

/** 顶层允许的字段——**完整清单**，多一个都拒。 */
const ALLOWED_FIELDS = Object.freeze([
  'schemaVersion', 'id', 'version', 'title', 'description',
  'requires', 'provides', 'verify',
]);

/** requires 子对象允许的字段。 */
const ALLOWED_REQUIRES = Object.freeze(['platforms', 'commands']);

/** verify 子对象允许的字段。 */
const ALLOWED_VERIFY = Object.freeze(['command', 'expectExitCode', 'timeoutMs']);

/** 支持的平台（与 process.platform 一致）。 */
const KNOWN_PLATFORMS = Object.freeze(['darwin', 'win32', 'linux']);

/** id 的形状：小写 kebab-case，3-64 字符。 */
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** 版本：semver 的三段简化形式（不引入依赖）。 */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

/**
 * 校验一个 manifest 对象。
 *
 * @param {object} value
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 */
function validateManifest(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }

  // ---- 未知字段：这是 fail-closed 的关键 ----
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      errors.push(`unknown field "${key}" (allowed: ${ALLOWED_FIELDS.join(', ')})`);
    }
  }
  // ---- 必填字段缺失 ----
  for (const key of ALLOWED_FIELDS) {
    if (!(key in value)) {
      // description 可选，其余必填
      if (key !== 'description') errors.push(`missing field "${key}"`);
    }
  }

  // ---- schemaVersion ----
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION} (got ${JSON.stringify(value.schemaVersion)})`);
  }

  // ---- id ----
  if (!isNonEmptyString(value.id)) {
    errors.push('id must be a non-empty string');
  } else if (!ID_RE.test(value.id)) {
    errors.push('id must be lower kebab-case (e.g. workspace-verification)');
  } else if (value.id.length < 3) {
    // 单字符 id 没有辨识度，且 '''a''' 这种会与未来的短名冲突
    errors.push('id must be at least 3 characters');
  } else if (value.id.length > 64) {
    errors.push('id must be at most 64 characters');
  }

  // ---- version ----
  if (!isNonEmptyString(value.version)) {
    errors.push('version must be a non-empty string');
  } else if (!VERSION_RE.test(value.version)) {
    errors.push('version must be MAJOR.MINOR.PATCH');
  }

  // ---- title ----
  if (!isNonEmptyString(value.title)) errors.push('title must be a non-empty string');

  // ---- requires ----
  if (!isPlainObject(value.requires)) {
    errors.push('requires must be an object');
  } else {
    for (const key of Object.keys(value.requires)) {
      if (!ALLOWED_REQUIRES.includes(key)) errors.push(`unknown requires field "${key}"`);
    }
    const { platforms, commands } = value.requires;
    if (!Array.isArray(platforms) || platforms.length === 0) {
      errors.push('requires.platforms must be a non-empty array');
    } else {
      for (const p of platforms) {
        if (!KNOWN_PLATFORMS.includes(p)) {
          errors.push(`requires.platforms has unknown platform "${p}" (known: ${KNOWN_PLATFORMS.join(', ')})`);
        }
      }
    }
    if (!Array.isArray(commands)) {
      errors.push('requires.commands must be an array (may be empty)');
    } else {
      for (const c of commands) {
        if (!isNonEmptyString(c)) errors.push('requires.commands entries must be non-empty strings');
      }
    }
  }

  // ---- provides ----
  if (!isPlainObject(value.provides)) {
    errors.push('provides must be an object');
  } else if (!Array.isArray(value.provides.capabilities) || value.provides.capabilities.length === 0) {
    errors.push('provides.capabilities must be a non-empty array');
  }

  // ---- verify：P3 的核心 ----
  if (!isPlainObject(value.verify)) {
    errors.push('verify must be an object — a capability pack without verification is just documentation');
  } else {
    for (const key of Object.keys(value.verify)) {
      if (!ALLOWED_VERIFY.includes(key)) errors.push(`unknown verify field "${key}"`);
    }
    if (!isNonEmptyString(value.verify.command)) {
      errors.push('verify.command must be a non-empty string');
    }
    if ('expectExitCode' in value.verify && !Number.isInteger(value.verify.expectExitCode)) {
      errors.push('verify.expectExitCode must be an integer');
    }
    if ('timeoutMs' in value.verify) {
      const t = value.verify.timeoutMs;
      if (!Number.isInteger(t) || t <= 0 || t > 30 * 60 * 1000) {
        errors.push('verify.timeoutMs must be a positive integer up to 30 minutes');
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * 判断 manifest 是否声明支持当前平台。
 *
 * @returns {{supported:boolean, reason:string|null}}
 */
function platformSupport(manifest, platform) {
  const list = manifest && manifest.requires && Array.isArray(manifest.requires.platforms)
    ? manifest.requires.platforms : [];
  if (list.includes(platform)) return { supported: true, reason: null };
  return {
    supported: false,
    reason: `this capability pack supports ${list.join(', ') || '(none)'}, not ${platform}`,
  };
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  ALLOWED_FIELDS,
  ALLOWED_REQUIRES,
  ALLOWED_VERIFY,
  KNOWN_PLATFORMS,
  validateManifest,
  platformSupport,
};
