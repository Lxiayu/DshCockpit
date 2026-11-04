// test/acceptance-probes-validity.test.js — 真机验收探针的有效性门禁。
//
// 第一性原理：为什么探针需要被守着
//
//   scripts/acceptance/ 下有 20 个真机探针，它们需要图形会话，**不在 CI 跑**。
//   这意味着：它们可以在几个月里悄悄失效而没人知道 ——
//   等到真的要做真机验收时，才发现探针自己先崩了，而那时已经很难分清
//   "是产品坏了"还是"是探针过时了"。
//
//   这份门禁用**静态检查**兜住最容易过时的那一类失效：
//     · 探针用到的 CSS 选择器 / 元素 id 在源码里已经不存在
//     · 探针 require 的相对路径已经不存在
//     · 语法错误（虽然 node --check 也能抓，但放在这里一起跑）
//
//   它不能证明探针"跑得过"（那需要图形会话），但它能保证
//   "探针引用的东西还在" —— 而这是最常见、也最廉价的失效方式。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ACCEPT_DIR = path.join(ROOT, 'scripts', 'acceptance');

function probeFiles() {
  if (!fs.existsSync(ACCEPT_DIR)) return [];
  return fs.readdirSync(ACCEPT_DIR)
    .filter((f) => /\.(js|cjs|mjs)$/.test(f))
    .map((f) => path.join(ACCEPT_DIR, f));
}

/** 递归收集源码文本（用于判断选择器是否存在）。 */
function sourceCorpus() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (!/node_modules|\.git|archive/.test(p)) walk(p);
      } else if (/\.(js|cjs|mjs|html|css)$/.test(name)) {
        out.push(fs.readFileSync(p, 'utf8'));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return out.join('\n');
}

test('probes: the acceptance directory still has probes (not silently emptied)', () => {
  // 如果没有探针，下面所有断言都会"通过" —— 那是最糟的假绿。
  const files = probeFiles();
  assert.ok(files.length >= 10,
    `expected the acceptance suite to still exist, found ${files.length} files`);
});

test('probes: every CSS selector they query still exists in src/', () => {
  const corpus = sourceCorpus();
  const broken = [];
  for (const file of probeFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const sels = [...text.matchAll(/querySelector(?:All)?\(\s*['"]([.#][\w-]+)/g)].map((m) => m[1]);
    for (const sel of new Set(sels)) {
      // 只检查字面量选择器（`#id` / `.class`）
      if (!corpus.includes(sel.slice(1))) {
        broken.push(`${path.basename(file)} -> ${sel}`);
      }
    }
  }
  assert.deepEqual(broken, [],
    `these probes query selectors that no longer exist (they will fail on a real machine):\n  ${broken.join('\n  ')}`);
});

test('probes: every relative require they use still resolves', () => {
  const broken = [];
  for (const file of probeFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const reqs = [...text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const rel of reqs) {
      const resolved = path.resolve(path.dirname(file), rel);
      const candidates = [resolved, resolved + '.js', resolved + '.cjs', path.join(resolved, 'index.js')];
      if (!candidates.some((c) => fs.existsSync(c))) {
        broken.push(`${path.basename(file)} -> ${rel}`);
      }
    }
  }
  assert.deepEqual(broken, [],
    `these probes require files that no longer exist:\n  ${broken.join('\n  ')}`);
});

test('probes: every probe is syntactically valid', () => {
  // node --check 是子进程，这里用 vm 做轻量语法验证（不执行）。
  const vm = require('node:vm');
  const broken = [];
  for (const file of probeFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      // 只编译不运行
      new vm.Script(text, { filename: file });
    } catch (err) {
      broken.push(`${path.basename(file)}: ${err.message}`);
    }
  }
  assert.deepEqual(broken, [], `syntax errors:\n  ${broken.join('\n  ')}`);
});

test('probes: each probe states WHY it needs a real machine (or is a pure probe)', () => {
  // 探针的价值在于"解释为什么这件事必须真机验证"。
  // 没有这段说明的探针，半年后没人知道它还在验什么。
  const undocumented = [];
  for (const file of probeFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const head = text.slice(0, 1200);
    const hasRationale = /第一性原理|why|为什么|离线测不到|只能由真机/.test(head);
    if (!hasRationale) undocumented.push(path.basename(file));
  }
  // 允许少数早期探针暂时缺失，但新增的必须有。
  // 这里把当前存量**固定**下来：只能减少，不能增加。
  const ALLOWED = 0;
  assert.ok(undocumented.length <= ALLOWED,
    `probes must explain why they need a real machine:\n  ${undocumented.join('\n  ')}`);
});
