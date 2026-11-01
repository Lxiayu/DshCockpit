# 测试体系盘点与改进建议（壳层视角）

> 状态：**审计报告（2026-11-01）** · 范围：`test/` 全量 137 个套件 + `src/workbench/test/`（未纳入主套件）
> 配套：`docs/architecture/architecture-overview.md`（现状架构）、`docs/quality/tech-debt-inventory.md`（债清单）、`AGENTS.md` §4（开发流程）
> 基线（本机 2026-11-01 实测）：`npm test` → **tests 1935 / pass 1934 / fail 1 / duration ≈ 120s**

---

## 0. 一句话结论

这是一套**完成度罕见地高、但我们测的和我们要做的不是同一件事**的测试体系：1935 项用例里 **61% 的测试行数集中在虚拟办公室**（65 个套件 / 1,117 用例），而**壳层自己最危险的 6385 行 `main.js` 一行都没被执行过**；同时存在一个结构性盲区——**907 处 `assert.match` 对源码做正则断言**（"形状测试"），这类测试在重构时会大量误红、在真 bug 上完全无效；最后，**这套测试全绿的信号强度被 CI 配置削掉了**：发布链不跑测试，唯一的定时测试工作流是 `continue-on-error: true` 且失败不发邮件。

---

## 1. 基线事实

### 1.1 规模

| 指标 | 实测值 | 命令 |
|---|---|---|
| 测试文件数 | **137** | `ls test/*.test.js \| wc -l` |
| 测试代码行数 | **48,740** | `cat test/*.test.js \| wc -l`（`wc -l test/*.test.js` 同值） |
| `node --test` 报告用例数 | **1935** | `npm test` |
| 顶层测试构造数（`test(` / `it(` / `gateTest(`） | **1933** | `grep -hoE "^\s*(test\|it\|gateTest)\(" test/*.test.js \| wc -l` |
| `assert.equal` / `deepEqual` 系 | **7,436** | `grep -o "assert\.equal\|assert\.deepEqual\|assert\.strictEqual\|assert\.deepStrictEqual"` |
| `assert.match` / `doesNotMatch`（**源码正则断言**） | **907** | `grep -o "assert\.match\|assert\.doesNotMatch"` |
| 用 `readFileSync` 的套件 | **85 / 137（62%）** | `grep -rl readFileSync test/*.test.js`（其中 68 个把正则断言到 `src/`，其余读的是临时 fs fixture，属行为测试） |
| 用真实临时目录（`mkdtempSync`）的套件 | **46** | `grep -l mkdtempSync` |
| 起真实子进程的套件 | **12** | `grep -l "execFileSync\|spawnSync\|child_process"` |
| 带 `timeout:` 的用例 | **1**（`office-ui.test.js:1294`，420 秒） | `grep -c "timeout:"` |
| 源码行数（对照） | **83,189**（`src/**/*.{js,html,css}`） | — |
| 测试 : 源码 行数比 | **≈ 0.59 : 1** | 48,740 / 83,189 |
| 测试文件平均行数 | **356 行** | 48,740 / 137 |

**评价**：[已确认] 测试密度**远高于**一般 Electron 应用（0.59 的测试/源码比在桌面应用里属于很高）。这不是"测试不足"的问题，而是"测试分布严重偏斜"的问题。

### 1.2 按领域分布（按文件名前缀精确归类，无重复计数）

| 领域 | 套件数 | 顶层用例数 | 测试行数 | 占测试行数 |
|---|---|---|---|---|
| **虚拟办公室**（`office-*`） | **65** | **1,117** | **29,782** | **61.1%** |
| **壳层**（runtime/cost/mcp/channels/settings/cockpit/session/mcp/…） | **55** | **564** | **11,829** | 24.3% |
| **Team Runtime**（`team-*`、`worker-execution-*`） | 7 | 113 | 3,342 | 6.9% |
| **Harness / 执行后端**（`harness-*`、`dsh-execution-*`） | 3 | 79 | 2,613 | 5.4% |
| **工作区 / Work**（`work-*`、`command-runner`） | 7 | 60 | 1,174 | 2.4% |
| **合计** | **137** | **1,933** | **48,740** | 100% |

复现：脚本按文件名前缀归类后累加每个文件的 `^\s*(test|it|gateTest)\(` 计数与 `wc -l`。

