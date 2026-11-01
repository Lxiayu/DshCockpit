// src/mission/verification-profile.js — 验证定义的可信模型（P1）
//
// 第一性原理：为什么不能存 `{ command, expectedExitCode }`
//
//   我最初的设计是一条 shell 命令字符串 + 期望退出码。GPT 指出了六个问题，
//   我逐条核对后确认全部成立：
//
//     1. 跨平台命令格式不同
//     2. **Shell 注入**：命令字符串天然可拼接
//     3. 命令可能包含未授权操作
//     4. **环境变量可能含 API Key**（我们的模型 Key 就在环境里）
//     5. 执行路径可能逃出项目目录
//     6. Agent 可能自己改验证脚本
//
//   第 6 条最重要：Agent 改了源码，同时把 package.json 的 test
//   改成 `echo ok`，`npm test` 照样返回 0。**退出码不是正确性证明。**
//
// 第二性原理：那"验证"到底能证明什么
//
//   只能证明：**「在代码快照 S 上、用验证定义 D、跑出了结果 R」**。
//   所以三个东西必须一起记录，缺一个就不可信：
//     · definitionDigest —— 用的是哪份验证定义
//     · sourceDigest     —— 跑在哪个代码快照上
//     · result           —— 实际结果
//
//   任何一个变了，旧结果就必须变成 stale（不是删除，是标记过期）。
//
// 第三性原理：谁能提供验证定义
//
//   不是所有验证定义都同样可信：
//     · platform       —— 我们内置的（可信）
//     · user_approved  —— 用户确认过的（可信，但可能是错的）
//     · agent_proposed —— Agent 提出的（**只展示，不执行**）
//
//   这个分级决定了 UI 敢不敢给"执行"按钮。
'use strict';

const crypto = require('node:crypto');

/** 验证定义的信任级别。**只有前两种允许执行。** */
const TRUST_LEVELS = Object.freeze(['platform', 'user_approved', 'agent_proposed']);

/** 允许执行的信任级别。agent_proposed 只展示不执行——它可能是绕过验证的尝试。 */
const EXECUTABLE_TRUST = Object.freeze(['platform', 'user_approved']);

/** 验证结果状态。stale 是**独立状态**，不是"未知"。 */
const VERIFY_STATES = Object.freeze(['not-run', 'passed', 'failed', 'stale', 'not-executable']);

/** 验证作用域。 */
const SCOPES = Object.freeze(['workspace', 'artifact']);

/** 单次验证执行的超时上限（毫秒）。超过就杀，不留僵尸进程。 */
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isNonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

/**
 * 计算验证定义的摘要。
 *
 * 为什么需要它：验证定义本身会被改。如果只记"跑过了"，
 * 下次定义变了就分不清"新定义通过"还是"旧定义通过"。
 *
 * 摘要只覆盖**影响执行语义**的字段，不包括 id/name 之类的展示字段。
 */
