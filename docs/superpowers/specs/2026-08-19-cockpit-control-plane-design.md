# DshCockpit Control Plane UI/UX 重构设计

## 目标

把 DshCockpit 从“给 Harness WebUI 加壳”升级为独立的桌面控制层：Harness 保持原生工作区和 DOM 完整性，DshCockpit 通过独立 overlay 提供 Token、Runtime、Automation、Cost、Quick Ask、Search、Remote 和 Settings 能力。

产品原则：

> Harness owns the workspace. DshCockpit owns the operating layer.
>
> Invisible when working. Obvious when needed.

## 范围与非目标

本次范围：

- 将现有 Harness 内注入式 Token/Settings chrome 替换为独立 Electron 子窗口。
- 新增 Edge Rail、Token Peek、Cockpit Panel 和一次性 onboarding。
- 让 Cockpit 成为 Quick Ask、Tasks、Cost、Runtime、Search、Remote 和 Integrations 的显性入口。
- 复用现有 `settings.html` 功能页，通过 `mode=control` 与 `mode=settings` 深链建立渐进迁移。
- 修复 Quick Ask 和 Tasks 的关闭、返回、焦点和未保存交互。
- 保持现有 Runtime、cost、scheduler、search、remote 和 settings IPC 契约可用。

非目标：

- 不修改 Harness DOM、CSS、React 组件、Sidebar、Toolbar 或页面布局。
- 不把 DshCockpit 功能注入 Harness 页面。
- 不在本次把数千行 Settings 页面物理拆成多个 renderer。
- 不重写 Quick Ask 后台 headless 执行和 scheduler 业务逻辑。

## 当前上下文与根因

当前 [src/preload.js](/Users/xia/program/dsh/DshCockpit/src/preload.js) 在 Harness renderer 中执行 `document.body.appendChild`，并通过 `header`、`role=toolbar` 和 class 名称扫描位置。该实现依赖 Harness UI 内部结构，无法抵抗前端重构。

Quick Ask 创建为 `frame: false` 的无边框窗口，但 [src/quickask.html](/Users/xia/program/dsh/DshCockpit/src/quickask.html) 只有 Escape 关闭路径，没有可见关闭按钮。Tasks 当前依赖 Settings 窗口系统标题栏，任务编辑 dialog 只有取消按钮；Control 入口不能继续依赖系统标题栏，因此需要显式的页面返回/关闭路径。

## 架构

### 窗口层级

```text
Electron main process
|
|- mainWindow: 原生 Harness WebUI（直接 loadURL，无 DshCockpit UI 注入）
|
|- cockpitWindow: 无边框、透明/半透明、skipTaskbar 的独立 shell renderer
|    |- Rail
|    |- Token Peek
|    |- Cockpit Panel
|    `- Onboarding
|
|- quickAskWindow: 现有独立 Quick Ask renderer（修复关闭与焦点）
|- searchWindow: 现有独立 Session Search renderer
`- settingsWindow: 现有 Settings renderer（mode=settings/control）
```

`cockpitWindow` 由主进程创建和定位，默认仅覆盖主窗口右上角极小区域。它不是 Harness 的 child DOM，也不通过 Harness webContents 注入 UI。主窗口只保留运行时 URL、窗口状态和原生菜单职责。

具体窗口策略：

- `cockpitWindow` 使用 `parent: mainWindow`、`modal: false`、`frame: false`、`transparent: true`、`skipTaskbar: true`、`resizable: false`、`fullscreenable: false`、`focusable: true`。
- 不启用全局 `alwaysOnTop`。父子 ownership 只保证 Cockpit 位于 Harness 之上，不覆盖其他应用；主窗口失去前台层级后 Cockpit 随父窗口落到其他应用后方。
- Rail 用 `showInactive()` 恢复，避免抢走 Harness 输入焦点；只有用户点击 Token/Cockpit 或键盘导航时 Cockpit 才获取焦点。
- Cockpit 自身 `blur` 时，Peek/Panel 回到 Rail，但 Rail 保持显示；点击 Harness 因而只会收起复杂度，不会隐藏产品入口。
- 主窗口 minimize/hide/close 时 Cockpit 同步 hide；show/restore 时重新计算 bounds 后 `showInactive()`。
- 进入/离开 fullscreen 时先隐藏 Cockpit，待 Electron 对应事件触发后重新计算父窗口 content bounds 并显示。Cockpit 本身永不进入 fullscreen。

