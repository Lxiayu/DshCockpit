# 生成交接：视频由**你的代理**生成，工作台接着做

> 生成提示词由 `node studio/bin/agent.js prompts` 从工作台自己的流水线配方（`buildPromptPlan`）生成，
> 与工作台内部会用的护栏**同一来源**；测试会比对两边，所以这份文件不会漂移。

## 为什么是交接，而不是在工作台里填 key

生成视频的模型/协议/返回方式千差万别，工作台里塞一套"填 key + 调 provider"既麻烦又僵。
所以定成：**你用你手上的任何模型/工具生成 → 交付绿幕原片 → 工作台从抠像那一步接手。**

工作台不再需要视频 provider 的 key；它需要的只是**合格的输入**与**参数记录**（谁生成的、什么模型、什么提示词、什么种子）。

## 一、出片前先读配方（每动作一份）

```bash
cd studio
node bin/agent.js prompts --action walk-left --direction left --json   # 结构化：护栏 / 分秒节拍 / 负面词
node bin/agent.js prompts --action walk-left --direction left          # 人读：整段提示词，照抄即可
```

下面这段就是"照抄给你手上的模型"的提示词（`walk-left · left` 为例，其余动作同构）：

```text
参考图中的角色（保持同一设定：配色、服装、描边、比例、画风），拍一段 walk-left（朝 left） 的动作素材。

镜头与背景：固定机位，16:9，纯绿幕背景 #00FF00，画面里不出现地面、不出现投影、不出现文字或水印。
运动约束：双脚锁定画布锚点，原地完成动作（只允许原地转身），不能有横向位移。

按秒分节拍（第 1 秒与最后一秒都必须是干净的站姿）：
  第 1 秒：standing still, feet locked to the canvas anchor, no props in frame
  第 2 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 3 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 4 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 5 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 6 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 7 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 8 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 9 秒：perform one beat of the action, no lateral movement (rotate in place only)
  第 10 秒：return to the exact standing pose of frame 1, props gone

必须满足：
  - green screen background (#00FF00), 16:9, no ground plane
  - no depth or perspective wording in the prompt (it paints a floor)
  - feet locked to the canvas anchor; in-place axis rotation only
  - first and last frame are the same clean standing pose
  - props follow the none → have → none closed loop, condensed within 0.5–1s
  - 10% safe margin on every side (ahoge, fins, skirt, tail)

不要出现：
  - no camera movement
  - no ground
  - no shadow on the backdrop
  - no text
  - no watermark

交付规格：640×360 级、~24fps、10 秒级；给绿幕原片（不要自己抠像），放进 content/incoming/<动作>/。
```

## 二、交付契约（不满足就别往下走）

| 项 | 要求 | 为什么 |
|---|---|---|
| 背景 | 纯绿幕（#00FF00 系），**不出现地面/阴影/文字/水印** | 抠像的前提；带地面会让"浮空"穿帮 |
| 机位 | 固定，16:9；**不写纵深/透视类措辞** | 纵深词会画出地面 |
| 运动 | 双脚锁定画布锚点，**原地**完成；首尾帧＝同一干净站姿 | 帧轨/视频轨都靠锚点对齐 |
| 道具 | "无 → 有 → 无"闭环，收在 0.5–1s 内 | 避免道具残留在循环缝上 |
| 边距 | 四周 ≥10%（呆毛/裙摆/尾鳍都算） | 防裁剪 |
| 规格 | 640×360 级、~24fps、10 秒级；**绿幕原片（不要自己抠像）** | 体积与工作台的编码参数一致 |
| 位置 | `content/incoming/<动作>/<任意名>.mp4`（目录已 gitignore） | 交付入口固定 |

## 三、交付后一条命令接收

```bash
cd studio
node bin/agent.js intake --dir ../content/incoming/walk-left \
  --action walk-left --model "<你用的模型名>" --prompt-file /tmp/prompt.txt --seed 42
```

`intake` 会：① 探测容器/分辨率/帧率/时长；② 取首尾帧算绿幕占比、主体占比、边距、脚线；
③ 把**生成参数写进素材台账**（`content/characters/<角色>/provenance/generation/<动作>.params.json`，
这正是过去"调用参数从未入账"的断点）；④ 写接收记录 `content/build/intake/<动作>.json`；⑤ 打印下一步。
**有红项就退出码 1 且不算接收**——改了再交，不要带着问题往下走。

## 四、交接之后（工作台接手）

```bash
node bin/pipeline.js matte <frame.png> --out <frame.png>   # 顺序写死：unpremultiply → harden → 去近黑
node bin/pipeline.js qc video <clip.webm> --expect-fps 24  # 黑帧/冻结/alpha/时长/fps
node bin/pipeline.js run walk-left                         # 命令链：接收→QC→分诊→归一化→入包（内容寻址：改一步只重跑一段）
node bin/actions.js publish walk-left                      # 校验全绿 → 备份 → 写包 → 记 provenance
# 或在工作台里：质量页一键跑全部校验 → 问题栏看红项 → 危险操作区发布
```

这条链的契约（段的输入输出、缓存键、入账字段、分诊语义、复现命令）见 `studio/docs/generation-loop.md`；
素材护照（这套素材怎么来的 + 一键复现 + 红黄绿）见 `node bin/provenance.js report walk-left --text`。

## 五、工作台里的旧路径（可选，不是主路径）

`node bin/pipeline.js providers` 仍会列出模型↔key 的严格对应表与"缺 key 即拒"的门禁——
那是**在工作台内部直连生成**的备用路径（需要 key，且要自己核验商用条款）。主路径是上面这套交接。
