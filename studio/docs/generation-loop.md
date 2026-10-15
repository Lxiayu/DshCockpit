# 生成段闭环（generation loop）—— 可复现的命令链

> 一句话：**用户自己的编码 agent 产出素材 → 工作台一条命令链接收它、QC 它、分诊它、归一化它、入包它**，
> 每一步**内容寻址**（改一步只重跑那一步）、每一次调用**参数入账**（`.params.json`）、
> 每一次失败**进人工分诊队列**（带原因、建议修法、已重试几次）。
>
> 架构决策（R5）：**生成不由工作台调模型**。工作台不持有视频/图像 key，不绑定模型协议；
> 它做的是「接收 → QC → 分诊 → 归一化 → 入包」这条链的**工程化**。
> 配方（提示词）由 `node bin/agent.js prompts` 从流水线自己的 `buildPromptPlan` 生成，两边同源（有测试锁着）。

模块：`studio/lib/pipeline/{stages,orchestrate,cache,intake,triage,params}.js` · CLI：`studio/bin/pipeline.js` · 服务面：`studio/lib/studio-services.js`（`pipelineStages/Plan/Run/TriageList/TriageResolve`，经 `studio:pipeline-*` IPC）· 界面：`src/workbench/` 的「生成」页（`app/pipeline-model.js` + `workbench.js` 面板块）。
测试：`studio/test/generation-loop.test.js`（16 项）+ `studio/test/pipeline.test.js`（P4 既有 15 项）+ `studio/test/studio-services.test.js` 的生成环 7 项 + `src/workbench/test/pipeline-panel.test.js`（17 项）。

---

## 1. 命令链（最终用法）

```bash
cd studio

# 看会跑什么（不执行、不写缓存、不入账）
node bin/pipeline.js plan walk-left
node bin/pipeline.js plan walk-left --force            # 假装没有缓存
node bin/pipeline.js plan walk-left --dir ../content/incoming/walk-left

# 跑：接收 → QC → 分诊 → 归一化 → 入包
node bin/pipeline.js run walk-left
node bin/pipeline.js run walk-left --plan              # 同 plan
node bin/pipeline.js run walk-left --force             # 忽略缓存，全部重跑
node bin/pipeline.js run walk-left --only S4,S5        # 只跑指定段
node bin/pipeline.js run walk-left --no-publish        # 到归一化为止，不入包
node bin/pipeline.js run walk-left --params '{"packCanvas":384}'
node bin/pipeline.js run walk-left --dir ../content/incoming/walk-left   # 先过交付门禁
node bin/pipeline.js run walk-left --record-params --agent codex-cli     # 显式落账 + 执行者身份

# 人工分诊队列
node bin/pipeline.js triage list [--action walk-left] [--status open|resolved] [--json]
node bin/pipeline.js triage show <id>
node bin/pipeline.js triage resolve <id> --note "改了什么" [--by codex-cli]

# 素材护照（这套素材怎么来的 + 一键复现 + 红黄绿）
node bin/provenance.js report walk-left --text
node bin/provenance.js verify [--json]                 # 全量在盘校验 + 台账哈希链
```

退出码：`0` 正常 · `1` 被拒/失败/分诊未清 · `2` 用法错误。
`--json` 动词的 stdout 只有 JSON；`plan --json` / `run --json` / `triage --json` 同理。

**三个门，一条链**：CLI（`bin/pipeline.js`）、服务（`studio:pipeline-*`，给界面用）、
界面（「生成」页的流水线面板）都走同一组库函数。plan 与 run 同源（`resolvePlan`），
服务与 CLI 的计划在沙盒树上逐字段对齐（有测试钉着）；台账策略两边一字不差——
**真实树默认不落账**（面板上是一个默认不勾的复选框，`--record-params` 是 CLI 的等价物）。

环境变量（与 `bin/agent.js` 同一套）：`STUDIO_CONTENT_DIR` / `STUDIO_CHARACTERS_ROOT` 把整条链指向**一棵树的副本**——
发布验收、代理试跑都这么用，**参数入账也默认只在沙箱树上落盘**（见 §6）。

---

## 2. 段（S0–S8）：输入 → 输出 → 缓存键