### Cockpit 窗口状态

```text
rail -> tokenPeek -> rail
rail -> cockpitPanel -> rail
rail -> onboarding(step 1..3) -> rail
cockpitPanel -> settings/control page (open separate window)
cockpitPanel -> quickAsk/search (open separate window, then collapse)
```

- Token Peek 与 Cockpit Panel 互斥。
- `Esc`、窗口失焦或显式关闭回到 Rail；onboarding 期间失焦不自动关闭。
- Cockpit 子窗口不保存绝对坐标，只保存 onboarding 完成标记；重新计算位置可适应多显示器和 DPI。

### 窗口定位

新增纯函数模块负责计算 bounds：

```js
computeCockpitBounds(mainBounds, displayWorkArea, mode, viewport)
```

输入是主窗口 bounds、匹配显示器 work area、Rail/Peek/Panel/Onboarding 模式和最小边距；输出始终保证窗口至少完整落在当前 work area 内。主进程在以下事件后 debounce 调用：`move`、`resize`、`maximize`、`unmaximize`、`enter-full-screen`、`leave-full-screen`、`show`、`restore`。主窗口隐藏、最小化或关闭时隐藏 cockpitWindow；恢复后重新定位并显示。

### 渐进迁移路由

`settings.html` 读取 URL query/hash：

- `mode=control`: 显示 Control Center 语义和控制导航，允许 `cost`、`tasks`、`runtime`、`remote`、`plugins`、`skills`、`channels`、`longsession`。
- `mode=settings`: 显示 Configuration Center 语义和配置导航，允许 `general`、`models`、`runtime`、`remote`、`channels`、`data`、`update`、`about`。

同一页同时含状态和配置的模块（Runtime、Remote、Channels）在过渡期允许两个模式访问，但入口文案和返回路径根据模式变化。Settings 不再承担所有功能的默认入口；关键功能首选从 Cockpit 进入。

全局只保留一个 `settingsWindow`。`openCenter(mode, page)` 先校验 mode/page 白名单：

- 窗口不存在时，用对应 query/hash 创建并显示。
- 窗口已存在时，不创建第二个窗口；显示并聚焦现有窗口，然后发送 `center:navigate`。renderer 在未保存表单确认后更新 mode、导航过滤和 hash；用户取消确认则保留当前页面。
- Control mode 顶部同时提供“返回 Cockpit”和“关闭”两个 icon button。返回操作关闭 center window、聚焦 `mainWindow` 并重新展开 Cockpit Panel；关闭操作只关闭 center window并回到 Harness。
- Settings mode 使用系统窗口关闭和内容区关闭按钮，不显示“返回 Cockpit”，避免把配置中心伪装成 Feature Hub。

## 默认 UI

### Rail

右上角只显示三个入口：

```text
[ 18.2k  29% ] [ Cockpit ] [ Settings ]
```

Token 文案同时包含格式化 token 与 context pressure。压力等级：0-59% 正常、60-84% 弱警告、85%+ 高风险；不使用持续闪烁或强报警动画。

Rail 只使用共享 `theme.css` token，尺寸固定，文本在窄窗口下可缩短为 `29%` 或 icon+tooltip，不改变布局高度。

### Token Peek

显示：Context 总量、压力进度条、Input、Output、Cached、当前会话/总会话。数据缺失时显示 `—` 和短状态，不跳转完整页面。Peek 的面板宽度和高度稳定，窗口不足时纵向滚动而不压缩 Harness。现有 token pill 的“压缩当前会话”动作迁移到 Peek 底部的显式 Compact action。

### Cockpit Panel

首屏顺序：

1. `SYSTEM`: Runtime Healthy/Starting/Restarting/Offline、版本。
2. `USAGE`: 当前 tokens、context pressure、今日 cost。
3. `AUTOMATION`: Running、Scheduled、Failed，以及最多三条任务摘要。
4. `QUICK ACTIONS`: Quick Ask、Tasks、Session Search、Cost Center、Runtime、Remote、Integrations。

面板是信息密集的控制工具，不使用大 Dashboard 卡片堆叠，不长期占据 Harness 内容区域。面板关闭按钮位于面板标题栏，动作按钮使用图标与短文本，并提供 tooltip/aria-label。

## Onboarding

在 Runtime ready 且 Harness 主窗口可见后触发一次。状态写入设置键 `cockpitOnboarded`，不重复显示。