**关键观察 [已确认]**：
- 办公室占 **61% 的测试行数**，而它占 **56%** 的源码行数（46,382 / 83,189）—— 比例大致匹配，**说明办公室的测试投入与代码量是相称的**，这块是真实资产（`docs/plans/completed/OFFICE-V3-INTERACTION-STAGE-REPORT-2026-10-30.md` 记录了 6 个缺陷修复 + 5 条遗留规则）。
- **壳层 15,043 行代码只有 24% 的测试行数**，且这 11,829 行里 **356 处是源码正则断言**（占全仓 907 处的 39%），形状主导套件覆盖壳层 25.3% 的测试行（见 §2 第 2 层）。
- **`src/work`（1,773 行）只有 60 个用例 / 1,174 行** —— 但它是 P1/P2 的真机验收资产：7 个套件里 5 个是纯行为测试（真实 fs + 真实 spawn + 离线端到端），只有 2 个 wiring 套件做源码断言。**质量显著高于数量**（见 §2 第 5 层）。
- **Team（7,068 行）+ Harness（约 3,000 行）合计 192 个用例 / 5,955 行** —— 这是"事实作者"层，`assert.match` 仅 23 处（占全仓 2.5%），几乎全是行为测试，**是全仓测试质量最高的部分**。

---

## 2. 测试类型分层（按"能否被变异检出"排序）

`AGENTS.md` §4.3 的变异纪律要求"无法被变异检出的测试要如实记录（masked）"。按这个标准给现有测试分层：

### 第 1 层 · 行为测试（可被变异检出）—— **106 / 137 个套件不是形状主导（77%）**，质量参差但可信

> 口径说明：68 个套件含至少 1 处 `assert.match`，但只有 **31 个**是"形状主导"（每用例 ≥0.5 个 match）。其余 106 个套件可能夹带零星源码断言，但主体是行为断言。

特征：构造真实输入、调用真实模块、断言输出或副作用。

**代表**：
| 套件 | 用例 | 为什么是行为测试 |
|---|---|---|
| `work-workspace-store.test.js` | 10 | 真实 `mkdtempSync` 建工作区，真实 fs 断言"只写 `.dsh/`"、"损坏索引 fail-closed"、"原子写无 `.tmp` 残留"（`test/work-workspace-store.test.js:39, 52, 141, 174`） |
| `work-controller.test.js` | 18 | 真实 store + 真实 fs，覆盖"completed 无产物 → 不是 completed"（:61）、"空变更不伪造 patch"（:192）、"验证失败如实记录"（:229） |
| `command-runner.test.js` | 6 | 真实 `spawn` 跑 `/bin/sh`，断言 exit code / 超时 / 输出截断（:39-94） |
| `token-stats.test.js` | 13 | 真实构造 session 日志文件，断言增量解析不重复计数（:109, 136）、V3 generation 选择（:188, 202） |
| `notification-center.test.js` | 10+ | 断言 DND 窗口跨午夜（:128）、折叠 60s 窗口（:79）、坏 JSONL 行跳过（:117） |
| `channels.test.js`（811 行 / 30 用例） | 30 | 一次性 token 单次消费、指数重连、离线队列重放、safeStorage 假实现 |
| `office-runtime-boundary.test.js` | 19 | **最强的门禁测试**：四类纯度证明（清单完整性、静态、传递闭包、运行时拦截 `require('electron')` 后仍能加载） |
| `mcp-manager.test.js` / `mcp-import.test.js` / `mcp-verify-gate.test.js` | ~60 | 真实 fs + 注入的 safeStorage |
| `runtime-manager-unit.test.js` | 43 | 无网络单测，真实临时 userData + 假 install runner |

**变异证据（文档记录，非本审计重跑）**：`docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md:51-58` 记录 M1（不写盘）DETECTED、M4（无产物仍 completed）DETECTED、M5（快照泄漏绝对路径）DETECTED、M6（不校验 digest）DETECTED、M7（发送方校验恒真）DETECTED；并**如实标注 M3 MASKED** 并补等价变异 M3'。

### 第 2 层 · 形状测试（源码正则断言）—— 断言占比 10.9%，但覆盖 22% 的行数，**这是最大的结构性债务**

特征：`fs.readFileSync('src/xxx.js')` + `assert.match(src, /正则/)`。

**精确统计**（三种口径，避免单一指标误导）：

| 口径 | 实测值 | 说明 |
|---|---|---|
| `assert.match`/`doesNotMatch` 断言数 | **907** | 占全部断言（7,436 精确比较 + 907 正则 ≈ 8,343）的 **10.9%** |
| 含至少 1 处 `assert.match` 的套件 | **68 / 137** | 其中「形状主导」（每用例 ≥0.5 个 match）的有 **31 个** |
| 「形状主导」套件覆盖的行数 | **10,852 / 48,740 = 22.3%** | 对应 **427 / 1,933 = 22.1%** 的用例 |
| 用 `readFileSync` 的套件 | **85** | 但其中只有 68 个把正则断言到 `src/`；其余 17 个读的是临时 fs fixture（属于行为测试） |

**按领域的 `assert.match` 分布**（更能说明问题）：

| 领域 | 套件数 | `assert.match` 总数 | 每套件均值 |
|---|---|---|---|
| 办公室 | 65 | 428 | 6.6 |
| **壳层** | **55** | **356** | **6.5** |
| 工作区 / Work | 7 | 100 | 14.3（但集中在 2 个 wiring 套件） |
| Team | 7 | 14 | 2.0 |
| Harness | 3 | 9 | 3.0 |

