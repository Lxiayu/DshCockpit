# DshCockpit — 设计文档

> 把 DeepSeek Harness（`dsh`）打包成 Windows / macOS 桌面应用，双击即用，不再依赖终端手动启动。
>
> 状态：**阶段 1 原型进行中** · 基于 `@deepseek-ai/dsh` **0.1.0-rc.6** · 2025 年勘察自本机安装产物与官方仓库文档

---

## 1. 背景、目标与非目标

### 背景
- 当前 `dsh web` 通过终端启动（用户实际走 `npx` 缓存的一次性安装），每次使用都要开终端、敲命令、等待启动，体验割裂。
- dsh 处于**开发者预览阶段**（当前 `0.1.0-rc.6`），上游快速迭代、随时可能破坏兼容。

### 目标
1. 桌面端一键启动（Windows `.exe` 安装包 / macOS `.dmg`），无需用户接触终端、无需手动装 Node/npm。
2. 窗口内获得与 `dsh web` 完全一致的完整体验（会话、工具、审批、设置）。
3. **自动更新**：跟随上游预览版快速迭代，同时**摔不坏**——坏版本不激活、可一键回滚。
4. 系统托盘常驻、单实例、开机自启可选、全局快捷键可选。

### 非目标（阶段 1）
- 不重写 dsh 的任何逻辑；壳只做"拉起 + 呈现 + 守护"。
- 不做手机端 / 多用户 / 云托管。

---

## 2. 关键决策记录（ADR 摘要）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 桌面壳用 **Electron**（而非 Tauri） | 与 dsh 同为 Node 生态，社区已有多个 Electron 套壳先例，最快出可用版 |
| D2 | **壳与运行时双层解耦**，运行时以"版本化目录"外置于应用数据区，绝不打包进 asar/.exe | 运行时独立更新、独立回滚，不重装应用 |
| D3 | 默认更新通道 **rc**（跟随预览版），提供 `latest` / `pinned` 模式 | 当前上游只有 rc；求稳者后续可切 |
| D4 | registry 默认官方源，设置内可切镜像（npmmirror 等） | 兼容性最稳 + 国内网络可加速 |
| D5 | 运行时用 **`--port 0`**，由 OS 分配端口，从 stdout 的 `dsh web: http://127.0.0.1:<port>` 解析实际端口 | 零端口冲突，无需扫描 |
| D6 | 运行时子进程优先用**系统 Node**（原型期），生产期用 Electron 内嵌 Node（`ELECTRON_RUN_AS_NODE`） | 依赖树含原生模块（sharp/koffi/node-pty，均为 N-API），与安装时所用 Node 版本匹配最稳 |
| D7 | 单实例锁（`app.requestSingleInstanceLock`），重复双击聚焦已有窗口 | 防多 host 实例并发写同一 DSH_HOME |
| D8 | 关窗口最小化到托盘常驻；托盘"退出"才真正结束 host | 直接解决"每次要重新启动"的痛点 |
| D9 | 换运行时版本前必须过**冒烟测试**（`--dump-config` + HTTP 健康检查） | 拦截上游破坏性变更，坏版本不激活 |
| D10 | 切换运行时前对 DSH_HOME 做**轻量快照**，回滚时一并还原 | 预览版可能改 profile/session schema，快照是保险丝 |

---

## 3. 总体架构

