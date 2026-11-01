# AGENTS.md — DshCockpit 地图与开发规则

> 本文件是**目录**，不是手册。深入内容在 `docs/`；`docs/README.md` 是唯一索引。
> 任何 agent/开发者先读这里，再按图索骥。保持本文件 ≤ 130 行（超了就是该拆了）。

## 1. 我们是什么

**DshCockpit = The Workspace for AI Teams**（2026-11-01 重定位）。
一个以虚拟办公室为核心交互方式的 AI 工作空间：组织、管理、观察并参与 AI Agent 团队的工作。

```
Harness owns execution.  DshCockpit owns experience, continuity, capability orchestration.
```

**不做什么**（硬边界，见 `docs/adr/ADR-0001-repositioning-ai-team-workspace.md`）：
不自研 Agent Loop / 通用 Harness；不做第二个 Harness 桌面壳；不做多 Runtime；不做通用聊天客户端。

**当前阶段**：P0 地基校准（审计 + 战略 + POC）。路线图见 `docs/product/product-roadmap.md`。

## 2. 架构铁律（任何改动不得违反）

1. **事实作者唯一**：Harness 拥有执行事实（Session/Turn/Tool/Agent/Team/Goal/文件变更）；
   DshCockpit 拥有 Mission / Shared Context / Capability / Office 派生呈现。
   **同一状态不许两个写入者。** 完整矩阵见 `docs/product/product-vision.md` §3.2。
2. **先查官方，再决定自研**：官方 0.2.x 有 308 个 `@deepseek-ai` 包。任何"自研 X"前必须查官方是否已有，
   并在 Issue/ADR 附检索证据。参考 `docs/research/capability-providers.md`。
3. **不伪造**：没有验证证据就没有"完成"；执行层不生成 prompt；UI 不编造状态；报告不把红写成绿。
4. **隐私**：raw sessionId / prompt 正文 / 工具参数原文 / 产物内容 / 绝对路径**不进** Office 快照与事实链。
5. **办公室不是输入面**：控制走明确通道（`shell:*` / `office:*` 冻结集合）；办公室只读派生。
6. **不为抽象而抽象**：只有一个实现时不造接口；出现第二个实现且有替换需求时才抽象。

## 3. 目录地图

```
src/main.js                   壳组合根（IPC、runtime 监督）——6297 行，过载中（TD-01/#22）
src/runtime-capability.js     能力矩阵：判定 runtime 是否可用（S1，替代版本号门禁）
src/ipc-*.js                  已提取的 IPC 域（mcp / remote / misc-domains / features）
src/window-manager.js         窗口/视图/快照广播
src/runtime-mux.js            /api/remote.mux 多路复用客户端（$events / session/follow）
src/harness-rpc.js            Harness RPC 表面
src/team/runtime/             Team 内核（纯 Node、门禁保护）。⚠ 按 ADR-0002 将退为适配层
src/office/runtime/           办公室纯内核（状态机/调度/布局/词表）
src/office/render/            PixiJS 渲染器（flat 代码化 2.5D / iso 预览）
src/office/office-module.js   办公室组合根——4726 行，上限 4800（余量 74 行）
src/work/                     单次工作项 MVP（⚠ 非 Mission Core 雏形，见 TD-15）
src/mission/                  【待建】Mission Core（P1）
src/workbench/                工作台（内容/引擎分离；⚠ 已从 asar 排除，见 TD-26）
test/                         离线测试（node:test，cwd 必须是仓库根；150 套件 / 2120 项）
docs/                         文档，唯一索引 docs/README.md
archive/ + docs/archive/      本地保险箱（git 忽略）
```

## 4. 开发流程（强制）

1. **计划先行**：非平凡改动先在 `docs/plans/active/` 写计划并等用户拍板。小修可直接改但须同步文档。
2. **先查后写**：任何"新增能力"前，先查官方包清单 + `docs/quality/tech-debt-inventory.md`。
3. **变异纪律**：每组新测试配负向变异（破坏→红→还原→绿）。无法检出的如实记 `masked`，不得谎称 DETECTED。
4. **真机分层**：headless 离线测试 ≠ 真机验收。真机脚本写进报告，由用户执行回填。
5. **文档同步**：新增/移动/删除任何文档必须同步 `docs/README.md`（`test/docs-index.test.js` 机械校验）。
6. **规则强制化优先**：能变成测试的架构规则就写成测试，不要只写在文档里（见 `docs/quality/quality-gates.md`）。

## 5. 命令与坑

