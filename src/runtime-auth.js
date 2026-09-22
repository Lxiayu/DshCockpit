// src/runtime-auth.js — 共享的 runtime 浏览器会话（token URL → dsh-auth-* Cookie）。
//
// 0.1.5 起 harness 的 web surface 用"进程启动 token 换浏览器 Cookie"：
//   GET <authUrl>（形如 http://127.0.0.1:<port>/?token=<launchToken>）
//     → 303 + Set-Cookie: dsh-auth-<随机前缀>=<签名>
//   之后一切 /api 请求（含 /api/remote.mux 的 WebSocket upgrade）都必须带该 Cookie，
//   否则 401。Cookie 名带随机前缀，**不可硬编码**。
//
// 该模块是 harness-rpc / 事件流 / 审批回答 / 手机网关四处共用的唯一 Cookie 来源：
//   - setAuthUrl(url)：supervisor 解析出带 token 的 URL 时调用（本进程内 token 恒定）
//   - getCookie()：拿到（缓存的）Cookie 头值；失败返回 null（调用方按 401/降级处理）
//   - invalidate()：收到 401 时调用，下次 getCookie 重新交换
//   - 单飞（single-flight）+ 退避重试，避免多处并发换 token
'use strict';

function createRuntimeAuth({ fetchImpl = globalThis.fetch, log = () => {}, retries = 3, retryDelayMs = 600 } = {}) {
  let authUrl = null;
  let cookie = null;
  let inflight = null;
  let lastError = null;

  function setAuthUrl(url) {
    if (typeof url !== 'string' || !url) return;
    if (url === authUrl) return;
    authUrl = url;
    cookie = null; // 新一代 runtime（新端口/新 token）一律重新交换
  }

  function invalidate() { cookie = null; }

  function cookieHeaderOf(response) {
    const list = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')];
    const parts = (list || [])
      .filter(Boolean)
      .map((entry) => String(entry).split(';')[0].trim())
      .filter((entry) => entry.includes('='));
    return parts.length ? parts.join('; ') : null;
  }

  async function exchange() {
    if (!authUrl) return null;
    for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
      try {
        // 不跟随重定向：303 的 Set-Cookie 就是要取的东西。
        const response = await fetchImpl(authUrl, { redirect: 'manual' });
        const header = cookieHeaderOf(response);
        if (header) {
          cookie = header;
          lastError = null;
          log(`[runtime-auth] browser session acquired (status ${response.status})`);
          return cookie;
        }
        lastError = new Error(`no set-cookie (status ${response.status})`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
    log(`[runtime-auth] exchange failed: ${lastError && lastError.message}`);
    return null;
  }

  async function getCookie() {
    if (cookie) return cookie;
    if (!inflight) {
      inflight = exchange().finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    setAuthUrl,
    getCookie,
    invalidate,
    get authUrl() { return authUrl; },
    get lastError() { return lastError; },
    get cached() { return cookie; },
  };
}

module.exports = { createRuntimeAuth };
