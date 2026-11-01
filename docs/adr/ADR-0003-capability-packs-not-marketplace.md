# ADR-0003：Capability 以「验证过的组合」交付，不做插件市场的替代品

- **状态**：✅ **已接受（用户 2026-11-01 决策：按已记录决策与替代方案继续执行，保留未验证项的 POC 门槛）**
- **日期**：2026-11-01
- **决策者**：用户（待确认）
- **影响范围**：Capability Platform、Starter Kit、Profile Composer、插件/技能市场模块
- **相关文档**：`docs/architecture/capability-platform.md`、`docs/research/capability-providers.md`、`docs/adr/ADR-0001-repositioning-ai-team-workspace.md`

## 1. 背景

新定位要求 DshCockpit 帮助新手**不用折腾底层设施**就能开始工作（Memory / Context / Workspace / MCP / 数据库等）。
用户提示词中提出了 Capability Platform、Capability Packs、Starter Kits、Profile Composer 等概念。

同时，DshCockpit 已有自研的插件市场（`src/plugin-flow.js`、`src/market.js`）与技能市场（`src/skills.js`）。

官方 0.2.x 已提供 `dsh-plugin-manager`、`dsh-plugin-market`、`dsh-plugin-market-index`、`dsh-skill`、`dsh-skill-filesystem`、`dsh-skill-office` 等。

## 2. 问题

**Capability Platform 应该做成什么？** 是"又一个插件市场"，还是别的？

## 3. 第一性原理分析

### 3.1 用户真正的问题

| 用户症状 | 根本原因 |
|---|---|
| "装了一堆插件，不知道哪个能用" | 插件市场只解决**分发**，不解决**验证** |
| "装完就崩 / 缺依赖 / 平台不支持" | 没有任何环节保证"这几个东西组合起来能跑" |
| "不知道该装什么" | 市场是**无限选项**，新手需要的是**有限推荐** |
| "装完不知道怎么用" | 缺少**配套的使用姿势**（prompt 模板、工作流、验证方式） |

### 3.2 关键洞察

> **插件市场解决"有没有"，Capability Platform 解决"能不能用"。**

官方 market 已经解决了"有没有"（`dsh-plugin-market` 提供浏览/安装）。
如果我们也做一个市场，那就是**重复实现 + 与官方竞争分发入口**，违反 ADR-0001。

但"能不能用"是一个**真实未被解决的问题**：
- 官方插件市场不保证组合可用性。
- 官方不提供"针对某类任务的最佳组合"。
- 官方不提供"装完之后的验证与引导"。

### 3.3 因此 Capability Platform 的正确定义

> **不是一个插件仓库，而是「经过端到端验证的能力组合」+「装完之后的成功路径」。**

它的产出物不是"更多插件"，而是**更少但保证能用的选择**。

## 4. 备选方案

| 方案 | 描述 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **A. 自建插件市场** | 与官方 market 同类，我们做更好的 UI | 可控 | 与官方重复；维护成本高；无差异化 | ❌ 否决 |
| **B. 只做文档推荐清单** | 写几篇"推荐装什么"的文档 | 零成本 | 不解决验证问题；文档会过期；用户仍要自己装 | ❌ 否决 |
| **C. 验证过的 Capability Pack + Starter Kit** | 有限数量的、端到端验证过的组合；一键装；装完有引导与验证 | 真正解决用户问题；与官方互补（消费官方插件但提供组合层）；可验证可测试 | 需要真实的验证基础设施；需要持续维护（插件会变） | ✅ **采用** |
| **D. 通用 Provider 抽象框架** | 定义 MemoryProvider/WorkspaceProvider 等接口，让第三方实现 | 架构优雅 | 只有一个实现时是纯负债；违反"不为抽象而抽象" | ❌ 暂缓（见 §7） |

## 5. 决策

**采用方案 C，并对方案 D 做严格约束。**

### 5.1 什么是 Capability Pack

一个 Capability Pack = **一组内容 + 一份 manifest + 一段验证脚本 + 一个成功路径**。

