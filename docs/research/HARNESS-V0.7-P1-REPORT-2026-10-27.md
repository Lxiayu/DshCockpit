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

- 全量：**1846 pass / 0 fail**。
- 新增套件：`work-workspace-store`（10）、`work-controller`（9）、`work-ipc`（5）、
  `work-view-wiring`（9）、`work-e2e-offline`（1，真实 transport 全链路）、
  `office-artifact-marker`（3）。
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

## 4. 真机验收脚本（**未执行**，需有显示环境）

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
6. **真机未验收**：上述脚本未执行（无显示环境）；GUI 行为只有源级接线测试覆盖。

## 6. 下一步

P2：worker 工具集（读写/命令/沙箱）+ Verification Runner + 受控 retry + 工作区 diff 捕获。
在此之前先做一次 dsh 会话的 cwd/工具权限探针（决定"工作区"能否真正成为执行根）。
