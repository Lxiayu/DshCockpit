# Office SPEC-03：纯 Character Runtime 核心

> Runtime 是可测试的 Agent Character Runtime，不是 Pixi 组件集合。它只接收结构化输入并返回新状态，不能自行读取 Harness、DOM、文件或系统时钟。
>
> Status: Draft

## 目标与非目标

目标：解耦 position/velocity、direction、animation state/frame、行为 activity 和 Runtime task，提供确定性移动、状态机和过渡控制。非目标：渲染、IPC、持久化、LLM 调用、A*、物理碰撞或随机桌宠逻辑。

## 前置阅读与文件责任

先读 handoff、索引、plan、`character-animation-architecture.md`、`character-movement-system.md`、`character-state-machine.md`、SPEC-02。允许修改 `src/office/runtime/{asset-pack,animation-controller,movement-controller,transition-controller,state-reducer}.js` 和对应纯测试。禁止 import Electron/Pixi/DOM/Harness；禁止在 reducer 内写文件或使用 `Date.now()`/`Math.random()`。

## API 契约

所有工厂均接收显式 `clock/seed/config`，返回无副作用对象：

```js
animation.resolve({state, direction, elapsedMs, pack})
// -> {resource, frameIndex, frameElapsedMs, loop, fallbackReason|null}
movement.step({position, target, graph, reservations, dtMs, scene:{width,height}})
// -> {position, direction, progress, arrived, routeId, reservationAction}
reduceOfficeState(state, event)
// -> {state, effects: []}
```

坐标是 `[0,1]` normalized；屏幕距离为 `hypot(dx*width,dy*height)`；默认速度 `sceneMinDimensionPerSecond=0.12`。resize 只改变投影，不改变逻辑位置/目标。visible height 使用 SPEC-02 公式。

## Waypoint、reservation 与移动

fixture `schemaVersion=1` 的节点字段为 `id/position/tags/capacity/safeRadius`，边为 `from/to/behaviors/bidirectional`。BFS 按 fixture 顺序遍历，过滤行为标签、容量、safe radius 和当前 reservation；无路返回 `UNREACHABLE`，严禁 teleport。reservation 有 owner、route segments、expiresAt、half-life renewal；到达、取消、超时、完成和中断统一释放。交叉 segment 冲突必须等待或换路。

移动方向由主导轴和稳定 tie-break 得出；到达误差不超过 `0.01` normalized。每次目标切换先由 Transition Controller 清理旧 reservation/chat lock，不能只改坐标。

## 状态与过渡

四层状态：`presence`、`sync`、`runtime`、`activity`，另有 `movement/control/binding/queue`。Runtime 事件才可产生 `running/completed/failed/attention`；本地 Scheduler 只能产生 `roaming/chatting/resting/sleeping`。取消仅产生 pending effect，直到 terminal evidence 才释放 binding。

Transition 必须显式经过 `stop -> turn -> move -> arrive -> sit/work` 与 `result -> stand -> leave`；中断时记录 reason、释放 path/chat reservation、保留最后可信任务。新状态不能通过替换 Sprite 或瞬移隐藏过渡错误。

动画帧时钟独立于 movement ticker，支持 animation default、per-frame、user override 的优先级；不假设四帧。

## 实现步骤、测试与验收

1. 先写 movement/animation/transition/reducer 失败测试，使用 fake clock、fixture graph、deterministic seed。
2. 运行 `node --test test/office-animation-controller.test.js test/office-movement-controller.test.js test/office-transition-controller.test.js test/office-state-reducer.test.js test/office-asset-runtime.test.js`，预期缺失模块失败。
3. 逐个实现最小纯 API；每完成一个模块运行其 focused test，并对该文件单独执行 `node --check <file>`（不要把 glob 传给 node）。
4. 检查 BFS、容量/半径、resize、anchor、状态优先级、取消 pending 和 transition 清理。

验收：focused tests 全通过；无 wall-clock/random 依赖；所有输出可 JSON replay；不含任何渲染或 IO 依赖。失败应回到责任层：路径问题修 movement，帧漂移修 asset，状态来源修 reducer，不能由 UI 兜底。

## 交接报告、交付格式与停止条件

报告 API 签名、状态不变量、fixture 版本、测试输出、性能基线和已知缺口。若发现上游事件无法表达所需状态、图无法连通、anchor 超限或 API 需要 Electron，停止并更新 SPEC/plan 后再实现。
