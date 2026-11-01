# Execution Plan：P0 工程实施（正式）

> 状态：**active** · 创建 2026-11-01 · 用户 2026-11-01 正式授权进入 P0
> 上游：`docs/product/product-roadmap.md` P0、`docs/adr/ADR-0001..0006`（全部已接受）
> 前序计划：`docs/plans/active/P0-AUDIT-AND-P1-MISSION-KICKOFF-2026-11-01.md`（审计与规划，已完成）
> **本计划是 P0 的唯一执行依据。** 每个 Issue 对应本计划的一节。

## 1. Goal

建立进入 Mission Core 正式开发前的**工程地基**：可靠的兼容性账本、真实的 CI 门禁、许可证合规机制、官方 Runtime 的明确 POC 结论、数据保护方案、关键 IPC 行为测试骨架。

## 2. Non-goals（本轮明确不做）

- ❌ **不**开发 Mission Desk
- ❌ **不**开发 Capability Marketplace
- ❌ **不**开发 Live2D
- ❌ **不**开发 Mission Core 正式功能（必须等 P0 完成条件全部满足）
- ❌ **不**把自研 Team Runtime 直接删除（见 ADR-0002 §5.0 退役硬约束）
- ❌ **不**一次性迁移全部旧设置到 SQLite
- ❌ **不**做大规模无关重构

## 3. 执行顺序（用户 2026-11-01 明确指定）

| 序 | Issue | 内容 | 预估 | 依赖 | 状态 |
|---|---|---|---|---|---|
| **1** | #21 | 修复兼容性账本 | 1–1.5 天 | 无 | ✅ **完成**（commit ca08f71） |
| **2** | #10 | CI 自动化门禁 | 0.5–1 天 | #21 | ✅ **完成**（commit 89c836b） |
| **3** | #14 | 许可证与依赖检查 | 0.5–1 天 | 无 | ✅ **完成**（commit 7aaacdd） |
| **4** | #9 | Runtime & Protocol POC | 1–2 天 | #21 | ✅ **协议层完成**（端到端待补） |
| **5** | #22 | main.js 关键行为测试骨架 | 1–2 天 | 无（可前可后） | ⬜ |
| **6** | #19 | Settings 数据保护 | 1 天 | 无（可前可后） | ⬜ |

**并行说明**（用户明确）：#22 与 #19 可根据依赖在 POC 前后合理并行。**但不得从计划中消失。**

```
#21 ──→ #10 ──→ #14 ──→ #9
                              ↘
 #22 ────────────────────────→ (可与上面并行)
 #19 ────────────────────────→ (可与上面并行)
```

## 4. 各 Issue 的质量要求（用户明确）

### #21 兼容性账本

- [ ] Runtime 版本与 Release Channel **不混淆**
- [ ] CI 结果**可追溯**（run id / commit / 平台 / 时间）
- [ ] **Verified / Fresh / Supported 三者分离**
- [ ] 账本与实际 CI 结果**一致**
- [ ] 增加**自动化检查**，防止信息链再次断裂
- [ ] 通道分级新鲜度：**prerelease 7 天 / stable 30 天**（不采用统一 7 天）
- [ ] 事件驱动强制复验（runtime/adapter/lockfile/测试矩阵变化）
- [ ] **历史验证成功不得因时间流逝被改写成失败**

### #10 CI 门禁

- [ ] 明确报告 **Passed / Failed / Skipped / Todo**
- [ ] **不得把 Skip 计作 Pass**
- [ ] 核心测试、类型检查、Lint、构建、架构检查形成明确门禁

### #14 许可证检查

- [ ] 检查**直接依赖 / 间接依赖 / 最终实际分发内容**
- [ ] 支持**有依据的许可证例外**
- [ ] **不允许未知或特殊许可证被静默放过**

### #9 Runtime POC

- [ ] 严格使用**独立目录 / 独立 Profile / 独立 Workspace / 独立测试数据**
- [ ] 不得修改生产 Runtime / 真实 Settings / 用户 Workspace / 锁定版本
- [ ] **分别记录** 0.2.1-rc.5 与 0.2.2-alpha.2 结果
- [ ] 验证**真实功能**，不止"能启动"
- [ ] 至少覆盖：Team / Session / 成员事件 / User Question / Approval / 重连 / 恢复
- [ ] 未实际验证的能力**必须明确标记**

### #19 Settings

- [ ] **先保护现有数据**
- [ ] 不因计划使用 SQLite 就一次性迁移全部旧设置
- [ ] 独立、**可回滚**的数据迁移方案

