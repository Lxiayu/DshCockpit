# Office SPEC-07：Pixi Office 场景与详情 UI

> Status: Draft

## 目标与非目标

目标是把通过 Playground 的 Runtime 嵌入 flat orthographic Office，并提供可访问的员工详情、活动日志、队列和 capability 控制。非目标：真实 3D/透视、家具最终美术、Renderer 直接改状态、从透明度猜遮挡、重建 Sprite 规避 transition bug。

## 前置阅读与边界

先读 handoff、索引、plan、SPEC-03/04/05/06、`OFFICE-DESIGN-DISCUSSION.md`。允许修改 `src/office/office-page.js`、`office.html/css`、`office-preload.js`、`src/office/render/pixi-office-renderer.js`、`src/office/fixtures/office-layout.json` 和最小 main/window-manager IPC 接线；禁止改 Harness 业务、旧 IPC channel、sessions 或资源原图。

## 场景 fixture 与图层

布局 `schemaVersion=1`：六工位为 2x3，整体右下偏移但保留左上扩展区；节点声明 `id/position/footprint/safeRadius/tags/capacity`。placeholder 家具使用确定性 Pixi Graphics，只是诊断占位。图层固定为 `Background -> Back Furniture -> Ground Entities -> Front Occluders -> Effects/Labels`；Ground Entities 按 `(footY,layer,entityType,id)` 稳定排序，遮挡关系由 fixture 显式声明。

## Pixi 生命周期与 Renderer 契约

每个 WebContentsView 只有一个 Application 和 simulation clock；`PIXI.Assets` 只加载本地已验证资源。每个员工保留一个持久 Sprite/Container，更新位置、纹理和动画不销毁重建。脚底 anchor、visible height 与 SPEC-02/03 一致。隐藏/后台暂停 ticker 和本地模拟，恢复从逻辑位置继续，不补跑时间；关闭 view 释放 view-owned textures。

WebGL 初始化失败进入 Canvas/static/diagnostic renderer，仍保留 HTML 详情、日志和 Adapter；不能因渲染失败让 Harness 壳崩溃。Renderer 只消费 snapshot/derived view model，用户点击通过 preload IPC 表达意图。

## HTML/UI 契约

概览显示在岗人数、运行任务、队列计数和活动日志。详情面板视觉层级：大字号员工名称 + 职责点标记；较大当前任务/最近结果；Session、sync、binding、诊断为小号淡色。必须支持 pointer、键盘 focus、Enter/Space、Escape、屏幕阅读器 label、reduced-motion；本地聊天只显示 icon/ellipsis，不显示模拟文字。

只新增 `office:*` channels：`state`、`dispatch`、`cancel/interrupt`、`settings`、`diagnostics`、`visibility`。IPC payload 必须 schema 校验、大小限制和 privacy redactor；Renderer 不读文件、不订阅 Harness。

## 实现步骤与测试

1. 写失败测试：六工位位置、placeholder、稳定 layer sort、持久 Sprite、anchor/height、resize、隐藏暂停、多窗口 snapshot/clock、fallback、详情键盘和队列 badge。
2. 运行 `node --test test/office-ui.test.js test/office-renderer.test.js`，确认缺实现失败。
3. 在 Playground gate 通过后实现 renderer，再接 HTML UI 和 IPC；每一步保持 static fallback 可用。
4. 用 Electron/Playwright 验证 1280x840 与窄窗口，记录截图、DPR、Pixi renderer 和资源释放诊断。

## 验收、失败处理与交付

验收：无 Harness 对话首次打开也可见本地漫游；任务到工位、结果展示、回到本地行为；无 Sprite 闪烁/重复 ticker；点击不触发整页重建；两个 view 不共享可变 Pixi 资源；详情和 capability 正确。空白或 FPS 下降必须切到 static/diagnostic，不能通过隐藏角色“通过”。

### 交接报告

交付报告列出 fixture 版本、IPC channels、截图/trace、资源统计、键盘验收、fallback 路径和已知缺口。若需要跨层直接读写、图层只能靠 CSS 修正或 Pixi 生命周期不确定，停止并回到相应 SPEC。
