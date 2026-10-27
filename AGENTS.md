# AGENTS.md — DshCockpit 地图与开发规则

> 本文件是**目录**，不是手册。深入内容在 `docs/`；`docs/README.md` 是唯一索引。
> 任何 agent/开发者先读这里，再按图索骥。保持本文件 ≤ 130 行（超了就是该拆了）。

## 1. 我们是什么

DshCockpit = 本地优先的 AI 工作团队桌面应用：**自研 Harness + Team**，以虚拟办公室为差异化呈现。
当前阶段：v0.6 完成（真实 dsh 执行链、resume 闭环、过程可见、首帧解耦、推送瘦身）；
v0.7 方向见 `docs/product/WORK-FIRST-V0.7.md`（从"看团队"到"用团队工作"）。

## 2. 架构铁律（任何改动不得违反）

1. **四层事实作者**：Harness 负责真实执行；Team Runtime 负责事实收敛（唯一 `team/*` 作者）；
   Office 负责理解呈现（只消费投影）；Electron Shell 负责承载。**任何一层不能冒充另一层的事实作者。**
2. **单向数据流**：执行事件 → controller（唯一转换点）→ Team facts → bridge → office 投影 → 快照 → 渲染。
3. **隐私**：raw sessionId / prompt 正文 / 产物内容 / 绝对路径**不进** Team fact 与 Office 快照。
   进入事实链的只有派生句柄（`exec-*` / `team-*-sha256:*`）与闭集 token。
4. **不伪造**：没有验证证据就没有"完成"；执行层不得生成 prompt；UI 不得自己编造状态。
5. **办公室不是输入面**：控制指令走明确的通道（`shell:team` / `office:cancel`），
   `office:*` 通道集合在契约里冻结（当前 8 个 + `shell:*` 自有命名空间）。

## 3. 目录地图

```
src/main.js                   壳组合根（IPC、runtime 监督、Team 真实入口接线）
src/window-manager.js         窗口/视图/快照广播；延迟服务门
src/team/runtime/             Team 内核（纯 Node、零 office 依赖、门禁保护）
  team-runtime.js             Team facts 唯一作者（fold 内核）
  execution-schema.js         执行事件词表/校验（execution/*）
  dsh-execution-backend.js    dsh 执行后端（transport 注入）
  team-execution-controller.js 执行→Team 唯一转换层
  team-office-adapter.js      Team fact → 白名单 office 事实（纯函数）
  execution-port.js / fake-executor.js  端口契约与离线执行器
src/team-shell-transport.js   壳侧 transport（建会话/发任务/物化产物）+ 固定模板
src/office/office-module.js   办公室组合根（仿真/快照；requires 冻结 + 行数上限）
src/office/runtime/           办公室纯内核（状态机/调度/布局/词表）
test/                         离线测试（node:test，**cwd 必须是仓库根**）
docs/                         文档（architecture / product / research / plans / quality / archive）
archive/                      本地保险箱（git 忽略，历史版本在提交里）
```

## 4. 开发流程（强制）

1. **计划先行**：非平凡改动先在 `docs/plans/active/` 写计划（目标/边界/工作包/验收/变异清单），
   经用户拍板后再动工。小修可直接改，但仍要同步文档。
2. **纵向批量**：一个批次 = 若干独立 commit，每个 commit 自洽可回退；做完写报告到
   `docs/research/`（或 plans/completed/），并把计划移入 `plans/completed/`。
3. **变异纪律**：每组新测试配负向变异（破坏→必须红→还原→复绿）。无法被变异检出的测试要**如实记录**
   （masked），不得谎称 DETECTED。
4. **真机分层**：headless 离线测试 ≠ 真机验收。真机脚本写进报告，由用户执行并回填结果。
5. **文档同步**：新增/移动/删除任何文档，必须同步 `docs/README.md` 索引；
   `test/docs-index.test.js` 会机械校验（未登记的文档 = 测试红）。

## 5. 命令与坑

```bash
# 全量测试（当前 1853 项；目标内部循环 < 1 分钟，正在分段优化）
npm test                                   # = node --test "test/*.test.js"（约 2 分钟）
# 单套件
node --test /abs/path/test/xxx.test.js
```

- **cwd 坑**：Bash 默认 cwd 可能是仓库父目录而非仓库根。一律用绝对路径，
  或 `zsh -c 'cd <repo> && ...'`；`parallel` 场景禁止共享 cd。
- **pure Node 门禁**：`src/team/runtime/**` 与 `src/office/runtime/**` 禁止 Electron/DOM/fs/网络；
  office-module 的 require 集合冻结。
- **docs/ 与 archive/**：活跃文档已入库（2026-10-27 重构）；`docs/archive/` 与根 `archive/` 仍 git 忽略（本地保险箱）。

## 6. Git 安全（硬规则）

- 严禁：`git reset --hard`、`git clean -fd`、`git checkout -- .`、`git add -A`。
- 清理/重构必须逐段进行：每删一段 → `node --check` + 相关测试 + 关键符号存在性断言。
  只回退**自己**刚改的单文件（`git restore --source=HEAD -- <file>`）是允许的救援手段。
- 提交信息写"为什么 + 证据（测试数/变异结果）"；推送只在用户明确授权后进行。

## 7. 当前状态与下一步

- v0.6 已推送（`21f7db3`）；v0.7 P1（工作区/产物落地/工作台）已落地并通过首轮真机验收（全量 1853 绿），
  本地未推送；计划/偏差/真机脚本见 `docs/plans/active/HARNESS-V0.7-P1-PLAN-2026-10-27.md`
  与 `docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md`。
- 待办主线：`docs/product/WORK-FIRST-V0.7.md` P1（产物与工作台）。
- 已知缺口：bind-attention 取消入口、blocked-turn steer 续跑、crash 受信来源、durable store。
- 办公室视觉重构（绑定式角色）排在 P3，硬门槛是 P1 验收通过。
