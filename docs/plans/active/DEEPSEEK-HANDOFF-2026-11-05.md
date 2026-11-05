# DeepSeek 交接包：Phase 0.5 契约验证（2026-11-05）

> 这份文件是**给实施方（DeepSeek）看的**，不是给用户看的。
> 它假设你会读代码，但**不假设你知道这个仓库的历史**。所有需要知道的事实都写在这里，并附了文件:行号。
> 与 `AGENTS.md`（行为协议）、`docs/architecture/repo-map.md`（地图与铁律）配合使用；冲突时以地图为准。

---

## 0. 一句话

把 dsh 0.2.2 的**执行契约**（事件形状、审批回调、续跑/中断、Electron 集成、SDK 供给）
固化成**能在 CI 里跑的 fixture 与契约测试**，让 Phase 1 的实施不必边写边猜协议。

**验收标准只有一条**：`node --test test/contract/**` 在**没有 API key**的机器上全绿，
且故意改坏 fixture 字段名时**必须变红**。

---

## 1. 开工前必读（按这个顺序，别跳）

| 顺序 | 文件 | 你从中得到什么 |
|---|---|---|
| 1 | `AGENTS.md` | 怎么做事：不许删功能、不许改门禁、不许伪造验证、什么时候必须停下来问 |
| 2 | `docs/architecture/repo-map.md` | 仓库地图、6 条铁律、命令、**已知红项**、Git 规则 |
| 3 | `docs/plans/active/VALUE-LAYER-REVIEW-2026-11-05.md` | **本任务的存在理由**：6 处会让返工的事实偏差（§2），尤其 §2.4 SDK 供给 |
| 4 | `docs/research/memory-and-sdk-validation-2026-11-05.md` | 0.2.2 真机实测证据（§4.5/§4.6）与环境坑 E1–E11 |
| 5 | `docs/plans/active/VALUE-LAYER-REFACTOR-2026-11-05.md` | 上位计划（四阶段全貌）；本任务只做它的 §2.7 |

---

## 2. 你必须知道的现状（否则一定踩坑）

1. **基线不是全绿**：`CI=1 npm test` → 3474 项 / 3466 pass / **7 fail** / 1 skip。
   6 个红是缺 Pillow，1 个红是并发偶发。**判据是"红项集合不扩大"，不是"全绿"**。
   → 动手前先跑一次，把红项列表抄进你的工作记录，收工时再跑一次比对。
2. **`@deepseek-ai/*` 不在 `package.json`**，仓库 `node_modules/@deepseek-ai/` 是空的。
   运行时是 `scripts/prepare-runtime.js` 装到 `vendor/runtime`（打包）或
   `src/runtime-manager.js` 用 arborist 物化到 `userData/runtime/<version>`。
   → 你没有权限决定"SDK 装哪棵树"，这是 T0 要先定的（见任务卡）。
3. **`package.json.runtimeVersion` = `0.1.5-rc.2`**，与现役 0.2.1 / 目标 0.2.2 都不一致。
   它是 `prepare-runtime.js` 与 `build.js` 的唯一版本来源。**改它要连带 re-gen `vendor/runtime` 和 compat ledger**。
4. **cordis 代际必须配对**：0.2.1 → `~4.0.5`，0.2.2 → `~4.1.0`。混装的报错是
   `plugin loader null entry`，指不到根因。任何依赖变更**先问人**。
5. **事件命名是 `entity.action`**（`finding.recorded` / `taskRef.linked`），
   投影 fold 在 `src/mission/projection.js`，`unknown entity type` 在
   `src/mission/schema.js:690` 的 `validateEntity` 会被**直接拒绝**。

---

## 3. 任务卡

> 每张卡都写了"交付物 / 验收 / 禁止"。**没有验收命令的交付物不算完成。**
> 卡之间除标注外无依赖，但建议按 T0 → T2 → T3 → T4 → T5 顺序做。

### T0（前置，需人拍板）：SDK 供给方案

**问题**：`@deepseek-ai/dsh-sdk-client@0.2.2-rc.1` 装在哪里、由谁解析、打包后怎么找到 `dshBin`。

**必须回答的四问**（写进 `docs/research/sdk-provisioning-2026-11-XX.md`）：

