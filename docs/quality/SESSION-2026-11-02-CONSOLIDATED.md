# 2026-11-02 会话整合：做完的、修掉的、还缺的

> 替代此前 14 份分散的 `*-2026-11-02.md` 记录。
> 详细过程见 git log（提交信息里保留了每一步的推理与实测数据）。

## 0. 这次会话到底完成了什么

按**用户能感知的价值**排序，不按开发顺序：

| # | 成果 | 用户能感知 |
|---|---|---|
| 1 | **Mission 能启动工作了**（「交给团队」） | ✅ 强 |
| 2 | **能看到 Agent 在跑、说了什么**（进度自动刷新 + 回复预览） | ✅ 强 |
| 3 | **性能真实提升**（热路径 3539ms→2ms；内存 -272MB） | ✅ 中 |
| 4 | **代码结构改善**（renderDetail 735→237 行） | 间接 |
| 5 | 待办两层分类 / 团队任务 / plan-review 折叠 | 中 |
| 6 | 产物收获（从回复里登记真实文件） | 中 |
| 7 | 磁盘清理 2.7GB | 间接 |

## 1. 最严重的那个问题，以及它暴露的判断失误

### 用户的批评

> "我创建了一个 mission，然后呢？没有反应了，我不知道下一步做什么。
> 我们上面进行了约 50 轮对话，到底做了什么？"

### 查证结果

**29 个 Mission action 里，0 个能让 Agent 开始工作。**
全部是 `list/get/create/record*/update*/link*` —— 记录、查询、关联。

### 我的判断失误（要记住）

我在文档里写过：

> "委托任务给 Lead 需要 API，grep `team/spawn` → 0"

**这个推理漏了一步**：`session/prompt` 就是那个 API。
我们**已经在用**它（Brief 验证探针里就是），`harness-rpc.js:383` 也早就实现了。

**把"没有专门的 API"误判成"做不到"，而通用 API 一直都在。**

### 教训

> 审计功能时不能只问"这个模块接线了吗"，
> 还要问"**用户打开产品后能做什么**"。

## 2. 关键能力：Mission → Agent 的真实链路

### 验证到了什么程度（四层，缺一不可）

| 层 | 能证明 | 不能证明 |
|---|---|---|
| 单元测试 | 参数校验、逻辑分支 | 真实 runtime |
| UI fixture 探针 | 按钮存在、提示显示 | 后端接通 |
| 隔离 runtime 自检 | 协议可用、Agent 能动 | App 接线对错 |
| **真机用户点击** | **整条链路** | — |

前 50 轮一直只到前两层。11-02 首次做到第四层：

```
02:52:03.933 [mission] startWork: ensureSession runtimeUrl=yes
02:52:03.956 [mission] startWork: prompt runtimeUrl=yes sid=session-a4648c len=140
02:52:28  assistant-stream end: 3 ended, 575 chunk(s)
02:53:10  assistant-stream end: 9 ended, 2164 chunk(s)
```

**23 毫秒送达，2164 个 chunk 产出。** 绑定确认：
`mis-b437fbdd068d → session-a4648cbc-…`（正是用户截图里那个 Mission）。

### 实现要点

- 新增 `startWork` action：拿/建会话 → 把「任务 + Mission 目标/约束」发过去 → 绑定
- 会话绑定存 `<workspace>/.dsh/mission-sessions.json`（0600 原子写）
  - **不进事件日志**：这是本机执行绑定，不是项目事实（同 lastSeenAtMs 的理由）
- `workStatus` 从投影读真实进度：`sessionStats.turns/steps` + `turnOutline[].response`
- **`turnOutline[].response` 是准确的"完成"信号**——官方注释明确它「commits at turn/end」

## 3. 性能：两个真实 bug + 一组 A/B 数据

### 3.1 解析缓存永不生效（最严重）

**症状**：日志里 `collectStats recompute took 8602ms / 7498ms / 2603ms`

**根因**（两个叠加）：
1. `parseCache` 上限是 **100**，而本机有 **102 个会话文件** → 一开机就超过，每次都在淘汰
2. 逐个淘汰（`if size > 100 delete one`）→ 容量被钉死在 100

