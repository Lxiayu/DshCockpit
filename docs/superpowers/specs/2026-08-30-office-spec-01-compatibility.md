# Office SPEC-01：Harness 与 Pixi 兼容性探针

> 本分册是所有运行时接线的前置门。没有可复现的探针结果，代理不得凭类型名或猜测增加 UI 能力。
>
> Status: Draft

## 目标与非目标

目标是证明目标 Electron/Harness 版本能提供 Office Adapter 所需的事件、终止证据和控制能力，并证明 Pixi 可以在本地 Electron 页面创建、渲染和销毁。探针只产生脱敏证据，不承担生产 Adapter、Office 状态或 UI。

非目标：升级 Electron/Harness、修改 Harness 源码、接入网络 CDN、把探针变成长期运行服务、证明 Harness 原生存在 `eventId`、`sessionEpoch`、snapshot/resync、pause/resume/preempt。

## 前置阅读与依赖

按此顺序阅读：`office-agent-handoff.md`、SPEC 索引、`总纲.md`、`docs/specs/OFFICE-DESIGN-DISCUSSION.md`、`docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md`、implementation plan。检查 `package.json` 的 Electron 版本、Node 版本和现有 Harness 接线；不得自行安装第二套 Electron。

## 允许修改与禁止修改

允许修改 `scripts/office-harness-probe.js`、`scripts/office-pixi-smoke.js`、`docs/notes/office-pixi-spike-2026-08.md`、`test/office-compatibility.test.js`，以及 `package.json/package-lock.json` 中精确锁定的 Pixi 依赖。若必须修改 `src/harness-rpc.js`，只能增加探针已证明的调用适配，先更新本 SPEC 和 plan。

禁止修改 `src/main.js` 的业务状态、`sessions/`、旧设置 schema、远程资源地址、用户密钥和任何角色包内容。探针失败时不得用 mock 结果标记通过。

## Harness 事实与探针输入

以研究报告为基线，原始事件形状为 `{ type, seq, time, data }`。至少验证以下样例：

| 能力 | 必须观察的证据 | 生产层归属 |
|---|---|---|
| Agent 状态 | `agent/status` 的 `idle/running` | Adapter 映射 runtime |
| 回合终止 | `turn/end.reason` 的实际枚举/未知值 | Adapter terminal reason |
| 子代理 | `subagent/start` 与 `subagent/end.stopReason` | Adapter binding |
| 控制 | `Agent.cancel` 返回和后续终止事件 | Adapter pending/terminal |
| 会话流 | `session.follow/page/control` 可访问范围 | Adapter snapshot 组合 |
| 未证明能力 | pause/resume/preempt/eventId/epoch | capability=false 或 Adapter 派生 |

探针应优先使用只读 fixture replay；若必须连接运行时，只允许 disposable Session，并在结束后清理。任何 prompt、工具参数/结果、Session ID、路径和密钥必须在输出前脱敏。

## 输出契约

`node scripts/office-harness-probe.js --redact` 输出单个 JSON 对象并以退出码区分结果：

```json
{
  "schemaVersion": 1,
  "runtimeVersion": "string|null",
  "electronVersion": "string|null",
  "source": "fixture|runtime",
  "events": [{"type":"agent/status","seq":1,"time":0,"dataKeys":["status"]}],
  "sequence": {"observed": true, "monotonic": true, "gaps": []},
  "terminalReasons": ["completed"],
  "subagentStopReasons": ["completed"],
  "controls": {"cancel": {"available": true, "evidence":"..."}, "pause": {"available": false}},
  "sessionStreams": {"follow": true, "page": true, "control": true},
  "redaction": {"prompts": 0, "secrets": 0},
  "probeStatus": "passed|mismatch|failed"
}
```

`mismatch` 表示与研究报告不同但可记录，不能自动扩大能力；`failed` 表示无法判断，必须阻断下游。证据中不得出现原始 payload，只保留 key 列表和粗粒度枚举。

## Pixi Smoke 契约

脚本必须作为 Electron entrypoint 执行：`./node_modules/.bin/electron scripts/office-pixi-smoke.js --headless`。创建一个 BrowserWindow、一个 `PIXI.Application`、一个本地 data/fixture 纹理 Sprite，等待一次 render，再按逆序销毁 Sprite、Application、Window。报告 `schemaVersion/pixiVersion/electronVersion/renderer/textureWidth/textureHeight/estimatedRgbaBytes/loadMs/destroyed/networkRequests`。

`networkRequests` 必须为 0；禁止 CDN。WebGL 不可用时 `renderer` 为 `canvas` 或 `static`，但必须仍能加载纹理并返回可见诊断；初始化异常退出码非 0。不能用 Node 直接创建 WebGL 代替 Electron 证据。

## CSP、版本与生命周期

探针通过后，Pixi 版本使用 `npm install --save-exact` 固定，lockfile 必须提交。Office 页面仅允许本地 `file:`/`app:` 资源、明确的 inline-safe 脚本和已校验角色包；不得开启通配 `*`、远程脚本或 `eval`。每个 view 只能有一个 Application/ticker；隐藏时暂停，销毁时释放 view-owned textures。

## 实现步骤（TDD）

1. 在 `test/office-compatibility.test.js` 写失败断言：事件归一化、终止原因、子代理配对、unsupported controls、Pixi 无网络和清理标记。
2. 运行 `node --test test/office-compatibility.test.js`，预期因脚本/依赖缺失失败。
3. 实现两个探针和最小 fixture，不引入生产状态。
4. 运行 focused test、Electron smoke 和 `node scripts/office-harness-probe.js --redact`；把实际差异写入 spike note。
5. 如 ESM/渲染器加载失败，停止并先补充 bundling/CSP 决策，不得绕过探针继续下游。

## 验收、失败处理与交接报告

验收：focused tests PASS；Pixi 报告一次可见 Sprite、0 网络请求、clean destroy；Harness 报告事实或明确 mismatch；UI capability 不渲染 false 项。失败只修本分册，保留 JSON 证据，不修改旧模块来“让测试通过”。

交付报告必须包含：探针命令和退出码、Electron/Pixi/Harness 实际版本、完整 capability 矩阵、网络请求数、证据文件路径、未解决 mismatch、修改文件和 staged 清单。错误码建议：`PROBE_RUNTIME_UNAVAILABLE`、`PROBE_EVENT_SHAPE_MISMATCH`、`PROBE_CONTROL_UNSUPPORTED`、`PIXI_INIT_FAILED`、`PIXI_NETWORK_REQUEST`、`PIXI_DESTROY_LEAK`。

## 常见失败与停止条件

- 看到 `cancel()` 返回成功就宣称任务结束：停止，必须等待 terminal event。
- 把 `agent/status=idle` 当离线：停止，idle 仅是运行时当前无活动。
- WebGL 失败但 Canvas 可用：记录 fallback，不阻断详情 UI；若两者都失败，阻断 SPEC-06 之后的渲染工作。
- 版本和研究报告不一致：记录 `mismatch` 并请求主代理裁决，不擅自改契约。