```
┌───────────────────────────── 桌面壳 (Electron) ─────────────────────────────┐
│ 主进程 (main.js)                                                             │
│  ├─ 单实例锁 / 托盘 / 窗口管理 / 生命周期                                      │
│  ├─ RuntimeManager：版本目录、激活指针、下载校验、冒烟测试、回滚              │
│  └─ spawn 运行时子进程 ───────────────────────────────┐                       │
│                                                      ▼                       │
│  BrowserWindow ──http/ws──► 127.0.0.1:<port>   dsh web 运行时 (node bin.js)  │
│  (contextIsolation,                                       │                  │
│   nodeIntegration off)                                   ▼                  │
│                                                  ┌──────────────────────┐    │
│                                                  │ Cordis 插件栈          │    │
│                                                  │  webserver/apiproxy/  │    │
│                                                  │  frontend-static/...  │    │
│                                                  │  (前端 dist 由本版本   │    │
│                                                  │   运行时自带并 serve)  │    │
│                                                  └──────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 壳与运行时的接口面（刻意做小、做稳）
| 接口 | 内容 |
|---|---|
| 启动 | `node <dsh>/lib/bin.js --profile web --port <n>`（`0` = OS 分配） |
| 端口发现 | stdout 首行形如 `dsh web: http://127.0.0.1:<port>`（已验证于 rc.6 源码） |
| 健康检查 | GET `/` 返回 200；WebSocket 升级握手成功 |
| 冒烟（不花 token） | `node <bin.js> --profile web --dump-config`，exit 0 且输出合法即通过 |
| 退出 | 壳先尝试优雅终止子进程，超时后强杀（见 §7） |

> 前端与后端永远同版本：前端 dist 由**同一运行时**的 `dsh-host-frontend-static` serve，壳只认识"HTTP + WS"，天然不存在前后端版本错配。

---

## 4. 数据与目录布局

以应用名 `DshDesktop` 为例（Windows 用 `%LOCALAPPDATA%`，macOS 用 `~/Library/Application Support`）：

```
<appData>\DshDesktop\
├── runtime\
│   ├── 0.1.0-rc.6\          # 运行时安装树（node_modules + lib/bin.js）
│   └── 0.1.0-rc.7\          # 新版本（下载+校验+冒烟通过后才可能被激活）
├── runtime-state.json        # 激活指针 + 通道 + 已知问题名单
├── dsh-home\                 # 托管 DSH_HOME（profiles / sessions / storages / settings）
├── snapshots\                # 切换运行时前的 DSH_HOME 轻量快照
├── logs\                     # 壳日志 + 运行时 stdout/stderr
├── state.json                # 窗口位置、设置、上次工作区
└── cache\                    # 已下载的运行时 tarball（可 GC）
```

### `runtime-state.json` schema
```json
{
  "channel": "rc",
  "activeVersion": "0.1.0-rc.6",
  "installed": ["0.1.0-rc.6"],
  "broken": [],
  "knownIssues": { "0.1.0-rc.7": "boot smoke test failed: config compose error" },
  "registry": "https://registry.npmjs.org/",
  "keepVersions": 2
}
```

### 真机使用约束（重要）
- **桌面应用与终端 `dsh web` 不能同时运行**（共用 DSH_HOME，双实例并发写 sessions 有风险）。桌面壳接管后，DSH_HOME 默认仍指向用户真实 `~/.dsh`，会话与配置无缝沿用。
- 阶段 1 通过环境变量 `DSH_DESKTOP_DSH_HOME` 支持"测试模式"（独立目录），用于自动化验证，不碰真实数据。

---

## 5. 运行时管理

- **版本目录**：每个版本一个目录，内容 = `npm install --prefix <dir> @deepseek-ai/dsh@<version>` 的产物。一个版本号（`@deepseek-ai/dsh`）即锁定整套 `dsh-*` 插件与 bundle（其 package.json 依赖 pin 全量锁定）。
- **激活 = 改指针**：写 `runtime-state.json`（先写临时文件再 rename，保证原子性）。切换不改任何应用文件。
- **GC**：保留最近 `keepVersions`（默认 2）个版本；`broken` 版本先提示再清理。
- **首次初始化**：`dsh web` 在 DSH_HOME 为空时自动从随附模板初始化 `web` profile（已验证该机制存在）。

---

## 6. 更新机制（核心设计）

### 6.1 双层更新总览
| 层 | 更新对象 | 机制 | 频率 |
|---|---|---|---|
| 壳 | Electron 应用本体 | electron-updater（GitHub Releases / 自建静态服务器） | 很低 |
| 运行时 | `@deepseek-ai/dsh` 整棵依赖树 | 自研"版本目录 + 指针 + 冒烟守卫"管道 | 高（跟随 rc） |

