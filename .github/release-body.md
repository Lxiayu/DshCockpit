## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `DshCockpit-0.2.7-win-x64.zip` |
| Apple Silicon（M1/M2/M3/M4） | `DshCockpit-0.2.7-mac-arm64.dmg` |
| Intel Mac | `DshCockpit-0.2.7-mac-x64.dmg` |

v0.2.7 是一个小版本：修复 Windows 悬浮工具栏按钮无法点击的问题，并将成本历史读写改为异步，降低 Windows 杀软环境下的偶发卡顿。

> **Harness owns the workspace. DshCockpit owns the operating layer.**
> **Invisible when working. Obvious when needed.**

## 修复：Windows 悬浮工具栏按钮无法点击

- **首次运行引导卡片被裁剪不可见**：引导卡片原为绝对定位，所在容器高度只包住工具栏，配合 `overflow: hidden` 整张卡片被裁剪掉。而引导模式下工具栏按钮按设计处于禁用状态，用户既看不到"跳过/下一步"也无法操作，等于被卡在引导里，工具栏看起来正常但点不动
- **改为文档流布局**：引导卡片跟随工具栏正常展开显示，首次运行可见可操作，完成引导后工具栏按钮即恢复可用

## 性能改进

- **成本历史读写异步化**：成本历史文件的读取与写入移出主进程事件循环。此前在 Windows Defender 实时扫描下，同步文件读写可能造成偶发卡顿，现在不再阻塞窗口与 IPC
- 成本历史的 mtime 缓存保持不变，Token 轮询仍走缓存，行为与之前一致

## Windows 安装

用 **7-Zip / WinRAR** 解压 `DshCockpit-0.2.7-win-x64.zip` → 双击根目录的 `DshCockpit.exe`。
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
