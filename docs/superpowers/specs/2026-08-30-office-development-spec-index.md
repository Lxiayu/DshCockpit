# Virtual Office 开发 SPEC 索引

> 状态：Draft for implementation review。本文档是开发分册入口，不替代产品总纲或 Character Runtime 设计规格。
>
> 唯一依据：`总纲.md`、`docs/specs/OFFICE-DESIGN-DISCUSSION.md`、`docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md`、`docs/superpowers/plans/2026-08-30-virtual-office-runtime-implementation.md` 及本目录下已确认的五份 Character Runtime 规格。当前所有 Office 分册均为 `Draft`，用户确认后才可改为 `Approved`。

## 阅读顺序

```text
外部 AI 代理交接规范
  -> SPEC-00 文档/边界
  -> SPEC-01 兼容性与依赖
  -> SPEC-02 角色资产与安装
  -> SPEC-03 纯 Character Runtime
  -> SPEC-04 本地行为/员工/队列
  -> SPEC-05 Harness Adapter/resync
  -> SPEC-06 Animation Playground
  -> SPEC-07 Pixi Office/UI
  -> SPEC-08 持久化/设置/降级
  -> SPEC-09 验收/发布
```

实现者必须先读本索引、产品总纲和对应分册；禁止跨分册复制内部状态或绕过接口。每个分册完成后先通过自身测试，再进入下游分册。实现计划是任务分解的唯一入口，SPEC 是契约的唯一入口，代码是当前事实的唯一入口；三者不一致时不能自行猜测。

目录浏览入口是 `README.md`；交给外部 AI 时，先发送 `2026-08-30-office-agent-handoff.md`，再发送本索引、plan 和指定 SPEC。交接规范定义基线检查、修改边界、测试纪律和汇报格式。

Character Runtime 的基础设计必须同时参考：`2026-08-30-character-animation-architecture.md`、`2026-08-30-character-state-machine.md`、`2026-08-30-character-movement-system.md`、`2026-08-30-character-asset-spec.md`、`2026-08-30-animation-playground-plan.md`。它们定义概念和视觉质量门；本索引下的 SPEC 定义仓库文件、接口和交付边界。

## 分册清单

| 编号 | 文档 | 负责范围 | 主要产物 |
|---|---|---|---|
| 00 | `2026-08-30-office-spec-00-boundaries.md` | 术语、层次、范围、禁止事项 | 边界测试 |
| 01 | `2026-08-30-office-spec-01-compatibility.md` | Pixi/Electron/Harness 探针 | 版本证据与 capability |
| 02 | `2026-08-30-office-spec-02-character-assets.md` | PNG 校准、manifest、安装、fallback | 角色包与 validation report |
| 03 | `2026-08-30-office-spec-03-runtime-core.md` | state、animation、movement、transition | 纯 CommonJS Runtime |
| 04 | `2026-08-30-office-spec-04-residents-and-queue.md` | 员工、漫游、聊天、睡眠、队列 | 员工/队列 reducer |
| 05 | `2026-08-30-office-spec-05-harness-adapter.md` | 事件适配、去重、resync、控制 | canonical envelope |
| 06 | `2026-08-30-office-spec-06-playground.md` | 单角色视觉验证 | Playground 与证据截图 |
| 07 | `2026-08-30-office-spec-07-office-ui.md` | Pixi 场景、WebContentsView、详情 UI | Office MVP 页面 |
| 08 | `2026-08-30-office-spec-08-persistence.md` | office-state、设置、隐私、诊断 | 持久化与降级 |
| 09 | `2026-08-30-office-spec-09-acceptance.md` | 全量测试、性能、视觉、发布 | Release evidence |

## 依赖图与任务选择

```text
SPEC-00
  -> SPEC-01 -> SPEC-02 -> SPEC-03 -> SPEC-06 -> SPEC-07
                    \            -> SPEC-04 -> SPEC-05 -/
                                      \-> SPEC-08 -/
                                                   -> SPEC-09
```

实现代理只能领取 plan 中已解锁的 Task：

| 任务 | 先决条件 | 可并行内容 | 完成门 |
|---|---|---|---|
| Task 0 | 无 | 无 | 文档契约测试 |
| Task 1 | Task 0 | 与资产 schema 讨论可并行，但不装依赖 | 探针和版本证据 |
| Task 2 | Task 0 | 可与 Task 1 分开准备素材，但不能改 package | validation report |
| Task 3 | Task 1、2 | 无 | 纯 Runtime focused tests |
| Task 4 | Task 3 | 无 | Playground 五阶段证据 |
| Task 5 | Task 3、4 | 无 | 四员工/单协作者 deterministic replay |
| Task 6 | Task 1、3、5 | 无 | adapter/resync fixture replay |
| Task 7 | Task 4、5、6 | 无 | Electron Office 场景 |
| Task 8 | Task 5、6、7 | 无 | office-state/隐私/降级测试 |
| Task 9 | Task 0-8 | 无 | 发布门和用户确认 |