**预览版迭代快、破坏性变更多的应对 = 运行时层全隔离**：升级只是"换目录"，坏版本根本不激活，回滚改一个指针。壳唯一要维护的是对运行时的"小接口面兼容矩阵"（见 6.4）。

### 6.2 版本发现
- 查询 packument：`GET <registry>/@deepseek-ai/dsh`。
- 读 `dist-tags` 决定是否升级：`rc`（默认通道）、`latest`（上游出正式版后可切）、`pinned`（用户锁死）。
- 每个版本带 `integrity`（sha512）与 `tarball` URL，供安全下载。
- 镜像：默认官方；设置内可切 npmmirror；镜像与官方均记录在 `runtime-state.json`，可一键换源重试。

### 6.3 下载与校验（进程内，不依赖系统 npm）
- 用 Node 库实现（`pacote` 或手动 fetch tarball + sha512 校验 + `tar` 解压），Electron 主进程完成。
- 失败（网络 / 校验 / 解压）→ 丢弃目录、静默重试、**绝不触碰激活指针**。

### 6.4 兼容性守卫：激活前的三道关
1. **配置冒烟**：`node <bin.js> --profile web --dump-config` → exit 0 且输出合法（`--dump-config` 不启动服务、不花 token；配置错误/启动失败会非零退出，CLI 行为参考确认）。
2. **HTTP 健康**：真实启动后 GET `/` 200、WS 握手成功。
3. **兼容矩阵**（壳内置，随壳版本发布）：
   ```json
   { "shell": "0.1.0", "supportedRuntimes": [">=0.1.0-rc.6 <0.2.0"] }
   ```
   超出矩阵 → 标记"不兼容"，提示"需要更新桌面壳"，**不盲升**。

任一道失败 → 新版本进 `broken`，保持旧版本激活，UI 提示 + "强制尝试"入口。

### 6.5 应用策略
- 壳启动后**后台检查**（不阻塞窗口，先用当前版本打开）。
- 发现新版本 → 静默下载 + 冒烟 → 通过后**不立即应用**：默认下次启动切换，或用户点"重启以应用"。
- **绝不在有活动对话时切换**（换版本必须重启 host 进程；会话持久化在 DSH_HOME，重启不丢历史，但进行中的对话会中断）。
- 网络失败静默重试，不打扰。

### 6.6 回滚
- 一键回滚（托盘 / 设置）：指针改回旧版本 + 重启 host，秒级。
- 切换前对 DSH_HOME 做轻量快照（profiles、settings、storages 关键文件）；预览版若升级了 schema，回滚时一并还原快照。
- 回滚后把该版本记入 `knownIssues`，避免反复触发升级。

### 6.7 壳自身更新
- electron-updater + 更新服务器；壳更新独立于运行时、互不阻塞。
- 壳更新时一并携带新的兼容矩阵——这是壳"唯一重要的更新"。

---

## 7. 进程与生命周期

- **启动链**：壳启动 → RuntimeManager 选激活版本 → spawn 子进程（cwd = 工作区，env 注入 `DSH_HOME`）→ 解析 stdout 端口 → 轮询健康检查 → 打开 BrowserWindow。
- **单实例**：`app.requestSingleInstanceLock()`；二次启动聚焦已有窗口。
- **托盘**：图标菜单 = 打开 / 重启运行时 / 回滚到上一版本（版本存在时）/ 退出。关窗口默认最小化到托盘。
- **退出**：主进程先优雅终止运行时子进程（Windows 下 Node 信号模拟受限，采用"发送关闭信号 → 等待 N 秒 → 强杀"策略；生产版按 CLI 行为参考的 shutdown 契约对接），随后清理临时文件退出。
- **崩溃守护**（阶段 2）：运行时进程意外退出时，托盘提示并提供一键重启。

---

## 8. 安全

