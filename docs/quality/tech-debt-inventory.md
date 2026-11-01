# 技术债清单（壳层）

> 状态：**审计报告（2026-11-01）** · 审计范围：除 `src/office`、`src/workbench`、`src/runtime-*` 协议细节、`src/team/**` 之外的壳层
> 配套文档：`docs/architecture/architecture-overview.md`（现状）、`docs/quality/testing-strategy.md`（测试体系）
> 本清单共 **33 条**（2026-11-01 追加 TD-33：兼容账本陈旧）。每条含：编号 / 位置 / 证据 / 影响 / 建议优先级（P0-P3）/ 是否阻塞新方向
> 「阻塞新方向」= 是否阻塞 `docs/product/product-vision.md` 的 Mission Core / Capability Platform 落地

## 优先级定义

| 级别 | 含义 | 处置窗口 |
|---|---|---|
| **P0** | 会导致用户数据丢失、或阻断新方向架构 | 重构前必做 |
| **P1** | 结构性债务，越晚改成本越高 | 与 Mission Core 同一批次 |
| **P2** | 可维护性/一致性债务，不阻塞功能 | 随功能迭代顺手改 |
| **P3** | 洁癖级，可无限延后 | 有空再说 |

---

## 汇总表

| # | 标题 | 类别 | 优先级 | 阻塞新方向 |
|---|---|---|---|---|
| TD-01 | `main.js` 6385 行 / 107 个 IPC handler / 196 个顶层函数，且无任何测试加载 | 结构 | P0 | ✅ 是 |
| TD-02 | `settings.json` 无 schemaVersion、无迁移框架，损坏时静默丢全部设置 | 存储 | P0 | ✅ 是 |
| TD-03 | `.dsh/index.json` fail-closed 且无 `.bak`，Mission 候选底座安全等级低于 office | 存储 | P0 | ✅ 是 |
| TD-04 | 工作产物索引是全量覆盖写而非 append-only，且无条目上限 | 存储 | P0 | ✅ 是 |
| TD-05 | 备份只覆盖 2 个 key，壳层全部状态无备份 | 存储 | P0 | ✅ 是 |
| TD-06 | `shell:*` 75 个通道完全无冻结机制、无集合测试 | IPC | P0 | ✅ 是 |
| TD-07 | 128 个 handler 中只有 1 个（`shell:work`）做发送方信任校验 | IPC/安全 | P1 | ✅ 是 |
| TD-08 | 全库无 `setPermissionRequestHandler`，摄像头/麦克风/剪贴板权限未显式拒绝 | 安全 | P1 | ⬜ 否 |
| TD-09 | `harnessView` 加载第三方 Web UI，无 `will-navigate` 拦截 | 安全 | P1 | ⬜ 否 |
| TD-10 | CI 不在发布链上跑测试，测试只在 `continue-on-error: true` 的每日工作流跑 | CI | P0 | ✅ 是 |
| TD-11 | 原子写代码在 15 个文件里各写一遍，质量参差（3 处固定 `.tmp` 会并发互踩） | 重复 | P1 | ✅ 是 |
| TD-12 | safeStorage 加密仓 3 套重复实现（KeyVault / TokenStore / ChannelSecrets） | 重复 | P2 | ⬜ 否 |
| TD-13 | 两套互不重叠的 i18n 字典（`i18n.js` 638 keys + `workbench/i18n.js` 1008 keys） | 重复 | P2 | ⬜ 否 |
| TD-14 | `.dsh/` 不写 `.gitignore`，污染用户工作区仓库 | 数据 | P1 | ✅ 是 |
| TD-15 | `src/work` 的单活动项约束（`currentId` 单值 + `WORK_BUSY`）与 Mission 多并行语义对立 | 架构 | P0 | ✅ 是 |
| TD-16 | `work-controller.templateId` 是死字段：main.js 从不传入，无模板注册表 | 假接口 | P1 | ✅ 是 |
| TD-17 | `workStatusPayload()` 无异常保护，索引损坏会导致工作台空白且无错误出口 | 健壮性 | P1 | ✅ 是 |
| TD-18 | `scanManifest` 在主进程同步递归遍历最多 5000 个文件 | 性能 | P2 | ✅ 是 |
| TD-19 | `registerIpc()` 单函数 627 行 / 106 个 handler，无声明式注册表 | 结构 | P1 | ✅ 是 |
| TD-20 | 无 preload↔main 通道一致性测试（preload 暴露的 invoke 可能无 handler） | 测试 | P1 | ✅ 是 |
| TD-21 | `workbench:*` 有 `CHANNELS` 常量但无测试，且常量与实际注册不同步 | IPC | P2 | ⬜ 否 |
| TD-22 | 变异测试纪律真实但无工具，无法回归 | 测试 | P1 | ⬜ 否 |
| TD-23 | `tdz-guard` 只覆盖 `createXxx({...})` 工厂块，不覆盖 `registerIpc()` 内部 | 测试 | P2 | ⬜ 否 |
| TD-24 | 无 lint / formatter / 类型检查（devDependencies 只有 electron + electron-builder） | 工具链 | P2 | ⬜ 否 |
| TD-25 | Electron 37 主进程 vs 36 弃用 API；`package-lock.json` 与 `pnpm` 并存 | 依赖 | P2 | ⬜ 否 |
| TD-26 | 已被 `electron-builder` 排除但仍被维护的代码 19,845 行（workbench + behavior-graph + layout-editor） | 死重量 | P2 | ⬜ 否 |
| TD-27 | 8 个模块无任何引用方（entry-only 或孤儿） | 死代码 | P3 | ⬜ 否 |
| TD-28 | `src/workbench/test/*.test.js` 56 个测试不在 `npm test` 的 glob 内 | 测试 | P2 | ⬜ 否 |
| ~~TD-29~~ | ~~`runtimeVersion` 锁 0.1.5-rc.2，兼容矩阵 `<0.2.0-0` 显式排除官方 0.2.x~~ | ~~依赖~~ | ~~P0~~ | ✅ **已解决 2026-11-01** |
| TD-30 | `before-quit` 同步执行备份，无超时保护，退出可能变慢 | 健壮性 | P2 | ⬜ 否 |
| TD-31 | `settings.html` 5895 行（4409 行内联 `<script>`），17 个页面挤一个文件 | 结构 | P2 | ⬜ 否 |
| TD-32 | IM 通道 `allowFrom: ['*']` 是一等选项（全开放模式），且 `pbbp2` 私有协议实现无外部校验 | 安全 | P2 | ⬜ 否 |
| **TD-33** | **兼容账本陈旧三个月**：CI 每日双平台验证 `0.2.1-rc.5` 全绿，但 `docs/compat/compat-status.json` 停在 `0.1.5-rc.2`（2026-09-16），PR #7 自 2026-09-17 OPEN；`compat-status.js:78-81` 的 `current===latestVerified` 恰好因「锁定版本=陈旧账本」而显示「已是最新」 | 信息链 | **P0** | ✅ 是 |

---

## 详细条目

**✅ 已启动修复（2026-11-01，Issue #22 Phase 0）**：

按用户要求「行为测试先行、小步提取」，Phase 0 未搬任何代码，而是先建立两层安全网：

1. **IPC 契约快照**（`test/ipc-contract.test.js`，8 项）—— 124 个通道的集合、命名规范、重复注册、preload↔handler 一致性、office:* 冻结集合、以及「哪些文件注册了 IPC 但未登记」。
2. **已抽出域的行为测试**（`test/ipc-features.test.js`，20 项）—— 用假 ipcMain + 注入 ctx 直接调用 11 个 handler，全程不 require('electron')。

