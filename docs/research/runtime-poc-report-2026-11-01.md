# Runtime & Protocol POC 报告（Issue #9）

> 状态：**已完成（2026-11-01）** · 执行者：Lead
> 上游：`docs/adr/ADR-0004-upgrade-harness-runtime-0.2.md`、`docs/quality/compatibility-ledger-spec.md`
> 隔离工具：`scripts/poc/runtime-poc.sh` + `scripts/poc/protocol-probe.js`

## 0. 一句话结论

**0.2.1-rc.5 与 0.2.2-alpha.2 在协议层与能力面均验证通过（16/16 PASS，0 FAIL）。**
CI 从未覆盖的 mux 连接、session RPC、能力包存在性，现在都有了运行级证据。

但**仍有一类能力未验证**（Team 成员事件、User Question、Approval、断线重连），
它们需要真实模型调用与交互式会话 —— 如实标记为 `not-verified`，**不当作通过**。

## 1. 方法与隔离（用户硬约束）

| 约束（用户 2026-11-01） | 落实方式 | 证据 |
|---|---|---|
| 独立目录 | `$TMPDIR/dsh-poc/<version>/` | `runtime-poc.sh status` |
| 独立 Profile | `DSH_HOME=$POC_ROOT/dsh-home`（全新） | `poc.env` 生成 |
| 独立 Workspace | `$POC_ROOT/workspace`（全新 git 仓库） | setup 时 `git init` + seed commit |
| 独立测试数据 | `$POC_ROOT/{logs,artifacts,npm-cache}` | 全部在 TMPDIR 内 |
| **不得改生产 Runtime** | 只读 symlink 仓库 `vendor/runtime`（无写入） | `git status vendor/` 为空 |
| **不得改真实 Settings** | POC 全程 `DSH_HOME` 指向沙箱 | `~/.dsh` 修改时间未变（02:32） |
| **不得碰用户 Workspace** | `cwd` 固定 `$POC_ROOT/workspace` | 探针 `pocEnv()` 强制 |
| **不得改锁定版本** | `package.json` 未动 | `runtimeVersion: "0.1.5-rc.2"` |

**额外隔离**：`npm_config_cache` 也指向 POC 目录，避免 POC 下载的 616 个包污染用户缓存。

## 2. 三版本对照结果

| 检查项 | 0.1.5-rc.2（基线） | 0.2.1-rc.5 | 0.2.2-alpha.2 |
|---|---|---|---|
| runtime 存在 | ✅ | ✅ | ✅ |
| 版本自证 | ✅ | ✅ | ✅ |
| `--dump-config` | ✅ 46ms | ✅ 58ms | ✅ 74ms |
| boot web host | ✅ | ✅ | ✅ |
| `GET /`（token） | ✅ 303 | ✅ 303 | ✅ 303 |
| **cookie 交换** | ✅ | ✅ | ✅ |
| **mux `$events` ready** | ✅ | ✅ | ✅ |
| **`session/list`** | ✅ items=0 | ✅ items=0 | ✅ items=0 |
| **`session/create`** | ✅ | ✅ | ✅ |
| **`session/page`** | ✅ | ✅ | ✅ |
| `dsh-experimental-agent-team` | ❌ 不存在 | ✅ | ✅ |
| `dsh-experimental-worktree` | ❌ | ✅ | ✅ |
| `dsh-workspace-changes` | ❌ | ✅ | ✅ |
| `dsh-goal` | ❌（vendor 精简版） | ✅ | ✅ |
| `dsh-session-query-sqlite` | ❌ | ✅ | ✅ |
| `dsh-experimental-session-search` | ❌ | ✅ | ✅ |
| **合计** | 10 pass / 10 not-verified | **16 pass / 4 not-verified** | **16 pass / 4 not-verified** |

> ⚠️ 0.1.5 的"❌不存在"需注意：本次用的是仓库 `vendor/runtime/0.1.5-rc.2`，
> 它是**精简安装（12 个包）**，不代表官方 0.1.5 全量安装的样子。
> 这一点已在下方 §5「已知局限」明确标注。

## 3. 关键发现

### 3.1 协议层是稳定的（最重要的好消息）

`$events` ready 帧、`session/list`、`session/create`、`session/page` 在三个版本上**全部通过**，
参数形状与响应结构一致。这印证了 bridge-auditor 的静态分析结论（"0.2.1 相对 0.1.5
的 session-controller RPC 零删除 + 3 新增"），现在有了运行级证据。

### 3.2 CI 与 POC 的覆盖差异被量化

| 层级 | CI（upstream-compat） | POC（本报告） |
|---|---|---|
| Installed | ✅ | ✅ |
| Healthy | ✅ | ✅ |
| **Compatible（协议）** | ❌ **不覆盖** | ✅ **已覆盖** |
| EndToEnd | ❌ | ⚠️ 部分（无模型调用） |
| TeamIntegration | ❌ | ❌ 未覆盖 |

**这正是要分开 CI 与 POC 的理由**：CI 天天绿，但从未验证过 mux 能不能连。

### 3.3 一个探针自身的 bug（已修复，值得记录）

首次运行时 mux 连接失败，报 `socket hang up`。根因**不是 runtime 的问题**，而是探针把
**带 `?token=` 的启动 URL** 直接传给了 `createRuntimeMux`：