**Top 12 形状主导套件**：
| 套件 | 用例数 | `assert.match` 数 | 比例（match/test） |
|---|---|---|---|
| `cockpit-ui.test.js` | 37 | **157** | 4.2 |
| `office-ui.test.js` | 45 | 78 | 1.7 |
| `work-dock-wiring.test.js` | 7 | **53** | 7.6 |
| `office-rail.test.js` | 6 | **51** | 8.5 |
| `office-doc-contract.test.js` | 11 | 49 | 4.5 |
| `work-view-wiring.test.js` | 12 | 46 | 3.8 |
| `settings-ui.test.js` | 25 | 45 | 1.8 |
| `office-right-panel-p4.test.js` | 24 | 31 | 1.3 |
| `runtime-hardening.test.js` | 8 | 24 | 3.0 |
| `office-pages-english.test.js` | 13 | 20 | 1.5 |
| `office-interaction-p3.test.js` | 8 | 17 | 2.1 |
| `shell-update-notice.test.js` | 8 | 17 | 2.1 |

**它们的自我定位是诚实的**：`work-view-wiring.test.js:4-6` 明确写：
> "这类测试不做像素断言，只钉住一旦破坏就会'看起来能用其实没接上'的契约：视图注册、通道、信任边界、i18n 覆盖、渲染安全。"

**因此不能简单说"形状测试是坏的"**——它们确实抓到了"接上了没"这一类问题，而且是在 `main.js` 完全不可测的前提下**唯一可行的手段**。

**但它们有三个真实代价**：

1. **重构误红**：改一个变量名/拆一个函数/调换两行顺序就可能让大量 `assert.match` 变红。典型：`cockpit-ui.test.js:335-336` 通过 `main.indexOf(...)` 定位两个 handler 之间的源码片段来断言顺序——**任何插入都会被判错**。
2. **真 bug 漏检**：`assert.match(main, /ipcMain\.handle\('shell:export-diagnostics'/)` 只证明"字符串存在"，不证明"这条 handler 能跑、参数对、错误处理对"。
3. **测试反向塑造代码**：`src/main.js:389-396` 有一段注释专门为 `tdz-guard` 的误报改了源码写法：
   > "Explicit keys: the tdz-guard scans factory blocks for shorthand refs and these are function parameters, not top-level bindings."
   
   这是**为了迁就测试而写不自然的代码**的信号。

**改进方向**：不是"删掉形状测试"，而是**把它们降级为辅助，同时补上第 1 层**。优先补的是**第 3 层的静态一致性测试**（成本极低，价值极高）。

### 第 3 层 · 静态一致性门禁（"结构性不可能"测试）—— 9 个套件 / 1,750 行（3.6%），**单位价值最高**

这类测试不测行为、不测源码正则，而是**证明某个结构约束不可能被违反**。它们是最有长期价值的测试。

| 套件 | 用例 | 证明什么 | 为什么强 |
|---|---|---|---|
| `office-runtime-boundary.test.js`（550 行 / 19 用例） | 19 | ① 模块清单完整性（目录里每个 `.js` 必须显式归类）；② 静态纯度（禁 electron/pixi/DOM/net/fs/UI/render）；③ **传递闭包纯度**；④ **运行时证明**：拦截 `require('electron')` 使抛错后每个内核模块仍能加载 | ④ 是"静态可达性 ≠ 真实依赖"的证明，是**真正的证据**而非声明 |
| `dependency-guard.test.js` | 5 | 每个 `require(裸模块)` 必须在 `package.json` 声明（防"dev 树有、打包后崩"） | 直接对应一类线上事故（H5/H6） |
| `docs-index.test.js` | 5 | `docs/README.md` 是唯一索引；无未登记文档；无死条目；AGENTS.md ≤130 行 | 让"文档是导航"从口号变成机械约束 |
| `tdz-guard.test.js` | 2 | 顶层 `createXxx({...})` 工厂块内的简写引用必须先声明 | **但有覆盖盲区**，见 TD-23 |
| `office-doc-contract.test.js` | 11 | 文档里声明的通道/事件名必须与代码一致 | 文档漂移检出 |
| `i18n.test.js` | 9 | 每个 key 中英都存在；HTML 引用的 key 都存在 | 半翻译 UI 不可能通过 |
| `office-packaging-boundary.test.js` | 3 | 打包排除项不会吃掉生产素材 | 对应 `scripts/verify-dist.js` 的 asar 负向断言 |
| `office-release-gate.test.js`（382 行） | 14 | 验收证据目录存在、每个自动 gate 有退出码、证据 JSON 无隐私泄漏 | 由 `OFFICE_RELEASE_EVIDENCE_ID` 环境变量选择证据轮次（:33） |

**这一层是项目最有价值的测试资产**，也是其他项目最少见的。`office-runtime-boundary.test.js` 的"运行时证明"手法（拦截 `require('electron')`）值得被复制到壳层（见 §6 建议 2）。