**Phase 0 立刻抓到一个真实 bug**：`src/ipc-features.js` 的 `weekly:open-dir` 用了 `path.join`，但该文件**从未 require('node:path')** —— 一旦调用必然 ReferenceError。因为 main.js 顶层没有测试，handler 注册成功、调用才炸，所以这个缺陷一直存在。已修复并加回归测试。

这正是「先给已抽出模块建测试」的价值：不是搬代码，而是先让「搬了有没有错」可被机械判定。

### TD-01 · `main.js` 已经不可测试地过载

**位置**：`src/main.js`（6385 行）

**证据**：
- `wc -l src/main.js` → 6385
- `grep -c "^function \|^async function " src/main.js` → 196 个顶层函数
- `grep -c "ipcMain.handle(" src/main.js` → 107（其中 106 个在 `registerIpc()` 内，该函数 `src/main.js:2356-2983`，**627 行**）
- **没有任何测试加载它**：`grep -rn "require.*src/main" test/` 无命中；`test/` 里 38 个文件提到 `main.js` 但全部是 `fs.readFileSync` 做**源码字符串断言**（`assert.match`）

**影响**：
1. 627 行单函数内 106 个 handler 顺序注册，任何插入都靠人工保证 `settings`/`runtimeAuth`/`remote` 等依赖已初始化；`test/tdz-guard.test.js` 只能防其中一小类（TD-23）。
2. 无法做单元测试 → 所有接线只能靠源码正则断言（`cockpit-ui.test.js` 157 处 `assert.match`），**改名/重构会大量误红，真实 bug 反而测不到**。
3. `ipc-features.js:4` 自己承认："The legacy shell handlers (86 of them) stay in main.js until their business domains are modularized (v0.4 plan)" —— **v0.4 计划至今未执行，现在已是 107 个**。

**建议**：按域抽 `src/ipc/{settings,runtime,plugins,mcp,channels,remote,work,cockpit}.js`，每个域导出 `register(ipcMain, deps)`；`main.js` 只保留组合根 + deps 装配。

**优先级**：P0 · **阻塞新方向 = 是**（Mission Core 的 IPC 面若继续堆进 main.js，债务翻倍）

---

### TD-02 · `settings.json` 是"无 schema、无迁移、损坏即静默丢全部"的存储

**✅ 已修复（2026-11-01，Issue #19）**：新增 `src/settings-persistence.js`（分层回退 + .bak 链 + 原子写）并接入 `SettingsStore`。损坏时**另存 `.corrupt-<ts>`** 而非覆盖；`loadStatus()` 供 UI 如实告知用户；`schemaVersion` 已注入且不泄漏到设置语义层。18 项专项测试。


**位置**：`src/settings-store.js`

**证据**：
```js
// :91  文件路径
this.file = path.join(userDataDir, 'settings.json');
// :96-107  加载
load() {
  try {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.data = { ...DEFAULTS, ...raw };
    delete this.data[LEGACY_TOKEN_WIDGET_KEY];
    for (const [key, from, to] of V41_MIGRATIONS) {
      if (this.data[key] === from) this.data[key] = to;
    }
  } catch {
    // first run or corrupt file: keep defaults      ← 静默吞掉，无提示、无日志、无诊断码
  }
}
```
- **无 `schemaVersion` 字段**：`grep -n "schemaVersion" src/settings-store.js` 无输出
- **"迁移"只是值替换**：`V41_MIGRATIONS`（:15-23）是 `[key, oldDefault, newDefault]` 三元组，"如果当前值恰好等于旧默认值就换成新默认值"。**无法处理字段重命名、类型变更、结构嵌套、枚举扩张**
- **53 个 key**（`node -e "console.log(Object.keys(require('./src/settings-store').DEFAULTS).length)"` → 53），包含 `recentWorkspaces`、`installedPlugins`、`scheduledTasks`、`modelProviders`、`mcpServers`、`imChannels` 这些**用户无法重建的数据**

**影响**：
1. 一次磁盘半写/用户手改/编码问题 → 全部 53 个设置回落默认，**用户得不到任何提示**；下一次任意 `patch()` 会把默认值写回磁盘，**原文件被永久覆盖**。
2. 未来加字段无法与旧版本区分（"这个空数组是用户清空的，还是新字段默认？"）。
3. `V41_MIGRATIONS` 这类"值碰巧等于旧默认"的启发式在用户**故意**设成旧默认值时会产生错误迁移（虽然当前影响小，但模式本身不可扩展）。

**建议**：加 `schemaVersion` + 迁移函数表；损坏时先尝试 `<file>.bak`（office 已有先例），再失败则**备份原文件并弹通知**，禁止静默。

**优先级**：P0 · **阻塞新方向 = 是**（Mission 的 ProjectStore 必须从第一天就有版本+迁移+备份）

---

### TD-03 · `.dsh/index.json` 的安全等级低于 office 状态

**✅ 已修复（2026-11-01，Issue #19）**：新增 `src/settings-persistence.js`（分层回退 + .bak 链 + 原子写）并接入 `SettingsStore`。损坏时**另存 `.corrupt-<ts>`** 而非覆盖；`loadStatus()` 供 UI 如实告知用户；`schemaVersion` 已注入且不泄漏到设置语义层。18 项专项测试。


**位置**：`src/work/workspace-store.js`

**证据**：
```js
// :211-215  损坏 → 抛错，刻意不重建
try { parsed = JSON.parse(raw); }
catch { throw codeError('WORK_INDEX_INVALID', 'index.json is not valid JSON (kept untouched)'); }
// :78-80  版本不符 → 抛错
if (value.schemaVersion !== WORK_SCHEMA_VERSION) {
  throw codeError('WORK_INDEX_INVALID', `unsupported index schemaVersion: ${value.schemaVersion}`);
}
```
**对比同一仓库里的 office**（`src/office/runtime/office-persistence.js`）：
```js
// :244-255  损坏 → 读 .bak → 再不行回落默认
if (!primary.missing) {
  noteDiagnostic('OFFICE_STATE_CORRUPT');
  const backup = parseStateFile(backupFile);
  if (backup.ok) return applyEpochGate(backup.state);
  ...
}
// :288  每次成功写后留一份 .bak
try { fs.copyFileSync(file, backupFile); } catch { /* low-permission dirs */ }
```
- `grep -n "\.bak\|backupFile" src/work/workspace-store.js` → **无输出**

**影响**：工作产物索引损坏 → 用户所有工作项、产物记录、来源、digest **永久不可读**（因为 fail-closed 不重建，且没有副本）。而 `docs/architecture/domain-model.md` 把 Mission 定义为"DshCockpit 唯一作者的事实源"，安全等级应**高于** office。

**建议**：写后留 `.bak`；读取失败时按 `.bak` → 从 `.dsh/artifacts/` 反扫重建（产物文件本身还在，可重建索引）→ 最后才报错。

**优先级**：P0 · **阻塞新方向 = 是**

---

### TD-04 · 工作产物索引全量覆盖写 + 无条目上限

**位置**：`src/work/workspace-store.js`

**证据**：
```js
// :71-73  索引形状：单个可变 JSON 文档
function emptyIndex(workspaceId) {
  return { schemaVersion: WORK_SCHEMA_VERSION, workspaceId, items: [], artifacts: [] };
}
// :222-226  每次改动重写整个文档
function saveIndex(absPath, index) {
  writeJsonAtomic(indexPathOf(absPath), index);
  openIndexes.set(absPath, index);
  return index;
}
// 8 处调用 saveIndex：:231(:flush) :258(open) :311(registerArtifact)
// :320(appendItem) :329(updateItem) :338(attachArtifactToItem) :474(registerShellArtifact)
```
- **无条目上限**：`grep -n "MAX_ITEMS\|items.length\|slice(-" src/work/workspace-store.js` → 无输出。`appendItem`（:316-322）与 `registerArtifact`（:282-314）都只 `push`，永不裁剪、永不归档
- **对比 office**：有 `TASK_HISTORY_PER_EMPLOYEE = 50`、`ACTIVITY_LOG_LIMIT = 200`（`office-persistence.js:39-40`）、`MAX_HISTORY = 500`（`notification-center.js:12`）

