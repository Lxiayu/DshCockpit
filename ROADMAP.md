# DshCockpit 路线图（ROADMAP）

> 本文件是 DshCockpit 的长期竞争路线图，基于对参考项目（`anywhere-labs/deepseek-harness-desktop`，截至调研时 ~8.8k⭐）、DeepSeek Harness 社区生态（发布 3 天插件破 4000+）、以及 2026–2027 全球 Agent 行业趋势的调研。
>
> 配套文档：[DESIGN.md](DESIGN.md)（架构）、[FEATURES.md](FEATURES.md)（已交付功能）、[README.md](README.md)（快速路线图）。

---

## 0. 定位与原则

### 产品一句话

> 别的壳把 dsh web 装进窗口；DshCockpit 把 dsh 变成**常驻后台的 Agent 服务**，并提供完整桌面产品体验（更新、成本、后台任务、数据安全、手机遥控）。

### 三条铁律（所有新功能必须通过）

1. **守住"控制台"心智，不做 IDE** —— 不做内嵌终端/浏览器预览这类"工作台"功能，那是 Cursor/ArcDesk 的战场，偏离 harness 定位。
2. **不重复造通信基础设施** —— 公网远程复用 Tailscale/Cloudflare 生态，不自研打洞/中继。
3. **护城河在工程深度，不在功能数量** —— 每个功能都要做到"别的薄壳抄不动"的深度（签名、鉴权网关、成本归因、坏版本不激活）。

---

## 1. 当前状态（已交付能力盘点）

| 能力 | 状态 | 说明 |
|---|---|---|
| 运行时/壳双层自动更新 + 回滚 | ✅ | 坏版本冒烟守卫不激活（最硬护城河） |
| Token 监控 + 成本中心 + 预算报警 | ✅ | 按工作区归因、峰谷分时、80%/100% 报警 |
| Quick Ask + 定时任务 + 通知 | ✅ | 全局热键 + headless 后台运行 |
| 会话全文检索 + 自动备份 | ✅ | Ctrl+K、append-only JSONL、三层保险 |
| 插件市场（dsh-plugin 话题） | ✅ | 一键安装/卸载，重启生效 |
| 手机远程控制（局域网安全网关） | ✅ | 配对码/safeStorage/Origin 重写/防爆破 |
| IM 渠道接入（飞书/企微/钉钉长连接） | ✅ | 0.2.4 交付；事件推送 + 按钮审批 + IM 对话；WhatsApp 缓做（合规门槛） |
| 公网远程（Tailscale/Cloudflare） | ✅ | 0.2.4 交付；默认关闭 + 显式授权 + 审计日志 |
| 官方级计费（余额 + 单轮成本） | ✅ | 0.2.4 交付；v4-flash/v4-pro 峰谷矩阵 + 缓存节省额 |
| 模型管理 + Ollama 本地接入 | ✅ | 0.2.4 交付；6 预设 + 连接测试 + Key 加密 |
| 长会话管理（/compact + 记忆文件） | ✅ | 0.2.4 交付；前后对比 + AGENTS.md 管理 |
| 技能（Skills）管理页 | ✅ | 0.2.4 交付；Claude Skill 兼容 + 预览防注入 |
| 三语界面 / 托盘 / 首次引导 | ✅ | 中/英/跟随系统 |
| 196 项单元测试全通过 | ✅ | `npm test` |
| macOS 签名与公证 | ❌ | 见 P2-7 |
| Windows Authenticode 签名 | ❌ | 见 P2-7 |
| 系统钥匙串集成 | ❌ | 见 P1 附带 |

---

## 2. 调研结论（竞争依据）

### 2.1 参考项目（8.8k⭐）在押注什么

- 主打 **手机远程控制 + Channels（微信/飞书/Discord/WhatsApp）+ 插件市场**；桌面功能本身比我们薄。
- 结论：**"手机 + IM 遥控 Agent"的生态想象力是传播引擎**，我们目前只有局域网手机控制，缺 IM 渠道这一块。

### 2.2 社区生态（发布 3 天，第三方插件 4300+）

- 插件类型占比：Agent 基础能力 ~50%，**UI 插件 17.6%**（竞争最激烈、皮肤经济），数据库/云部署等 To B 长尾仅 ~1.5%。
- 桌面赛道已头部集中：`dsh-desktop` 同名项目 55 个；`deepseek-harness-desktop` 33 个，**第一名拿走 ~6900 星，其余 32 个合计 ~255 星**。
- 社区已自发涌现远程渠道插件：`qqbot`、`dsh-weixin-bot`、`dsh-feishu-bot`、`dsh-wecom-bot`、`telegram`。
- 结论：**"给 Agent 接 IM"是共识级需求，但我们还没接住；插件经济（卖零件）是生态级机会。**