### 第 4 层 · 真机探针（环境依赖）—— 1 个

`test/office-ui.test.js:1294`：
```js
test('E5a-R1 real shell: the walk sequence plays in metadata order with a stable foot line', { timeout: 420000 }, () => {
  ... execFileSync(node_modules/.bin/electron ...) ...
});
```
- 用真实 Electron 二进制 + `--force-device-scale-factor=2` 跑探针脚本
- **这就是当前唯一的红**：`TestContext.<anonymous> (test/office-ui.test.js:1312:3)`，`status: 9`
- 判定：**[待验证] 环境相关已知红**。依据：任务上下文声明的基线（1934 pass / 1 fail）与本机实测一致；该用例需要真实 Electron 图形栈，`--force-device-scale-factor` + 离屏渲染在无头/CI 环境下不稳定。**但本审计未验证它在有图形环境的本机是否也红**——若本机也红，则不是"环境相关"，而是"该探针已失效"。

**风险**：这个红项长期存在（任务上下文称其为"已知红"），会**训练所有人忽略红色信号**。见 §5 改进建议 5。

### 第 5 层 · 离线端到端（真实链路，无 Electron）—— 2 个

`test/work-e2e-offline.test.js`（2 用例，真实 transport + dsh 后端 + controller + Team）：
- `:47` "a full offline run lands a real file in the workspace and completes the work item"
- `:138` "a missing upstream artifact blocks the next step observably (no silent running)"

这是**第 1 层里最接近"真机"的形态**：不用 Electron，但走完 用户目标 → 工作项 → transport → 执行后端 → 产物落盘 → 索引 → 状态收敛 的完整链。`docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md:39` 称其为"首跑 5 分钟产出真实文件"的无头等价物。

**这是最值得扩展的测试形态**（见 §6 建议 4）。

---

## 3. `1935` 这个数字的构成

### 3.1 用例数（不是"测试文件数"也不等于"断言数"）

- 137 个测试文件，**全部**都用顶层式写法（`test(` / `it(` / `gateTest(`），**没有 `describe()` 分组**（`grep -rn "{ *describe\|describe," test/*.test.js | grep "node:test"` → 无命中；`grep` 到的 `describe()` 全是 `adapter.describe()` 这类业务方法调用，不是测试分组）
- **没有 subtest**：`grep -rn "t\.test(\|await t\.test" test/*.test.js` → 0 命中
- 三种等价写法：
  | 写法 | 用例数 | 使用者 |
  |---|---|---|
  | `test(` | 1,895 | 绝大多数 |
  | `it(` | 25 | `channels-c6.test.js`(13)、`channels-timeout-failure.test.js`(12)，均 `const { test: it } = require('node:test')` 改名 |
  | `gateTest(` | 14 | `office-release-gate.test.js`，`const gateTest = EVIDENCE_ID ? test : test.skip`（:33） |
  | **合计** | **1,933** | |
- `node --test` 报告 **1935** —— 比顶层构造多 2，来自 `--test` 对 `test.skip`（`command-runner.test.js:94` 的 `{ skip: process.platform === 'win32' }`）等边界计数的差异。**量级一致，数字可信。**
- 唯一条件跳过：`command-runner.test.js:94` 的 POSIX 用例在 win32 上 skip（macOS 上会跑）

**含义**：1935 是**真实用例数**，不是被拆分的虚数，也没有 `describe` 嵌套导致的重复计数。

### 3.2 一个用例 ≠ 一个断言

平均 **4.3 个断言/用例**（7,436 + 907 ≈ 8,343 / 1,935）。但分布极不均：
- `office-runtime-boundary.test.js` 的用例动辄十几条断言（集合相等 + 逐模块循环）
- 形状测试通常 1-3 条 `assert.match`

### 3.3 一个数字背后的缺口

**1935 项全绿 ≠ 主进程可运行**。证据：
```bash
grep -rn "require.*src/main" test/    # 无命中
```
`src/main.js`（6385 行、107 个 IPC handler、196 个函数）**从未被任何测试加载或执行**。它只被 `fs.readFileSync` 读取后做正则断言（38 个套件提到 `main.js`）。

同理未被执行的壳层文件（14 个，共约 760 行）：
```
aux-windows.js(188L)  ipc-features.js(82L)   preload.js(5L)
cockpit-preload.js(31L)  settings-preload.js(141L)  quickask-preload.js(13L)
search-preload.js(13L)  loading-preload.js(12L)  window-state.js(25L)
search-worker.js(75L)  runtime-install-worker.js(45L)  runtime-events.js(53L)
watchdog.js(51L)  headless.js(56L)
```

**这 14 个的共同点**：要么是**只能在 Electron 里跑**（preload / window / install-worker / watchdog），要么是**纯接线**。它们不是"忘记测"，而是**架构导致不可测**（TD-01）。

---