**A/B 实测（同一份真实会话树）**：

| | 冷 | 热 |
|---|---|---|
| 修复前 | 3503ms | **3539ms** ← 缓存完全无效 |
| 修复后 | 3706ms | **2ms** ← 1769× |

**修复**：上限 100 → 1024，淘汰改为批量（一次腾 25%）。

### 3.2 并发重复计算

**症状**：同一毫秒两次重算（8838ms + 2838ms）——两个调用者同时发现缓存过期。

**修复**：in-flight 去重（非强制调用搭车）。日志出现 `joined an in-flight recompute`。

### 3.3 动态背景节流（内存）

原来 3 个视图硬编码 `backgroundThrottling: false`，理由是"后台也要保持推送"——
**但那是推测**，代价是所有视图即使不可见也全速跑定时器/动画/渲染循环。

Electron 37 支持动态切换。改为按可见性设置。

**A/B 实测（启动后 55s 稳态，同机同配置）**：

| 版本 | 总内存 | 主进程 |
|---|---|---|
| 基线 | 1660 MB | 672 MB |
| 节流版 | **1463 MB** | **400 MB** |

**主进程 -272MB (-40%)，总内存 -197MB (-12%)。**

### 3.4 内存不是泄漏

连续 80s 采样：1749 → 1750 → 1753 → 1755 MB。**稳定不增长。**
启动期有峰值（约 1955MB）后回落。所以优化方向是"降低稳态"，不是"修泄漏"。

## 4. 代码结构：用第一性原理消除重复

### 4.1 renderDetail 735 → 237 行（-68%）

它一个函数扛 17 个区块。这是高内聚的典型反面。

**发现/假设/证据三者结构同构**（状态徽章 + 正文 + 元信息 + 状态推进 + 就地表单），
之前是**三份几乎相同的 80 行**（共 219 行），而且已经漂移过：
假设有 3 个状态转移，发现只有 2 个。

改成 `renderEntitySection(cfg)`：**差异做成参数，共性做成实现**。219 → 62 行。

其余区块独立：`renderDecisions` / `renderOpenQuestions` / `renderWorkstreams` /
`renderTaskRefs` / `renderDeliverables` / `renderBriefAndDiagnostics`。

`renderDetail` 现在只做编排。

### 4.2 重构暴露的可测性退化

重构后 action-parity 测试红了 5 项——它用正则 `api('xxx')` 扫描源码，
而 action 名变成了配置参数（`apiAction: 'updateFindingStatus'`）。

**这不是放宽标准**：补上配置形式识别后做了变异验证——删掉整个"发现"配置块，
测试**准确报出** `updateFindingStatus` 缺 UI。

## 5. 工程教训（本轮最重要的三条）

### 5.1 假测试：断言必须精确到"为什么"

做「产物收获」时第一版测试**变异验证什么都抓不到**。

**假测试 1**：只断言"被跳过"。
`fs.statSync` 抛异常 → `stat=null` → 后面 `readFileSync` 也失败 → `digest=null` → 仍走 skipped。
**删掉 stat 检查，测试照过。**

修：断言精确到原因 `'file not found in workspace'`。

**假测试 2**：只断言"没登记"。
schema 层会拒绝非法 relPath，即使 filter 被删掉结果还是"没登记"。

修：断言 `mentionedTotal`，证明它在**处理前**就被过滤。

> **断言必须精确到"为什么"，不能只看"结果是什么"。**
> 当系统有多层防线时，"结果正确"可能来自任何一层。

### 5.2 "脚本没报错" ≠ "改动生效"

第 4 项（plan-review）第一次写 hook 时，python 第一个 `assert` 失败了但没打印，
我误以为成功。后面单独插函数成功了，结果**函数存在、调用点不存在**。
是验收探针立刻红了 4 项才发现的。

### 5.3 用户感知的反馈不能只写在代码里

「交给团队」第一版：先显示"已交给团队" → 再 `loadDetail()` 刷新
→ **刷新重建 DOM，把成功提示冲掉了**。

