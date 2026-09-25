# Office SPEC-08：持久化、设置、隐私与降级

> Status: Draft

## 目标与非目标

目标是建立 Office 独立的、可迁移且隐私可控的持久化边界，并在资源/渲染/同步失败时保持壳可用。非目标：把办公室字段塞进旧 `settings.json`、保存动画过程、恢复旧运行任务、记录 prompt/工具结果或让 Renderer 成为写者。

## 前置阅读与边界

先读 handoff、索引、plan、SPEC-02/03/05/07、`settings-store.js` 现有 schema。允许修改 `office-persistence.js`、`privacy-redactor.js`、办公室设置 IPC、迁移测试和双语文案；禁止修改旧设置字段、`runtime-state.json`、`sessions/` 和原始素材。

## 存储所有权与 schema

主进程单写者维护 `userData/office-state.v1.json`，写入采用同目录 temp + fsync（可用时）+ atomic rename；并发请求串行化。Schema：

```json
{
  "schemaVersion":1,
  "flags":{"officeRuntimeEnabled":false,"officePlaygroundEnabled":false},
  "settings":{"sleepAfterMs":300000,"resultPresentationMs":5000,"sceneMinDimensionPerSecond":0.12,"userFrameDurationOverrideMs":null,"reducedMotion":false,"privacyMode":"redacted"},
  "employees":[],"tasks":[],"activityLog":[],"bindings":[]
}
```

只持久化 profile、角色选择、设置、每员工最多 50 条最近任务、全局最多 200 条脱敏活动和带 epoch 的 recoverable binding snapshot。不保存 path、frame、chat lock、reservation、in-flight transition。旧 epoch 只能显示 stale history，不能恢复 running。

设置范围：`sleepAfterMs` 60 秒至 24 小时；`resultPresentationMs` 1 至 30 秒；速度为正且受产品上限保护；frame override 为空或合法正整数。变更在下一个行为/过渡决策点生效，不截断当前结果、不改写当前 path。优先级：用户 override > per-frame > animation default。

## 隐私矩阵与降级

默认 `privacyMode=redacted`。同一个 redactor 用于详情、日志、持久化、探针：保留员工角色、状态、event type、粗粒度 result code；任务文本、工具参数/结果、错误原文、Session ID、Token/Context 数值替换占位符或 bucket。`full` 需用户显式开启，任何模式都不保存密钥。

无包/manifest 错误/纹理失败/WebGL 不可用/Runtime stale/FPS 不足时，保留背景、详情、日志，依次使用 pinned `deepseek-default` 或 diagnostic placeholder/static renderer；诊断码稳定且不崩溃 Harness。文件损坏先尝试最后有效备份，再回默认 schema，并记录 `OFFICE_STATE_CORRUPT`。

## 实现步骤、测试与验收

1. 写 schema migration、原子写恢复、并发单写者、设置 clamp/生效时点、history 上限、epoch 拒绝、隐私矩阵、flag 默认值和 fallback 失败测试。
2. 运行 `node --test test/office-persistence.test.js test/office-privacy.test.js`，确认缺实现失败。
3. 实现读-校验-迁移-写入流水线；写失败保留旧文件，不把半文件暴露给读取者。
4. 注入临时 userData 和 fake clock 运行 focused tests，并检查脱敏 JSON。

验收：重启后只恢复允许字段；损坏/低权限/磁盘失败时壳仍能进入 static Office；所有设置有 clamp 和双语错误反馈；默认 flags 仍为 false，直到 SPEC-09 发布门。

## 交接报告、交付与停止条件

报告 schema、迁移版本、原子写策略、隐私样例（必须脱敏）、降级矩阵、测试结果和残留风险。若实现必须写旧 schema、需要保存运行中任务、或 redactor 不能覆盖某类 payload，停止并请求产品/安全裁决。
