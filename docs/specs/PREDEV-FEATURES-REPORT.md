# DshCockpit 预开发功能报告（v0.3.1 过渡版）

> 状态：**v0.3.0 已交付（2026-08-26）· 本文件聚焦 v0.3.1 开发范围** · 编制：2026-08-23 · 重写：2026-08-26
>
> 本文件已清理 v0.2.8→v0.3.0 的已完成内容（压缩至 §2 历史记录）；§3 起为 **v0.3.1 唯一开发范围基线**：鲸鱼娘皮肤系统准备（主项）+ 三个过渡项。远期主线（R11 多模型编排总控台）保留于 §4，不排期。

---

## 1. 总原则：不影响现有壳版本

当前稳定版 **v0.3.0** 已交付能力（运行时更新管道、成本中心、IM 渠道双向控制、远程网关、启动自检、兼容快报、通知中心、缓存看板、周报卡片、NSIS 分发等）**不允许被本期任何改动破坏**。硬性约束：

| # | 约束 | 说明 |
|---|---|---|
| C-1 | **新增为主，修改最小化** | 新功能一律落在新模块文件中；对 main.js / settings.html 只做"接线式"增量（注册 handler、追加导航项），禁止重构既有代码路径 |
| C-2 | **IPC 只增不改** | 全部使用新 channel 名（如 `skin:*`、`mcp:*`）；既有 channel 的请求/响应结构冻结 |
| C-3 | **设置只追加** | 新字段仅追加到 `settings-store.js` DEFAULTS（带默认值），既有字段键名/类型/语义不变；老 settings.json 无需迁移即可加载 |
| C-4 | **数据只写新文件** | 皮肤资产、MCP 缓存等写入新的 userData 子目录/新文件；不触碰 sessions、settings.json、runtime-state.json 既有格式 |
| C-5 | **回归门禁** | 每批合入前：既有测试全绿（`npm test`）+ 该批次新增守护测试全绿；任一红即回滚该批 |
| C-6 | **功能开关化** | 新功能（尤其皮肤系统）默认关闭，失败可经设置关闭，不留死路径 |
| C-7 | **main.js 改动必须 `node --check`** | `npm test` 不加载 Electron 主进程文件，语法错误会漏网（v0.2.8 H4 事故）；改 main.js 先 `node --check` 再跑测试 |
| C-8 | **不碰无关文件** | 本版范围之外的文件一律不修改；新增测试放 `test/`，命名 `<模块>.test.js` |

---

## 2. 历史交付记录（已完成，供追溯，不再展开）

| 版本 | 交付内容 | 日期 |
|---|---|---|
| **v0.2.8** | H1 成本中心周末谷价（DeepSeek 新规）、H2 node-forge 安全升级、H3 pnpm-shim（打包版插件安装） | 2026-08-23 |
| **v0.2.9** | H5 运行时版本代差（内置运行时 0.1.1-rc.2 + 系统 dsh 优先 + 崩溃根因识别）、H6 pnpm store major 匹配、R1 启动自检+一键修复、R2 上游兼容快报、打包白名单瘦身 | 2026-08-24 |
| **v0.3.0** | R4 缓存经济学看板、R5 周报卡片、R6 通知中心、IM 渠道重构（飞书协议修正/双向会话控制/体验层）、D 线分发（prune、slim/full 双轨、NSIS 向导、mac ad-hoc 签名）、H7-H11 真机修复批 | 2026-08-26 |

> 已交付文件速查：`src/cost.js`（含 WEEKEND_OFFPEAK_SINCE）、`src/pnpm-shim.js`、`src/boot-check.js`、`src/compat-status.js`、`src/crash-reason.js`、`src/runtime-pick.js`、`src/cache-economics.js`、`src/weekly-report.js`、`src/notification-center.js` 等。

---

## 3. 本版开发范围（版本号待定：内容足够多/好则直接 v0.4.0，见 S1 §7）

### S1 · 壳容器化 + Agent 总控台「办公室视图」（本版主项，产品形态级升级）

