# 交接提示词：H5 运行时版本代差修复 + 运行时选择策略调整

> 用途：粘贴给**当前正在 DshCockpit 仓库开发的另一个 AI 会话**。基于你已经完成的 R1（`src/boot-check.js`）与 R2（`src/compat-status.js` + upstream-compat CI）扩展，实现 H5 紧急修复，**不要与本会话（主会话）或其他并行改动冲突**。
>
> 来源：主会话深度排查（2026-08-23）+ [PREDEV-FEATURES-REPORT.md §2.6](PREDEV-FEATURES-REPORT.md)。

---

## 0. 必读背景（先读这些文件再动手）

- `docs/specs/PREDEV-FEATURES-REPORT.md` —— 功能范围基线。**§2.6 H5** 是本任务规格，§1 是硬性约束，§7 是验收门禁。
- `docs/specs/DEV-KICKOFF-PROMPT.md` —— 项目铁律（C-1~C-8，尤其 **C-7 main.js 必须 `node --check`**、C-8 不碰无关文件）。
- `DESIGN.md` §7/§10 —— 运行时 spawn 与 profile 符号链接自愈机制。
- 你已完成的 `src/boot-check.js`（六域自检）与 `src/compat-status.js`——本任务在其上扩展。

## 1. 问题根因（已实证，不要重新猜测）

registry `@deepseek-ai/dsh` 最新为 **0.1.1-rc.2**（latest/next），内置运行时为 **0.1.0-rc.8**。上游在 0.1.1 把 `~/.dsh/.credentials.yaml` 从**平铺格式**（`key: value`）改为 **`version: 1 + refs:` 嵌套格式**，**双向不兼容**：

- 旧解析器（rc.8）读新文件 → `must be a string`（`version` 为数字、`refs` 为对象，平铺解析器均拒绝；删 `version` 行也没用，报错换到 `refs`）
- 新解析器（0.1.1-rc.2）读旧平铺文件 → 报"pre-release flat layout"，但 **`loadInitial` 会自动原地迁移旧格式**（`migrateFlatDocument`，值原样保留）
- 影响人群：**先用终端 dsh（npm 最新版）体验、后转桌面端**的用户（我们的主要获客来源）——`~/.dsh` 是 0.1.1 格式，装壳必然启动即崩（用户实测 v0.2.8 code=1）。

## 2. 当前运行时选择逻辑（代码事实，勿改坏）

`src/main.js`：
- `ensureRuntimeRegistered()`（约 L437）：**优先级 = 激活指针 → bundled seed（内置）→ discoverDshBin()（系统 dsh）**。**问题：内置 seed 永远优先于用户系统 dsh**——即使系统 dsh 是更新的 0.1.1-rc.2 也被忽略，导致用旧运行时读新数据。
- `discoverDshBin()`（约 L403）：**已能探测系统 PATH 上的 dsh**（where/which → 解析 `node_modules/@deepseek-ai/dsh/lib/bin.js`）。
- `dshBinMeta()`（约 L421）：**已能读出 bin.js 对应版本**。
- `activeDshBin()`（约 L503）：激活条目 → 兜底 discoverDshBin。
- `runtime-manager.js` `smokeTest()`（约 L555）：`--dump-config` 冒烟，**已具备**。
- `materializeIfNeeded()`（约 L467）：把系统 dsh 物化到 managed 目录，脱离系统路径依赖，**已具备**。

## 3. 策略调整方案（核心改动）

**运行时选择优先级改为**（即"壳默认使用用户自己的运行时，用户端无/过低才用内置"）：

```
1. 激活指针（runtime-state.json）——保留，但激活版本若无法通过冒烟或格式不兼容 → 降级继续
2. 系统 dsh（discoverDshBin）当 版本 > 内置 seed 版本 或 格式兼容 → 优先使用（它极可能是 ~/.dsh 数据写入者）
3. 内置 seed（bundled）——用户无系统 dsh 或系统版本过低时的兜底
4. 全部不兼容 → 触发 H5-2 引导升级（见任务 D）
```

实现要点：
- 在 `ensureRuntimeRegistered` 中把 `discoverDshBin()` 的探测**提前**到 bundled seed 之前（版本比较：系统版本 ≥ 内置版本时优先系统）；版本比较用 `dshBinMeta(discoverDshBin()).version` vs 内置 seed 版本（`manager.getInfo()` / bundled 注册路径可读）。
- 每个非激活指针的候选走 `manager.smokeTest`（防 npx 半安装/损坏的系统 dsh），失败则回落下一候选。
- **不要把激活指针改成系统路径**：仍走 `bootstrapFrom(installRoot, version)` + `materializeIfNeeded()` 物化到 managed 目录（沿用现有机制，避免依赖临时路径）。

