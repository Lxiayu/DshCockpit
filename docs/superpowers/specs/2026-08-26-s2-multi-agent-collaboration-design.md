# S2 多 Agent 协作调研与设计文档

> 日期：2026-08-26
> 状态：调研完成，已评审，待评审 Marvis 参考调研
> 对应规格：PREDEV-FEATURES-REPORT.md §S2

## 0. Marvis 参考调研（2026-08-26）

### 0.1 调研对象

- **腾讯 Marvis**（官方，操作系统级 AI 助手，2026-05 发布）：预装 6 Agent 团队
- **Drok1015/marvis-office**（FastAPI + SSE + 6 Agent 编排复刻，最贴近 PREDEV 设想）
- **jiatianbo666/marvis-rs**（Rust 课程作业版，参考性质）

### 0.2 核心架构：Orchestrator（PM 主管）+ 专项 Agent 池

不是"Agent 互聊"，而是**固定的主管-员工单向派发**：

```
用户输入 → Main Agent(PM/Orchestrator) → 拆解 2-5 子任务
              ├──▶ File Agent / Computer / App / Browser / Search
              └──▶ 并行 asyncio.gather → PM 汇总 → 返回用户
```

### 0.3 关键技术机制

| 机制 | 实现 | 对我们的启示 |
|---|---|---|
| **任务拆解** | PM 用 LLM 拆成 JSON `{agent, task}`，校验 agent 合法；失败用 `_heuristic_plan`（关键词匹配）兜底 | 我们不需要自建拆解——harness 会话/LLM 自带；壳只做路由 |
| **事件总线 + SSE** | 单进程 EventBus（asyncio.Queue）+ 前端 EventSource 订阅，广播 `AgentEvent`，实时更新工位状态/消息/token | **高度吻合我们现有架构**：events.host 流驱动 agent-registry + 广播 office 状态，只需泛化事件类型 |
| **状态机 7 态** | `idle→dispatching→thinking→working→done/error/paused` | 我们用更清晰的 6 态（S1.4 已实现）；`paused` 对应我们的确认环节 |
| **确认流** | Agent 检测敏感词 → `create_confirmation()` 建 `asyncio.Event` 槽 → 暂停等 `/api/confirm` → 超时 120s 取消 | harness 已有 approval/question 流（events.mux 已在监听），**零开发** |

### 0.4 与我们的差异决策（关键）

| 维度 | Marvis | **我们（本项目）** |
|---|---|---|
| Agent 来源 | 固定 6 个预置角色 | **动态 Agent 池**（每个 harness 会话 = 实体，S1.2 已实现） |
| 协作方向 | PM 单向派发 | **双向**：任务传递 + 求助（用户已确认：自动触发/Agent 自主协作） |
| 执行单元 | 自带 LLM 循环 + 18 工具 | **零开发**——harness 运行时已有 subagent/prompt/工具 |
| 事件流 | 自建 EventBus | **复用已有** events.host/events.mux + agent-registry 广播 |
| 确认机制 | 自建 120s 槽 | harness 已有 approval/question 流（复用） |
| 通信模式 | P2P 直接 | **壳层路由**（A→壳→B 注入），防消息风暴/限速去重 |

**核心结论**：S2 不需像 Marvis 那样自建编排引擎。所需地基 = harness 子代理 API 暴露 + agent-registry 父子关系 + 壳层消息路由 + 子代理发现循环 + 办公室连线展示。

---

## 1. 调研结论

### 1.1 Harness 运行时已有完整子代理 API（零侵入）

运行时 0.1.1-rc.2 已内置完整的子代理系统，无需壳额外开发 Agent 执行引擎：

| API | 用途 | 现状 |
|---|---|---|
| `subagent.list` | 列出父会话的所有子代理（kind=child/diagnostic, mode=one-shot/continuable, activity=running/inactive, hasChildren） | 未使用 |
| `subagent.history` | 获取子代理的会话事件日志 | 未使用 |
| `subagent.prompt` | 向 continuable 子代理发送消息 | 未使用 |
| `subagent.interrupt` | 中断运行中的子代理 | 未使用 |

### 1.2 运行时已内置协作工具（壳只需暴露）

- `send_message(subagent_id, message)` — 壳可转发此调用
- `interrupt_agent(agent_id)` — 壳可转发
- `subagent` tool（foreground/background/continuable 三种模式）— 模型层已可用
- `workflow` — JS 编排脚本（`agent()`/`pipeline()`/`parallel()`/`phase()`），模型可写

### 1.3 壳的职责（而非重造框架）

壳不需要从零开发 Agent 对话引擎——运行时已有。壳的职责是：

1. **发现**：通过 `subagent.list` 发现父子关系，同步到 `agent-registry`
2. **展示**：办公室视图展示 Agent 层级关系（连线/树）
3. **触发**：用户界面上的"委托"按钮 → 调用 `subagent.prompt` 或 `session.prompt` 注入指令
4. **监控**：监听 `subagent/end` 事件 → 更新状态 → 通知父 Agent
5. **共享上下文**：AGENTS.md 跨 Agent 共享机制

