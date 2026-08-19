**[English](README.en.md)** | **简体中文**

<div align="center">

# 🛩️ DshCockpit

**把 DeepSeek Harness 变成一台常驻后台的 Agent 驾驶舱**

成本控制 · 用量监控 · 官方余额 · IM 渠道遥控 · 公网远程 · 模型管理 · 长会话压缩 · 技能市场 · 自动更新 · 定时任务 · 快捷问询 · 局域网手机操控 · 数据安全

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#)
[![Powered by](https://img.shields.io/badge/powered%20by-DeepSeek%20Harness-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

*让 `dsh web` 从"终端里的一个标签页"变成"双击即用、后台常驻、自动更新、会算账的桌面控制台"*

**English TL;DR** — DshCockpit is an open-source desktop cockpit (Electron) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): real-time **token usage & context-pressure alerts**, a **cost tracking center** with per-day/week/month/workspace stats, **official account balance** and per-turn exact spend, **IM channel remote control** (Feishu / WeCom / DingTalk long connections), **public-network remote** (Tailscale / Cloudflare), a **model manager** (third-party providers + local Ollama), **long-session compaction** and AGENTS.md memory files, a **Skills marketplace**, runtime **auto-update with smoke-test guard & one-click rollback**, a global-hotkey **Quick Ask** window, **scheduled agent tasks**, `Ctrl+K` **full-text session search**, and a community **plugin marketplace**. Bundled runtime — no Node.js install needed. Windows portable zip + macOS dmg (arm64/x64). *Full English readme → [README.en.md](README.en.md)*

</div>

---

## 💬 交流群

欢迎扫码进群，讨论使用问题、反馈建议，或聊聊 Agent 桌面化的玩法。

<div align="center">
<img src="photo/qrcode-group.png" width="260" alt="DshCockpit 交流群二维码" />
</div>

---

## ✨ 为什么选择 DshCockpit？

别的壳把 dsh web **装进窗口**；DshCockpit 把 dsh 变成**一台后台服务**，并在其上构建了四个其他项目都没有的差异化能力：

| | 浏览器版 `dsh web` | 其他桌面壳 | **DshCockpit** |
|---|---|---|---|
| 关闭窗口 | ❌ 会话就断 | ✅ 托盘常驻 | ✅ 托盘常驻 + 后台任务照跑 |
| 运行时更新 | ❌ 手动 npm | ❌ 无 | ✅ **自动更新管道 + 冒烟守卫 + 一键回滚** |
| Token 用量 | ❌ 只闪一下 | ❌ 无 | ✅ **实时胶囊 + 上下文压力预警** |
| 花费多少 | ❌ 不知道 | ❌ 无 | ✅ **成本中心：按天/周/月/工作区统计 + 预算报警** |
| 随手提问 | ❌ 要开浏览器 | ❌ 无 | ✅ **全局热键 Quick Ask（后台运行）** |
| 定时任务 | ❌ 无 | ❌ 无 | ✅ **壳级定时任务（间隔/每天 + 通知）** |
| 历史检索 | ❌ 手动翻 | ❌ 无 | ✅ **`Ctrl+K` 全文搜索全部会话** |
| IM 遥控 | ❌ 无 | ❌ 无 | ✅ **飞书/企微/钉钉官方长连接，群里审批/提问/遥控** |
| 公网远程 | ❌ 无 | ❌ 无 | ✅ **Tailscale / Cloudflare 隧道，出门在外也能遥控** |
| 花了多少钱 | ❌ 不知道 | ❌ 无 | ✅ **官方账户余额 + 每轮精确花费** |
| 模型选择 | ❌ 仅默认 | ❌ 无 | ✅ **第三方/本地 Ollama 模型管理** |
| 数据安全 | ✅ 本地 | ✅ 本地 | ✅ 本地 + **自动备份 + 隐私声明 + 备份不含密钥** |

**一句话：它们做"窗口"，我们做"控制台"。**

---

## 🚀 功能全景

### 🎛️ 驾驶舱级监控（独有）
- **Token 实时胶囊**：窗口右上角常驻显示当前会话 输入→输出 tokens；悬停看明细（当前/全部会话、缓存）；**上下文压力**达到 60%/85% 自动黄/红预警，提醒你"该开新会话了"。
- **成本控制中心**：按天/周/月统计 token 与估算费用（单价可配），**按工作区**看谁在烧钱；**月度预算 + 80%/100% 报警**，再也不会月底收到吓人的账单。
- **官方账户余额**：接入 DeepSeek 官方接口，实时显示总额/赠送/充值余额与刷新时间，余额不足标红提醒；**每轮对话精确花费**（输入/输出/缓存命中拆分 + 缓存节省额）。
- **峰谷分时计价**：托盘实时显示 ⚡峰时/🌙谷时状态与现行单价，成本统计按事件时间分桶（与官方 2026-08 分时定价同步）。

### 📱 IM 渠道遥控（独有）
把 Agent 接进你每天都在用的 IM——**任务完成、工具审批、Agent 提问三类事件直接推送到群里**，在 IM 里点按钮就能批准/拒绝审批、回答提问，还能直接发消息让 Agent 后台干活。
- 三渠道均走**官方长连接**（飞书长连接 / 企微智能机器人 / 钉钉 Stream Mode）：**无需公网 IP、无需端口映射、不经任何第三方服务器**
- 每个渠道独立白名单（配对准入），陌生联系人无法触达你的 Agent
- 审批按钮携带**一次性令牌（120 秒有效、用后即焚）**，防重放；渠道凭据系统加密存储（Keychain / DPAPI）
- 设置 → 渠道：分步接入引导（在哪建应用、勾哪些权限一页说清）+ 连接测试

### 🌐 公网远程（独有）
手机遥控突破「同一 Wi-Fi」限制，两种方式任选：
- **Tailscale（推荐）**：壳自动检测本机 Tailscale，已登录即生成 `http://100.x.y.z:31780` 配对链接（含二维码）；手机装 Tailscale 登录同账号，4G/5G 下即可完整使用
- **Cloudflare 临时隧道**：一键启动 cloudflared 免费隧道，手机**无需装任何 App**，浏览器打开 trycloudflare.com 链接即用
- 安全默认值：公网模式**默认关闭**，开启需二次确认并展示公共网络警告；配对码有效期收紧至 5 分钟、审计日志记录所有公网配对事件

### 🧠 模型管理
- 内置 6 家常用第三方模板（硅基流动 / Kimi / 智谱 / 通义 / 火山方舟 / OpenRouter）+ 自定义：填 baseURL 和 Key 即可，**连接测试 + 模型列表拉取**
- **Ollama 一键接入**：检测到本机 Ollama 自动注册为 provider，本地模型当默认模型，零成本跑 Agent
- API Key 系统加密存储，运行时配置热加载（新会话生效，无需重启）

### 📚 长会话管理
- **一键压缩当前会话**（Token 胶囊右键 / 设置页）：调用运行时原生 `/compact`，完成后显示**前后 token 对比与预估节省金额**
- 压力预警按「最近一次请求的真实上下文占用」计算（此前按全历史累计，长会话下误报偏红）
- **AGENTS.md 记忆文件管理**：工作区级与全局记忆文件在线编辑，新会话自动生效

### 🧩 技能（Skills）市场
- 浏览 / 搜索 GitHub 技能生态，**安装前可预览 SKILL.md 全文**（防注入）
- 兼容 **Claude Skill 格式**（SKILL.md frontmatter 校验，不兼容给可读错误）；支持本地目录导入
- 安装即生效（运行时热加载，新会话可见），失败自动清理不留半成品

### 🔄 更新体系（双层解耦，坏版本不激活）
- **运行时更新**：registry 检查 → 安装 → **`--dump-config` 冒烟测试守卫**（坏版本绝不激活）→ 待应用 → 切换（自动快照 DSH_HOME）→ **一键回滚**。安装有 **10 分钟硬超时 + Node engines 预检**；更新时弹出**程序内进度终端**（实时显示阶段与已用秒数），长安装不再像卡死。
- **壳自身更新**：自动检查（启动 + 每 4h）→ **更新说明对话框**（展示 GitHub Release 正文）→ 立即重启。

### ⚡ 后台 Agent 服务（独有）
- **Quick Ask（全局快捷问询）**：默认 `Ctrl+Alt+Space` 弹出小窗，随手提问 → 后台无头会话运行 → 完成通知。写代码时不用切窗口就能问。
- **定时任务**：每天/每周/每间隔跑固定提示词（日报、周报、清理），到点自动执行 + 系统通知 + 运行历史。
- **任务完成通知**：窗口最小化时，agent 跑完长任务、有人要审批、有提问待回答，都会系统通知你。
- **手机远程控制（局域网）**：手机连同一 Wi-Fi，把设置页显示的**配对链接**（含一次性配对码，可一键复制）发到手机、用浏览器打开即完成配对，之后可完整使用 dsh Web UI——查看会话流式输出、发消息/插话、**审批工具执行、回答提问**。默认「微信/抖音打开兼容模式（HTTP）」可直接打开；一次性配对码 + 加密长期令牌，运行时仍只监听 127.0.0.1（详见 DESIGN.md §17）。

### 🔍 历史与检索
- **`Ctrl+K` 会话全文检索**：跨全部历史会话按关键词搜索（片段高亮 + 一键复制）。
- **会话自动备份**：退出时备份 + 手动备份，保留 N 份；升级/回滚另有 DSH_HOME 快照。

### 🧩 生态与体验
- **插件市场**：基于 **awesome-dsh-plugin 社区精选列表**（CC0-1.0），**14 个分类**导航 + 搜索，市场内嵌设置 → 插件 子页；安装有进度反馈、失败自修复与残留清理。
- **双语界面**（中文 / English，可跟随系统）；托盘、通知、设置全本地化。
- 快捷键（`Ctrl+,` 设置 / `Ctrl+K` 搜索 / `Ctrl+R` 重载 / `Ctrl+Shift+I` 开发者工具）。
- 首次运行引导、窗口位置记忆、崩溃自动重启（60s 内 3 次防循环）、**孤儿进程看门狗**（壳崩溃自动清理运行时，不留幽灵进程）。
- 存储管理（占用可视化 + 一键清理）、崩溃诊断记录。

### 🛡️ 数据与隐私
- **完全本地运行**。设置界面明示：**不收集、不上传、不存储**你的个人信息、API Key、会话内容与用量数据。
- 备份刻意**不含 API 凭据**（防明文密钥扩散）；运行时下载全程 sha512 校验；harness 自带文件沙箱与审批机制原样保留。

---

## 🚀 快速开始

### 方式一：Windows 便携版
从 [Releases](https://github.com/Lxiayu/DshCockpit/releases) 下载 `DshCockpit-<version>-win-x64.zip` → **用 7-Zip/WinRAR 解压** → 双击根目录的 `DshCockpit.exe`。
> **约 9 秒开窗**（首次启动若 DSH_HOME 尚未初始化会多花约 20–30 秒建立 profile），内置运行时，无需安装 Node/dsh、无需联网下载。后续版本自动更新。
> 若内置运行时被解压工具截断（极少见），应用会自动尝试从 npm registry 安装兜底，并按提示用 7-Zip 重新解压。

### 方式二：macOS 安装包（.dmg）
从 [Releases](https://github.com/Lxiayu/DshCockpit/releases) 下载对应架构的 `.dmg`：
- **Apple Silicon（M1/M2/M3/M4）**：`DshCockpit-<version>-mac-arm64.dmg`
- **Intel Mac**：`DshCockpit-<version>-mac-x64.dmg`

双击挂载 → 把 `DshCockpit` 拖进「应用程序」→ 在启动台/访达双击启动。

> ⚠️ **首次打开会提示「已损坏」或「无法验证开发者」**：当前 macOS 包**尚未签名公证**（暂无 Apple Developer 证书），这是 Gatekeeper 的正常拦截，应用本身没坏。任选其一放行即可：
> - **图形界面**：先双击一次（弹出警告点取消）→「系统设置 → 隐私与安全性」→ 滚到底部点「仍要打开」→ 再点「打开」。
> - **终端一行**（推荐，最快）：
>   ```bash
>   xattr -dr com.apple.quarantine /Applications/DshCockpit.app
>   ```
>
> 放行一次后即可永久正常启动。后续接入 Apple 签名公证后此提示会消失。

### 方式三：从源码运行（推荐给开发者/尝鲜者）
```bash
# 前置：Node.js ≥ 22；推荐本机已安装 @deepseek-ai/dsh（未安装时首次启动会自动下载）
git clone https://github.com/Lxiayu/DshCockpit.git
cd DshCockpit
npm install
npm start
```

首次启动后：
1. 在窗口的 Harness 设置里配置你的 DeepSeek API Key（右上角齿轮有红点提示）；
2. 把工作区文件夹拖到右上角工具条（或设置里选择）；
3. 开始对话——右上角胶囊实时显示 token 用量。

---

## 📸 界面预览

<div align="center">

<img src="photo/preview-1.png?v=0.2.4" width="720" alt="DshCockpit main window — DeepSeek Harness (dsh) desktop cockpit with token usage capsule" />

<table><tr>
<td><img src="photo/preview-2.png?v=0.2.4" width="280" alt="Cost center — token cost tracking & budget alerts" /></td>
<td><img src="photo/preview-3.png?v=0.2.4" width="280" alt="Settings & plugin marketplace" /></td>
</tr></table>

</div>

---

## 🏗️ 技术架构

```
DshCockpit (Electron)
 ├─ 运行时管理：版本目录 + 更新管道（Arborist 安装 / 冒烟测试 / 切换 / 回滚）
 ├─ 数据层：会话解析（zstd）、成本历史、官方余额、全文检索、备份/快照
 ├─ 事件流：订阅运行时 WebSocket（任务完成 / 审批 / 提问）
 ├─ 服务：Quick Ask、定时任务调度器、插件/技能市场、模型管理、崩溃看门狗
 ├─ 渠道：IM 渠道管理器（飞书 / 企微 / 钉钉长连接）+ 手机远程网关（局域网/公网）
 └─ 界面：壳设置窗口 + 窗口内 chrome（token 胶囊 / 快捷入口）
```

- **壳与运行时彻底解耦**：运行时版本化共存于 `userData/runtime/`，互不干扰；
- 接口面刻意做小：spawn 参数、URL 行、HTTP/WS——上游怎么改都不影响壳。

---

## 🗺️ 路线图

> 完整竞争分析与验收标准见 [`ROADMAP.md`](ROADMAP.md)。

- [x] 运行时/壳双层自动更新 + 回滚
- [x] Token 监控 + 成本中心 + 预算报警
- [x] Quick Ask + 定时任务 + 任务/审批通知
- [x] 会话全文检索 + 自动备份 + 隐私声明
- [x] 插件市场 + 双语界面 + 便携打包（内置运行时）
- [x] macOS 构建（CI 自动产出 arm64 + x64 包）
- [x] 手机远程控制（局域网安全网关：配对 + 审批 + 会话）
- [x] IM 渠道遥控（飞书 / 企微 / 钉钉官方长连接）
- [x] 公网远程（Tailscale / Cloudflare 隧道）
- [x] 官方账户余额 + 每轮精确花费
- [x] 模型管理（第三方模板 + Ollama 本地模型）
- [x] 长会话压缩 + AGENTS.md 记忆文件
- [x] 技能（Skills）市场
- [ ] macOS 代码签名与公证
- [ ] 代码签名（Windows Authenticode）
- [ ] 系统钥匙串集成（凭据加密）
- [ ] 更多工作流

---

## 🤝 贡献

欢迎 PR！请先跑 `npm test`（230 项单元测试）。架构细节见 [`DESIGN.md`](DESIGN.md)，功能清单见 [`FEATURES.md`](FEATURES.md)。

## 📄 许可证

[MIT](LICENSE)

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 本项目所驱动的 Agent 运行时与 Web UI
- IM 渠道设计参考 [dsh-im-bridge](https://github.com/search?q=dsh-im-bridge) 等 MIT 项目；余额展示范式参考 dms-deepseekbalance（MIT）；技能生态兼容 [Claude Skill](https://agentskills.io) 格式（Anthropic）
- 所有贡献过社区桌壳与插件的开发者