**影响**：
1. 每次状态变化（`updateItem` 逐字段 patch、`attachArtifactToItem`）都序列化并重写**全部历史** → 随使用时间呈 **O(n²)** 写入量。
2. 长期 Mission（Vision V2："关闭应用一周后重开，Mission 的状态/决策/产物仍完整可用"）会让 `index.json` 无限增大，而它每次都要被完整读入内存 + JSON.stringify。
3. 与 `docs/architecture/domain-model.md` §5 选择的方案 C「append-only JSONL + 内存索引」**方向相反**。

**建议**：改事件 append（JSONL）+ 定期快照压缩；或至少加 `MAX_ITEMS` + 归档目录。

**优先级**：P0 · **阻塞新方向 = 是**（Mission 数据量级远大于当前 WorkItem）

---

### TD-05 · 备份只覆盖 2 个 key，壳层状态零备份

**✅ 已修复（2026-11-01，Issue #19）**：新增 `src/settings-persistence.js`（分层回退 + .bak 链 + 原子写）并接入 `SettingsStore`。损坏时**另存 `.corrupt-<ts>`** 而非覆盖；`loadStatus()` 供 UI 如实告知用户；`schemaVersion` 已注入且不泄漏到设置语义层。18 项专项测试。


**位置**：`src/backup.js:24`

**证据**：
```js
const INCLUDED_KEYS = ['sessions', 'settings.yaml'];
```
即只备份 `~/.dsh/sessions/`（Harness 会话）与 `~/.dsh/settings.yaml`（Harness 设置）。

**完全不备份**（`main.js` 中 `app.getPath('userData')` 下的写出清单，`grep -rn "path.join(app.getPath('userData'), '" src/main.js`）：
```
settings.json              ← 壳的 53 个设置
office-state.v1.json       ← 办公室状态（有 .bak 单份，但不在 backup 体系内）
office-layout.v1.json      ← 用户编辑的办公室布局
<workspace>/.dsh/index.json ← 工作产物索引（无任何副本）
cost-history.json / balance-snapshot.json / compact-history.json
notification-history.jsonl / office-rail-state.json / im-bindings.json
profile-snapshots/         ← 自身是备份，但不在 backup 体系的内置/裁剪策略里
```
设计上的"故意不备份"只适用于密钥类（`backup.js:5-6`：`.credentials.yaml` 明文副本是负债；`remote-token.bin`/`*-secrets.json`/`model-keys.json` 同理）。**`settings.json`、`office-state.v1.json`、`.dsh/index.json` 不在这个理由范围内，只是没被加进去。**

**影响**：用户换机/重装/磁盘故障 → 会话历史还在，**但所有壳设置、办公室状态、工作产物索引全丢**。Work Product 索引丢了等于"产品核心承诺（V3 产物可追溯）失效"。

**建议**：把 `INCLUDED_KEYS` 扩展为白名单模式（每项声明是否需要脱敏），并对 `.dsh/index.json` 做 per-workspace 备份。

**优先级**：P0 · **阻塞新方向 = 是**

---

### TD-06 · `shell:*` 75 个通道零冻结保护（占 IPC 面 56%）

**位置**：`src/main.js`（无常量）、`src/ipc-features.js`

**证据**：
- `grep -rn "SHELL_CHANNELS\|SHELL_IPC" src test` → **无输出**
- `grep -rn "shell:\*" src/*.js test/*.test.js` → 只命中两条注释（`main.js:310`、`settings-ui.test.js:428`），无任何集合断言
- 对比 `office:*`：有 `OFFICE_IPC_CHANNELS` 常量（`office-module.js:204-214`）+ **5 个测试**精确断言集合（`office-ui.test.js:794, 854`；`office-ux-mustfix.test.js:353`；`office-right-panel-p4.test.js:475`；`office-interaction-p3.test.js:262`；`office-pages-english.test.js:154`）

**影响**：
1. 新增/删除/改名任何 `shell:*` 通道**不会让任何测试变红**。而 `shell:*` 包含全部高风险动作：`shell:public-remote-enable`、`shell:tunnel-start`、`shell:plugin-action`、`shell:restore-snapshot`、`shell:safe-mode`、`shell:work`、`shell:model-save`、`shell:channels-configure`。
2. `AGENTS.md` §2.5 写「`office:*` 通道集合在契约里冻结」容易被误读为"壳层有通道纪律"，实际只有 office 那 9 个有。
3. 当前 75 个通道无任何能力分级，`shell:safe-mode`（重置 profile）与 `shell:get-theme`（读主题）在危险度上是同一类。

**建议**：建 `SHELL_CHANNELS` 常量 + 按危险度分级（read / write / destructive）+ 集合测试 + preload 白名单。

**优先级**：P0 · **阻塞新方向 = 是**

---

### TD-07 · 128 个 handler 只有 1 个校验发送方

**位置**：`src/work/work-ipc.js:79-90, 125`

**证据**：
```js
// work-ipc.js:125  ← 全库唯二的 sender 校验之一
ipcMain.handle('shell:work', async (event, payload) => handle(payload, isTrustedWorkSender(event)));
```
`grep -rn "senderFrame\|event.sender" src --include=*.js` 只命中 3 处：
- `work-ipc.js:79`（真正的 URL 校验）
- `workbench/app/ipc.js:72`（`event.sender === windowWebContents`，仅用于向发起者回推进度，非准入控制）
- `channels/receivers/feishu.js:58`（飞书 SDK 的字段名，无关）

**影响**：风险评估为 **[部分实现/待验证]**：
- 缓解因素：所有渲染进程 `sandbox: true` + `contextIsolation: true`；`src/preload.js` 故意为空（5 行注释），所以加载第三方 dsh Web UI 的 `harnessView` **拿不到 IPC**；`will-navigate` 在 8 处被拦截。
- 真实风险：**纪律不对称且无文档说明**。新写一个通道时，"要不要校验 sender"没有规则可依；`shell:public-remote-enable`（把手机网关暴露到公网，`main.js:2319-2327`）与 `shell:get-theme` 享受同等信任。

**建议**：定义"哪些通道必须校验 sender"（凡 `destructive` 类必须），并把 `isTrustedWorkSender` 抽成通用 `assertSender(event, expectedFile)`。

**优先级**：P1 · **阻塞新方向 = 是**（Mission 的写操作通道需要明确的信任模型）

---

### TD-08 · 无任何 Electron 权限请求处理器

**位置**：全库缺失

**证据**：`grep -rn "setPermissionRequestHandler\|setPermissionCheckHandler" src` → **0 处**

**影响**：Electron 默认行为下，渲染进程可以请求摄像头/麦克风/地理位置/通知/剪贴板读取/MIDI 等权限（部分需要用户系统弹窗，部分不需要）。当前：
- 若 dsh Web UI 或某个插件页面请求权限，壳层**不会拒绝也不会记录**；
- 没有"哪些 origin 允许哪些权限"的策略。

**建议**：`session.defaultSession.setPermissionRequestHandler` 默认全部 deny，仅对 `file://` 且已声明的能力白名单放行。

**优先级**：P1 · **阻塞新方向 = 否**

---

### TD-09 · `harnessView` 加载第三方 Web UI，无导航拦截

**位置**：`src/window-manager.js:395-403`