```
错误：ws://127.0.0.1:62553/?token=abc123/api/remote.mux   ← 路径错位
正确：ws://127.0.0.1:62553/api/remote.mux                  ← origin only
```

生产代码（`src/main.js:startMuxEventsFeed`）传的一直是 origin，所以这是**探针的用法错误**。
修复方式：`new URL(baseUrl)` 后清空 `search`/`hash` 取 `origin`。

> 教训：POC 工具本身也需要被验证。如果没做"基线先跑通"这一步，
> 这个 bug 会被误读成"0.2.1 协议不兼容"——结论会完全反过来。

### 3.4 `recommended` 不能只看 semver

首次把 POC 结果写入账本时，`recommended` 自动选成了 `0.2.2-alpha.2`（semver 更高）。
但用户明确要求"不要把 0.2.2-alpha.2 当作 rc.5 的后继"——它发布于 rc.5 **之前**，
属于 0.2.2 线的预览分支。

修正：`recommended` 排序键改为 **通道稳定度优先，其次 semver**：
```
next/latest (0) > explicit (1) > alpha (2)
```
结果：推荐 `0.2.1-rc.5`（next 通道，`compatible`），alpha 仅记录不推荐。

## 4. 对 ADR-0004 的影响

| 原判断 | POC 后 | 变化 |
|---|---|---|
| S0 POC 需验证"能否启动" | CI 已证明，POC 再次确认 | ✅ 无风险 |
| S0 POC 需验证"mux 是否兼容" | **已实测通过** | ✅ **风险消除** |
| S0 POC 需验证"agentTeam 视图" | 已测**包存在性**，未测字段形状 | ⚠️ 部分 |
| 破坏面在事件词表（净增 6） | 未在本次 POC 验证（需驱动会话产生事件） | ⚠️ 待补 |

**结论**：ADR-0004 的 S-1（修账本）→ S0（POC）两步中，**S0 的协议部分已完成**。
剩下的端到端验证需要真实模型调用，属下一阶段。

## 5. 已知局限（诚实清单）

| # | 局限 | 影响 | 后续 |
|---|---|---|---|
| L1 | **仅在 darwin-arm64 执行** | win32-x64 未测 | CI 已在 win 上验证 install/health，协议需另跑 |
| L2 | **未做真实模型调用** | Team 事件/User Question/Approval/重连未验证 | 需用户提供 API key 或改用 mock harness |
| L3 | **0.1.5 用的是 vendor 精简版（12 包）** | 基线能力面不可比 | 如需精确基线，应全量安装 0.1.5 |
| L4 | **`agentTeam` 字段形状未测** | ADR-0002 的能力映射仍缺直接证据 | 需驱动一次 team 会话 |
| L5 | **net 事件词表未实测** | 净增 6 事件的实际 payload 未知 | 需产生对应事件 |

## 6. 复现方式

```bash
# 1. 建立隔离环境（下载 ~136MB，只写 TMPDIR）
./scripts/poc/runtime-poc.sh setup 0.2.1-rc.5

# 2. 跑协议探针
./scripts/poc/runtime-poc.sh verify 0.2.1-rc.5

# 3. 看报告
cat "${TMPDIR:-/tmp}/dsh-poc/0.2.1-rc.5/logs/verify.md"

# 4. 清理（不影响生产）
./scripts/poc/runtime-poc.sh teardown 0.2.1-rc.5
```

## 7. 账本已更新

POC 结果已写入 `docs/compat/compat-status.json`（schema 2）：

| 版本 | 通道 | verdict | verifiedBy |
|---|---|---|---|
| `0.2.1-rc.5` | `next` | **compatible** | `poc:runtime-poc` |
| `0.2.2-alpha.2` | `alpha` | **compatible** | `poc:runtime-poc` |
| `0.1.5-rc.2` | `explicit` | healthy | `ci:upstream-compat(legacy)` |

`recommended` = `0.2.1-rc.5`（`supportedLevel: compatible`，`since 2026-11-01`）。
`latestVerified` 与 `recommended.version` 一致，账本自洽性门禁 PASS。

> **注意**：`supportedLevel` 是 `compatible` 而**非** `supported`。
> 因为 `endToEnd` 与 `teamIntegration` 仍是 `not-run`——按四级规则，
> 不能由"协议通了"推出"我们承诺支持"。这个区别是有意的。

## 8. 下一步

1. **L2 补齐**：需要一次真实模型调用的端到端验证（可先在 POC 沙箱内做，用用户的 key，
   或做 mock harness）。这决定 `supportedLevel` 能否升到 `supported`。
2. **L1 补齐**：在 win32-x64 上跑同一探针。
3. **ADR-0002 R0（能力映射）**：POC 已证明 agent-team 包存在，下一步是读它的实际 API 形状。

## 9. 相关文档

- 决策：`docs/adr/ADR-0004-upgrade-harness-runtime-0.2.md`
- 账本规范：`docs/quality/compatibility-ledger-spec.md`
- 官方能力分级：`docs/architecture/official-capability-matrix.md`
- 工具：`scripts/poc/runtime-poc.sh`、`scripts/poc/protocol-probe.js`