| 段 | 输入 → 输出 | 缓存键包含 | 参数键（`paramKeys`） | 现状 |
|---|---|---|---|---|
| S0 参考图规范 | 参考 PNG → 事实（尺寸/绿幕占比/alpha/宽高比） | 参考图字节 | —（无参数） | 本地可跑（`--reference` 时入链） |
| S1 三视图 | 参考图 → 转身基准图 | 参考图 + 参数（模型/动作/方向/节拍） | model, action, direction, beatSeconds, referenceHash | **provider 门禁**：缺 key 即拒（计划可缓存） |
| S2 方向基准 | 三视图 → 方向基准 | 同上 | 同上 | 同上 |
| S3 动作生成 | 方向基准 → 动作视频 | 同上 | 同上 | 同上 |
| S4 抠像后处理 | 帧 → 清洗帧 | 帧字节 + `options` | options | 本地可跑 |
| S5 自动 QC | 清洗帧/视频 → 红黄绿报告 + 修法 | 上游产物 + 阈值 | footLine, tolerancePx, expectedSeries, expect | 本地可跑（帧 + ffmpeg 视频） |
| S6 归一化 | 清洗帧 → 规范帧 | 清洗帧 + QC 报告 + 几何参数 | footLine, packCanvas, packAnchor, targetHeight | 本地可跑 |
| S7 alpha 视频 | 清洗帧 → VP9-alpha WebM | 清洗帧 + 编码参数 | fps, crf, size, expectAlpha | 本地可跑 + 实测 alpha 平面 |
| S8 入包 | 规范帧 + QC 报告 → 包条目 + provenance | 上游 + 动作文档 | —（无参数） | 本地可跑；**红灯报告在盘上即拒绝入包** |

**缓存键 = `sha256(段名 | 工具版本 | 该段的参数 | 每个输入的字节 sha256)`**（`lib/pipeline/cache.js`）。
两个关键语义：

1. **参数按段过滤**：键里只有该段 `paramKeys` 声明的参数。改 `packCanvas` 只让 S6（及其下游）失效，
   抠像和 QC 门的键纹丝不动。改 `options` 则整条下游跟着重跑——因为它的**输入字节**变了（内容寻址，不是时间戳寻址）。
2. **命中即恢复链**：S4 命中时，它产出的清洗帧从缓存条目里回到 `ctx`，所以 S5 的键与当初那次运行**逐字节一致**。
   （没有这条，换一个进程再跑，S4 命中而 S5 的键对不上——第二次运行就不会是零执行。）

目录：`<repo>/.studio-cache/<段>-<段名>/<key>/{meta.json, 产物}`。命中时**重新校验产物哈希**，
被手改过的条目算 miss（不是撒谎）。缓存是消耗品：删掉只花时间，不丢数据（`node bin/pipeline.js cache clear`）。

**plan 与 run 同源**：两者走同一个解析器（`resolvePlan` / `stageKeyFor`），plan 打印的就是 run 将要做的。
plan 里标 `将执行（上游变更）` 的段，是它的上游要重跑、产物字节还不可知的段——ComfyUI 也是这个说法。

---

## 3. 接收（intake）：交付物门禁

`lib/pipeline/intake.js`（与 `bin/agent.js intake` **共用同一套纯函数**，两个门不会漂移；
加固来源：commit `ea79c94 fix(studio): harden the intake door against hostile delivery names`）：

| 检查 | 码 | 规则 |
|---|---|---|
| 命名 | `INTAKE_UNSAFE_NAME` | 纯文件名：字母/数字开头，`[A-Za-z0-9._-]` 续，**无路径分隔符、无前导 dash/空格**（`-x.mp4` 会被 ffprobe/ffmpeg 当选项——门禁就是防线，`--` 对这个 ffprobe 不是可用终止符） |
| 包含性 | `INTAKE_FILE_ESCAPES_DIR` | 必须解析在交付目录内**且是普通文件**（符号链接指到外面 = 走私） |
| 类型 | `INTAKE_BAD_TYPE` / 命名闸 | 视频 `mp4/mov/webm/mkv`，帧 `png` |
| 大小 | `INTAKE_TOO_LARGE` | 视频 ≤ 64 MiB，图像 ≤ 8 MiB |
| 尺寸 | `INTAKE_TOO_SMALL` / `INTAKE_TOO_BIG` | 短边 ≥ 240，长边 ≤ 4096（PNG 现场解码，视频走 ffprobe） |
| 时长/帧率 | `INTAKE_TOO_SHORT` / `_TOO_LONG` / `_FPS_OFF` | 2–20s，12–60fps（~24 建议） |

