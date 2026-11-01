# P3 Capability Pack 与 Starter Kit —— 第一性原理分解

> 状态：执行中（2026-11-01）
> 上游：`docs/product/product-roadmap.md` §P3
> 前置核查：官方 `@deepseek-ai/**` 中**无** capability-pack 类包（只有通用
> cordis plugin 机制），确认 P3 是真实空白，不是重复造轮子。

## 1. 第一性原理：Capability Pack 到底解决什么问题

路线图说「让新手 5 分钟内拿到真实产物，且不需要懂底层设施」。

拆开这句话：

| 词 | 真实含义 |
|---|---|
| 5 分钟内 | 首次使用的**摩擦**必须极低（不是"功能强大"） |
| 真实产物 | **可验证的文件**，不是演示用的假数据 |
| 不懂底层设施 | 不需要理解 Harness / Session / Mux / Agent 就能用 |

所以 Capability Pack 的本质不是"插件系统"，而是**把一套已经能工作的
配置固化下来，让下一个人不用重新想**。

推导出的最小形态：
- 一份 **manifest**（声明这个能力需要什么、产出什么、怎么验证）
- 一个 **verify 脚本**（证明它真的能工作，而不是"看起来能"）
- 一条**安装/卸载**路径（用完了能干净退出）

## 2. 为什么 verify 是核心，不是附属

这是本阶段最重要的判断。

一个"能力包"如果没有 verify，它退化成**一段文档**——用户装完不知道
成功没有，我们也不知道它坏了没有。

verify 带来的三个具体价值：

1. **对用户**：装完立刻知道"能用/不能用"，而不是等到干活时才发现
2. **对我们**：CI 能跑（路线图验收标准 4 明确要求），不需要真机
3. **对演进**：官方能力变化时，verify 先红，而不是用户先发现

所以 P3 的顺序必须是 **manifest 结构 → verify 机制 → 第一个 Pack**，
而不是反过来"先做个包再补验证"。

## 3. 架构约束

### 约束 1：不自研插件系统

官方有 cordis plugin 机制与 plugin-manager。Capability Pack **消费**它们，
不重写。P3 的产物是"manifest + verify + 安装脚本"，
不是"另一个 plugin loader"。

### 约束 2：verify 复用 command-runner

`src/work/command-runner.js`（108 行）已有超时、输出上限、跨平台 shell、
可注入 spawn/platform。**直接复用**，不新写一个执行器。

### 约束 3：平台不支持时明确拒绝

路线图验收标准 2：「平台不支持时**明确拒绝**（不是崩溃）」。
所以 manifest 要能声明平台约束，安装器要能检查并给出**可读的理由**。

### 约束 4：卸载无残留

验收标准 1 要求「卸载 → 无残留」。这要求安装记录**装了什么**，
而不是"复制作业"。安装清单是关键设计点。

## 4. 实施分解

| 步 | 内容 | 验证 |
|---|---|---|
| **S1** | `src/capability-packs/manifest.js` —— manifest 校验（纯函数） | 单测 |
| **S2** | `src/capability-packs/verify.js` —— verify 执行器（复用 command-runner） | 单测（注入假 runner） |
| **S3** | `src/capability-packs/installer.js` —— 安装/卸载/健康检查 + 安装清单 | 单测（临时目录） |
| **S4** | 第一个真实 Pack：`workspace-verification` | verify 在 CI 可跑 |
| **S5** | CI 集成 + 真机验收 | 截图/日志 |

**S1-S3 是纯逻辑，可以完全离线测试**（与 P2.3 同一节奏：数据先对）。
S4 是第一个真实用户，S5 是证据。

## 5. 设计决定（先想清楚）

### 决定 1：manifest 的字段必须少而硬

一个常见错误是"manifest 支持一切"。本阶段只允许：
```json
{
  "schemaVersion": 1,
  "id": "workspace-verification",
  "version": "1.0.0",
  "title": "...",
  "requires": { "platforms": ["darwin","win32","linux"], "commands": ["node"] },
  "provides": { "capabilities": ["workspace.verify"] },
  "verify": { "command": "...", "expectExitCode": 0 }
}
```
**不多加字段**。将来需要再加——那时才知道为什么要加。

### 决定 2：安装 = 记录 + 校验，不是复制

因为没有"复制文件到系统"的需求（Capability Pack 是配置+脚本），
安装的本质是：
1. 校验 manifest
2. 检查平台/命令依赖
3. 写一条安装记录（`installed.json`）
4. 跑一次 verify

卸载 = 删记录 + 确认无残留。**这样"无残留"是可验证的**。

### 决定 3：verify 结果必须四态，不是布尔

沿用本项目的四态纪律（见 `scripts/ci-gate.js`）：
- `passed` — 命令退出码符合预期
- `failed` — 退出码不符或超时（附输出尾部）
- `skipped` — 平台不支持（附原因）
- `not-verified` — 无法运行（缺命令/权限）

**`skipped` 绝不能算 `passed`**——那是本项目已经踩过的坑。

## 6. 验收标准（路线图 + 本项目追加）

- [ ] manifest 校验拒绝残缺/多余字段（fail-closed）
- [ ] verify 四态清晰，skipped 不计作 passed
- [ ] 安装/卸载幂等（重复安装不报错、重复卸载不报错）
- [ ] 卸载后无残留（安装记录删除、无孤儿文件）
- [ ] 平台不支持时明确拒绝并给可读理由
- [ ] 第一个 Pack 的 verify 在 CI 可跑（无真机依赖）
- [ ] 不复用造轮子：verify 走 command-runner

## 7. 明确的非目标

- ❌ Pack 市场 / 远程分发
- ❌ 5 个以上 Pack（先做 1 个走通全链路）
- ❌ MemoryProvider 抽象（无第二实现，见 AGENTS.md §2.6）
- ❌ 自研 plugin loader（消费官方）