- BrowserWindow：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，preload 只暴露最小桥接 API。
- 只加载本地 origin（解析出的 `http://127.0.0.1:<port>`）；禁用导航到外部地址。
- dsh 自身的文件沙箱（workspace-write）与用户审批（ask）都在 host 侧实现，审批弹窗在对话 UI 内呈现，不依赖终端。
- 凭据：沿用 dsh 的 `DSH_HOME/.credentials.yaml` 与 settings；阶段 2 可选接入系统钥匙串（`safeStorage`）。
- 下载运行时全程校验 `integrity`，防篡改。

---

## 9. 打包与分发

- electron-builder：Win **NSIS** 安装包 + mac **DMG**（+ zip 供自动更新）。
- **运行时目录不进 asar、不进安装包**（保证独立更新）。
- 签名：Windows 代码签名证书（过 SmartScreen）；macOS Developer ID + notarization（过 Gatekeeper）。未签名只能本机自用。
- 原生模块（sharp / koffi / node-pty / node-addon-require-builtin）按平台随运行时一起分发（N-API，Node ≥ 18 均可加载）。
- 网络：electron 二进制与 electron-builder 下载走镜像/代理环境变量（国内可用 npmmirror）。

---

## 10. 已验证的 CLI 事实（基于 0.1.0-rc.6 源码勘察）

- `dsh --version` → `0.1.0-rc.6`，exit 0。
- web 应用 flag：`--host <host>`、`--port <port>`（**`0` = OS 分配**）、`--trusted-host <authority...>`；`--host 0.0.0.0` 被安全拒绝。
- 启动时 stdout 打印：`dsh web: http://127.0.0.1:<port>`（可选 ` (LAN: ...)` 后缀）——端口解析依据。
- 默认端口 3080（`dsh-cmdline`：`port: !!js ctx.webStartup.port ?? 3080`）。
- 启动器 flag：`--profile`、`--dump-config` / `--dump-default-config`（不启动、非零退出表示配置错误）。
- `dsh` 在 Windows 上以 `.ps1/.cmd` shim 形式存在于 `node_modules\.bin`，壳应直接定位 `lib/bin.js` 用 node 执行，避免 shell shim 差异。

### 阶段 1 原型开发中的实测发现（2026-08）
- **spawn 的 cwd 陷阱**：`spawn()` 的 `cwd` 目录不存在时，Windows 的 CreateProcess 报 `ERROR_FILE_NOT_FOUND` → Node 抛 **ENOENT**（看起来像"可执行文件不存在"）。壳必须在 spawn 前 `fs.mkdirSync(cwd, {recursive:true})`。
- **nvm 符号链接**：`where.exe node` 返回 `C:\nvm4w\nodejs\node.exe`（符号链接 → 真实目录），Electron 内 spawn 经链接失败 ENOENT。修复：`fs.realpathSync` 解析真实路径作为首选候选，原路径、`ELECTRON_RUN_AS_NODE` 依次兜底。
- **`where` 与 `where.exe`**：Node `execFileSync('where')` 不可靠（`where` 是 cmd 内建/别名），Windows 上必须显式用 `where.exe`。
- **沙箱限制**：harness 文件沙箱拦截命名管道，Chromium 的 Mojo IPC 依赖命名管道 → Electron 在沙箱内直接 FATAL 崩溃（`mojo platform_channel 拒绝访问`）。**测试 GUI 必须在完整权限下运行**；壳的生产运行不受此限。
- **运行时日志落盘**：运行时 stdout/stderr 用 `fs.openSync` 的 fd 直接写文件（`stdio: ['ignore', fd, fd]`），壳轮询文件解析 URL 行——比管道健壮，且绕开沙箱的管道限制。实测 URL 行解析与健康检查全通。
- **DSH_HOME 的符号链接农场（重要）**：`~/.dsh/profiles/node_modules` 下所有包（含 `@deepseek-ai/*`）都是**指向 dsh 安装目录的 junction**，由 dsh 启动时自行维护（`healProfilesModuleFallback`：发现"存在但不是符号链接"会直接报错并拒绝启动）。因此：
  - 复制/迁移 DSH_HOME 时不能把 node_modules 复制成实体目录；**删除 `profiles/node_modules` 让 dsh 自愈重建** 即可（实测有效，重建后指向当前激活运行时，也天然适配未来的运行时更新）；
  - 这是"运行时更新后 profile 依赖仍指向旧安装"问题的官方解法——dsh 每次启动都会 heal 这些链接。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 上游破坏 CLI / 配置语法 | `--dump-config` 冒烟 + 兼容矩阵 |
