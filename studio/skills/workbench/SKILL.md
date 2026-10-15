---
name: office-studio-workbench
description: 给「虚拟场景创作工作台」（本仓库的 studio/）做第一批内容与场景开发：摆家具、改动作帧序与时长、写台词、改行为图、跑校验；人在工作台里做微调。当任务涉及本仓库的 content/**（场景、角色动作、对话文案、行为图）或要把 AI 产出的改动落进工作台时使用。
---

# 工作台开发（给外部编码代理）

这个仓库里有一个**人类用的内容工作台**（Electron 应用，`studio/`）和它的**命令行镜像**（`studio/bin/agent.js`）。
分工是刻意的：

- **你（代理）做第一批**：读代码/资产 → 用命令**试算** → 看清楚要改什么 → 落实 → 跑校验。
- **人在工作台里微调**：打开 `npm run studio`，在画布/时间轴/表格上拖一拖，按 ⌘Z 撤销，用检查器改数值。

你的价值在于"把该改的都改对"，人的价值在于"好不好看、顺不顺手"。**不要**替人做审美判断，也不要点上线。

## 一、先读这些（按顺序，都是真源）

1. `studio/docs/handover.md` —— 目录地图（**哪个目录是工作台、哪个是文档、哪个只读**）、硬约束、已有能力、缺口清单。**先读它的 §2 目录地图**，避免改错地方。
2. `studio/docs/contracts.md` —— 数据契约（动作文档、场景布局、语料、行为图、画布窗口、撤销/会话）。
3. `studio/skills/workbench/reference/operations.md` —— **可用操作清单**（由命令生成，永远与代码一致）。
4. `studio/docs/architecture.md` —— 分层与边界（工具 vs 产品运行时）。

## 二、心智模型（30 秒）

- **内容**在 `content/**`：`characters/<id>/{actions/*.json, assets/**, dialogue/**, character.json}`、`scenes/<id>/{layout,scene,zones}.json`、`graphs/*.vgraph.json`。
- **工作台有六个页面**（`src/workbench/` 是界面）：场景（摆家具）· 动作（帧序/时长）· 行为（图）· 语料（台词）· 质检（校验报告）· 观测（跑仿真）。人可能在任何一页，**你改的都是同一份内容**。
- **一切写入都过一次校验事务**：试算（`save:false`）→ 校验 → 字节备份 → 写。你的命令走的就是这套；**永远不要直接写 `content/**` 的文件**。

## 三、你的工作循环

```bash
cd /Users/xia/program/dsh/DshCockpit-s1/studio

# 0) 先看现状：能不能做、有没有红灯
node bin/agent.js capabilities                 # 可用操作（也可 --json 给程序读）
node bin/agent.js check --domain all           # 校验器的分组结果；有红项时退出码 1

# 1) 试算：打印"人话 diff"，一个字节都不写
node bin/agent.js diff --domain scene --op move --params '{"itemId":"draft-27","position":{"x":0.4,"y":0.5}}'

# 2) 落实：同一个操作真跑（校验通过才写，先做字节备份）
node bin/agent.js apply --domain scene --op move --params '{"itemId":"draft-27","position":{"x":0.4,"y":0.5}}'

# 3) 复核
node bin/agent.js check --domain scene
node bin/agent.js log --n 10                   # 你刚刚做了什么（人也能看）
```

退出码：**0 = 通过/已写入 · 1 = 被拒绝或校验有红项（原因已打印）· 2 = 用法错误**。
被拒绝时**不要**换一条"绕过校验"的路——把校验器给的理由转述出来，或换个合法值再试。

## 四、五条硬规矩

1. **不绕过事务**：不直接写 `content/**`、不改 `resources/**`（生产包只由工作台的「发布」动作更新）。
2. **不碰产品运行时**：`src/office/**` 是只读依赖（语义冻结）；改它需要单独一轮 + 回归测试，不在开发任务里顺手做。
3. **密钥**：只从环境变量/本地 secrets 读，**绝不入库、进日志、进导出物**；不要打印任何 key。
4. **一次一件事**：改完就 `check` + 提交；**不要**把"顺手重构"混进内容改动。
5. **不删素材**：`photo/**` 与历史素材只读引用。

## 四点五、生成新素材：视频由**你**生成，工作台接着做（R5）

工作台**不持有**视频生成的 key，也不替你选模型——生成这一步交给你的代理，因为各家协议/返回方式都不同。
分工写在 `reference/generation-handoff.md`（由工作台自己的配方生成）：

1. **先读配方**：`node bin/agent.js prompts --action <动作> [--direction left] [--json]`
   —— 输出一段可直接照抄的提示词，加上护栏（绿幕 / 无纵深词 / 脚锁锚点 / 首尾同站姿 / 道具闭环 / 10% 边距）、
   按秒分节拍与负面词。这些与工作台内部会用的配方**同一来源**。
2. **用你手上的任何模型生成**，产出 640×360 级、~24fps、10 秒级的**绿幕原片**（不要自己抠像）。
3. **交付**：`content/incoming/<动作>/<文件名>.mp4`（该目录已 gitignore）。
4. **交接一条命令**：
   ```bash
   node bin/agent.js intake --dir ../content/incoming/<动作> --action <动作> \
     --model "<模型名>" --prompt-file <提示词文件> --seed <n>
   ```
   它探测规格、取首尾帧算绿幕/主体/边距/脚线，**把生成参数写进素材台账**（过去"参数从未入账"的断点），
   并把接收记录写到 `content/build/intake/<动作>.json`。**有红项＝退出码 1，不算接收**。
5. **然后工作台接手**：`pipeline.js matte` → `qc video` → `run --action <id>`（内容寻址缓存，改一步只重跑一段）
   → `actions.js publish`（校验全绿才写包）；或在工作台界面里走质检页 → 危险操作区发布。

> 旧的"在工作台里直连生成"路径（`node bin/pipeline.js providers`，模型↔key 严格对应、缺 key 即拒）
> 仍然可用，但它是**备用路径**，需要 key 且要自己核验商用条款。

## 五、常见任务（照抄即可）

**摆/挪家具**（改完必须同步碰撞区，否则场景检查会红）
```bash
node bin/agent.js diff  --domain scene --op add --params '{"asset":"flat-sofa","position":{"x":0.5,"y":0.45}}'
node bin/agent.js apply --domain scene --op add --params '{"asset":"flat-sofa","position":{"x":0.5,"y":0.45}}'
node bin/agent.js apply --domain scene --op sync-zones --params '{"write":true}'
node bin/agent.js check --domain scene
```

**调帧序 / 帧时长**（帧序＝数组顺序，不是文件名）
```bash
node bin/agent.js apply --domain action --op reorder  --params '{"actionId":"walk-left","from":2,"to":0}'
node bin/agent.js apply --domain action --op duration --params '{"actionId":"walk-left","index":3,"durationMs":120}'
```

**加一句台词**（先看 topic 有哪些：`node bin/dialogue.js list`；**一次命令就写完**，守卫先跑，红则拒绝）
```bash
node bin/agent.js apply --domain dialogue --op add --params '{"topic":"pantry","text":"米缸还有半缸","weight":2}'
# 条目 id 会自动生成（稳定：同 topic+同文本 → 同 id）；改/删可以只给 id，工具自己找 topic
node bin/agent.js apply --domain dialogue --op update --params '{"id":"pantry-3f9a1","text":"新的台词"}'
node bin/agent.js apply --domain dialogue --op remove --params '{"id":"pantry-3f9a1"}'
# 想先不写盘：加 "stage": true（只在内存里暂存，给 --json 的批量调用用）
```

**改行为图**（图文件在 `content/graphs/`；先 `node bin/graph.js validate <file>`）
```bash
node bin/agent.js apply --domain graph --op save --params '{"file":"local-behaviour.vgraph.json","graph":{...}}'
node bin/graph.js run content/graphs/local-behaviour.vgraph.json --steps 40   # 跑一遍看轨迹
```

## 六、人接手时，他要看什么（你收尾时要保证）

- 工作台里**六个页面的"检查器/问题栏"能看到你的改动与遗留问题**：跑一次 `node bin/agent.js check --domain all`，
  红项要么修掉，要么在交付说明里点名（人不会自己去找）。
- **每一处改动都能被撤销**：工作台的撤销栈覆盖场景布局（⌘Z）；动作/语料/图的改动走的是各自的备份，
  恢复命令在 `studio/docs/contracts.md`。
- **给人留一句"接下来手动微调哪里"**：例如"沙发位置我放在 (0.5,0.45)，你在画布里拖一下更合适"。

## 七、验证与证据

```bash
cd studio && npm test                                    # 231 项，改动前后都要绿
cd .. && npm test                                        # 产品侧 1244 项（若你碰了 src/office 之外的共享代码）
STUDIO_EVIDENCE_DIR=../evidence/studio-<你的阶段> npm run studio   # 真壳探针（~2 分钟），输出 STUDIO_EVIDENCE_OK
```
- **探针会写内容并还原**：如果它失败，先看 `evidence/studio-<阶段>/results.json` 的 `error`/`lastStep`，
  再确认 `git status --short content/` 为空——**内容残留是你的责任**（探针的还原规则见 `studio/docs/contracts.md §20`）。
- 证据目录在仓库内 `evidence/<阶段>/`（已 gitignore，不要提交截图）。

## 八、不要做

- 不要新增 npm 依赖（`studio/package.json` 的 dependencies 保持为空）。
- 不要改界面结构后**不同步测试**：`studio/test/boundary.test.js` 钉住了元素 id 契约与 i18n 键集。
- 不要为了让套件变绿而注释掉断言。
- 不要 promise「零人工」或替代人做验收：你交付的是**可被工作台复现的改动**，不是"上线"。