> **产品形态（用户 2026-08-26 确认）**：把桌面壳彻底变成 **DeepSeek Harness 的容器应用**——壳最左侧一条**功能栏**：上部 = **Harness** 入口（进入正常 DeepSeek Harness 交互界面），下部 = **办公室**入口（点击整页切换到办公室视图）。办公室视图 = **Marvis 式拟人化总控台 × puffo 式多 Agent 协作实体**：每个工位 = 一个真实 Agent 实体（harness 会话/子代理），鲸鱼娘是它的**具象化身**（非桌宠），状态机驱动化身表情/动作。多 Agent 协作（puffo 式对话/任务传递）为后续阶段。

**与竞品/参考的差异定位**：
- vs Marvis：固定 6 角色单向派发 → 我们**动态 Agent 池**（每个会话 = 实体，可增可减）；
- vs puffo：纯 IM 无可视化 → 我们**办公室可视化 + 协作**；
- 我们 = Marvis 的"办公室皮" × puffo 的"多 Agent 实体" × harness 的"执行内核"。

---

#### S1.1 壳容器化重构（P0 前置，先于办公室视图）

**现状**：`mainWindow` 直接加载 harness URL，壳 chrome（Edge Rail/设置按钮/Token 胶囊）由 `cockpit-preload` 注入 harness web。

**目标形态**：

```
┌──────────┬─────────────────────────────────────────┐
│ 功能栏    │  视图容器                                │
│ (常驻)    │  视图1：Harness（嵌入 harness web）       │
│ ┌──────┐ │  ─────────── 整页切换 ───────────         │
│ │Harness│ │  视图2：办公室（壳本地 office 页）         │
│ │ (上)  │ │  工位墙 × Agent 实体 × 化身 × 状态        │
│ ├──────┤ │                                         │
│ │ 办公室 │ │                                         │
│ │ (下)  │ │                                         │
│ └──────┘ │                                         │
└──────────┴─────────────────────────────────────────┘
```

**技术方案（选型建议，实施前需小实验验证）**：
- **壳壳层页**：新 `src/shell.html`（本地页）作为 `mainWindow` 唯一载体，内含左侧功能栏 + 视图容器；
- **Harness 视图嵌入**（三选一，按推荐序）：
  1. **WebContentsView**（Electron 现代推荐）：独立 webContents 嵌入 harness，`addChildView/removeChildView` 切换；**首选**；
  2. `webview` tag：隔离偏好与权限可控，但 Electron 维护者不推荐长期使用；
  3. `iframe`：需验证 harness 是否允许被嵌入（CSP/X-Frame-Options）——**先做小实验**，不行则回退 1/2；
- **办公室视图**：壳本地 `src/office.html`（非嵌入，DOM 渲染）；
- **兼容要求**：现有 `cockpit-preload` Edge Rail/Token 胶囊**继续注入 harness webContents**（保持不变）；托盘/设置/quickask/search/loading 窗口不受影响；单实例锁/运行时管理/崩溃守护逻辑不变。
- **隔离策略**：新增 `src/shell.html` + 视图容器接线；`mainWindow` 创建流程改造集中在 main.js 一处；其余模块零改动。

**验收（S1.1）**：壳启动 → 功能栏常驻 → 默认 Harness 视图正常（含 Edge Rail 注入）；点办公室 → 整页切到 office 页；切回无状态丢失；小实验记录 iframe 可行性结论；`npm test` 全绿 + C-7。

---

#### S1.2 Agent 实体模型（agent-registry）

- 新模块 `src/agent-registry.js`：**每个 harness 会话/子代理注册为一个 Agent 实体**；
- 数据源：`events.host` 会话状态流 + session-worker 聚合（**已有，零侵入**）；R8 看板同源；
- 实体字段：`{ id, name（会话名/任务名）, avatar（化身引用）, status, task?, workspace?, startedAt, lastActiveAt }`；
- 生命周期：会话创建 → 注册；会话结束 → 保留在"已归档工位"或移除（可配）；
- **验收**：≥2 个并行会话 → 注册为 2 个实体，状态正确联动 events.host；测试 ≥ 6 项。

---

#### S1.3 办公室视图（office.html）

