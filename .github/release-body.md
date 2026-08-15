## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `DshCockpit-0.2.0-win-x64.zip` |
| Apple Silicon（M1/M2/M3/M4） | `DshCockpit-0.2.0-mac-arm64.dmg` |
| Intel Mac | `DshCockpit-0.2.0-mac-x64.dmg` |

## Windows 安装

用 **7-Zip / WinRAR** 解压 `DshCockpit-0.2.0-win-x64.zip` → 双击根目录的 `DshCockpit.exe`。
- 内置 dsh 运行时，无需安装 Node/dsh、无需联网下载。
- 首次启动若 `DSH_HOME` 尚未初始化，会多花约 20–30 秒建立 profile。
- 若内置运行时被解压工具截断（极少见），应用会自动从 npm registry 兜底安装。

## macOS 安装

双击 `.dmg` → 把 **DshCockpit** 拖进「应用程序」→ 双击启动。内置 dsh 运行时，无需另装 Node/dsh。

> ⚠️ **首次打开会被 Gatekeeper 拦截**（提示「已损坏」或「无法验证开发者」）：当前包尚未签名公证，应用没坏。终端执行一次即可永久放行：
> ```
> xattr -dr com.apple.quarantine /Applications/DshCockpit.app
> ```

## 本次修复

### Windows 性能（重点）
- **彻底消除主线程阻塞**：token 轮询不再每 5 秒同步读取整个会话日志，改用增量 + 异步读取，解决「经常未响应」
- 修复 `dirSizeMB` 同步递归遍历导致设置页打开时卡死
- 修复 `bestNodeBin` 无缓存导致每次 spawn `where.exe` 的累积卡顿
- 修复点击发送卡顿
- 全文搜索窗口关闭按钮失效 + 搜索性能优化

### 其他
- 修复设置页 i18n 点号键名未转换，导致大量区块显示原始键名
- 修复设置页插件市场按钮失效

---

macOS 的 `.zip` 包供 electron-updater 自动更新使用，普通用户下载 `.dmg` 即可。
