# Office SPEC-09：全量验收与发布门

> 这是发布门，不是“看起来能动”的人工确认清单。所有证据必须可重放、脱敏并能定位到责任分册。
>
> Status: Draft

## 目标与非目标

目标是证明 Office 在自动化、Electron、性能、视觉、隐私和降级门上满足已批准 SPEC，再决定是否打开生产 feature flag。非目标：在验收阶段新增产品功能、修改上游阈值、替换失败证据或清理用户 dirty worktree。

## 前置阅读、允许修改与禁止修改

先读 handoff、索引、plan、SPEC-00 至 SPEC-08、当前 release checklist。允许新增验收脚本、fixture、报告和测试；不得为通过验收放宽上游阈值、删除失败证据或默认开启 feature flag。禁止修改生产逻辑来迎合截图或性能结果；发现问题必须回到责任 SPEC。

## 自动化门

必须运行：

```bash
npm test
node --check src/main.js
node --check src/window-manager.js
for file in src/office/runtime/*.js; do node --check "$file"; done
node --test test/office-*.test.js
```

任一失败、未提交的 focused test、未解释的 `git diff --check` 错误或 staged 文件越界，都阻断 `officeRuntimeEnabled`。修改 main/window manager 后必须先做语法检查，再做 focused tests，最后才跑全量。

## 实现步骤

1. 收集 SPEC-01 至 SPEC-08 的完成门和证据索引，确认没有未解释的 blocker。
2. 运行自动化门和 Electron 场景矩阵；失败项定位回责任 SPEC，不在本分册改阈值。
3. 运行性能、视觉和隐私复核，保存脱敏 replay、截图和 diagnostics。
4. 由主代理和用户审阅交付报告，才决定 `blocked|candidate|approved`。

## Electron 场景矩阵

固定 macOS 14+、Electron 37（以 SPEC-01 实测为准）、`1280x840`、DPR 1，并另测窄窗口和高 DPI：

1. 无 Harness 对话打开 Office，四名员工立即本地漫游，不显示 offline。
2. 可信 running/attention 让正确员工到工位，working/结果展示后回本地行为。
3. collaborator FIFO、waiting count、唯一绑定和原子释放。
4. cancel/interrupt 仅 pending，直到 terminal evidence 才释放。
5. stale/resyncing 不结束聊天/休息、不让未结束绑定睡眠。
6. resize/隐藏/后台/恢复不改变锚点、不补跑时间、不重复 ticker。
7. 两个 Office view 使用同一主进程 snapshot/clock；关闭一个只释放自己的 Pixi 资源。
8. 缺失包、WebGL 失败、低 FPS 进入 static/diagnostic，详情/日志仍可用。
9. 损坏 office-state 恢复默认/最后有效文件，不触碰旧 settings/sessions。

## 性能、视觉与隐私门

五个活动角色参考场景 FPS 至少 30；记录 renderer、纹理解码 bytes、加载耗时、ticker 数、DPI、字体和内存趋势。WebGL 失败与 FPS 失败分开判定。fake-clock 布局 pixel diff 初始阈值 5%，动画帧差异不计入布局 diff；人工复核 Contact/Passing、脚底线、转向、停下、遮挡、详情层级和 reduced-motion。

导出的截图、trace、diagnostics、event replay 必须经过 redactor；禁止包含 prompt、工具参数/结果、Session ID、路径、Token 或密钥。证据保存于 `artifacts/office-playground/<commit>/`，Pixi spike 保存于 `docs/notes/office-pixi-spike-2026-08.md`。

## 发布决策与回滚

只有所有阶段门通过、用户确认 evidence、兼容矩阵无未决 blocker，才把 `officeRuntimeEnabled` 从 false 改为 true。生产默认保留 static/diagnostic fallback。失败发布只回滚本次 Office 文件/提交，不 reset 或 checkout 用户既有修改；报告回滚文件清单和恢复命令。不要自动 merge/push。

## 交接报告模板

```text
Scope: 覆盖的 SPEC/场景/commit
Environment: OS/Electron/Node/Pixi/viewport/DPR
Contracts: schema、channels、capability、feature flags
Tests: 每条命令、退出码、摘要
Evidence: 截图、replay、diagnostics、性能报告（脱敏路径）
Findings: 失败项及责任层
Known gaps: 明确未覆盖项
Release decision: blocked|candidate|approved
Rollback: 仅本次变更的文件和步骤
```

## 停止条件

空白渲染、角色漂移超 `1px`、重复绑定、队列跳过 terminal、任何本地行为外部调用、隐私泄漏、无网络/CSP 证据、FPS 低于门槛或文档契约冲突，均必须标记 `blocked`，先修责任 SPEC，不得用截图裁剪、延迟或文案掩盖。