- **工位墙布局**：网格/排布，每个 Agent 实体一个工位（化身 + 名称 + 状态徽章）；空闲工位显示摸鱼行为；
- **基本交互**：点击工位 → 展开该 Agent 的会话/任务详情（跳转现有会话视图 or 浮层摘要）；
- **顶部概览条**：当前在线 Agent 数、运行中任务数、今日成本/预算状态（复用 cost 数据）；
- 深浅主题走 `theme.css` token；`prefers-reduced-motion` 降级；
- **验收**：工位渲染正确、状态联动、点击交互可用；测试 ≥ 4 项（渲染数据纯函数）。

---

#### S1.4 状态机 + 摸鱼动画（低起点）

- **六态**（参考 Copiwaifu 状态机）：`idle` / `working` / `finished` / `warning` / `error` / `offline`；优先级 error > warning > working > finished > offline > idle；finished 3s 回落；
- **摸鱼行为（Marvis 灵魂，必须做）**：空闲工位的化身有 idle 循环动画（打盹/眨眼/闲逛/喝咖啡，2-3 个变体），SVG/CSS 动画实现；
- 事件源：events.host 会话状态 + cost.budgetStatus + 通知中心（全部已有）；
- **验收**：`skinState()` 纯函数覆盖六态 + 优先级 + 回落 ≥ 8 断言；摸鱼动画在 reduced-motion 下禁用。

---

#### S1.5 化身系统（鲸鱼娘主题 + 皮肤）

- **皮肤目录规范**：`manifest.json` `{ name, author, version, theme, statusAssets, license, homepage? }`；内置 `resources/skins/` + 用户 `userData/skins/`；
- **官方主题「鲸鱼娘」**：SVG 起步（自绘简化虎鲸轮廓 + 状态表情/动作），声明"粉丝二创、非官方、可替换"；
- **默认关闭**（C-6），设置页「外观」新增皮肤下拉；社区投稿渠道预留；
- **升级路径**：未来引入 `easy-live2d`（PixiJS 8）做高成本动效（开源接入位，见 S1.6）；
- **验收**：皮肤扫描/切换/持久化；鲸鱼娘 6 态 SVG + 深浅主题可读；默认关闭、开启后办公室正常、关闭零残留。

##### S1.5-A 素材生产规范（AI 生成工作流 + 资费决策，2026-08 调研）

**总原则（开源项目零预算）**：不购买任何付费素材工具/会员；默认主题用**官方 logo SVG 基底**（GitHub 开源仓库自带，MIT 兼容，零版权风险）+ LLM 改 SVG；进阶主题用**国产免费额度**（豆包/即梦）补充。

**两条 AI 生成路线（业界实证）**：
1. **SVG 直接生成（主路线）**：QuiverAI（文本/图像→SVG，支持 ≤4 张参考图锁风格，免费额度）/ OmniSVG（图像→SVG，NeurIPS 2025 本地开源免费）/ pixel2motion（PNG→SVG 动画，开源免费）/ Inkscape（免费微调）。矢量可无限缩放、KB 级、可嵌 CSS/SMIL 动画、可编辑。
2. **sprite sheet 帧动画（后续摸鱼动画用）**：豆包/Midjourney 精灵图工作流（有成熟 5 模块提示词模板：角色定义/动作设计/布局控制/画风控制/一致性）+ ComfyUI 2D Character Pipeline（分层 sprite，需 24GB VRAM——**跳过**）。

**资费决策表（零成本组合）**：

| 工具 | 资费 | 决策 |
|---|---|---|
| 豆包 / 即梦 AI | 每日免费积分 | ✅ 用免费额度生成立绘参考 |
| 可灵 AI 3.0 | 每日免费灵感值 | ✅ 摸鱼动画图生视频可试 |
| OmniSVG / pixel2motion / Inkscape | 免费 | ✅ 主力 |
| QuiverAI | 免费额度够用 | ⚠️ 不升会员 |
| SVGMaker MCP | 开源免费，底层 **BYOK**（用户自备 key） | ⚠️ 做成可选功能，不由项目承担 |
| SD WebUI / ComfyUI / Midjourney / NovelAI | 免费但需 24GB 显存 / $30 月 / $10-25 月 | ❌ 全部跳过 |

