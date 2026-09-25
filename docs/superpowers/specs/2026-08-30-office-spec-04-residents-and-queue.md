# Office SPEC-04：常驻员工、本地行为与队列

> Status: Draft

## 目标与非目标

目标是定义四名常驻员工、一个 collaborator、无任务时的本地生命感和忙碌时的真实席位绑定。常驻员工始终 `presence=present`，长时间无任务进入 sleeping 而非 offline。非目标：伪造 LLM 对话、扩展 Harness provider 权限、复制多个协作者、在本地行为中消耗 Token 或生成 Runtime transcript。

## 前置阅读与边界

先读 handoff、索引、plan、SPEC-03、SPEC-05、`character-state-machine.md` 和 `character-movement-system.md`。允许修改 `src/office/runtime/employee-profile.js`、`employee-registry.js`、`behavior-scheduler.js`、`queue-controller.js`、`state-reducer.js` 和对应测试；不得让这些模块 import Harness/Pixi/DOM，也不得修改 session 原始数据。

## Employee Profile 契约

```json
{
  "employeeId":"coder", "displayName":"编码员", "role":"编码、文件、命令",
  "defaultSeat":"desk-3", "characterPack":"deepseek-default", "variant":"base",
  "allowedOverrides":["displayName","role","seat","characterPack","variant"]
}
```

固定员工：`orchestrator/desk-1`、`researcher/desk-2`、`coder/desk-3`、`reviewer/desk-4`；desk-5/desk-6 为未来扩展或协作者使用。profile 与 Session 分离，不能由 Harness payload 覆盖角色包/权限。第五席 collaborator 是单例，未知子代理进入其中的 FIFO 队列。

## Binding 与任务生命周期

Binding 字段：`sessionId/employeeId/bindingSource/confidence/boundAt/releasedAt`。优先级 `manual > root-default > heuristic`；Session ID 全局唯一，不能同时占用两个席位。根 Session 默认 orchestrator；`subagent/start` 建立或排队 binding；`subagent/end` 只有在 terminal evidence 后释放，并保留脱敏的 last task/result。`cancel` 返回不释放席位。

## 本地行为

办公室打开即用主进程 snapshot/clock 开始模拟，不等待 Harness。决策使用稳定 seed，默认概率 `roaming 60% / resting 25% / chatting 15%`，设置最小停留、冷却、safe radius、容量和每次仅一对聊天。聊天只显示 icon/ellipsis 与可访问性 label，不发送文字、不调用 LLM、不写 transcript。连续无可信任务达到默认 `sleepAfterMs=300000` 后允许 sleeping；阈值由 SPEC-08 clamp。

可信 `running/attention` 到达时，释放本地目标/聊天锁，沿 graph 前往员工工位；完成/失败需展示 `resultPresentationMs` 后，经过 stand/leave 才回到本地行为。`sync=stale/resyncing` 不制造 offline，不结束聊天/休息，不让仍有未结束 binding 的员工睡眠。

## 队列契约

队列项：`queueItemId/requestedAt/requestedBy/employeeId/sessionId/taskSummary/priority/status`，status 为 `queued|dispatching|running|cancelled|completed|failed`。空闲直派在同一 reducer 事务创建 `binding=pending`；忙碌请求 FIFO。urgent 只能 `cancel/interrupt -> 等 terminal evidence -> 原子释放 -> 启动下一项`，不能 teleport、复用旧 path 或跳过 collaborator。

## 实现步骤、测试与验收

1. 写 profile、binding、scheduler、chat、sleep、FIFO 和 urgent preempt 的失败测试。
2. 运行 `node --test test/office-behavior-scheduler.test.js test/office-employee-registry.test.js test/office-employee-profile.test.js test/office-queue-controller.test.js`，确认缺失实现失败。
3. 实现纯 reducer/scheduler；注入 fake clock、seed、graph 和 terminal event。
4. 验证办公室首次打开即漫游、无 offline、聊天上限、睡眠边界、waiting count、原子切换和 reservation 清理。

验收需有 deterministic replay：四 profile 正确、协作者最多一个、忙碌任务不丢失、急件不抢占未终止任务、本地行为零 Harness 调用。冲突时停止，不用 UI 隐藏队列状态。

## 交接报告

报告 profile 表、binding 优先级、队列状态机、seed/clock、focused test 命令和结果、场景 replay 文件、已知视觉缺口。若发现员工角色和 Harness 责任混淆、队列无法证明 terminal、或本地行为触发外部调用，立即停工并回报。
