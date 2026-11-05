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

1. **基线不是全绿**：`CI=1 npm test` → 3476 项 / 3468 pass / **7 fail** / 1 skip。
   6 个红是缺 Pillow，1 个红是并发偶发。**T0 落地前过渡判据是"红项集合不扩大"**；
   **T0 完成后恢复 0 fail**（那是你的任务之一）。
   → 动手前先跑一次，把红项列表抄进你的工作记录。
2. **`@deepseek-ai/*` 不在 `package.json`**，仓库 `node_modules/@deepseek-ai/` 是空的。
   运行时是 `scripts/prepare-runtime.js` 装到 `vendor/runtime`（打包）或
   `src/runtime-manager.js` 用 arborist 物化到 `userData/runtime/<version>`。
   → **SDK 装哪棵树已拍板**（计划 §2.8 决策 B）：**与 runtime 同树 + 宿主进程**。
   T0 是**实施卡不是决策卡**，别再提替代方案。
3. **`package.json.runtimeVersion` = `0.1.5-rc.2`**，与现役 0.2.1 / 目标 0.2.2 都不一致。
   它是 `prepare-runtime.js` 与 `build.js` 的唯一版本来源。**改它要连带 re-gen `vendor/runtime` 和 compat ledger**。
4. **cordis 代际必须配对**：0.2.1 → `~4.0.5`，0.2.2 → `~4.1.0`。混装的报错是
   `plugin loader null entry`，指不到根因。任何依赖变更**先问人**。
5. **事件命名是 `entity.action`**（`finding.recorded` / `taskRef.linked`），
   投影 fold 在 `src/mission/projection.js`，`unknown entity type` 在
   `src/mission/schema.js:690` 的 `validateEntity` 会被**直接拒绝**。
6. **记忆实体已拍板**（计划 §2.8 决策 A）：只加一个 `lesson` 实体（`kind: lesson|gotcha|attempt`），
   删 `memory/decision`，`finding` 不动。Phase 0.5 期间**不改 schema**（那是 Phase 2 的活）。

---

## 3. 任务卡

> 每张卡都写了"交付物 / 验收 / 禁止"。**没有验收命令的交付物不算完成。**
> 卡之间除标注外无依赖，建议按 T0 → T1 → T2 → T3 → T4 → T5 顺序做（T0/T1 的拍板已定，是动手卡）。

### T0（拍板已定，动手卡）：SDK 同树供给 + 宿主进程

**拍板（计划 §2.8 决策 B）**：SDK 与 runtime **同树供给** + **宿主进程**。这张卡是**实施**，不是再选方案。

**已源码确认的硬事实**（照做，别重新摸索）：

1. `@deepseek-ai/dsh-sdk-client@0.2.2-rc.1` 精确依赖 `@deepseek-ai/dsh@0.2.2-rc.1`（本体 124K、
   **90 个依赖、整树 897MB**）→ 装进仓库 `node_modules` = asar +897MB，**不可行**；
2. SDK 把子进程命令**硬编码为 `process.execPath`**（`lib/index.js:172`，无覆盖选项）→
   Electron 主进程（Node 22）里直接用 = spawn 出 Electron 本体，且不满足 dsh ≥24.9
   → **必须跑在宿主进程里**，宿主由 `bestNodeBin()`（`src/main.js:1952`）拉起；
3. 显式传 `dshBin` 会**跳过** SDK 的版本相等校验（`lib/index.js:164`）——
   旧守门人换掉，新守门人是 Runtime Lockfile 一致性门禁，**别漏装**。

**交付物**

1. runtime 树 `package.json` 模板两处同步加 `@deepseek-ai/dsh-sdk-client`（精确版）：
   `src/runtime-manager.js:448`（物化模板）与 `scripts/prepare-runtime.js`（vendor seed）；
2. `scripts/sdk-provision-check.js`，在**干净 DSH_HOME** 下打印：
   - 同树解析路径（SDK 与 dsh 是否同一 `node_modules`、是否去重为单份）；
   - `dshBin` 开发态 / 打包态（`extraResources`）两个路径；
   - 宿主进程端到端：`bestNodeBin()` 解析结果 → 宿主内动态 `import()` SDK → 无 key 握手冒烟；
   - asar 打包后路径（跑不了打包就写"跑不了 + 原因"，**不许推断当结论**）；