**默认主题生产路径（0 元）**：官方 DeepSeek logo 的 SVG（开源仓库，黑鲸=Harness / 蓝鲸=模型）→ LLM（DeepSeek/Claude，token 费≈几毛）改出六态表情/姿势变体 → Inkscape 微调 → 产出 6 张 KB 级 SVG。深浅主题用 CSS 变量/token 双套。

**角色一致性纪律**：AI 多帧生成角色必漂移 → 提示词写死特征（`same hairstyle / exactly the same character across all states`）+ 参考图约束（QuiverAI/IP-Adapter/主体参考）锁定。

**授权链风险（重要，2026-08 调研发现）**：
- 社区鲸鱼娘谱系：原创角色「溟月」（2025-06，**CC BY-NC-SA 4.0**：署名+非商业+相同方式共享）→ 女仆鲸鱼娘（2026-04 ZipZipPipe 二创）→ 大肥鱼（社区梗）；
- **NC（非商业）限制会污染我们 MIT 开源分发**：若默认主题直接基于女仆鲸鱼娘/溟月形象，下游用户商用我们的项目即违约；
- **结论**：① 默认主题必须**自绘**（基于官方 logo 轮廓 + 鲸鱼特征元素，不抄溟月设定）；② 社区鲸鱼娘皮肤只能作为**可选安装的社区皮肤**（manifest 声明 CC BY-NC-SA，用户自担授权链）；③ 所有皮肤 manifest 必须带 `license` 字段。

---

#### S1.6 开源接入位（能用就用，减少开发量与踩坑）

| 项目 | 用途 | 阶段 |
|---|---|---|
| **Copiwaifu**（Panzer-Jack） | 六态状态机定义参考；hook 事件模式对比（我们用 events.host 更优，无需注入） | 本版参考 |
| **easy-live2d**（PixiJS 8） | 未来高成本化身动画渲染 | 升级期 |
| **DesktopFriends / NyaDeskPet / AIRI** | Live2D 模型导入 / 角色卡规范参考 | 升级期 |
| **puffo-agent** | 多 Agent 实体/身份/触发/共享的架构参考（Python 栈，不直接引入） | 协作期 |
| **harness 原生子代理**（Claude Code/Codex 可装为子代理） | 协作期 Agent 池的真实执行单元 | 协作期 |

---

#### S1.7 版本号决策（用户确认原则）

- **规则**：按一次性更新内容定版本号；内容足够多且好 → 直接 **v0.4.0**；
- **本版候选**：壳容器化重构 + 办公室视图 + Agent 实体 + 状态机 + 化身系统 = **产品形态级升级**，建议直接 **v0.4.0**（S1 全部落地即升）；
- 若只完成 S1 的子集（如仅 S1.2/S1.3 骨架）→ 维持 v0.3.1 过渡。

---

#### S1.8 风险登记（本版追加）

| 风险 | 等级 | 缓解 |
|---|---|---|
| 壳容器化重构破坏 harness 嵌入（Edge Rail 注入失效 / 视图切换异常） | 高 | S1.1 先小实验验证嵌入方案；兼容要求强制（注入保留）；分批：先容器化重构独立验证，再上办公室 |
| 鲸鱼娘版权（DeepSeek 商标） | 中 | 自绘简化轮廓 + "非官方、粉丝向、可替换"声明；皮肤系统与形象资产解耦 |
| 办公室视图挤占带宽 / 壳端臃肿 | 中高 | 化身系统默认关闭；办公室视图与 harness 视图互斥（整页切换，不叠加）；分阶段交付 |
| iframe 嵌入被 harness 拒绝 | 中 | 先小实验；回退 WebContentsView/webview |
| 多 Agent 协作（后续）范围失控 | 中 | 明确"本版只做办公室 + 实体，不做协作"；协作单独立项（S2） |

### T1 · R3 MCP 管理器（过渡项，T-0 勘察先行）

**方案（承接原 R3，简化 MVP）**：先完成 T-0 勘察（dsh 的 MCP 配置面：settings.yaml 字段 / CLI / 配置文件位置），确定壳最稳接入边界（优先文件系统+CLI，零侵入）；通过后设置页新增「MCP」子页：已装列表（名称/传输/状态）、registry 搜索添加、连接测试、启用禁用；写入前后备份原文件（字节级 diff 校验）。