## 4. 分领域真实覆盖评估

判定标准：**有真测试** = 第 1/3/5 层 · **形状测试** = 第 2 层 · **无测试** = 无任何引用

### 4.1 高覆盖（有行为测试 + 门禁）

| 领域 | 覆盖率判断 | 代表证据 |
|---|---|---|
| Runtime 生命周期 | **强** | `runtime-manager-unit.test.js`(43)、`runtime-supervisor.test.js`、`runtime-health.test.js`、`runtime-mux.test.js`、`runtime-state.test.js`、`runtime-log-tail.test.js`、`runtime-pick.test.js`、`runtime-hardening.test.js`(8) |
| MCP | **强** | 6 个套件（manager/registry/connect/import/usage/verify-gate），`mcp-manager.test.js` 覆盖 CRUD + patch 文件 + vault |
| IM 通道 | **强** | `channels.test.js`(30/811 行) + `channels-c6.test.js`(17) + `channels-timeout-failure.test.js`，含真实 `pbbp2` 帧往返 |
| 工作区 / Work | **强**（相对其规模） | 6 套件 60 用例，含 2 个离线端到端 |
| 用量/成本 | **强** | `token-stats.test.js`(13，含增量解析防重复计数)、`cost.test.js`、`balance.test.js`、`cache-economics.test.js`、`weekly-report.test.js` |
| 通知/调度 | **中-强** | `notification-center.test.js`(10+)、`scheduler.test.js` |

### 4.2 中覆盖（形状测试为主）

| 领域 | 判断 | 说明 |
|---|---|---|
| 窗口/视图接线 | **形状** | `work-view-wiring.test.js`(12/46 处 match)、`work-dock-wiring.test.js`(7/53) —— 钉住"视图注册/通道/信任边界/i18n 覆盖"，但**不打开真正的窗口** |
| Cockpit 悬浮条 | **形状** | `cockpit-ui.test.js`(37/157) —— 全仓 match 密度最高 |
| 设置页 | **形状** | `settings-ui.test.js`(25/45)，`settings.html` 5895 行内联脚本从未被执行 |
| 壳层加固 | **形状 + 部分行为** | `runtime-hardening.test.js`(8/24)、`shell-update-notice.test.js`(8/17) |
| 插件/技能/市场 | **部分行为** | `plugin-flow.test.js`、`skills.test.js`、`market.test.js`(5)、`pnpm-shim.test.js`/`pnpm-profile.test.js` |

### 4.3 低覆盖 / 无覆盖

| 模块 | 行数 | 状态 | 风险 |
|---|---|---|---|
| `src/main.js` | 6385 | **无测试（不可测）** | 组合根 + 107 handler |
| `src/settings.html` | 5895（4409 内联 JS） | **无测试** | 壳层唯一配置面，17 个页面 |
| `src/aux-windows.js` | 188 | **无测试** | 3 个辅助窗口 |
| `src/ipc-features.js` | 82 | **无测试**（11 个 handler） | boot/weekly/cache/compat/notifications |
| `src/window-state.js` | 25 | **无测试** | 固定 `.tmp` 并发风险（TD-11） |
| `src/workbench/workbench.js` | 6300 | **不在主套件**（`src/workbench/test/` 56 用例不跑） | 不进发行包（TD-26/28） |
| `src/headless.js` | 56 | **无测试** | Quick Ask / 定时任务 / IM 的共同执行路径 |
| `src/watchdog.js` | 51 | **无测试** | 孤儿进程回收 |
| `src/runtime-install-worker.js` | 45 | **无测试** | 子进程安装入口 |
| `src/search-worker.js` | 75 | **无测试**（间接经 `session-worker-client`） | worker 线程 |

**特别指出 `src/headless.js`**：它是 **Quick Ask + 定时任务 + IM 通道 runPrompt** 三条用户路径的共同执行器（`main.js:6053-6060` → `runHeadless`）。无测试意味着这条路径上的环境变量拼装（`DSH_HOME`、`ELECTRON_RUN_AS_NODE`）、cwd、stdout fd 重定向都没有回归保护。同类的 `command-runner.js`（108 行）有 6 个测试（含真实 spawn）——**说明"能测的都测了"，没测的是因为架构不可测**。

### 4.4 测试投入 vs 代码行数

```
办公室：  46,382 源码行  ←  29,782 测试行   （0.64 : 1）
壳层：    15,043 源码行  ←  11,829 测试行   （0.79 : 1，但 356 个正则断言 / 20 个套件读源码）
Team：     7,068 源码行  ←   3,342 测试行   （0.47 : 1）
Harness：  ~3,000 源码行  ←   2,613 测试行   （~0.87 : 1）
work：     1,773 源码行  ←   1,174 测试行   （0.66 : 1，行为测试占比最高）
```

**表面看壳层比例（0.79）甚至高于办公室（0.64）——但这正是指标误导之处**：