1. Welcome：`Harness is ready. Your cockpit is here.`，标示 Token/context monitor。
2. Cockpit：展示 Quick Ask、Tasks、Cost、Runtime 四项桌面能力。
3. Ready：显示 Quick Ask global hotkey，提供进入 Harness 操作。

整个流程控制在 20-30 秒内，不阻塞 Harness，不修改 Harness 页面，不要求用户填写配置。

- 完成第三步或显式 Skip 都写入 `cockpitOnboarded: true`，以后不再显示。
- Escape/窗口关闭属于临时退出，不写完成标记；只写进程内 `onboardingDismissedThisRun`，本次运行不再打扰，下次启动重新展示。
- Runtime 在 onboarding 中重启时保持当前步骤并显示 Starting；主窗口隐藏/最小化时暂时隐藏，恢复后继续当前步骤。

## IPC 与数据流

新增 `cockpit-preload.js`，仅暴露明确 API：

```js
getSnapshot()
onSnapshot(callback)
onTheme(callback)
setOnboardingComplete()
openQuickAsk()
openSearch()
openControlPage(page)
openSettings()
setWorkspaceFromFile(file)
compactNow()
close()
```

主进程新增 `cockpit:get-snapshot` 和显式 action handlers。禁止 renderer 传入任意路径、URL、shell 命令或未列入白名单的 page。

快照结构（所有 token 数量单位为 token，成本单位由 `currency` 指定，时间为 epoch milliseconds）：

```js
{
  runtime: {
    state: 'healthy|starting|restarting|offline',
    version: string|null,
    activeVersion: string|null
  },
  usage: null|{
    current: null|{ input: number, output: number, cacheRead: number, cacheWrite: number },
    totals: { input: number, output: number, cacheRead: number, cacheWrite: number },
    contextWindow: number,
    pressureTokens: number,
    pressurePct: number,
    sessionCount: number
  },
  cost: null|{
    today: { cost: number, input: number, output: number, cacheRead: number, cacheWrite: number, sessions: number },
    month: { cost: number, input: number, output: number, cacheRead: number, cacheWrite: number, sessions: number },
    currency: string,
    budget: number,
    budgetStatus: 'ok|warn|exceed|disabled'
  },
  automation: {
    running: number,
    scheduled: number,
    failed: number,
    items: Array<{
      id: string,
      name: string,
      state: 'running|scheduled|completed|failed|disabled',
      nextRunAt: number|null,
      lastRunAt: number|null
    }>
  },
  remote: { enabled: boolean, running: boolean, publicMode: 'lan|tailscale|cloudflare' },
  shell: {
    version: string,
    language: 'zh|en',
    theme: 'dark|light',
    needsSetup: boolean,
    onboardingComplete: boolean
  }
}
```

所有 `nextRunAt` 和 `lastRunAt` 都是 epoch milliseconds；现有 scheduler/history 中的 ISO 字符串只在主进程聚合快照时转换。`automation.items` 排序为 running 优先，其次按 `nextRunAt` 升序，再按 name；最多返回三项。`failed` 是最近 24 小时内最新一次执行失败的 distinct task 数量。

单个任务的状态优先级固定为：

1. `running`: task id 在 `scheduledRunning` 集合中。
2. `failed`: 最近 24 小时内最新一次历史记录为 `ok === false`。
3. `scheduled`: `enabled === true` 且存在未来 `nextRunAt`。
4. `completed`: 最新历史记录成功且当前没有可执行的 next run。
5. `disabled`: 未启用且没有成功完成记录。

因此一个刚失败但已被 scheduler 重新计算 next run 的任务仍显示 `failed`，直到下一次成功或超过 24 小时；运行中始终覆盖其他状态。没有任务时返回零值和空数组，不返回 null。

各 section 独立捕获异常：usage/cost 失败返回 null；automation 失败返回零值和空数组；remote 失败返回 `{ enabled:false, running:false, publicMode:'lan' }`；runtime 无 child process 且无 URL 时返回 offline。主动重启从发出命令到新 runtime URL health check 成功期间使用 `restarting`，首次启动使用 `starting`。Panel 将 `restarting` 显示为独立的“Restarting/重启中”状态，不映射为 Starting。任何 section 失败都不能导致整个 Cockpit 白屏。

### 旧 Chrome 行为迁移

移除 Harness preload UI 时保留两个现有操作：

