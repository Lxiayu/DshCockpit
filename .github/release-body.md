<!-- NOTE: this body is attached to EVERY tag release (body_path in
     release-win/release-mac workflows). Refresh the prose per version and
     keep the download table version-agnostic — pinned filenames become dead
     links the moment a new version ships. -->

# DshCockpit v0.3.2 — 计费对齐 V4.1、上下文 1M、测试全绿

> **Harness owns the workspace. DshCockpit owns the operating layer.**

v0.3.2 是一个**准确性与可靠性**版本：成本中心对齐 DeepSeek 官方 2026-09-10 起的 V4.1 定价，上下文压力改用真实 1M 窗口，会话日志改为按世代读取（为后续运行时升级铺路），并修平了 Windows 下长期存在的 7 项测试失败。

---

## 下载（应该下载哪个？）

| 你想要 | 下载文件（`<版本>` 以本 Release 资产列表为准） |
|---|---|
| **Windows · 推荐安装**（应用内自动更新、开始菜单/桌面快捷方式） | `DshCockpit-<版本>-win-x64.exe` |
| Windows · 绿色便携（免安装，解压即用） | `DshCockpit-<版本>-win-x64.zip` |
| **macOS Apple Silicon · 推荐安装** | `DshCockpit-<版本>-mac-arm64.dmg` |
| macOS Apple Silicon · 完整便携 zip | `DshCockpit-<版本>-mac-arm64.zip` |
| macOS Apple Silicon · 精简包（不含内置运行时） | `DshCockpit-<版本>-slim-mac-arm64.zip` |

> Intel Mac：v0.3.3 起 CI 不再发布 x64 包（可在 Apple Silicon Mac 上用 electron-builder 自行交叉构建）。

> 从 v0.3.1 升级：Windows 安装版会收到应用内更新提示；其他渠道手动下载覆盖，数据原样保留。

---

## 修复与改进

### 成本中心对齐 V4.1 官方定价
- `deepseek-flash`（DeepSeek-V4.1-Flash）成为默认模型：**输入 ¥1 / 输出 ¥4 / 缓存命中 ¥0.02**（每百万 tokens，空闲时段），高峰时段 ×2（周一至周五 9–12、14–18）
- 旧模型名（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-chat`、`deepseek-reasoner`）自动归一到 Flash 档——官方已由 V4.1-Flash 提供服务并按 Flash 价计费
- 修正后：此前按 V4-Flash 旧价估算会**高估约 50% 输入成本、2.5 倍缓存命中成本**，缓存节省额也会被算错
- 单轮成本、缓存经济学、周报卡片、余额提醒共用同一价目表

### 上下文压力改用 1M 窗口
- V4.1-Flash / V4-Pro 的上下文窗口是 **1M**，此前默认按 128k 估算 → **压力百分比虚高约 8 倍**，60%/85% 预警频繁误报
- 默认值改为 1M；**只有仍是旧默认值（未被你自定义过）的配置会自动迁移**，手动改过的不动
- 设置页提示同步更新

### 会话日志按世代读取（面向未来）
- 新版 Harness 的会话日志按**不可变世代**命名（`session.jsonl[.zstd]` = v0，`session.v1|v2|v3...jsonl[.zstd]`），运行时读最高世代
- 壳统一改为"每个会话只取最高世代"（绝不跨世代求和），避免升级运行时后 Token/成本/搜索读不到新会话

### MCP 配置跟随运行时版本
- 0.1.5+ 的 `dsh-mcp-client` 只接受 `transport: stdio | streamable-http` 且工具超时键为 `toolCallTimeoutMs`（毫秒）；旧版接受 `stdio | sse | websocket`
- 现在**按当前激活运行时的版本写对应词汇**，升级前不会把配置写坏

### 事件流健壮性
- 若运行时不再提供 `/api/events.*`（0.1.2+ 已改为 `/api/remote.mux`），壳会打一条明确日志并退避到 60s，而不是每 3 秒无意义重连

### 其他修复
- 修复 Windows 下 MCP 服务器命令为**绝对路径**时被误判为"命令不存在"（`where.exe` 不接受路径模式）
- 测试基线：**469 项测试在 Windows 全绿**（此前 7 项平台性失败：POSIX 0600 断言、跨盘符路径假设、shim 执行方式等）；macOS/Linux 逻辑不变

---

## 关于内置运行时（重要）

- 本版内置运行时仍为 **`0.1.1-rc.2`**（已验证），你现有的一切功能不受影响
- 上游 0.1.5 重做了整个远程 API：所有 `/api/*` 需浏览器会话 Cookie，事件流改为 `/api/remote.mux`（`$events` 流复用协议），`/api/session.list`、`/api/respond` 已移除，审批/提问改用 `$events/result` 回执
- 壳对这些接口的完整适配正在进行，**将随 v0.4.0 发布**；届时运行时可升级到 0.1.5，并同时保持通知、审批推送、IM 审批与按轮成本可用
- 如果你现在手动把运行时升级到 0.1.5：界面与对话可用，但**通知、IM 推送与按轮成本会暂停**（壳会在运行日志中说明原因）

---

## 升级说明

- 从 v0.2.x / v0.3.x 升级：数据（会话、设置、凭据）原样保留
- macOS 未签名版本首次打开：右键 → 打开，或终端执行 `xattr -dr com.apple.quarantine /Applications/DshCockpit.app`
- Windows 安装版将收到应用内自动更新提示