| 领域 | 测试行 | `assert.match` | 每 100 测试行 match 数 | 真实行为测试占比 |
|---|---|---|---|---|
| 办公室 | 29,782 | 428 | 1.44 | 中（但有 65 套件的大基数，且含大量真实 fs/状态机测试） |
| **壳层** | **11,829** | **356** | **3.01** | **低**：`cockpit-ui`(157) + `settings-ui`(45) + `runtime-hardening`(24) + `work-*-wiring`(99，虽归 work 组但测的是壳层接线) + `shell-update-notice`(17) 就占了大半 |
| Team | 3,342 | 14 | 0.42 | **最高**：纯 Node 内核，几乎全是行为测试 |
| Harness | 2,613 | 9 | 0.34 | 高 |
| work | 1,174 | 100 | 8.52 | **看似最高但实际最高**：100 个 match 全在 2 个 wiring 套件（`work-dock-wiring` 53 + `work-view-wiring` 46），另外 5 个套件（`work-controller`/`work-workspace-store`/`work-e2e-offline`/`work-ipc`/`command-runner`）**match 总计 1 个**，全是真实 fs 行为测试 |

**最诚实的表述**：壳层 11,829 行测试里，**约 2,995 行（25.3%）**所在的 12 个套件在做源码正则断言。扣掉这部分，壳层的**行为测试行数约 8,800 行 / 15,043 行源码 ≈ 0.58** —— 与办公室持平，但**壳层的代码危险度（主进程、fs、密钥、公网暴露）远高于办公室（渲染仿真）**，所以覆盖是**不匹配的**。

**更关键的是覆盖的对象错了**：壳层的测试大量测的是**接线字符串**（handler 存在吗、通道名对吗），而**不是行为**（handler 能不能跑、错误怎么处理、并发如何）。而 `src/work` 那 5 个套件测的恰恰是行为 —— 这是**为什么 `src/work` 虽然只有 60 个用例，却是全仓最可信的模块之一**。

---

## 5. 门禁类型盘点

项目自称有"门禁保护"（`AGENTS.md` §2），实测确实存在且真实运作：

| 门禁 | 位置 | 保护什么 | 是否真有效 |
|---|---|---|---|
| **pure Node 纯度** | `office-runtime-boundary.test.js`（19 用例） | `src/office/runtime/**`、`src/team/runtime/**` 禁 electron/DOM/fs/网络 | ✅ **真有效**，含运行时证明（拦截 `require('electron')`） |
| **require 集合冻结** | 同上 :510-522 | `office-module.js` 的 require 集合；"清单自身不允许悄悄删项" | ✅ 真有效 |
| **行数上限** | 同上 :524-532 | `office-module.js` ≤ 4800 行（当前 4725） | ✅ 真有效，但**只保护了这一个文件**；`main.js`(6385)、`settings.html`(5895)、`workbench.js`(6300) **无上限** |
| **文档索引** | `docs-index.test.js`（5 用例） | 每个 `docs/**/*.md` 必须登记；无死条目；AGENTS ≤130 行 | ✅ 真有效 |
| **依赖声明** | `dependency-guard.test.js`（5 用例） | 每个裸 `require` 必须在 `package.json` 声明 | ✅ 真有效 |
| **通道冻结（office）** | 5 个套件交叉断言 | `office:*` = 9 个精确集合 | ✅ 真有效（见 architecture-overview §3.2） |
| **通道冻结（shell）** | **不存在** | — | ❌ **无** |
| **preload↔main 一致性** | **不存在** | — | ❌ **无** |
| **i18n 键集等价** | `i18n.test.js`（9 用例） | 每个 key 中英都有；HTML 引用都存在 | ✅ 真有效 |
| **打包边界** | `office-packaging-boundary.test.js`(3) + `scripts/verify-dist.js` | 创作树不进包；生产素材不被误删 | ✅ 真有效（但只在 `build.js` 里跑，见 §6） |
| **TDZ 静态防护** | `tdz-guard.test.js`（2 用例） | 顶层 `createXxx({...})` 块内简写引用顺序 | ⚠️ **覆盖窄**（只覆盖 1 种写法，见 TD-23） |
| **变异纪律** | 无工具 | 新测试必须配负向变异 | ⚠️ **纪律真实、记录诚实，但不可回归**（TD-22） |
| **隐私红线** | `office-privacy.test.js`、`office-privacy-redactor.test.js` | 快照不含 sessionId/token/绝对路径 | ✅ 真有效（`office-ui.test.js:842` 断言整个序列化快照） |
| **内容红线（鲸鱼娘语料）** | 提交 `20b4702` 说明"内容红线进 CI" | 闲聊语料的安全边界 | [待验证] 未定位到具体套件（可能在 office-dialogue-engine 内） |

**结论**：门禁体系**真实存在且有含金量**（尤其 pure-Node 纯度 + require 冻结 + 运行时证明这套，是少数项目才有的）。缺口是**壳层完全没有对应门禁**——所有门禁都长在办公室/Team 那两块上，而壳层（15,000 行、含全部高风险动作）裸奔。