视频交付的**绿幕深分析**（首尾帧绿幕占比/主体占比/边距/脚线）留在 `bin/agent.js intake`——
它需要 ffmpeg 抽帧，属于生成交接那一层。本门禁回答的是"这份交付物是否**形态合格**，可以进链"。
**被拒的交付物会写进分诊队列并停链**（exit 1），红单不带着往下走。
接收记录落 `content/build/intake/<action>.json`。

帧交付（目录里是 PNG）通过门禁后**成为链的输入帧**；视频交付只过门禁（抽帧归生成方，R5）。

---

## 4. 分诊（triage）：队列 + 状态机 + 3 次上限

队列文件：`content/build/triage/<actionId>.triage.json`（工具输出，gitignored）。每条entry回答四个问题：

```
哪一步失败的（stage）· 什么原因（code + reason + findings）· 建议怎么改（fix）· 已经花了多少预算（attempts/maxRetries/runs）
```

状态机（两态一边）：`open --resolve(id, note)--> resolved`。
`resolve` **必须带 note**（"改了什么的"没有说明的解析不是记录）；重复解析、解析不存在的 id 一律失败（fail closed）。
同一 (stage, code) 的再次失败**长在同一条 entry 上**（attempts/runs 增长），不会堆重复项。
某天这一关过了，`autoResolve` 自动关掉它的 open 项并注明 "auto: stage passed on re-run"——没有静默丢弃，每次状态迁移都落盘。

**自动重试上限 3 次**：一段失败且 finding 有已知修法时，编排器应用**一个**参数变化并**回退到修法所在的段**重跑
（修法常常不在报错那段上：QC 门看见残留，抠像清掉它——所以回退是必须的，不是可选优化）。
修法只有在**它的段属于本次链、且在失败段之前**时才作数。每个失败段最多 `1 + maxRetries` 次执行
（默认 `maxRetries=3` ⇒ 至多 4 次），仍不过 → 挂队列、下游段标记 `blocked`、退出码 1。**绝不无限重试，绝不静默放行。**

---

## 5. 入账（`.params.json`）：每次生成/转换调用落一份

台账：`content/characters/<characterId>/provenance/generation/<actionId>.params.json`
（追加式，唯一写入口是 `lib/provenance.js` 的 `writeParamsRecord`；`lib/pipeline/params.js` 是调用方）。

一条 call 记录的**必备字段**（`REQUIRED_CALL_FIELDS`，缺一即拒）：

| 字段 | 含义 |
|---|---|
| `tool` + `toolVersion` | 哪个实现跑的（名字会腐烂，版本才能比） |
| `agent` | 执行者身份（`--agent` / `STUDIO_AGENT_ID`，默认诚实写 `studio-cli`） |
| `command` | **一键复现命令**（`report` 原样打印） |
| `recordedAt` / `kind` | 时间 / `image`\|`video`\|`frame-sheet` |
| `params` / `seed` | 全部参数与随机种子 |
| `inputs[].sha256` / `outputs[].sha256` | **输入/输出文件的内容哈希**（只给路径时现场算；文件不在又没给哈希 ⇒ 拒绝，绝不编） |
| `promptHash` | 提示词默认只存 sha256（`--store-prompt-text` 才存原文） |

- **去重**：同 tool+版本+参数+输入输出哈希的调用**不重复入账**（内容寻址的幂等），改一个字节才新增一条。
- **脱敏（红线）**：写盘前对**即将落盘的字节**跑形状扫描（`lib/scan.js`：`sk-` / `Bearer` / `token=` / cookie / api_key 赋值…）。
  命中 ⇒ `SECRET_SHAPE_REFUSED`，**一个字节都不写**，报错只给指纹（前 4 位 + 长度 + sha256 前缀），绝不回显值。
  测试用"片段拼装"的假密钥锁住这条（`studio/**` 自身也被同一条扫描覆盖）。