**证据**：`harnessView` 创建时设置了 `contextIsolation/nodeIntegration/sandbox` 与 `preload: preload.js`（内容为空），但**没有** `will-navigate` 拦截、**没有** `setWindowOpenHandler`：
```js
harnessView = new WebContentsView({ webPreferences: { ... preload: path.join(__dirname, 'preload.js') } });
mainWindow.contentView.addChildView(harnessView);
```
对比同一个文件里 office/work/rail 三个视图都调用了 `webContents.on('will-navigate', e => e.preventDefault())` 与 `setWindowOpenHandler(() => ({ action: 'deny' }))`（:140-141, 188-189, 217-218, 282-283）。

另：`settingsWindow`、`cockpitWindow`、`quickAskWindow`、`searchWindow`、`loadingWindow` 有 `will-navigate` 但**无** `setWindowOpenHandler`。

**影响**：
- `harnessView` 加载的是 dsh 自己的 UI（第三方代码路径）。若 dsh UI 里有 `target=_blank` 或 `window.open`，因为没有 deny handler，Electron 会**派生子窗口**。派生窗口的 `webPreferences` 由 Electron 默认值决定（不是本仓显式配置），因此**安全项不可控**——这是"不是我们决定的"而非"我们决定为不安全"。
- 直接后果取决于 dsh UI 行为 + Electron 37 的派生子窗口默认值，**[待验证]**（本审计未在真机触发过 `window.open`）。
- 缓解因素：`harnessView` 的 `preload.js` 为空（5 行注释，故意不暴露任何 API），所以即使派生子窗口，也拿不到本应用的 IPC 面。

**建议**：全部 `WebContentsView`/`BrowserWindow` 统一加 `setWindowOpenHandler(() => ({action:'deny'}))`，外链一律走 `shell.openExternal` 并校验协议。

**优先级**：P1 · **阻塞新方向 = 否**

---

### TD-10 · CI 不在发布链上跑测试

**位置**：`.github/workflows/`

**证据**：
| 工作流 | 触发 | 是否跑 `npm test` |
|---|---|---|
| `release-win.yml` | tag push / 手动 | ❌ **不跑**（注释 :20-24 明确写"发布流水线不再用单元测试门禁"），只有 build + `verify-dist` + `e2e-smoke` |
| `release-mac.yml` | tag push / 手动 | ❌ **不跑**（注释 :19-23 同上），只有 build + e2e-smoke |
| `upstream-compat.yml` | 每日 03:00 + 手动 | ✅ 跑，但 `test` job 有 **`continue-on-error: true`**（:41），且注释 :36-40 写明"informational — a red unit suite must not turn the daily run red（that is what spammed failure mails）" |
| `mirror-downloads.yml` | 定时 6h + release 完成后 | ❌ 不跑（只同步安装包镜像） |

因此：**`npm test` 只在一条每日定时、且失败不报警的工作流里跑**（结果通过邮件发送，且邮件需配置 SMTP secrets 才发；未配置时只 `::warning::`，`upstream-compat.yml:391`）。**没有任何 PR/push 触发的测试门禁**。

**影响**：
1. 1935 项测试的**保护价值被削弱为"事后发现"**：一个破坏性提交可以一路合进 `develop` 并打出 tag，没有任何 CI 红灯。
2. `continue-on-error: true` + 邮件通知 + 邮件需手工配 secrets = 实际观测率取决于人的自觉。
3. 已知有 1 个长期红（`office-ui.test.js:1294` E5a-R1 真机探针 exit 9），这类环境相关红会**进一步降低信号可信度**。

**建议**：至少加一条 `push` → `npm test`（可 `fail-fast: false`、可对已知红做显式 skip 列表），把"已知红"变成显式配置项而不是容忍。

**优先级**：P0 · **阻塞新方向 = 是**（Mission Core 是大重构，没有 CI 门禁等于裸奔）

---

### TD-11 · 原子写 15 份复制，3 处会并发互踩

**位置**：15 个文件（见下）

**证据**：`grep -ln "renameSync(tmp" src/*.js src/*/*.js src/*/*/*.js` →
```
balance.js, boot-check.js, channels/credentials.js, channels/receivers/base.js,
compact.js, compat-status.js, main.js, models-manager.js(×2), notification-center.js,
office/runtime/office-persistence.js(×2), remote-control.js, runtime-manager.js,
settings-store.js, skills.js, window-state.js, work/workspace-store.js
```
质量分三档：

| 档位 | 特征 | 例子 |
|---|---|---|
| 强 | tmp 名含 pid+时间+随机串；fsync；串行写链 | `workspace-store.js:186-190`（`${file}.tmp-${pid}-${nowMs()}-${randomId()}`）；`office-persistence.js:277-281` + `writeChain`(:196,261,292) |
| 中 | tmp 名含 pid | `main.js:3529`（`.${basename}.${pid}.tmp`） |
| **弱** | **固定 `.tmp` 后缀，无 pid/随机** | `settings-store.js:112`（`${this.file}.tmp`）；`window-state.js:18`；`runtime-manager.js:108` |

**影响**：固定 `.tmp` 的三处，两个执行流同时保存会**互相 rename 掉对方的内容**或 `ENOENT`。`settings-store` 被 `shell:save-settings`（`main.js:2368`）调用，`runtime-manager.saveState` 在安装/切换/失败计数多条路径上都会被调用 → 并发窗口真实存在（虽非高频）。

**建议**：抽 `src/storage/atomic-write.js`（tmp 名含 pid+随机 + fsync + 可选串行链），15 处全部替换。

**优先级**：P1 · **阻塞新方向 = 是**（Mission 的存储必然用同一套）

---

### TD-12 · safeStorage 加密仓 3 套重复实现

**位置**：`src/models-manager.js:451`（`class KeyVault`）、`src/remote-control.js:179`（`class TokenStore`）、`src/channels/credentials.js:14`（`class ChannelSecrets`）

**证据**：`channels/credentials.js:5-7` 自己写明了原因：
> "Same 范式 as remote-control's TokenStore / models-manager's KeyVault（the shared pattern was kept local to avoid touching stable modules in C5）"

即**为了不碰稳定模块而故意复制**——已知取舍。三者都实现：`usable()` 探测 → `encryptString` → 失败回落 `plain:`/base64 → 0600 写 → 原子 rename。

**影响**：三处安全逻辑各自演化。`channels/credentials.js:47` 的回落是 **base64 混淆**（不是加密），且只在 safeStorage 不可用时；`remote-control.js:197` 的回落同样。若某天要加"密钥轮换"或"更严格的回落策略"，要改三处。

**建议**：抽 `src/storage/secret-vault.js`（`createSecretVault(file, safeStorage, log)`），三处改为使用。

**优先级**：P2 · **阻塞新方向 = 否**

---

### TD-13 · 两套零重叠的 i18n 字典

**位置**：`src/i18n.js`（1347 行，638 keys）、`src/workbench/i18n.js`（1188 行，1008 keys）

**证据**：
```
node -e "const a=require('./src/i18n.js').STRINGS; console.log(Object.keys(a.zh||{}).length)"  → 638
workbench/i18n.js 键正则匹配 → 1008 keys
交叉比对重叠键数 → 0
```
两个文件都提供 `t(lang, key, vars)` 与 `apply()`，但**键集完全不相交**，且 `workbench/i18n.js` 是**浏览器端**（通过 `<script>` 加载，不走 IPC 拉表），而壳层页是通过 `shell:get-i18n` 拉 `STRINGS` 表（`main.js:2429`）。

**影响**：两套翻译、两套 key 命名习惯（`work.*` vs `bench.*`）、两套语言切换流程。若未来把工作台并入产品，需要合并或双轨并存。

