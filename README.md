**[English](README.en.md)** | **简体中文**

<div align="center">

# 🛩️ DshCockpit

**把 DeepSeek Harness 变成一台常驻后台的 Agent 驾驶舱**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#)
[![Powered by](https://img.shields.io/badge/powered%20by-DeepSeek%20Harness-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

> **Harness owns the workspace. DshCockpit owns the operating layer.**

DshCockpit 是一个开源的 DeepSeek Harness 桌面控制层（Electron）：双击即用、托盘常驻、自动更新、会算账——Harness 保持 100% 原生工作区，一切监控、自动化与运行时管理都发生在独立 Cockpit 控制层。内置运行时，无需安装 Node。Windows 便携版 + macOS dmg（arm64/x64）。

</div>

---

## 💬 交流群

欢迎扫码进群，讨论使用问题、反馈建议，或聊聊 Agent 桌面化的玩法。

<div align="center">
<img src="photo/qrcode-group.png" width="260" alt="DshCockpit 交流群二维码" />
</div>

---

## 🚀 功能

### 🎛️ 监控
- **Token / Context**：右上角 Edge Rail 常驻显示用量与上下文压力，点击展开明细（输入/输出/缓存），60%/85% 自动预警，内置一键压缩
- **成本中心**：按天/周/月/工作区统计花费，月度预算 80%/100% 报警，支持峰谷分时计价
- **官方余额**：实时查看 DeepSeek 账户余额（总额/赠送/充值），每轮对话精确到分

### � 遥控与自动化
- **手机远程**：手机浏览器即可使用完整 dsh 界面（看会话、发消息、审批、提问）；局域网一键配对，Tailscale / Cloudflare 支持出门在外也能连
- **IM 渠道遥控**：飞书 / 企微 / 钉钉官方长连接，任务完成、审批、提问直接推到群里，群里点按钮即可处理
- **Quick Ask**：`Ctrl+Alt+Space` 全局热键随手提问，后台运行、完成通知
- **定时任务**：日报周报自动跑，支持每天/每周/间隔，运行历史可查

### 🛠️ 运行时与数据
- **运行时管理**：自动更新 + 冒烟测试守卫 + 一键回滚，安装进度实时显示
- **会话检索**：`Ctrl+K` 全文搜索全部历史会话；退出自动备份
- **长会话**：一键 `/compact` 压缩并显示前后 token 对比与节省金额；AGENTS.md 记忆文件在线编辑

### 🧩 生态与体验
- **模型管理**：6 家第三方模板 + 自定义 + Ollama 本地模型，连接测试即配即用
- **插件 + 技能市场**：14 分类社区插件、Claude Skill 技能市场，安装前可预览
- 双语界面、深/浅主题、数据完全本地（不收集、不上传、备份不含密钥）

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

> ⚠️ **首次打开会提示「已损坏」或「无法验证开发者」**：当前 macOS 包**尚未签名公证**（暂无 Apple Developer 证书），这是 Gatekeeper 的正常拦截，应用本身没坏。终端执行一次即可永久放行：
> ```bash
> xattr -dr com.apple.quarantine /Applications/DshCockpit.app
> ```

### 方式三：从源码运行（推荐给开发者/尝鲜者）
```bash
# 前置：Node.js ≥ 22；推荐本机已安装 @deepseek-ai/dsh（未安装时首次启动会自动下载）
git clone https://github.com/Lxiayu/DshCockpit.git
cd DshCockpit
npm install
npm start
```

首次启动后：
1. 在原生 Harness 设置里配置你的 DeepSeek API Key（右上角齿轮有红点提示）；
2. 通过 Edge Rail 的 Settings 或工作区入口选择工作区；
3. 开始对话——Edge Rail 持续显示 Context 状态，需要时点击 Cockpit 管理 Agent。

---

## 📸 界面预览

<div align="center">

<img src="photo/preview-1.png?v=0.2.5" width="720" alt="DshCockpit main window — native DeepSeek Harness workspace with Edge Rail and Context status" />

<table><tr>
<td><img src="photo/preview-2.png?v=0.2.5" width="280" alt="Cost center — token cost tracking & budget alerts" /></td>
<td><img src="photo/preview-3.png?v=0.2.5" width="280" alt="Settings & plugin marketplace" /></td>
</tr></table>

</div>

---

## 🤝 贡献

欢迎 PR！请先跑 `npm test`（全部单元测试）。架构细节见 [`DESIGN.md`](DESIGN.md)，产品理念见 [`PHILOSOPHY.md`](PHILOSOPHY.md)，功能清单见 [`FEATURES.md`](FEATURES.md)。

## 📄 许可证

[MIT](LICENSE)

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 本项目所驱动的 Agent 运行时与 Web UI
- IM 渠道设计参考 [dsh-im-bridge](https://github.com/search?q=dsh-im-bridge) 等 MIT 项目；余额展示范式参考 dms-deepseekbalance（MIT）；技能生态兼容 [Claude Skill](https://agentskills.io) 格式（Anthropic）
- 所有贡献过社区桌壳与插件的开发者

---

## 💡 产品理念

<details>
<summary><b>不是另一个 Harness UI —— Harness owns the workspace. DshCockpit owns the operating layer.</b></summary>

DshCockpit 不替代、不改造、不修改 Harness WebUI。Harness 负责工作区（对话、看文件、写代码、完成任务）；DshCockpit 负责 Harness 之外的**操作系统层**：监控、快捷问询、后台任务、成本、运行时管理、检索、远程、集成、桌面级自动化。

核心交互原则：

> **工作时隐形，需要时显现**（Invisible when working. Obvious when needed.）

三条产品纪律：

- **Cockpit，不是 Settings**：高频能力常驻可见（Token / Cockpit / Quick Ask / Tasks），状态与操作进 Control Center，Settings 只做持久配置——设置页不是功能集散地，而是配置中心
- **渐进披露**：`默认 → Peek → Cockpit → 完整配置`，小问题不打开大面板
- **Agent ≠ 当前窗口**：Agent 是持续可管理的桌面服务——后台运行、定时任务、远程指令、用量累积、运行时更新，与工作区是否在前台无关

工程上坚持**零侵入**：只依赖 HTTP / WebSocket / IPC / 文件系统等稳定边界，不依赖 Harness 的 DOM、CSS、组件内部实现——兼容性本身就是产品特性，**Harness 可以变，DshCockpit 保持有用**。

一句话：

> **DshCockpit 是 DeepSeek Harness 的桌面控制平面。**
> Harness owns the workspace. DshCockpit owns the operating layer.

完整理念（英文）见 [`PHILOSOPHY.md`](PHILOSOPHY.md)。
</details>
