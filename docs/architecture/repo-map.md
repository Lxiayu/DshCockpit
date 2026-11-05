# 仓库地图与项目铁律（DshCockpit）

> **本文件是地图，不是手册。** 深入内容在 `docs/`；`docs/README.md` 是唯一索引。
> **它原是根 `AGENTS.md` 的正文**，2026-11-05 起因根 `AGENTS.md` 改为「工程代理行为协议」而迁到这里。
> 开工顺序：根 `AGENTS.md`（怎么做事）→ 本文件（这是什么仓库、红线在哪）→ `docs/README.md`（按需深入）。
> 保持本文件 ≤ 130 行（`test/docs-index.test.js` 机械守着；超了就是该拆了）。

## 1. 我们是什么

**DshCockpit = The Workspace for AI Teams**（2026-11-01 重定位）。
一个以虚拟办公室为核心交互方式的 AI 工作空间：组织、管理、观察并参与 AI Agent 团队的工作。

```
Harness owns execution.  DshCockpit owns experience, continuity, capability orchestration.
```

**不做什么**（硬边界，见 `docs/adr/ADR-0001-repositioning-ai-team-workspace.md`）：
不自研 Agent Loop / 通用 Harness；不做第二个 Harness 桌面壳；不做多 Runtime；不做通用聊天客户端。

**当前阶段**：P0–P3 已完成，P4 未排期；价值层重构（SDK 桥接 + Mission Memory + 检查器）已批准待实施，
见 `docs/plans/active/VALUE-LAYER-REFACTOR-2026-11-05.md`。

## 2. 架构铁律（任何改动不得违反）

1. **事实作者唯一**：Harness 拥有执行事实（Session/Turn/Tool/Agent/Team/Goal/文件变更）；
   DshCockpit 拥有 Mission / Shared Context / Capability / Office 派生呈现。
   **同一状态不许两个写入者。** 完整矩阵见 `docs/product/product-vision.md` §3.2。
2. **先查官方，再决定自研**：官方 0.2.x 有 308 个 `@deepseek-ai` 包。任何"自研 X"前必须查官方是否已有，
   并在 Issue/ADR 附检索证据。参考 `docs/research/capability-providers.md`。
3. **不伪造**：没有验证证据就没有"完成"；执行层不生成 prompt；UI 不编造状态；报告不把红写成绿。
4. **隐私**：raw sessionId / prompt 正文 / 工具参数原文 / 产物内容 / 绝对路径**不进** Office 快照与事实链。
   落地位置：`src/mission/schema.js` 的 `PRIVACY_FORBIDDEN_FIELDS` + `FORBIDDEN_PERSISTED_FIELDS`。
5. **办公室不是输入面**：控制走明确通道（`shell:*` / `office:*` 冻结集合）；办公室只读派生。
6. **不为抽象而抽象**：只有一个实现时不造接口；出现第二个实现且有替换需求时才抽象。

## 3. 目录地图

```
src/main.js                   壳组合根（IPC、runtime 监督）——7083 行 / 69 个 ipcMain.handle（已知债 TD-01）
src/runtime-capability.js     能力矩阵：判定 runtime 是否可用（S1，替代版本号门禁）
src/window-hardening.js       统一窗口加固 + 权限默认全 deny（TD-08/09）
src/runtime-manager.js        版本化运行时安装（arborist 物化 userData/runtime/<version>）
src/ipc-*.js                  已提取 IPC 域（features/mcp/remote/misc/mission/skills/models/scheduled/memory-compact/channels）
src/window-manager.js         窗口/视图/快照广播
src/runtime-mux.js            /api/remote.mux 多路复用客户端（$events / session/follow）——374 行
src/harness-rpc.js            Harness RPC 表面
src/team/runtime/             Team 内核（纯 Node、门禁保护，10 个模块）。⚠ 按 ADR-0002 将退为适配层
src/office/runtime/           办公室纯内核（状态机/调度/布局/词表）
src/office/render/            PixiJS 渲染器（flat 代码化 2.5D / iso 预览）
src/office/office-module.js   办公室组合根——4799 行（总行上限 5200，代码行上限 3400）
src/work/                     单次 Team 执行面（⚠ 不是 Mission 存储层，见 domain-model §5.2）
src/mission/                  Mission Core 纯逻辑层（25 个模块：schema/store/event-log/projection/…）
src/ipc-mission.js            Mission IPC（单通道 mission:invoke + 43 action）
src/mission-desk.html         Mission Desk 窗口（P1 首个用户可见界面）
test/                         离线测试（node:test，cwd 必须是仓库根；265 套件 / 3476 项）
scripts/acceptance/           真机验收探针（需图形会话，不在 CI 跑）
docs/                         文档，唯一索引 docs/README.md
archive/ + docs/archive/      本地保险箱（git 忽略）
```

> 行数会漂移：`test/file-size-budget.test.js` 比对这里的 `main.js` / `office-module.js` 数字与真实行数，改代码后同步本文件。

## 4. 开发流程（强制）

