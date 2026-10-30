# docs/README.md —— 文档唯一索引

> 规则（机械校验见 `test/docs-index.test.js`）：
> 1. **本文件是唯一索引**——`docs/` 下每个非归档文档都必须在这里登记；未登记 = 测试红。
> 2. **活跃文档入库**（2026-10-27 文档重构起）；`docs/archive/` 是本地历史保险箱（git 忽略），不在此逐一登记。
> 3. 新增/移动/删除文档时同步本表；过时文档移入 `docs/archive/` 并在归档说明里写清原因。
> 4. 文档结构按用途分层：契约（architecture）/ 产品方向（product）/ 研究（research）/
>    计划与报告（plans）/ 质量与来源（quality）/ 脚本产物（compat）。
> 5. 仓库地图与开发铁律在根目录 `AGENTS.md`（≤130 行）；新会话先读它。

## 1. 架构与契约（长期有效，改动需拍板）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/architecture/HARNESS-RUNTIME-CONTRACT-v0.md` | 权威 | Harness→Office 运行时内核边界：journal→渲染事实链、通道冻结 |
| `docs/architecture/TEAM-RUNTIME-CONTRACT-v0.md` | 权威 | Team Runtime v0：Job/Role/WorkerRun/Artifact、事实唯一作者、收敛规则 |
| `docs/architecture/WORKER-EXECUTION-CONTRACT-v0.md` | 权威 | 执行端口契约 + controller 唯一转换 + dsh 后端；§17 记 v0.6 增量 |
| `docs/architecture/MCP-MANAGER-SPEC.md` | 权威 | MCP 管理器 v2（CRUD/双传输/健康检查） |
| `docs/architecture/OFFICE-DESIGN-DISCUSSION.md` | 权威 | 办公室产品决策日志（45 条：角色/四层状态/布局/动画） |
| `docs/architecture/2026-09-23-office-right-panel-spec.md` | 权威 | 右栏数据契约（usage/staff/pending/timeline/detail） |
| `docs/architecture/office-workbench-design.md` | 权威 | 工作台设计原则（内容/引擎分离） |
| `docs/architecture/office-workbench-m0.md` | 权威 | 工作台 M0 边界与已拍板决定（平面 2D） |
| `docs/architecture/2026-08-30-office-spec-00-boundaries.md` | 权威 | 办公室 SPEC-00 边界（冻结词表/文件边界） |
| `docs/architecture/office-asset-naming.md` | 权威（门禁依据） | 素材接入规范：命名/目录/声明面/layer 带宽；E2e/E3a 测试直接读本文 |
| `docs/architecture/2026-08-30-office-development-spec-index.md` | 权威 | 办公室 SPEC 索引（Task→SPEC 映射） |

## 2. 产品方向

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/product/WORK-FIRST-V0.7.md` | **草案（待拍板）** | v0.7 方向：Work Product 一等公民、工作台为主、办公室为氛围层、首跑 5 分钟、P1/P2/P3 分期 |

## 3. 研究（有证据价值，按日期）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md` | 参考 | Harness 原生能力证据（办公室边界事实） |
| `docs/research/TEAM-RUNTIME-OSS-RESEARCH-2026-10.md` | 参考 | Agent-team OSS 调研（58 仓），支撑 Team Runtime 立场 |
| `docs/research/DSH-EXECUTION-BACKEND-COMPAT-2026-10.md` | 参考（已按 v0.6 校正） | dsh 执行后端映射盘点；artifact/crash 缺口已由壳侧物化与 WP1 合成覆盖 |
| `docs/research/HARNESS-V0.7-P1-REPORT-2026-10-27.md` | 进行中（待真机） | v0.7 P1 报告：工作区/产物/工作台、变异矩阵、真机脚本、已知缺口 |
| `docs/research/WHALE-GIRL-LORE-RESEARCH-2026-10.md` | 参考（长期有效） | 鲸鱼娘社区生态调研：四条硬设定、83 条台词、五类禁用清单、「鱼片」查证结论。**闲聊语料库与内容红线测试的依据** |

