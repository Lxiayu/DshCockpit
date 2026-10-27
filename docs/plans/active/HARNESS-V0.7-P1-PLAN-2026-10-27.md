# HARNESS v0.7 P1 —— 工作区、产物落地与工作台（实施计划）

状态：**已开工**（方向由用户 2026-10-27 拍板；"这个方向可以，可以开始了"）
上位文档：`docs/product/WORK-FIRST-V0.7.md`（Work Product 模型与 P1 范围）
日期：2026-10-27

## 0. 一句话

让"团队完成一次任务"以**用户工作区里的真实文件 + 可打开的证据**结束，而不是以一条状态线结束；
工作台成为主交互面，办公室继续只做投影。

## 1. 与上位文档的偏差（先声明，避免悄悄改范围）

| 上位文档 P1 | 本计划 | 理由 |
|---|---|---|
| Artifact kinds 扩 `report` / `workspace-patch` / `workspace-files` | **推迟到 P2**，P1 只用现有 `research-notes` / `review-findings` | 这三类需要 worker 的工作区写能力与受信 diff 捕获（P2）。没有真实生产者就加 kind，等于制造"看起来完整"的事件——本项目明令禁止 |
| 任务板（多任务） | P1 = **单活动任务 + 历史列表**；并行/排队 P2 | 一次只跑一条链，先把"产物可信"做对；并行写冲突属于 P2 |
| 桌面显示产物缩略 | P1 = 座位级**产物标记**（kind 图标/计数）；缩略渲染 P3 | 缩略图需要场景渲染与素材管线，P3 视觉重构一起做 |
| 首跑 5 分钟 | 不变（P1 验收硬指标） | — |

默认决定（如需调整请在开工中指出）：新建工作区默认落在 `~/DshWorkspaces/<名字>/`；工作台不抢默认视图
（rail 新增入口 + 首次进入引导），P1 实测后再定是否设为默认。

## 2. 数据与目录契约

### 2.1 工作区布局（壳拥有；Team/Office 永远看不到绝对路径）

```
<workspace>/
  .dsh/
    work.json                  {schemaVersion:1, workspaceId, createdAtMs}
    index.json                 Work Product 索引（任务 + 产物；只存工作区相对路径）
    artifacts/<jobId>/<kind>.md   P1 产物正文（jobId 由 controller 给出，是句柄）
    manifest.json              P2 用：基线清单（P1 只写不读，不做 diff 结论）
```

写入纪律：临时文件 + `rename` 原子替换；索引损坏时**拒绝启动新任务**并保留现场（不静默重建）。
`.dsh/` 之外的写入 P1 一律不允许（工作区只读边界）。

### 2.2 索引 schema（P1）

```js
{
  schemaVersion: 1,
  workspaceId: 'ws-<sha256:8>',
  items: [{
    workItemId: 'wi-<ms>-<seq>', goal, templateId: 'research-review',
    status: 'idle|running|attention|completed|incomplete|failed|cancelled',
    runRef, startedAtMs, finishedAtMs,
    artifactRefs: ['ref:researcher-research-notes', ...], phase
  }],
  artifacts: [{
    ref: 'ref:<role>-<kind>', kind, relPath: '.dsh/artifacts/<jobId>/<kind>.md',
    digest: 'exec-sha256:…', producerRole, runRef, attempt, createdAtMs
  }]
}
```
索引是**面向人/agent 可读的事实**（harness engineering：工作必须可读），可被下一次任务当上下文。

### 2.3 IPC（`shell:work:*`，新增命名空间；`office:*` 仍为 8 个）

| 通道 | 方向 | 载荷 |
|---|---|---|
| `work:status` | invoke | → `{workspace:{displayPath,id}|null, items, artifacts, running}`（无 raw sessionId / 无 prompt） |
| `work:select-workspace` | invoke | `{path}` 或 `{create:name}`；校验存在/可写/不是应用目录 |
| `work:start` | invoke | `{goal}`；未选工作区 → `WORKSPACE_REQUIRED` |
| `work:cancel` | invoke | → 转给 controller.cancel |
| `work:open-artifact` | invoke | `{ref, action:'read'|'open'|'reveal'}`；read 返回有界文本（≤256KB） |
| `work:update` | push | 同 status 载荷（去抖 150ms） |

发送方校验：只接受工作台视图的 `senderFrame.url`（`file://.../work/work.html`）。

## 3. 工作包

### WP1 工作区与产物落地（纯壳侧，additive）
- 新增 `src/work/workspace-store.js`（纯 Node，注入 fs/clock/home）：
  `openWorkspace({path|create})` / `readIndex` / `writeIndexAtomic` / `registerArtifact` /
  `appendItem` / `updateItem` / `scanManifest`（P2 基线；P1 只写）。
- `src/team-shell-transport.js`：`artifactDir` 改为工作区 `.dsh/artifacts`；新增 `onArtifact` 回调
  （壳注册索引，transport 不碰索引）；`artifactPath` 仍只在壳内。
- `src/main.js`：从 settings 读 `workWorkspace`；注入 `artifactDir` 与 `onArtifact`。
- 测试：`test/work-workspace-store.test.js`（原子写/损坏拒绝/路径越界/隐私）；transport 套件更新。

