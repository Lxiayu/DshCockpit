# Office SPEC-06：Animation Playground

> Status: Draft

## 目标与非目标

目标是在正式 Office 前，用一个角色、纯色背景和固定 fixture 验证素材几何、四方向 walk、独立帧时钟、移动、转向、状态过渡、resize 和 fallback。非目标：真实 Harness binding、办公家具、持久化、多人行为或生产 feature flag。

## 前置阅读与边界

先读 handoff、索引、plan、Character Runtime 五份设计规格、SPEC-02/03。允许修改 `src/office/playground-*`、fixtures、focused test 和开发-only window command；不得从 Playground 写 office-state、调用 Harness 或修改生产 Office 页面。

## 页面与调试契约

页面创建一个 Pixi Application、一个 Sprite、纯色背景和 waypoint graph。控件必须能选择 state/direction/speed/frameDuration/loop/pause/reduced-motion，点击目标投影到允许 waypoint；direct-target 只在 debug 开关下可用。Overlay 显示 anchor、visibleBounds、footprint、route、frame、fallback、logical/screen position、fake time。

固定 reference viewport `1280x840`、DPR 1、系统字体记录在 evidence JSON。fake clock 必须可暂停、步进和 replay，同一个 seed/replay 得到同一截图和 diagnostics。

## 自动验收阈值

- frame boundary 误差 `±16ms`；移动 ticker 与帧 ticker 独立。
- 参考视口一秒屏幕距离误差 `±5%`，方向切换无额外 teleport。
- foot baseline drift `<=1 CSS px`。
- resize 逻辑位置误差 `<=0.005`、到达误差 `<=0.01`。
- visible height 遵循 `clamp(64px, sceneHeight*0.11, 180px)`。
- reduced-motion 立即应用目标但仍推进逻辑状态；文本/诊断可读。
- 缺失动画走 fallback chain，不出现空白。

## 实现步骤与证据

1. 写失败测试覆盖 waypoint 投影、fake ticker 边界、速度、anchor、状态转换、resize、reduced-motion 和 missing texture。
2. 运行 `node --test test/office-playground.test.js`，确认缺实现失败。
3. 实现隔离页面和 fixture runner；先做 overlay，再做美术隐藏开关。
4. 运行 focused tests；用 Playwright/Electron 固定 viewport 截 initial/moving/arriving/result/resize/reduced-motion/missing-texture，并保存 replay、diagnostics、pass/fail JSON 到 `artifacts/office-playground/<commit>/`。

## 人工复核、验收与停止条件

人工必须逐项观察 Contact、Passing、body bounce、方向一致性、停下/转向、Walk->Work、Work->Walk 和不同速度。自然度问题归素材/transition 层，不用 offset 或改变阈值掩盖。Stage 1 geometry、2 walk、3 transitions、4 projection/resize、5 fault 全通过后才允许 SPEC-04/07 的多人/正式场景。

### 交接报告

交付报告包含 viewport/DPR/版本、命令结果、截图索引、人工结论和未通过帧。若脚底超限、资源解码失败、截图空白或视觉检查未通过，停在 Playground gate，不进入 Office。
