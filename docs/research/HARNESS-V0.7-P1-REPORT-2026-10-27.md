# HARNESS v0.7 P1 完成报告 —— 工作区、产物落地与工作台

日期：2026-10-27 · 计划：`docs/plans/active/HARNESS-V0.7-P1-PLAN-2026-10-27.md`
上位方向：`docs/product/WORK-FIRST-V0.7.md`（用户 2026-10-27 拍板"这个方向可以，可以开始了"）

## 0. 一句话

团队任务现在以**用户工作区里的真实文件**结束：产物写进 `<workspace>/.dsh/artifacts/`，
索引记录来源与 digest，工作台可打开/定位；**没有产物就不会显示"完成"**（机械门禁）。

## 1. 交付内容

| 工作包 | 内容 | 主要文件 |
|---|---|---|
| WP1 | 工作区与 Work Product 索引：原子写、路径边界、损坏 fail-closed、产物登记/读取 | `src/work/workspace-store.js` |
| WP2 | 工作项状态机（单活动任务、终态映射、无产物门禁、重启标注 interrupted） | `src/work/work-controller.js` |
| WP2 | 执行链壳侧钩子：`onArtifact` / `onStatus`（deps 注入，沙箱测试不引用模块状态） | `src/team-shell-transport.js`、`src/main.js` |
| WP2 | `shell:work` IPC（单一通道 + action；发送方必须是工作台页面） | `src/work/work-ipc.js` |
| WP3 | 工作台视图（第三主视图）：首跑选工作区、任务输入、历史、详情、产物查看器 | `src/work/work.{html,css,js}`、`work-preload.js`、`src/window-manager.js` |
| WP3 | 左栏第三入口 + 主题/语言跟随 + 中英双语文案 | `src/office-rail.html`、`office-rail-preload.js`、`src/i18n.js` |
| WP4 | 办公室座位级产物标记（闭集 kind + 计数，无 id/路径/内容） | `src/office/office-module.js`、`office-page.js`、`office.html`、`office.css` |
| — | 文档同步与偏差声明 | `docs/README.md`、`WORK-FIRST-V0.7.md`、`AGENTS.md` |

## 2. 数据流（P1）

```
用户目标（工作台）
  → workController.begin（索引落工作项）
  → startTeamRealWithTopic（deps: artifactDir=.dsh/artifacts, onArtifact, onStatus）
  → shell transport 物化 → onArtifact → workspace-store.registerArtifact（相对路径 + digest）
  → execution/artifact → controller → Team artifact/available
  → admin: office bridge → 座位产物计数（快照 artifacts.count/kinds）
  → workController.sync(teamState) → completed / incomplete（无产物）
  → work:update（150ms 去抖）→ 工作台渲染
```

隐私边界：内容只在文件里；索引只有工作区相对路径；Team fact / Office 快照只有闭集 token；
绝对路径只出现在 `shell:work` 状态（工作区展示）与 open/reveal 副作用中。

## 3. 验证

- 全量：**1853 pass / 0 fail**（含真机验收发现的两处修复）。
- 新增套件：`work-workspace-store`（10）、`work-controller`（11）、`work-ipc`（5）、
  `work-view-wiring`（12）、`work-e2e-offline`（2，真实 transport 全链路 + 阻塞场景）、
  `office-artifact-marker`（3）；transport 17（含真实 v3 journal 形状回归）。
- 离线端到端（`work-e2e-offline`）：真实 `team-shell-transport` + dsh 后端 + controller + Team，
  产物落盘、digest 可验、索引持久、工作项 completed、快照无正文/绝对路径。

### 3.1 变异矩阵（apply → 必红 → 还原 → 复绿）

| # | 变异 | 结果 |
|---|---|---|
| M1 | `registerArtifact` 不写盘 | DETECTED（新进程读不到） |
| M2 | 原子写改直写 | 未单独变异（rename 语义由"无 .tmp 残留 + 新进程可读"共同覆盖） |
| M3 | `resolveInside` 去掉词法守卫 | **MASKED**：第二道 containment 检查仍拦截；等价变异 M3'（`isSafeRelPath` 恒真）DETECTED |
| M3' | `isSafeRelPath` 恒真 | DETECTED |
| M4 | 无产物仍映射 completed | DETECTED |
| M5 | 快照泄漏绝对路径 | DETECTED |
| M6 | 读取不校验 digest | DETECTED |
| M7 | 发送方校验恒真 | DETECTED |
| M8 | 产物不挂到工作项 | DETECTED |
| M9 | 办公室产物不计数 | DETECTED |
| M10 | 办公室不校验 kind | DETECTED |

## 3.2 真机验收结果（2026-10-27，Electron 37.10.3 + 真实 dsh 0.1.5-rc.2）

**第一轮：发现两处真实缺陷（都已修复并有回归测试）**

1. **assistant 正文形状不匹配**：真实 dsh v3 journal 是 `data.message.content`，离线 fixture 是
   `data.content`。只认后者 → 每条真实正文都被静默丢弃 → materializer 拒绝伪造产物 →
   `HANDOFF_INCOMPLETE`。修复：`assistantTextOf` 两种形状都接受（`src/team-shell-transport.js`）。
