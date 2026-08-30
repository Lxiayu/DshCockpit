// src/mcp-registry.js — MCP server discovery (T1, v0.3.1).
//
// Three sources, merged and de-duplicated:
//   1. BUILTIN — a curated offline list of verified commands (zero network,
//      the baseline that always renders)
//   2. Official MCP Registry (registry.modelcontextprotocol.io/v0.1) — the
//      authoritative, namespace-verified catalog (io.github.* binds to a
//      GitHub account; `deleted` status marks moderated/malicious entries).
//      Packages map to commands: npm → `npx -y <pkg>`, pypi → `uvx <pkg>`
//      (the NPX/UVX-first posture Trae documents too). Remotes map to sse.
//   3. GitHub topic search (topic:mcp-server) — community long tail, query-
//      driven; results never carry a command (form opens prefilled only).
//
// Network results are cached in-process for 10 minutes (the official registry
// asks aggregators to scrape infrequently; a settings-page visit must never
// turn into a scrape loop). Every failure degrades silently to what is
// already on screen — builtin always works offline.
'use strict';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1';
const REGISTRY_LIMIT = 24;
const REGISTRY_TTL_MS = 10 * 60_000;

const BUILTIN = [
  {
    id: 'filesystem', name: 'Filesystem', category: 'storage', provider: 'official', stars: 12300,
    description: '本地文件系统读写（可指定目录范围）',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'github', name: 'GitHub', category: 'devtools', provider: 'official', stars: 12300,
    description: 'GitHub API：仓库 / Issue / PR 管理',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    envPlaceholders: { GITHUB_TOKEN: 'GitHub 个人访问令牌（repo 权限）' },
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'git', name: 'Git', category: 'devtools', provider: 'official', stars: 9000,
    description: 'Git 仓库操作（status / diff / commit / log）',
    transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '{workspace}'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'postgres', name: 'PostgreSQL', category: 'database', provider: 'official', stars: 12300,
    description: 'PostgreSQL 只读查询与 schema 检查',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'sqlite', name: 'SQLite', category: 'database', provider: 'official', stars: 12300,
    description: 'SQLite 数据库探索与只读查询',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '{workspace}/data.db'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'brave-search', name: 'Brave Search', category: 'search', provider: 'official', stars: 12300,
    description: 'Brave 网页搜索',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envPlaceholders: { BRAVE_API_KEY: 'Brave Search API Key' },
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'memory', name: 'Memory', category: 'memory', provider: 'official', stars: 12300,
    description: '知识图谱式长期记忆（官方参考实现）',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'sequential-thinking', name: 'Sequential Thinking', category: 'memory', provider: 'official', stars: 12300,
    description: '结构化分步思考，动态修订推理链',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'fetch', name: 'Fetch', category: 'search', provider: 'official', stars: 12300,
    description: '抓取网页并转换为 Markdown',
    transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'time', name: 'Time', category: 'devtools', provider: 'official', stars: 9000,
    description: '时区换算与时间查询',
    transport: 'stdio', command: 'uvx', args: ['mcp-server-time'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'gdrive', name: 'Google Drive', category: 'storage', provider: 'official', stars: 9000,
    description: 'Google Drive 文件搜索与读取',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'google-maps', name: 'Google Maps', category: 'search', provider: 'official', stars: 9000,
    description: '地图 / 路线 / 地点检索',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'],
    envPlaceholders: { GOOGLE_MAPS_API_KEY: 'Google Maps API Key' },
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'puppeteer', name: 'Puppeteer', category: 'browser', provider: 'official', stars: 12300,
    description: '浏览器自动化（抓取 / 测试）',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envPlaceholders: {}, homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'playwright', name: 'Playwright', category: 'browser', provider: 'community', stars: 8500,
    description: 'Playwright 跨浏览器自动化（微软官方）',
    transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'],
    envPlaceholders: {}, homepage: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'serena', name: 'Serena', category: 'coding', provider: 'community', stars: 5600,
    description: '基于 LSP 的符号级代码检索（IDE 级代码理解）',
    transport: 'stdio', command: 'serena', args: ['start-mcp-server', '--context', 'agent', '--project-from-cwd'],
    envPlaceholders: {}, homepage: 'https://github.com/oraios/serena',
  },
  {
    id: 'slack', name: 'Slack', category: 'communication', provider: 'official', stars: 12300,
    description: 'Slack 工作区消息与频道管理',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'],
    envPlaceholders: { SLACK_BOT_TOKEN: 'Slack Bot Token（xoxb-…）', SLACK_TEAM_ID: 'Slack Team ID' },
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'notion', name: 'Notion', category: 'devtools', provider: 'official', stars: 9000,
    description: 'Notion 官方远程 MCP（OAuth 由服务端处理）',
    transport: 'sse', url: 'https://mcp.notion.com/mcp',
    envPlaceholders: {}, homepage: 'https://mcp.notion.com',
  },
  {
    id: 'sentry', name: 'Sentry', category: 'devtools', provider: 'official', stars: 9000,
    description: 'Sentry 官方远程 MCP：错误监控与事件检索',
    transport: 'sse', url: 'https://mcp.sentry.dev/mcp',
    envPlaceholders: {}, homepage: 'https://mcp.sentry.dev',
  },
  {
    id: 'stripe', name: 'Stripe', category: 'devtools', provider: 'official', stars: 9000,
    description: 'Stripe 官方远程 MCP：支付与账务操作',
    transport: 'sse', url: 'https://mcp.stripe.com/mcp',
    envPlaceholders: {}, homepage: 'https://mcp.stripe.com',
  },
  {
    id: 'linear', name: 'Linear', category: 'devtools', provider: 'official', stars: 9000,
    description: 'Linear 官方远程 MCP：事项跟踪与项目管理',
    transport: 'sse', url: 'https://mcp.linear.app/sse',
    envPlaceholders: {}, homepage: 'https://mcp.linear.app',
  },
  {
    id: 'custom', name: '自定义 MCP Server', category: 'custom', provider: 'custom', stars: 0,
    description: '手动配置任意 MCP Server（stdio / 远程端点）',
    transport: 'stdio', command: '', args: [], envPlaceholders: {}, homepage: '',
  },
];

const CATEGORIES = [
  ['all', 'mcp_catAll'], ['storage', 'mcp_catStorage'], ['database', 'mcp_catDatabase'],
  ['devtools', 'mcp_catDevtools'], ['search', 'mcp_catSearch'], ['browser', 'mcp_catBrowser'],
  ['coding', 'mcp_catCoding'], ['communication', 'mcp_catCommunication'], ['memory', 'mcp_catMemory'],
  ['custom', 'mcp_catCustom'],
];

/** Map an official-registry server entry onto our record. Returns null when
 * no executable shape can be derived (no npm/pypi package and no remote). */
function fromRegistryEntry(entry) {
  if (!entry || typeof entry.name !== 'string') return null;
  const short = String(entry.name).split('/').pop() || entry.name;
  const slug = short.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const pkg = Array.isArray(entry.packages) ? entry.packages.find((p) => p && p.identifier) : null;
  const remote = Array.isArray(entry.remotes) ? entry.remotes[0] : null;
  const base = {
    id: `reg-${slug}`,
    name: entry.title || short,
    registryName: entry.name,
    description: String(entry.description || '').slice(0, 200),
    category: 'other',
    provider: String(entry.name).startsWith('io.modelcontextprotocol') ? 'official' : 'community',
    registryVerified: true, // every official-registry entry carries a verified namespace
    homepage: (entry.repository && entry.repository.url) || '',
    envPlaceholders: {},
    stars: 0,
  };
  if (pkg && pkg.registryType === 'npm') {
    base.transport = 'stdio';
    base.command = 'npx';
    base.args = ['-y', String(pkg.identifier)];
  } else if (pkg && pkg.registryType === 'pypi') {
    base.transport = 'stdio';
    base.command = 'uvx';
    base.args = [String(pkg.identifier)];
  } else if (remote && remote.url) {
    base.transport = 'sse';
    base.url = String(remote.url);
  } else {
    return null; // docker/nuget/binary-only: no NPX/UVX shape — show via requiresConfig instead? skip
  }
  return base;
}

function createMcpRegistry({ log, fetchImpl } = {}) {
  const doFetch = fetchImpl || null;
  const cache = new Map(); // key → { at, items }
  const cached = (key) => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.at < REGISTRY_TTL_MS ? hit.items : null;
  };
  const store = (key, items) => {
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), items });
  };

  async function getJson(url, timeoutMs = 8000) {
    if (!doFetch) throw new Error('offline');
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(url, {
        headers: { 'User-Agent': 'DshCockpit', Accept: 'application/json' },
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
      return typeof res.json === 'function' ? await res.json() : JSON.parse(res.body || '{}');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Official registry listing (search when a query is present). */
  async function searchOfficial(query) {
    if (!doFetch) return [];
    const key = `reg:${query || ''}`;
    const hit = cached(key);
    if (hit) return hit;
    const params = new URLSearchParams({ limit: String(REGISTRY_LIMIT), status: 'active' });
    if (query) params.set('search', query);
    try {
      const body = await getJson(`${REGISTRY_BASE}/servers?${params.toString()}`);
      const items = (Array.isArray(body.servers) ? body.servers : [])
        .map(fromRegistryEntry)
        .filter(Boolean);
      store(key, items);
      return items;
    } catch (e) {
      log(`[mcp] official registry unavailable (builtin list shown): ${e.message}`);
      return [];
    }
  }

  /** GitHub topic search for the community long tail. */
  async function searchOnline(query, timeoutMs = 8000) {
    const q = String(query || '').trim();
    if (!q || !doFetch) return [];
    const key = `gh:${q}`;
    const hit = cached(key);
    if (hit) return hit;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:mcp-server ${q}`)}&sort=stars&per_page=12`;
    try {
      const body = await getJson(url, timeoutMs);
      const items = (body.items || []).slice(0, 12).map((r) => ({
        id: `gh-${r.full_name.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase()}`,
        name: r.name,
        fullName: r.full_name,
        description: String(r.description || '').slice(0, 200),
        category: 'other',
        provider: 'community',
        stars: r.stargazers_count || 0,
        requiresConfig: true, // no verified command — the form opens prefilled only
        homepage: r.html_url || '',
        transport: 'stdio',
      }));
      store(key, items);
      return items;
    } catch (e) {
      log(`[mcp] registry search failed (offline list shown): ${e.message}`);
      return [];
    }
  }

  function filterBuiltin(query, category) {
    const q = String(query || '').trim().toLowerCase();
    return BUILTIN.filter((it) => {
      if (category && category !== 'all' && it.category !== category) return false;
      if (!q) return true;
      return it.name.toLowerCase().includes(q)
        || it.description.toLowerCase().includes(q)
        || it.id.toLowerCase().includes(q);
    });
  }

  return {
    BUILTIN,
    CATEGORIES,
    search: filterBuiltin,
    searchOfficial,
    searchOnline,
    /** Builtin + official registry (always) + GitHub (query mode), deduped. */
    async list(query, category) {
      const q = String(query || '').trim();
      const local = filterBuiltin(q, category);
      const seen = new Set(local.map((it) => it.name.toLowerCase()));
      const online = [];
      for (const item of [...await searchOfficial(q), ...await searchOnline(q)]) {
        const key = (item.name || '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        online.push(item);
      }
      return [...local, ...online];
    },
  };
}

module.exports = {
  BUILTIN,
  CATEGORIES,
  REGISTRY_BASE,
  REGISTRY_TTL_MS,
  fromRegistryEntry,
  createMcpRegistry,
};
