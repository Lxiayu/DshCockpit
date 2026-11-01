# 质量门禁与 CI 策略

> 状态：**现行（2026-11-01）** · 本文件定义"什么算通过"。
> 上游：`docs/product/product-principles.md` §4（强制化清单）
> 配套：`docs/quality/testing-strategy.md`（测试体系盘点）、`docs/quality/tech-debt-inventory.md`（已知债务）

## 0. 核心问题（必须先承认）

**当前 CI 不在发布链上跑测试。**

| 工作流 | 触发 | 跑 `npm test`？ | 门禁效力 |
|---|---|---|---|
| `release-win.yml` | tag push / 手动 | ❌ 否（注释明确写"发布流水线不再用单元测试门禁"） | 无 |
| `release-mac.yml` | tag push / 手动 | ❌ 否 | 无 |
| `upstream-compat.yml` | 每日 03:00 | ✅ 是，但 **`continue-on-error: true`** | 弱（失败不报警） |
| `mirror-downloads.yml` | 定时 6h | ❌ 否 | 无 |

**结论**：1935 项测试的保护价值被削弱为"事后发现"。破坏性提交可以一路合进 `develop` 并打 tag，**没有任何 CI 红灯拦截**。

> ✅ **已修复（2026-11-01，Issue #10）**：新增 `.github/workflows/ci.yml`，在
> `pull_request` 与 `push`（develop/master）上运行。测试在 ubuntu 上跑全量（约 2 分钟），
> 四态由 `scripts/ci-gate.js` 诚实报告；`release-win/mac` 的 build 现在依赖新增的 `gate` job。
>
> **同时修正了一个更隐蔽的问题**：`test/office-ui.test.js` 的 E5a-R1 真机探针曾用
> `if (process.env.CI) return;` 提前返回 —— 于是 `CI=1 npm test` 报告
> `pass=1959 / skipped=0`，而这个像素级契约一次都没执行。现已改为 `t.skip()`，
> 报告如实显示 `skipped=1`。**Skip 不再被计作 Pass。**

> 证据：`docs/quality/tech-debt-inventory.md` TD-10（含工作流行号）。

**这是一条 P0 级债，必须在 P1 之前修复。**

## 1. 门禁分层

### L0：本地提交前（开发者/Agent 自查）

| 检查 | 命令 | 耗时 | 必须 |
|---|---|---|---|
| 文档索引一致 | `node --test test/docs-index.test.js` | < 1s | ✅ |
| 语法检查 | `node --check <changed files>` | < 1s | ✅ |
| 相关单测 | `node --test <related tests>` | 秒级 | ✅ |
| 全量测试 | `npm test` | ~2 min | 每次批次收尾 |

### L1：PR / push（**待建立，当前缺失**）

| 检查 | 说明 | 目标耗时 |
|---|---|---|
| 全量单测 | `npm test`，失败即红 | < 3 min |
| 文档索引 | 包含在 `npm test` 内 | — |
| 依赖许可证白名单 | **待建**（见 §3） | < 30s |
| 官方能力重复检测 | **待建**（见 §4） | < 30s |
| 未使用模块扫描 | **待建**（见 §4） | < 1 min |

**实施要求**：新增 `.github/workflows/test.yml`，触发 `pull_request` + `push` 到 `develop`/`master`，**不带 `continue-on-error`**。

### L2：发布前（tag）

| 检查 | 当前 | 目标 |
|---|---|---|
| 全量单测 | ❌ 未跑 | ✅ 必须 |
| 构建成功 | ✅ | ✅ |
| `verify-dist` | ✅ | ✅ |
| `e2e-smoke` | ✅ | ✅ |
| 真机验收脚本 | 人工 | 人工（记录结果） |

**规则**：**L1 未绿不得打 tag。**

### L3：每日/定期

| 检查 | 当前 | 说明 |
|---|---|---|
| upstream compat | ✅（但 continue-on-error） | 应改为"失败报警但不阻塞"，而非"静默失败" |
| 与官方包清单对照 | ❌ 待建 | 检测"我们是否在重复实现官方能力" |
| 技术债趋势 | ❌ 待建 | 债务条数/行数趋势 |