- **谁在写**：`agent.js intake`（生成调用）· `pipeline run` 的每个**执行过的转换段**（S4/S5/S6/S7）·
  `provenance.js record`（手工补记）。S8 的入账是发布台账自己（`content/characters/<id>/provenance/<ISO>-<action>.json`）。
- **默认策略（诚实边界）**：`--record-params` 显式开；沙箱树（`STUDIO_CONTENT_DIR` 指向副本）自动开；
  **仓库自己的 content 树默认不落转换入账**——保持 passport 套件"真实树只读"的纪律，
  也保持"没有真实生成就没有台账"的口径。真实树上要落账就显式加flag。

## 6. 复现与校验（provenance 侧）

```bash
node bin/provenance.js report walk-left --text
```

```
generation  traceable
    · 最近一次调用：studio/lib/pipeline/stages.js#S6 @ dsh-studio@0.1.0 · 执行者 codex-cli · 2026-10-12T…
    · 一键复现：node studio/bin/pipeline.js run walk-left --only S6 --params {"footLine":296}
latest generation call:
  tool / executed by / at / params / inputs (n files, hashes…) / outputs (n matched on disk)
  reproduce:   < recorded command >
reproducible: yellow        # 红黄绿：任一段 lost 或 red finding ⇒ 红
```

`verify` 现在同时校验**台账哈希链**：每条记录的 outputs 与在盘字节逐条比对，
`matched / tampered / unresolved` 分开计数——**篡改一个已入账的输出文件，`verify` 立刻变红**（`counts.tampered`、`hashChain.outputsTampered`）。
"路径不在盘"（文件被搬走）是黄（`traceable-in-history`），"路径在盘但字节不对"是红（链被改过）。

为了让"同路径不同字节"只意味着篡改，转换段的产物落在**内容寻址暂存目录**：
`content/build/pipeline/<action>/<段>-<key前12位>/`——参数不同落不同目录，旧记录的输出哈希永远对得上自己那一份字节。

---

## 7. 端到端行为（真实历史素材）

- **b 系列（在产素材，15 帧）**：全绿通过（黄色建议项如 `qc.motion-stall` 只报告不阻断）。
- **退役的 C 卡（walk-left-c01/c02/c04/c05，c03 被等分切掉）**：`qc.frame-gap` + `qc.safe-margin` +
  `qc.bbox-jitter` + `qc.motion-irregular` 全部复现并给出修法；判定黄，不阻断（建议项）。
- **gen-1 水洗线（walk-left-01..04）**：S4 修复后清洗帧零残留、QC 门转绿。
  **已知限制（记录在案，不粉饰）**：归一化的重采样会在个别帧的鞋线下**重新生成一行很淡的 alpha**（实测 walk-left-04.png，1 行 α51）；
  QC 门跑在清洗帧上（S5 在 S6 之前），看不见入包后的字节。修它属于归一化器（`src/workbench/lib/normalizer.js`，产品侧只读），不属于本链。
- **必挂素材（构造）**：一张全不透边帧 ⇒ `qc.opaque-background` 红 ⇒ 按 FIX_TABLE 回退重试 3 次（参数修不了"没有 alpha"）⇒
  挂队列（attempts=4/3）⇒ `triage resolve` 后重新入链。

## 8. 目录与边界

```
studio/lib/pipeline/stages.js       S0–S8 注册表（consumes/produces/paramKeys/run）
studio/lib/pipeline/orchestrate.js  plan/run 同源解析、回退重试、分诊挂钩、内容寻址暂存
studio/lib/pipeline/cache.js        内容寻址缓存（键/条目/校验/清理）
studio/lib/pipeline/intake.js      交付门禁（命名/包含/类型/大小/尺寸/时长）
studio/lib/pipeline/triage.js      人工分诊队列（JSON + 状态机）
studio/lib/pipeline/params.js      .params.json 入账（字段完整/去重/脱敏/复现命令）
studio/bin/pipeline.js             CLI：qc / check / plan / run / triage / matte / encode / cache / providers
```

纪律不变：不直接写 `content/**`（入账走 `writeParamsRecord` 追加事务，入包走发布内核）；
不改 `src/office/**` 语义；不新增 npm 依赖；密钥绝不入库/入日志/入导出物（写盘前形状扫描）。