工作真的发出去了，但**界面看起来毫无反应**——正是用户抱怨的症状。
真机验收 2 项红才发现。

## 6. 现在还不完整的（按优先级）

### 🔴 高：Agent 产出不会自动进 Mission

现在用户要手动点「核对并登记产物」。中间产物要不要登记？
如果 Agent 跑 5 轮每轮都产文件，全登记会让 Mission 塞满垃圾。

**需要先决定策略**（只登记最后一轮？只登记用户确认的？）。

### 🟡 中：Work Receipt 状态机缺失

无法标记"已验收"。`verification-profile.js` 只做了数据模型（含 stale 机制），
但没有 UI，也没有 Runner（在 Electron 主进程跑任意命令风险太高）。

### 🟡 中：右栏信息架构需要重新设计

**这是用户明确表示最不满意的部分。** 见 §7。

### 🟢 低：其他

- 一个 Mission 只能绑一个会话
- 进度只显示最后一轮（多轮历史要切 Harness）
- 跨 Team 依赖不支持（官方 `blockedBy` 只在 Team 内有效）
- team profile 未在生产启用（experimental，UI 已能在缺 key 时正确降级）
- Windows 真机验收（用户说先打磨 Mac）

## 7. 右栏：当前状态与需要重新思考的问题

### 现状（17 个区块竖排）

```
待办 L1 → 离开期间 L2 → 交给团队 → 团队任务 → 状态 → 实时
→ 目标 → 边界 → 决策 → 发现 → 假设 → 证据 → 未决问题
→ 工作流 → 关联执行 → 产物 → Brief → 诊断
```

### 核心问题

**它仍然是"把所有东西都列出来"。** 即使做了：
- 两层待办分类（决策 vs 提醒）
- 「交给团队」置顶
- 折叠 plan-review

用户仍然要滚十几屏。**信息架构没有回答"我现在该看什么"。**

### 待用户决策的设计方向

1. **默认视图是"现在"还是"全景"？**
   — 「现在该做什么」置顶，其余折叠进"全部信息"？
2. **17 个区块能不能压到 5-7 个一级入口？**
   — 按"现在 / 团队 / 记录 / 设置"分组？
3. **Mission 与 Harness 的关系要不要更直接？**
   — 右栏是"遥控器"（操作 Mission、看进度）还是"档案柜"（记录一切）？
4. **多 Mission 时右栏怎么工作？**
   — 现在 dock 是单 Mission。多个并行 Mission 怎么办？

**这几个问题需要用户先定方向，不该由我继续猜。**

## 8. 这轮做了什么（文件级）

### 清理
- 删除 2.7GB 无关产物：`vendor/`(900M 旧 runtime 副本)、`evidence/`(266M)、
  `output/`(80M)、`archive/`、`photo/{new output,new output-clean,output}`(1.4G)
- 项目从 4.0G → 1.3G

### 重构
- `src/mission-desk.html`：renderDetail 735 → 237 行
- 新增 `renderEntitySection` / `renderEntityForm` / `renderDecisions` /
  `renderOpenQuestions` / `renderWorkstreams` / `renderTaskRefs` /
  `renderDeliverables` / `renderBriefAndDiagnostics`

### 性能
- `src/token-stats.js`：PARSE_CACHE_MAX 100 → 1024，批量淘汰
- `src/main.js`：collectStats in-flight 去重
- `src/window-manager.js`：动态背景节流

### 新增能力
- `src/ipc-mission.js`：`startWork` / `workStatus` / `bindSession` /
  `getBoundSession` / `harvestDeliverables`
- `src/mission/verification-profile.js`：可信验证模型（含 stale 机制）
- `src/mission-desk.html`：交给团队 / 进度自动刷新 / 回复预览 / 产物核对 /
  plan-review 折叠 / 两层待办

### 测试
- 全量 **2984 passed / 0 failed / 1 skipped**
- 真机探针 10 个，约 130 项检查
- 新增：`token-stats-cache` / `mission-harvest-deliverables` /
  `verification-profile` / `team-projection-contract`
- 每个新测试都做了**变异验证**
