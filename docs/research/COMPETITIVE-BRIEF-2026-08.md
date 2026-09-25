# 竞争情报与生态调研简报（2026-08）

> 性质：调研报告（事实与结论，不含实施承诺）· 抓取日期：2026-08-20 ~ 08-23 · 服务对象：《docs/specs/PREDEV-FEATURES-REPORT.md》及 ROADMAP 决策

---

## 1. 生态大盘

| 指标 | 数值 | 备注 |
|---|---|---|
| deepseek-ai/deepseek-harness | 174k★ | 8/13 发布，首日 34k★；一周内 109k → 174k |
| `dsh-plugin` 话题 | 9,883 仓库 | 巨型项目蹭标签严重（open-design 89.7k★、reactive-resume 41.3k★ 均打此话题） |
| anywhere-labs/deepseek-harness-desktop | 16.4k★ / 625 forks / 30 贡献者 | 8/13 创建（DSH 发布当天）；10 天 13.8k★，第 10~12 天仍以约 1.3k★/天增长 |
| 记忆/上下文基础设施品类 | OpenViking 31k★（字节）、EverOS 12.3k、MemOS 10.9k | 巨头赛道，勿碰 |

## 2. 竞品（deepseek-harness-desktop）画像

**已交付强项**：Profile 管理（兼容/高级双模式）、内置终端（私有 shim 不污染系统 PATH）、恢复助手/回滚 UI、macOS 签名公证（v2.0.0 完成）、Windows Mica 效果、自建更新服务器 + 官网 dshdesktop.cn 下载 CDN、dsh-market 插件市场集成（展示下载量/star）、飞书文档站。

**结构性裂缝（来自其 v2.0.x Release Notes 与 118 个 open issues）**：

| 模式 | 证据 | 根因 |
|---|---|---|
| 插件装不上/卡死/无指引 | #351 #346 #341 #340 #348 #310 | pnpm 原生依赖边界 + Cordis slot 约束 |
| 插件冲突致启动即闪退、无恢复机制 | #325 | 插件运行于宿主进程，单插件可毒死全局 |
| 打包遗漏致启动失败 | #339（自家维护者提交） | vendor 整棵上游树的复杂度反噬 |
| 上游破坏性更新毁 profile、插件全丢 | v2.0.2 官方公告要求用户手抄插件清单重建 | submodule pin 架构原罪 |
| Windows 闪退/白屏持续 | #347 #326 #321 等 | — |
| 基础功能缺口 | #335 求托盘重启项 | — |

## 3. 热门插件榜单规律（star 排序实证）

1. **补官方基础能力缺口**：dsh-codex-ui 套件（侧栏树/全局搜索/归档/定时/IM，V2EX 1,263 点击）、ModLens（视觉 OCR）、dsh-context（上下文面板）
2. **UI/情感化**：dsh-web-ui 合集 5.2k★（任务板/git 图/live token stats/mobile remote UI/宠物/皮肤中心）、colleague-skill 23.6k★（数字生命情绪病毒式传播）
3. **目录型**：awesome-dsh-plugin 本身 10.6k★

共同点：解决"官方没有但人人需要"的缺口 + 名字直白含关键词 + 有 GIF/截图 + 进入市场/榜单分发。

**复刻预警**：dsh-web-ui 已含插件级 "live token stats" 与 "mobile remote UI"——壳层独有功能正被插件层复刻。护城河必须下沉到插件层做不了的深度：预算报警、官方余额、工作区归因、缓存经济学、跨会话检索性能。

## 4. 对 DshCockpit 的定位结论

- "桌面壳"品类胜负已分（头部通吃，第一名拿走同名词 97% 流量），正面追赶 star 无意义；
- 可行路线：**可靠性即产品**（承接竞品踩坑用户）+ **成本深水区**（插件层难复刻）+ **内容化输出**（兼容快报/周报卡片）；
- 英文市场（HN/Reddit）竞品布局薄弱（其渠道全在中文圈），是当前最大增量窗口；
- 单人维护约束下，优先级必须服从"每批一个自然周工作量"的上限。
