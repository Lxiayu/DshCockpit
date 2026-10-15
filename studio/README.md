# Office Studio — 虚拟场景创作工作台

> 一句话：**一张参考图 + 一段提示词 → 一整套可用素材**（多方向行走/待机/工作/休息/小憩/说话 + 家具道具 + 布局草稿 + 对话语料），
> 每一步**可复现、可回退、只重跑变更部分**，并有**自动质检报告**证明这套素材可用。
>
> 鲸鱼娘办公室是第一个用例；目标形态是通用创作画布。**诚实边界见 §5**——不承诺"任何一张图零人工出整套"。

## 1. 跑起来

```bash
cd studio
npm run studio          # 打开工作室（Electron 窗口；自己的 .studio-data/ 用户目录）
npm test                # studio 自己的测试套件（纯 Node + 1 个真壳引导测试）
npm run provenance -- report walk-left     # 素材护照：这套素材怎么来的、能不能复现
node bin/dshpack.js info                   # 项目概览（project.json + 内容 digest）
node bin/dshpack.js roundtrip              # 导出→导入→逐文件 sha256 比对（P1 验收）
node bin/dshpack.js export --out /tmp/whale.dshpack
node bin/dshpack.js import --dest /tmp/restored /tmp/whale.dshpack
node bin/scene.js report                    # 场景冲突校验（有阻断项时 exit 1）
node bin/scene.js waypoints                 # 派生航点图（区域 → 格点图 + 标签 + 入口）
node bin/scene.js sync-zones                # 试算：布局 vs zones.json 的漂移
node bin/scene.js sync-zones --write        # 重建障碍（先备份，无变更不落盘）
node bin/actions.js list                    # 动作清单（schema/帧数/标签/批注/是否在包内）
node bin/actions.js bench walk-left         # 审片台数据：逐帧鞋线/可见框/质心/中位
node bin/actions.js gaps                    # 能力缺口检查（含"怎么补"）
node bin/actions.js migrate --all           # v1 → v2（先备份，无变更不落盘）
node bin/actions.js annotate --action walk-left --frame 2 --text "裙摆被裁" --severity fix
node bin/actions.js publish walk-left       # 真发布内核（校验全绿 → 备份 → 写包 → 记 provenance）
node bin/pipeline.js check walk-left        # 帧 QC：鞋线/高度/抖屏/水洗/边距/重帧/跳帧（有红灯 exit 1）
node bin/pipeline.js qc video <clip> --expect-fps 24
node bin/pipeline.js plan walk-left         # 生成链计划：会跑哪些/哪些命中缓存/为什么（不执行、不写盘）
node bin/pipeline.js run walk-left          # 命令链：接收→QC→分诊→归一化→入包（改一步只重跑那一段）
node bin/pipeline.js run walk-left --plan | --force | --only S4,S5 | --no-publish | --params '{"packCanvas":384}'
node bin/pipeline.js run walk-left --dir ../content/incoming/walk-left   # 先过交付门禁（恶意/畸形文件名即拒）
node bin/pipeline.js triage list [--status open]      # 人工分诊队列：哪步/什么原因/建议怎么改/已重试几次
node bin/pipeline.js triage show <id>
node bin/pipeline.js triage resolve <id> --note "改了什么"   # 解析后重新入链
node bin/pipeline.js matte <png> --out <png>  # 抠像后处理（顺序写死：unpremultiply→harden→去近黑→鞋线以下清空）
node bin/pipeline.js encode --frames <dir> --out <webm>   # VP9-alpha（实测 alpha 平面）
node bin/pipeline.js cache stats            # 内容寻址缓存（可清理：删掉只花时间）
node bin/pipeline.js providers              # 模型↔密钥与指纹（永不打印密钥）
node bin/graph.js validate content/graphs/local-behaviour.vgraph.json   # 行为图校验（闭集/端口/环）
node bin/graph.js run content/graphs/local-behaviour.vgraph.json --steps 20
node bin/graph.js diff content/graphs/local-behaviour.vgraph.json      # 与 behavior-scheduler 的差异报告
node bin/atlas.js pack --format webp    # 74 帧 → 1 张图集（PNG 持平、WebP 1.52× 更小、纹理数 74→1）
node bin/graph.js feel                     # 手感参数与曲线（挤压/落地/淡入/位移）
node bin/video.js plan walk-left           # 这条动作该走帧轨还是视频轨（带理由）
node bin/video.js encode walk-left         # VP9-alpha 640×360 24fps（解码验证 alpha）
node bin/video.js probe <clip.webm>        # Chromium 实测 alpha（权威读数）
node bin/video.js ab walk-left             # A/B：体积/节奏/alpha + 手感层，输出报告与截图
```