| # | 问题 | 为什么必须回答 |
|---|---|---|
| 1 | SDK 包装进仓库 `node_modules`，还是装进运行时那棵树？ | 两棵树会带两套 cordis，混装即崩 |
| 2 | `dshBin` 指向哪？开发态 vs 打包态路径分别是什么？ | 指向错了表现为 "no adapter registered for provider"（误导性极强） |
| 3 | SDK 能否在 asar 内被 require？不能的话 `asarUnpack` 加什么？ | 打包后才暴露，开发态永远发现不了 |
| 4 | Electron 主进程是 Node 22，SDK 包未声明 `engines`，能否加载？ | 属推断，**必须实测**；不行就得把 SDK 关进子进程 |

**交付物**：一份方案文档 + 一个最小可跑脚本 `scripts/sdk-provision-check.js`（打印四问的实测答案）。
**验收**：脚本在**干净 DSH_HOME** 下能跑出结论；四问都有"是/否 + 证据"。
**禁止**：不要直接改 `package.json` 的 dependencies 来"试试看"——先出方案。
**注意**：这条涉及依赖与运行时，按 `AGENTS.md` §13 必须先问人。

### T1（需人拍板）：事件命名与实体归并

**背景**：计划写的 `memory/attempt` 与现有 `entity.action` 约定不符；
`lesson`/`gotcha` 与已有 `finding`/`assumption`/`evidence` 重叠。

**两个待定问题**（**不要自己决定**，等用户拍板后写进计划再实施）：

1. 事件名用 `attempt.recorded` / `lesson.recorded` / `gotcha.recorded`（推荐），还是别的？
2. 与 `finding` 归并（`gotcha` = `finding.kind: hazard`），还是并存（并写清分工判据）？

**你现在能做的**：先把"三处必改点"列成 checklist 放进计划，等拍板后一次性改：
`ENTITY_TYPES`（schema.js:28）→ `validateEntity` 分派（schema.js:690）→ `projection.js` fold（:115 起）。

### T2：事件契约 fixture + 契约测试（本阶段主交付）

**目标**：把六族事件（`turn|step|tool|message|request|session`）的字段形状与顺序约束固定下来。

**输入证据**（**不要重新烧 key**）：

- `docs/research/memory-and-sdk-validation-2026-11-05.md` §4.6 的两次真机跑（问答 / 工具循环）；
- 事件样本：脱敏后的 `session-event-sample-022.md`（验证报告引用）；
- 已知语义（必须体现进 fixture 注释）：
  - `session.event` 是 wire 信封，`session.status` 是**独立通知方法**，不属于 `session.event`；
  - `tool/call` 与 `tool/result` 靠 `callId` 配对；
  - `request/header` 带 provider/model/完整工具清单。

**交付物**

```
test/fixtures/harness/0.2.2/qa-session.jsonl       # 问答（13 事件）
test/fixtures/harness/0.2.2/tool-loop.jsonl        # 工具循环（23 事件，2 组 tool-call→result）
test/contract/harness-event-shape.test.js          # 字段形状 + 必填项
test/contract/harness-event-order.test.js          # 顺序约束 + callId 配对
```

**验收（必须满足全部）**

1. `node --test test/contract/**` 全绿，**且不需要 API key、不需要网络**；
2. **负向变异必须被检出**：把 fixture 里 `callId` 改名 → 红；删 `seq` → 红；
   打乱 `tool/result` 顺序 → 红。三种变异各做一次，把结果写进报告（`DETECTED`/`masked`）。
3. 测试里**不得**出现"如果字段缺失就跳过断言"的写法。

**禁止**

- 不要为了"让测试好写"而裁掉事件字段 —— fixture 是契约，不是方便面。
- 不要把真机全量日志原样塞进去（含 prompt 正文、绝对路径）—— 必须脱敏，
  见 `repo-map.md` §2.4 隐私铁律。

### T3：RuntimeProfileManager 原型（provisioner）

**目标**：把"profile + patch + plugin"三步做成可重复执行的脚本，替代手工操作。

**已验证的三条硬事实**（照做，别重新摸索）：

1. profile 用 `sdk-minimal`，补丁 `insert` 必须是**数组**：
   `insert: [{ id, name, config }]`；
2. 自定义 OpenAI 兼容网关必须用 `@deepseek-ai/dsh-llm-pi-ai`
   （`api: openai-completions` + `baseURL` + 自声明 `models`），
   **`dsh-llm-deepseek` 只支持 Messages 协议**，接不了 chat-completions；