### 2.3 直接竞品（社区桌面壳）

- **DeepSeek Phone Harness**：手机远程已支持 4G/5G/公网（Tailscale/中继），roadmap 含 **PWA 离线壳 + 推送通知 + 多设备**。
- **ArcDesk**：远程支持扫码/局域网/**Cloudflare（跨网）**；内嵌工作台（终端/浏览器预览/Git/多 Tab）；**/compact 长会话压缩 + ARCDESK.md 记忆层 + Failure Memory**；**Ollama 本地模型**；三档运行模式（Auto/Plan/YOLO）。
- **deepseek-tui-desktop**：已做 **notarized mac 构建**；远程桥接用 token 鉴权，把"只读进度查看"与"远程控制"分离；任务分解工作台。

### 2.4 行业趋势（2026–2027+）

- **MCP 成为"AI 的 USB-C"**：统一工具接入标准，官方 registry 500+ Server、mcp.so 2000+；DeepSeek V4/Kimi K2.6 已原生支持。→ 桌面壳需要 **MCP 管理器**。
- **A2A（Agent-to-Agent）协议**：跨厂商智能体协作标准，2026 尚不成熟，2026–2027 会收敛；与 MCP 互补（MCP=工具接入，A2A=智能体协作）。→ **多智能体编排**是前瞻方向。
- **数字员工时代（2026–2027）**：Agent 从"助手"变"同事"，**治理、审计、安全策略**进入落地期，成为企业采用的前置条件。
- **商业模式从 Coding Plan → Token Plan**：成本透明度与优化的价值持续放大（V4-Pro 缓存命中价 ~$0.022/1M vs 未命中 ~$0.66/1M，差 30 倍）→ **成本中心 = 长期差异化**。
- **DeepSeek 战略**：开源 Harness 把"执行层"拉平成公共品（安卓式"定标准"），模型与执行层分离。→ 桌面壳是执行层之上**分发与 UX 的争夺点**，生态会持续放大。

---

## 3. 优先级路线图

### P0 —— 不做就掉队（竞争分水岭）

#### P0-1 IM 渠道接入（Channels）
- **为什么**：参考项目核心卖点 + 社区渠道插件爆发（weixin/飞书/telegram…），是"能被看见、能讲出去"的传播功能。
- **做什么**：
  - 壳内"渠道管理器"：一键安装/配置微信/飞书/Discord/Telegram bot 插件并保持在线；
  - 事件推送到 IM：任务完成 / 审批请求 / Agent 提问（复用现有 `events.mux` 订阅与通知体系）；
  - 渠道接入状态可视化 + 失效重连提示。
- **验收标准**：
  - [ ] 至少 **2 个渠道**（微信机器人 + Telegram）可一键接入并收发消息；
  - [ ] 三类事件（完成/审批/提问）在目标渠道真实送达，手测清单通过；
  - [ ] 渠道 token 加密存储（safeStorage），不进设置文件/备份；
  - [ ] 新增单元测试 ≥ 8 项，`npm test` 全绿。

#### P0-2 手机远程突破"同一 Wi-Fi"→ 公网/4G
- **为什么**：DeepSeek Phone Harness、ArcDesk 均已支持 Tailscale/Cloudflare，局域网限制等于砍掉一半使用场景。
- **做什么**：
  - 首选 **Tailscale 一键打通**（检测客户端 → 引导登录 → 在设置页展示 `http://<tailscale-ip>:31780` 配对链接）；
  - 可选 Cloudflare Tunnel 模式（社区已验证可行）；
  - 安全默认值：**公网模式默认关闭**，需显式开启并二次确认（公共网络警告）。
- **验收标准**：
  - [ ] Tailscale 打通后，手机在 4G/5G 网络下可完成配对、查看会话、审批、提问；
  - [ ] 局域网 → 公网切换不丢会话、不断配对；
  - [ ] 公网开启需显式授权 + 明文提示，默认关闭；
  - [ ] 新增远程模式相关测试 ≥ 5 项，全绿。

---

### P1 —— 生态对齐（拉开差异化深度）

#### P1-3 模型管理面板 + 多 Provider 快捷切换
- **为什么**：dsh 支持 40+ 提供商，手机端竞品已有模型切换，我们壳里尚无模型入口。
- **做什么**：设置页新增"模型"子页：默认模型、快捷切换、各 Provider Key 管理、连接测试。
- **验收标准**：支持 ≥5 个 provider 快捷切换；连接测试有明确成功/失败反馈；默认模型持久化。

