# 交接提示词：S1 壳容器化 + Agent 总控台「办公室视图」（v2，含 §7 战略基线）

> 粘贴给在 **DshCockpit-s1 私有仓库** 中开发的另一个 AI 会话。先完整阅读本文件与 `docs/specs/PREDEV-FEATURES-REPORT.md` **§3 S1（S1.1~S1.8）+ S1.5-A 素材生产规范 + §7 Agent Office 战略基线**，再动手。
>
> 本任务是**产品形态级升级**：把桌面壳变成 DeepSeek Harness 的容器应用（左侧功能栏 + Harness/办公室双视图整页切换），并遵循 §7 战略基线（角色与代码分离、三层授权、角色包结构）。**改动大、破坏面广，必须按顺序分步走，每步独立验证。**

---

## 0. 仓库与协作环境（必读）

- **仓库**：`/Users/xia/program/dsh/DshCockpit-s1`（私有，`origin` = github.com/Lxiayu/DshCockpit-s1；`upstream` = 主仓库 Lxiayu/DshCockpit 供同步修复）
- **分支**：当前 `feature/s1-office`（从 v0.3.0 切出）。**所有工作在此分支**，直接 push 到 origin 私有仓库（无 CI 无 secret，发布仍走主仓库）
- **文档版本**：`docs/specs/PREDEV-FEATURES-REPORT.md` 已更新至 **v2026-08-26 版**（含 S1.5-A 素材生产规范 + §7 战略基线）——**以此为准，勿用旧记忆**
- **稳定基线**：v0.3.0 已交付（R4/R5/R6、IM 双向、NSIS、自检、兼容快报等），**不允许破坏**

## 1. 硬性约束（C-1~C-8，违反即返工）

| # | 约束 |
|---|---|
| C-1 | 新增为主、修改最小化：新功能落新模块；对既有代码只做"接线式"增量 |
| C-2 | IPC 只增不改：新 channel 用新名（如 `shell:*`、`office:*`、`agent:*`） |
| C-3 | 设置只追加：新字段只加 settings-store.js DEFAULTS，既有字段不变 |
| C-4 | 数据只写新文件：角色包/办公室状态写 userData 新子目录 |
| C-5 | 回归门禁：`npm test` 全绿 + 新增守护测试全绿 |
| C-6 | 功能开关化：化身系统/办公室视图默认关闭或可切换，失败不留死路径 |
| C-7 | **改 main.js/window-manager.js 必须 `node --check`**（H4 事故教训） |
| C-8 | 不碰任务范围外文件；测试放 `test/<模块>.test.js` |

## 2. 关键代码锚点（S1.1 改造落点）

| 位置 | 现状 |
|---|---|
| `src/window-manager.js` `createWindow(url)`（约 L47） | mainWindow = `new BrowserWindow({ webPreferences: { preload: cockpit-preload … } })` → `loadURL(harnessUrl)`。**S1.1 改造主落点** |
| `src/cockpit-preload.js` | 向 harness web 注入 Edge Rail/设置按钮/Token 胶囊——**S1.1 后必须继续注入 harness webContents（兼容要求）** |
| `src/main.js` `createWindowManager(...)`（约 L355） | 窗口管理入口 |
| `src/settings-store.js` | 设置持久化（追加字段用 C-3） |
| `src/theme.css` | 全窗口共享 token（办公室/角色包主题必须用它） |

## 3. 战略对齐要求（§7，防返工，硬性）

1. **角色与代码分离**（§7.4）：S1.5 化身系统**必须**按角色包结构设计：

```
character-pack/
├── manifest.json   { name, author, license, version, avatar, animations, expressions, personality, behaviors }
├── assets/         avatar.png / animations/ / expressions/
├── personality/    behavior.json
└── LICENSE
```

2. **三层授权**（§7.5）：核心代码 MIT；官方角色资产（Layer 2）独立版权；**默认分发不得携带任何 Layer 3 社区素材**（如女仆鲸鱼娘）；所有 manifest 必须含 `license` + `author` 字段。
3. **官方形象来源**：约稿买断（用户线下进行，全版权）——**开发阶段先用自绘占位 SVG**（官方 logo 轮廓简化版，黑鲸/蓝鲸双配色），角色包结构 + 加载代码先行，画师稿件到位后**仅替换 assets/，不改代码**。
4. **素材生产规范**（S1.5-A）：零预算；默认主题用官方 logo SVG 基底 + LLM 改六态；不得购买付费工具/会员。

## 4. 任务（严格按顺序，每步独立验证再进下一步）

### 步骤 0：嵌入方案小实验（S1.1 前置，30 分钟）
- 验证 harness（http://127.0.0.1:<port>）能否被 **iframe** 嵌入（CSP/X-Frame-Options）；不行则记录并确认用 **WebContentsView**。
- 产出：`docs/notes/embed-experiment.md`（结论 + 证据），并同步更新 PREDEV S1.1。