| 上游破坏 profile/session schema | DSH_HOME 快照 + 一键回滚 |
| 原生模块与 Electron 内嵌 Node 不兼容 | 原型期用系统 Node；生产期预验证 N-API 加载，失败自动回退系统 Node |
| registry 抽风 / 国内网络慢 | 镜像设置项 + 静默重试 + 手动模式兜底 |
| 双实例并发写 DSH_HOME | 壳内单实例锁 + 文档约束（不与终端 dsh web 同开） |
| 杀软 / Gatekeeper 拦截 | 代码签名 + 公证；文档说明 |
| 首次初始化 web profile 耗时（需建 profile 目录） | 首次启动显示"正在初始化"状态页 |

---

## 12. 阶段路线图

### 阶段 1 — 原型（✅ 完成）
- [x] 勘察运行时 CLI 事实（端口、URL 行、dump-config）
- [x] 冒烟验证 spawn `dsh web --port 0` 全链路
- [x] Electron 壳：spawn + 端口解析 + 窗口加载 + 单实例 + 托盘
- [x] 验收：窗口内可对话（真机模式用真实 DSH_HOME）
- [x] 实测修复：cwd 预创建、nvm 符号链接 realpath、where.exe、fd 日志落盘
- [x] 实测结果：窗口标题 "DeepSeek Harness"、HTTP 200、URL 解析正常

### 阶段 2 — 可用版（✅ 完成）
- [x] 壳自己的**设置界面**（原生窗口 `src/settings.html` + IPC + 托盘入口）：
     更新通道（rc/latest/pinned）、npm 镜像源、保留版本数、启动检查开关、
     工作区/DSH_HOME 目录选择、端口、Node/dsh 路径、托盘常驻、开机自启
- [x] `SettingsStore`（`settings.json` 持久化，env 变量优先覆盖）
- [x] `RuntimeManager`：版本目录注册（bootstrap 现有安装 + Arborist 托管安装）、
     `runtime-state.json` 指针、pacote 拉取 packument 的通道解析、
     `--dump-config` 冒烟测试、激活（含 DSH_HOME 快照）、回滚、GC
- [x] 动态托盘菜单（检查更新/应用更新/回滚，按状态启用）
- [x] 崩溃守护：运行时意外退出 → 系统通知 + 托盘可恢复
- [x] 实测：无头管道测试 7 项全过（bootstrap→registry→安装→冒烟→激活→回滚→GC）；
     GUI 集成测试通过（设置窗口打开、runtime-state.json 落盘、启动后台检查无异常）

### 阶段 3 — 分发（✅ 完成基础）
- [x] electron-builder 双平台配置（`electron-builder.yml`：win nsis / mac dmg+zip，`--publish never`）
- [x] Windows 安装包实建（`dist/DshCockpit Setup 0.1.0.exe`，89MB，blockmap 生成）
- [x] 打包应用端到端实测：从**托管运行时**启动、updater 初始化、事件流连接、HTTP 200
- [x] electron-updater 壳更新接入（打包后启用，托盘「检查壳更新」）
- [ ] 代码签名（Windows Authenticode / macOS Developer ID+公证）——需购买证书，配置已就绪（env: CSC_LINK 等）
- [ ] 真实发布源（electron-updater feed 指向真实仓库/服务器）——发布前配置
- [ ] macOS 构建与实测——需在 macOS 上执行

