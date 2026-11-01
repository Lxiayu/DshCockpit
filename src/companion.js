// src/companion.js — Companion 小窗的渲染逻辑（P2.4 S2）。
//
// 第一性原理：渲染层不做判断
//
//   companion-state.js 已经把"显示什么种类的信息"派生好了
//   （idle / working / needs-you / disconnected + 两个数字）。
//   这里只负责把它画出来。
//
//   如果渲染层自己再判断一次"待办数 > 0 才亮红"，就出现了两处规则。
//   两处规则迟早会不一致——典型表现是派生层说 idle 而 UI 还亮着红。
//
// 所以：**UI 只消费 kind，不重新推导 kind。**
'use strict';

(function init() {
  const dot = document.getElementById('dot');
  const label = document.getElementById('label');
  const count = document.getElementById('count');
  const body = document.body;

  // 文案表：小窗自己持有（它不加载 i18n.js——那是完整应用才需要的重量级依赖）。
  // 只有 4 种 kind，硬编码比引入词典更简单，也更难出错。
  const COPY = {
    zh: {
      'needs-you': (n) => `${n} 件待你处理`,
      working: (n) => `${n} 个任务运行中`,
      idle: () => '空闲中',
      disconnected: () => '未连接',
    },
    en: {
      'needs-you': (n) => `${n} need${n === 1 ? 's' : ''} you`,
      working: (n) => `${n} running`,
      idle: () => 'Idle',
      disconnected: () => 'Disconnected',
    },
  };

  let lang = 'zh';

  /** 主进程推来的状态（由 companion-state.js 派生，本层不重新推导）。 */
  function render(state) {
    const kind = (state && state.kind) || 'disconnected';
    body.dataset.kind = kind;
    const copy = COPY[lang] || COPY.zh;
    const fn = copy[kind] || copy.disconnected;
    const n = kind === 'needs-you' ? (state.pendingCount || 0)
      : kind === 'working' ? (state.runningCount || 0) : 0;
    label.textContent = fn(n);
    // 数字只在需要时显示；待办数是主角，运行数次之，其余留空
    count.textContent = (kind === 'needs-you' || kind === 'working') && n > 0 ? String(n) : '';
  }

  // 初始态：未连接。等主进程推送。
  render({ kind: 'disconnected' });

  const bridge = window.companionBridge;
  if (bridge) {
    bridge.onState((state) => { render(state); });
    bridge.onLanguage((value) => {
      if (value === 'zh' || value === 'en') { lang = value; render(bridge.lastState() || { kind: 'disconnected' }); }
    });
    // 点击 → 展开完整办公室（由主进程决定是聚焦主窗口还是新建）
    document.body.addEventListener('click', () => { bridge.expand(); });
  }
})();
