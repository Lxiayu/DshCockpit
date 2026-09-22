// test/runtime-auth.test.js — 共享 runtime 鉴权（token URL → Cookie）契约。
// 依据 docs/strategy/2026-09-22-harness-upgrade-compat-plan.md §1.3 的实测：
//   GET <authUrl> → 303 + Set-Cookie: dsh-auth-<随机前缀>=<签名>；裸 / 一律 401。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRuntimeAuth } = require('../src/runtime-auth.js');

function responseWithCookie(cookie, status = 303) {
  return {
    status,
    headers: {
      getSetCookie: () => (cookie ? [cookie] : []),
      get: () => (cookie ? [cookie] : null),
    },
  };
}

test('exchanges the launch-token URL for the browser cookie and caches it', async () => {
  let calls = 0;
  const auth = createRuntimeAuth({
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.match(url, /\?token=/);
      assert.equal(options.redirect, 'manual', 'never follow the 303');
      return responseWithCookie('dsh-auth-abc=signature; Path=/; HttpOnly');
    },
  });
  auth.setAuthUrl('http://127.0.0.1:45771/?token=launch');
  assert.equal(await auth.getCookie(), 'dsh-auth-abc=signature');
  assert.equal(await auth.getCookie(), 'dsh-auth-abc=signature', 'second call is cached');
  assert.equal(calls, 1, 'only one exchange');
});

test('a new auth URL invalidates the cached cookie (new runtime generation)', async () => {
  let n = 0;
  const auth = createRuntimeAuth({
    fetchImpl: async () => { n += 1; return responseWithCookie(`dsh-auth-g${n}=sig`); },
  });
  auth.setAuthUrl('http://127.0.0.1:1/?token=a');
  assert.equal(await auth.getCookie(), 'dsh-auth-g1=sig');
  auth.setAuthUrl('http://127.0.0.1:2/?token=b');
  assert.equal(await auth.getCookie(), 'dsh-auth-g2=sig', 're-exchanged for the new generation');
});

test('invalidate() forces a re-exchange (401 self-healing)', async () => {
  let n = 0;
  const auth = createRuntimeAuth({ fetchImpl: async () => { n += 1; return responseWithCookie(`dsh-auth-r${n}=sig`); } });
  auth.setAuthUrl('http://127.0.0.1:3/?token=c');
  await auth.getCookie();
  auth.invalidate();
  assert.equal(auth.cached, null);
  assert.equal(await auth.getCookie(), 'dsh-auth-r2=sig');
  assert.equal(n, 2);
});

test('concurrent callers share one in-flight exchange (single flight)', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const auth = createRuntimeAuth({
    fetchImpl: async () => { calls += 1; await gate; return responseWithCookie('dsh-auth-s=1'); },
  });
  auth.setAuthUrl('http://127.0.0.1:4/?token=d');
  const [a, b, c] = [auth.getCookie(), auth.getCookie(), auth.getCookie()];
  release();
  assert.deepEqual(await Promise.all([a, b, c]), ['dsh-auth-s=1', 'dsh-auth-s=1', 'dsh-auth-s=1']);
  assert.equal(calls, 1);
});

test('a missing cookie or a failing fetch degrades to null without throwing', async () => {
  const noCookie = createRuntimeAuth({ fetchImpl: async () => responseWithCookie(null, 200), retries: 1 });
  noCookie.setAuthUrl('http://127.0.0.1:5/?token=e');
  assert.equal(await noCookie.getCookie(), null);
  assert.ok(noCookie.lastError);

  const broken = createRuntimeAuth({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, retries: 2, retryDelayMs: 1 });
  broken.setAuthUrl('http://127.0.0.1:6/?token=f');
  assert.equal(await broken.getCookie(), null);
  assert.match(String(broken.lastError && broken.lastError.message), /ECONNREFUSED/);
});

test('no auth URL means no exchange at all (runtime not up yet)', async () => {
  let calls = 0;
  const auth = createRuntimeAuth({ fetchImpl: async () => { calls += 1; return responseWithCookie('x=1'); } });
  assert.equal(await auth.getCookie(), null);
  assert.equal(calls, 0);
});