#### P1-4 本地模型一键接入（Ollama）
- **为什么**：BYOM 是开源 harness 核心价值，ArcDesk 已合入 Ollama provider。
- **做什么**：检测本机 Ollama → 一键注册 provider + 配置默认模型 + 模型列表展示；无 Ollama 时优雅降级提示。
- **验收标准**：有/无 Ollama 两种环境均可稳定通过；注册后可用本地模型完成一次最小对话。

#### P1-5 长会话管理补强（/compact + 记忆层）
- **为什么**：1M 上下文但成本高，ArcDesk 已做三级压缩 + 项目记忆；我们已有上下文压力预警，往前一步就是压缩与记忆。
- **做什么**：壳级"压缩当前会话"入口；记忆文件（`AGENTS.md`/`ARCDESK.md` 类）的浏览与管理。
- **验收标准**：压缩前后 token 用量有可见对比；记忆文件可新建/编辑/删除；压缩后会话可继续。

#### P1-6 技能（Skills）管理页
- **为什么**：通用 Agent 技能生态是明确趋势（兼容 Claude Skill 格式），与插件市场同一心智。
- **做什么**：与插件市场同入口，浏览/一键安装 dsh 技能；兼容 Claude Skill 目录格式读取。
- **验收标准**：可浏览并安装 ≥1 个技能并生效；格式不兼容时给出可读错误。

---

### P2 —— 信任与转化（影响增长速率）

#### P2-7 代码签名与公证 ⚠️ 建议提到最前
- **为什么**：deepseek-tui-desktop 已交付 notarized mac 构建；未签名导致的 Gatekeeper 绕过是"敢不敢装"的分水岭，直接决定转化率。
- **做什么**：macOS `notarytool` 公证（CI 集成）+ Windows Authenticode 签名；发布流程强制签名后才出正式包。
- **验收标准**：macOS 安装后**不再需要** `xattr -dr com.apple.quarantine`；Windows 无 SmartScreen 未知发布者警告；发布 CI 无人工步骤。

#### P2-8 官网/落地页 + SEO
- **为什么**：参考项目有官网 + 社区矩阵，分发差距的核心之一。
- **做什么**：GitHub Pages 静态落地页（Hero + 下载 + 截图 + 机型对照 + FAQ）；README 首屏改挂强关键词（DeepSeek Harness + Desktop）。
- **验收标准**：落地页上线并可从 GitHub 访问；README 首屏含官方关键词；下载按钮直达最新 Release。

#### P2-9 移动端推送通知
- **为什么**：DeepSeek Phone Harness roadmap 含推送；当前手机端无"任务完成/审批"主动通知。
- **做什么**：优先走 P0-1 的 IM 渠道推送；次选 PWA Web Push。
- **验收标准**：远程任务完成/审批请求在手机端真实触发通知，延迟可感知 < 数秒。

---

### P3 —— 护城河深化（别人难抄，可缓做）

#### P3-10 成本中心深化：缓存经济学可视化
- **为什么**：V4-Pro 缓存命中价差 30 倍，"前缀缓存省钱"是官方热点，与现有成本中心天然契合。
- **做什么**：按会话/天统计缓存命中率与节省金额，可视化展示。
- **验收标准**：命中率/节省金额与真实账单误差 < 10%；按会话下钻可查。

#### P3-11 Trace 全程轨迹回放 / 审计导出
- **为什么**：官方 Trace 特性 + "数字员工"阶段的治理需求，是企业采用前置条件。
- **做什么**：会话轨迹时间线回放；审计报告导出（JSON/Markdown）。
- **验收标准**：回放可还原某任务全部工具调用序列；导出文件含完整时间戳与动作。

#### P3-12 多 Agent 并行看板
- **为什么**：行业普遍向 parallel agent teams 演进（Cursor/Windsurf/Claude Code）。
- **做什么**：并行任务/子 Agent 状态聚合监控看板。
- **验收标准**：≥2 个并行任务可同屏监控；失败/阻塞有告警。

---

## 4. 长期战略（2027 前瞻，观望+小步验证）

> 以下方向与 P0-P3 并行推进，原则：**小步验证、以插件生态与协议演进为准，不做超前重投入。**

### L-1 MCP 管理器（建议最早启动）
- 依据：MCP 已成"AI 的 USB-C"，官方 registry 500+/mcp.so 2000+ Server；DeepSeek V4 原生支持。
- 范围：浏览/搜索 MCP Server → 一键添加 → 权限控制 → 连接测试。
- 里程碑：MVP 支持浏览 + 添加 + 测试；后续补权限与审计。

### L-2 A2A / 多智能体编排（观望期）
- 依据：A2A 是跨厂商智能体协作标准，2026 尚不成熟，2026–2027 收敛。
- 范围：跟踪 Google A2A/IBM ACP 演进；在壳内预留"智能体注册/发现"抽象层，不急着实现。