```
capability-packs/<pack-id>/
├── manifest.json          # Capability Manifest（声明依赖、平台、风险）
├── compose.yml            # Profile 组合补丁（官方 cordis.patch.yml 格式）
├── guide.md               # 装完怎么用（面向用户，不是面向开发者）
├── prompts/               # 配套的任务模板
└── verify.js              # 端到端验证脚本（装完必须跑通）
```

**Manifest 草案**：

```jsonc
{
  "schemaVersion": 1,
  "id": "persistent-memory",
  "name": "持久记忆",
  "userPromise": "关闭应用一周后，团队仍记得项目的关键决策",
  "problem": "会话结束后上下文丢失",          // 第一性原理：先写问题
  "capability": "memory",                    // memory | history | workspace | knowledge | verification
  "provider": {
    "kind": "official-package",              // official-package | third-party-plugin | builtin
    "packages": ["@deepseek-ai/dsh-goal"],   // 真实依赖清单
    "whyNotBuiltin": "..."                   // 如果官方已有，为什么还要 Pack
  },
  "platforms": ["darwin", "win32", "linux"],
  "requirements": {
    "runtimeMinVersion": "0.2.0",
    "externalBinaries": [],
    "networkAccess": false
  },
  "risk": {
    "level": "low",                          // low | medium | high
    "dataWritten": [".dsh/mission/**"],
    "reversible": true,
    "uninstallRemovesData": false            // 卸载是否删数据（默认不删）
  },
  "verify": {
    "script": "verify.js",
    "checks": ["install-ok", "works-after-restart", "uninstall-clean"]
  },
  "defaultFor": ["starter-kit:long-project"], // 被哪些 Starter Kit 默认包含
  "deferred": false,
  "deferredReason": null
}
```

### 5.2 什么是 Starter Kit

Starter Kit = **面向一类用户任务的 Capability Pack 组合 + 一个 Mission 模板**。

目标：新手选一个 Kit，5 分钟内拿到第一个真实产物。

| Kit | 面向 | 包含 | Mission 模板 |
|---|---|---|---|
| `research-report` | 做调研的人 | Capability: history, verification | 一句话 → 调研笔记 → 报告文件 |
| `code-change` | 改代码的人 | Capability: workspace(worktree), verification | 一句话 → 计划 → 改动 → 验证 |
| `long-project` | 长期项目 | Capability: memory, workspace, verification | Mission + Workstream + Shared Context |
| `knowledge-base` | 建知识库 | Capability: knowledge（**暂缓**） | — |

**关键约束**：Starter Kit **必须可端到端验证**（装完真的能产出东西），否则不许发布。

### 5.3 Profile Composer 的边界

**不做**自由组合器（用户随便挑 Provider 拼装）—— 那是高级玩家的需求，且组合爆炸无法验证。

**做**：
- 列出可用 Capability 的**状态**（未安装/已安装/验证通过/验证失败）。
- 允许**替换**某个 Capability 的实现（如 workspace: shared → worktree），但**替换后必须重跑验证**。
- 高级用户可直接编辑 `cordis.patch.yml`（官方机制），我们只提供"推荐组合"。

### 5.4 对方案 D（通用 Provider 抽象）的严格约束

**规则**：只有当存在**第二个真实实现**且**有明确替换需求**时，才引入抽象接口。

当前判断：

| Provider | 抽象？ | 理由 |
|---|---|---|
| MemoryProvider | **暂不抽象** | 官方 `dsh-goal` + `dsh-compaction` + session-search 已够用；第三方记忆方案均未验证（见 `docs/research/memory-systems.md`） |
| WorkspaceProvider | **暂不抽象** | `dsh-workspace-changes` + git worktree 已覆盖；LayerFS 未验证 |
| KnowledgeProvider | **暂不抽象** | 当前无真实用户需求证据 |
| HistoryProvider | **暂不抽象** | 官方 `dsh-experimental-session-search` 已覆盖 |
| VerificationProvider | **暂不抽象**（2026-11-01 复核） | 原有理由推错了一步："官方没有" + "我们有一个" ≠ 两个实现。收益已通过 `runVerify` + 注入 runner 获得 |