## 5. 工程纪律（用户 2026-11-01 明确）

1. 每个 Issue 对应明确的 Execution Plan 或轻量任务计划
2. **先理解现有代码再修改**
3. 小步实施，避免大规模无关重构
4. 每个阶段必须有自动化验证
5. 涉及核心架构时更新 ADR
6. 发现新问题及时创建 Issue
7. 暂不开发的功能进入 Deferred Backlog
8. 发现新技术方案先建立 Research Issue
9. **不允许通过不断增加文档代替实际开发**
10. 每次完成任务都更新执行进度、测试结果和剩余风险

**AGENTS.md 保持精简**，详细证据放对应文档。

## 6. P0 完成条件（进入 Mission Core 的前置门槛）

**以下全部满足**，才建议进入 Mission Core 正式开发：

- [ ] 兼容性账本可靠（#21）
- [ ] CI 门禁建立（#10）
- [ ] 许可证审查机制建立（#14）
- [ ] 官方 Harness Runtime POC 得到明确结论（#9）
- [ ] Team / Session 数据映射方案经过验证（#9 + ADR-0002 R0）
- [ ] Settings 数据保护方案完成（#19）
- [ ] 关键 IPC 行为测试具备基本安全网（#22）
- [ ] 相关文档、ADR 和 Issue 已同步

## 7. 测试基线（本轮确立）

```bash
CI=1 npm test    # → 1935 / 1935 / 0 fail（唯一有效基线）
```

详见 `docs/quality/test-tiers-and-baseline.md`。

**报告必须区分 Passed / Failed / Skipped / Todo，且 Skip 不计入 Pass。**

## 8. 进度表（每完成一个 Issue 更新）

| 日期 | Issue | 结果 | 证据 |
|---|---|---|---|
| 2026-11-01 | 规划轮完成 | 22 份文档 + 6 ADR + 14 Issue | `docs/`、GitHub #9–#22 |
| 2026-11-01 | 用户授权 P0 | ADR-0001..0006 全部接受 | 各 ADR 状态行 |
| 2026-11-01 | #21 | ✅ 完成：schema 2 账本 + Verified/Fresh 分离 + 通道分级 + 防复发门禁 + CI 三层回写 | `test/compat-ledger-v2.test.js` 22 项；全量 1959/1959/0 fail；变异 4 组全部 DETECTED |
| 2026-11-01 | #10 | ✅ 完成：ci.yml PR/push 门禁 + 四态诚实报告 + 修复 Skip 冒充 Pass | `test/ci-gate.test.js` 16 项；TAP passed=1989/failed=0/skipped=1 |
| 2026-11-01 | #14 | ✅ 完成：许可证三层检查（直接/传递/分发一致性） | `test/check-licenses.test.js` 15 项；真实仓库 167 传递包全合规 |
| 2026-11-01 | #9 | ✅ POC 协议层完成：三版本隔离验证 16/16 PASS；账本写入 compatible | `docs/research/runtime-poc-report-2026-11-01.md`；`scripts/poc/` |

## 9. 风险与阻塞

| # | 风险 | 状态 | 缓解 |
|---|---|---|---|
| 1 | PR #7 卡死三个月，自动回写链路失效 | 待处理（#21） | L1 改为直接推 + L2 超期检测 |
| 2 | 0.2.x 破坏性未实测 | 待 #9 | POC 覆盖 Protocol 层 |
| 3 | 自研 Team Runtime 退役无路径 | 已定 R0–R5 门槛 | ADR-0002 §5.0 |
| 4 | CI 中 Skip 被误当 Pass | 待 #10 | 显式四态报告 |

## 10. 回退方案

| 变更 | 回退方式 |
|---|---|
| 账本 schema 升级 | 保留 schema 1 读取兼容；旧文件 git 可恢复 |
| CI 新 workflow | 删除 workflow 文件，无代码影响 |
| POC 产物 | 在独立目录，不在仓库/生产环境 |
| Settings 迁移 | 迁移前自动备份 + 可回滚脚本 |

**禁止**：`git reset --hard` / `git clean -fd` / `git checkout -- .`。

## 11. 相关文档

| 目的 | 文档 |
|---|---|
| 账本规范 | `docs/quality/compatibility-ledger-spec.md` |
| 测试分级 | `docs/quality/test-tiers-and-baseline.md` |
| 门禁策略 | `docs/quality/quality-gates.md` |
| 官方能力分级 | `docs/architecture/official-capability-matrix.md` |
| 领域模型 | `docs/architecture/domain-model.md` |
| ADR | `docs/adr/` |