### L-3 插件经济（生态变现）
- 依据：插件 3 天 4300+，"卖零件"经济成型；UI 插件 17.6% 说明皮肤/工具消费意愿明确。
- 范围：精品插件目录（筛选/推荐）、插件作者入驻通道、赞助/付费标识（合规前提下）。

### L-4 治理与审计（企业级）
- 依据："数字员工"阶段治理/审计成为企业前置条件。
- 范围：操作审计日志、审批分级策略（Auto/Plan/YOLO 类）、企业策略导入导出。

### L-5 自进化（2027–2028 方向，最低优先级）
- 依据：行业进入"Agent 自我升级"阶段。
- 范围：基于本地会话数据的自诊断/自修复建议（不自动执行，仅建议）。

---

## 5. 明确不做清单（避免过度工程）

- ❌ **不做完整 IDE**（内嵌终端/浏览器预览/多 Tab 工作区）——与 Cursor/ArcDesk 正面竞争，偏离"控制台"心智。
- ❌ **不自研打洞/中继**——公网远程一律复用 Tailscale/Cloudflare。
- ❌ **不做模型绑定或闭源化**——保持 BYOM，模型可插拔。
- ❌ **不在 P0 未落地前铺开 L 系列**——先赢下当前窗口。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 官方 v0.1 preview 破坏性变更 | 接口面刻意做小 + 运行时版本化共存（已内建） |
| 生态头部集中效应（薄壳扎堆） | 差异化叙事 + 尽快落地 P0；护城河在工程深度 |
| 被"薄壳"快速抄袭功能 | 深度高于宽度：签名/网关/成本/坏版本不激活难抄 |
| 单人维护，带宽有限 | 开源协作：issue 模板、CONTRIBUTING、社区 PR（手机远程已证明可行）；按优先级聚焦 |
| 公网远程引入安全风险 | 默认关闭 + 显式授权 + Tailscale 优先；复用 §17 网关鉴权体系 |

---

## 7. 建议落地顺序（里程碑）

- **M1（当前窗口）**：P2-7 签名公证（提信任）→ P0-1 IM 渠道（提传播）→ P0-2 Tailscale（提半径）。
- **M2（生态占位）**：P1-3/4 模型管理 + Ollama → P1-5/6 长会话 + 技能 → L-1 MCP 管理器 MVP。
- **M3（深挖护城河）**：P3-10 缓存经济学 → P3-11 Trace 回放 → P3-12 多 Agent 看板 → P2-8/9 落地页与推送。
- **M4（长期）**：L-2~L-5 按协议与生态演进小步验证。

> 优先级一句话：**先签名（信任=转化）、再接 IM（传播载体）、再打通公网远程（使用半径），然后模型/技能/MCP 跟进制作者生态。**

---

## 8. 参考来源

- [deepseek-harness-desktop（参考项目）](https://github.com/anywhere-labs/deepseek-harness-desktop)
- [DeepSeek Phone Harness（dev.to / GitHub）](https://github.com/2903077918-lgtm/DeepSeek-phone-harness)
- [ArcDesk（GitHub）](https://github.com/P1ouson/deepseek-ArcDesk)
- [deepseek-tui-desktop（GitHub）](https://github.com/w66917759-commits/deepseek-tui-desktop)
- [DeepSeek Harness 上线 3 天，4300 个第三方插件都在干什么（今日头条）](http://m.toutiao.com/group/7674810617052316214/)
- [DeepSeek Harness 深度解析（CSDN）](https://blog.csdn.net/guoqi_666/article/details/163803738)
- [DeepSeek 开源 Agent 框架 Harness：为什么说它要当全球 Agent 底座（新浪财经）](https://cj.sina.com.cn/articles/view/7879996026/1d5af327a06801p0h4)
- [MCP vs A2A: Agent Protocols Compared 2026（TokenMix）](https://tokenmix.ai/blog/mcp-vs-a2a-agent-protocols-compared-2026)
- [Tool Use and MCP（ai-system-design-guide）](https://github.com/ombharatiya/ai-system-design-guide/blob/main/07-agentic-systems/03-tool-use-and-mcp.md)
- [DeepSeek Harness: Open-Source Claude Code Rival（AI Tools Review）](https://aitoolsreview.co.uk/insights/deepseek-harness)
- [展望 2027：未来三年 AI Agent 的技术路线图（CSDN）](https://blog.csdn.net/qq_42568323/article/details/161157668)
- [2026 桌面 Agent 全盘点：20 款工具（博客园）](https://www.cnblogs.com/tutudatu/p/21894041)