**验收**：T-0 未通过则整体延后；通过后添加 ≥2 个真实 MCP Server 并连通一次；禁用即时生效；写入后 dsh 冒烟通过；测试 ≥ 4 项。

### T2 · R7 插件健康度面板（过渡项）

**方案**：读取 profile 已装插件清单，与内置已知冲突特征库（常见 slot/service 冲突对）比对，给出状态与预警；定位"插件混乱中的稳定器"（竞品 #325 类事故的信任缺口）。

**验收**：已装插件列表 + 冲突预警正确；测试 ≥ 4 项。

### T3 · R9 GitHub Pages 落地页（过渡项，随缘）

**方案**：复用 `website/` Vite 工程：Hero + 三支柱 + 对比表 + 兼容快报入口 + 下载直达 Releases；同步设置仓库 homepage。

**验收**：落地页上线可从 GitHub 访问；下载按钮直达最新 Release。

---

## 4. 远期主线（S2 多 Agent 协作 + R11 多模型编排，不排期）

> 本版 S1 已把「办公室视图 + Agent 实体」立起来；以下为其功能延伸，等 S1 稳定后推进。S1 的办公室视图是这些功能的**承载界面**，Agent 实体（agent-registry）是**数据底座**。

**S2 · 多 Agent 协作（puffo 式，单独立项）**：
- Agent 间对话气泡、任务传递、共享上下文、触发（参考 puffo-agent 的身份/触发/共享机制 + harness 原生子代理调度）；
- 办公室工位间的连线/消息流可视化；
- 范围大、易失控 → 单独立项，S1 完成前不启动。

**R11 · 多模型编排（办公室的总控功能）**：
- 总控会话（强模型）拆解 → 手动确认 → 多个执行会话（便宜模型）并行 → 回收 → 总控审查；成本实时核算（"GLM 执行 + ChatGPT 审查省 ¥X"）；
- 四阶段：1 地基（按会话选模型 + R8 看板）→ 2 编排（任务派发，先手动）→ 3 成本 → 4 形象（已由 S1 化身系统承接）；
- 三条防臃肿纪律：视图互斥（办公室/Harness 整页切换）/ 化身默认关闭 / 编排逻辑薄（不重造框架）。

---

## 5. 本版风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 壳容器化重构破坏 harness 嵌入（Edge Rail 注入失效 / 视图切换异常） | 高 | S1.1 先小实验验证嵌入方案；兼容要求强制（注入保留）；先容器化重构独立验证再上办公室 |
| 鲸鱼娘形象版权（DeepSeek 商标） | 中 | 自绘简化轮廓 + "非官方、粉丝向、可替换皮肤"；皮肤系统与形象资产解耦；README 非官方声明延续 |
| 办公室视图挤占带宽 / 壳端臃肿 | 中高 | 化身系统默认关闭；办公室/Harness 视图互斥（整页切换不叠加）；S1 与 S2/R11 分离（本版只做办公室+实体，不做协作）；分阶段交付 |
| iframe 嵌入被 harness 拒绝 | 中 | S1.1 先小实验；回退 WebContentsView/webview |
| T0 勘察未通过 → MCP 延后 | 中 | T1 明确"未通过则整体延后"，不阻塞 S1 |
| 改 main.js 引入语法回归 | 中 | C-7 强制 `node --check`（H4 事故教训） |
| 与并行会话（另一 AI）改动冲突 | 中 | 协作边界：S1 只碰 `src/shell.html`/`src/office.html`/`src/agent-registry.js`/`src/skin-*.js`/`settings-store.js`(追加)/settings.html(外观行)；禁碰 cost/pnpm-shim/boot-check/compat-status 等已交付文件；git 不 commit/push |

---

## 6. 验收门禁（每批放行条件）

