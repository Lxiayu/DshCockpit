# 测试分级与基线规范

> 状态：**现行（2026-11-01 审查修订）** · 修正第一阶段"1934/1935，1 个环境相关红"的模糊表述
> 上游：`docs/quality/quality-gates.md`、`docs/quality/testing-strategy.md`
> 目的：**不允许把持续失败算作通过**，也不允许把"可在 CI 跑绿"说成"环境相关失败"

## 0. 核心修正（本轮最重要的实测结论）

### 0.1 一个被错误表述的事实

第一阶段报告反复使用："**1935 项 / 1934 pass / 1 红（环境相关）**"。

**实测复核（2026-11-01）**：

```bash
$ node --test test/office-ui.test.js          # 无 CI 变量
ℹ tests 45 | pass 44 | fail 1

$ CI=1 node --test test/office-ui.test.js     # 带 CI 变量
ℹ tests 45 | pass 45 | fail 0

$ CI=1 npm test                               # 全量
ℹ tests 1935 | pass 1935 | fail 0
```

**结论**：该探针**在 `CI=1` 下是"通过"的**（因为测试代码里有 `if (process.env.CI) return;` 提前返回）——但这正是问题：
它根本没执行，却被计为 pass。
它不是"环境相关的持续失败"，而是"**本地无图形会话时无法运行、CI 下已显式跳过**"。

**正确表述应该是**：
- ✅ "1935 项；本地无图形会话时 1934 pass / 1 无法运行；`CI=1` 下 1935 全绿"
- ❌ "1934/1935，1 个环境相关红"（暗示持续失败，误导决策）

### 0.2 为什么这个区别重要

用户明确要求：**「不能将持续存在的失败直接算作通过」**。
反过来同样成立：**不能把"已通过"说成"持续失败"** —— 那会训练所有人忽略红色信号（"反正一直有一个红"）。

## 1. 测试三级分类（强制）

**每一项测试必须归入且只归入一类。** 分类写入测试文件顶部注释或测试名。

| 级别 | 定义 | 运行环境 | 失败含义 | 是否阻塞合并 |
|---|---|---|---|---|
| **C — Core** | 纯逻辑/契约，无外部进程、无图形、无网络、无真实文件系统依赖 | 任何环境 | **真实缺陷** | ✅ **必须阻塞** |
| **I — Integration** | 启动真实子进程 / 读写真实临时文件 / 本地 HTTP fixture | 任何环境（含 CI） | 真实缺陷或环境缺陷 | ✅ **必须阻塞** |
| **E — Environment-specialized** | 需要真实图形会话 / 真实 Electron 窗口 / 真实硬件 | **仅在满足条件的环境** | 环境缺陷，非产品缺陷 | ⚠️ 必须在 CI 显式 skip 并记录 |

### 1.1 判定细则

| 特征 | 分类 |
|---|---|
| 只 require `node:*` + 项目内纯模块 | **C** |
| 有 `require('electron')` 但被 mock/probe | **I** |
| `spawn`/`execFileSync` 真实进程 | **I** |
| `WebSocketServer` / `http.createServer` 本地 fixture | **I** |
| 需要真实 GPU / 图形会话 / 显示器 | **E** |
| 需要真实公网 | **E**（当前无此类测试，禁止新增） |

### 1.2 E 类测试的强制要求

```js
// 必须显式声明环境依赖 + 显式跳过（不得静默失败）
test('...', { timeout: 420000 }, () => {
  if (process.env.CI) return;                    // ① CI 必须跳过
  if (!process.env.DSH_GRAPHICS) return;         // ② 本地无图形也必须跳过
  // ...
});
```

**规则**：
1. E 类测试**必须**有显式 skip 分支（且跳过原因写注释）。
2. E 类测试**不得**计入"通过率"分母（见 §2）。
3. E 类测试**必须有**等价的 C/I 级替代断言覆盖同一契约（否则该契约等于无测试）。
4. E 类测试的失败**不得**被记为"已知红"长期挂账。

**本仓库现状**：`test/office-ui.test.js:1294` 的 E5a-R1 探针已满足 ①②，且其契约由资产级用例（"every walk frame shares the pack sole line"）覆盖 —— **属于合规的 E 类**。

### 1.3 已修复：静默 return 被改成显式 skip（Issue #10，2026-11-01）

上面 §0 指出的问题已经修好：

| 之前 | 现在 |
|---|---|
| `if (process.env.CI) return;` | `t.skip('needs a real graphics session')` |
| 报告显示 `pass=1959 / skipped=0` | 报告显示 `pass=1973 / skipped=1` |
| 一个没执行的像素级契约伪装成通过 | 如实列为 skipped，供人工判断是否合理 |

配套：`scripts/ci-gate.js` 解析 TAP，强制 **Skipped 不计入 Passed**，
并把被跳过的测试名打印出来（见 `test/ci-gate.test.js` 的 REGRESSION 用例守护）。

