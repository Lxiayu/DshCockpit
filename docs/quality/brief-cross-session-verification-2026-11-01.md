# Brief 跨会话生效验证（P1 最后一项，2026-11-01）

> 这是 P1 唯一未验证的事项。本文记录**验证到了什么程度**、依据是什么、
> 以及**哪些仍未验证**——不把间接证据说成直接证据。

## 0. 结论先行

| 层次 | 状态 | 依据 |
|---|---|---|
| Brief 被正确写入 `<workspace>/AGENTS.md` | ✅ **已验证** | 143 项离线测试 + 真实调用 `syncToWorkspace` |
| 官方 runtime 会读 `<root>/AGENTS.md` | ✅ **已验证** | 官方源码 `dsh-agent-instructions` 明文实现 |
| 读取时机是会话启动 | ✅ **已验证** | 同上，且有 `session/created` 集成点 |
| **真实模型会话确实读到并据此回答** | ⚠️ **未完成** | 需要一次完整 Agent 会话（见 §4 原因） |

**诚实结论**：机制的三个环节都有代码级证据，但端到端的"模型真的说出来"
还差最后一步。不把前三层证据当成第四层的替代品。

## 1. 第一层：Brief 写入正确（已验证）

`src/mission/brief-sync.js` 的 `syncToWorkspace({ workspaceDir, briefText })`：

- 用 `BEGIN_MARK` / `END_MARK` 包裹，边界明确
- 重复同步是**幂等**的（同内容不重复追加）
- **用户手写内容永不丢失**（块外内容原样保留）
- 卸载（`unsyncFromWorkspace`）只删块内

真实调用实测：
```
sync ok: true | 标记完整: true | 用户内容保留: true
```

## 2. 第二层：官方 runtime 确实读 AGENTS.md（已验证，源码级）

官方包 `@deepseek-ai/dsh-agent-instructions`：

```js
const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const USER_GLOBAL_FILE = "AGENTS.md";
const DEFAULT_MAX_SOURCE_BYTES = 1048576;
```

关键事实：

1. **会读两类位置**
   - `<projectRoot>/AGENTS.md`（项目级）
   - `$DSH_HOME/AGENTS.md`（用户全局级）

2. **项目根的判定依据是 `.git`**（`projectRootMarkers`）
   —— 这是本验证发现的**重要前置条件**：工作区没有 `.git` 时，
   项目级的 AGENTS.md 可能**不在识别范围内**。

3. **有变更同步机制**
   源码里有 `Instructions removed: ...` / change-action 处理，
   说明运行中修改 AGENTS.md 会被感知（不只在启动时读一次）。

4. **有大小上限** 1 MiB

## 3. 第三层：读取时机（已验证，源码级）

`dsh-agent-instructions` 与 session 生命周期存在集成点
（`session/created` 事件处理）。指令内容有 SHA1 内容身份（`instructionContentSha1`），
说明是按内容变化增量更新的，不是每次全量重读。

## 4. 第四层：真实会话验证 —— 未完成

**尝试过什么**：

| 路径 | 结果 |
|---|---|
| `dsh run <prompt>` | ❌ 0.2.1-rc.5 无 `run` 子命令；profile 是 `web` |
| `dsh --profile web` + mux `session/create` | ❌ HTTP 405（该端点在 0.2.1 的 HTTP 表面上未暴露为 unary RPC） |
| `dsh --profile web` + `session/prompt` | ⏸ 未尝试成功（依赖上一步拿 sessionId） |

**为什么没继续深挖**：继续需要逆向 `dsh-api-session-controller` 的
RPC 注册机制（`typert.host.js` / `typert.remote-client.js`）。
这是**验证工具的成本**，不是产品缺陷。投入产出比不划算——
因为下一层证据（真实会话）可以用更简单的方式获得：

## 5. 最省力的完成方式（建议）

**手动一次即可**，不需要写探针：

1. 在 DshCockpit 里创建/更新一个 Mission，写一条独特的 Brief
2. 确认该 Mission 的工作区有 `.git`
3. 打开 dsh 官方 UI，在该工作区发起一次会话，问："当前 Mission 的 Brief 是什么？"
4. 若模型复述出 Brief 内容 → **第四层完成**

这一步人工做只需 2 分钟，比我逆向 RPC 协议快得多。

## 6. 由此发现的两个**真实风险**

### 风险 1：工作区没有 `.git` 时 Brief 可能不生效

官方以 `.git` 判定项目根。若用户的 Mission 工作区是随便一个文件夹，
`<workspace>/AGENTS.md` 可能不在识别范围。

**影响**：跨会话记忆静默失效——用户不会收到任何提示。
**建议**：写入 Brief 前检查工作区是否有 `.git`；没有时**明确提示用户**
（"这个目录不是 git 仓库，Brief 可能不会自动加载"），而不是静默写入。

### 风险 2：1 MiB 上限

`DEFAULT_MAX_SOURCE_BYTES = 1048576`。Mission Brief 若包含大量内容
（多个 Mission 的 Brief 累积），可能超限被截断或忽略。
**建议**：`brief-sync` 写入前检查长度，超限时告警。

## 7. 复现方式

```bash
# 1. 单测（离线，143 项）
node --test test/mission-brief-sync.test.js

# 2. 官方读取逻辑（查看源码）
grep -n "AGENTS.md" \
  <runtime>/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js
```