**建议**：因为 workbench 当前不进发行包（`electron-builder.js:54`），可**暂不合并**；但需在文档中明确"两套字典是已知的、有意的分离"，避免后续误判为 bug。

**优先级**：P2 · **阻塞新方向 = 否**

---

### TD-14 · `.dsh/` 不写 `.gitignore`，污染用户工作区

**位置**：`src/work/workspace-store.js`（`ensureLayout`，:171-184）

**证据**：
- `ensureLayout` 只 `mkdir .dsh/artifacts` + 写 `.dsh/work.json`，**不碰 `.gitignore`**
- `grep -rn "gitignore" src/work/ src/main.js` → **无输出**
- 根 `.gitignore` 里也没有 `.dsh`（`grep -n "\.dsh" .gitignore` 无命中）
- 扫描时排除 `.dsh`（`workspace-store.js:32`）证明作者知道它是自产目录

**影响**：用户打开任何一个已有 git 项目作为工作区 → 立刻多出一个未跟踪的 `.dsh/` 目录，`git status` 脏。用户要么手工 ignore，要么每次看到脏状态。**没有任何提示。**

`docs/architecture/domain-model.md` Q5「Mission 数据是否要可 git 追踪（进用户仓库的 .dsh/）」还标注"待用户拍板 / 倾向是"。**当前实现事实上是"进仓库且不 ignore"**，等于**用默认行为替用户做了未拍板的决定**。

**建议**：`ensureLayout` 检测到工作区是 git repo（存在 `.git/`）时，把 `.dsh/` 追加到 `.git/info/exclude`（不改用户 `.gitignore`，更礼貌）或明确弹一次提示。

**优先级**：P1 · **阻塞新方向 = 是**（Mission 会写更多数据进 `.dsh/`，污染面扩大）

---

### TD-15 · `src/work` 的单活动项约束与 Mission 多并行语义对立

**位置**：`src/work/work-controller.js:55, 92-95`

**证据**：
```js
let currentId = null; // 只允许一个活动工作项（P1）
...
const active = activeItem();
if (active && ACTIVE_STATUS.includes(active.status)) {
  return Object.freeze({ ok: false, code: 'WORK_BUSY' });
}
```

**影响**：这是**结构性**约束，不是参数：
- `activeItem()` / `sync()` / `onArtifact()` / `runVerification()` / `captureDiff()` 全部依赖 `currentId` 单值来定位"当前项"；
- `baseline` / `baselineItemId` / `diffCaptured` 也是**单份内存状态**（:57-59），多并行会互相覆盖；
- `main.js:498` 与 `:513` 另有 `TEAM_ALREADY_ACTIVE` 单实例守卫（`officeTeamRealInstance`），是第二道单值约束。

`docs/architecture/domain-model.md` §2 与 Vision §4.2 场景 B 都要求"一个项目持续两周 / 多条 Workstream"，`docs/product/WORK-FIRST-V0.7.md` §7 P3 明确"并行 work-item"。

**建议**：Mission Core 另起 `src/mission/**`，`src/work` 保留为"单次 Team 执行"的执行面（它对 Team 的接线是真实验收过的资产）。Mission 与 WorkItem 是 `1—N` 引用关系，不是替换。

**优先级**：P0 · **阻塞新方向 = 是**

---

### TD-16 · `templateId` 是死字段（假接口）

**位置**：`src/work/work-controller.js:87, 99, 217`

**证据**：
```js
// :87  begin 默认值
function begin({ goal, templateId = 'research-review', verifyCommand = '', ... } = {}) {
// :99  存进 item
templateId,
// :217  retry 时原样保留
templateId: prev.templateId,
```
但**唯一的调用点从不传**：
```js
// src/main.js:500
const begun = controller.begin({ goal, verifyCommand });
```
且 `grep -n "templateId" src/` 的全部命中只有 work-controller 内部 + `main.js:2594`（定时任务的**不相干**字段，属于 `scheduledTasks`）。**没有任何模板注册表、没有消费者、没有 UI**。

**影响**：`docs/product/product-vision.md` 的 **Starter Kit**、`docs/research/capability-providers.md` 的 **Capability Pack / Profile Composer** 都依赖"模板"概念。当前代码里有一个名叫 `templateId` 的字段恒为 `'research-review'` 且从未被读取 —— **会让设计者误判"模板机制已有雏形"，实际是零**。

**建议**：要么删除该字段（诚实地表示没有模板），要么实现最小模板注册表并接进 `main.js:500`。**不要留着当"未来会用到"**。

**优先级**：P1 · **阻塞新方向 = 是**（Starter Kit 的判断依据会被污染）

---

### TD-17 · `workStatusPayload()` 无异常保护

**位置**：`src/main.js:424-439`

**证据**：
```js
function workStatusPayload() {
  const controller = ensureWorkController();
  if (!controller) { return Object.freeze({ ok: true, code: workWorkspaceError, ... }); }
  return Object.freeze({
    ok: true, code: null, ...controller.snapshot(),   // ← snapshot() 可能抛（索引损坏）
    focusEmployee: officeFocusEmployeeId,
    team: officeTeamRealStatus(),
  });
}
```
`controller.snapshot()` → `store.readIndex()` → 索引损坏时抛 `WORK_INDEX_INVALID`（`workspace-store.js:214`）。调用点：
- `shell:work status`（`main.js:640`）→ 直接 reject 整个 IPC
- `sendWorkUpdate()`（`main.js:470`）→ 在 `setTimeout` 里，异常被外层 `try/catch` 吞成静默（`main.js:472` `catch { /* the work view may not be up yet */ }`）

**影响**：索引损坏时用户看到的是**工作台空白 + 无任何错误信息**，且无法通过 UI 恢复（因为 `status` 永远失败）。这与项目铁律"不伪造、错误要可见"相反。

**建议**：`snapshot()` 加 try/catch 返回 `{ ok:false, code }`；UI 渲染诊断卡并提供"备份并重建索引"入口。

**优先级**：P1 · **阻塞新方向 = 是**

---

### TD-18 · `scanManifest` 在主进程同步阻塞

**位置**：`src/work/workspace-store.js:371-398`

**证据**：
```js
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  ...
  try { stat = fs.statSync(abs); } catch { continue; }   // 每个文件一次同步 stat
};
walk(rootPath);
```
上限 `MANIFEST_MAX_FILES = 5000`（:28），即最坏 **5000 次同步 `statSync` + 数百次 `readdirSync`**，全部在 Electron 主进程、在 `begin()`（:115）与 `captureDiff()`（:298，终态时触发）里调用。

同一仓库已有正反两个先例：
- `main.js:3002-3019` `dirSizeMBAsync`：用 `fsp.opendir` + 每 256 条 `setImmediate` 让出 —— **这是正确做法**
- `backup.js:170-197`：注释写"`readdirSync+statSync` per file 会钉死主线程（Windows+AV 同款陷阱）"

**影响**：Windows + AV 环境下，5000 同步 stat 可能数百毫秒到数秒的主线程卡顿（正是 `backup.js:8-17` 记录过的那类问题）。任务开始的瞬间与终态瞬间是用户最可能操作 UI 的时刻。

**建议**：改异步 + 分批让出；或放到 worker 线程（已有 `session-worker` 基础设施）。

**优先级**：P2 · **阻塞新方向 = 是**（Mission 的工作区可能更大）

---

### TD-19 · `registerIpc()` 627 行单函数

**位置**：`src/main.js:2356-2983`

**证据**：`awk 'NR>=2356 && NR<=2983 && /ipcMain.handle\(/{c++} END{print c}'` → **106**

