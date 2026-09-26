<!-- NOTE: this body is attached to EVERY tag release (body_path in
     release-win/release-mac workflows). Keep it to "what changed in this
     version" — no narrative, no self-verification sections; the download
     table stays version-agnostic (pinned filenames become dead links). -->

# DshCockpit v0.4.0 — 虚拟办公室

把 Agent 的工作过程画出来：调度员接单后走到自己的工位，子代理化作研究员、编码员、评审员、协作者各自落座；右栏实时显示今日用量、员工状态、待你处理的审批与逐轮时间线。

## 下载

| 平台 | 文件 |
|---|---|
| **Windows · 安装版**（应用内自动更新） | `DshCockpit-*-win-x64.exe` |
| Windows · 便携版（解压即用） | `DshCockpit-*-win-x64.zip` |
| **macOS Apple Silicon · 安装版** | `DshCockpit-*-mac-arm64.dmg` |
| macOS Apple Silicon · 便携版 | `DshCockpit-*-mac-arm64.zip` |
| macOS Apple Silicon · 精简版（不含内置运行时） | `DshCockpit-*-slim-mac-arm64.zip` |

> 未签名：Windows 首次安装会有 SmartScreen 提示，macOS 首次打开需右键「打开」。

## 新增

- **虚拟办公室**：真事件驱动（不是空转动画）；5 名员工各有工位、行走与工作动画；小憩、巡游、闲聊在同一套仿真时钟下运转
- **右栏六块信息架构**：今日用量（token + 金额）· 员工状态 · 待你处理 · 时间线（逐轮 token 归属）· 员工今日工作记录 · 页脚状态
- **审批收件箱**：低/中风险行内批准；高风险弹模态列出步骤、影响范围与真实命令原文，且只提供「仅本次批准」
- **中英双语**：办公室 / 左栏 / 驾驶舱 HUD 跟随语言设置实时切换
- **崩溃诊断一键导出**（脱敏）与**素材复现链 CLI**（`asset-provenance verify | report | lost`）

## 修改

- 修复：切到工作台一段时间后办公室画面锁死（含锁屏/息屏唤醒后不自愈）
- 修复：任务结束后员工卡在「工作中」、面板「同步滞后」
- 修复：角色与家具图层闪烁；员工会站在空地上摆工作动画（现在只可能站在自己的工位上）
- 修复：`请求取消 / 追加任务` 之前是空操作，现在真的会取消 / 追加（「中断」因运行时无对应接口而停用并注明）
- 修复：面板无法用键盘操作（现在纯键盘可完成一次审批）
- 修复：诊断环被同一条告警刷屏；仿真时钟被主进程停顿拖慢（有界补步）
- 内置运行时更新为 **0.1.5-rc.2**（本版验证版本）；本机若已安装更新版本仍优先使用本机版本

## 性能

- Windows 杀软面：MCP 校验去抖（N 次 → 1 次子进程）、启动自检 24h 内复用、退出备份改增量（38.5ms → 4.7ms）、compact 与 token 共享一次遍历（11.9ms → 0.1ms）
- 渲染：静态画面零重绘、切走视图不再空转；低帧降级改为先降档、末档才静态，并提供「重试渲染」
- 打包：产物内不再包含创作工具链（asar 内创作块 0）
