// test/harness-auth-cookie-guard.test.js — 防止 harness 页面因 cookie 污染白屏
//
// ============================================================================
// 这个测试存在的原因（2026-11-02 真机事故）
//
//   DeepSeek Harness 页面整片白屏：URL 正确、load 事件全部成功、主进程 0 报错、
//   控制台也没有 JS 错误 —— 但 body.innerHTML 是空字符串。
//
//   根因：dsh 的认证 cookie 名是 `dsh-auth-<每实例随机后缀>`。
//   **每启动一次 runtime 就多一个不同名字的 cookie**，且是 HttpOnly 持久化的。
//
//   本机实测累积了 **71 个** dsh-auth-* cookie（调试期间 71 次启动）。
//   浏览器带着 71 个同族 cookie 去请求时，发出的很可能不是服务端认的那一个
//   → 401 → 页面 body 全空 → 白屏。
//
//   修法：加载前清掉除当前有效那个以外的所有 dsh-auth-*，只注入当前 cookie。
//
// ============================================================================
// 为什么用静态断言
//
//   真实复现需要"攒 71 个 cookie"，在 CI 上不现实。但**错误的代码形状**是
//   确定的：加载 harness 前必须清理陈旧 cookie。静态断言能 100% 拦住删掉它。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WM = fs.readFileSync(path.join(ROOT, 'src', 'window-manager.js'), 'utf8');

test('harness load path must clear stale dsh-auth cookies', () => {
  assert.match(WM, /startsWith\('dsh-auth-'\)/,
    '必须识别 dsh-auth-* 这一族 cookie');
  assert.match(WM, /cookies\.remove\(/,
    '必须真的删除陈旧 cookie，而不是只统计');
  assert.match(WM, /cleared .* stale dsh-auth cookie/,
    '清理行为必须留下日志（否则下次白屏又要从头排查）');
});

test('harness load path must inject the CURRENT auth cookie', () => {
  // 复用 runtimeAuth 已交换好的 cookie，而不是再消耗一次一次性 token
  assert.match(WM, /getCookie\(\)/,
    '必须从 runtimeAuth 取已交换好的 cookie');
  assert.match(WM, /cookies\.set\(/,
    '必须把 cookie 注入 session');
});

test('the harness URL must drop the one-shot token before loading', () => {
  // token 是一次性的：第一个请求用掉就失效。所以最终页面地址不能带它。
  assert.match(WM, /searchParams\.delete\('token'\)/,
    '加载前必须去掉 token 参数，否则会 401');
});

test('blank-page detection stays in place', () => {
  // 没有这个探测，白屏时日志上什么都看不出来（这次排查最费时的地方）
  assert.match(WM, /rootChildren/,
    '必须保留"页面是否真的有内容"的探测');
  assert.match(WM, /WARN harness view is BLANK/,
    '空页面必须显式告警');
});

test('cookie values are never logged', () => {
  // 凭据不能进日志。只允许打名字/长度。
  const bad = /log\([^)]*pairs\[0\]\.split\('='\)\[1\]/;
  assert.doesNotMatch(WM, bad,
    'cookie 的值绝不能进日志（只打名字和长度）');
  assert.match(WM, /valueLen=/,
    '应该打值的长度用于诊断，而不是值本身');
});