```bash
npm test                                   # 全量（约 2 分钟，2120 项）
node --test test/docs-index.test.js        # 文档索引（毫秒级，改文档后必跑）
node --check <file>                        # 语法检查
```

- **cwd 坑**：Bash 默认 cwd 可能是仓库父目录。一律用绝对路径或 `zsh -c 'cd <repo> && ...'`。
- **基线**：`CI=1 npm test` → **2120 passed / 0 failed / 1 skipped**（唯一有效基线）。
  唯一 skip 是 E5a-R1 真机探针（需图形会话）——**Skip 不计作 Pass**，
  由 `scripts/ci-gate.js` 四态报告保证，见 `docs/quality/test-tiers-and-baseline.md`。
- **pure Node 门禁**：`src/team/runtime/**` 与 `src/office/runtime/**` 禁止 Electron/DOM/fs/网络；
  `office-module` 的 require 集合冻结。
- **CI 已建立门禁**（#10）：`.github/workflows/ci.yml` 在 PR/push 上跑全量测试 +
  三个机械门禁（`npm run check:compat-ledger` / `npm run check:licenses` / docs-index）。
  `release-*` 的 build 依赖新增的 `gate` job。

## 6. Git 安全（硬规则）

- 严禁：`git reset --hard`、`git clean -fd`、`git checkout -- .`、`git add -A`。
- 清理/重构必须逐段进行：每删一段 → `node --check` + 相关测试 + 关键符号存在性断言。
- 只回退**自己**刚改的单文件：`git restore --source=HEAD -- <file>`（允许的救援手段）。
- 提交信息写"为什么 + 证据（测试数/变异结果）"；**推送只在用户明确授权后进行**。

## 7. 当前状态与下一步

- **2026-11-01 完成**：战略重定位（ADR-0001）、四路审计、领域模型、6 份 ADR、第三方评估。
- **本轮计划**：`docs/plans/active/P0-AUDIT-AND-P1-MISSION-KICKOFF-2026-11-01.md`
- **P0 完成（2026-11-01）**：#21 账本 / #10 CI 门禁 / #14 许可证 / #9 POC / #19 Settings / #22 IPC 安全网。
  8 项完成条件中 **7 项达成**；唯一未达成：`agentTeam` 字段形状需真实模型调用验证（ADR-0002 R0）。
- **S1 完成（2026-11-01）**：runtime 兼容层改为**能力探测**（TD-29 已解决）。
  `src/runtime-capability.js` 用能力声明 + 已知矩阵 + 四态判定替代版本比较：
  `0.2.1-rc.5` / `0.2.2-alpha.2` 判 **supported**（POC 实测 16/16），`0.1.5-rc.2` 判 degraded
  （无 agent-team），未测过的版本判 **unverified 但放行**（"没测过 ≠ 不能用"）。
- **下一步（P1）**：Mission Core（Issue #12）。前置：`agentTeam` 字段形状验证（Issue #23）。
- **ADR-0001..0006 全部已接受**（2026-11-01）。ADR-0002 附退役硬约束 R0–R5（禁止直接删旧 Team Runtime）。
- **已消除的债**：TD-02/03/05（#19 Settings 保护）、TD-10（#10 CI 门禁）、
  TD-17（#17 符号引用）、TD-22 部分（#22）、**TD-29（S1 能力探测）**。
- **仍存在的债**（详见 `docs/quality/tech-debt-inventory.md`）：
  TD-01 main.js 过载（#22：契约快照已建，Phase 1 已提取 3 批共 18 个 handler）· TD-04 索引覆盖写 ·
  TD-06/07 IPC 无冻结 · TD-15 src/work 语义冲突。

## 8. 文档入口（按目的）

| 我想… | 读 |
|---|---|
| 了解产品定位与边界 | `docs/product/product-vision.md` |
| 知道什么允许/禁止 | `docs/product/product-principles.md` |
| 知道下一步做什么 | `docs/product/product-roadmap.md` |
| 理解领域模型 | `docs/architecture/domain-model.md` |
| 理解运行时桥接 | `docs/architecture/runtime-bridge.md` |
| 理解办公室 | `docs/architecture/office-runtime.md` |
| 知道为什么这样决策 | `docs/adr/` |
| 知道什么算通过 | `docs/quality/quality-gates.md` |
| 知道有哪些债 | `docs/quality/tech-debt-inventory.md` |
| 看 runtime 兼容证据 | `docs/research/runtime-poc-report-2026-11-01.md` |
| 当前 P0 执行状态 | `docs/plans/active/P0-ENGINEERING-EXECUTION-2026-11-01.md` |
