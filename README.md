**简体中文** | **[English](README.en.md)**

<div align="center">

# 🛩️ DshCockpit

**不是给 dsh 再套一个窗口——而是一个桌面控制平面。**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#)
[![Tests](https://img.shields.io/badge/tests-471%20passing-brightgreen)](#)
[![upstream](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Lxiayu/DshCockpit/master/docs/compat/badge.json)](docs/compat/)
[![Powered by](https://img.shields.io/badge/powered%20by-DeepSeek%20Harness-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

DshCockpit 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）从一条终端命令变成常驻桌面的 Agent 服务：Harness 工作区保持 100% 原生，壳只在其外补齐安全更新、成本核算、后台任务、远程访问——全部通过稳定接口完成。内置运行时，无需安装 Node.js。

</div>

---

## 💬 交流群

欢迎扫码进群，讨论使用问题、反馈建议，或聊聊 Agent 桌面化的玩法。

<div align="center">
<img src="photo/qrcode-group.png" width="260" alt="DshCockpit 交流群二维码" />
</div>

---

## 为什么需要它？

如果你每天用 `dsh` 跑 Agent，有三个问题始终绕不开：

| 问题 | 实际会发生什么 |
|---|---|
| **更新全靠赌** | 上游 rc 版几天一个，手动升级可能弄坏 profile，降级等于重装。 |
| **花了多少钱是黑盒** | 没有用量接口、没有花费面板——等账单到了才知道一次调试狂欢的价格。 |
| **Agent 活在一个窗口里** | 关掉窗口（或合上盖子），长任务就死了；审批请求只能等你回来。 |

常见的桌面壳对这三个问题都无能为力——它们只是把同一个窗口装进托盘。DshCockpit 把 Agent 当作**需要运维的服务**，窗口只是它恰好可见的地方。

## 你能得到什么

### 1 · 一个不会把自己搞坏的运行时

新版本并行安装，必须先通过 `--dump-config` 冒烟测试才允许激活，切换是原子操作。坏版本永远激活不了；一键回滚会同时恢复上一版本**和**数据目录快照。更新自动跟随官方 npm 通道——不 vendor、不分叉、不落后于上游。

### 2 · 成本与用量可观测

- **上下文压力常驻**：安静的胶囊实时显示当前会话输入/输出/缓存 token，60%/85% 预警，一键压缩
- **成本中心**：按天/周/月统计，按工作区归因，峰谷分时计价，月度预算 80%/100% 报警
- **官方余额**：实时显示总额/赠送/充值，精确到每轮对话花费与缓存节省

全部在本地从会话日志计算（纯 JS zstd 解压），零遥测。

### 3 · 你不盯着它也能干活

- **Quick Ask** — `Ctrl+Alt+Space` 随手提问，后台运行，完成通知
- **定时任务** — 日报、周期任务、运行历史
- **IM 渠道** — 飞书 / 企微 / 钉钉：任务完成、审批请求、Agent 提问直达群聊，点按钮即可处理
- **手机远程** — 手机浏览器完整 UI，经鉴权局域网网关配对；Tailscale / Cloudflare 出门在外也能连
- **会话检索** — `Ctrl+K` 全文搜索全部历史；退出自动备份

还有：模型管理（6 家预设 + Ollama 本地模型）、插件与技能市场（安装前可预览）、双语界面、深浅主题。

### 横向对比

| | 裸 `dsh web` | 一般桌面壳 | **DshCockpit** |
|---|---|---|---|
| 双击即用、内置运行时 | ❌ | ✅ | ✅ |
| 更新门禁 + 回滚 + 数据快照 | ❌ | ❌ | ✅ |
| Token/上下文压力 + 预算报警 | ❌ | ❌ | ✅ |
| 按工作区的成本分析 | ❌ | ❌ | ✅ |
| 全局热键后台提问 | ❌ | ❌ | ✅ |
| 定时任务 | ❌ | ❌ | ✅ |
| 会话全文检索 | ❌ | ❌ | ✅ |
| 鉴权手机远程 | ❌ | 罕见 | ✅ |
| 运行**未魔改的官方运行时** | — | 常见 vendor/分叉 | ✅ 始终 |

## 零侵入设计

壳从不给上游源码打补丁，从不碰它的内部实现。所有集成只走稳定边界：HTTP/WebSocket、文件系统（会话日志）、CLI 参数（`--dump-config`、端口发现）与显式 IPC。"Harness 可以变，DshCockpit 保持有用"在这里是工程性质，不是口号。详见 [`DESIGN.md`](DESIGN.md)。

## 🚀 快速开始

**Windows**：从 [Releases](https://github.com/Lxiayu/DshCockpit/releases) 下载 `DshCockpit-<version>-win-x64.zip` → 用 7-Zip/WinRAR 解压 → 双击根目录 `DshCockpit.exe`。约 9 秒开窗，后续版本自动更新。

**macOS**：下载 `.dmg`（Apple Silicon）→ 拖入「应用程序」→ 启动。

> ⚠️ 尚未签名公证——Gatekeeper 会拦截一次，终端执行一次即可永久放行：
> ```bash
> xattr -dr com.apple.quarantine /Applications/DshCockpit.app
> ```

**从源码运行**（Node ≥ 22）：
```bash
git clone https://github.com/Lxiayu/DshCockpit.git && cd DshCockpit
npm install && npm start
```

首次启动：设置 DeepSeek API Key（齿轮有红点提示）→ 选择工作区 → 开始对话。其余一切都是可选的。

## 📸 界面预览

<div align="center">

<img src="photo/preview-1.png?v=0.2.7" width="720" alt="原生 DeepSeek Harness 工作区 + DshCockpit Edge Rail 上下文状态" />

<table><tr>
<td><img src="photo/preview-2.png?v=0.2.7" width="280" alt="成本中心：工作区花费、预算与报警" /></td>
<td><img src="photo/preview-3.png?v=0.2.7" width="280" alt="控制中心与插件市场" /></td>
</tr></table>

</div>

## 诚实的局限

- macOS 包尚未签名公证（需要上面那行 `xattr`）；Windows 可能因同样原因触发 SmartScreen
- 单人维护的项目；主要在作者自己的机器上实战验证
- Windows 是主要开发目标；macOS arm64 由 CI 构建并冒烟测试（Intel 包暂停发布，可在 Apple Silicon 上自行交叉构建），但真实环境里程较少

## 🤝 贡献

欢迎 PR！请先跑 `npm test`（1422 项测试）。架构见 [`DESIGN.md`](DESIGN.md)，产品理念见 [`PHILOSOPHY.md`](PHILOSOPHY.md)，功能清单见 [`FEATURES.md`](FEATURES.md)，竞争路线图见 [`ROADMAP.md`](ROADMAP.md)。

<details>
<summary><b>操作层原则（产品理念）</b></summary>

Harness owns the workspace. DshCockpit owns the operating layer.

工作区——对话、文件、代码、审批——属于 Harness，保持原样。它周围的一切——监控、成本、自动化、更新、远程——属于驾驶舱。高频操作保持可见；Settings 只放持久配置；小问题永远不打开大面板（`默认 → Peek → Cockpit → 完整配置`）。Agent 不是窗口：它是持续运行、持续累积用量、随时接受指令的桌面服务，与前台是什么无关。

完整理念见 [`PHILOSOPHY.md`](PHILOSOPHY.md)。
</details>

## 🧰 开发日志 · P5（2026-09-23，未提交）

**P5 第一步：B-1 外提 + 摘编辑器 UI**（顺序铁律：先外提验证切片，再摘 UI，物理删除与排包是第二步）

- **B-1 外提**：`src/office/layout-editor.js`（52KB 编辑器内核）里生产启动链唯一需要的 schema-v1 验证切片（`parseDraft` / `validateDraftSchema` / `ASSET_BY_ID` / 层默认表 / 稳定错误码）**移动**到新模块 `src/office/layout-schema.js`——零 DOM/Electron/Pixi/fs 依赖的纯模块，唯一 require 是 `layout-assets.js` 目录。编辑器改为 require 它（单一真源），编辑器本体留在仓库等第二步处理。
- **生产 boot 不再加载编辑器**：`office.html` 原来在任何界面动作前 `loadModule('./layout-editor.js')` 并造一次性 editor 实例取 `validateDraftSchema`；现在直接加载 `layout-schema.js` 并注入自由函数 `validateDraftSchema` 给 `office-boot.resolveProductionLayoutDraft`。saved > bundled 优先级与坏草稿拒绝行为逐字不变（`test/office-layout-schema.test.js` 用**真校验器**钉住整条链：有效 saved 胜出、损坏/不可解析 saved 回退 bundled 并报 `OFFICE_LAYOUT_SAVED_INVALID`、全失败 fail-closed）。真壳探针实测：boot 全程**零次**请求 `layout-editor.js`，`layout-schema.js` 正常加载。
- **摘掉编辑器 UI 与入口**：`office.html` 删除编辑器 DOM 块（palette/toolbar/inspector/align-bar/shelf/canvas/layer-panel）、1218 行连续接线（指针/框选/快捷键/检查器/保存导入/图层面板）、页脚「布局编辑」chip 与 `?editor=1` 自动打开；`office.css` 删除约 61 条编辑器规则与 chip 样式（保留混排其中的 `.checkbox` 与两个生产媒体查询）。页面侧只服务该 UI 的代码（keyup/快捷键分支/resize 编辑器分支/证据钩子四条）随之清理。
- **测试同批更新**（有意更新，不是放宽）：删除 28 个钉住编辑器 UI 的测试（随编辑器搬往工作台）；改写 boot 链测试指向 `layout-schema`；新增静态断言钉住「编辑器已不存在」（`office.html` 无 `layout-editor` DOM/模块加载/chip/`布局编辑`，`office.css` 无编辑器选择器）；`test/office-right-panel-p2.test.js` 原「编辑器 DOM 未动」断言反转为不存在断言。
- **渲染证据**：`/tmp/office-e2e/p5-no-editor.png`（+ `p5-no-editor-live.png`、`p5-no-editor.json`）——无任何编辑器代码参与，office 页正常 boot（webgl、canvas 960×630、bundled-flat 布局链、五名员工在岗），右栏 P1–P4 各块齐全，页脚已无「布局编辑」入口。
- **未动**：`resources/office/layout-editor/**`（生产家具素材源，名字骗人）、`resources/characters/**`、仿真/动画逻辑、`office:*` 通道数（8 个）；编辑器独立成页（B-2）与排包排除（A-1/A-6）属第二步。

**P5 第二步：排包闸门 + 主仓创作块清出 + 真包冒烟**（顺序铁律收尾：先排包（产物层），再物理清出（仓库层），最后真包验证）

- **排包（A-1）**：`electron-builder.js` `files` 白名单新增排除——`src/workbench/**`、`src/office/layout-editor.js`、`playground.{html,page.js,css}`、`fixtures/character-pack/**`、`fixtures/events.json` / `waypoints.json`，并对 `content/**`、`photo/**`、`artifacts/**`、`test/**`、`docs/**` 与全部创作脚本显式钉死（白名单本就排除，防止未来放宽回流）。**同名陷阱已注释钉住**：`resources/office/layout-editor/`（extraResources 里的生产家具素材，24 张方向图）严禁按名字排除。
- **负向断言（A-6）**：`scripts/verify-dist.js` 增加 asar 直读能力（镜像 `@electron/asar` 的 header pickle 格式，零新依赖）与三道闸门——① 创作块条目必须为 0（编辑器/工作台/playground/夹具/gen-*/content/photo/artifacts/test/docs）；② 生产表面必须在（`office.html`/`office-boot.js`/`layout-assets.js`/`layout-schema.js`/三个布局夹具/`render/**`/`runtime/**`（含内化的 `runtime/validate-character-pack.js`）/`pixi.min.js` 等 18 项）；③ asar 条目数 ≤ 预算 3603（实测 3275 + 10% 余量）。另加正向着色：`resources/office/layout-editor/*.png`、`flat/*.png`、`characters/deepseek-default/manifest.json`、`dialogue/*.json` 必在产物内。验证覆盖全部轨道（`build.js` 出货前恒触发：win zip/win-unpacked、mac zip/.app、以及无平台参数的 `npm run build`；zip 与 .app 两种内部布局已分别实测），且只门禁本次版本产物。基线上实测：改配置前跑 verify 报 FAIL（抓到 52 个创作块条目），改后全绿。**实测还抓到过一类真实缺陷**：dist/ 里残留的**同版本陈旧 zip** 会被如实判失败（防止把旧树产物当新包发布）。
- **物理清出**（38 个文件，均逐一核实 s1 同路径对应物后删除）：`src/workbench` 外壳 7 文件 + `lib/{asset-validator,content-validator}.js`（63,050 + 23,474 B——其余 6 个 lib 被**保留的** `scripts/office-assets/normalize-*.js` 反向依赖，故留）、`src/office/layout-editor.js`（44,932 B）、playground 三件（42,755 B）、`fixtures/{events,waypoints}.json`（2,803 B）；`scripts/` 15 个工具（launchers×2、gen-*×5、apply-walk/asset-gap/flat-gen×3、publish/export×2、acceptance run/evidence/view-evidence×3）；`test/fixtures` 5 个验收探针模板（~83 KB）、`test/office-{playground,gen-frames,asset-gap-report}.test.js` 三个工具测试文件。`package.json` 的两个 dev 脚本随 launcher 删除。**`photo/` 4 个预览图按铁律保留**：s1 的 `photo/` 虽是 1.7 GB 超集，但这 4 个文件（二维码 + 3 张界面预览）在 s1 无同路径对应物，且 README/README.en 直接引用。
- **测试手术**（有意更新，不是放宽；套件 1422 → **1286，−136 精确对上账**）：删 3 个工具测试文件（26+15+9）、`office-ui.test.js` 删 7 个（M2b 探针契约 + E4/E5a/E5a-R1/E5a-R2 四个真壳 + M0 launcher/shell 两个工作台契约）、`office-asset-runtime.test.js` 删 78 个（编辑器内核测试群 + M0/M1 发布内核段，其数据源 `content/**` 已随工具清出）、`office-layout-schema.test.js` 删 1 个（"编辑器 require schema 单一真源"随编辑器删除）。两处混合测试**改指不断言**：E4.6 归档白名单与 E3a flat-draft schema 校验从 `editor.load` 改指 `layout-schema.parseDraft/validateDraftSchema`。`office-asset-pack.test.js` 的 E5a-R1 grep-lock 去掉已删除的 `test/fixtures` 扫描根（`src/office` 覆盖不变）。**为保全覆盖面而保留**的项：`test/fixtures/` 里 4 个 draft/provenance 夹具（生产编译器/resolver 测试模块级依赖，误删后已从 git 恢复）、`src/workbench/lib` 6 个发布内核（被保留的 office-assets 脚本依赖）、`scripts/office-assets/**`（生产 `character-pack-installer.js` 的校验真源 + 测试入边）、`scripts/office-{harness-probe,pixi-smoke}.js`（`office-compatibility.test.js` 模块级依赖）、`content/**`（dialogue 一致性守卫 `M4.1d` 读它）、`artifacts/**`（release-gate 读它）、`src/office/fixtures/character-pack/**`（6 个生产测试模块级载入作夹具数据 + main.js 冻结 playground 路径引用——均排除出包但留存仓库）。
- **真包冒烟**：`node scripts/build.js --mac dir`（verify 门禁全绿）→ `scripts/e2e-smoke.js` 冷启动打包产物 HTTP 200（exit 0）→ 带 `DSH_DESKTOP_OPEN_OFFICE=1` 真启动 `.app`，办公室视图全屏渲染（`[office] layout source: bundled-flat` → `[office] prewarmed pack + layout`），两轮截图（间隔 9 秒，行走姿势有差异证明场景是活的）：`/tmp/office-e2e/p5-b-office.png`、`p5-b-office-walk.png`，机读事实 `/tmp/office-e2e/p5-b-smoke.json`（asar 3,276 条目 / 创作块 0 / 生产表面 18 项齐全 / layout-editor 24 图 + characters 在产物内 / 截图像素多样性约 3.9 万色）。**收尾后重跑仍六项全过**。另注：本地 `npm run build`（zip 轨）会带 owner 占位符的 app-update.yml，e2e-smoke 的 updater 守卫会按设计拦下——本地冒烟用 `--mac dir` 轨（不含 feed），真实发布坐标由 CI 环境变量注入。
- **产物对比**：app.asar 3,327 → **3,275 条目**（−52），30,912,799 → **28,960,440 B**（−1.86 MiB，−6.3%）；`src/` 174 → 159 文件 / 4,406,229 → 4,229,215 B（−177,014 B）；整包 `DshCockpit.app` 472M → 470M（大头是 runtime 139M + extraResources 38M，均不动）。`extraResources`（office 26M / characters 12M / dialogue）**零变化**。
- **s1 零改动**：`git -C /Users/xia/program/dsh/DshCockpit-s1 status --porcelain` 为空、HEAD 仍为 `4e314e4`。主仓删除的每一项在 s1 均有同路径对应物（38/38；`layout-editor.js` 与 `e5a-r2` 探针模板在 s1 为 P5-1 之前的原版，能力是主仓现存版的超集）。按铁律"凡 s1 无对应物一律不删"保留的项：`photo/` 4 个预览图（README 直接引用、s1 无同路径文件）、`src/office/fixtures/character-pack/**`（6 个生产测试模块级载入作夹具数据 + main.js 冻结 playground 路径引用）、`content/**`（dialogue 一致性守卫读它）、`artifacts/**`（release-gate 读它）、`src/workbench/lib` 6 个发布内核（被保留的 office-assets 脚本 + 保留测试依赖）、`test/fixtures/` 4 个 draft/provenance 夹具（生产编译器/resolver 测试模块级依赖）。

**P5 收尾：修打包自洽缺陷（内化角色包校验器）**

- **缺陷**：`src/office/runtime/character-pack-installer.js`（产品代码）模块级 require `../../../scripts/office-assets/validate-character-pack.js`，而 `files` 白名单只含 `src/**`——**打包产物内这条 require 指向不存在的文件**（dev 下能跑、真包里必 MODULE_NOT_FOUND；此前零运行时影响只因该 installer 尚无生产加载方）。
- **修复**：`git mv` 至 `src/office/runtime/validate-character-pack.js`（自身零外部依赖，仅 node:fs/path，链路一次内化即自洽）；installer 改 `require('./validate-character-pack.js')`；两个测试的路径引用同步更新；`verify-dist.js` 生产表面清单 +1（产物内必须存在）；新增 `test/office-packaging-boundary.test.js` 静态钉死——① 全仓不再有任何 `src/**` → `scripts/**`（src 外）的 require 边（唯一合法豁免：asar 根按策略必有的 `package.json`）；② installer 的校验 require 指向 src 内兄弟文件；③ 有 dist 产物时直接验 asar 内含该文件。
- **实测**：门禁对旧树 zip 报 `missing: src/office/runtime/validate-character-pack.js`（负向断言有效），新树产物全绿（asar 3,276 条目 = 3,275 + 1）。

## 📄 许可与致谢

[MIT](LICENSE) · 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建。社区项目——与 DeepSeek 官方无隶属关系，也未获其背书。
