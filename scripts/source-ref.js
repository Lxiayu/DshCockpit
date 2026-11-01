'use strict';

// scripts/source-ref.js — 抗漂移的源码引用（Issue #17）。
//
// 第一性原理：为什么"行号"是错误的引用方式
//
//   契约表（如 DSH_EXECUTION_MAPPING）想回答的是"这个结论的依据在代码哪里"。
//   行号看起来很精确，但它**随任何无关编辑而失效**——而失效时没有任何信号：
//
//     · 插一个空行 → 所有后续行号 +1，全部指向错误位置
//     · 删一段注释 → 行号 -N，仍然"在文件内"，测试照样绿
//
//   本仓库真实发生过：DSH_EXECUTION_MAPPING 里 5 处 `src/main.js:4760-4762`
//   之类的引用，今天指向的是 `guidedInstallInProgress` 和 `hasBrokenBundle`
//   ——与 turn 事件毫无关系。而 test:124 的断言只检查"行号 ≤ 文件行数"，
//   所以这个漂移从未被发现。
//
//   正确的引用是**符号名 + 片段摘要**：
//     - 符号被重命名/删除 → 立刻红（这是真实的契约变化，应该红）
//     - 行号漂移         → 不受影响（本来就不该依赖行号）
//     - 片段被改写        → 红，要求人工确认是否仍然成立
//
//   本模块提供：
//     makeRef({file, symbol, fragment})  → 生成带 digest 的引用
//     verifyRef(ref, rootDir)            → 校验符号存在 + 片段仍匹配
//     resolveSymbol(file, symbol)        → 找到函数/常量的行区间（供人阅读）
//
// 片段摘要用 sha256 的前 16 位十六进制——足够避免碰撞，又不至于让 diff 噪音。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 规范化片段：去掉首尾空白、统一换行、折叠行内多余空格。 */
function normalizeFragment(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** 片段摘要（sha256 前 16 hex）。 */
function fragmentDigest(text) {
  return crypto.createHash('sha256').update(normalizeFragment(text), 'utf8').digest('hex').slice(0, 16);
}

/** 构造一个引用对象。fragment 是"这段代码长什么样"的证据。 */
function makeRef({ file, symbol, fragment }) {
  const norm = normalizeFragment(fragment);
  if (!norm) throw new Error('makeRef requires a non-empty fragment');
  return Object.freeze({
    file: String(file),
    symbol: String(symbol || ''),
    digest: fragmentDigest(norm),
    // 人类可读的片段原文。它不参与判定（digest 才参与），
    // 但让报告能直接显示出"当时指的是什么"。
    fragment: norm,
  });
}

/**
 * 在文件里定位符号的行区间。
 * 支持：function 声明、const/let/var 赋值、class 声明、module.exports 属性。
 * 找不到返回 null。
 */
function resolveSymbol(src, symbol) {
  if (!symbol) return null;
  const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 依次尝试几种常见声明形态
  const patterns = [
    new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'),
    new RegExp(`^(?:const|let|var)\\s+${name}\\s*=`, 'm'),
    new RegExp(`^class\\s+${name}\\b`, 'm'),
    new RegExp(`^\\s*${name}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function)`, 'm'),
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    const startLine = src.slice(0, m.index).split('\n').length;
    return { startLine, startIndex: m.index, match: m[0] };
  }
  return null;
}

/**
 * 校验单个引用。
 * @returns {{ok:boolean, reason:string, located?:object}}
 */
function verifyRef(ref, rootDir) {
  if (!ref || typeof ref !== 'object') return { ok: false, reason: 'ref is not an object' };
  const { file, symbol, digest } = ref;
  if (!file) return { ok: false, reason: 'ref.file missing' };
  const abs = path.isAbsolute(file) ? file : path.join(rootDir, file);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, reason: `cannot read ${file}: ${err.message}` };
  }

  // 1) 符号必须仍然存在
  let located = null;
  if (symbol) {
    located = resolveSymbol(src, symbol);
    if (!located) {
      return { ok: false, reason: `symbol "${symbol}" no longer defined in ${file} (contract changed or renamed)` };
    }
  }

  // 2) 片段必须仍然出现在文件里（规范化后做子串比较）
  const normSrc = normalizeFragment(src);
  const normFrag = normalizeFragment(ref.fragment || '');
  if (!normFrag) {
    return { ok: false, reason: 'ref.fragment empty — cannot verify the contract still holds' };
  }
  const present = normSrc.includes(normFrag);
  const actualDigest = present ? fragmentDigest(normFrag) : null;

  if (digest && present && actualDigest !== digest) {
    // digest 记录了"当时的片段"，但片段是按内容校验的，内容一致 digest 必然一致。
    // 走到这里说明 ref 自身的 digest 与实际内容不符（被人手改过 ref）。
    return { ok: false, reason: `ref.digest ${digest} does not match its own fragment (${actualDigest})` };
  }
  if (!present) {
    return {
      ok: false,
      reason: `fragment no longer present in ${file}${symbol ? ` (symbol "${symbol}" at line ${located.startLine})` : ''} — verify whether the contract still holds`,
      located,
    };
  }
  return { ok: true, reason: '', located };
}

/** 批量校验，返回 {ok, failures[]}。 */
function verifyRefs(refs, rootDir) {
  const failures = [];
  for (const ref of refs) {
    const r = verifyRef(ref, rootDir);
    if (!r.ok) failures.push({ ref, ...r });
  }
  return { ok: failures.length === 0, failures };
}

module.exports = {
  normalizeFragment,
  fragmentDigest,
  makeRef,
  resolveSymbol,
  verifyRef,
  verifyRefs,
};
