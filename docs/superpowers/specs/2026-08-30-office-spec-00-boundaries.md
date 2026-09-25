# Office SPEC-00：边界与开发纪律

> Status: Draft. 本分册是所有 Office 任务的范围冻结和冲突门禁；它不提供可运行模块。

## 目标与非目标

目标是冻结 Virtual Office v1 的术语、状态层次、模块责任、文件边界、隐私底线和发布开关。任何代理都应能依据本分册判断“这个字段/行为由谁产生、是否可以修改、何时必须停工”。

非目标：恢复旧版 DOM Office、真实 3D/透视相机、物理碰撞或 A*、LLM 驱动闲聊、固定 provider 权限、修改 Harness 源码、写入 `sessions/`、GitHub 角色导入、在未探针证明时提供 pause/resume/preempt UI。

## 前置阅读与允许范围

先读 handoff、SPEC 索引、implementation plan、`总纲.md`、`docs/specs/OFFICE-DESIGN-DISCUSSION.md` 和 Harness research。Task 0 仅允许修改上述文档及 `test/office-doc-contract.test.js`；禁止修改 `src/`、`package.json`、角色资源和 Harness 接线。发现旧文档冲突时标记 `superseded` 并报告，不删除历史文件。

## 产品范围冻结

- 扁平 2D 正交办公室，不使用透视或 3D 投影。
- 2x3 六工位，整体略向右下，左上保留家具扩展区；家具未齐时使用可识别 placeholder。
- 四名常驻员工：`orchestrator`、`researcher`、`coder`、`reviewer`；一个动态 collaborator，不能复制多个。
- 办公室打开即本地漫游/聊天/休息；可信任务才回工位工作，长时间无任务为 sleeping，不为 offline。
- Pixi 负责渲染；纯 Runtime 不依赖 Pixi；Adapter 是唯一 Runtime 事实入口。

## 仓库隔离与主仓库迁移契约

Office 实现必须优先放在独立目录，避免把业务逻辑散落到主仓库根目录：

```text
src/office/                 # Office 运行时、渲染器、UI、fixtures
src/office/runtime/         # 纯 Runtime、Adapter、Scheduler、Persistence
src/office/render/          # Pixi renderer
src/office/ui/              # office page/preload/html/css
resources/office/           # 已确认的办公室运行时素材
resources/characters/       # 独立 Character Pack
scripts/office-assets/      # 资产校准和验证工具
scripts/office-probes/      # 兼容性/渲染探针
test/office/                # Office 专属测试
```

`photo/` 只保存原始素材、生成记录和人工参考，不得成为生产运行时依赖。旧实现只能位于 `docs/legacy/`，不得被 `require()`、资源扫描或打包配置加载。Office 只能通过一个薄集成入口（建议 `src/office/office-module.js`）接入 `main.js`、`window-manager.js` 和设置系统；主仓库共享文件只包含注册、bounds/IPC、feature flag 和文案接线，不得承载 Office 状态机或 Pixi 业务逻辑。

资产路径必须通过统一 resolver 解析开发环境、打包环境 `process.resourcesPath` 和用户 `app.getPath('userData')`；禁止硬编码项目绝对路径。`package.json`/lockfile 的 Pixi 变更单独成提交；办公室目录、资源、接线和设置也分别成可回滚提交，迁移主仓库时优先使用 cherry-pick，而不是复制整个分支。

主仓库迁移验收：Office 目录可整体迁移；只需重新处理明确列出的薄接线文件；旧 settings/runtime/sessions 不产生 schema 冲突；`git diff --find-renames` 可定位目录移动；生产入口不引用 `docs/legacy` 或 `photo`。

## 状态与来源契约

```text
presence: present
sync: healthy | stale | resyncing
runtime: unbound | idle | running | attention | completed | failed
activity: roaming | chatting | resting | sleeping | working | thinking | waiting | celebrating
movement: stationary | moving | arriving | leaving
control: none | dispatchPending | cancellationPending | preemptPending
binding: unbound | pending | bound | releasing
queue: empty | queued
```

常驻员工永远 `presence=present`；`sync` 异常只能改变 sync，不得生成 offline。Harness 只提供原始事件和经过探针证明的能力；Adapter 派生 `eventId/sessionEpoch/snapshot/resync`；Scheduler 只能写本地 activity/target；Movement 只能写位置/方向/reservation；Animation 只能写资源/帧；Renderer/UI 只能显示和发用户意图；Persistence 只能保存允许的 profile/设置/脱敏历史。

## 变更与接口规则

跨分册接口变更顺序固定为：更新受影响 SPEC -> 更新 plan/index -> 写契约测试 -> 实现 -> 验收证据。新字段必须声明来源、schemaVersion、默认值、兼容行为、隐私级别和回滚行为。未在兼容探针或 research evidence 中证明的 Harness 字段必须标为 Adapter 派生或 unsupported，不能进入 UI。

每个任务开始前记录 dirty worktree；只提交任务授权文件；不得 reset/checkout/clean 用户已有修改。修改 `main.js` 或 `window-manager.js` 必须先 `node --check`。纯逻辑使用 fake clock/seed；视觉问题提交截图与诊断 JSON；禁止用 CSS offset、图片硬切、节点重建或 teleport 掩盖责任层缺陷。

## 实现步骤与文档契约测试

1. 在 `test/office-doc-contract.test.js` 写失败断言，检查状态词汇、四员工/单协作者、2x3 布局、`office-state.v1`、feature flags、Harness unsupported 能力和来源表。
2. 运行 `node --test test/office-doc-contract.test.js`，预期旧文档/缺契约时失败。
3. 标记冲突段落并补齐当前词汇，不改实现文件。
4. 再运行测试和 `git diff --check -- docs/superpowers/specs docs/superpowers/plans docs/specs`。

## 验收、失败处理与交接报告

验收要求契约测试通过、索引能定位每份 SPEC、plan 有 Task->SPEC 映射、无活动段落声称 Harness 原生提供 `eventId/sessionEpoch` 或 offline。失败时停止所有下游实现，保留冲突清单和测试输出。

交付报告：`Scope`、`Docs changed`、`Vocabulary frozen`、`Migration surface`、`Conflicts/superseded sections`、`Tests`、`Evidence`、`Known gaps`、`Rollback`、`Staged files`。缺少任一项，状态保持 Draft。
