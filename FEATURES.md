# DshCockpit — 功能与特色

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）变成**双击即用的桌面产品**：自动更新、数据安全、用量监控、后台任务——不只是"套个窗口"。

## 一句话

**别的壳把 dsh web 装进窗口；DshCockpit 把 dsh 变成一台常驻后台的 Agent 服务，并提供完整的桌面产品体验。**

---

## 🚀 三大差异化王牌

### 1. 运行时级自动更新（坏版本不激活）
- 双层更新：**壳**（electron-updater，更新说明对话框 + 立即重启）与**运行时**（registry 检查 → 安装 → **`--dump-config` 冒烟测试守卫** → 待应用 → 切换）完全解耦；
- 坏版本**绝不激活**：冒烟失败自动标记 broken，保留当前版本；一键回滚 + DSH_HOME 快照；
- 预览版快速迭代期，这是最硬核的稳定性保障。

### 2. Token 用量与成本控制中心
- 独立 Edge Rail：Harness 保持原生工作区，DshCockpit 只显示 Token / Context、Cockpit、Settings 三个轻量入口；
- Token Peek：点击即可查看当前/全部会话输入输出、缓存、**上下文压力进度**（按最近一次请求真实占用计算，快满提示开新会话）；
- Cockpit Control Center：从一个操作层进入 Runtime、成本、后台任务、Quick Ask、Remote、Session Search 和 Integrations；Settings 只承担持久配置；
- **成本估算**：按天/周/月统计（换算金额），**按工作区**看谁在烧钱，**月度预算 + 80%/100% 报警**；
- **官方余额（v0.2.4）**：接入 DeepSeek 官方接口，实时显示账户余额（总额/赠送/充值），每轮对话精确花费与**缓存命中节省额**，低余额提醒；
- 单价表：v4-flash / v4-pro × 峰谷分时矩阵，与官方 2026-08 分时计价同步；
- 数据来自会话日志本地解析（zstd 纯 JS 解压），**完全离线、不上传**（余额查询仅在你配置 Key 后直连官方 API）。

### 3. 后台 Agent 服务（Quick Ask + 定时任务）
- **全局热键**（默认 Ctrl+Alt+Space）弹出快捷问询：随手提问 → 后台 headless 会话运行 → 完成通知；
- **壳级定时任务**：每天/每间隔跑固定提示词（日报、总结、清理），到点自动执行 + 通知；
- 窗口最小化照常工作——dsh 从"一个窗口"变成"常驻能力"；Tasks 在 Cockpit 中先 Peek 状态，再进入完整管理。

### 4. 独立桌面控制层
- Harness owns the workspace：不修改 Harness DOM、CSS、Sidebar、Toolbar 或 React 组件；
- DshCockpit owns the operating layer：Edge Rail、Overlay Peek、Control Center 和 Settings 通过 Electron IPC、HTTP/WebSocket、filesystem 与 Runtime 交互；
- `/compact` 通过稳定 RPC 选择最新的非空活动会话，尽量抵抗 Harness UI 更新；Runtime 状态由生命周期控制器统一广播；
- Control Center 负责即时操作，Settings 负责配置；Remote、Runtime、Channels 等不会在两个页面重复实现同一职责。

---

## 🛡️ 数据与安全（隐私优先）

- **隐私声明（设置内明示）**：完全本地运行，不收集/上传个人信息、API Key、会话、用量数据；
- 会话 **append-only JSONL** 天然抗丢 + 退出自动备份 + 切换快照，三层保险；
- **备份刻意不含 API 凭据**（防明文密钥扩散）；
- 运行时下载全程 sha512 校验；harness 文件沙箱与审批机制原样保留；
- **孤儿看门狗**：壳崩溃/强杀时自动清理运行时进程，不留幽灵服务器。

## 🧩 生态对齐

- **插件市场**：浏览 GitHub「dsh-plugin」话题（2000+ 社区插件），一键安装/卸载，自动重启生效；
- **技能市场（v0.2.4）**：浏览/搜索技能生态，安装前预览 SKILL.md 全文；兼容 Claude Skill 格式（可读错误提示），本地导入；安装即热生效；
- **模型管理（v0.2.4）**：6 家第三方 provider 模板（硅基流动/Kimi/智谱/通义/火山/OpenRouter）+ 自定义，连接测试 + 模型拉取 + 默认模型切换；Ollama 本地模型一键接入；Key 系统加密存储；
- **IM 渠道遥控（v0.2.4）**：飞书/企业微信/钉钉官方长连接接入，任务完成/工具审批/Agent 提问推送 + 按钮审批 + IM 内对话（一次性令牌 + 白名单准入）；
- **公网远程（v0.2.4）**：Tailscale 直连（推荐）或 Cloudflare 临时隧道，4G/5G 下完整遥控；公网默认关闭 + 显式授权 + 审计日志；
- 三语界面（中文/English/跟随系统）；托盘、通知、设置全中文化；
- 首次运行引导（无 Key 时红点提示 + 步骤）；窗口位置记忆；拖拽工具条智能避让不遮挡界面。

## 📦 工程化

- **196 项单元测试**（node --test）、日志轮转、存储管理（占用可视化 + 一键清理）、崩溃诊断记录；
- Windows NSIS 安装包 + macOS dmg 配置；GitHub Releases 即更新源（`npm run publish:win` 一键发布）；
- 快捷键保留：`Ctrl+,` 设置 / `Ctrl+K` 会话搜索 / `Ctrl+R` 重载 / `Ctrl+Shift+I` 开发者工具 / `Ctrl+Shift+O` 浏览器打开。

---

## 快捷上手

```bash
git clone <repo> && cd dsh-cockpit
npm install
npm start                 # 开发运行
npm run build:win         # 打 Windows 安装包
npm run publish:win       # 发布到 GitHub Releases（自动成为更新源）
```

> 社区其他壳多为"窗口+托盘+进程管理"的薄封装；DshCockpit 提供的是**更新、成本、后台任务、数据安全**的完整产品闭环。详细介绍见 [DESIGN.md](../DESIGN.md)。