- Folder drop 切换 workspace：迁移到 Cockpit Rail/Panel 的 drop target。`cockpit-preload.js` 内部调用 `webUtils.getPathForFile(file)`，只向 renderer 暴露 `setWorkspaceFromFile(file)`，再把解析后的路径送入主进程白名单 IPC；主进程继续执行现有路径/目录校验，renderer 不接收或传入任意系统路径。
- Compact current session：通过 `cockpit-preload.js` 显式暴露 `compactNow()`，调用现有 compact 主进程逻辑并显示 running/success/failure 状态。

原 `chrome:set-workspace`、`chrome:compact-now` 在迁移完成后可作为兼容 IPC 暂留一个版本，但 Harness renderer 不再调用它们。

## Quick Ask 与 Tasks 修复

### Quick Ask

- 在无边框窗口内增加显式 icon close button，按钮有 tooltip 和 aria-label。
- 保留 Escape；窗口显示后焦点进入 textarea，关闭按钮可通过 Tab 到达。
- 失焦关闭只适用于尚未提交的 palette 状态；提交后即使窗口隐藏，headless 任务继续运行并发送通知。
- 运行状态下关闭按钮文案保持“关闭窗口”，不暗示取消后台任务。
- 成功、失败和空结果状态都保留可读反馈；重新打开窗口不会复用已提交的 prompt。

### Tasks

- Control mode 页面标题栏增加返回 Cockpit/关闭入口，不依赖系统标题栏。
- 新建/编辑任务 dialog 增加标题栏关闭按钮，支持取消、Escape 和遮罩关闭。
- 有未保存字段时关闭触发轻量确认；取消和确认逻辑不影响已保存任务。
- 保存失败时 dialog 不静默消失，保留表单并显示错误；成功保存后刷新任务列表。
- Tasks 页面显示 Running、Scheduled、Completed、Next Run、Failed 状态；刷新和 scheduler push 不丢失当前 tab。

## 视觉与可访问性

- Harness 维持绝对主视觉；Cockpit 使用低对比、细边框、单一强调色和有限语义色。
- 不使用渐变、装饰 orb、大面积紫色、长期固定 Sidebar 或嵌套卡片。
- 所有固定格式元素使用稳定尺寸，长中文/英文通过换行或省略处理，不发生重叠。
- 所有 icon-only button 提供 tooltip、`aria-label` 和键盘焦点环。
- `prefers-reduced-motion` 下关闭面板位移动画和压力动画。

## 测试与验收

### 单元测试

- `computeCockpitBounds` 覆盖单屏、负坐标副屏、超小主窗口、最大化和 fullscreen work area。
- 快照压力等级、缺失/失败 section 降级、runtime restarting 状态。
- onboarding 标记只写入一次；control/settings 路由白名单拒绝未知 page。
- 单一 center window 的 mode/page 复用、未保存导航取消、返回 Cockpit 状态转换。
- Workspace folder drop 与 Token Peek Compact 仍路由到现有主进程能力。
- 静态检查确保 Harness preload 不再注入 DshCockpit DOM，也不存在 Harness selector/class/testid 依赖。

### Renderer 测试

- Rail 显示 Token/Cockpit/Settings 三入口。
- Token 点击打开 Peek，Cockpit 点击打开 Panel，Esc/失焦回到 Rail。
- Panel actions 调用正确的显式 bridge API。
- Quick Ask 关闭按钮、Escape、失焦和提交后隐藏路径。
- Tasks 页面/编辑 dialog 的 close、cancel、Escape、未保存确认和保存失败保留表单。
- 中英文、深浅主题、窄 viewport、长文本不重叠。

### Electron 验收

- Harness DOM/结构快照与启用 Cockpit 前一致（只允许独立窗口存在）。
- 主窗口 move/resize/maximize/fullscreen/minimize/restore 后 overlay 正常锚定。
- 主窗口移动到另一显示器后 overlay 不漂移；恢复显示时重新匹配 work area。
- Runtime 更新、重启、崩溃恢复期间 Cockpit 状态正确切换，不白屏、不丢入口。
- Quick Ask 后台运行期间关闭 UI 仍能完成通知；Tasks 的 scheduler 运行和列表推送不回归。

## 兼容性检查

代码审查门禁：DshCockpit renderer 不读取 Harness webContents 的 DOM、URL 路由或内部状态；所有跨边界数据来自 IPC、已有 runtime HTTP/WebSocket、filesystem 或主进程业务模块。未来 Harness 修改 DOM、CSS、React、Sidebar、Toolbar 或路由时，Cockpit UI 不需要同步修改。