3. 给 0.2.2-rc.1 补 `src/runtime-capability.js` 的 KNOWN_MATRIX 记录
   （现在 `judge('0.2.2-rc.1')` 返回 `unverified`、9 项能力 unknown——以隔离环境实测为准，不是抄文档）。

**验收**：provision-check 脚本可重跑且四项都有"是/否 + 证据"；`node --test` 相关套件不红。
**禁止**：不改根 `package.json` 的 dependencies；不提"装进仓库树"的替代方案（已否决）。
**注意**：依赖与运行时变更按 `AGENTS.md` §13 先问人——本卡已获用户批准的范围除外（同树两处模板 + capability 记录）。

### T1（拍板已定，动手卡）：基线转绿

**拍板（计划 §2.8 决策 C）**：把 7 个红**动手消掉**，不是记录归因。完成后全量判据恢复 **0 fail**。

**要做**

1. **6 个 Pillow 红 → 条件 skip**：缺 Pillow 时 `t.skip()` 并打印原因；
   CI 设 `REQUIRE_PIL=1` 时 skip **变回 fail**（本地宽容、CI 严格）；
2. **`test/mcp-verify-gate.test.js` 并发偶发 → 串行化**（`{ concurrency: 1 }` 或等价），**不是重试**；
3. **skip 白名单**登记进 `repo-map.md` §5（哪些 skip、为什么允许）。

**验收**：本机 `CI=1 npm test` → **0 fail**（skip 只允许白名单内的）；有 Pillow 的环境跑一次记录结果。
**禁止**：不许无条件 skip（那是把红藏起来，比红更糟）；不许改门禁测试的断言；
`repo-map.md` §5 的白名单登记属于**文档同步**（允许），改 `test/` 门禁属于**松绑**（禁止）。

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

**要回答**（宿主进程形态已定，计划 §2.8 决策 B——**验证它，不是再选它**）：

1. `bestNodeBin()`（`src/main.js:1952`）在干净机器上能否解析到 Node ≥24.9？解析不到时的降级行为是否可接受（显式报错而非玄学崩溃）；
2. 宿主进程（真 Node ≥24.9 + 同树 SDK）端到端：握手 + 一次无 key 冒烟 + 优雅关闭梯子（stdin EOF → SIGTERM → SIGKILL）；
3. 打包后 `extraResources` 里 runtime 树的路径解析（asar 内只留宿主脚本薄壳；SDK 不进 asar）。

**交付物**：`docs/research/electron-sdk-integration-2026-11-XX.md` + 可重跑的探针脚本
（放 `scripts/acceptance/`，因为它需要图形会话/打包产物，**不进 CI**）。

**验收**：三个问题都是"是/否 + 证据（命令输出片段）"。跑不了就写"跑不了 + 原因"，**不许推断当结论**。

---

## 4. 交付前的自检清单

- [ ] `node --test test/contract/**` 绿，且**我在没有 key 的干净环境**跑过。
- [ ] 三种负向变异都做过，结果如实记录（`DETECTED` / `masked`）。
- [ ] `CI=1 npm test`：T1 完成后 **0 fail**；若 T1 未完成，红项集合与开工前**一致**（不是"更绿"，是"不多"）。
- [ ] 没有新增未登记的 skip（白名单见 `repo-map.md` §5）。
- [ ] `node --test test/docs-index.test.js` 绿（我新增/移动了文档）。
- [ ] 没有新增依赖（T0 批准范围内的同树模板改动除外，已记录在计划里）。
- [ ] 没有修改任何 `test/` 门禁、`AGENTS.md`、`repo-map.md` 来让自己通过。
- [ ] 报告写了"改了什么/验证了什么/还剩什么"，且剩余问题没有被说成完成。

---

## 5. 明确不做（本阶段）

- 不写 UI、不改 `mission-desk.html`。
- 不改 Mission schema / 事件类型（拍板已定见 §2 现状第 6 条，但实施属 Phase 2，本阶段不动）。
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
