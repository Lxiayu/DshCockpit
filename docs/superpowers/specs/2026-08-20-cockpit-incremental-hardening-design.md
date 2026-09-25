# DshCockpit Cockpit 增量完善设计

## 背景与目标

上一轮已经建立独立 Electron Cockpit overlay，并让 Harness 保持原生工作区。本轮不重写该架构，只补齐可发现性、职责分离、稳定接口和旧实现清理。

目标是让 Control Center 只承担状态与即时操作，让 Settings 只承担持久配置，同时保证已有 Runtime、Remote、Channels、Tasks、Quick Ask、Cost、插件、技能和长会话能力不回归。

## 已确认范围

本轮包含：

- Control Center 与 Settings 的页面职责拆分，清理重复入口和空导航分组。
- Task Peek：从 Cockpit 先查看任务状态，再选择新建或进入完整任务管理。
- Onboarding 使用真实 Rail，并高亮真实 Token/Cockpit 控件。
- `/compact` 从 Harness DOM 注入迁移到 Harness RPC。
- Runtime 生命周期状态统一更新和广播。
- Settings 增加 Quick Ask 全局快捷键配置。
- 将 `website/public/img/logo.jpg` 复制为 DshCockpit 自有资源，并用于 Cockpit 品牌入口。
- 删除旧 `chrome:*` IPC、DOM compact 触发、废弃 `tokenWidget` 设置和过时文档。

本轮不包含：

- 不做此前清单中的第 4 项扩展验证工作；不扩大 resize、fullscreen、multi-monitor 的实现范围。已有 overlay 定位行为与现有测试必须保持。
- 不增加 DeepSeek API Key 配置。
- 不制作额外浏览器视觉 mockup。
- 不修改 Harness DOM、CSS、React 组件、Sidebar、Toolbar 或页面布局。
- 不拆写或重写整个 `settings.html`，只做与职责隔离直接相关的局部结构调整。

## 信息架构

### 入口职责

| 能力 | Control Center | Settings |
|---|---|---|
| Cost | 今日/月度用量、预算状态、官方余额和刷新等查看动作 | 费率、峰谷时段和月度预算等持久配置；使用同一 Cost 页面但只显示 Settings scope |
| Tasks | 运行、计划、完成、失败状态；新建、运行、编辑和历史 | 不显示 |
| Runtime | Healthy/Starting/Restarting/Offline、版本、重启、检查/应用更新和回滚等即时操作 | workspace、DSH_HOME、端口、Node/dsh 路径、context window，以及更新通道、registry、保留版本数等持久配置 |
| Remote | 当前服务状态、配对码、已连接设备、撤销设备、Tailscale/Cloudflare 启停和访问链接 | 是否启用、监听端口、HTTP 兼容性及其他安全/连接配置 |
| Channels | 在线状态、连接测试和必要的启停操作 | allowlist、凭据、接入参数和接入指南 |
| Plugins/Skills | 发现、安装、卸载、启停等管理动作 | 不显示 |
| General/Models/Data/Update/About | 不显示 | 只在 Settings 显示 |

`cost`、`runtime`、`remote` 和 `channels` 可继续复用一个 HTML 页面和同一组 IPC，但页面内部必须使用明确的 mode-scoped sections。Control 模式不得显示持久配置表单；Settings 模式不得显示配对、撤销、隧道启停、Runtime 重启/更新等即时操作。现有 Update 页中的持久更新策略留在 Settings；检查、应用、回滚和安装进度迁移到 Control Runtime，不能在两个入口重复显示。

页面路由仍使用经过白名单验证的 `mode` 和 `page`。切换入口时先应用 mode，再渲染该 mode 对应的 section，防止旧页面状态短暂闪现。已有未保存表单确认继续生效，用户取消时保留当前 mode、page 和表单数据。

### 导航分组

每个 `.group-label` 与其后、下一个 group label 之前的 nav items 构成一个分组。模式过滤和搜索过滤完成后，如果组内没有可见 nav item，则隐藏 group label；只要有一个可见 item 就显示。

