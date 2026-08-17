import './fonts.js';
import { dict } from './i18n.js';

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- i18n 切换 ---------- */
const langBtn = $('#langBtn');
const ZH = 'zh', EN = 'en';

function applyLang(lang) {
  document.documentElement.lang = lang === EN ? 'en' : 'zh-CN';
  langBtn.textContent = lang === EN ? '中文' : 'EN';

  if (lang === EN) {
    $$('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      const en = dict.en[key];
      if (en === undefined) return;
      if (!el.dataset.zh) el.dataset.zh = el.innerHTML;
      el.innerHTML = en;
    });
    document.title = 'DshCockpit — Turn DeepSeek Harness into a resident Agent cockpit';
    $('meta[name="description"]').setAttribute('content',
      'Open-source desktop cockpit for DeepSeek Harness: live token monitoring & context-pressure alerts, cost center with budget alarms, smoke-guarded auto-update with rollback, global-hotkey Quick Ask, scheduled tasks, Ctrl+K full-text search and a plugin marketplace. Fully local, MIT licensed.');
  } else {
    $$('[data-i18n]').forEach((el) => {
      if (el.dataset.zh) el.innerHTML = el.dataset.zh;
    });
    document.title = 'DshCockpit — 把 DeepSeek Harness 变成常驻后台的 Agent 驾驶舱';
    $('meta[name="description"]').setAttribute('content',
      '开源桌面驾驶舱：Token 实时监控与上下文压力预警、成本控制中心与预算报警、冒烟守卫自动更新与一键回滚、全局热键 Quick Ask、定时任务、Ctrl+K 全文检索、插件市场。完全本地运行，MIT 开源。');
  }
  // OS 检测按钮文案跟随语言
  updateDlText();
  localStorage.setItem('dsh-lang', lang);
}

langBtn.addEventListener('click', () => {
  applyLang(document.documentElement.lang === 'en' ? ZH : EN);
});

const saved = localStorage.getItem('dsh-lang');
if (saved === EN) applyLang(EN);

/* ---------- OS 检测下载按钮 ---------- */
const ua = navigator.userAgent;
const isMac = /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua);
const isWin = /Windows/i.test(ua);

function updateDlText() {
  const el = $('#heroDlText');
  if (!el) return;
  const en = document.documentElement.lang === 'en';
  el.textContent = en
    ? `Download for ${isMac ? 'macOS' : isWin ? 'Windows' : 'all platforms'}`
    : `下载 ${isMac ? 'macOS' : isWin ? 'Windows' : ''}版`.replace('  ', ' ');
}

/* ---------- 导航 ---------- */
const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

const burger = $('#burger');
burger.addEventListener('click', () => $('#navLinks').classList.toggle('open'));
$$('#navLinks a').forEach((a) => a.addEventListener('click', () => $('#navLinks').classList.remove('open')));

/* ---------- 滚动显现 ---------- */
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.12 });
$$('.reveal').forEach((el) => io.observe(el));

/* ---------- 仪表演示动画 ---------- */
// 1) 上下文压力条：42% → 68%(黄) → 86%(红) → 重置 循环
const pressure = $('#pressure');
const pFill = $('#pressureFill');
const pVal = $('#pressureVal');

if (pressure && !reduced) {
  let stage = 0;
  const stages = [
    { v: 42, cls: '', label: { zh: '42% · 正常', en: '42% · NOMINAL' } },
    { v: 68, cls: 'warn', label: { zh: '68% · 黄色预警', en: '68% · AMBER' } },
    { v: 86, cls: 'danger', label: { zh: '86% · 红色预警 — 建议开新会话', en: '86% · RED — open a new session' } },
  ];
  const run = () => {
    const s = stages[stage];
    pressure.classList.remove('warn', 'danger');
    if (s.cls) pressure.classList.add(s.cls);
    pFill.style.width = s.v + '%';
    const en = document.documentElement.lang === 'en';
    pVal.textContent = en ? s.label.en : s.label.zh;
    stage = (stage + 1) % stages.length;
  };
  const pio = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (e.isIntersecting) { run(); setInterval(run, 2600); pio.disconnect(); }
    });
  });
  pio.observe(pressure);
} else if (pressure) {
  pFill.style.width = '42%';
}

// 2) 成本柱状图
const cost = $('#costDemo');
if (cost) {
  const cio = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      cost.classList.add('play');
      $$('.bar-v', cost).forEach((b, i) => {
        setTimeout(() => { b.style.height = b.dataset.h; }, reduced ? 0 : i * 90);
      });
      cio.disconnect();
    });
  });
  cio.observe(cost);
}

// 3) 更新管道步骤点亮
const pipe = $('#pipeline');
if (pipe) {
  const steps = $$('.pipe-step', pipe);
  const arrows = $$('.pipe-arrow', pipe);
  const lio = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      steps.forEach((s, i) => {
        setTimeout(() => {
          s.classList.add('on');
          if (i > 0) arrows[i - 1].classList.add('lit');
        }, reduced ? 0 : i * 520);
      });
      lio.disconnect();
    });
  });
  lio.observe(pipe);
}

// 4) Quick Ask 按键演示
const hotkey = $('#quickask .hotkey');
if (hotkey && !reduced) {
  let n = 0;
  setInterval(() => {
    hotkey.classList.add('press');
    setTimeout(() => hotkey.classList.remove('press'), 260);
  }, 3200);
}

// 5) 胶囊数字轻微跳动（仪表活着的感觉）
const capIn = $('#capIn');
const capOut = $('#capOut');
if ((capIn || capOut) && !reduced) {
  let io1 = 12480, io2 = 3102;
  setInterval(() => {
    io1 += Math.floor(Math.random() * 90);
    io2 += Math.floor(Math.random() * 26);
    if (capIn) capIn.textContent = io1.toLocaleString('en-US');
    if (capOut) capOut.textContent = io2.toLocaleString('en-US');
  }, 2400);
}

/* ---------- 复制 xattr 命令 ---------- */
const toast = $('#toast');
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

$('#copyXattr').addEventListener('click', async () => {
  const cmd = $('#xattrCmd').textContent.trim();
  try {
    await navigator.clipboard.writeText(cmd);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = cmd;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const en = document.documentElement.lang === 'en';
  showToast(en ? 'Copied to clipboard ✓' : '已复制到剪贴板 ✓');
});

updateDlText();