function definitionDigest(profile) {
  const semantic = {
    executable: profile.executable,
    args: Array.isArray(profile.args) ? profile.args : [],
    workingDirectory: profile.workingDirectory || '.',
    timeoutMs: profile.timeoutMs,
    expectedExitCodes: Array.isArray(profile.expectedExitCodes) ? [...profile.expectedExitCodes].sort() : [],
    scope: profile.scope ? { kind: profile.scope.kind, paths: [...(profile.scope.paths || [])].sort() } : null,
  };
  const text = JSON.stringify(semantic);
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 校验一个验证定义。
 *
 * 硬约束（每条都对应一个具体风险）：
 *   · executable 必须是**裸文件名**，不能带路径（防 /bin/sh -c 注入）
 *   · 不允许 shell 元字符出现在 executable 里
 *   · args 每个元素不能是 `-c`（防把参数变成命令）
 *   · workingDirectory 必须是相对路径（防逃出项目）
 *   · expectedExitCodes 必须是非空数字数组
 */
function validateProfile(p) {
  const errors = [];
  if (!isPlainObject(p)) return { ok: false, errors: ['profile must be an object'] };

  if (!isNonEmpty(p.profileId)) errors.push('profileId is required');
  if (!isNonEmpty(p.name)) errors.push('name is required');
  if (!isNonEmpty(p.executable)) {
    errors.push('executable is required');
  } else {
    // 不允许路径分隔符：`/bin/sh` 或 `..\cmd` 都该被拒
    if (/[\\/]/.test(p.executable)) {
      errors.push('executable must be a bare command name, not a path (prevents /bin/sh -c style injection)');
    }
    // 不允许 shell 元字符
    if (/[\s;&|<>$`(){}[\]*?!#~]/.test(p.executable)) {
      errors.push('executable must not contain shell metacharacters or whitespace');
    }
  }
  if (!Array.isArray(p.args)) {
    errors.push('args must be an array (never a single command string)');
  } else {
    for (const a of p.args) {
      if (typeof a !== 'string') { errors.push('every arg must be a string'); break; }
      // -c / --command 会把参数变成可执行命令，等于绕开 args 分离
      if (a === '-c' || a === '--command' || a === '/c') {
        errors.push('args must not contain -c/--command — that turns an argument back into a shell command');
        break;
      }
    }
  }
  if (p.workingDirectory !== undefined) {
    if (!isNonEmpty(p.workingDirectory)) {
      errors.push('workingDirectory must be a non-empty relative path');
    } else if (/^([A-Za-z]:[\\/]|[\\/])/.test(p.workingDirectory) || p.workingDirectory.split(/[\\/]/).includes('..')) {
      errors.push('workingDirectory must stay inside the workspace (no absolute paths, no ..)');
    }
  }
  if (!Array.isArray(p.expectedExitCodes) || p.expectedExitCodes.length === 0) {
    errors.push('expectedExitCodes must be a non-empty array');
  } else if (!p.expectedExitCodes.every((c) => Number.isInteger(c))) {
    errors.push('expectedExitCodes must contain integers');
  }
  if (!Number.isFinite(p.timeoutMs) || p.timeoutMs < MIN_TIMEOUT_MS || p.timeoutMs > MAX_TIMEOUT_MS) {
    errors.push(`timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  if (!TRUST_LEVELS.includes(p.trustLevel)) {
    errors.push(`trustLevel must be one of ${TRUST_LEVELS.join('|')}`);
  }
  if (p.scope !== undefined) {
    if (!isPlainObject(p.scope) || !SCOPES.includes(p.scope.kind)) {
      errors.push(`scope.kind must be one of ${SCOPES.join('|')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 判断一个验证结果是否已过期。
 *
 * 这是整个模型里最重要的一条规则：
 * **代码快照变了、或验证定义变了，旧结果就不能再显示为"通过"。**
 */
function isStale(run, current) {
  if (!run || !isPlainObject(run)) return true;
  if (!isNonEmpty(run.sourceDigest) || !isNonEmpty(current && current.sourceDigest)) return true;
  if (run.sourceDigest !== current.sourceDigest) return true;
  if (!isNonEmpty(run.definitionDigest) || !isNonEmpty(current && current.definitionDigest)) return true;
  if (run.definitionDigest !== current.definitionDigest) return true;
  return false;
}

/**
 * 派生一次验证的展示状态。
 *
 * **不猜**：信任级别不够执行时，状态是 not-executable，而不是 failed。
 */
function deriveState(run, current) {
  if (!run || !isPlainObject(run)) return 'not-run';
  if (run.trustLevel && !EXECUTABLE_TRUST.includes(run.trustLevel)) return 'not-executable';
  if (isStale(run, current)) return 'stale';
  if (run.exitCode === null || run.exitCode === undefined) return 'not-run';
  const expected = Array.isArray(run.expectedExitCodes) ? run.expectedExitCodes : [];
  return expected.includes(run.exitCode) ? 'passed' : 'failed';
}

module.exports = {
  TRUST_LEVELS,
  EXECUTABLE_TRUST,
  VERIFY_STATES,
  SCOPES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  definitionDigest,
  validateProfile,
  isStale,
  deriveState,
};