这条规则同时覆盖 Control 和 Settings，解决 Control Center 底部出现空“系统”分组的问题。分组可见性不能依赖硬编码组名，以免后续增加或移动页面后再次产生空标题。

## Task Peek

Cockpit Panel 的 Tasks 动作不再直接打开 960x720 Control Center，而是把 overlay 切换到 `taskPeek`。

Task Peek 显示：

- Running、Scheduled、Completed、Failed 数量。
- 任务列表中的状态、`nextRunAt` 和最近运行信息；没有下次运行时显示短占位，不伪造时间。
- `New Task`：打开 Control Center 的 Tasks 页面，并立即打开现有新建任务 dialog。
- `Manage All`：打开完整 Tasks 页面，不自动打开 dialog。

快照已有的 `nextRunAt`、`lastRunAt` 必须进入 renderer；状态排序沿用现有快照契约。New Task 使用显式受限 IPC 意图，不通过 renderer 拼接脚本，也不创建第二套任务编辑逻辑。打开完整页面后，overlay 回到 Rail；从 Control Center 返回时恢复 Cockpit Panel，而不是恢复过期的 Task Peek。

## Onboarding 与品牌

Onboarding 不再用替代性示意控件遮住 Rail：

1. 显示真实 Rail，高亮真实 Token 控件并介绍 Context Monitor。
2. 高亮带 DshCockpit Logo 的真实 Cockpit 按钮，介绍 Quick Ask、Tasks、Cost 和 Runtime。
3. 清除高亮并进入 Harness。

Onboarding 期间真实 Rail 只作为视觉锚点，不执行页面导航，避免步骤状态与正常交互冲突。一次性标记继续使用 `cockpitOnboarded`。

Logo 来源为 `website/public/img/logo.jpg`。复制到应用自己的 renderer 可加载资源目录；网站源文件保持不变。打包配置或 app.asar 文件规则必须包含这份副本，开发态和打包态都从 DshCockpit 自有路径读取。

## DOM-free Compact RPC

删除 `src/compact.js` 中的 selector table、注入脚本和 `executeJavaScript` 提交逻辑，只保留 compaction 日志追踪、历史和节省估算。

Compact 动作流程：

1. `POST /api/session.list`，使用 Harness 的 `client-request` RPC envelope。
2. 从返回 items 中选择 `blank !== true` 的最近更新会话；优先最近 `updatedAt`，不依赖 Harness 当前路由或 DOM。
3. `POST /api/commands/execute` 执行 `/compact`。
4. rc.8 发送 `{ agentId, line: '/compact', images: [] }`；rc.7 发送 `{ agentId, line: '/compact' }`。若版本未知，只在服务端明确返回参数形状错误时尝试另一种形状，不对网络、权限或业务错误盲目重试。
5. UI 文案明确说明压缩的是最近活动的非空会话；无会话、会话运行中、RPC 拒绝和网络失败都返回可读错误。

所有请求使用当前 Runtime URL，不允许 renderer 传入任意 URL、session id 或命令文本。RPC id 由主进程生成，响应必须校验 HTTP 状态和 RPC 错误结构。

## Runtime 状态

主进程提供单一 `setRuntimeState(nextState)` 入口，负责：

- 更新 `starting|healthy|restarting|offline` 状态。
- 失效 Cockpit snapshot cache。
- 向 Cockpit 和其他已有订阅者广播新快照。

所有生命周期路径都必须使用该入口：首次启动、手动重启、health 成功、health 失败、spawn 失败、子进程提前退出、自动重启等待、crash-loop 停止。单次 health 抖动只有在现有健康策略判定 Runtime 不可用后才进入 `offline`，不新增更激进的重启策略。

Runtime 重启不清空 Tasks、Remote 或其他独立 section；各 section 独立降级，任何一个快照源失败不能导致整个 Cockpit 白屏。

## Quick Ask 快捷键

Settings 的 General 页面增加 Quick Ask 快捷键选择，使用有限预设加 Disabled，避免让无效自由文本进入 `globalShortcut`：

