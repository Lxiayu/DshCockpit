# Office 长夜开发会话：边界与执行文档

> 状态：**活跃**（2026-09-11 晚间 → 用户叫停）。基线 HEAD `40eae32`，已推送。
> 目标：把运行时办公室从"功能可跑"升级为"眼前一亮"——行走、工作、庆祝、对话全部动起来。
> 纪律：一阶段一 push（用户本轮明确要求）；子代理实现 + 主代理复审；不改运行时状态机；不碰 photo/ 与 .office-editor-data/。

## 已批准决策

- 用户确认改为平面 2D（后→前）；编辑器已可摆放，现在要让**运行时**呈现这套布局
- 行走升级到 5 帧（passing 帧插 02 与 03 之间），节奏保持 1000ms/帧
- 对话 A+B 混用，沿用 activeChatPair，文案预写
- 贩卖机/座机电话等已生成素材保留
- 鱼缸/跑步机/马桶废弃（跑步机/马桶可在后续用其他家具替换）
- **用户授权 push**：每阶段完成后 push 到 GitHub
- 密钥来源：本机环境变量（原始 kickoff 记录在本地归档 `docs/archive/prompts/IMG-GEN-KICKOFF.md`，不入库）

## 阶段计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| E6a | 运行时加载 flat 布局 + letterbox + 跨工位穿模修复 | 完成（E4 已做，062076a） |
| E6b | 行走升级：归一化 passing 帧进包（5 帧循环）| 完成（E5a+R1，e06aea9+1bbcc8c） |
| E6c | 运行时尊重角色尺寸/朝向（heightRatio + facing）| 完成（E5a-R2，cc9ba4d） |
| E6d | **坐姿工作背向动画**（GPT Image 角色锁定生成）| 完成（`2e4ffae`） |
| E6e | 庆祝/完成后动画（正面可读性优先）| 未开始（2026-09-16 校订；原误标"当前"） |
| E6f | 对话系统（语料库+触发+气泡渲染）| 部分：引擎+语料+渲染端已交付；chat-pair→bubble 中段接线缺失（handover §8.10） |
| E6g | 工具补洞（workbench 发现的问题顺手修）| 贯穿 |

## 角色素材现状

- 包：`resources/characters/deepseek-default/`（352² 画布、锚点 (178,296)、unionVisibleBounds 319×277、defaultFrameDurationMs 1000）
- 已有动画：idle/working/finished/error/offline（各 1 帧静态）、walk-{down,left,right,up}（各 4 帧）、side-{back,left,right}（各 1 帧）
- **待补**：walk-left/right 的 passing 帧（photo/output_nobg/ 已有 2 张 1254²）、working-back（坐姿背视多帧——**用 GPT Image 角色锁定生成**）、庆祝/完成正面帧
- 脚点线约定：α≥128 最低行 y=296（全帧一致）

## GPT Image API（角色一致性生成）

- Base URL: https://ai.hebox.net/v1
- Key: 环境变量 IMG_API_KEY（从本地归档 `docs/archive/prompts/IMG-GEN-KICKOFF.md` §2.A 读取）
- 模型: gpt-image-2
- 端点: POST /images/generations（文生图）/ POST /images/edits（图生图+角色锁定）
- 限制: prompt ≤300 字符（超长 400）；AbortController 300s；参考图 ≤1MB；b64_json 偶缺重试
- 角色锁定：/images/edits 传参考图（walk-left-02.png 等）确保角色一致性

## 不变式（全程不可违反）

- 运行时状态机/调度器/编译器语义冻结
- 素材栏 tile 数 = catalog 条目数（test/office-asset-runtime 锁定）
- E4 跨工位穿模采样 = 0；E5a 帧序=元数据序；鞋线 ±1px
- content/** 与 resources/office/flat/** 是本轮生产素材
- photo/ 与 .office-editor-data/ 只读
- officeRuntimeEnabled 仍未改

## 已知问题（待修）

- walk-left/right 行走姿态僵硬（4 帧 → 5 帧已做，但 01/02 与 03/04 间双腿收拢不明显）
- working 姿态烘焙桌沿可见（素材问题）
- 两角色交错瞬间的最小 0.4px 采样距离（需路径预约，E5+）
- 协作者在多员工交通下的行走等待（行为调度器已知问题）
