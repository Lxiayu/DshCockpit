**简体中文** | **[English](README.en.md)**

<div align="center">

# 🛩️ DshCockpit

**不是给 dsh 再套一个窗口——而是一个桌面控制平面。**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#)
[![Tests](https://img.shields.io/badge/tests-311%20passing-brightgreen)](#)
[![Powered by](https://img.shields.io/badge/powered%20by-DeepSeek%20Harness-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

DshCockpit 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）从一条终端命令变成常驻桌面的 Agent 服务：Harness 工作区保持 100% 原生，壳只在其外补齐安全更新、成本核算、后台任务、远程访问——全部通过稳定接口完成。内置运行时，无需安装 Node.js。

</div>

---

## 💬 交流群

欢迎扫码进群，讨论使用问题、反馈建议，或聊聊 Agent 桌面化的玩法。

<div align="center">
<img src="photo/qrcode-group.png" width="260" alt="DshCockpit 交流群二维码" />
</div>

---

## 为什么需要它？

如果你每天用 `dsh` 跑 Agent，有三个问题始终绕不开：

| 问题 | 实际会发生什么 |
|---|---|
| **更新全靠赌** | 上游 rc 版几天一个，手动升级可能弄坏 profile，降级等于重装。 |
| **花了多少钱是黑盒** | 没有用量接口、没有花费面板——等账单到了才知道一次调试狂欢的价格。 |
| **Agent 活在一个窗口里** | 关掉窗口（或合上盖子），长任务就死了；审批请求只能等你回来。 |

常见的桌面壳对这三个问题都无能为力——它们只是把同一个窗口装进托盘。DshCockpit 把 Agent 当作**需要运维的服务**，窗口只是它恰好可见的地方。

## 你能得到什么

### 1 · 一个不会把自己搞坏的运行时

新版本并行安装，必须先通过 `--dump-config` 冒烟测试才允许激活，切换是原子操作。坏版本永远激活不了；一键回滚会同时恢复上一版本**和**数据目录快照。更新自动跟随官方 npm 通道——不 vendor、不分叉、不落后于上游。

### 2 · 成本与用量可观测

- **上下文压力常驻**：安静的胶囊实时显示当前会话输入/输出/缓存 token，60%/85% 预警，一键压缩
- **成本中心**：按天/周/月统计，按工作区归因，峰谷分时计价，月度预算 80%/100% 报警
- **官方余额**：实时显示总额/赠送/充值，精确到每轮对话花费与缓存节省

全部在本地从会话日志计算（纯 JS zstd 解压），零遥测。

### 3 · 你不盯着它也能干活

- **Quick Ask** — `Ctrl+Alt+Space` 随手提问，后台运行，完成通知
- **定时任务** — 日报、周期任务、运行历史
- **IM 渠道** — 飞书 / 企微 / 钉钉：任务完成、审批请求、Agent 提问直达群聊，点按钮即可处理
- **手机远程** — 手机浏览器完整 UI，经鉴权局域网网关配对；Tailscale / Cloudflare 出门在外也能连
- **会话检索** — `Ctrl+K` 全文搜索全部历史；退出自动备份

还有：模型管理（6 家预设 + Ollama 本地模型）、插件与技能市场（安装前可预览）、双语界面、深浅主题。

### 横向对比

| | 裸 `dsh web` | 一般桌面壳 | **DshCockpit** |
|---|---|---|---|
| 双击即用、内置运行时 | ❌ | ✅ | ✅ |
| 更新门禁 + 回滚 + 数据快照 | ❌ | ❌ | ✅ |
| Token/上下文压力 + 预算报警 | ❌ | ❌ | ✅ |
| 按工作区的成本分析 | ❌ | ❌ | ✅ |
| 全局热键后台提问 | ❌ | ❌ | ✅ |
| 定时任务 | ❌ | ❌ | ✅ |
| 会话全文检索 | ❌ | ❌ | ✅ |
| 鉴权手机远程 | ❌ | 罕见 | ✅ |
| 运行**未魔改的官方运行时** | — | 常见 vendor/分叉 | ✅ 始终 |

## 零侵入设计

壳从不给上游源码打补丁，从不碰它的内部实现。所有集成只走稳定边界：HTTP/WebSocket、文件系统（会话日志）、CLI 参数（`--dump-config`、端口发现）与显式 IPC。"Harness 可以变，DshCockpit 保持有用"在这里是工程性质，不是口号。详见 [`DESIGN.md`](DESIGN.md)。

## 🚀 快速开始

**Windows**：从 [Releases](https://github.com/Lxiayu/DshCockpit/releases) 下载 `DshCockpit-<version>-win-x64.zip` → 用 7-Zip/WinRAR 解压 → 双击根目录 `DshCockpit.exe`。约 9 秒开窗，后续版本自动更新。

**macOS**：下载对应架构的 `.dmg`（Apple Silicon / Intel）→ 拖入「应用程序」→ 启动。

> ⚠️ 尚未签名公证——Gatekeeper 会拦截一次，终端执行一次即可永久放行：
> ```bash
> xattr -dr com.apple.quarantine /Applications/DshCockpit.app
> ```

**从源码运行**（Node ≥ 22）：
```bash
git clone https://github.com/Lxiayu/DshCockpit.git && cd DshCockpit
npm install && npm start
```

首次启动：设置 DeepSeek API Key（齿轮有红点提示）→ 选择工作区 → 开始对话。其余一切都是可选的。

## 📸 界面预览

<div align="center">

<img src="photo/preview-1.png?v=0.2.7" width="720" alt="原生 DeepSeek Harness 工作区 + DshCockpit Edge Rail 上下文状态" />

<table><tr>
<td><img src="photo/preview-2.png?v=0.2.7" width="280" alt="成本中心：工作区花费、预算与报警" /></td>
<td><img src="photo/preview-3.png?v=0.2.7" width="280" alt="控制中心与插件市场" /></td>
</tr></table>

</div>

## 诚实的局限

- macOS 包尚未签名公证（需要上面那行 `xattr`）；Windows 可能因同样原因触发 SmartScreen
- 单人维护的项目；主要在作者自己的机器上实战验证
- Windows 是主要开发目标；macOS arm64/x64 由 CI 构建并冒烟测试，但真实环境里程较少

## 🤝 贡献

欢迎 PR！请先跑 `npm test`（311 项测试）。架构见 [`DESIGN.md`](DESIGN.md)，产品理念见 [`PHILOSOPHY.md`](PHILOSOPHY.md)，功能清单见 [`FEATURES.md`](FEATURES.md)，竞争路线图见 [`ROADMAP.md`](ROADMAP.md)。

<details>
<summary><b>操作层原则（产品理念）</b></summary>

Harness owns the workspace. DshCockpit owns the operating layer.

工作区——对话、文件、代码、审批——属于 Harness，保持原样。它周围的一切——监控、成本、自动化、更新、远程——属于驾驶舱。高频操作保持可见；Settings 只放持久配置；小问题永远不打开大面板（`默认 → Peek → Cockpit → 完整配置`）。Agent 不是窗口：它是持续运行、持续累积用量、随时接受指令的桌面服务，与前台是什么无关。

完整理念见 [`PHILOSOPHY.md`](PHILOSOPHY.md)。
</details>

## 📄 许可与致谢

[MIT](LICENSE) · 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建。社区项目——与 DeepSeek 官方无隶属关系，也未获其背书。
