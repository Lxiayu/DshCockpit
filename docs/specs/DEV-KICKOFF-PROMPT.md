# DshCockpit 开发者交接提示词（新会话启动模板）

> 用途：在**新的开发会话/终端**中开始 DshCockpit 功能开发时，先粘贴本文件内容再附上具体任务。目标：让新会话快速对齐项目背景与铁律，防止越界改动、破坏既有功能。
>
> 使用方式：复制下方「提示词正文」到新会话 → 替换 `【任务】` 段落为本次要做的具体功能（从 docs/specs/PREDEV-FEATURES-REPORT.md 选取）。

---

## 提示词正文

你将在 DshCockpit 仓库中开发一个新功能。这是一个开源的 Electron 桌面应用（MIT，github.com/Lxiayu/DshCockpit），是 DeepSeek Harness（dsh）的"桌面控制平面"。开始前先完整阅读以下约定，再动手。

### 0. 项目背景（必读）

- **产品哲学**：`Harness owns the workspace. DshCockpit owns the operating layer.`（零侵入）——绝不修改 dsh 运行时源码/内部实现，只通过稳定边界交互：HTTP/WebSocket、文件系统（会话日志 JSONL）、CLI 参数（`--dump-config`、端口发现）、Electron IPC。
- 壳 = Electron 主进程（src/main.js）+ 渲染页（settings.html / loading.html / quickask.html / search.html）+ preload 桥（settings-preload.js 等）+ 大量纯逻辑模块。
- **当前版本 v0.2.8（已发布）**；运行时版本 `0.1.0-rc.8`（package.json `runtimeVersion`，由 runtime-manager 托管版本目录）。
- 测试框架：Node 内置 `node --test`（`npm test`），当前 **320 项全绿**。CI 发布：推 `v*` tag 触发 GitHub Actions。
- 全部代码为 CommonJS（`require`），无框架、无 TS；渲染页样式 token 统一在 `src/theme.css`。

### 1. 硬性约束（违反任一即返工）

| # | 约束 |
|---|---|
| C-1 | **新增为主、修改最小化**：新功能放新模块文件；对 main.js / settings.html 只做"接线式"增量（注册 handler、追加导航项），**禁止重构既有代码路径** |
| C-2 | **IPC 只增不改**：新 channel 必须用新名字（如 `boot:*`、`mcp:*`、`notify:*`）；既有 channel 的请求/响应结构一律冻结 |
| C-3 | **设置只追加**：新设置字段只追加到 `settings-store.js` 的 DEFAULTS（带默认值）；既有字段键名/类型/语义不变；老 settings.json 必须无需迁移即可加载 |
| C-4 | **数据只写新文件**：新数据写入 userData 的新子目录/新文件；**绝不触碰** sessions、settings.json、runtime-state.json 的既有格式 |
| C-5 | **回归门禁**：交付前 `npm test` 320 项全绿 + 新增守护测试全绿；任一红即回滚 |
| C-6 | **功能开关化**：新功能默认可通过设置关闭（失败不留死路径） |
| C-7 | **main.js 改动必须 `node --check`**：`npm test` 不加载 Electron 主进程文件，语法错误会漏网（曾发生 SyntaxError 事故）；**改完 main.js 先 `node --check src/main.js` 再跑测试** |
| C-8 | **不碰无关文件**：本次任务范围之外的文件一律不修改（连格式化都不要）；新增测试文件放 `test/`，命名 `<模块>.test.js` |

### 2. 关键文件地图

| 文件 | 职责 |
|---|---|
| `src/main.js` | 主进程入口：窗口/托盘/生命周期/全部 `ipcMain.handle`/运行时 spawn |
| `src/runtime-manager.js` | 运行时版本目录、激活指针、`--dump-config` 冒烟、回滚 |
| `src/cost.js` | 成本估算与日历史（含周末谷价规则 `WEEKEND_OFFPEAK_SINCE`，勿破坏） |
| `src/token-stats.js` | 会话日志 token 解析（zstd 纯 JS 解压），peak/offPeak 分桶 |
| `src/remote-control.js` | 手机远程鉴权网关（配对码/证书/Origin 重写） |
| `src/settings-store.js` | 设置持久化（DEFAULTS / STRING_KEYS / 原子写入） |
| `src/i18n.js` | 双语字典（zh + en 键集必须一致） |
| `src/pnpm-shim.js` | 打包版插件安装的 pnpm 桥接（勿动） |
| `src/channels/` | IM 渠道（飞书/企微/钉钉） |
| `src/theme.css` | 全部壳窗口共享样式 token |
| `test/` | `node --test` 单测；改哪个模块就要补哪个测试 |
| `docs/specs/PREDEV-FEATURES-REPORT.md` | 功能范围基线（§3 是待开发项、§7 是验收门禁） |

### 3. 代码风格约定

- CommonJS + `'use strict'`；文件头部一行注释说明模块职责。
- 用户可见文案一律走 i18n：main.js 用 `t(L, 'key', {...})`（键加进 src/i18n.js STRINGS zh+en）；settings.html 用 `data-i18n` / `tr()`（键加进页面内 `I18N.zh` 和 `I18N.en`）。**中英缺一不可**（有守护测试会查）。
- 异步优先 `async/await`；子进程 spawn 参考 `runDshPlugin` 的 fd 落盘 + 超时强杀模式；禁止同步阻塞主进程。
- 新 IPC handler 在 main.js 中命名 `ipcMain.handle('xxx:yyy', ...)`，返回结构稳定（成功/失败有 `ok` 字段）。

### 4. 本次任务

【任务】——从 `docs/specs/PREDEV-FEATURES-REPORT.md` 阅读，确定要开发的任务，把它的动机/方案/验收抄到此处，作为唯一开发目标。开发中如发现与报告冲突，先停下来向用户确认，不要自作主张扩大范围。

### 5. 交付标准（全部满足才算完成）

1. 代码符合 §1 全部约束（尤其 C-1/C-7/C-8）；
2. `node --check` 通过所有改过的 src 文件；`npm test` 全绿（既有 320 + 新增）；
3. 新增测试覆盖新功能的正常路径与边界（参考同类测试写法）；
4. 对照报告里该功能的"验收"清单逐项自查；
5. 汇报：改动文件清单 + 新增测试清单 + 验收结果 + 已知限制。

### 6. 常见坑（前车之鉴）

- **main.js 语法错误**：改完不 `node --check` 就跑，npm start 直接崩（H4 事故）。
- **i18n 漏双语**：新文案只加了 zh 或只加了 en，守护测试红。
- **IPC 撞名**：新 channel 与既有重复，静默覆盖旧行为。
- **settings.html 内嵌 script**：它是 HTML 内联脚本，改完必须能被 `new Function()` 解析（settings-ui.test.js 会查），注意转义。
- **会话数据误动**：任何修复动作不得触碰 sessions/（append-only JSONL，动了就是数据事故）。
- **别用 git push**：开发完成后汇报给用户，由用户确认后统一提交（仓库有 PR 分支保护，直接推 master 会被拒）。

---

*模板版本：2026-08-23 · 对应 PREDEV-FEATURES-REPORT.md §8 结论*