### WP2 入口重构 + 工作项状态机
- 把"建 transport → controller → adapter → office 投影"抽成 `createTeamChain({topic, workspace, roleFor…})`：
  两个触发者共用（env 启动路径 / 工作台用户动作），避免两套接线。
- 新增 `src/work/work-controller.js`（纯 Node）：持有当前 work item，把 Team 快照映射为
  `status`；**机械门禁**：Team `completed` 但 `artifactRefs.length === 0` → `incomplete`（UI 不得显示完成）。
- `shell:work:*` IPC + `work:update` 推送。
- 测试：`test/work-controller.test.js`（状态映射、无产物门禁、取消、重启恢复）。

### WP3 工作台视图
- `src/work/work.html|work.css|work.js|work-preload.js`；`window-manager.js` 增加第三主视图
  `work`（与 harness/office 互斥切换，office 后台保持存活）；`office-rail.html` 增加入口。
- 首跑：未选工作区 → 引导卡（新建/打开）；已选 → 任务输入 + 模板（P1 仅 `research-review`）。
- 任务详情：目标 / 阶段（复用 `progressPhase` 的 i18n 短语）/ 产物列表 / 证据（digest、生产者、时间）。
- 产物查看器：读取文本（`<pre>`，转义渲染），按钮「打开」「在文件夹中显示」。
- i18n：`work.*` 进 `src/i18n.js`（zh/en），页面不写私有文案。
- 测试：`test/work-view-wiring.test.js`（源级：视图注册/rail/通道/发送方校验/i18n 键存在）。

### WP4 机械门禁与办公室最小映射
- 门票：无产物不算完成（WP2 已含），再加"产物文件必须存在且 digest 匹配"（打开前校验）。
- 办公室：`artifact-available` 从"只记诊断"升级为座位级产物标记（闭集 kind + 计数，无 id/路径），
  快照新增 `artifactKinds`；页面显示小图标（i18n 短语）。
- 测试：office 快照字段漂移钉 + 隐私闸。

### WP5 验收与收尾
- 真机脚本（报告 §）：选工作区 → 输入主题 → 等完成 → 打开产物 → 校验文件在盘上 → 重启后仍在。
- `docs/research/` 报告（变异矩阵 + 真机结果位）；本计划移入 `docs/plans/completed/`。

## 4. 验收

**机械（测试）**
1. 工作区选择：新建目录含 `.dsh/work.json`+`index.json`；打开已有项目不写 `.dsh/` 之外的任何文件。
2. 产物落地：一次 fake 链跑完，`.dsh/artifacts/<jobId>/research-notes.md` 存在且 digest 与事实一致。
3. 无产物门禁：产物为空时 work item 状态为 `incomplete`，不是 `completed`。
4. 隐私：`shell:work:status` / 索引 / Team facts / Office 快照均无 raw sessionId、prompt 正文、绝对路径。
5. 通道：`office:*` 仍 8 个；新增只在 `shell:work:*`。
6. 重启恢复：读索引能恢复历史任务与产物列表。

**真机（用户执行）**
- 首跑 5 分钟内：新建工作区 → 一句话主题 → 完成 → 打开 `.md` → 文件真实存在。
- 失败路径：materializer 无产出 → UI 明确显示"未产出"，不显示完成。

## 5. 变异清单（每组新测试至少一项）

| # | 变异 | 期望 |
|---|---|---|
| M1 | `registerArtifact` 不写索引 | 落地测试红 |
| M2 | 原子写改直写（无 rename） | 损坏/中断测试红 |
| M3 | 路径越界不拒绝（`..`） | 边界测试红 |
| M4 | 无产物仍映射 `completed` | 门禁测试红 |
| M5 | `work:status` 带 raw sessionId | 隐私测试红 |
| M6 | 产物 read 不校验 digest/存在 | 打开测试红 |
| M7 | 视图不校验 senderFrame | 接线测试红 |
| M8 | 办公室产物标记带 artifactId | 快照隐私测试红 |

## 6. 风险

| 风险 | 缓解 |
|---|---|
| dsh 会话的 cwd 不是用户工作区（P2 工具循环的前提） | P1 不依赖它；P2 前做能力探针，把 cwd/工具权限探明 |
| 真实运行时长与 5 分钟目标冲突（模型速度） | 模板要求"先给 3-6 个子问题 + 结论"，控制输出规模；超时显示阶段而非假完成 |
| 用户工作区很大 | P1 不扫描工作区（只写 `.dsh/`）；P2 manifest 有文件数/大小上限 |
| 索引与事实漂移 | 索引只由壳写，事实只由 Team 写；用 digest 交叉校验，不互相推断 |

## 7. 进度

- [x] WP1 工作区与产物落地（`src/work/workspace-store.js`，10 测试）
- [x] WP2 工作项状态机 + `shell:work` IPC（`work-controller` 9、`work-ipc` 5、离线端到端 1）
- [x] WP3 工作台视图（第三主视图 + rail + 首跑 + 详情/查看器；接线测试 8）
- [x] WP4 门禁 + 办公室产物标记（`office-artifact-marker` 3）
- [x] WP5 报告：`docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md`
- [ ] 真机验收（需有显示环境；脚本见报告 §4）

全量：1845 pass / 0 fail。