> 教训：`t.skip()` 与裸 `return` 在 node:test 里的语义完全不同。
> 前者产生 TAP `# SKIP` directive，后者什么都不产生——测试"通过"且"没跑"。

## 2. 基线定义（替代"1934/1935"）

### 2.1 正式基线

| 环境 | 命令 | 期望 | 含义 |
|---|---|---|---|
| **CI / 无图形** | `CI=1 npm test` | **1935 / 1935 / 0 fail** | **这是唯一有效基线** |
| 本地有图形 | `npm test` | 1934 pass + 1 skipped（或 pass） | 非基准，仅参考 |
| 本地无图形 | `npm test` | 1934 pass + 1 fail | **不是基线**，是环境缺失 |

> **规则：对外报告一律用 `CI=1 npm test` 的结果。**

### 2.2 禁止的表述

| ❌ 禁止 | ✅ 正确 |
|---|---|
| "1934/1935，1 个已知红" | "`CI=1` 下 1935/1935 全绿" |
| "约 1935 项，基本都过" | "1935 项全过（CI 环境）" |
| "有个环境相关红，不影响" | "1 项 E 类测试需图形会话，CI 显式跳过" |

### 2.3 若未来真的出现核心红

**处理规则**：
1. 立即修复或回退该变更。
2. 若确定是环境问题 → 转 E 类（加显式 skip + 记录原因）。
3. **禁止**：
   - ❌ 加 `continue-on-error`
   - ❌ 放宽断言
   - ❌ 标"已知红"然后长期挂着
   - ❌ 删除测试而不说明

## 3. 测试套件分类表（现状 137 个套件）

### 3.1 按领域分布

| 领域 | 套件数 | 主要分类 | 备注 |
|---|---|---|---|
| office（办公室） | 65 | C 为主，少数 I/E | 门禁最密集的领域（boundary/doc-contract/release-gate） |
| runtime（运行时） | 9 | C/I | mux/protocol/auth |
| work（工作项） | 6 | I | 文件系统依赖 |
| team（Team） | 6 | C | 纯 Node 内核 |
| mcp（MCP） | 6 | I | 进程/网络 fixture |
| session（会话） | 3 | C/I | — |
| cockpit / channels / settings / pnpm / harness | 2–3 各 | C/I | — |
| 其他（weekly/token/tdz/skills/shell/scheduler/remote/quickask…） | 各 1 | C/I | — |

### 3.2 必须标记为 E 类的（当前清单）

| 测试 | 文件 | 原因 | 已合规？ |
|---|---|---|---|
| E5a-R1 real shell walk sequence | `test/office-ui.test.js:1294` | 需真实 Electron 图形会话 + 像素测量 | ✅ 有 `CI` skip |
| E5a-R1 相关真壳探针 | 同文件其他 `real shell:` 用例 | 同上 | 需逐个核查 |

**待办**：把 `test/office-ui.test.js` 内所有 `real shell:` 用例逐一登记进本表并验证 skip 覆盖。

### 3.3 未纳入 `npm test` 的测试（TD-28）

`src/workbench/test/*.test.js`（56 个用例，实测全绿）**不在** `npm test` 的 glob 内。

**处置**：要么纳入主 glob，要么明确说明为何独立（当前无说明 = 债）。见 `tech-debt-inventory.md` TD-28。

## 4. CI 分级门禁（与 Issue #10 对接）

```yaml
# 目标形态（待实施）
test-core:        # 阻塞合并
  run: CI=1 npm test
test-workbench:   # 阻塞合并（若纳入）
  run: node --test "src/workbench/test/*.test.js"
# E 类不入 CI（CI 下 skip）
```

**规则**：
- C + I 必须阻塞。
- E 不阻塞（CI 下 skip），但必须有 C/I 级替代覆盖。

## 5. 报告模板（对外统一）

```
测试基线（CI 环境）：
  CI=1 npm test → 1935 tests / 1935 pass / 0 fail
  C 类：全部通过
  I 类：全部通过
  E 类：1 项（E5a-R1），CI 下显式跳过；契约由资产级用例覆盖

本地有图形环境复核：
  npm test → 1934 pass / 1 fail（E5a-R1 需真实图形会话，属预期）
```

## 6. 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `docs/quality/testing-strategy.md` | 详细盘点（本文以其为基础，修正结论表述） |
| `docs/quality/quality-gates.md` | 门禁层（本文补充测试分级） |
| `docs/quality/compatibility-ledger-spec.md` | 同样使用"分级不可推导"的思路 |
| `AGENTS.md` | §5 的基线表述需同步修正 |

## 7. 待办

- [ ] 修正 `AGENTS.md` §5 的基线表述
- [ ] 修正 `testing-strategy.md` 中对已知红的定性
- [ ] 登记 `office-ui.test.js` 全部 `real shell:` 用例
- [ ] 决定 `src/workbench/test/*` 是否纳入 `npm test`
- [ ] CI 门禁实施后，把 `CI=1 npm test` 作为唯一基线
