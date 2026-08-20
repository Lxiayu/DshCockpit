## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `DshCockpit-0.2.5-win-x64.zip` |
| Apple Silicon（M1/M2/M3/M4） | `DshCockpit-0.2.5-mac-arm64.dmg` |
| Intel Mac | `DshCockpit-0.2.5-mac-x64.dmg` |

v0.2.5 是一次**桌面控制层重构**：Harness 保持 100% 原生工作区，DshCockpit 通过独立 Cockpit 控制层提供监控、自动化与运行时管理——**不再向 Harness 注入任何 UI**。

> **Harness owns the workspace. DshCockpit owns the operating layer.**
> **Invisible when working. Obvious when needed.**

## 新功能一：独立 Cockpit 控制层（Edge Rail）

- 右上角常驻极窄 **Edge Rail**：Token / Context、Cockpit、Settings 三个入口，占用极小、随主窗口锚定，不遮挡 Harness 内容区
- **Token Peek**：点击即看输入/输出/缓存/上下文压力，底部提供显式 Compact 动作，无需打开完整页面
- **Cockpit Panel**：Runtime 状态、用量与今日成本、任务概览、Quick Actions（Quick Ask / Tasks / 会话搜索 / 成本 / 运行时 / 远程 / 集成）
- **Onboarding**：指向真实产品入口（高亮真实 Rail / Token / Cockpit），只引导一次
- **彻底移除 Harness DOM 注入**：不依赖任何选择器、CSS 类、React 组件内部结构；未来 Harness 改版不影响 Cockpit

## 新功能二：Control Center 与 Settings 职责拆分

- **Control Center** 只做状态查看与即时操作（成本 / 任务 / 运行时 / 远程 / 渠道 / 插件技能）
- **Settings** 只做持久配置（通用 / 模型 / 数据 / 更新 / 关于）
- 空导航分组自动隐藏；两个入口职责互斥、不再重复

## 新功能三：Task Peek

- 从 Cockpit 先看 Running / Scheduled / Completed / Failed 概览，再选择「新建任务」或「完整管理」，一步直达

## 新功能四：Compact 迁移到 Harness RPC（零 DOM 依赖）

- `/compact` 从 DOM 注入改为 **session.list + commands/execute 原生 RPC**，自动选择最近活动的非空会话
- 兼容 rc.7 / rc.8 两种请求形状，只在参数形状错误时回退；网络/权限错误返回可读提示，不盲目重试
- 即使 Harness 改版布局与组件，压缩能力依然稳定

## 新功能五：Runtime 生命周期状态统一

- 单一状态入口：`healthy / starting / restarting / offline`，覆盖首次启动、手动重启、健康检查、崩溃恢复全路径
- Cockpit 实时反映运行时状态；单个模块失败不影响整体面板

## 新功能六：Quick Ask 全局快捷键可配置

- 设置 → 通用：`Ctrl+Alt+Space`（默认）/ `Ctrl+Shift+Space` / `Alt+Space` / 禁用
- 注册失败自动回退旧快捷键并提示，杜绝重复注册

## 其他改进

- DshCockpit 自有品牌 Logo，不再借用网站资源
- 清理废弃 `tokenWidget` 设置、旧 `chrome:*` IPC、DOM 注入桥接与过时文档
- 测试大幅扩充（Cockpit bounds / snapshot / UI、RPC compact、Runtime 状态、快捷键管理等新增），全部通过
- Harness 原生工作区与既有核心功能（远程 / 渠道 / 任务 / 成本 / 插件技能）零回归

## Windows 安装

用 **7-Zip / WinRAR** 解压 `DshCockpit-0.2.5-win-x64.zip` → 双击根目录的 `DshCockpit.exe`。
- 内置 dsh 运行时，无需安装 Node/dsh、无需联网下载。
- 首次启动若 `DSH_HOME` 尚未初始化，会多花约 20–30 秒建立 profile。
- 若内置运行时被解压工具截断（极少见），应用会自动从 npm registry 兜底安装。

## macOS 安装

双击 `.dmg` → 把 **DshCockpit** 拖进「应用程序」→ 双击启动。内置 dsh 运行时，无需另装 Node/dsh。

> ⚠️ **首次打开会被 Gatekeeper 拦截**（提示「已损坏」或「无法验证开发者」）：当前包尚未签名公证，应用没坏。终端执行一次即可永久放行：
> ```
> xattr -dr com.apple.quarantine /Applications/DshCockpit.app
> ```

---

macOS 的 `.zip` 包供 electron-updater 自动更新使用，普通用户下载 `.dmg` 即可。