### 阶段 4 — 加固与体验（✅ 完成，2026-08）
- [x] **运行时物化**：首次运行后台把运行时安装进 userData/runtime（托管），`entry()` 托管优先；实测打包应用已完全脱离 npx 缓存启动
- [x] **崩溃自动重启**：非预期退出 1.5s 后自动重启，60s 内最多 3 次防循环
- [x] **日志轮转**：log/out 各保留最近 10 份
- [x] **设置界面警告**：镜像信任、Hyper-V 端口区间（#589）、非 ASCII 路径（#107）
- [x] **首次运行引导**：无凭据时设置窗口显示引导步骤 + chrome 齿轮红点
- [x] **窗口状态记忆**：bounds 持久化 + 显示器可见性校验
- [x] **任务完成通知**：订阅 events.host WebSocket（`host/session-status`），窗口隐藏时发通知
- [x] **工作区快速切换**：托盘「最近工作区」+ 拖文件夹到 chrome 工具条
- [x] **存储管理**：设置里显示各目录占用 + 一键清理（日志/旧备份）
- [x] **单元测试**：node --test 22 项（settings-store / i18n / backup / token-stats / runtime-manager-unit），`npm test`
- [ ] 系统钥匙串集成（凭据加密）——后续版本
- [ ] macOS 实测——需 macOS 环境

### 阶段 6 — 上线冲刺：差异化功能全量实现（进行中，2026-08）
- [x] **上下文健康度**：token 胶囊边框按上下文压力变色（绿/黄/红）+ 悬停百分比（`contextWindow` 可配）
- [x] **审批/提问系统通知**：订阅 events.mux（approval/requested、question/requested），窗口隐藏时通知
- [x] **成本控制中心**：`src/cost.js` 日历史持久化、按工作区归因（会话头 cwd）、月度预算 80%/100% 报警、单价可配（实测修复：设置键名与 costOf 参数名不一致导致费用恒 0）
- [x] **Quick Ask**：全局热键（默认 Ctrl+Alt+Space，可配）+ 无边框小窗 + `src/headless.js` 后台运行 + 完成通知
- [x] **壳级定时任务**：`src/scheduler.js`（间隔/每天），30s tick，错过超 1 周期自动跳过（实测修复：原 ensureNextRun 在到期判断前把时间推到未来导致永不触发）
- [x] **会话全文检索**：`src/session-search.js` + Ctrl+K 搜索窗（修复：O(n²) 匹配计数 → split）
- [x] **引导式首次运行**：无 dsh 时 loading 窗口 + registry 安装进度
- [x] **崩溃诊断**：`userData/diagnostics/crash-*.json`（日志尾部 + 状态）+ 设置→关于 入口 + 下次启动提醒
- [x] **隐私声明**：设置内明示不收集数据（i18n 双语）
- [x] 测试新增：cost / scheduler / session-search（34 项全过）；`FEATURES.md` 宣传文档
- [x] 自查修复：settings.patch 白名单（IPC 防注入）、scheduled-upsert 字段清洗、cost 费率键名映射（费用恒 0 bug）、session-search O(n²) 计数
- [ ] 全量代码审查（子代理交叉审查）并修复 —— 进行中
- [ ] 最终打包与发布

### 阶段 5 — 壳自更新完善 + 社区功能对齐（✅ 完成，2026-08）
- [x] **壳自动更新完整化**：启动 10s 后自动检查 + 每 4h 周期检查（设置可关）；下载完成后弹「更新说明 + 立即重启/稍后」对话框（release notes 来自 GitHub Release 正文）；托盘「检查壳更新」手动触发
- [x] **快捷键恢复**（无可见菜单栏）：Ctrl+, 设置 / Ctrl+R 重载 / Ctrl+Shift+I 开发者工具 / Ctrl+Shift+O 浏览器打开 / Ctrl+Q 退出（隐藏菜单 + accelerator）
- [x] **插件市场 v1**（对齐社区共识功能）：设置里浏览 GitHub「dsh-plugin」话题（2093 个仓库），一键 `dsh plugin --profile web add/remove github:owner/repo` 安装/卸载，完成后自动重启运行时；本地记录已装列表
- [x] **孤儿进程看门狗**（对齐 Void0312Aurora reaper）：detached 子进程监视壳主进程，主进程硬杀（崩溃/taskkill /F）时自动 tree-kill 运行时——实测硬杀后无孤儿
- [x] **发布准备**：electron-builder publish 用 `${env.DSH_REPO_OWNER}`/`${env.DSH_REPO_NAME}` 驱动（无需改配置），`npm run publish:win` 一键发布到 GitHub Releases（= electron-updater 更新源）；`RELEASE.md` 完整步骤
- [ ] 实际发布——等待用户提供仓库与权限
- [ ] macOS 构建/签名/公证实测