- [ ] 既有测试全绿 + 本批新增守护测试全绿（`npm test`）；
- [ ] `npm start` 冒烟：主窗口加载、设置页全子页路由、托盘菜单、退出备份无回归；
- [ ] 新增设置字段符合 C-3（只追加）；新增 IPC 符合 C-2（grep 复核既有 channel 未变更）；
- [ ] 改过 main.js 则 `node --check` 通过（C-7）；
- [ ] 新增用户可见文案 zh/en 双语齐全（i18n 约束）；
- [ ] 对照 §3 各项验收清单逐项勾选；
- [ ] 出 tag 后安装包在本机完成一次冷启动 + 核心链路手测。

---

## 7. Agent Office 产品规划与版权架构（长期战略基线，2026-08 外部方案整合）

> 本节是 DshCockpit 从开源工具走向 AI Agent 平台的**战略设计基线**，非简单功能需求。来源：外部方案（产品架构/开源战略/技术方案）+ 本项目 S1 讨论结论（形象双层、约稿买断、素材生产规范）整合。本节对未来所有 Agent Office / 角色系统 / 插件生态 / 版权管理设计具有约束力。

### 7.1 产品定位升级

- **从**："DeepSeek Harness 的 GUI / 桌面壳"
- **到**："**AI Agent Desktop Environment**"——用户拥有一个 AI 公司，DshCockpit 是办公室，Agent 是员工。
- 不同 Agent 拥有：不同职位、性格、外观、工作行为。
- 产品结构：

```
DshCockpit
├── Core Desktop Shell
├── Agent Runtime Management
├── Virtual Office Engine
├── Agent Personality System
├── Character Plugin System
└── Community Marketplace
```

### 7.2 Virtual Office 设计理念

- 让每个 Agent 成为**虚拟员工**：用户不仅管理 Agent，还能观察 Agent 工作/思考/执行/等待/摸鱼/休息/成长。
- 传播核心：**"让 AI Agent 成为你的虚拟员工"**（而非"我们用了某某角色"）。
- 用户感受目标："我的 AI 员工生活在 DshCockpit 里"，而不是"我安装了一个 DeepSeek GUI"。
- 对接 S1：办公室视图（S1.3）+ 状态机/摸鱼（S1.4）+ 化身（S1.5）即 Virtual Office 引擎的第一落地。

### 7.3 Agent 员工系统设计

- Agent = 员工实体（对接 S1.2 agent-registry）：`{ id, name, avatar, status, role, personality, task?, workspace?, startedAt, lastActiveAt }`；
- 员工属性：职位（role）、性格（personality）、外观（avatar）、工作行为（behaviors）；
- 观察维度：工作/思考/执行/等待/摸鱼/休息/成长（状态机 S1.4 扩展为员工行为叙事）；
- 成长概念（远期）：Agent 行为/偏好的累积（与记忆、会话历史关联，**先做观察展示，不做自主进化**）。

### 7.4 Character Plugin Architecture（角色插件系统）

**核心原则：角色与代码分离**（参考开源游戏的"引擎 + 资源包"模式：引擎管逻辑，资源包管角色/美术/音乐）。

- **代码（MIT）与角色（独立授权）彻底分离**；角色不是代码的一部分，作为 **Plugin / Asset Pack** 存在。
- 角色包结构（`character-pack/`）：

```
character-pack/
├── manifest.json          { name, author, license, version, avatar, animations, expressions, personality, behaviors }
├── assets/
│   ├── avatar.png
│   ├── animations/
│   └── expressions/
├── personality/
│   └── behavior.json
└── LICENSE
```

- 加载模型：核心程序不携带任何第三方素材；用户**安装**角色包后加载（对接 S1.5 皮肤/化身系统升级为角色插件系统）。

### 7.5 三层许可证体系（核心）

| Layer | 内容 | 许可证 | 目标 |
|---|---|---|---|
| **Layer 1 Core** | Electron Shell / Runtime Manager / Agent 管理逻辑 / Office Engine / 插件系统 | **MIT** | 保持开源生态；允许 fork/修改/二次开发/商业使用 |
| **Layer 2 Official Assets** | 官方原创资产：官方 Logo、官方 Agent 角色、官方 UI 素材、官方动画、品牌资源 | **独立版权声明，不跟随 MIT** | 保护 DshCockpit 品牌资产；未来可商业授权 |
| **Layer 3 Community Packs** | 社区贡献角色：DeepSeek 鲸鱼女仆、用户原创、第三方 IP | **遵循作者原始协议**（如 CC BY-NC-SA） | 明确来源/版权/是否允许商用 |