**影响**：见 TD-01。补充一点：这 627 行里混杂了 **注册**与**业务逻辑**（如 `shell:scheduled-upsert` 的 40 行 sanitize 逻辑直接内联在 `main.js:2586-2628`），导致业务逻辑也无法测试。

**建议**：同 TD-01。

**优先级**：P1 · **阻塞新方向 = 是**

---

### TD-20 · 无 preload↔main 通道一致性测试

**位置**：测试体系缺失

**证据**：`grep -rn "preload" test/*.test.js | grep -c "invoke.*handle"` → 0。存在 11 个 preload（`preload/cockpit/settings/quickask/search/loading/office-rail/office/work/workbench` + office 的 office-preload），暴露约 **170 个 invoke/send 调用点**（实测：settings-preload 单文件 95 个）。**没有任何测试断言"preload 暴露的每个通道在 main 侧有 handler"**。

**影响**：改名/删除 handler 后，preload 仍会暴露一个永远 reject 的 API。UI 表现为"点了没反应"，测试全绿。这是最容易发生的静默回归类型。

**建议**：加一个纯静态测试：解析所有 preload 的 `invoke('x')` 集合 + 解析所有 `ipcMain.handle('x')` 集合，断言前者 ⊆ 后者。

**优先级**：P1 · **阻塞新方向 = 是**（Mission 的 IPC 面要继续扩张）

---

### TD-21 · `workbench:*` 有常量无测试且已漂移

**位置**：`src/workbench/app/ipc.js:11-27`

**证据**：
```js
const CHANNELS = Object.freeze([
  'workbench:content-tree', ... 'workbench:action-publish',   // 16 项
]);
```
但：
- 实际注册是 16 个 `ipcMain.handle` + **1 个 `ipcMain.on('workbench:report-preview-rect')`**（:70，注释写 "deprecated no-op"）—— 该 on 通道**不在常量里**
- `grep -rn "CHANNELS" src/workbench/test/*.test.js` → **无输出**；`grep -rn "workbench:" src/workbench/test/*.test.js` → 无输出

**影响**：常量是"文档性"的，没有任何机制防止漂移；已存在一个漂移实例。

**建议**：用常量遍历注册（`for (const ch of CHANNELS) ipcMain.handle(ch, ...)`），并加集合测试。

**优先级**：P2 · **阻塞新方向 = 否**（workbench 不进发行包）

---

### TD-22 · 变异测试纪律无工具化

**位置**：全仓

**证据**：
- `ls scripts/ | grep -i "mutat\|mutation"` → **无结果**
- 但纪律真实执行且**诚实记录**：`docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md:49-58` 有 M1-M7 矩阵，其中 **M3 明确标注 MASKED**（"第二道 containment 检查仍拦截"）并补了等价变异 M3'；`docs/plans/completed/HARNESS-V0.6-REPORT-2026-10-26.md:107` 记录 "M-W5 teamPhase 移出签名 | **未红（掩蔽）**"
- `AGENTS.md` §4.3 强制要求："每组新测试配负向变异（破坏→必须红→还原→复绿）。无法被变异检出的测试要**如实记录**（masked），不得谎称 DETECTED"

**影响**：纪律的**诚实度可信**（有 MASKED 记录），但**不可回归**：没有工具，下次改动不会自动重跑，历史变异结论会随时间失效。新加入的 agent 也无法验证既有测试是否仍然"能抓"。

**建议**：至少对 `src/work/**` + `src/team/**` 这两个新方向核心做半自动变异脚本（列出变异点 → 脚本 apply/run/revert → 输出矩阵）。

**优先级**：P1 · **阻塞新方向 = 否**（但影响新方向的质量保证）

---

### TD-23 · `tdz-guard` 覆盖范围窄

**位置**：`test/tdz-guard.test.js:34`

**证据**：
```js
const factoryRe = /const\s+(\w+)\s*=\s*(create\w+)\(\{\n([\s\S]*?)\n\}\);/g;
```
只扫描 **`const X = createY({ ... })` 形式、且 `{` 后必须紧跟换行、且内部不含 `})` 行**的顶层工厂块。

**未覆盖**：
- `registerIpc()` 函数体内部的引用顺序（106 个 handler，最容易出错的地方）
- `app.whenReady().then(...)` 回调内部（280 行，`main.js:5967-6240`）
- 非 `create` 前缀的工厂（如 `const supervisor = createRuntimeSupervisor({...})` 能覆盖，但 `const { a } = require(...)` 之后解构重命名的情况不覆盖）
- 对象字面量中跨行的简写引用（正则要求 `\}\);` 在同一行）

且 `main.js:389-396` 有注释专门为此写：
> "Explicit keys: the tdz-guard scans factory blocks for shorthand refs and these are function parameters, not top-level bindings."

—— 说明这个 guard 已经出现过**误报**，作者为了让测试通过改了源码写法。这是"测试反向塑造代码"的信号。

**影响**：真实的 TDZ 崩溃（"Cannot access X before initialization"）仍是主进程启动崩溃的高频原因（`test/tdz-guard.test.js:1-4` 注释："Catches the ... class of load-time crashes that npm test cannot see (it never loads main.js)"）。**而 `main.js` 无任何运行时测试**。

**建议**：用 AST（`acorn` 已是 electron 依赖链里的传递依赖）替代正则；或在 CI 里加一个"能否启动到 whenReady"的 smoke（`scripts/e2e-smoke.js` 已做，但只在发布时跑）。

**优先级**：P2 · **阻塞新方向 = 否**

---

### TD-24 · 无 lint / formatter / 类型检查

**位置**：`package.json:20-23`

**证据**：
```json
"devDependencies": { "electron": "^37.0.0", "electron-builder": "^26.15.3" }
```
- `find . -maxdepth 2 -name ".eslintrc*" -o -name "eslint.config.*" -o -name ".prettierrc*"` → **无结果**
- 无 `tsconfig.json`，全 JS 无类型标注
- 无 `scripts.lint` / `scripts.typecheck`

**影响**：
- 唯一的质量闸是 1935 个测试 + 手工 `node --check`（AGENTS.md §6 要求"每删一段 → `node --check` + 相关测试"）
- 语法类错误靠 `node --check`，但**未使用变量/未定义变量/错误的 await/漏 return** 全部无法机械发现
- 大文件改写（TD-01 的拆分）风险显著提高

**建议**：加 ESLint（`no-undef`、`no-unused-vars`、`no-floating-promises` 三条就能堵住大部分坑）。

**优先级**：P2 · **阻塞新方向 = 否**（但会显著拖慢 TD-01 的重构）

---

### TD-25 · 依赖管理双轨（`package-lock.json` + `pnpm`）与 Electron 版本滞后

**位置**：`package.json`、`package-lock.json`

**证据**：
- 根目录有 `package-lock.json`（192KB），但 `package.json` 依赖里含 `pnpm ^10.34.5`（用于子 profile 包管理，不是本仓包管理），CI 用 `npm install`（`release-win.yml` / `release-mac.yml`）
- `electron ^37.0.0` → 实测安装 37.10.3
- `node -v` 本机 24.16.0，但 CI 用 `node-version: 22`

**影响**：
- 本仓用 npm，子 profile 用 pnpm（`pnpm-shim.js` 专门解决"用户机器上 pnpm 版本与 profile 要求不匹配"）—— 两套包管理器语义共存，是必要复杂但也是理解成本
- 本地 Node 24 vs CI Node 22 vs Electron 内置 Node：三个版本语义差异（如 `fs.readdirSync({recursive:true})` 在旧版本的行为）
- `package.json:6` `runtimeVersion: 0.1.5-rc.2` 与官方 0.2.1-rc.5 差一个大版本