## 2. 现有门禁清单（已强制，不得破坏）

这些是**已经生效**的机械约束，任何改动不得让它们失效：

| # | 规则 | 机制 | 位置 |
|---|---|---|---|
| G1 | `docs/` 每个文件必须被索引 | 测试 | `test/docs-index.test.js` |
| G2 | `AGENTS.md` ≤ 130 行 | 测试 | 同上 |
| G3 | 索引无死链 | 测试 | 同上 |
| G4 | 根目录只允许 6 个 md | 测试 | 同上 |
| G5 | `src/team/runtime/**` 零 Electron/DOM/fs/网络 | 测试 | 纯 Node 门禁 |
| G6 | `src/office/runtime/**` 零 DOM/Pixi | 测试 | 同上 |
| G7 | office-module require 集合冻结 | 测试 | 集合相等 |
| G8 | 执行层不得调 Team 命令（单转换点） | 测试 | `test/exec-contract` M14 |
| G9 | 渲染层不得成为事实源 | 测试 | 静态 import 断言 |
| G10 | Office 快照隐私白名单 | 测试 | `privacy-redactor` |
| G11 | `office:*` 通道集合冻结 | 测试 | 契约测试 |
| G12 | 无产物不得显示"完成" | 代码强制 | `work-controller.js` |
| G13 | 文档契约（SPEC-00 等） | 测试 | `test/office-doc-contract.test.js` |
| G14 | 素材命名规范 | 测试 | `test/office-asset-pack.test.js` |

**纪律**：新增架构规则时，先问"能变成测试吗"。能则写测试（G 系列），并在本节登记。

## 3. 待建立的门禁（按优先级）

### G15：依赖许可证白名单（P0）

**问题**：MIT 项目不能打包 AGPL 依赖。当前无任何检查。

**方案**：
```js
// scripts/check-licenses.js（待建）
// 遍历 package.json + node_modules，提取 license 字段
// 白名单：MIT, Apache-2.0, BSD-*, ISC, 0BSD, Unlicense
// 拒绝：AGPL-*, GPL-*, SSPL, NOASSERTION（需人工确认）, 自定义商业许可
// 排除 devDependencies
```

**为什么必须先建**：ADR-0005 / ADR-0006 的决策依赖"许可证是硬门槛"。没有机械检查，这个门槛就是纸的。

### G16：官方能力重复检测（P1）

**问题**：我们反复有"重新实现官方已有能力"的风险（自研 session-search / Team Runtime / 插件市场）。

**方案**：
```js
// scripts/check-upstream-overlap.js（待建）
// 1. 从 asar 提取官方包清单（或从配置的版本清单）
// 2. 对比我们的 src/ 模块清单
// 3. 输出"疑似重复"报告（人工判断，不自动失败）
```

**注意**：这是**报告**门禁，不是**阻塞**门禁（有些重复是合理的）。

### G17：preload ↔ main 通道一致性（P1）

**问题**：preload 暴露的 `invoke('x')` 可能没有对应 handler（TD-20）。

**方案**：静态分析 `*-preload.js` 的 `invoke` 调用 + `main.js` 的 `ipcMain.handle`，做集合比对。

### G18：IPC 通道冻结（P1）

**问题**：`shell:*` 75 个通道无冻结机制（TD-06）；`office:*` 有冻结（G11），但 `shell:*` 没有。

**方案**：为 `shell:*` 建立与 `office:*` 同级的契约清单 + 集合测试。

### G19：原子写一致性（P1）

**问题**：原子写代码在 15 个文件里各写一遍，3 处固定 `.tmp` 会并发互踩（TD-11）。

**方案**：抽出一个 `src/lib/atomic-write.js`，用 lint/测试确保所有写路径都经过它。

### G20：Mission 边界（P1，随 Mission Core 建立）

**规则**（见 `docs/architecture/mission-core.md` §1.3）：
- `src/mission/**` 不得 require Harness 内部模块
- 不得有 LLM 调用
- 不得有 roster/task/agent 状态机
- 不得自己实现 goal phase 枚举