1. **计划先行**：非平凡改动先在 `docs/plans/active/` 写计划并等用户拍板。小修可直接改但须同步文档。
2. **先查后写**：任何"新增能力"前，先查官方包清单 + `docs/quality/tech-debt-inventory.md`。
3. **变异纪律**：每组新测试配负向变异（破坏→红→还原→绿）。无法检出的如实记 `masked`，不得谎称 DETECTED。
4. **真机分层**：headless 离线测试 ≠ 真机验收。真机脚本写进报告，由用户执行回填。
5. **文档同步**：新增/移动/删除任何文档必须同步 `docs/README.md`（`test/docs-index.test.js` 机械校验）。
6. **规则强制化优先**：能变成测试的架构规则就写成测试，不要只写在文档里（见 `docs/quality/quality-gates.md`）。
7. **删冗余行可以，压事实行不行**：触到篇幅上限时先问"这件事该归哪个文件承载"，而不是"哪一行还能再塞点"；
   按职责拆分并由 `test/docs-index.test.js` 的内聚门禁保证不退化。

## 5. 命令与坑

```bash
npm test                                   # 全量（约 2 分钟，3476 项）
node --test test/xxx.test.js               # 单套件（调试首选，全量并发会放大时序偶发）
node --test test/docs-index.test.js        # 文档索引（毫秒级，改文档后必跑）
node --check <file>                        # 语法检查
```

- **cwd 坑**：Bash 默认 cwd 可能是仓库父目录。一律用绝对路径或 `zsh -c 'cd <repo> && ...'`。
- **基线（2026-11-05 实测，诚实版）**：`CI=1 npm test` → **3476 tests / 3468 pass / 7 fail / 1 skip**。
  - 6 个红是**环境缺 Pillow**（`resources/characters/**` 的 PNG alpha 校验用 `python3 -c "import PIL"`）——
    不是代码回归；装了 Pillow 即绿。1 个红是 `test/mcp-verify-gate.test.js` 并发时序偶发（单跑 8/8 通过）。
  - **去向已定（价值层重构 T0/T1，计划 §2.8）**：6 红转条件 skip（CI 设 `REQUIRE_PIL=1` 时变回 fail）、
    并发用例串行化；完成后判据恢复 **0 fail + skip 白名单**（白名单登记在本节）。T0/T1 落地前过渡判据是"红项集合不扩大"。
  - 唯一登记 skip：E5a-R1 真机探针（需图形会话）——**Skip 不计作 Pass**，由 `scripts/ci-gate.js` 四态报告保证，
    见 `docs/quality/test-tiers-and-baseline.md`。**新增 skip 必须登记，未登记的 skip 视同红。**
- **pure Node 门禁**：`src/team/runtime/**` 与 `src/office/runtime/**` 禁止 Electron/DOM/fs/网络；
  `office-module` 的 require 集合冻结。
- **CI 门禁**：`.github/workflows/ci.yml` 在 PR/push 上跑全量测试 +
  三个机械门禁（`npm run check:compat-ledger` / `npm run check:licenses` / docs-index）。

## 6. Git 安全（硬规则）

- 严禁：`git reset --hard`、`git clean -fd`、`git checkout -- .`、`git add -A`。
- 清理/重构必须逐段进行：每删一段 → `node --check` + 相关测试 + 关键符号存在性断言。
- 只回退**自己**刚改的单文件：`git restore --source=HEAD -- <file>`（允许的救援手段）。
- 提交信息写"为什么 + 证据（测试数/变异结果）"；**推送只在用户明确授权后进行**。

## 7. 当前状态与下一步

阶段交付明细、证据位置、已知问题见 `docs/product/delivery-status.md`（唯一来源，本文件不重复）。

- **#23 已关闭（2026-11-04 真机验证）**：`agentTeam` 字段形状与 Brief 跨会话读取均实测通过
  → `docs/quality/harness-agent-team-probe-2026-11-04.md`。仍待验证的是**团队写路径**与**权限轴**（该报告 U-4/U-5/U-7/U-9）。
- **已知偶发**：`test/mcp-verify-gate.test.js` 的 debounce 用例（全量并发下偶发，单跑通过）。
- **仍存的债**：TD-01（main.js 过载）· TD-06/07（IPC payload 未冻结）。
- **ADR-0001..0006 全部已接受**；ADR-0002 附退役硬约束 R0–R5（禁止直接删旧 Team Runtime）。

## 8. 文档入口（按目的）

| 我想… | 读 |
|---|---|
| 了解产品定位与边界 | `docs/product/product-vision.md` |
| 知道什么允许/禁止 | `docs/product/product-principles.md` |
| 知道下一步做什么 | `docs/product/product-roadmap.md` |
| 知道各阶段交付了什么 | `docs/product/delivery-status.md` |
| 理解领域模型 | `docs/architecture/domain-model.md` |
| 理解运行时桥接 | `docs/architecture/runtime-bridge.md` |
| 理解办公室 | `docs/architecture/office-runtime.md` |
| 知道为什么这样决策 | `docs/adr/` |
| 知道什么算通过 | `docs/quality/quality-gates.md` |
| 知道有哪些债 | `docs/quality/tech-debt-inventory.md` |
| 看验证证据 | `docs/research/runtime-poc-report-2026-11-01.md`、`docs/research/memory-and-sdk-validation-2026-11-05.md` |
| 看真机验收证据 | `docs/quality/*-acceptance-2026-11-01.md` |
| 当前重构主线 | `docs/plans/active/VALUE-LAYER-REFACTOR-2026-11-05.md` |