## 4. 具体任务（按顺序，每项过验收）

### 任务 A：内置运行时升级到 0.1.1-rc.2（P0）
- `package.json` `runtimeVersion`: `0.1.0-rc.8` → `0.1.1-rc.2`。
- 本地/CI 冒烟验证两条路径：① 0.1.1 格式（`version:1+refs`）凭据文件可正常启动；② 旧平铺格式注入后被 0.1.1 自动迁移、值不变、可读（可用 `DSH_DESKTOP_DSH_HOME` 指向临时目录做隔离验证，**不要碰真实 ~/.dsh**）。
- 验收：`npm test` 全绿；新格式与旧格式各至少一个用例通过。

### 任务 B：运行时选择优先级调整（P0，§3 方案）
- 实现 §3 的优先级；保留冒烟守卫与物化机制。
- 验收：模拟"系统 dsh = 0.1.1-rc.2 + 内置 seed = 0.1.0-rc.8"场景，断言选择系统 dsh；"系统 dsh 缺失"场景回落内置 seed；"系统 dsh 冒烟失败"场景跳过并回落。新增测试 ≥ 4 项。

### 任务 C：boot-check 增加"数据格式布局探测"（P1，扩展你已写的 R1）
- 在 `src/boot-check.js` 的 `credentials.exists` 基础上，新增 `credentials.layout`（或并入现有 id，保持 report 契约稳定，见文件头注释）：**只读**识别 `.credentials.yaml` 为平铺（旧）还是 `version/refs` 嵌套（新），与当前激活运行时的解析器能力匹配（运行时版本 ≥0.1.1 支持 v1；<0.1.1 只支持平铺）。**绝不读取/输出凭据值**（延续"备份不含凭据"原则）。
- 不匹配时：报告标记 `degraded` + 提示"数据由较新/较旧版本 Harness 写入，需升级运行时"。
- 验收：两种布局各注入断言；不读值的断言（结果里不含凭据内容）。

### 任务 D：启动失败根因识别 + 引导升级（P0，并入你已接线的崩溃路径）
- 在 `src/main.js` runtime 退出处理（`dialog.runtimeDied`，约 L697）前，解析 `runtimeLogPath` 尾部：命中 `must be a string` / `refs` / `version` / `flat layout` 特征时，弹窗文案改为："检测到您的 DSH 数据由较新版本 Harness 写入（凭据文件 version/refs 格式），当前运行时不支持。升级运行时到 0.1.1-rc.2 即可自动迁移"，并提供「立即升级」按钮 → 复用现有更新管道（registry 检查 → 安装 → 冒烟 → 激活 → 重启 runtime）。
- 无匹配时维持现状（纯展示层增强）。
- 验收：注入含特征日志，断言弹窗文案与按钮链路；无特征时原行为不变。新增测试 ≥ 2 项。

## 5. 协作边界（防止冲突，必须遵守）

- **只改与本任务直接相关的文件**：`package.json`、`src/main.js`（仅 `ensureRuntimeRegistered`/`discoverDshBin` 调用处与崩溃弹窗段）、`src/boot-check.js`（仅 credentials 相关）、`runtime-manager.js`（如确需）、对应测试。
- **禁止改动**（其他并行会话/主会话持有）：
  - `src/cost.js`、`test/cost.test.js`（周末谷价，已交付 v0.2.8）
  - `src/pnpm-shim.js`、`test/pnpm-shim.test.js`（pnpm 桥接，已交付）
  - `src/i18n.js` 的 `tray.*` 键（已交付）；新增键可以加，但**不得删除/改值已有键**
  - `docs/specs/PREDEV-FEATURES-REPORT.md`、`docs/specs/DEV-KICKOFF-PROMPT.md`（主会话维护，只读）
  - `README.md`/`README.en.md`/`ROADMAP.md`（叙事改版，主会话/其他会话持有）
- **git 纪律**：不 `commit`、不 `push`、不 `rebase`、不 `checkout` 他人文件；所有改动留在工作区，由用户统一审阅提交。
- **C-7 铁律**：改过 `src/main.js` 必须 `node --check src/main.js` 再跑测试（`npm test` 不加载 Electron 主进程，语法错会漏网）。
- **回归门禁**：`npm test` 全绿（既有 320 + 新增）；改 main.js 前先 `git stash` 之外的方式确认不覆盖他人未提交改动（可与用户确认基线）。

## 6. 完成汇报格式

向用户汇报：① 改动文件清单 + 每处 diff 摘要；② 新增测试清单与结果；③ 任务 A~D 逐项验收自查表；④ 已知限制；⑤ 明确标注"未提交，等待用户审阅"。
