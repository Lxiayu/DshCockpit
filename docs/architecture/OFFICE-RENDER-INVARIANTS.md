# 虚拟办公室渲染不变量（改代码前必读）

> 建立日期：2026-11-02（因一次真实事故）
> 相关代码：`src/window-manager.js`、`src/office/office-module.js`、
> `src/office/render/fps-monitor.js`、`src/office/render/pixi-office-renderer.js`
> 自动防护：`test/office-throttling-guard.test.js`

## 事故经过（一句话）

给 office 视图开了 Chromium `backgroundThrottling` →
渲染循环降到 1Hz → fps-monitor latch 降级 →
**虚拟办公室永久白屏，切走再切回也不恢复**。

## 不变量 1：office 永远不能被 backgroundThrottling 节流

```js
// src/window-manager.js — showOfficeShellView()
backgroundThrottling: false,   // ← 必须是 false，永久
```

**为什么**：办公室不是纯展示页面，是**持续运行的仿真 + WebGL 渲染循环**。
节流掐死的正是它的核心工作。

### 因果链（记住这个就够）

```
backgroundThrottling: true
  → 渲染循环降到 1Hz
  → fps-monitor 连续多个窗口低于阈值
  → latch degraded = true
  → 该状态**设计上不可自动恢复**（只能显式 reset()）
  → 永久白屏（切走再切回也没用，因为那不算 foreground transition）
```

## 不变量 2：两个"可见性"层次不能混

| 层次 | 是什么 | 能不能动 |
|---|---|---|
| ① 页面自己的仿真节流 | `notifyOfficeShellVisibility()` 下发的 `active` | ✅ **可以**，设计好的 |
| ② Chromium `backgroundThrottling` | 整个渲染循环降频 | ❌ **绝对不行** |

①是"用户没在看时降低气泡动画频率"，仿真继续跑。
②是"把整个渲染循环掐死"。**两者完全不是一回事。**

## 不变量 3：别指望靠切换视图恢复降级态

`reset()` 只在三处调用：
- foreground transition
- render-profile downgrade 之后
- recovery rebuild 之后

`removeChildView` / `addChildView` **不构成** foreground transition。
所以"切走再切回"救不了降级。

**正确做法是别让帧率掉下来。**

## 不变量 4：隐私边界

- 渲染层只能消费 `state()` 快照
- 快照**永远不能有** sessionId / prompt / 工具参数 / 原始错误
- 原始 Harness id 只能留在主进程当句柄

## 不变量 5：单一逻辑时钟

`office-module.js` 是**唯一组合根**。仿真逻辑散出去会让"一个逻辑时钟"失效
（会出现两套时间，表现为走位/气泡错乱）。

## 关于那次"内存优化"

当时的 A/B 数据是：主进程 -272MB。

**那是假收益。** 省下的内存正是把干活的渲染循环掐死了——
用户看不见内容，自然也不占渲染资源。

### 教训

> **优化不能只看资源指标，必须同时验证功能没被削弱。**
> 内存下降 + 功能坏死 ≠ 优化成功。

而且当时是**推翻了一条带真实理由的工程决策**（原注释明确写
"the simulation keeps pushing"），却没先验证那个理由是否成立。

## 已在代码里留下的防护

1. **中文注释**：`window-manager.js` 三处 `backgroundThrottling` 都有长注释说明为什么不能改
2. **自动测试**：`test/office-throttling-guard.test.js`（5 项）
   - office 的 `backgroundThrottling` 必须是 `false`
   - office 不能出现在任何 `setBackgroundThrottling` 循环里
   - 每个 `backgroundThrottling: false` 前面必须有中文说明
   - fps-monitor 的"不自动恢复"契约必须还在
3. **变异验证**：把 office 改成 `true`、或塞进节流循环，测试都会立刻红
