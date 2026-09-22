# Virtual Office 外部 AI 代理交接规范

> 这是交给其他 AI 开发者的入口文件。任何代理在修改代码前必须完整阅读本文件、开发 SPEC 索引、implementation plan，以及被分配的具体 SPEC。

## 阅读链

```text
agent-handoff.md
  -> office-development-spec-index.md
  -> docs/specs/OFFICE-DESIGN-DISCUSSION.md
  -> docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md
  -> implementation plan
  -> assigned SPEC
  -> existing files named by that SPEC
```

代理不得只阅读用户消息或只阅读一个代码文件就开始改动。若 plan、SPEC、现有代码互相矛盾，停止实现，记录冲突位置并请求主代理裁决。

## 规范优先级与冲突处理

冲突按以下顺序裁决：用户已确认的产品决策 > 当前 SPEC 中的已批准契约 > compatibility/research evidence > implementation plan 的步骤 > 现有实现 > 旧文档/旧代码注释。这个顺序只规定发现冲突后的处理方式，不能用来跳过上游阅读。代理必须报告“文件、行号、冲突字段、受影响任务、建议选项”，不得默默选择一边实现。

`Draft` 文档只可作为提案，不能被代理当成已批准接口；`Approved` 才能约束实现；`Superseded` 段落只能用于历史背景。若状态未写明，按 Draft 处理。

## 开始任务前

1. 运行 `git status --short`、`git diff --name-only`，记录任务开始前已有的用户修改。
2. 读取 plan 中本任务的 Files、Steps、Expected 和 commit 边界。
3. 读取 assigned SPEC 的“目标、输入、输出、允许修改、禁止事项、测试、交付”部分。
4. 检查依赖和运行时版本，不自行升级 Electron、PixiJS 或 Harness。
5. 用一句话向主代理确认：本任务要解决什么、不会修改什么、验收命令是什么。

## 主代理发送的任务包

主代理应为每个外部代理发送一段可复制的任务包，避免代理自行猜测范围：

```text
Task: plan.md 中的 Task N / SPEC-0X
Read first: handoff -> index -> product/research -> plan -> assigned SPEC
Allowed files: <精确文件列表>
Forbidden files: <精确目录/文件列表>
Inputs already available: <探针、fixture、上游 commit 或报告>
Required tests: <命令>
Evidence path: artifacts/office/<task>/<commit>/
Stop and ask when: <冲突、缺少能力、素材或隐私问题>
Expected report: Scope/Files/Contracts/Tests/Evidence/Known gaps/Rollback
```

代理收到的任务包缺少 `Allowed files` 或 `Required tests` 时，先请求补全，不开始编码。

## 实现边界

- CommonJS + `'use strict'`，沿用仓库现有模块风格。
- 纯逻辑模块不得 import Electron、Pixi、DOM、Harness 或写文件。
- Renderer 不得直接访问文件系统或 Harness；所有事实经 IPC/Adapter。
- 本地漫游、聊天、休息、睡眠不能产生 LLM 调用、Token、Runtime transcript 或伪造任务结果。
- 不修改 `sessions/`、旧 `settings.json`、旧 `runtime-state.json` 和无关模块。
- 不把 `eventId/sessionEpoch`、pause/resume/preempt 写成 Harness 原生能力。
- 不用 CSS offset、setInterval 图片硬切、节点销毁重建或 teleport 掩盖 anchor/path/transition 缺陷。
- 不把测试 fixture、placeholder 或诊断 renderer 当成生产美术；临时实现必须显式命名并能删除。
- 不在一个提交中混合依赖升级、跨层重构和无关格式化；一个任务只产生一个可回滚边界。
- Office 新代码默认放在 `src/office/`，Office 测试放在 `test/office/`；不要把业务逻辑散落到仓库根目录。
- `photo/` 和 `docs/legacy/` 只能作为源素材/历史归档，生产代码、资源扫描器和打包配置不得加载它们。
- 共享入口文件只能做薄接线；如果需要把 Runtime、Pixi 或 Office 状态写进 `main.js`/`window-manager.js`，必须停止并报告边界冲突。
- 任何资源路径都必须通过 resolver 兼容开发、打包和 userData；禁止本机绝对路径。