### 阶段 3 — 分发
- [ ] electron-builder 双平台打包 + 签名 + 公证
- [ ] 壳自动更新（electron-updater）+ 兼容矩阵发布流程
- [ ] 图标 / 品牌 / 安装包体验 / 自动更新 UI

---

## 13. 测试与验收标准

- **冒烟**：干净环境（空 DSH_HOME）首次启动 → 自动初始化 → 窗口加载 → 会话可创建。
- **更新**：伪造"新版本目录"→ 触发升级 → 冒烟失败场景不激活、冒烟通过场景切换成功 → 回滚秒级生效。
- **并发**：二次启动只聚焦不重启；与终端 dsh web 并存时给出明确提示。
- **退出**：退出后无孤儿 node 进程、无残留锁。
- **平台**：Windows 10/11 + macOS（Apple Silicon / Intel）各过一遍上述用例。

### 实测记录（2026-08，Windows 10.0.26200）
- 无头管道测试 `node test/runtime-manager.test.js`：bootstrap → 真实 registry 检查（当前即最新）→
  Arborist 安装 `0.1.0-rc.3` 完整依赖树 → `--dump-config` 冒烟 exit 0 → 激活（快照）→ 回滚 →
  GC，**7 项断言全部通过**。
- GUI 集成测试（测试模式）：bootstrap 日志、运行时 URL 解析、设置窗口打开、
  `runtime-state.json` 落盘、启动后台更新检查无异常，主窗口标题 "DeepSeek Harness"，HTTP 200。
- 更新管道的"发现新版本"分支当前无法用真实版本验证（registry 最新即 0.1.0-rc.6）；
  管道机制已用"安装旧版本→切换→回滚"完整覆盖。

## 14. 壳设置界面（shell settings）

与 harness 内部的设置（模型、插件等）**完全独立**，管理桌面壳自身行为：

| 设置项 | 说明 | 生效时机 |
|---|---|---|
| 更新通道 rc/latest/pinned | 决定更新检查解析的目标版本 | 下次检查 |
| npm 镜像源 | 官方 / npmmirror / 自定义 | 下次检查/安装 |
| 保留版本数 | GC 保留的托管版本数 | 下次切换 |
| 启动时检查更新 | 壳启动 15s 后后台检查 | 下次启动 |
| 工作区目录 | 运行时 cwd（默认用户主目录） | 重启运行时 |
| DSH_HOME | 运行时数据目录（默认 ~/.dsh） | 重启运行时 |
| 端口 | 0 = OS 分配 | 重启运行时 |
| Node / dsh 路径 | 覆盖自动检测（env 变量优先级更高） | 重启运行时 |
| 关闭窗口最小化到托盘 | 窗口关闭行为 | 立即 |
| 开机自启 | `app.setLoginItemSettings` | 立即 |
| **界面语言** | 中文 / English / 跟随系统（`app.getLocale()` 判定） | 立即 |
| **退出时自动备份会话** | 退出前把 sessions + settings.yaml 复制到备份目录 | 退出时 |
| **保留备份份数** | 备份 GC 保留份数（默认 5） | 备份时 |

- 存储：`userData/settings.json`（原子写入：tmp + rename）。
- 界面：`src/settings.html`（内置 zh/en i18n 字典 + `data-i18n` 属性，跟随 `language` 设置实时切换；CSP 允许 unsafe-inline）+ `src/settings-preload.js`（contextBridge 暴露 `dshShell` API）+ `ipcMain.handle` 处理器。
- 入口：托盘菜单「设置…」；**窗口内右上角齿轮按钮**（preload 注入，见 §16）；开发用 `DSH_DESKTOP_OPEN_SETTINGS=1` 启动即开。
- 状态同步：设置窗口实时读取 `runtime-info`（当前版本/待应用/已安装列表）与 `backup-info`，应用更新/回滚/备份后自动刷新。

