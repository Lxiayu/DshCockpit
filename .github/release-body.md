## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `DshCockpit-0.2.6-win-x64.zip` |
| Apple Silicon（M1/M2/M3/M4） | `DshCockpit-0.2.6-mac-arm64.dmg` |
| Intel Mac | `DshCockpit-0.2.6-mac-x64.dmg` |

v0.2.6 是一次**启动提速 + 卡顿根治**的性能与稳定性大版本：会话统计、日志解压与扫描全部移入独立工作线程，主进程不再被大日志阻塞；启动流程重构后首窗口更快、加载更稳。

> **Harness owns the workspace. DshCockpit owns the operating layer.**
> **Invisible when working. Obvious when needed.**

## 核心改进：彻底根治 Windows 卡顿

- **会话处理移入独立工作线程**：Token 统计、zstd 日志解压、会话压缩扫描全部在后台线程执行。此前大历史目录会让主进程同步阻塞 10 秒以上（表现为「刚启动就卡」「输入卡顿」「页面无响应」），现在完全不再阻塞窗口与输入
- **会话扫描请求去重**：同一时刻相同请求自动合并，轮询与手动刷新不会叠加全量扫描
- **压缩跟踪防重叠**：5 秒扫描增加在飞保护，慢扫描不再叠加执行

## 启动提速与加载更稳

- **非核心服务延迟启动**：自动更新、定时任务、余额监控、快捷键注册等移出首窗口路径，首屏更快
- **首次 Token 扫描等待窗口就绪**：大历史树不再与运行时启动抢资源
- **日志轮询增量读取**：启动期间只读新增字节，不再全量重读多 MB 运行时日志（Windows + 杀软环境下提升明显）
- **窗口加载兜底**：主窗口 `ready-to-show` 超时自动强制显示 + 加载失败自动重试，不再可能卡死在加载页
- **无白屏过渡**：加载页与主窗口均就绪后再切换显示，去掉启动白屏闪烁

## 其他改进

- **会话压缩缓存限流**：超大日志不再常驻工作线程内存
- **Cockpit 拖拽优化**：指针捕获修复，拖拽更跟手、松手即停
- **GitHub Issue / PR 模板**：提 bug、建议、合并请求更规范
- **内置运行时构建加固**：固定版本 + 高复用缓存 + 完整性校验；安装改用 npm install（实时日志 + 20 分钟硬超时），修复 Windows 首次安装 arborist 静默挂起

## Windows 安装

用 **7-Zip / WinRAR** 解压 `DshCockpit-0.2.6-win-x64.zip` → 双击根目录的 `DshCockpit.exe`。
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
