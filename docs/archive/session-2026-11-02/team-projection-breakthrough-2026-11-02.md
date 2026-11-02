# 突破：`agentTeam` 可以通过稳定端点拿到

> 日期：2026-11-02
> 背景：GPT 说「Team 的 `agentTeam` 浏览器投影**未加入稳定 API Proxy**」，
> 我最初的 grep 也确认 `dsh-api-session-controller/lib/types/` 里 0 次出现。
> **但那个结论不完整。** 本文记录修正。

## 0. 结论先行

**`agentTeam` 是 SessionProjection，可以通过 `session/projections` 拿到——
不需要 Host 插件。**

前提：profile 里要启用 `@deepseek-ai/dsh-experimental-agent-team-profile`。

## 1. 我之前的判断错在哪

我第一次 grep 的是：

```
dsh-api-session-controller/lib/types/*.d.ts  →  agentTeam 出现 0 次
```

由此得出「未进稳定 API」。**这个推理漏了一步**：

Session 投影的类型定义**分散在各插件包里**，不在 session-controller 里。
`agentTeam` 的定义在：

```
@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.d.ts
```

里面明确写着：

```ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentTeam: TeamProjectionState;
  }
}

export interface TeamState {
  readonly id: TeamId;
  readonly members: readonly TeamMemberSnapshot[];
  readonly tasks: readonly TeamTaskSnapshot[];      // ← shared task DAG
  readonly messages: readonly TeamMessageSnapshot[];
  readonly delivered: readonly TeamMessageId[];
  readonly nextTaskNumber: number;
}
```

而 `session/projections` 是**稳定端点**。

## 2. 实测验证（两种 profile 对比）

| profile | 投影字段数 | `agentTeam` |
|---|---|---|
| 默认 `web` | 20 | ❌ 不存在 |
| 加了 `agent-team-profile` | **21** | ✅ **存在** |

### 实测返回

```json
{
  "agentTeam": {
    "members": [
      { "id": "session-76581fd8-ce9f-445a-ab35-2084504343da",
        "name": "lead", "role": "lead", "phase": "active" }
    ],
    "tasks": []
  }
}
```

### 复现方式

在隔离 DSH_HOME 里建一个 profile：

```json
{
  "name": "dsh-profile-teamtest",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile"
      ]
    }
  }
}
```

然后 `dsh --profile teamtest --port 0 --no-open`，
调 `session/projections`。

## 3. 这改变了什么

### 3.1 不需要 Host 插件

GPT 建议的长期方案是写一个 Host 插件 `@dshcockpit/runtime-bridge`，
与 Agent Team 同进程。

**现在看，那条路不是必需的。** 我们能通过现有的 HTTP unary 端点拿到：

- `members[]`（含 id / name / role / phase）
- `tasks[]`（shared task DAG——**这正是我们缺的 Workstream 依赖**）
- `messages[]`

### 3.2 我的 `official-teams-shape.js` 可以接线了

之前我把这个模块判为「刻意不接线」，
理由是不能造第二套 Team 事实路径（铁律 1）。

**现在有了正规入口**：它校验的 `.d.ts` 形状，
正是 `agentTeam` 投影的结构。可以直接用它做运行时校验。

### 3.3 Workstream 依赖缺口有现成来源

我列的「缺口 C：Workstream 没有 `dependsOn`」，
官方的 `TeamTaskSnapshot` 里就有 shared task DAG。

**不需要自己设计 DAG**——只需要映射。

## 4. 但仍有真实的不确定性（不能盲目乐观）

| 不确定 | 说明 |
|---|---|
| **experimental 稳定性** | 包名带 `experimental`。官方明说无稳定性保证。API 可能变 |
| 默认不启用 | 用户装了我们的 app，默认 profile 里没有它。要**我们决定**是否启用 |
| 启用后行为变化 | 启用 profile 会不会改变现有会话行为？还没验证 |
| `tasks` 是空的 | 实测 `tasks: []`——因为没真的 spawn teammate。**DAG 的真实形状还没见过** |
| 与 Mission 的关系 | Team 的 task 和我们的 Mission/Workstream 是**两个模型**。映射需要设计 |

## 5. 待验证清单（下一步）

| # | 问题 | 怎么验 |
|---|---|---|
| 1 | 启用 profile 后，现有功能有回归吗？ | 用启用版 profile 跑我们的全部验收探针 |
| 2 | 真实 spawn teammate 后，`tasks[]` 长什么样？ | 起一个 Lead + 2 teammate，看投影 |
| 3 | `tasks[]` 的依赖关系字段是什么？ | 读 `TeamTaskSnapshot` 类型 |
| 4 | 这个 profile 能不能被我们的 runtime-manager 管理？ | 改 profile 的 bundles，看能否启动 |
| 5 | 如果官方改了 experimental API，我们怎么降级？ | 契约测试 + 投影缺 key 时回落 |

## 6. 对 GPT 的回应（写进交流文档）

GPT 的判断「未进稳定 API Proxy」在**字面上成立**（它确实不在
`api-session-controller` 的类型里），但**结论过于悲观**：
它在 `SessionProjectionStateMap` 里，而 projections 是稳定端点。

**所以「要不要做 Host 插件」这个问题的答案变了：暂时不需要。**