**即：只有 VerificationProvider 现在值得做接口。**

### ⚠ 2026-11-01 复核：这条判断的**时机**错了（方向没错）

复核结论见 `docs/plans/active/P4-VERIFICATION-PROVIDER-DECISION-2026-11-01.md`。

原推理链：「官方无内置 verification runner；DshCockpit 已有 command-runner」
→「因此有第二实现需求」。

**最后一步不成立**："官方没有" + "我们有一个" ≠ "有两个实现"。
它恰恰说明当前**只有一个实现**，而那正是 AGENTS.md §2.6 说的不该抽象的条件。

实际代码状态：

```
runVerify 的调用点：2 处，且已在用同一个入口
```

也就是说，抽象能带来的三条收益里，两条**已经通过现有设计获得**：
- 可测试 → `runVerify` 接受注入的 `runner`，测试里就是 fake runner
- 统一入口 → 2 个调用点用同一个函数
- 可替换 → ❌ 没有第二个后端，也没有真实需求

**决定：不做完整接口**（那只会增加一份要同步的契约 + 一层间接）。

**重新评估的触发条件**（满足任一）：

1. 出现一个**无法用 shell 命令表达**的 verify（需调 Node API、或走 HTTP 的服务型验证）
2. 第三方要写自己的 Capability Pack，且需要自定义 verify 方式
3. `capability-packs/verify.js` 里出现 `if (kind === 'shell') … else if (…)`
   这类分支——那是"需要接口"的机械信号

**与 RenderBackend（ADR-0006）的区别**：那个缺的是"标出接缝"（20 个平铺方法
没有统一入口），这个缺的是"第二个实现"。**后者没法靠写代码解决。**

## 6. 决策理由

1. **不与官方竞争分发**：官方 market 是分发层，我们做**组合与验证层**，互补。
2. **真正解决用户痛点**：用户的痛点是"装了不能用"，不是"找不到插件"。
3. **可验证**：Capability Pack 有 verify 脚本，符合"不伪造"原则。
4. **避免过度抽象**：只对 VerificationProvider 做接口，其余等到有第二个实现。
5. **资源可控**：Pack 数量有限（初期 3–5 个），维护成本可控。

## 7. 代价

| 代价 | 说明 |
|---|---|
| 需要真实验证基础设施 | verify 脚本要能在 CI 与真机都跑通 |
| 需持续维护 | 插件版本变化会破坏 Pack，需要有更新机制 |
| 覆盖范围窄 | 只覆盖少数场景，高级用户可能觉得不够 |
| 自研插件市场需让位 | `src/plugin-flow.js` / `src/market.js` 可能降级为"官方 market 的入口"或删除 |

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **Pack 数量膨胀失控** | 中 | 中 | 硬约束：每个 Pack 必须有 verify 脚本 + 真实用户价值论证 |
| **验证脚本成为新负担** | 高 | 中 | 复用 `src/work/command-runner.js`；verify 只跑最小断言 |
| **官方补齐"组合推荐"** | 低 | 中 | 我们的价值在"验证"与"Mission 集成"，不只是推荐 |
| **用户仍去官方 market 装东西** | 高 | 中 | 不阻止；但我们的 Pack 保证"用 Mission 时状态可见" |

## 9. 后续重新评估的触发条件

1. 官方提供 capability bundle / starter kit 概念。
2. 某个 Capability 出现**第二个真实实现**（则该 Provider 值得抽象）。
3. Pack 维护成本超过用户价值（则收缩为纯文档推荐）。

## 10. 未验证声明

> ⚠️ 本 ADR 中关于"官方 market 不保证组合可用性"的判断，基于对官方包 README 的阅读，**未经实测**。
> 关于第三方 Provider 的具体评估见 `docs/research/capability-providers.md`（由独立评估产出）。
> 本 ADR 的 Pack 设计需要在第一个真实 Pack 落地后回填验证结果。