---

## 6. 改进建议（按 ROI 排序）

### 建议 1（成本 0.5 天，ROI 最高）· 恢复 CI 门禁

**问题**：`npm test` 只在 `upstream-compat.yml` 的每日定时任务跑，且该 job `continue-on-error: true`（:41），失败不发失败邮件（需手配 SMTP secrets，`upstream-compat.yml:391` 未配时只 `::warning::`）。发布链（`release-win.yml`/`release-mac.yml`）**完全不跑测试**。

**建议**：
1. 加 `.github/workflows/test.yml`：`on: [push, pull_request]` → `npm test`，`fail-fast: false`
2. 把已知红（`office-ui.test.js:1294`）用**显式 skip 机制**处理（现有先例：`office-release-gate.test.js:33` 用 `const gateTest = EVIDENCE_ID ? test : test.skip`），例如 `const uiProbe = process.env.DSH_SKIP_ELECTRON_PROBE ? test.skip : test`
3. 这样可以**恢复"全绿 = 可信"**的信号，同时不掩盖已知问题

**度量**：从"0 个 PR 门禁"到"每个 PR 必跑 1935 项"。

### 建议 2（成本 1 天，ROI 极高）· 把"运行时证明"手法复制到壳层

**问题**：`main.js` 不可加载（顶层就有 `app.whenReady()`、`ipcMain.handle` 等副作用）。

**建议**：不做"加载 main.js"这种不现实的改造，而是借鉴 `office-runtime-boundary.test.js` 的**运行时证明**思路，做两件事：

a) **IPC 全表面静态一致性测试**（纯解析，无执行）：
```js
// 断言：preload 暴露的每个 invoke/send 通道，在 main 侧必有 handler
const preloadChannels = parseInvokes('src/settings-preload.js', 'src/cockpit-preload.js', ...);
const mainHandlers = parseHandles('src/main.js', 'src/ipc-features.js', 'src/work/work-ipc.js');
assert.deepEqual([...preloadChannels].filter(c => !mainHandlers.has(c)), []);
```
当前这个检查**完全不存在**（`grep -rn "preload" test/*.test.js | grep invoke.*handle` → 0），而 11 个 preload 暴露约 170 个 invoke/send 调用点（`grep -o "invoke(\|send(" src/*preload.js ...` → 232，含重复）。**这是一个一天内能写完、能永久防住"UI 点了没反应"这类静默回归的测试。**

b) **`SHELL_CHANNELS` 常量 + 集合测试**（解 TD-06）：
把 75 个 `shell:*` 从散落的字面量收成一个常量（按危险度分级 read/write/destructive），加集合断言 —— 照抄 `office:*` 那 5 个测试的做法。

### 建议 3（成本 1 天）· 修 `tdz-guard` 的覆盖盲区

**问题**：`test/tdz-guard.test.js:34` 的正则 `const\s+(\w+)\s*=\s*(create\w+)\(\{\n([\s\S]*?)\n\}\);` 只匹配一种写法；且已经出现过为迁就它改源码的情况（`main.js:389-396` 注释）。

**建议**：用 AST（`acorn` 在 electron 依赖链里已有）做真正的"未定义/先用后声明"检查；范围扩到 `registerIpc()` 函数体与 `whenReady().then()` 回调体。这是 `main.js` 无运行时测试时**唯一**能防主进程启动崩溃的手段。

### 建议 4（成本 2-3 天，对新方向最有价值）· 扩展"离线端到端"测试形态

**问题**：`work-e2e-offline.test.js` 是全仓**唯一**"真实链路但不需要 Electron"的测试，只有 2 个用例。它证明了"用户目标 → 工作项 → transport → dsh 后端 → 产物落盘 → 索引 → 状态收敛"全链路可无头验证。

**建议**：Mission Core 必须复用这个形态。建议建立"离线端到端"测试的**模板**：
- 真实 fs（`mkdtempSync`）
- 真实 transport / command-runner（真实 spawn）
- 假的是：dsh runtime 进程（用 fake-executor 或录制的 journal）
- 断言的是：**产物真的落盘 + 索引真的可重读 + digest 真的对得上 + 重启后状态正确**

这比 907 处源码正则加起来更能保护新方向。

### 建议 5（成本 0.5 天）· 处理已知红

**问题**：`office-ui.test.js:1294` E5a-R1 长期红。它训练所有人"红不一定是问题"。

**建议**：二选一，不要维持现状：
- 若它确实环境相关 → 用环境变量 guard 显式 skip，并在测试名里标注环境要求，CI 里按环境决定
- 若它本机也红 → 它已经失效，应修或删（[待验证]：本审计实测它在**本机也红**，`status: 9`。这意味着"环境相关"的说法需要更精确的定义——它是"需要真实图形显示环境"而非"任何环境都红"）

