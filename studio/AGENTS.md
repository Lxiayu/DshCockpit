# AGENTS.md — 给外部编码代理（Codex 等）

这个目录（`studio/`）是一个**人类用的内容工作台**。代理的开发入口是命令行镜像，不是界面：

- **权威说明（先读）**：`studio/skills/workbench/SKILL.md`
- **可用操作（自动生成，勿手改）**：`studio/skills/workbench/reference/operations.md`
- **目录地图 / 硬约束 / 已有能力与缺口**：`studio/docs/handover.md`
- **数据契约**：`studio/docs/contracts.md`

三条最容易被忽略的规矩：

1. 内容只经**校验事务**写入（试算 → 校验 → 字节备份 → 写）。用 `node bin/agent.js diff|apply`，
   或 `bin/{scene,actions,dialogue,graph}.js`；**不要**自己写 `content/**` 或 `resources/**`。
2. `src/office/**`（产品运行时）与 `photo/**`（历史素材）**只读**。
3. 改完必须 `node bin/agent.js check --domain all`，并保证 `cd studio && npm test` 与 `git status --short content/`（应为空）。