### 步骤 1：壳容器化重构（S1.1）
- 新 `src/shell.html`：左侧功能栏（上部 Harness / 下部 办公室）+ 视图容器；mainWindow 加载 shell.html；Harness 视图用选定方案嵌入；
- **兼容强制**：cockpit-preload 注入保留；托盘/设置/quickask/search/loading 不变；单实例锁/运行时管理/崩溃守护不变；
- **验收**：功能栏常驻 → 默认 Harness 视图（含 Edge Rail）→ 切办公室 → 切回无状态丢失；`node --check` + `npm test` 全绿。

### 步骤 2：Agent 员工实体（S1.2 + §7.3）
- 新 `src/agent-registry.js`：每个 harness 会话/子代理 = 员工实体；数据源 events.host + session-worker（已有，零侵入）；
- 字段**预留** role/personality（§7.3）：`{ id, name, avatar, status, role?, personality?, task?, workspace?, startedAt, lastActiveAt }`；
- **验收**：≥2 并行会话 → 2 实体，状态正确联动；测试 ≥ 6 项。

### 步骤 3：办公室视图（S1.3）
- 新 `src/office.html`：工位墙 + 顶部概览条（在线数/任务数/成本状态）；点工位展开摘要；theme.css token；reduced-motion 降级；
- **验收**：渲染/状态联动/点击交互；测试 ≥ 4 项。

### 步骤 4：状态机 + 摸鱼动画（S1.4）
- 新 `src/skin-state.js`（纯函数）：六态 `idle/working/finished/warning/error/offline`，优先级 error>warning>working>finished>offline>idle，finished 3s 回落；
- 摸鱼动画：idle 循环（打盹/眨眼/吃白饭 2-3 变体），SVG/CSS，reduced-motion 禁用；
- **验收**：skinState ≥ 8 断言；摸鱼动画 reduced-motion 禁用。

### 步骤 5：角色插件系统（S1.5 + §7.4，替代原"皮肤系统"）
- 新 `src/character-manager.js`：扫描内置 resources/characters + 用户 userData/characters 的角色包、解析 manifest（**含 license/author**）、切换持久化（settings-store 新字段 `character`，默认 `''`）、onCharacterChanged 广播；
- 内置**官方占位角色**「鲸鱼娘」（自绘 SVG：蓝鲸员工配色 + 黑鲸总控配色双变体，六态占位表情）；**不携带任何社区素材**；
- 设置页「外观」新增角色下拉；manifest 校验（license/author 缺失 → 拒绝加载并提示）；
- **验收**：角色包扫描/校验/切换/持久化；占位角色六态可读；默认关闭、开启正常、关闭零残留；测试 ≥ 6 项（含 manifest 校验、license 缺失拒绝）。

## 5. 禁止改动（并行会话/主仓库持有）

- `src/cost.js`、`test/cost.test.js`、`src/pnpm-shim.js`、`src/boot-check.js`、`src/compat-status.js`、`src/crash-reason.js`、`src/runtime-pick.js`、`src/cache-economics.js`、`src/weekly-report.js`、`src/notification-center.js`（已交付）
- `docs/specs/PREDEV-FEATURES-REPORT.md`（规格基线，只允许按任务更新 S1 相关节）
- 主仓库（DshCockpit）**绝不碰**；S1 开发只活在私有仓库 feature/s1-office

## 6. 交付标准（全部满足才算完成）

1. 符合 §1 约束 + §3 战略对齐（角色包结构/三层授权/占位资产）；
2. 步骤 0~5 顺序完成，每步独立验证记录；
3. `node --check` 通过所有改动 src 文件；`npm test` 全绿（既有 + 新增）；
4. 对照 PREDEV S1.1~S1.8 + §7.4/§7.5 验收清单逐项自查；
5. 汇报：改动文件清单 + 新增测试 + 各步验收 + 已知限制 + 下一步建议。

## 7. 常见坑（前车之鉴）

- **main.js/window-manager 语法错误**：改完不 `node --check` → npm start 崩（H4 事故）
- **Edge Rail 注入丢失**：S1.1 改嵌入方式后必须回归验证 cockpit-preload 注入
- **角色素材授权污染**：默认分发绝不携带社区角色素材（女仆鲸鱼娘等）；manifest 缺 license/author 必须拒绝加载
- **iframe 被 harness 拒绝**：先做步骤 0 实验
- **状态源重复**：办公室状态一律来自 events.host 聚合，不自己轮询会话日志
- **i18n 漏双语**：新增文案 zh/en 都要
- **git 纪律**：只在 feature/s1-office 提交推送 origin；不 push upstream/master；不 commit 主仓库

---

*S1 交接提示词 v2 · 2026-08-26 · 对应 PREDEV-FEATURES-REPORT.md §3 S1 + §7 战略基线*