## 2. 技术方案

### 2.1 Agent 注册表扩展（agent-registry.js）

当前示例 agent：
```
{ id: "sess-abc",       name: "重构数据库",  status: "working", role: "后端工程师" }
{ id: "sess-def",       name: "写测试用例",  status: "idle",    role: "QA 工程师" }
{ id: "sess-abc-child", name: "子代理-重构", status: "working", role: "代码审查", parentId: "sess-abc" }
```

新增字段：
- `parentId` — 父 Agent 的 id（可选，无则为顶层）
- `children` — 子 Agent id 集合（自动维护）
- `mode` — one-shot / continuable（来自 subagent API）
- `delegationDepth` — 委托深度（来自运行时）

### 2.2 子代理发现（subagent-discover.js，新模块）

每 10 秒（与现有 syncAgentsFromRuntime 合并）：
1. 对每个 running 的顶层 Agent，调用 `rpc.listSubagents(parentId)`
2. 将返回的子代理作为 Agent 实体注册（`parentId` 关联）
3. 递归发现子代理的子代理（受 `maxDepth` 限制）
4. 从 `subagent.history` 获取子代理的对话摘要（用于办公室展示）

### 2.3 协作消息通道（agent-messaging.js，新模块）

壳层消息路由（非 p2p 直接通信，避免 LLM 开销膨胀）：

```
Agent A → 壳 IPC → 目标 Agent B 的 session.prompt 注入
```
- 壳维护一个 `agent-messaging.js` 模块，注册新 IPC channel `agent:send-message` / `agent:get-history` / `agent:list-relations`
- 办公室视图消费这些 IPC 展示气泡/连线

### 2.4 办公室视图协作展示（office-view.js 扩展）

- 工位卡增加 `children` 徽章（子代理数量）
- 点击展开子代理列表（子工位内联或浮层）
- 在线连线：running 状态的 Agent 之间的父子关系连线（SVG line overlay）
- 消息气泡：Agent 间最近消息的快照显示

### 2.5 共享上下文

- 现有的 AGENTS.md 机制（project + global）直接作为共享上下文
- 新增 `agent:sync-memory` IPC：Agent 完成任务后，壳自动在 AGENTS.md 追加协作记录
- 站内消息历史：用 `subagent.history` 获取，不在壳持久化

## 3. 实施计划

### 阶段 1：地基（2-3 天）
- [ ] 扩展 `harness-rpc.js`：新增 `subagent.list`、`subagent.history`、`subagent.prompt` 方法
- [ ] 扩展 `agent-registry.js`：新增 `parentId`/`children`/`mode`/`delegationDepth` 字段
- [ ] 新建 `src/subagent-discover.js`：子代理发现 + 注册循环
- [ ] 修改 `main.js`：将子代理发现集成到 `syncAgentsFromRuntime` 周期
- [ ] 测试：子代理发现、注册、递归、状态联动

### 阶段 2：展示（2-3 天）
- [ ] 新建 `src/agent-messaging.js`：消息路由 + IPC channel
- [ ] 扩展办公室视图：父子关系展示（连线/内联树）
- [ ] 办公室详情浮层：增加子代理列表、最近消息
- [ ] i18n 追加
- [ ] 测试：消息路由、父子关系展示

### 阶段 3：协作（2-3 天）
- [ ] 用户触发协作：办公室工位右键/按钮 → 派任务给子代理
- [ ] 自动触发（Agent 自主）：监听 `subagent/end` 事件 → 通知父 Agent
- [ ] 共享上下文：AGENTS.md 协作记录追加
- [ ] 端到端测试：2 个 Agent 协作完成一个任务，状态正确联动

## 4. 风险与注意事项

| 风险 | 缓解 |
|---|---|
| subagent API 调用过频（10s 轮询 × N 个 Agent） | 只在 running 状态的 Agent 上递归发现；缓存 `hasChildren` 不变的节点 |
| 父子关系深度无限 | 运行时已有 `maxDepth=3`，壳同步时也截断 |
| 消息风暴：Agent A 给 B 发消息 → B 执行完 → A 又发 | 壳层去重 + 限速（每 Agent 每 5s 最多 1 条） |
| 办公室视图连线过多性能差 | 只显示 active（running）状态的 Agent 连线；按需展开 |
| 与现有 H-im 系统冲突 | 协作通道走独立 IPC `agent:*`，不影响 `im:*` |

## 5. 待确认问题

1. 用户触发协作的 UI 形态：右键菜单？拖拽？按钮？
2. Agent 自主触发的条件：Agent 主动调用 `send_message` 工具时，壳是否干预？还是完全透传？
3. 协作记录的持久化：保留在运行时（`subagent.history`），还是壳也要存一份？