### 7.6 第三方角色生态策略（"生态支持，而非品牌绑定"）

- **正确叙事**：DshCockpit 是支持 AI Agent 角色扩展的平台，DeepSeek 鲸鱼娘只是**其中一个社区角色包**；
- **错误叙事**：DshCockpit 内置 DeepSeek 鲸鱼娘作为官方吉祥物；
- **原因**：① 第三方 IP 版权限制；② MIT 协议允许商用与部分角色素材许可冲突；③ 未来商业化/增值服务有法律风险；
- 对接 S1.5-A 结论：社区女仆鲸鱼娘只能作为**可选安装的社区角色包**（manifest 声明 CC BY-NC-SA + 原作者署名），核心分发安全。

### 7.7 官方 IP 建设路线（先借势，再立品牌）

| 阶段 | 目标 | 动作 |
|---|---|---|
| **阶段 1 快速增长** | 利用社区认知势能 | 推出 Office + 社区角色包（如鲸鱼女仆包）；传播"让 AI Agent 成为你的虚拟员工" |
| **阶段 2 生态** | 建立 Agent Character Marketplace | 用户制作/分享角色、定制 Agent 人格 |
| **阶段 3 品牌** | 推出官方原创角色，建立自有世界观/角色体系/品牌资产 | 最终不依赖任何第三方角色 |

- **形象落地（对接讨论结论）**：官方原创角色 = **约稿买断**（全版权，商用+修改+再分发授权；预算 300-800 元/套设定稿）；**一套设定稿 + 双配色**（蓝鲸员工 / 黑鲸 DSH 总管），一次约稿两个身份；交付分层源文件（AI/PSD/PNG），六态 SVG 用 AI 衍生（OmniSVG/QuiverAI + LLM）。

### 7.8 商业化兼容设计

- MIT 只覆盖代码，不覆盖品牌资产（Layer 2 独立版权）→ 未来可对官方资产/增值服务收费而不破坏开源；
- 社区角色包自担授权（Layer 3）→ 项目不承担第三方授权风险；
- 商业化的前提：**默认分发零授权雷**（官方角色原创买断 + 核心 MIT 干净）。

### 7.9 技术实现规划（与 S1 对接）

| 战略模块 | 本版落地（S1） | 后续 |
|---|---|---|
| Virtual Office Engine | S1.3 办公室视图 | S2 协作可视化 |
| Agent 员工系统 | S1.2 agent-registry（实体字段预留 role/personality） | S2 行为叙事 |
| Character Plugin System | S1.5 化身/皮肤系统 → **升级为角色包规范**（manifest 对齐 §7.4） | Marketplace |
| 三层授权 | S1.5-A（license 字段 + 自绘默认 + 社区包可选） | 资产分级管理 |
| Agent Personality | — | personality/behavior.json 消费 |

**架构对齐要求**：S1.5 的皮肤系统设计**必须**按 §7.4 角色包结构设计（manifest 含 license/author/personality），避免后期返工；核心程序**不得**打包任何 Layer 3 素材。

### 7.10 后续开发 Roadmap（战略层）

- **S1（本版）**：壳容器化 + 办公室视图 + Agent 实体 + 状态机 + 化身系统（按 §7.4 角色包结构设计）→ 定位升级为 Agent Desktop Environment 的第一块基石；
- **S2**：多 Agent 协作（puffo 式对话/任务传递/共享）→ 员工间协作叙事；
- **R11**：多模型编排（总控分派）→ 办公室的"总经理"功能；
- **远期**：Agent Character Marketplace（制作/分享/人格定制）→ 官方 IP 三阶段（§7.7）。

---

*重写说明：本文档于 2026-08-26 清理（v0.2.8→v0.3.0 交付压缩至 §2；删除原 §9-§14 已完成调研/修复细节）。v0.3.1 范围以 §3 为准；远期主线 §4 供方向参考；§7 为长期战略基线（Agent Office 产品规划与版权架构，外部方案整合）。*