- `CommandOrControl+Alt+Space`（默认）
- `CommandOrControl+Shift+Space`
- `Alt+Space`
- Disabled

切换时先尝试注册新 accelerator。注册成功后才注销旧 accelerator并持久化；失败则保留旧快捷键和设置值并显示错误。切换到 Disabled 时注销当前快捷键并保存禁用状态。主进程只跟踪一个已注册 accelerator，退出时只注销该 accelerator，避免新旧快捷键同时存在。

## 旧内容清理

在新路径有等价能力并通过测试后删除：

- `chrome:set-workspace`、`chrome:compact-now` 等旧 Harness chrome IPC。
- Harness preload 中与旧 chrome/DOM 注入相关的桥接。
- `src/compact.js` 的 Harness DOM selector 和注入 helpers，以及对应测试。
- `settings-store` 中废弃的 `tokenWidget` 和相关旧命名/迁移残留。
- README、README.en 和 FEATURES 中关于 hover capsule、in-window chrome、右键 compact 等旧描述。

清理不删除 compaction tracker/history、workspace 选择、Quick Ask、scheduler、Remote 或 Channels 的业务实现。删除前必须通过代码搜索确认没有仍在使用的调用方。

## 错误处理与状态一致性

- Control 操作采用按钮级 pending 状态，禁止重复提交；失败后恢复按钮并保留服务端返回前的已知状态，随后主动刷新真实状态。
- Settings 保存只在主进程验证和持久化成功后更新已保存基线；失败保留用户输入并继续标记为 dirty。
- mode 切换时不复用另一个 mode 的临时表单状态；取消未保存确认则整个导航事务不发生。
- 快捷键注册、RPC compact、Remote 配对/隧道、Runtime 重启都返回结构化 `{ ok, code, reason }`，renderer 只显示受控文案，不渲染任意 HTML 错误。
- Cockpit snapshot section 独立失败，使用已有安全降级值；状态恢复后下一次 push 覆盖降级值。

## 测试与验收

按测试优先实施，每项先写会因缺失行为而失败的测试，再做最小实现。

自动化覆盖：

- mode-scoped section：Control/Settings 在 Runtime、Remote、Channels 中显示互斥职责；页面白名单不变。
- 导航分组：模式过滤和搜索后没有可见 item 的 group label 自动隐藏，空“系统”不再出现。
- Task Peek：状态/时间渲染、New Task 和 Manage All 意图、返回 Panel 状态。
- Onboarding：真实 Rail 可见、真实 Token/Cockpit 高亮、按钮在 onboarding 中不导航。
- Compact RPC：session 选择、rc.7/rc.8 payload、仅参数形状错误回退、网络/业务错误不重试、无 DOM selector。
- Runtime：health/spawn/exit/crash-loop 各路径状态和 snapshot 广播。
- Quick Ask shortcut：新注册失败保留旧值，成功后只留一个，Disabled 注销，重启恢复。
- 静态门禁：Harness renderer/preload 不出现 DOM 注入；旧 `chrome:*`、`tokenWidget` 和文档术语消失。
- Logo：DshCockpit 自有副本存在且 Cockpit 引用该副本，构建文件包含资源。

回归验证运行完整 `npm test` 和构建/语法检查。与本轮排除的第 4 项相关的真实多显示器、全屏设备矩阵不新增执行，但现有 bounds 单元测试不得回归。已知由受限环境导致的 localhost `EPERM` 测试必须与真实产品失败区分并如实报告。

## 完成标准

- Control Center 不再出现空“系统”分组。
- 手机远程、Runtime、Channels 从 Control 与 Settings 进入时呈现不同且不冲突的职责。
- Tasks 可先 Peek，并可顺畅进入新建或完整管理。
- Onboarding 指向真实产品入口，Cockpit 使用自有 Logo 资源。
- Compact 完全不依赖 Harness DOM。
- Runtime 异常和恢复状态能及时反映到 Cockpit。
- Quick Ask 快捷键可配置且不存在重复注册。
- 等价迁移后的旧 UI、IPC、设置键、测试和文档残留已清理。
- Harness 原生工作区和现有核心功能保持不变。