## 15. 数据与安全（历史不丢失）

**会话持久化**：dsh 的会话是 append-only JSONL（`DSH_HOME/sessions/<项目>/<会话>/session.jsonl[.zstd]`），每条事件写入即落盘（Windows 上走 durable write-through），本身已很抗丢失。桌面壳在之上加了三道保险：

1. **退出自动备份**（`src/backup.js`）：退出前把 `sessions/` + `settings.yaml` 复制到 `userData/backups/<时间戳>/`，按 `backupKeep` 保留最近 N 份（设置中可开关/调份数/手动"立即备份"）。
2. **切换运行时快照**（RuntimeManager §6.6）：升级/回滚前对 DSH_HOME 关键文件做轻量快照，回滚时一并还原。
3. **优雅退出**：退出时先尝试让运行时正常收尾（SIGTERM + 4s 宽限再强杀），避免截断写入。

**安全边界**（重要）：
- **备份不含 API 凭据**：`.credentials.yaml` 刻意不进入备份（明文凭据副本是风险），钥匙串集成（safeStorage / Windows Credential Manager / macOS Keychain）规划为后续版本；
- 运行时下载全程由 npm 生态做 sha512 integrity 校验；镜像源由用户选择（自担镜像可信度）；
- harness 自带的文件沙箱（workspace-write）与用户审批（ask）机制由运行时管理，桌面壳不削弱、不在其外另开权限；
- 单实例锁 + 端口隔离防止多实例并发写 DSH_HOME。

## 16. 窗口内壳 chrome（设置按钮 + token 部件）

preload（`src/preload.js`）向 dsh web 页面注入一个悬浮组件（暗色主题，半透明、悬停增亮）：

- **⚙ 设置按钮**：点击经 IPC 打开壳设置窗口（不再依赖托盘）；
- **token 用量胶囊**：`⛁ 输入→输出` 实时显示**当前会话** token 用量，悬停显示明细（当前/全部会话、输入/输出/缓存）；点击可手动刷新；
- **可拖拽 + 位置记忆**：拖动组件任意摆放，位置存 localStorage（隔离世界，不污染页面存储），下次启动保持；用户拖过之后不再自动移位。

**防遮挡策略**（实测解决：部件曾盖住 harness 右上角的会话导出按钮）：
- 初始注入在 `DOMContentLoaded`，但 harness 是 SPA，头部此时尚未渲染——因此注入后**延迟重测**（每 0.7s 最多 12 次），扫描页面右上角区域（`top<130 && right>innerWidth-220`）的交互控件，一旦发现即把部件放到其**下方 10px**；
- 实测：首测 found=0（top=10）→ 0.7s 后 found=1 → 自动下移到 top=52；
- 用户一旦拖拽过，自动移位即停用（尊重用户位置）。

数据来源：壳每 5s 读取 `DSH_HOME/sessions/` 下的会话日志（`.jsonl.zstd` 用纯 JS 的 `fzstd` 解压），从 `assistant/message` / `assistant/chunk(usage)` 事件的 `data.usage`（`inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`）汇总，按 (size, mtime) 缓存避免重复解析。HTTP 层没有现成统计接口（token-meter 是运行时内部服务），这是壳自己的数据源。实测：真实会话日志解析正常（本仓库开发对话 9339 行 → 输入 29.2 万 / 输出 36 万 / 缓存读 3300 万 tokens）。

**界面语言**：Electron 默认 File/Edit 菜单已移除（`Menu.setApplicationMenu(null)`），壳的托盘、通知、设置窗口、注入 chrome 全部走 `src/i18n.js` 的 zh/en 字典（`跟随系统` 用 `app.getLocale()` 判断），不再出现英文系统菜单。