**优先级**：P2 · **阻塞新方向 = 否**（但 runtimeVersion 是 P0，见 TD-29）

---

### TD-26 · 已被排除但仍维护的死重量 19,845 行

**位置**：`electron-builder.js:54, 56, 57`

**证据**：
```js
'!src/workbench/**',              // 972KB
'!src/office/behavior-graph/**',  // 1,972 行
'!src/office/layout-editor.js',   // 998 行
```
- `find src/workbench -name '*.js' | xargs wc -l` → **13,933 行**（含 56 个自有测试）
- `wc -l src/office/behavior-graph/*.js` → 1,972 行
- `src/office/layout-editor.js` → 998 行
- 合计 **约 16,900 行 JS**（含测试则近 19,800 行），**不进发行包**

**影响**：
1. 这部分代码仍在 `src/` 下、仍被 `npm test` 之外的测试（`src/workbench/test/`）覆盖、但仍被**任何全库扫描类测试**（`dependency-guard.test.js` 扫 `src/**`）计入 → **占用维护成本但不产生用户价值**。
2. `src/office/behavior-graph/**` 的注释说"产品代码当前不引用它"（`electron-builder.js:50-52`），`grep -rn "behavior-graph"` 确认只有注释与 `verify-dist.js` 的负向断言引用。
3. 违反 AGENTS.md "删除前版本回归"的保守策略——理解，但债务在累积。

**建议**：移出 `src/` 到 `tools/workbench/`（`src/` 语义 = 产品代码），或明确标注"这是工具树，不是产品树"。

**优先级**：P2 · **阻塞新方向 = 否**

---

### TD-27 · 8 个模块无任何引用方

**位置**：见下

**证据**：用脚本解析全部 `require()` + `<script src>`（含 `.js`/`/index.js` 解析），从 `src/main.js` 出发找不可达模块。**注意**：office 页面有一套自研的 `loadModule()` 动态加载机制（`office.html:266, 278-293, 303`），不是 `require` 也不是 `<script src>`，普通静态扫描会误判为死代码，因此下表已逐个人工复核：

| 模块 | 行数 | 真实状态 |
|---|---|---|
| `src/office/behavior-graph/**`（index/diff/feel/interpreter/schema） | 1,972 | ✅ **真死**：产品不引用（`electron-builder.js:50-52` 注释"产品代码当前不引用它"），`grep -rn "behavior-graph" src scripts` 除自身外只命中注释 + `verify-dist.js` 的负向断言 |
| `src/office/runtime/index.js` | 158 | ⚠️ 非死：它是模块清单声明，被 `test/office-runtime-boundary.test.js` require 用于"清单完整性"断言。**合理用途，保留** |
| `src/office/runtime/workstation-layout.js` | 137 | ⚠️ 仅被 `test/office-asset-runtime.test.js:26` require（`normalizeWorkstationDraft`）。**测试专用，产品未用** —— 若产品不需要，属可清理 |
| `src/office/office-boot.js` | 187 | ❌ **不是死代码**（初判错误，已更正）：`office.html:266` 通过 `REGISTRY['office-boot'] = await loadModule('./office-boot.js')` 加载 |
| `src/office/office-page.js`（963）/ `render/pixi-office-renderer.js`（4674）/ `render/frame-hygiene.js`（65） | 5,702 | ❌ **不是死代码**：`office.html:278-303` 动态加载 |

**结论**：真正的无引用模块只有 `behavior-graph/**`（1,972 行）**+** `workstation-layout.js`（137 行，仅测试用），**约 2,100 行**。

**建议**：`behavior-graph` 随 TD-26 一起移出 `src/`；`workstation-layout.js` 确认产品是否还需要（若只服务测试则是测试在给死代码续命）。

**优先级**：P3 · **阻塞新方向 = 否**

---

### TD-28 · `src/workbench/test/` 56 个测试不在 `npm test` 内

**位置**：`package.json:17`

**证据**：
```json
"test": "node --test \"test/*.test.js\""
```
glob 只匹配 `test/` 顶层。而 `src/workbench/test/` 有 7 个文件 56 个测试：
```
action-restore, compare, depth-bands, drop-ghost, history-controller,
item-props, pipeline-panel
```
实测 `node --test "src/workbench/test/*.test.js"` → `tests 56 / pass 56 / fail 0`（全绿）。

**影响**：
- 这 56 个测试**从不被主套件执行**，只在开发工作台时手工跑
- 加上 TD-26，workbench 整体处于"半维护"状态：不进包、测试不跑、但仍需与 office 契约同步
- 更微妙的：`src/` 下放着测试文件，破坏了"src = 产品代码"的语义

**建议**：要么纳入 `npm test`（改成 `node --test "test/*.test.js" "src/workbench/test/*.test.js"`），要么整棵树移出 `src/`。

**优先级**：P2 · **阻塞新方向 = 否**

---

### TD-29 · `runtimeVersion` 锁 0.1.5，兼容矩阵显式排除 0.2.x

> ✅ **已解决（2026-11-01，S1）**：**版本号不再是兼容性判据。**
>
> 问题本质：`semver.satisfies(v, '<0.2.0-0')` 给 0.2.1-rc.5 判"不支持"，
> 而 POC 已实测它 16/16 通过。这个常量的语义早已从"兼容性门禁"退化为
> "上次更新时的版本快照"。
>
> 修复：新增 `src/runtime-capability.js`，用**能力声明 + 已知矩阵 + 四态判定**
> 替代版本比较：
>
> | 判定 | 含义 | 实例 |
> |---|---|---|
> | supported | required + optional 全在 | `0.2.1-rc.5`、`0.2.2-alpha.2` |
> | degraded | required 在，optional 缺 | `0.1.5-rc.2`（无 agent-team） |
> | unsupported | required 缺失 | （真实矩阵中暂无） |
> | **unverified** | **没测过 ≠ 不能用** | `0.2.0`、`0.9.9`、dev build |
>
> 关键语义：**未验证版本一律放行**。若判成不支持，每次上游发版都会禁用壳层。
>
> 矩阵范围**只列实测过的具体版本**（`'0.2.1-rc.5 || 0.2.2-alpha.2'`），
> 不用 `>=0.2.0-0 <0.3.0-0` 这种宽范围——那会把从未测过的 0.2.99 也说成
> supported，等于撒谎。新增版本需手动追加，这是刻意成本：**兼容性结论必须有人负责。**
>
> `SUPPORTED_RUNTIME_RANGE` 保留为展示字符串；新增 `canRunRuntime()` 作真正判定。
> 更新提示按三态分派：unsupported 告警、degraded 提示、**unverified 只记日志
> 不发通知**（否则每次发版都弹窗，会训练用户忽略告警）。
>
> 测试：`test/runtime-capability.test.js` 14 项 + `test/runtime-compat-notify.test.js` 7 项。
>
> **仍未解决**：`agentTeam` 的实际字段形状（Issue #23）；在线能力探测（需 3 分钟，
> 不适合放进每次更新检查，当前用声明式矩阵）。

**位置**：`package.json:6`、`src/runtime-manager.js:39`

**证据**：
```json
// package.json:6
"runtimeVersion": "0.1.5-rc.2",
```
```js
// runtime-manager.js:39
const SUPPORTED_RUNTIME_RANGE = '<0.2.0-0';
```
注释（`runtime-manager.js:30-38`）说明该常量已于 2026-09-22 降级为"已测试矩阵"，矩阵外仍可安装（容器姿态），但会记 `knownIssue` 并提示降级。