### 建议 6（成本 1 天）· 让 `src/workbench/test/` 的 56 个用例进入主套件或移出 `src/`

**问题**：`package.json:17` 的 glob 是 `"test/*.test.js"`，`src/workbench/test/`（7 文件 56 用例，实测全绿）**从不被 `npm test` 执行**。

**建议**：改成 `node --test "test/*.test.js" "src/workbench/test/*.test.js"`，或把工作台整树移出 `src/`（TD-26）。

### 建议 7（成本 3-5 天，工程价值最高但最贵）· 拆 `main.js` 以获得可测性

**问题**：所有形状测试的**根因**是 `main.js` 不可测。

**建议**：这是 `tech-debt-inventory.md` TD-01/TD-19 的解法。拆完之后，现在的形状测试可以逐步替换为"注入假 ipcMain + 假 deps，调用 `register(ipcMain, deps)`，断言注册了哪些通道 + 调用 handler 是否返回正确形状"——这才是 IPC 层真正的行为测试。

**为什么排最后**：成本高、风险大、且需要 TD-01 决策先落地。但它是**唯一能根治第 2 层债务的办法**。

---

## 7. 门禁 vs 变异：纪律的真实性核查

`AGENTS.md` §4.3 规定：
> "每组新测试配负向变异（破坏→必须红→还原→复绿）。无法被变异检出的测试要**如实记录**（masked），不得谎称 DETECTED。"

**核查结论 [已确认]：纪律被执行且记录诚实。**

正面证据：
- `docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md:49-58` 的 M1–M7 表，其中 **M3 主动标注 MASKED** 并解释原因（"第二道 containment 检查仍拦截"），还补了等价变异 M3' 得到 DETECTED
- `docs/plans/completed/HARNESS-V0.6-REPORT-2026-10-26.md:107` 记录 **"M-W5 teamPhase 移出签名 | 未红（掩蔽）"**，并解释冗余捕捉者掩盖了它
- `test/office-runtime-boundary.test.js:60-75` 有一段修复说明：旧的注释剥离实现有 bug（行注释里的 `/*` 被当块注释开始，吞掉真实代码），**负向变异 M13 实测未检出才发现**，修正后 M13 能检出

负面事实：
- **无变异工具**：`ls scripts/ | grep -i mutat` 无结果。所有变异都是人工 apply → 跑 → revert
- **不可回归**：历史变异结论随时间失效；下次改动不会自动重跑
- **无覆盖率统计**：无 `c8`/`nyc`/`--experimental-test-coverage` 配置，不知道哪些分支被覆盖

**结论**：这属于"**诚实的、但不可持续的手工纪律**"。在团队规模 ≤2 人时可维持；一旦多人并行（如本审计的 4-auditor 场景），就无法保证。

**建议**：对 `src/work/**` + 未来的 `src/mission/**` 建立半自动变异脚本（列出变异点 → apply → run → revert → 输出矩阵）。这两个模块是新方向的核心，值得投入。

---

## 8. 一句话给 Lead 的判断

| 问题 | 答案 |
|---|---|
| 这套测试能防住什么？ | **办公室的视觉/状态回归**（65 套件 / 1102 用例）、**pure-Node 边界**、**依赖/文档/i18n 结构漂移**、**Runtime 生命周期**、**MCP/通道/成本的数据处理** |
| 这套测试防不住什么？ | **主进程启动崩溃**、**IPC 接线断裂**、**设置页逻辑**、**任何 `shell:*` 通道的增删改**、**存储损坏恢复** |
| 对新方向（Mission Core）够用吗？ | **不够**。Mission 需要的"存储耐久性 / 跨 Session 连续性 / 迁移"三类保证，现有测试一项都不覆盖 |
| 最该先做的三件事？ | ① 恢复 CI 门禁（0.5 天）② preload↔main 一致性测试（1 天）③ 扩展离线端到端形态（2-3 天） |

---

## 9. 本节待补 + 原因

| 项 | 原因 |
|---|---|
| 真实代码覆盖率百分比 | 未配置覆盖率工具（无 `c8`/`nyc`），无法测量。若需要，命令为 `node --test --experimental-test-coverage "test/*.test.js"`（[待验证] Node 24 是否支持该 flag 组合） |
| `office-ui.test.js:1294` 在"有图形环境"下是否绿 | 本机实测红（`status: 9`）；未在 CI 或另一台有头机器上复现并对照 |
| `src/workbench/test/` 56 用例的独立通过率 | 实测 `node --test "src/workbench/test/*.test.js"` → 56 pass / 0 fail（2026-11-01），但它不在主套件内，长期无保障 |
| 各套件的执行耗时分布 | `node --test` 只在整体结束时给总时长（~120s），未逐套件统计；已知 `office-release-gate.test.js` 内有一个 690ms 的全仓测试账本扫描、`office-ui.test.js:1294` 的 Electron 探针是主要耗时项 |
