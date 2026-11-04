'use strict';

// test/helpers/source-scan.js — 源码级断言的公共工具。
//
// 第一性原理：为什么需要这个文件
//
//   本项目有十几个"读源码做断言"的门禁（注入是否接线、轮询刷新什么、
//   state 字段是否只读不写…）。它们都要先做同一件事：**把注释去掉**。
//   否则注释里提到的名字会让断言失真。
//
//   这件事已经因为"各写各的"出过**四次**问题：
//     第 34 轮  `await refresh()`    —— 注释里正好写着它，被当成违规
//     第 42 轮  attention            —— 同上
//     第 48 轮  officeTeamActivation —— 同上
//     第 49 轮  linkSessionId        —— 同上
//
//   而各文件里那版实现都只剔 `// 行注释`，**不处理块注释 `/* *\/`**
//   也不处理行尾注释。第 50 轮实测：mission-desk.html 里有 95 个块注释、
//   7 处行尾注释，其中 3 个关键名字（markSeen / sessionProjections /
//   attention）就藏在块注释里 ——
//   也就是说那些断言当时是**看着绿、其实在检查注释文本**。
//
//   所以统一到这里：一份正确的实现，所有人共用。
//   各文件里再写自己的剥注释逻辑，就是给自己留一个新的坑。

/**
 * 去掉源码里的注释，保留代码与换行结构。
 *
 * 处理三种形式（这是关键 —— 只处理 `//` 是不够的）：
 *   1. 整行 `// 注释`
 *   2. 行尾 `code(); // 注释`
 *   3. 块注释 `/* ... *\/`（可跨行）
 *
 * 保留换行：跨行的块注释换成一串空行，这样**行号不会错位** ——
 * 断言里常常用 `indexOf` 比位置，行号错位会让它得出错误结论。
 *
 * 另外会**跳过字符串字面量**（' " `）—— 否则源码里的
 * `'http://...'` 会被当成行注释，把后面的代码全吃掉。
 * 这是本模块第一版真实踩到的 bug（测试抓到）。
 *
 * 已知不做：正则字面量里的 `//`、模板字符串里的 `${}` 嵌套表达式。
 * 本项目的源码扫描场景用不到，真要精确得上词法器 ——
 * 这里的目的是"别让注释和 URL 干扰断言"，不是"完整解析 JS"。
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  if (typeof src !== 'string') return '';
  const out = [];
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let quote = null; // 当前所在的字符串定界符：' " `
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // --- 字符串内部：原样保留，直到闭合 ---
    //
    // 为什么必须处理：
    //   源码里到处是 `'http://...'`。不识别字符串的话，
    //   那个 `//` 会被当成行注释，把**后面的所有代码**都吃掉 ——
    //   门禁于是对着半截源码做判断，结论完全不可信。
    //   这是本模块第一版真实踩到的 bug。
    if (quote) {
      out.push(ch);
      if (ch === '\\') { // 转义：连下一个字符一起吞掉
        if (i + 1 < src.length) { out.push(src[i + 1]); i += 2; continue; }
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (inLine) {
      if (ch === '\n') { inLine = false; out.push('\n'); }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 2; continue; }
      // 保留换行，保证行号不错位
      out.push(ch === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }

    // --- 代码区 ---
    if (ch === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out.push(ch); i += 1; continue; }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * 源码是否包含某段代码（注释不算）。
 *
 * @param {string} src
 * @param {string|RegExp} needle
 * @returns {boolean}
 */
function codeHas(src, needle) {
  const code = stripComments(src);
  if (needle instanceof RegExp) {
    // 保证 g 标志不影响 lastIndex
    const re = new RegExp(needle.source, needle.flags.replace('g', ''));
    return re.test(code);
  }
  return code.includes(needle);
}

/**
 * 在源码里找一个代码块（按前缀取一段），并返回**去注释后**的文本。
 * 用于"某个函数内部不得出现 X"这类断言。
 *
 * @param {string} src
 * @param {string} startMarker  代码里的起始标记
 * @param {number} length       取多长（去注释前）
 * @returns {string}
 */
function codeSlice(src, startMarker, length) {
  const i = src.indexOf(startMarker);
  if (i === -1) return '';
  return stripComments(src.slice(i, i + length));
}

module.exports = { stripComments, codeHas, codeSlice };