## 测试纪律

先写失败测试，再写最小实现。纯逻辑使用 fake clock、fixture 和 deterministic seed；Electron 测试记录 viewport/DPI；视觉问题同时提交截图和诊断 JSON。修改 `main.js` 后先运行 `node --check src/main.js`，再运行相关测试，最后才跑 `npm test`。

## 交付格式

代理完成时必须报告：

```text
Scope: 本次实现覆盖的 SPEC/步骤
Files: 实际修改/新增文件
Contracts: 新增或确认的接口、字段、来源、版本
Tests: 执行命令与实际结果
Evidence: 截图/报告/日志位置（必须脱敏）
Known gaps: 未完成项、失败项、需要主代理决定的冲突
Rollback: 本任务提交包含哪些文件，如何只回滚本任务
```

代理不得自行 merge、push、删除用户文件或修改任务范围。若发现素材、Harness 版本、Pixi 生命周期或隐私策略与 SPEC 不符，应先停在诊断状态。

## 证据命名与可重放要求

证据目录使用 `artifacts/office/<task>/<commit-or-dirty-id>/`；最少包含 `commands.txt`、`result.json`、`diagnostics.json`，视觉任务再包含固定 viewport 的 PNG。JSON 必须可由 fixture replay 重建，时间使用 ISO 或 fake-clock tick，不写本机绝对路径、密钥、Session ID 或原始任务文本。截图文件名包含场景和阶段，例如 `moving-t+1000ms.png`。

交付前运行 `git diff --check` 和 `git diff --cached --name-only`。报告中的 Files 必须与 staged 清单一致；发现其他代理同时修改同一文件时，不覆盖其内容，先发冲突报告。

## 实时审查协议

开发期间，主代理或外部代理每完成一个可验证小步骤，都应向审查者同步：当前 Task/SPEC、刚完成的行为、变更文件、测试命令/结果、未决风险和下一步。不得连续完成多个跨层步骤后才一次性汇报。审查者至少检查：

1. 变更是否仍在 Allowed files 和本 SPEC 边界内；
2. 输入/输出字段、来源、版本和错误处理是否与上游契约一致；
3. 测试是否覆盖失败路径、时钟/顺序/资源生命周期和隐私；
4. 是否引入对 `main.js`、旧 settings/sessions、`photo` 或 `docs/legacy` 的不必要耦合；
5. 是否保留可回滚提交和迁移面报告。

审查者提出 blocker 后，代理必须先修复或解释并获得裁决，不能继续推进下游 Task。审查意见、决定和修复结果写入对应交付报告或 `docs/notes/`，不只留在聊天记录中。

## 迁移检查

若任务将来需要迁移到主仓库，交付报告必须额外列出：`Office-only files`、`Shared integration files`、`Asset/runtime paths`、`Cherry-pick order`、`Expected conflict points`。代理不得声称“可直接迁移”，除非已用临时目标目录或 `git diff --find-renames` 验证路径，且没有对旧 settings、runtime-state、sessions 的写入。

## 常见误区

1. 把 `agent/status=idle` 渲染成 offline；常驻员工始终 `presence=present`。
2. 把 `cancel()` 返回当成任务已结束；必须等 terminal evidence。
3. 把 `subagent/end` 一律当取消；必须读取 `stopReason`。
4. 用透明 PNG 完整画布计算角色大小；必须按 `visibleBounds` 和统一 visibleHeight。
5. 在窗口隐藏后继续跑本地 ticker；隐藏/后台必须暂停模拟时钟，恢复不补跑。
6. 把本地聊天写成文字消息；只允许非文字 icon/ellipsis 和辅助标签。
7. 为了通过测试而放宽 `±1px` anchor、速度或顺序阈值；失败应回到对应责任层。