## 4. 计划与报告

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/plans/completed/HARNESS-V0.6-PLAN-2026-10-25.md` | 已完成 | v0.6 五工作包计划（续跑/过程可见/首帧/推送/归档） |
| `docs/plans/completed/HARNESS-V0.6-REPORT-2026-10-26.md` | 已完成 | v0.6 完成报告：变异矩阵、真机脚本、遗留 |
| `docs/plans/completed/2026-08-30-virtual-office-runtime-implementation.md` | 已完成 | 办公室运行时 Task 0–9（历史记录；路径按当时结构） |
| `docs/plans/completed/OFFICE-V3-INTERACTION-STAGE-REPORT-2026-10-30.md` | 已完成 | 互动层阶段报告：6 个缺陷修复、左右站位回退、语料调研、高内聚拆分、5 条遗留规则 |

| `docs/plans/active/HARNESS-V0.7-P1-PLAN-2026-10-27.md` | **进行中** | v0.7 P1 实施：工作区/产物落地/工作台/门禁；含与上位文档的偏差声明 |
| `docs/plans/active/HARNESS-V0.7-P1.5-DOCK-PLAN-2026-10-27.md` | **进行中** | P1.5：工作坞并入办公室（右栏收成浮动待办）、角色悬停卡与暂停呈现 |
| `docs/plans/active/HARNESS-V0.7-P2-PLAN-2026-10-27.md` | **进行中** | P2：专用 Team runtime（cwd=工作区）、变更捕获、Verification Runner、受控 retry |
| `docs/plans/active/OFFICE-V3-VISUAL-PLAN-2026-10-27.md` | **进行中** | P3 视觉重构：呈现时钟、代码环景、伪 3D 生成布局、dsh-pet 式交互（P3.0/P3.1/P3.3/P3.4 已落地） |
| `docs/plans/active/OFFICE-V3-ISOMETRIC-PLAN-2026-10-27.md` | **I0 完成，待评审 I1** | 等轴测投影：投影数学、画家算法遮挡、命中测试、I0–I4 分阶段与回退 |
| `docs/plans/active/OFFICE-V3-CODED-2.5D-PLAN-2026-10-27.md` | **进行中（互动层已收口）** | 2.5D 代码化家具 + §21 走路系统重构 + §22 互动层打磨（拖拽/交互区/闲聊朝向/语料）。视觉细化仍可继续 |

进行中的计划放 `docs/plans/active/`；完成的移入 `completed/`。

## 5. 质量与来源

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/quality/2026-09-26-asset-provenance.md` | 参考（脚本配套） | 素材来源链说明；`scripts/asset-provenance.js` 输出 `docs/quality/2026-09-26-asset-provenance-index.json` |

## 6. 脚本产物（由脚本生成/更新，不要手改）

| 文档 | 状态 | 说明 |
|------|------|------|
| `docs/compat/2026-08-23-0.1.1-rc.2.md` | 自动生成 | 上游兼容报告 |
| `docs/compat/discussion-body.md` | 自动生成 | 兼容报告对应的 Discussion 模板 |

## 7. 历史（归档）

`docs/archive/`（本地保险箱，git 忽略）：2026-08～10 的旧计划/报告/设计/s1 时代笔记与 legacy 快照，
含用户拍板记录与决策追溯；**不作为新设计依据**。详见 `docs/archive/README.md`（本地）。
2026-09-16 的"docs/ 不跟踪"决定已由 2026-10-27 重构覆盖（活跃文档入库，归档保持本地）。

## 8. 维护

- 文档园丁（每次批次收尾）：核对本索引、移动过期文档、修正与代码矛盾的描述。
- 与代码矛盾的文档**优先修正或归档**，不允许带着错误描述留在活跃区（2026-10-27 审计发现的矛盾点已全部处理，见提交 `d50f198`）。