2. **handoff 阻塞不可观测 + 驱动循环挂死**：缺产物时 reviewer 保持 pending，`readyRoles()` 不再返回它，
   Team 不产生任何命令；驱动循环却阻塞在已完成会话的 `pumpOne()` 上，工作项永远 `running`。
   修复：controller 从 Team state 计算 `blocked`（`HANDOFF_INCOMPLETE` + 角色，不伪造 Team 事实）；
   驱动循环在 `dispatchReady` 之后、阻塞等待之前检查终态/attention/blocked；工作台呈现为
   「需要你处理 + 原因码」，取消 = 显式放弃（`abandoned`，Team 事实保持原样）。

**第二轮（修复后）通过**

| 验收项 | 结果 |
|---|---|
| 新建工作区（UI 引导） | ✅ `~/DshWorkspaces/acceptance-2026-10-27`，只建 `.dsh/` |
| 真实团队任务完成 | ✅ 状态 completed，产出 **2** 个产物：research-notes 2170 B + review-findings 98 273 B |
| 产物落盘 + digest | ✅ 文件在 `<ws>/.dsh/artifacts/<jobId>/`，sha256 与索引一致 |
| 重启恢复 | ✅ 上次未完成项显示「已中断」；工作区与历史仍在 |
| 首跑时长 | ✅ 约 5 分钟（两轮模型调用） |
| 无产物门禁 | ✅（离线 E2E 覆盖；真机缺失路径由第一轮复现） |

**附带发现（P2 必须先解决）**：dsh 会话的 cwd 是用户主目录（本轮 `/Users/xia`），模型的工具
写了一个 `/Users/xia/research-notes/harness-engineering.md` —— **工作区之外的写入不受壳控制**。
在给 worker 打开写工具之前，必须把会话 cwd/沙箱钉到工作区（P2 的第一件事）。

## 3.3 P1.5（同日）：工作坞并入办公室 + 角色悬停卡

用户拍板：不再让工作台和办公室争夺整屏。落地：

- **工作坞**：办公室右侧 380px 壳视图（`work.html?compact=1`），任务/产物/证据在办公室视线内；
  「展开全屏」切到原工作台（同一 `shell:work` 状态）。
- **右栏收编**：`body.docked` 下办公室自有右栏隐藏，`待你处理` 变成左上浮动卡（仅 pending>0 时出现）；
  员工列表/详情/用量/时间线让位（后续按需进坞或折叠）。
- **悬停卡**：复用 `renderer.hitTest` 的 `pointermove` 命中；命中即通过
  `shell:office-present` 让该员工暂停移动并转正面（模块 `setPresenting`，纯呈现、无事实）；
  卡片刻度只来自快照（姓名/状态/动作/任务#/产物数/今日完成），点击钉住、Esc 关闭。
- **边界**：`office:*` 仍 8 个；新增 `shell:office-present` / `shell:office-layout`（壳命名空间）。

CDP 真机验证（Electron 37）：坞出现在右侧；办公室画布重排到 1046px；悬停后 `presenting=true`、
`facing=down`、位置 2 秒不变；钉住后移开卡片仍在；Esc 后 `presenting=false`；展开全屏/返回办公室均正常。

**真机修掉的三处**：① 隐藏右栏不触发 window resize → canvas 不重排（加 ResizeObserver）；
② 实例上没有 `EMPLOYEE_IDS` → 白名单恒空（取模块常量）；③ 聊天伙伴的决策会改写呈现中员工的朝向。

## 4. 真机验收脚本（已按上表执行；保留给后续回归）

```bash
cd <repo> && npm start
# 1) 左栏第三个图标 → 工作台；首次进入应看到"先选一个工作区"
# 2) 新建工作区 demo（或打开一个已有项目）→ 顶部显示工作区名与路径
# 3) 输入一句话目标 → 开始
# 4) 观察：阶段短语变化；完成后任务状态=已完成
# 5) 产物列表出现"研究笔记" → 点击 → 右侧显示正文
# 6) "在文件夹中显示" → 确认 <workspace>/.dsh/artifacts/<jobId>/research-notes.md 真实存在
# 7) 重启应用 → 工作台仍能看到该任务与产物
# 8) 失败路径：让 runtime 离线再开始 → 任务应显示失败/未产出，绝不显示完成
```

回填项：首跑是否 ≤5 分钟；产物是否可打开；阶段短语是否与动作相符；办公室座位是否出现"产出 N"。

## 5. 已知缺口（如实声明）

1. **worker 没有工作区写工具**（P2）：所以 P1 的产物是笔记/评审文本落到工作区 `.dsh/`，
   还不是"改代码/生成报告到用户目录"。`report` / `workspace-patch` / `workspace-files`
   与受信 diff 捕获随 P2 的工具循环一起做。
2. **单活动任务**：P1 一次只跑一条链；排队/并行需要文件级写锁（P2）。
3. **重启不续跑**：遗留 running/attention 项在工作台标为"已中断"；自动恢复属 P5 持久化。
4. **办公室只有计数标记**：缩略图/桌面摆件属于 P3 视觉重构。
5. **工作台不是默认视图**：P1 保持 harness 为默认，实测后再决定是否切换默认。
6. 真机验收已执行（2026-10-27，见 §3.2）；仍需在 Windows 上回归一次（路径/字体/焦点）。

## 6. 下一步

P2：worker 工具集（读写/命令/沙箱）+ Verification Runner + 受控 retry + 工作区 diff 捕获。
在此之前先做一次 dsh 会话的 cwd/工具权限探针（决定"工作区"能否真正成为执行根）。