若代理只被分配一个 SPEC，任务包必须明确它可以读哪些上游产物、不得触碰哪些下游文件；“顺手修一下”不属于授权范围。

## 实时开发审查

每个 Task 必须拆成可验证的小步骤，并在每一步结束时同步给审查者。审查者按四项检查：范围与迁移面、跨层契约、失败/隐私/生命周期测试、回滚和证据。审查发现 blocker 时，下游 Task 自动锁定；修复决定必须记录到交付报告或 `docs/notes/`。

## 代理查阅清单

领取任务后按以下命令建立上下文（命令只读）：

```bash
git status --short
git diff --name-only
sed -n '1,260p' docs/superpowers/specs/2026-08-30-office-agent-handoff.md
sed -n '1,260p' docs/superpowers/specs/2026-08-30-office-development-spec-index.md
sed -n '1,420p' docs/superpowers/plans/2026-08-30-virtual-office-runtime-implementation.md
sed -n '1,260p' docs/superpowers/specs/<assigned-spec>.md
```

随后只读取 assigned SPEC 列出的代码入口和测试；不要用全文搜索结果替代前置阅读。开始编码前，在交接消息中回复 `Task / Scope / Out of scope / Gate command` 四项。

## 规格版本与变更记录

每个分册顶部的状态应为 `Draft`、`Approved`、`Implemented` 或 `Superseded`，并在变更时记录日期、原因、影响的字段/测试。跨分册字段变更必须同时更新索引、plan、所有消费者 SPEC 和契约测试；不能只修改实现。

## 每份 SPEC 的强制结构

每个分册必须保持以下章节，便于没有仓库上下文的代理执行：

1. `目标与非目标`：本任务做什么、不做什么。
2. `前置阅读与依赖`：必须先读的文档、上游产物和版本。
3. `允许修改与禁止修改`：精确到文件/目录和跨模块边界。
4. `输入/输出契约`：字段、来源、默认值、版本、错误码和生命周期。
5. `实现步骤`：按 TDD 顺序写测试、实现、验证和交付。
6. `验收与失败处理`：命令、阈值、证据位置和遇到冲突时的停机规则。
7. `交接报告`：实际文件、测试结果、已知缺口和回滚边界。

## 状态来源原则

| 来源 | 允许写入 | 不允许写入 |
|---|---|---|
| Harness Runtime | runtime、tool、terminal、binding evidence | 本地漫游、视觉结果 |
| Office Adapter | canonical envelope、sync、capability、派生 binding | 伪造 Harness 事实 |
| Local Scheduler | roaming/chat/rest/sleep、目标选择 | running/completed/failed/tool |
| Movement | 位置、方向、reservation | Runtime 状态 |
| Animation | 当前资源和帧 | 逻辑位置、任务状态 |
| Renderer/UI | 显示、选择、详情、用户意图 | 持久化事实、Runtime 结果 |

## 目录与迁移规则

Office 新代码默认只能放入 `src/office/`，测试放入 `test/office/`，运行时办公室素材放入 `resources/office/`，角色包放入 `resources/characters/<pack-id>/`，工具放入 `scripts/office-assets/` 或 `scripts/office-probes/`。`photo/` 是源素材区，`docs/legacy/` 是归档区，二者都不能被生产代码扫描或加载。

与主仓库共享的接线面必须保持最小：`src/main.js`、`src/window-manager.js`、设置代理、`src/i18n.js`、`package.json/package-lock.json` 和打包配置。共享文件中只允许添加 Office 注册、IPC/bounds、feature flag、文案和资源打包入口；所有业务逻辑必须通过 `src/office/office-module.js` 或等价稳定 façade 暴露。

迁移目标是“目录可整体搬运、接线可单独重做、提交可 cherry-pick”。任何新增跨目录 import、绝对路径、对旧 settings/sessions 的写入或对 `docs/legacy/photo` 的运行时依赖，都必须先更新 SPEC 并获得主代理裁决。

## 变更规则

1. 跨分册接口先改对应 SPEC，再改实现和测试。
2. 新增字段必须写明来源、版本、默认值、兼容和回滚行为。
3. 未经兼容探针证明的 Harness 能力不得进入 UI。
4. 每个分册提交前检查 dirty worktree 和 staged 文件清单；不得回滚用户既有修改。
5. 本索引与分册状态为 Draft，须用户确认后才开始实现。
6. 任何代理交付必须附 handoff 规定的报告；缺少测试或证据时状态保持 Draft/Blocked。
