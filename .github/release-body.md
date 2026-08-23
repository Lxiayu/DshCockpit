## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `DshCockpit-0.2.8-win-x64.zip` |
| Apple Silicon（M1/M2/M3/M4） | `DshCockpit-0.2.8-mac-arm64.dmg` |
| Intel Mac | `DshCockpit-0.2.8-mac-x64.dmg` |

v0.2.8 是一个修复版本：成本中心跟随 DeepSeek 新计费规则（周末全天谷价），并修复打包版安装插件时报 `pnpm not found on PATH` 的问题。

> **Harness owns the workspace. DshCockpit owns the operating layer.**
> **Invisible when working. Obvious when needed.**

## 修复：成本中心周末计费错误（周六日被按 2 倍价格计算）

- DeepSeek 自 2026 年 8 月 23 日（北京时间）起调整峰谷计费规则：**周六、周日全天按谷价计费**
- 此前成本中心仅按小时判断峰谷，周日 09:00 起会错误进入峰值口径，导致成本显示为实际账单的 2 倍
- 本次修复：周末（北京时间周六/周日）全天按谷价计费，且以规则生效时刻为闸门——**规则生效前的历史账本不会被追溯改价**；托盘状态行在周末显示「谷时（周末全天谷价）」，不再出现误导的「X 分钟后转峰」倒计时

## 修复：打包版安装插件失败（pnpm not found on PATH）

- 从 Release 安装包（非源码运行）安装/卸载插件时报错：`dsh: pnpm not found on PATH`
- 原因：`dsh plugin` 命令依赖系统 PATH 中的 `pnpm`；macOS 从 Finder 启动的应用 PATH 极简（不含 Homebrew 目录），Windows 便携版更是完全没有
- 本次修复：**DshCockpit 现在自带 pnpm**，自动生成可执行桥接并注入子进程 PATH——无论源码运行还是打包安装，插件市场/技能安装均无需用户安装任何额外工具
- 安全升级：node-forge 升至 1.4.0（修复 CVE-2025-12816、CVE-2025-66031 两个高危漏洞）

## Windows 安装

用 **7-Zip / WinRAR** 解压 `DshCockpit-0.2.8-win-x64.zip` → 双击根目录的 `DshCockpit.exe`。
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
