# 交接提示词：办公室化身 PNG 逐帧动画 + 行走系统

> 粘贴给在 **DshCockpit-s1 私有仓库** 中开发的另一个 AI 会话。先阅读 `docs/specs/S1-OFFICE-KICKOFF.md` 了解整体约束，本提示词只覆盖"化身从 SVG 切换为 PNG 逐帧 + 行走"这一增量任务。

---

## 1. 任务目标

把办公室视图中的化身从"占位 SVG 静态图"升级为"PNG 逐帧动画 + 可行走"。

具体：
1. 六态表情用 PNG 显示（替换现有 SVG）
2. 化身可在办公室内行走：4 方向 × 4 帧逐帧播放 + CSS transform 位移
3. idle 态保留现有 CSS 摸鱼动画（nap/blink/lunch keyframes 已实现）

## 2. 素材位置

所有 PNG 已生成好，透明背景，在仓库内：

```
photo/output_nobg/
├── edit-idle.png          ← idle 态
├── edit-working.png       ← working 态
├── edit-finished.png      ← finished 态
├── edit-warning.png       ← warning 态
├── edit-error.png         ← error 态
├── edit-offline.png       ← offline 态
├── edit-side-left.png      ← 左侧身（静止）
├── edit-side-right.png     ← 右侧身（静止）
├── edit-back.png           ← 背面（静止）
├── walk-down-01~04.png     ← 向下行走 4 帧
├── walk-up-01~04.png       ← 向上行走 4 帧
├── walk-left-01~04.png     ← 向左行走 4 帧
└── walk-right-01~04.png   ← 向右行走 4 帧
```

图片规格：2508×2508px，PNG RGBA 透明背景，每张约 3MB。

## 3. 需要改的代码

### 3.1 角色包素材迁移

把 PNG 放入角色包目录，替换现有 SVG：

```
resources/characters/whale-girl/assets/
├── expressions/
│   └── blue/          ← 把 SVG 替换为 PNG
│       ├── idle.png
│       ├── working.png
│       ├── finished.png
│       ├── warning.png
│       ├── error.png
│       └── offline.png
├── animations/
│   ├── walk-down-01~04.png
│   ├── walk-up-01~04.png
│   ├── walk-left-01~04.png
│   └── walk-right-01~04.png
└── manifest.json      ← 路径从 .svg 改为 .png
```

### 3.2 manifest.json 更新

把所有 expressions/animations 路径后缀从 `.svg` 改为 `.png`，新增 `walkAnimations` 字段：

```json
{
  "walkAnimations": {
    "down": ["assets/animations/walk-down-01.png", "...02.png", "...03.png", "...04.png"],
    "up": ["assets/animations/walk-up-01.png", ...],
    "left": ["assets/animations/walk-left-01.png", ...],
    "right": ["assets/animations/walk-right-01.png", ...]
  }
}
```

### 3.3 character-manager.js

- 加载逻辑从读 SVG 文件改为读 PNG 文件
- 新增 walk 帧序列加载与缓存

### 3.4 office-page.js

- 化身 `<img>` 的 `src` 从 SVG 改为 PNG 路径
- 新增行走逻辑：当 Agent 状态变为"移动中"时，按 8-12 FPS 切换 walk 帧序列 + CSS transform 位移
- 行走结束回到 idle 态

### 3.5 office.css

- 现有摸鱼动画（nap/blink/lunch keyframes）保持不变——它们作用于 `.avatar` 容器，PNG 用 `<img>` 也能用
- 新增 `.avatar.walking` 类：行走时禁用摸鱼动画，避免冲突
- 可选：walk 帧切换用 `background-position` spritesheet 优化（锦上添花，不做也行）

## 4. 行走动画规格

| 参数 | 值 |
|---|---|
| 帧率 | 10 FPS（每 100ms 切一帧） |
| 帧序列 | 每方向 4 帧，循环播放 |
| 位移速度 | 30-50 px/s（办公室内慢速行走） |
| 方向映射 | down→walk-down, up→walk-up, left→walk-left, right→walk-right |
| 停止条件 | 到达目标位置 → 切回 idle 态 + 对应表情 PNG |
| 摸鱼冲突 | 行走中禁用 nap/blink/lunch；停止后恢复 |

## 5. 硬性约束

- **C-1~C-8 不变**（见 S1-OFFICE-KICKOFF.md）
- 角色包 manifest 必须含 `license` + `author`（三层授权）
- **不碰已交付文件**（cost.js、boot-check.js、notification-center.js 等）
- PNG 文件只放入 `resources/characters/whale-girl/assets/`，不散放仓库其他位置
- `npm test` 全绿 + `node --check` 通过

## 6. 验收

1. 六态表情 PNG 在工位上正确显示（透明背景，无白边）
2. 化身行走时 4 帧逐帧播放流畅，方向正确
3. 行走停止后回到 idle 表情 + 摸鱼动画恢复
4. `npm test` 全绿
5. 汇报改动文件清单 + 已知限制

## 7. 图片预压缩（可选）

原图 2508×2508 偏大（3MB/张），建议裁切到实际需要尺寸（如 256×256）：
```bash
sips -Z 256 photo/output_nobg/edit-idle.png --out resources/characters/whale-girl/assets/expressions/blue/idle.png
```
工位头像只有 40-80px 显示，256px 足够。全量 25 张从 80MB 压到 < 2MB。

---

*PNG 逐帧动画交接 · 2026-08-28 · DshCockpit-s1 feature/s1-office*