**影响**：
- 官方桌面 runtime 已 **0.2.1-rc.5**（`docs/product/product-vision.md` F1，证据 `/Applications/DeepSeek Harness.app/.../dsh/package.json`）
- 目标新定位 `Harness-first`：**Agent Teams / goal / jobs / workspace-changes 全部在 0.2.x**
- 即：**新方向所需的能力一个都不在当前锁定的 0.1.5 里**，而兼容矩阵明确把 0.2.x 标为"未测"

**建议**：这不是普通技术债，是**主线阻塞项**。需要在 Mission Core 动工前完成 0.2.x 升级评估（`docs/adr/ADR-0004` 已在起草，属 Lead 范围）。本审计仅从壳层角度确认：`runtime-manager` 的安装/切换/回滚/矩阵机制**足以承载升级**，风险集中在 API 面（见 `runtime-bridge.md`）。

**优先级**：P0 · **阻塞新方向 = 是**

---

### TD-30 · `before-quit` 同步备份无超时

**位置**：`src/main.js:6348-6365`

**证据**：
```js
app.on('before-quit', () => {
  quitting = true;
  if (settings.get().backupOnQuit) {
    try {
      backupDeltaNow({ dshHome: dshHomeOf(), backupDir: backupDir(), keep: ..., log });   // 同步！
    } catch (err) { log(`[shell] quit backup failed: ${err.message}`); }
  }
  manager.cancelAllInstalls();
  killRuntime();
});
```
`backupDeltaNow` 是**全同步**：`scanSource`（`backup.js:29-59`，metadata-only walk）+ 逐文件 `copyFileSync`（:146-158）。虽然从"全量 cpSync"改成了增量（`backup.js:8-17` 记录了 Windows 上"app 退不掉"的历史），但**仍然是同步的、无超时的**。

**影响**：session 树很大且首次（无 index）时会走全量 `backupNow`（`backup.js:140-142`）+ `cp` 每个文件。用户点退出 → UI 无响应若干秒 → 用户以为卡死 → 强杀 → 可能留半写状态。

**建议**：`before-quit` 里 `event.preventDefault()` + 异步备份 + 完成后 `app.quit()`，加 5s 超时直接放弃备份。

**优先级**：P2 · **阻塞新方向 = 否**

---

### TD-31 · `settings.html` 5895 行单文件

**位置**：`src/settings.html`

**证据**：
- `wc -l` → 5895
- 17 个页面（`grep -c 'class="page"'` → 17，`grep -c 'data-page="'` → 17）
- 内联 `<script>` 从 `:1486` 到文件末尾 = **4409 行 JS 内联在 HTML 里**
- 无外部 `<script src>` 拆分

**影响**：
- 与 `main.js` 同病：无法单测、无法 lint、diff 噪音大
- 17 个页面的逻辑共享一个作用域，全局变量污染风险
- 这是**壳层唯一的功能配置面**（模型/MCP/插件/技能/通道/远程/备份/更新/通知/周报/办公室），新定位下要被 Capability Platform 部分替代/重组 → **改造成本会很高**

**建议**：抽 `src/settings/*.js`（每页一个模块）+ `settings-preload` 之外的分层。不必急，但要意识到这是 Mission/Capability 的必经之路。

**优先级**：P2 · **阻塞新方向 = 否**

---

### TD-32 · IM 通道的全开放模式与私有协议实现

**位置**：`src/channels/allowlist.js`、`src/channels/pbbp2.js`

**证据**：
```js
// allowlist.js:18-21
if (e === '*') return true;          // catch-all：全开放
if (e === id) return true;
if (e.endsWith('*')) return id.startsWith(e.slice(0, -1));   // 前缀通配
```
- `allowFrom: ['*']` 是**一等选项**，界面上可配置（`shell:channels-allowfrom`，`main.js:2690`）
- 默认是**关闭**（`allowlist.js:12`：`allowFrom.length === 0` → 拒绝所有人），这一点做得好
- `src/channels/pbbp2.js`（152 行）是自己实现的**二进制帧编解码**（`encodeFrame/decodeFrame/headerMap`），用于钉钉/飞书某类 WebSocket 协议

**影响**：
- 用户配了 `*` 后，**任何能给这个 bot 发消息的人都能驱动 `runPrompt`**（`main.js:6053-6060` → `runHeadless` + 用户工作区 cwd）。这是"用别人的 IM 账号跑任意 prompt"的攻击面。有 `allowFrom` 机制但 `*` 让它形同虚设。
- `pbbp2.js` 是零依赖自研二进制协议解析，**无 fuzz 测试**（`test/channels-c6.test.js` 只做往返 encode/decode 断言）。
- 好消息：审批/提问回调走**一次性 token**（`one-shot-tokens.js`：crypto 随机 16 字节、单次消费、120s TTL、`burn-on-redeem`），这部分设计是扎实的。

**建议**：`*` 选项加二次确认 + 显著警告；`pbbp2` 加 fuzz 或至少 malformed 输入测试。

**优先级**：P2 · **阻塞新方向 = 否**

---

## 债务主题归纳

把 32 条按根因归类，可以看到只有 **3 个根因**：

```mermaid
graph TB
  R1["根因 1：<br/>没有统一的存储层<br/>（13 个 JSON 各自为政）"]
  R2["根因 2：<br/>没有统一的 IPC 层<br/>（133 通道散在 4 文件，无注册表无分级）"]
  R3["根因 3：<br/>没有 CI 门禁<br/>（测试只在不报警的定时任务跑）"]

  R1 --> TD02 & TD03 & TD04 & TD05 & TD11 & TD12 & TD14 & TD30
  R2 --> TD01 & TD06 & TD07 & TD19 & TD20 & TD21
  R3 --> TD10 & TD22 & TD23 & TD24 & TD28

  TD15 & TD16 & TD17 --> R1
  TD08 & TD09 & TD32 --> R2
  TD18 --> R1
  TD25 & TD26 & TD27 & TD29 & TD13 & TD31 --> 其他（历史/范围/依赖）
```

**对新方向的判断**：

| 根因 | Mission Core 能否绕开 | 结论 |
|---|---|---|
| 存储层 | ❌ 不能。Mission 的唯一事实源必须落在存储上 | **必须先抽 `src/storage/`，否则 Mission 会继承全部 5 条 P0 存储债** |
| IPC 层 | ⚠️ 部分能。Mission 的 IPC 可以新开命名空间（如 `mission:*`），但会加剧 TD-01/TD-06 | **建议与新 IPC 层一起做，不要先加后改** |
| CI 门禁 | ❌ 不能。大重构无门禁 = 裸奔 | **TD-10 是前置条件，成本很低（一天）** |

---

## 建议的处置顺序（供 Lead 参考）

**第 0 批（1-2 天，立即，成本极低收益极高）**
1. TD-10：加 `push` → `npm test` 的 CI（已知红用显式 skip 列表）
2. TD-20：加 preload↔main 通道一致性静态测试
3. TD-16：删掉 `templateId` 死字段（或做实），消除假接口
4. TD-14：`.dsh/` 写进 `.git/info/exclude`

**第 1 批（与 Mission Core 同批，1-2 周）**
5. 抽 `src/storage/`：atomic-write + secret-vault + 一个带 schemaVersion/migrate/backup 的通用 JSON store（解 TD-02/03/05/11/12）
6. 抽 `src/ipc/`：按域拆分 + `SHELL_CHANNELS` 常量 + 危险度分级 + 集合测试（解 TD-01/06/07/19）
7. TD-04：先决定 Mission 存储形态（JSONL vs 单文档），再写 Mission Core

**第 2 批（随迭代）**
8. TD-08/09/17/18/22/23/24/30
9. TD-13/21/26/27/28/31

**独立主线（Lead 决策）**
10. TD-29：`runtimeVersion` 0.1.5 → 0.2.x 升级（**这是新方向的最大外部依赖**）