仓库根仍可跑旧入口（同一套实现，两个入口）：`npm run office:workbench`。
右侧「护照」面板是同一批服务：项目摘要 · 五段护照表 · 生成参数台账 · 往返校验 / 导出 / 导入按钮
（旧入口没有 `studio:*` 服务，面板会说明而不是半途报错）。

**现状**：P0 = 骨架 + 内核整合 + 契约文档 + 素材护照与参数台账；P1 = 项目模型（`project.json`）+
`.dshpack` 导入导出（真资产往返哈希不变）+ 护照面板；P2 = 场景冲突校验（工作位悬空/家具重叠/入口被堵/障碍漂移
全被拦住）+ 派生航点图 + 障碍一键重建 + 「场景」面板（摆放仍用预览场里的产品编辑器）。
P3 = 动作 schema v2（标签 / ping-pong / 事件帧 + 迁移）+ 审片台（逐帧 · 脚线/质心可视化 · 洋葱皮 · 并排 · 帧号批注 + 导出 JSON）
+ 能力缺口检查 + v2→运行时 v1 的**显式编译降级**（`runtime.dropped` 带原因，不静默丢失）。
P4 = **流水线核心**：S0–S8 各段（本地段真跑：S0 参考规范、S4 抠像后处理、S5 帧/视频 QC、S6 归一化、S7 alpha 编码、S8 入包）
+ 内容寻址缓存（改一步只重跑那一段）+ provider 门禁（模型↔密钥，缺 key 即拒、计划可缓存）+ QC 编排与人工分诊。
用**真实历史素材**复现了三代缺陷（水洗线 / C 卡缺帧与越界 / 走位跳帧）并给出修法。
P7（第一半）= **对话语料库**：两层（基础库 + 角色覆盖，覆盖优先、缺失回落）+ 一致性守卫（12 类问题：id 重复/超长/重复文本/未知占位符/未知条件键/**隐私红线**）+ CSV 批量导入 + 抽签式"说一遍"（同 seed 可复现）+ 「语料」面板与 `bin/dialogue.js`。
**UX** = 可收起的综合工作台（左右栏收起为 40px 轨道，⌘/Ctrl+B/J；右轨即标签切换器）+ IDE 风格文件树（展开箭头/类型图标/尺寸/过滤/全部折叠展开/方向键走位）+ UI 偏好记忆（localStorage，不碰内容）。
**R1 窗口形状重做（2026-09-28，用户提出"太拥挤、中间要空白画布、图能拖进去"）** = 中间是**画布**（编辑层＝布局，
运行层＝产品真实运行时视图，同一坐标系，工具条上一键切换 + 适应窗口）、右边是**一次一个工具的检查器**（四组）,
左边是**素材库（57 件家具，可拖）+ 内容树**。**拖放**：家具图 → 放进布局（走同一套校验事务：试算 → 备份 → 写盘）、
动作帧 → 动作检查、JSON → 对应工具、其它 → 拒绝并说明。**去掉了产品编辑器 chrome**（`?editor=1` 打开的是一个
保存被拒的编辑器；工具链自己的画布就是唯一编辑器）。本轮探针抓到两个真缺陷：运行模式两层全隐藏（`hidden` 属性
与模式 CSS 打架）、刚放进布局的结果被热重载刷新一秒抹掉（结果行现在有粘滞窗口）。
**P8 后半（工作台外壳）** = ⌘/Ctrl+K **命令面板**（一张命令表同时驱动面板与快捷键）+ **可拖拽分栏**（拖动/方向键/双击复位，宽度记忆）
+ **系统化键盘**（⌘B/⌘J 收起两侧、⌘R 重读内容、1–0 切标签）+ **热重载**（内容变化 400ms 去抖后推给窗口，重读面板但**不静默换掉正在跑的仿真**）
+ **页面侧遥测**（向预览页要它自己的事实：渲染后端 / 画布 / 空闲重绘 / 员工数，并随诊断包导出）。
本轮探针抓出并修掉两个**真缺陷**：`onContentChanged` 订在了没有该通道的 bridge 上（热重载静默失效）、
运行脚本的结果被面板刷新抹掉（结果改到独立结果行）。UI #2 = **行为图画布**（`.vgraph` 可视化：节点着色 + 端口标签 + 拖动改版面 + 校验/运行/差异报告；保存前先过解释器校验，非法图拒绝写盘、字节备份）。
UI #1 = **场景画布编辑器**（拖拽移动 + 方向键 + 网格吸附 + 隐藏/缩放；改动先暂存，保存时走"重建障碍 → 冲突校验 → 备份写盘"的事务，违规当场拦住）。
P6 = **行为图**：`.vgraph` + **纯解释器在 `src/office/behavior-graph/`（产品可复用同一份）** + 手感层（挤压/镜像/交叉淡入/时间驱动位移）
+ 与 `behavior-scheduler` 的差异报告 + `bin/graph.js`（无图形编辑器面板）。
P5 = **视频直用**：VP9-alpha 编码 + 双路 alpha 验证（libvpx 解码器 / Chromium 实测）+ A/B 探针（体积 11.5×、节奏同 60fps、手感层按播放时间驱动）
+ 轨选择规则；帧轨仍是默认主轨。
**跟进（2026-09-28）**：动作 schema v2 元数据（tags/pingPong/events）**随包发布**（校验器与发布内核放宽，v1 文档逐字节不变），
真实 8 个动作已迁移 v2、四条行走动作带 `walk` 标签并已发布进生产包（严格校验器复验通过）。
**P8 完成度**：图集打包（74 帧 → 1 张，PNG 体积持平 / WebP 1.52× 更小，纹理数 74→1）、双语文案（键集等价有测试卡）、
WCAG 对比度审计、空态、命令面板 / 分栏 / 键盘 / 热重载 / 页面遥测都已落地并进真壳证据。
**仍未做（要如实说）**：图集只到"打包 + 清单"，**未接进运行时**（让 Pixi 用图集渲染属引擎侧改动）；
面板内部的运行态文案仍是中文（外壳已双语）；P7 的语料与预览诊断已可用，但"用行为图替换调度器行为"属引擎语义变更，未做。

## 2. 目录

```
studio/
  main.js                 应用入口（boot + studio:* IPC）
  lib/studio-services.js  能力域服务（P0：info / 护照 / 参数台账）
  lib/provenance.js       五段式素材护照引擎（移植自主仓 scripts/asset-provenance.js）
  lib/scan.js             导出边界密钥形状扫描（命中即拒绝写盘）
  bin/provenance.js       护照 CLI：report | verify | index | lost | record
  docs/main-product-integration.md   《主产品接入说明》：主仓要接什么、怎么接、风险与不要指望的
  docs/                   architecture.md（分层/边界/阶段落点）· contracts.md（数据契约）
                          providers.md（模型×密钥×许可）· provenance.md（护照与台账）
                          generation-loop.md（生成段闭环：命令链契约——段/缓存键/入账字段/分诊语义/复现命令）
  test/                   studio-services / boundary / studio-startup
../../src/workbench/**    工作台内核（两个入口共用：外壳 + app 服务层 + lib 算法内核）
../../content/**          内容工程（角色 / 场景 / 区域 / 语料）——工具写入的源
../../resources/**        生产包（发布动作的同步目标，运行时只读）
```

## 3. 三条纪律（工具不得越界）

1. **工具不进发行版**：`studio/**`、`src/workbench/**`、`content/**` 永不被产品入口引用（边界测试遍历产品依赖图 + 全仓 grep 双重强制）。
2. **产品只读**：工具 import 运行时（`src/office/**`）是单向的；改运行时语义仍走 RED 测试 + 复审。
3. **密钥绝不入库/入日志/入导出物**：key 只从环境变量或本地 secrets 文件读，导出前跑形状扫描（`sk-`/`Bearer`/`token=`/cookie），报告里只出现指纹（前 4 位 + 长度 + sha256 前缀）。

## 4. 素材护照（P0 落地）

```bash
node bin/provenance.js report walk-left     # 五段链逐段状态 + 红黄绿可复现判定
node bin/provenance.js report walk-left --text   # 人读：最近一次调用的参数/输入输出哈希/一键复现命令/红黄绿
node bin/provenance.js verify --json        # 全库逐条（含台账哈希链：篡改已入账输出即红）
node bin/provenance.js index                # 机读索引 → build/provenance-index.json
node bin/provenance.js lost                 # 已知断链 + 恢复锚点
node bin/provenance.js record --action walk-left --model qwen-image-edit --prompt-file p.txt \
  --agent codex-cli --tool-version dsh-studio@0.1.0 --command "..."   # 参数入账（写盘前跑密钥形状扫描，命中即拒）
```

状态词表：`traceable | traceable-in-history | lost | not-recorded`。**不能证明就写 not-recorded**——
`report <id> --text` 会打印**最近一次生成的调用**（模型/工具+版本/执行者/参数/种子/输入输出哈希）与**一键复现命令**；
`verify` 同时校验台账哈希链（记录过的输出字节被改过 ⇒ 红）。
生成调用参数经 `agent.js intake` / `pipeline run` 的转换段 / `provenance.js record` 三处入账
（`provenance/generation/<actionId>.params.json`），写盘前跑密钥形状扫描（`sk-`/`Bearer`/`token=`/cookie 命中即拒）。

## 5. 诚实边界（写在这里，也要写进 UI）

- **"任何一张图稳定产出整套、零人工"做不到**：一致性会漂（复杂服装尤甚）；保留**人工分诊**位（同行 117 段动作人工精修 = 现实成本参照）。
- **生成素材的版权**：纯提示词产出在某些司法辖区不受版权保护；只能承诺 provenance 的人类参与证据链；上传第三方 IP 参考图风险自负。
- **四方向是产品边界**：不做 8 方向 / 3D 转身 / 骨骼蒙皮。
- **每条外部模型路线必须逐个核验商用条款后才进主链**（见 `docs/providers.md`）：主链优先 Apache-2.0 系（Qwen-Image-Edit / Wan2.2-Animate），非商用/受限模型只能作为明确标注的可选轨。

## 6. 给外部编码代理：命令行镜像 + 生成交接

工作台本身给人用；**代理走命令行**（`studio/bin/agent.js`）：

```bash
cd studio
node bin/agent.js capabilities                  # 17 个操作：场景 / 动作 / 语料 / 行为图
node bin/agent.js check --domain all            # 校验结果（按代码分组，红项退出码 1）
node bin/agent.js diff  --domain scene --op move --params '{"itemId":"draft-27","position":{"x":0.4,"y":0.5}}'
node bin/agent.js apply --domain scene --op move --params '{"itemId":"draft-27","position":{"x":0.4,"y":0.5}}'
node bin/agent.js log --n 10                    # 代理动过什么（content/build/agent-log.jsonl）
```
`diff` **一个字节都不写**（有全树摘要测试锁着），`apply` 校验通过才写、先做字节备份。
代理要读的说明：`studio/skills/workbench/SKILL.md`；操作清单 `reference/operations.md` 由命令**生成**（手改会被测试判红）。
发现入口：`.claude/skills/workbench/SKILL.md`、`studio/AGENTS.md`。

**生成视频这块是交接，不是内置**（R5）：工作台**不持有**视频 key、不绑定模型协议。
`agent.js prompts` 给出与流水线**同源**的配方（绿幕 / 无纵深词 / 脚锁锚点 / 首尾同站姿 / 道具闭环 / 10% 边距，
外加分秒节拍与负面词）→ 用户用自己的模型生成绿幕原片 → 放进 `content/incoming/<动作>/` →
`agent.js intake` 探测规格、分析首尾帧（绿幕 / 主体 / 边距 / 脚线）、**把生成参数写进素材台账**（红项即拒）→
工作台从抠像 / QC / 归一化 / 发布接着做。详见 `studio/skills/workbench/reference/generation-handoff.md`。
旧的"在工作台里直连生成"（模型↔key 严格对应、缺 key 即拒）仍是**备用路径**。
