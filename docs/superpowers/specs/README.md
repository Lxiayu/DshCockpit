# Virtual Office 文档入口

需要开发 Virtual Office 时，从 `2026-08-30-office-agent-handoff.md` 开始；它定义代理必须阅读的顺序、冲突优先级、文件边界、测试纪律和交付报告格式。

随后阅读 `2026-08-30-office-development-spec-index.md`，按 plan 的 Task->SPEC 映射选择唯一分册。implementation plan 只负责任务顺序和提交边界；具体字段、错误码、状态来源和验收阈值以对应 SPEC 为准。

推荐阅读链：

```text
README.md
  -> office-agent-handoff.md
  -> office-development-spec-index.md
  -> docs/superpowers/plans/2026-08-30-virtual-office-runtime-implementation.md
  -> assigned office-spec-XX.md
  -> assigned SPEC 列出的代码与测试
```

当前 Office 分册全部为 `Draft`。用户确认并完成前置门后，主代理才可把对应分册标记为 `Approved` 并发送任务包；没有任务包中的允许文件和验收命令，外部代理不得开始编码。

迁移原则：Office-only 代码集中在 `src/office/`，运行时资源集中在 `resources/office/`，角色包集中在 `resources/characters/`；`main.js`、`window-manager.js` 和设置系统只保留薄接线。`photo/` 与 `docs/legacy/` 不属于生产依赖。每个 Task 完成时必须同步迁移面和 cherry-pick 顺序，并接受主代理的阶段性审查。