3. 插件必须 `dsh plugin --profile <name> add <pkg>` 装进 profile，否则 patch 静默不激活；
   `tool-fs` 默认 read/write/edit 全 false，做写文件任务要显式开启。

**交付物**：`src/runtime/profile-manager.js`（纯逻辑优先，可注入执行器）+ 单测
`test/runtime-profile-manager.test.js`（用 fake executor，不真装包）。

**验收**

1. 单测覆盖：补丁生成（数组形状）、幂等（重复 provision 不重复装）、自检（插件未激活时报错而不是静默）；
2. 生成物与验证报告 §4.6 的 `stepfun-patch.yml` **结构一致**（字段名逐个比对）；
3. 无 key 环境下可跑（fake executor 路径）。

**禁止**：不要硬编码 provider/baseURL 到业务代码里 —— 配置来自用户设置，不来自常量。

### T4：中断方案（二选一定稿）

**背景事实（已实测）**：SDK **没有会话级取消**——`cancelRequest` / `$/cancel` 在 sdk-client 里出现 0 次。
只有 ACP 通过 JSON-RPC 请求中止（`stopReason: "cancelled"`）。

**要做的**：验证两条降级路径，选一条，写进计划，并明确 **UI 是否能有"停止"按钮**。

| 方案 | 做法 | 要验证什么 |
|---|---|---|
| A | kill 子进程 → `resumeSession` 续跑 | 续跑后上下文是否连续；被杀会话是否留下"半个 turn" |
| B | 经 ACP 请求中止 | 中止后事件流如何收尾；会话身份归谁 |

**交付物**：`docs/research/interrupt-options-2026-11-XX.md`（两方案的实测结论 + 推荐 + 失败模式）。
**验收**：有明确结论，**允许结论是"本期不提供停止按钮"**——这比假取消好。
**禁止**：不许在 UI 里放一个"点了其实没停"的按钮。

### T5：Electron 集成面实测

**要回答**：

1. Electron 主进程（Node 22）`require('@deepseek-ai/dsh-sdk-client')` 是否可行；
2. Harness 子进程需要 Node ≥24.9 —— 随包供给 Node 24 时，路径解析与打包后定位怎么做；
3. asar 环境下子进程能否执行（`asarUnpack` 是否必需）。

**交付物**：`docs/research/electron-sdk-integration-2026-11-XX.md` + 可重跑的探针脚本
（放 `scripts/acceptance/`，因为它需要图形会话/打包产物，**不进 CI**）。

**验收**：三个问题都是"是/否 + 证据（命令输出片段）"。跑不了就写"跑不了 + 原因"，**不许推断当结论**。

---

## 4. 交付前的自检清单

- [ ] `node --test test/contract/**` 绿，且**我在没有 key 的干净环境**跑过。
- [ ] 三种负向变异都做过，结果如实记录（`DETECTED` / `masked`）。
- [ ] `CI=1 npm test` 的红项集合与开工前**一致**（不是"更绿"，是"不多"）。
- [ ] `node --test test/docs-index.test.js` 绿（我新增/移动了文档）。
- [ ] 没有新增依赖（若必须，已先问人并记录在计划里）。
- [ ] 没有修改任何 `test/` 门禁、`AGENTS.md`、`repo-map.md` 来让自己通过。
- [ ] 报告写了"改了什么/验证了什么/还剩什么"，且剩余问题没有被说成完成。

---

## 5. 明确不做（本阶段）

- 不写 UI、不改 `mission-desk.html`。
- 不改 Mission schema / 事件类型（T1 拍板后才能动）。
- 不改主链路派发（`missionPromptSession` 保持原样，Phase 1 才切）。
- 不删 `src/team/runtime/**`（按 ADR-0002 延后退役）。
- 不做记忆检索、不做检查器（Phase 2 / 3）。
- 不引入第三方记忆引擎。

---

## 6. 遇到这些，停下来问（不要猜）

1. 要改 `AGENTS.md` / `repo-map.md` / 任何 `test/` 门禁；
2. 要加依赖、升级运行时、改 `runtimeVersion`、动 cordis 代际；
3. 要动隐私边界（schema 黑名单、写用户文件、fixture 里放真实日志）；
4. 需求有两种合理读法且代价不同；
5. 要真机 key / 图形会话 / 外部网关；
6. 要推送、开 PR、改 CI。

其余（命名、目录、测试怎么写、日志措辞）自己按现有约定决定，报告里说明即可。
