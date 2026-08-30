# DshCockpit v0.3.1 — MCP 服务管理

> **Harness owns the workspace. DshCockpit owns the operating layer.**

v0.3.1 新增 **MCP（Model Context Protocol）服务管理**：在设置页可视化地添加、测试、启用/禁用 MCP Server，无需手动编辑 `cordis.patch.yml`。入口：设置 → MCP 服务，或驾驶舱面板 → 快捷操作 → 🔌 MCP 服务。

---

## 下载（应该下载哪个？）

| 你想要 | 下载文件 |
|---|---|
| **Windows · 推荐安装**（应用内自动更新、开始菜单/桌面快捷方式） | `DshCockpit-0.3.1-win-x64.exe` |
| Windows · 绿色便携（免安装，解压即用） | `DshCockpit-0.3.1-win-x64.zip` |
| **macOS Apple Silicon · 推荐安装** | `DshCockpit-0.3.1-mac-arm64.dmg` |
| macOS Apple Silicon · 完整便携 zip | `DshCockpit-0.3.1-mac-arm64.zip` |
| macOS Apple Silicon · 精简包（不含内置运行时） | `DshCockpit-0.3.1-slim-mac-arm64.zip` |
| macOS Intel | `DshCockpit-0.3.1-mac-x64.dmg` |

> **每个文件可单独下载**。SHA256 校验见 `SHA256SUMS-*.txt`。
> 从 v0.3.0 升级：Windows 安装版会收到应用内更新提示；其他渠道手动下载覆盖。

---

## 新增：MCP 服务管理

### 配置与管理
- **可视化添加/编辑/移除** MCP Server，写入 DSH 的 `cordis.patch.yml`（只改动对应配置块，写入前备份、写入后经 `--dump-config` 校验，失败自动回滚）
- **手动配置（JSON）**：粘贴 `mcpServers` JSON 即导入——支持带 `//` 注释与尾逗号的示例格式（与 Trae 的手动配置方式一致）；也支持从 Claude Desktop / Claude Code / VS Code / Cursor 的现有配置一键导入
- **启用/禁用开关**：禁用保留配置，重新启用即恢复；配置变更后提示重启运行时生效

### 发现（Registry）
- 内置 20 个常用 MCP Server 离线清单（Filesystem / GitHub / Git / PostgreSQL / SQLite / Brave Search / Memory / Sequential Thinking / Fetch / Time / Google Drive / Maps / Puppeteer / Playwright / Serena / Slack，以及 Notion / Sentry / Stripe / Linear 官方远程端点）
- 接入 **官方 MCP Registry**（registry.modelcontextprotocol.io）：命名空间经 GitHub/DNS 验证的条目自动生成安装配置（npm → `npx`，PyPI → `uvx`，远程端点 → SSE），带"已验证来源"标记
- 关键词搜索时补充 GitHub `topic:mcp-server` 社区结果（无验证命令的条目提示需手动填写命令）
- 网络不可用时离线清单完整可用

### 测试与观测
- **测试连接**：启动 MCP Server 进程完成 MCP 握手（initialize → tools/list），返回发现的工具列表；首次运行需下载依赖时有提示
- 命令存在性/URL 可达性的静默快查（结果缓存 5 分钟）
- **使用量统计**：从会话日志统计每个 MCP Server 的工具调用次数、最近使用时间与常用工具（基于本地会话记录，不上传）
- Windows 上 `npx` 等命令自动包装为 `cmd /c` 执行（界面始终显示原始命令）
- 环境变量中的敏感值经系统加密存储（macOS 钥匙串 / Windows DPAPI），不写入任何配置文件，重启运行时后经运行时环境注入生效

### 安全提示
- MCP Server 会在本机执行第三方命令，可能访问你的文件与凭据。安装前请确认来源：优先选择官方命名空间（`io.modelcontextprotocol/*`）与已验证的 Registry 条目，只添加你信任的服务。

---

## 其他变更

- 驾驶舱快捷操作新增「🔌 MCP 服务」入口（控制中心与设置窗口均可直达）
- 主进程 MCP 配置写入带验证回滚；日志扫描在使用独立 worker 线程执行

---

## 升级说明

- 从 v0.2.x / v0.3.0 升级：数据（会话、设置、凭据）原样保留
- macOS 未签名版本首次打开：右键 → 打开，或终端执行 `xattr -dr com.apple.quarantine /Applications/DshCockpit.app`
- Windows 安装版（v0.3.0 起）将收到应用内自动更新提示