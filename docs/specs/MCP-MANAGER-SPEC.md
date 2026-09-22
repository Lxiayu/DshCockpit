# MCP 管理器 — 技术规范文档

> **版本**：v2（完整版）· **编制日期**：2026-08-29 · **状态**：待评审
>
> **v2 修订说明**：对标 Claude Desktop / Claude Code / Codex CLI / VS Code 四家成熟实现后全面升级——补齐远程传输、enabled 策略、通用导入器、密钥安全存储、两层健康检查、Windows 兼容、使用量观测等 9 项差距。对标结论见 §2。
>
> 关联文档：[ROADMAP.md](file:///Users/xia/program/dsh/DshCockpit/ROADMAP.md) §R3 · [PREDEV-FEATURES-REPORT.md](file:///Users/xia/program/dsh/DshCockpit/docs/specs/PREDEV-FEATURES-REPORT.md) §T1

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [竞品对标与能力基线](#2-竞品对标与能力基线)
3. [MCP 协议与 DSH 集成调研](#3-mcp-协议与-dsh-集成调研)
4. [设计原则与关键决策](#4-设计原则与关键决策)
5. [架构总览](#5-架构总览)
6. [数据模型](#6-数据模型)
7. [模块职责与接口](#7-模块职责与接口)
8. [IPC 协议](#8-ipc-协议)
9. [设置页面设计](#9-设置页面设计)
10. [关键技术方案](#10-关键技术方案)
11. [验收标准](#11-验收标准)
12. [风险与缓解](#12-风险与缓解)
13. [附录](#13-附录)

---

## 1. 背景与目标

### 1.1 为什么需要 MCP 管理器

MCP 已成"AI 的 USB-C"。但当前 DSH 的 MCP 配置需要**手动编辑 `cordis.patch.yml` YAML 文件**，门槛高、易出错、无可视化。竞品（Claude Desktop 的 Connectors UI、VS Code 的 MCP 面板、Codex CLI 的 `codex mcp` 子命令）都提供了完整的管理界面，壳级 MCP 管理器在 DSH 生态是明确空位。

### 1.2 目标（v2）

1. **可视化 CRUD**：添加/列表/编辑/移除 MCP Server，无需手动编辑 YAML
2. **双传输支持**：stdio（本地进程）+ sse/websocket URL（远程服务）——DSH 客户端原生支持的三种
3. **通用导入器**：从 Claude Desktop / VS Code / Cursor / 剪贴板 JSON 一键导入（`mcpServers` 同构 schema）
4. **两层健康检查**：Tier 1 快查（命令存在/URL 可达）+ Tier 2 深查（完整 MCP 握手 + tools/list）
5. **密钥安全**：env 中的敏感值经 safeStorage 加密存储，不落明文、不进备份
6. **enabled 策略**：禁用保留配置（成熟工具的标准做法），不销毁用户输入
7. **使用量观测（独家）**：从会话日志解析 `mcp__server__tool` 调用，展示每个 Server 的工具调用次数与最近使用——四家成熟工具都没有的能力
8. **零侵入**：只通过文件系统 + CLI 操作 DSH 配置

### 1.3 非目标（本版明确不做）

- ❌ OAuth 2.1 授权流（远程 SSE/WS 的鉴权先靠 header/env；OAuth 依赖 `dsh-oauth-mcp-client` 类插件，列为 v2 后续，架构上预留）
- ❌ Streamable HTTP 传输（DSH 原生客户端暂不支持，需社区插件，不引入依赖）
- ❌ MCPB 打包格式（DSH 无此机制）
- ❌ MCP Server 进程托管（运行时归 DSH 管，壳只管配置）
- ❌ enterprise allowlist/denylist（单人项目阶段不需要）

---

## 2. 竞品对标与能力基线

### 2.1 四家成熟实现调研结论（2026-08）

| 能力 | Claude Desktop | Claude Code | Codex CLI | VS Code | **我们的取舍** |
|---|---|---|---|---|---|
| 配置载体 | `claude_desktop_config.json` | `~/.claude.json` + `.mcp.json` 三作用域 | `config.toml` `[mcp_servers.*]` | `mcp.json` + settings | `cordis.patch.yml`（DSH 约束）+ settings.json |
| 传输 | stdio + HTTP + MCPB | stdio + http（SSE 弃用） | stdio + http | stdio + http | stdio + sse/websocket（DSH 客户端能力） |
| 作用域 | 单一全局 | local/project/user | user/project/profile | user/workspace | **单一全局**（DSH patch 文件只有 profile 级，见 D-2） |
| 启用/禁用 | UI 开关 | toggle 写不同位置 | `enabled = true` 字段 | 状态独立存储 | **enabled 标志**（D-3） |
| OAuth | Connectors UI（核心） | `/mcp` 自动流 | `mcp login/logout` | 支持 | 不做，架构预留（D-5） |
| 健康检查 | 连接状态 | 两层检查 | auth 状态 | 两层 + 5min 缓存 | **两层 + 5min 缓存**（照抄 VS Code） |
| 导入迁移 | MCPB 目录 | `add-from-claude-desktop` | — | Settings Sync | **通用 mcpServers 导入器**（比 Claude Code 更通用） |
| 密钥 | OS 钥匙串 | env 引用 | `bearer_token_env_var` | env | **safeStorage vault**（复用 models-manager） |
| 超时 | 固定 | — | `startup_timeout_sec`/`tool_timeout_sec` | 可配 | **per-server 超时字段**（照抄 Codex） |
| Windows npx | 内置 Node 兜底 | `cmd /c` 包装（官方文档明确） | — | — | **自动 `cmd /c` 包装**（Windows 主战场必须） |
| 使用量观测 | ❌ | ❌ | ❌ | ❌ | ✅ **独家：会话日志解析** |
| 工具列表缓存 | 自动发现 | `/mcp` 查看 | `mcp list` | 缓存计数 | 测试时发现 + 持久化 |

### 2.2 结论

成熟工具的**公倍数**是：CRUD + enabled 标志 + 两层健康检查 + 密钥不落明文 + per-server 超时。这些全部纳入。成熟工具的**差集**里，"通用导入器"（各家 schema 同构，成本极低）和"MCP 使用量观测"（我们的会话日志数据源独家）是性价比最高的两个，纳入。OAuth/HTTP 传输受 DSH 客户端能力限制，本版不做但预留架构位。

---

## 3. MCP 协议与 DSH 集成调研

### 3.1 DSH 的 MCP 接入方式

DSH 使用 `@deepseek-ai/dsh-mcp-client` 插件（随 DSH CLI 自带，无需单独安装），通过 `cordis.patch.yml` 配置：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: <块 id>                        # patch 块唯一标识
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <namespace>          # 工具前缀 mcp__<serverName>__<toolName>
        transport: stdio                 # stdio | sse | websocket
        command: <executable>            # stdio：启动命令
        args: []                         # stdio：命令参数
        env: {}                          # 环境变量
        url: <endpoint>                  # sse/websocket：远程端点
        headers: {}                      # 远程：自定义请求头
        failOnStartupError: false        # 启动失败是否阻断 DSH 启动
```

**关键事实**（勘察自 DSH 生态实证）：

- 工具注册为 `mcp__<serverName>__<toolName>`，`serverName` 必须唯一且具描述性
- `--dump-config` 可验证配置是否被 compose（但不证明 MCP Server 真正启动成功）
- 会话日志中 `assistant/message` / 工具调用事件记录了 `mcp__<serverName>__<toolName>` 调用——**这是使用量观测的数据源**
- 配置修改需重启运行时生效（DSH 无热重载）

### 3.2 传输方式（v2 全覆盖）

| 传输 | 配置字段 | 适用 | 本版 |
|---|---|---|---|
| **stdio** | `command` + `args` + `env` | 本地 MCP Server（npx/uvx/二进制） | ✅ 主力 |
| **sse** | `url` + `headers` | 远程 HTTP SSE 端点 | ✅ 支持 |
| **websocket** | `url` + `headers` | 远程双向流 | ✅ 支持 |
| streamable-http | — | 新版规范 | ❌ DSH 原生不支持，不引入插件依赖 |

### 3.3 生态参考

| 项目 | 借鉴点 |
|---|---|
| `dsh-plugin-mcp`（社区） | 万级 Server 引擎、allow/ask/deny 权限模型（本期参考权限语义，不做粒度实现） |
| Claude Code `cmd /c` 包装 | Windows npx 兼容性标准做法 |
| VS Code MCP 面板 PR #330207 | 状态可见性设计："状态只在有信息量时显示"、开关单一语义 |
| Codex `[mcp_servers.*]` | per-server `enabled`/`startup_timeout_sec`/`tool_timeout_sec` 字段设计 |

---

## 4. 设计原则与关键决策

### 4.1 约束清单（继承 PREDEV-FEATURES-REPORT.md）

| # | 约束 | 说明 |
|---|---|---|
| C-1 | 新增为主，修改最小化 | 新模块文件；main.js / settings.html 只做接线式增量 |
| C-2 | IPC 只增不改 | 全部新 channel `mcp:*` |
| C-3 | 设置只追加 | `settings-store.js` DEFAULTS 追加，老 settings.json 免迁移 |
| C-4 | 数据只写新文件 | 只动 `cordis.patch.yml` 的 MCP 块 + userData 下新文件 |
| C-5 | 回归门禁 | 既有测试全绿 + 新增测试全绿 |
| C-7 | 改 main.js 必须 `node --check` | H4 事故教训 |

### 4.2 本模块特有原则

| # | 原则 | 说明 |
|---|---|---|
| M-1 | 文件系统 + CLI 边界 | 不碰 DSH 内部 API；写前备份、写后 `--dump-config` 验证、失败回滚 |
| M-2 | 密钥不出主进程 | 敏感 env 值经 safeStorage 加密；renderer 只见 `keyConfigured` 布尔，永远不见值 |
| M-3 | 配置即真相，settings 存意图 | cordis.patch.yml 只含**启用中**的 Server；禁用的留在 shell settings（意图层） |
| M-4 | 安装前可预览 | Registry 安装前展示将执行的命令与参数（对齐技能市场"预览防注入"理念） |

### 4.3 关键决策记录（ADR）

**D-1 配置写入 `cordis.patch.yml` 而非 `settings.yaml`**
`settings.yaml` 是 DSH 核心配置（models-manager 已在用），MCP 属插件级配置，官方通道是 patch 文件。两者共存且职责分离，互不干扰。

**D-2 作用域单一（profile 级全局），不做三作用域**
Claude Code 的 local/project/user 三层依赖其 CLI 生态。DSH 的 `dsh-mcp-client` 只认 profile patch 文件，引入多作用域会造成"配置写了但 DSH 读不到"的幻觉。**单一作用域 + 诚实提示**优于虚假的多作用域。若未来 DSH 支持 `~/.dsh/mcp.json` 全局层，再扩展。

**D-3 禁用 = 从 patch 文件移除块 + settings 保留记录（enabled:false）**
Codex 的 `enabled` 字段方案更优雅，但 `dsh-mcp-client` config schema 是否支持 `enabled` 未经验证（T-0 勘察项）。**保守方案**：patch 文件只含启用的 Server（DSH 确定会加载的），禁用状态存 settings。禁用不丢用户输入，重新启用即恢复。若 T-0 证实 schema 支持 `enabled` 字段，升级为文件内标志方案。

**D-4 远程传输的密钥走 headers/env 引用，OAuth 后续**
sse/websocket 的鉴权先支持两种：`headers`（如 `Authorization: Bearer <value>`，值可引用 vault）与 `env`。OAuth 流（浏览器授权 + loopback callback）留架构位：`auth: { type: 'oauth' }` 字段预留，本版遇到 OAuth-only 端点给出可读提示。

**D-5 Windows `cmd /c` 自动包装**
Claude Code 官方文档确认：Windows 原生（非 WSL）环境下 npx-based Server 不包 `cmd /c` 会 "Connection closed"。壳在 stdio 保存时自动检测：`process.platform === 'win32' && command ∈ {npx, npm, yarn, pnpm, bunx}` → 写入 `command: 'cmd', args: ['/c', 原命令, ...原args]`。UI 显示原始形式，文件落盘包装形式，编辑时反向解包。

---

## 5. 架构总览

### 5.1 模块位置

```
src/
├── mcp-manager.js        # 核心：Server CRUD + cordis.patch.yml 行级 patch + 验证回滚
├── mcp-registry.js       # Registry：内置精选列表 + 在线搜索
├── mcp-connect.js        # 两层健康检查：Tier1 快查 + Tier2 MCP 握手
├── mcp-import.js         # 通用导入器：Claude Desktop / VS Code / Cursor / JSON 粘贴
├── mcp-usage.js          # 使用量观测：会话日志解析 mcp__server__tool 调用
test/
├── mcp-manager.test.js
├── mcp-registry.test.js
├── mcp-connect.test.js
├── mcp-import.test.js
└── mcp-usage.test.js
```

### 5.2 数据流

```
设置页 MCP 子页
   │ IPC mcp:*（见 §8）
   ▼
mcp-manager.js ──写──▶ ~/.dsh/profiles/web/cordis.patch.yml（MCP 块，行级 patch）
   │                       │ 写前备份 .bak → 写后 --dump-config 验证 → 失败回滚
   │                       ▼
   │                  DSH 运行时（重启后加载 MCP Server）
   │
   ├──mcp-connect.js──▶ Tier1（which/HEAD）/ Tier2（spawn + initialize + tools/list）
   ├──mcp-import.js───▶ 读 claude_desktop_config.json / mcp.json / 剪贴板
   └──mcp-usage.js────▶ 读 DSH_HOME/sessions/**/*.jsonl[.zstd] 统计 mcp__*__* 调用
```

### 5.3 与既有模块的关系

| 既有模块 | 关系 |
|---|---|
| `models-manager.js` | **模式模板**：复用 `upsertSection/removeSection` 思路 + `KeyVault`（safeStorage）+ "key 不跨进程" IPC 纪律 |
| `settings-store.js` | 追加 `mcpServers` 数组字段 |
| `session-worker.js` / `session-search.js` | mcp-usage 复用其日志扫描模式（zstd 解压 + 流式解析） |
| `runtime-log-tail.js` | 运行时日志解析 MCP 启动状态（可选增强） |
| `settings.html` / `settings-preload.js` | 追加导航项、子页、桥接方法 |
| `i18n.js` | 追加 zh/en 词条 |

---

## 6. 数据模型

### 6.1 settings-store.js 追加字段（C-3：只追加）

```javascript
mcpServers: [],        // MCP Server 配置（意图层，含禁用的）
```

> **实现注记（2026-08-29 实现后更新）**：健康检查缓存落在 `mcp-connect.js` 的进程内 Map（5 分钟 TTL），不写入 settings.json——避免每次列表刷新产生磁盘写放大；SPEC 原文 §6.1 的 `mcpTestCache` 字段不落地。

**McpServer 完整 schema**：

```javascript
{
  id: 'mcp-filesystem',              // 唯一 id（块 id 与之一致，patch 文件可读性）
  name: 'Filesystem',                // 显示名
  serverName: 'filesystem',          // MCP 命名空间（唯一，^[a-z][a-z0-9-]*$）
  transport: 'stdio',                // stdio | sse | websocket
  // stdio 专属
  command: 'npx',                    // UI 显示的原始命令（win32 落盘时自动包装）
  args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'],
  envRefs: { GITHUB_TOKEN: 'vault:mcp-github' },  // 敏感值 → vault 引用
  envPlain: { NODE_ENV: 'production' },           // 非敏感值明文
  // sse/websocket 专属
  url: '',                           // 远程端点
  headerRefs: { Authorization: 'vault:mcp-notion' }, // 敏感 header 值 → vault
  // 通用
  enabled: true,                     // 禁用保留配置（D-3）
  failOnStartupError: false,
  startupTimeoutSec: 10,             // Codex 式 per-server 超时（写注释放 patch 里）
  toolTimeoutSec: 60,
  source: 'registry|manual|import',  // 来源（import 记录 origin）
  origin: '',                        // import 来源描述（如 "Claude Desktop"）
  createdAt: '2026-08-29T…',
}
```

> **注**：`startupTimeoutSec`/`toolTimeoutSec` 若 `dsh-mcp-client` schema 不支持（T-0 勘察项），则仅作为 Tier2 测试参数与 UI 提示，不写入 patch 文件。

### 6.2 cordis.patch.yml 落盘格式（单个 Server 一个 patch 块）

```yaml
- insert:
    - id: mcp-filesystem
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: filesystem
        transport: stdio
        command: cmd            # win32 自动包装（D-5）
        args:
          - /c
          - npx
          - -y
          - '@modelcontextprotocol/server-filesystem'
          - /tmp
        env:
          NODE_ENV: production
          GITHUB_TOKEN: '{{DSH_VAULT:mcp-github}}'   # vault 引用（见 10.3）
        failOnStartupError: false
```

> **vault 引用语法（实现结论，2026-08-29）**：采用**运行时 env 注入方案**——敏感值只存壳 vault（safeStorage），运行时 spawn 时由 supervisor 的 `envExtras` 注入子进程环境，DSH 启动的 MCP Server 经进程继承拿到；cordis.patch.yml 对敏感键**整键省略**（不写占位符，避免空值覆盖继承）。依赖 T0-3 的"DSH 合并继承 env"假设，Tier2 探针始终用壳直接 spawn + vault 解密值验证命令本身，两条路径均不落明文。远程传输的 header 值是文档化的明文例外（DSH 从 config 构造 HTTP 请求，env 无法携带），UI 明示警告。

### 6.3 Registry 条目

```javascript
{
  id: 'filesystem', name: 'Filesystem',
  description: '本地文件系统访问（可配权限范围）',
  category: 'storage',            // storage|database|devtools|search|browser|coding|communication|memory|custom
  transport: 'stdio',
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'],
  envPlaceholders: {},            // 需要用户填的敏感 env（名称 + 提示文案）
  homepage: 'https://github.com/modelcontextprotocol/servers',
  verified: true, provider: 'official', stars: 12300,
  installArgHint: '{workspace} 会被替换为当前工作区路径',
}
```

内置列表 ≥ 12 个（filesystem / github / postgres / sqlite / brave-search / memory / puppeteer / playwright / serena / slack / linear / fetch + custom 空模板），在线搜索走 GitHub `topic:mcp-server` API（复用插件市场的 fetch 模式，失败静默降级为离线列表）。

---

## 7. 模块职责与接口

### 7.1 `src/mcp-manager.js`

```javascript
function createMcpManager({ settings, dshHome, profileName, vault, log, dumpConfigVerify }) {
  return {
    listServers(),        // settings.mcpServers 快照（含 enabled:false；敏感值替换为 hasKey 布尔）
    getServer(id),        // 单个详情
    async addServer(input),      // 校验 → vault 写入敏感值 → upsert patch 块 → dump-config 验证 → settings 落盘
    async updateServer(id, input), // 同上（反向解包 cmd /c）
    async removeServer(id),      // patch 块移除 + vault 清理 + settings 移除
    async toggleServer(id, enabled), // 启用：重建 patch 块；禁用：移除 patch 块、settings 置 enabled:false（D-3）
    patchFile(),                 // cordis.patch.yml 绝对路径
    changedAt(),                 // 供 UI 显示"配置已变更，重启生效"
  };
}
```

**写入管线（每个变更操作共用）**：
1. 备份 `cordis.patch.yml` → `cordis.patch.yml.mcp-bak`（保留 1 份）
2. 行级 patch：只增/删/改 `id === 本Server` 的块，其余块字节不动
3. 原子写（tmp + rename）
4. `--dump-config` 验证（带超时 8s）——非零退出 → 回滚备份 → 返回 `{ ok:false, reason }`
5. 通过 → settings 落盘 → 广播 `mcp:changed`

### 7.2 `src/mcp-connect.js`（两层健康检查，对齐 VS Code）

```javascript
const TIER2_TIMEOUT_DEFAULT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;      // 结果缓存 5 分钟（照抄 VS Code）

async function tier1(server, ctx)   // <2s：stdio→which/where.exe 查命令；远程→URL HEAD 请求
async function tier2(server, ctx)   // spawn/连接 → JSON-RPC initialize → tools/list → 返回工具名列表
function statusToIcon(t1, t2)        // healthy|degraded|binaryFound|reachable|unreachable|commandNotFound|error
```

状态语义（对齐 VS Code 设计规则"状态只在有信息量时显示"）：卡片上**只在异常时显示状态词**（命令未找到 / 连接失败 / 需要配置 Key），正常态不显示"Running"噪音。

### 7.3 `src/mcp-import.js`（通用导入器）

```javascript
// 各家配置全部是 { mcpServers: { name: { command|url, args, env, headers? } } } 同构
const IMPORT_SOURCES = {
  'claude-desktop': { win: '%APPDATA%\\Claude\\claude_desktop_config.json', mac: '~/Library/Application Support/Claude/claude_desktop_config.json' },
  'claude-code':    { file: '.mcp.json（项目根）+ ~/.claude.json 的 mcpServers' },
  'vscode':         { file: '.vscode/mcp.json + 用户 settings.json 的 mcp.servers' },
  'cursor':         { file: '~/.cursor/mcp.json' },
  'clipboard':      { }  // 粘贴 JSON 文本，解析 mcpServers 或单个 server 对象
};
async function scanSources()          // 探测哪些来源存在、各含几个 Server
async function importServers(sourceKey, selectedIds)  // 批量导入 → 复用 manager.addServer
```

字段映射：`type: "http"|"sse"` → transport 映射；`url` → url；`command+args+env` → stdio；导入后统一过 D-5 Windows 包装。命名冲突自动加后缀 `_1`（对齐 Claude Code `add-from-claude-desktop` 行为）。

### 7.4 `src/mcp-usage.js`（独家能力）

```javascript
// 数据源：DSH_HOME/sessions/**/session.jsonl[.zstd]
// 扫描 assistant/工具调用事件中 /mcp__([a-z0-9-]+)__([a-z0-9_-]+)/ 匹配
async function buildUsage({ days }) {
  // 返回：per-server { toolCalls, lastUsedAt, topTools: [{tool, count}] }
  // 复用 token-stats/session-search 的 (size, mtime) 缓存模式避免重复解析
}
```

UI 呈现：卡片底部一行"已调用 142 次 · 最近使用 2 小时前 · Top: read_file(80)"。与缓存经济学同构——"数据别的壳拿不到"。

---

## 8. IPC 协议

### 8.1 Channel 定义（全部新增，C-2）

| Channel | 参数 | 返回 |
|---|---|---|
| `mcp:list` | — | `{ ok, servers, changedAt }` |
| `mcp:get` | `id` | `{ ok, server }` |
| `mcp:save` | `server`（新增/编辑二合一） | `{ ok, server?, reason? }` |
| `mcp:remove` | `id` | `{ ok, reason? }` |
| `mcp:toggle` | `id, enabled` | `{ ok, reason? }` |
| `mcp:test` | `id 或 临时config, tier` | `{ ok, status, tools?, reason? }` |
| `mcp:registry` | `query?, category?` | `{ ok, items }` |
| `mcp:import-scan` | — | `{ ok, sources: [{ key, label, count, servers }] }` |
| `mcp:import-run` | `sourceKey, ids[]` | `{ ok, imported, failed: [{name, reason}] }` |
| `mcp:usage` | `days` | `{ ok, usage }` |
| `mcp:env-value` | `id, refKey` | 设值专用：`{ ok }`（**只写不读**，值永不回传 renderer，M-2） |
| `mcp:changed` | main → renderer 事件 | 配置变更通知（刷新列表 + 重启提示条） |

### 8.2 preload 桥接追加（settings-preload.js）

```javascript
mcpList: () => ipcRenderer.invoke('mcp:list'),
mcpSave: (server) => ipcRenderer.invoke('mcp:save', server),
mcpRemove: (id) => ipcRenderer.invoke('mcp:remove', id),
mcpToggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', id, enabled),
mcpTest: (target, tier) => ipcRenderer.invoke('mcp:test', target, tier),
mcpRegistry: (query, category) => ipcRenderer.invoke('mcp:registry', query, category),
mcpImportScan: () => ipcRenderer.invoke('mcp:import-scan'),
mcpImportRun: (sourceKey, ids) => ipcRenderer.invoke('mcp:import-run', sourceKey, ids),
mcpUsage: (days) => ipcRenderer.invoke('mcp:usage', days),
mcpSetEnvValue: (id, refKey, value) => ipcRenderer.invoke('mcp:env-value', id, refKey, value),
onMcpChanged: (cb) => ipcRenderer.on('mcp:changed', () => cb()),
```

---

## 9. 设置页面设计

### 9.1 导航项

`settings.html` 侧边栏"插件"与"技能"之间插入：

```html
<button class="nav-item" data-page="mcp"><span class="ico">🔌</span><span class="txt" data-i18n="nav.mcp">MCP 服务</span></button>
```

### 9.2 子页结构（三个卡片）

1. **已配置的 MCP 服务**：卡片列表（名称 / 状态词-仅异常时 / 传输·命令摘要 / 用量行 / 启用开关 / 测试 / 编辑 / 删除）；顶部 [+ 添加] [导入] 两按钮；配置变更后顶部出现"重启运行时生效"提示条 + [立即重启] 按钮
2. **导入**：来源探测结果（Claude Desktop 检测到 3 个 → 勾选导入）；JSON 粘贴框
3. **发现（Registry）**：搜索框 + 分类 chips + 推荐卡片（安装 = 打开预填好的添加对话框，M-4 预览确认后落盘）

### 9.3 添加/编辑对话框字段

名称* / 命名空间*（提示工具前缀规则）/ 传输方式（stdio | sse | websocket 三选）；
stdio → 命令* + 参数 + env 键值对（值输入框旁"🔒 敏感值加密存储"勾选）；
远程 → URL* + headers（同样支持敏感标记）；
failOnStartupError 开关 / [测试连接] / [保存]。

编辑已启用 Server 保存后：若运行时在跑，提示重启。

---

## 10. 关键技术方案

### 10.1 Windows 命令包装（D-5）

```javascript
const WRAP_TARGETS = new Set(['npx', 'npm', 'yarn', 'pnpm', 'bunx']);
function wrapForWindows(command, args) {
  if (process.platform !== 'win32') return { command, args };
  const base = String(command).trim().replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (!WRAP_TARGETS.has(path.basename(base))) return { command, args };
  return { command: 'cmd', args: ['/c', command, ...args] };
}
// 编辑回显时反向解包：command==='cmd' && args[0]==='/c' → 还原原始形式
```

UI 永远展示/编辑**原始形式**；落盘自动包装；测试执行用**落盘形式**。

### 10.2 两层健康检查

- **Tier 1（自动，列表刷新时静默跑，<2s）**：stdio → `which`/`where.exe` 查命令存在性；远程 → `URL` HEAD（3s 超时）。结果缓存 5 分钟。
- **Tier 2（手动，[测试] 按钮）**：stdio → spawn（落盘形式命令 + env 注入 vault 解密值）→ stdin 写 `initialize` → `notifications/initialized` → `tools/list` → 收集工具名 → kill；远程 → HTTP/WS 同协议序列。超时用 per-server `startupTimeoutSec`（默认 15s）。**测试进程独立于 DSH 运行时**，结束后即清理。
- 首次 npx 下载可能慢 → 测试中 UI 显示"首次运行需下载依赖，可能较慢"。

### 10.3 密钥管理（M-2，复用 models-manager KeyVault）

- vault 命名空间：`mcp:<id>:<refKey>`，safeStorage 加密，落 `userData/mcp-secrets.json`（0600 原子写）
- 落盘占位符 `{{DSH_VAULT:key}}` 或降级 `.credentials.yaml`（见 6.2 注）
- renderer 侧：env/headers 值输入框只写不读；列表 API 返回 `envRefs: { GITHUB_TOKEN: { configured: true } }`
- 删除 Server 时同步清理 vault 条目
- `backup.js` 白名单不包含该文件（继承"备份不含凭据"）

### 10.4 使用量观测实现要点

- 扫描器复用 `session-search.js` 的增量模式：按 `(path, size, mtime)` 缓存已解析文件，zstd 用 `fzstd` 流式解压
- 正则只匹配工具调用事件的 `name` 字段，`/^mcp__([a-z0-9-]+)__/`
- 默认聚合最近 30 天；UI 入口在 MCP 卡片行内，不做独立大页（保持"小问题不打开大面板"）

### 10.5 重启联动

配置变更 → `mcp:changed` 事件 → 设置页顶部提示条。[立即重启] 复用托盘"重启运行时"的既有 IPC（不新造重启逻辑）。

---

## 11. 验收标准

### 11.1 T-0 勘察门禁（先于一切开发）

| # | 勘察项 | 通过标准 |
|---|---|---|
| T0-1 | `dsh-mcp-client` 支持 sse/websocket 的 config 字段名（`url`/`headers`？） | 用 `--dump-config` + 官方文档双确认；不支持则远程传输降级为"仅展示 + 跳转文档" |
| T0-2 | patch 块写入后 `--dump-config` 是否能捕获格式错误 | 故意写坏一个块，验证非零退出；不能则验证降级为 YAML 语法校验 |
| T0-3 | 壳 spawn 的运行时子进程 env 是否传递到 MCP Server 进程 | 决定 vault 占位符方案 or `.credentials.yaml` 降级方案 |
| T0-4 | config schema 是否支持 per-server `enabled`/超时字段 | 支持则升级 D-3 为文件内标志 |

**T0-1/T0-2 任一不过 → 本模块整体延后**（不阻塞其他 v0.3.1 项），与 PREDEV T1 纪律一致。

### 11.2 功能验收

- [ ] A-1 导航 + 子页三卡片渲染正常（zh/en 双语）
- [ ] A-2 Registry 安装 → 预览对话框 → 保存 → patch 文件出现正确块（含 win32 包装）
- [ ] A-3 手动添加 stdio Server（npx 型）→ 落盘 `cmd /c` 包装（Windows）/ 原样（macOS）
- [ ] A-4 添加 sse Server（URL + header）→ 落盘正确；`serverName` 冲突被拒绝且提示可读
- [ ] A-5 禁用 → patch 块移除、settings 保留 enabled:false；重新启用 → 块恢复、env 敏感值不丢
- [ ] A-6 编辑 → 反向解包正确回显原始命令；保存后 dump-config 验证通过
- [ ] A-7 写坏场景：手动构造 patch 语法错误 → 保存失败 → 自动回滚 → 原文件字节不变
- [ ] A-8 导入：本机若有 Claude Desktop 配置 → scan 检出 → 导入 1 个 → 字段映射正确
- [ ] A-9 JSON 粘贴导入：`mcpServers` 对象与单 server 对象两种输入均可
- [ ] A-10 Tier2 测试真实 Server（如 filesystem）返回工具列表；超时/命令不存在给出可读错误
- [ ] A-11 敏感 env：设值后 settings.json / patch 文件 / 导出均无明文；UI 重开显示"已配置"
- [ ] A-12 用量行：有真实 MCP 调用的会话日志 → 卡片显示调用次数与最近使用
- [ ] A-13 配置变更 → 提示条出现 → 立即重启复用成功

### 11.3 测试验收（node --test，目标 ≥ 30 项）

- [ ] mcp-manager：CRUD × 8（含重复 id 拒绝、serverName 校验、win32 包装/解包、回滚）
- [ ] mcp-connect：Tier1 × 3（找到/未找到/远程 HEAD）、Tier2 mock × 3（成功列工具/超时/握手失败）、缓存 TTL × 1
- [ ] mcp-import：schema 映射 × 4（各来源 1 项）、命名冲突 × 1、粘贴解析 × 2
- [ ] mcp-usage：正则提取 × 2、聚合 × 2、zstd 文件 × 1
- [ ] vault：写入/清理/不落明文 × 3
- [ ] 回归：`npm test` 既有 376 项全绿；`grep` 复核无既有 channel 变更（C-2）

---

## 12. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| T0-1 失败：dsh-mcp-client 不支持远程传输字段 | 中 | 门禁前置；降级为"stdio only + 远程条目只读展示" |
| T0-3 失败：vault 占位符方案不通 | 中 | 降级 `.credentials.yaml` 明文凭据方案（0600 + 不进备份，安全线仍守住） |
| patch 文件被用户/其他工具并发修改 | 中 | 行级 patch 只动本块 + 写前备份 + dump-config 验证三重保险 |
| npx 首次下载导致 Tier2 超时误报 | 低 | 超时文案明确"首次运行需下载"；Tier1 已通过的命令给"命令存在但握手超时"分级提示 |
| 会话日志量大导致用量统计慢 | 低 | (path,size,mtime) 增量缓存 + 默认 30 天窗口 + worker 化（复用 session-worker 模式） |
| GitHub 搜索国内不可达 | 低 | 内置 12+ 离线列表为基线，在线失败静默降级 |
| 与另一并行会话改动冲突 | 中 | 本模块只碰 `src/mcp-*.js`、settings-store(追加)、settings.html(MCP 行)、settings-preload(MCP 段)、ipc 接线一处；禁碰 cost/boot-check/compat-status 等已交付文件 |

---

## 13. 附录

### 13.1 参考来源

- [Claude Code MCP 文档](https://docs.anthropic.com/en/docs/claude-code/mcp)（三作用域 / cmd /c 包装 / /mcp 命令）
- [Codex CLI MCP 管理](https://developers.openai.com/codex/mcp)（`config.toml` `[mcp_servers.*]`、enabled/timeout 字段、mcp login/logout）
- [VS Code MCP 服务器管理](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)（enable/disable 独立存储、两层健康检查、信任机制）
- [VS Code Agents 窗口 MCP UI PR #330207](https://github.com/microsoft/vscode/pull/330207)（状态可见性三规则）
- [Serena + DSH MCP 配置指南](https://gist.github.com/tonyzhu/933704e4fba6cb4938ebfa3b16683b4a)（cordis.patch.yml 实证格式）
- [dsh-plugin-mcp](https://npm.io/package/dsh-plugin-mcp)（DSH 生态 MCP 桥接的能力上限参考）

### 13.2 术语

- **patch 块**：`cordis.patch.yml` 中一个 `- id: … name: … config: …` 列表项
- **意图层 / 真相层**：settings.json（壳的意图，含禁用项）/ cordis.patch.yml（DSH 实际加载的启用项）
- **vault 引用**：敏感值的安全存储指针，明文永不出主进程

---

*v2 修订记录：对标四家成熟实现补齐 9 项差距（§2）；新增 T-0 勘察门禁（§11.1）；新增 mcp-import / mcp-usage 两模块；重写数据模型（enabled 策略、vault 引用、per-server 超时）；IPC 从 7 个扩展到 12 个 channel。*
