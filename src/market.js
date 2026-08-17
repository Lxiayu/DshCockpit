// src/market.js — plugin market data from the awesome-dsh-plugin curated list
// (CC0-1.0, https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
// Pure functions only: fetching/caching lives in main.js so this stays testable.
'use strict';

/** Stable category ids for the 14 sections of the curated list. */
const CATEGORY_MAP = {
  'UI Enhancements': { id: 'ui', zh: 'UI 增强', en: 'UI Enhancements' },
  'Usage & Billing': { id: 'billing', zh: '用量与计费', en: 'Usage & Billing' },
  'Themes & Appearance': { id: 'theme', zh: '主题与外观', en: 'Themes & Appearance' },
  'Models & Providers': { id: 'models', zh: '模型与账号接入', en: 'Models & Providers' },
  'Sessions & Messages': { id: 'sessions', zh: '会话与消息', en: 'Sessions & Messages' },
  'Memory': { id: 'memory', zh: '记忆', en: 'Memory' },
  'Tools & Capabilities': { id: 'tools', zh: '工具与能力', en: 'Tools & Capabilities' },
  'Vision & Multimodal': { id: 'vision', zh: '视觉与多模态', en: 'Vision & Multimodal' },
  'Skills': { id: 'skills', zh: '技能包', en: 'Skills' },
  'Workflow & Automation': { id: 'workflow', zh: '工作流与自动化', en: 'Workflow & Automation' },
  'Notifications & Integrations': { id: 'notify', zh: '通知与集成', en: 'Notifications & Integrations' },
  'Development & Runtime': { id: 'devtools', zh: '开发与运行时', en: 'Development & Runtime' },
  'Plugin Markets & Managers': { id: 'market', zh: '插件市场与管理', en: 'Plugin Markets & Managers' },
  'Just for Fun': { id: 'fun', zh: '娱乐', en: 'Just for Fun' },
};

const ENTRY_RE = /^[-*]\s+\[([^\]]+)\]\(https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)[^)]*\)\s*(?:[-—–:]\s*)?(.*)$/;

function cleanDesc(s) {
  return String(s || '')
    .replace(/\*\*/g, '')       // strip bold markers; textContent shows them literally
    .replace(/\s+$/, '')
    .slice(0, 300);
}

/** Extract the plugin region: `## Plugins` (or the localized heading) up to the
 *  next `## ` heading. TOC anchor links stay out because they precede it. */
function pluginRegion(md) {
  const lines = String(md || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+(Plugins|插件)\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break; // next top-level section ends the region
    out.push(lines[i]);
  }
  return out;
}

/**
 * Parse the English curated README into market entries.
 * Returns [{ category, categoryLabel, fullName, desc }] in document order.
 */
function parseAwesomeReadme(md) {
  const entries = [];
  let cat = null;
  let catLabel = '';
  for (const line of pluginRegion(md)) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      const mapped = CATEGORY_MAP[h[1]];
      cat = mapped ? mapped.id : h[1].toLowerCase().replace(/[^a-z0-9]+/g, '-');
      catLabel = mapped ? mapped.en : h[1];
      continue;
    }
    const m = line.match(ENTRY_RE);
    if (!m || !cat) continue;
    entries.push({
      category: cat,
      categoryLabel: catLabel,
      fullName: `${m[2]}/${m[3]}`,
      desc: cleanDesc(m[4]),
    });
  }
  return entries;
}

/** Parse the Chinese README into a fullName → description map (join by repo). */
function parseZhDescriptions(md) {
  const map = new Map();
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = line.match(ENTRY_RE);
    if (m) map.set(`${m[2]}/${m[3]}`, cleanDesc(m[4]));
  }
  return map;
}

/**
 * Build the IPC payload: category chips in document order with counts, and
 * plugin cards with stars/installed flags joined in. `starMap` entries are
 * {stars, updated}; plugins missing from it keep stars null (rendered as —).
 */
function buildMarketPayload(entries, starMap, installedSet) {
  const list = Array.isArray(entries) ? entries : [];
  const stars = starMap || {};
  const installed = installedSet || new Set();
  const cats = [];
  const seen = new Map();
  const plugins = list.map((e) => {
    if (!seen.has(e.category)) {
      seen.set(e.category, 0);
      cats.push(e.category);
    }
    seen.set(e.category, seen.get(e.category) + 1);
    const meta = stars[e.fullName] || {};
    return {
      fullName: e.fullName,
      description: e.descZh || e.desc, // renderer picks by language; zh preferred when present
      descriptionEn: e.desc,
      category: e.category,
      stars: typeof meta.stars === 'number' ? meta.stars : null,
      updated: meta.updated || '',
      installed: installed.has(e.fullName),
    };
  });
  return {
    categories: cats.map((id) => ({ id, count: seen.get(id) })),
    plugins,
  };
}

/** True when the on-disk cache is within its TTL (24h default). */
function isCacheFresh(cache, now = Date.now(), ttlMs = 24 * 3600 * 1000) {
  return Boolean(cache)
    && typeof cache.fetchedAt === 'number'
    && Array.isArray(cache.entries)
    && cache.entries.length > 0
    && now - cache.fetchedAt < ttlMs;
}

module.exports = { CATEGORY_MAP, parseAwesomeReadme, parseZhDescriptions, buildMarketPayload, isCacheFresh };