### G21：Capability Pack 验证（P3，随 Capability Platform 建立）

- 每个 Pack 的 `verify.js` 必须在 CI 可跑（`ciRunnable: true`）
- 安装 → verify → 卸载 幂等测试

## 4. 变异测试纪律（现有做法）

**现状**：项目已有"变异测试"纪律（`AGENTS.md` §4.3），但**无工具支撑**（TD-22）。

**纪律内容**：
1. 每组新测试配负向变异：破坏代码 → 测试必须红 → 还原 → 必须绿。
2. 无法被变异检出的测试要**如实记录为 `masked`**，不得谎称 `DETECTED`。
3. 变异结果写进 commit message 或完成报告。

**待改进**：
- 建一个 `scripts/mutate.js`，支持声明式变异（把"改哪行、改成什么"写成配置）。
- 至少对**核心模块**（mission store / office reducer / 执行转换层）做自动化变异。

## 5. 真机验收（不可被离线测试替代）

| 内容 | 为什么不能离线 | 记录方式 |
|---|---|---|
| 角色是否正确显示 | 需要真实 Pixi 渲染 | 截图 + 人工确认 |
| 事件流转是否正确 | 需要真实 Harness | 运行日志 |
| 断线重连 | 需要真实网络 | 手动断网验证 |
| 动画是否不合理切换 | 需要人眼 | 录屏 |
| 原有功能回归 | 需要真实交互 | 清单逐项确认 |

**规则**：真机脚本写进完成报告，由用户执行并回填结果。**不得把"未执行"说成"通过"**。

## 6. 提交与回退规则

### 6.1 提交

- 一个 commit = 一个自洽、可独立回退的变更。
- 提交信息写"**为什么 + 证据**"（测试数/变异结果），不只写"改了什么"。
- 推送只在用户明确授权后进行。

### 6.2 禁止的 git 操作（硬规则）

```
git reset --hard
git clean -fd
git checkout -- .
git add -A
```

**理由**：仓库有用户未提交的修改与本地保险箱（`archive/`、`docs/archive/`）；破坏性操作会丢失不可恢复的数据。

### 6.3 允许的救援

- `git restore --source=HEAD -- <单个文件>`（只回退自己刚改的文件）。
- 逐段回退：每删一段 → `node --check` + 相关测试 + 关键符号存在性断言。

## 7. 门禁失败的处理原则

| 情形 | 处理 |
|---|---|
| 测试红 | **立即回退该变更**，不放宽断言 |
| 测试本身错了 | 修测试，但必须在 commit 说明"原断言为何错" |
| 门禁与真实需求冲突 | 先改门禁（并说明理由），再改代码；不得绕过 |
| 无法强制化的规则 | 写进文档 + 在 tech-debt-tracker 记"为何无法强制化" |
| 环境相关红（如真机探针） | 单独标记为 `environment-dependent`，不计入回归；但必须有人复核 |

## 8. 与路线图的关系

| 阶段 | 必须达成的门禁 |
|---|---|
| P0 | G1–G4（已达成）；**G15 许可证检查（新）**；CI 测试门禁（L1） |
| P1 | G17 preload 一致性、G18 IPC 冻结、G20 Mission 边界、原子写统一（G19） |
| P2 | 办公室交互端到端测试 |
| P3 | G21 Pack 验证 |

## 9. 待回答的问题

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 是否引入 ESLint + TypeScript checkJs？ | TD-24；利弊需评估 |
| Q2 | 全量测试 2 分钟，CI 是否可接受？ | 若不可，需分段/并行 |
| Q3 | 真机 Electron 探针不稳定（基线唯一红），是修复还是移除？ | 影响 CI 全绿可行性 |
| Q4 | 是否需要覆盖率门禁？ | 当前无覆盖率统计 |

## 10. 相关文档

- 原则：`docs/product/product-principles.md` §4
- 测试体系：`docs/quality/testing-strategy.md`
- 技术债：`docs/quality/tech-debt-inventory.md`
- 开发流程：`AGENTS.md` §4
