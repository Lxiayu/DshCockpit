# Live2D 技术路线与 POC 方案（含许可风险表）

> 状态：**暂缓生产接入（Deferred）+ Re-evaluation 触发条件** · 核查日期 **2026-11-01（Asia/Shanghai）**，条款复核 **2026-11-01**
> 结论定位：**Deferred（暂缓生产接入）**，**不是永久拒绝**。技术可行、许可成本高、素材成本更高；三条同时成立才构成"本阶段不接"，任一条被推翻即可 Re-evaluate。
> 方法：Live2D 官方三份许可协议（Open Software / Proprietary Software / Free Material）+ SDK Release License 页 + Expandable Application 专页 + VTuber 授权页全文实抓并逐条复读；`Live2D/CubismWebSamples` / `CubismWebFramework` 的 `LICENSE.md` 实抓；PixiJS v8 生态候选 npm + GitHub 实测；我方资产层与角色包代码实读。

---

## 0. 一句话结论（三层）

1. **技术上可行**：PixiJS **8.5.2** 已是 DshCockpit 依赖（`package.json` 实测），社区已有 PixiJS v8 的 Live2D 渲染器（`@jannchie/pixi-live2d-display@1.4.0`、`untitled-pixi-live2d-engine@1.4.0`，均 MIT）。**技术不是障碍。**
2. **许可上成本高，但不是"必然违法"**：我们的角色是**鲸鱼娘，会作为可分发的角色素材包**；按 Expandable Application（Proprietary §1.5）的**定义文义**，这个形态**强指向** Expandable——但它需要过「**significant expandability**」这个门槛，且最终判定属 Live2D 单方裁量。**正确表述是"高概率命中，需书面确认"，不是"100% 命中"。** 另需分清：**Cubism Core 是专有二进制，但 `Redistributable Code` 在满足 §5.2 四项条件时是允许随派生作品再分发的**（这点上一版写成了"绝不 bundle"，不准确，见 §1.5）。
3. **产品上现在不该做**：`docs/product/product-principles.md` 已写「Live2D 只做 POC，不进生产」；`OFFICE-V3-VISUAL-PLAN-2026-10-27.md` §85 已写「推荐 A（现有帧 + 程序化）先行，P3.4 再评估 Live2D」。本评估**确认这两条判断成立**，但把"确认成立"的对象从「许可红灯、永久否决」修正为「**在本阶段（无收入模型、无分层原画资产、无签约预算）不接生产；条件变化即重评**」。

**这一版修订的核心（用户直接批评的那一条）**：

> 上一版把「协议**终止**后的销毁义务」（Proprietary §8.4）直接当成「**未获审批即出版**」的自动后果。
> **这是不准确的。** §8.4 的触发前提是 §8.1「本协议被解除」（`If this Agreement is terminated pursuant to Section 8.1`）——即 Live2D **先**行使解除权，**再**产生销毁义务。未获审批出版（§6.3）是**违约事实**，它构成解除的**理由之一**（§8.1.1），并直接产生**损害赔偿**责任（§12）与**禁令救济**风险（§4.2），但它**本身不自带销毁义务**。
> **两条链必须分开写：**「违约 → Live2D 可解除 → 解除后须销毁」与「违约 → 损害赔偿/禁令」。见 §1.6。

---

## 1. 许可核查：三份协议 + Expandable Application（逐条引用原文）

### 1.1 三份协议的分工（必须先分清，否则一定误判）

| 协议 | 覆盖对象 | 关键性质 | 来源 |
|---|---|---|---|
| **Live2D Open Software License Agreement**（v1.4，修订 2025-02-03） | **Cubism Components** 的源码部分（Cubism Web Framework / Web Samples 等） | 允许改、允许分发，但**有 §5.6「不得与不兼容许可证组合」** | https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html |
| **Live2D Proprietary Software License Agreement**（v2.1，修订 2025-02-03） | **Cubism Core**（`live2dcubismcore.min.js` 等）、Cubism MotionSync Core | **闭源专有**；只有 `RedistributableFiles.txt` 列出的才是 Redistributable Code；**§5 允许有条件再分发，§6.2 禁止未获许可的分发/捆绑** | https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html |
| **Free Material License Agreement** | Live2D 提供的免费素材 / 官方角色 / 模型数据 | 按 License Type 分层（Freeware / Sample Code / Live2D Original Character / Collaboration Character） | https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html |

**最重要的认知**：**Live2D 不是"一个开源 SDK"。** 框架开源（Open Software），**运行时核心是专有二进制**（Proprietary），**素材是单独授权的**（Free Material）。三者的义务互不覆盖。

**补充实证（2026-11-01）**：`Live2D/CubismWebSamples` 与 `Live2D/CubismWebFramework` 的 `LICENSE.md` 明确写「Cubism Web Samples/Framework **is included in Live2D Cubism Components**」，并分列三段：`Cubism SDK Release License`（营收 ≥1000 万日元的 business 必须取得）、`Live2D Open Software License`（Components）、`Live2D Proprietary Software License`（**Cubism Core**）。即：**框架走 Open，Core 走 Proprietary，Release License 是第三重（出版层）**。这三重身份在 GitHub 的 `license.spdx_id` 上统一表现为 `NOASSERTION`——不是"无许可证"，是"GitHub 无法映射为标准 OSI 许可证"。

### 1.2 Expandable Application：定义、判定边界、豁免路径（这是本评估最关键的一节）

#### 1.2.1 定义（Proprietary §1.5 / Open §1.5 措辞一致）

> 「「Expandable Application」means any Derivative Work **having significant expandability**. In particular, it includes the Derivative Work which **uses and generates any indefinite number of models** by adding or combining files or data (e.g. avatars, live streaming applications, video generators/video makers), **or, the Derivative Work containing multiple or other works in one title, or accessible to such works through one title** (e.g. collection of relevant works or portal).」

**逐要件拆解（这是判定边界，不是结论）**：

| 要件 | 原文关键词 | 判定含义 | 谁说了算 |
|---|---|---|---|
| **门槛要件** | `having significant expandability` | 不是"有任何扩展性"，是"**显著**扩展性"。这是限定语，不是修辞 | 文义门槛；最终解释权在 Live2D（协议整体解释 + §15 日本法/东京地裁） |
| **要件 A（模型维度）** | `uses and generates any indefinite number of models by adding or combining files or data (e.g. avatars)` | 「不特定数量模型」+「通过添加/组合文件或数据实现」+ 明确举例 **avatars** | 文义 + Live2D 裁量 |
| **要件 B（作品维度）** | `containing multiple or other works in one title, or accessible to such works through one title` | 「一个 title 内含多个/其他作品」或「通过一个 title 可访问这些作品」 | 文义 + Live2D 裁量 |
| **兜底性质** | 「In particular, it includes」 | 列举是**示例性**（non-exhaustive），不排除其他形态 | Live2D 裁量 |

**关键：定义里有一个"显著扩展性"的门槛，而且判定权在 Live2D 手里。** 所以正确的表述是「**按定义文义强指向 Expandable**」，而不是「定义直击、100% 命中」。

#### 1.2.2 后果（Expandable Application 专页原文，2026-11-01 复核）

> - **Review and License Agreement are required for every Expandable Application**
> - 「every Expandable Application needs to be **reviewed for approval** and enter into a **special Publication License Agreement** before its release.」
> - 「These requirements are applied to **all publishers including General Users and Small-Scale Enterprises** who are normally exempted from the Publication License Agreement for non-Expandable Applications.」

#### 1.2.3 审查条件（原文五条 + 一条上一版漏记的重要脚注）

1. **Existence of a valid revenue model**（「as a general rule, **fully free of charge is not eligible for approval**」）
2. Consent to **submission of sales reports and license fee payments based on revenue share**
3. Inclusion of a **Statement specified by Live2D** in the EULA/ToS（仅流媒体用途）
4. **Display of the Expandable Application logo** in the app + **listing on Live2D Showcase**
5. 满足以上也可能被拒：「approval may not be granted … in all cases」

> ⚠️ **上一版漏记的一条（重要修正）**：同一专页在「approval may not be granted in all cases」之后紧接一行原文：
> 「**Approval may be granted to fully free-of-charge Expandable Applications in some cases if separately specified conditions are met.**」
>
> 也就是说：**「完全免费原则上不予批准」是"一般规则"（as a general rule），不是绝对排除**——存在"另行规定的条件"下的免费获批路径。上一版把这条写成「免费项目原则上不给批」并据此论证"我们（免费开源）必被拒"，**过度绝对**。准确说法：**免费形态会显著降低获批概率、且获批条件不公开（无法核实），但协议文本没有封死这条路。**

#### 1.2.4 费用表（原文实测，2026-11-01）

| 主体 | Basic initial fee | Basic annual fee（每平台） | Revenue share |
|---|---|---|---|
| General User（年销 < 1000 万日元） | Free | Free | **$1.90/笔 或 20% 销售额（取高）** |
| Small-Scale Enterprise（年销 < 1000 万日元） | Free | Free | **$1.90/笔 或 20%（取高）** |
| Middle-Scale（1000 万–1 亿日元） | $317.33 (¥50,000) | $1,523.21 (¥240,000) | 5% |
| Large-Scale（> 1 亿日元） | $1,904.01 (¥300,000) | $7,616.03 (¥1,200,000) | 5% |

#### 1.2.5 授权边界：什么算 Expandable / 什么不算 / 有哪些豁免路径

**A. 算 Expandable（按文义）**
1. 应用可加载**不特定数量**的 Live2D 模型（用户自装包、社区包、插件包、下载即用）。
2. 应用是 **avatar 类**（定义里逐字点名 `avatars`）——虚拟形象/桌宠/VTuber 客户端属此类。
3. 一个应用内**承载多个作品**（多个角色、多个模型作者的作品集合）。
4. 应用是**门户/集合**（"accessible to such works through one title"）。

**B. 不算 Expandable（或至少需具体判断）**
1. 模型**完全内置、不可替换、不可加载外部模型**，且一个 title 内只有**一个**作品 → 更可能落在普通 Derivative Work（仍受 §2.1 出版许可约束，但可享 §2.2 豁免）。
2. 扩展性**不显著**（`significant expandability` 未达门槛）——例如只内置 2–3 个固定角色、无外部加载入口。**这是文义上的抗辩空间，但边界模糊、最终由 Live2D 解释，不可当作可靠依据。**
3. **纯内部使用 / 开发与试用阶段**：SDK Release License 页原文「**License only required upon releasing your content. Not during trial or development.**」→ **不发布就不构成 Publish，无需 Release License**（这是本阶段最有用的一条授权空间，见 §6）。

**C. 豁免 / 替代路径（按适用性排序）**

| # | 路径 | 条款依据 | 是否适用于我们 | 备注 |
|---|---|---|---|---|
| **E1** | **非 Expandable + General User / Small-Scale / 教育机构** → 免 Publication License（免签约、免费） | Proprietary **§2.2**；SDK 总页「Individuals and Small-Scale Enterprises are exempted from the license and payment (**except Expandable Application**)」 | **仅当**我们能证明不构成 Expandable（见 B1/B2） | 与产品方向（可换角色）互斥；B2 的"扩展性不显著"是唯一理论缝隙但不可靠 |
| **E2** | **免费 Expandable 也可能获批** | Expandable 专页脚注：「Approval **may** be granted to fully free-of-charge Expandable Applications in some cases **if separately specified conditions are met**」 | **可能** | 但"separately specified conditions"**未公开 → 无法核实**；只能通过正式申请得知 |
| **E3** | **Live2D Simple License Plan（SLP）** | Proprietary **§2.4**：「For **Middle-Scale or Large-Scale Enterprises** planning **temporary** Publication for **specific promotional purposes**…」 | **不适用**（我们是 General User/Small-Scale） | 仅中大型 + 临时促销 |
| **E4** | **VTuber 专属门槛（年销 2000 万日元）** | VTuber 授权页：「annual sales generated directly or indirectly by the covered software or content produced with it exceed **JPY 20 million**… the applicable license plan is the **"Expandable Applications" plan**」 | **不适用**（我们不是 VTuber 流媒体业务） | 但它证明"Expandable 的适用有场景化门槛"，不是一见 avatar 就必然落 Expandable |
| **E5** | **不发布（仅内部评估/开发）** | SDK Release License 页：「Not during trial or development」；Proprietary §1.6「Publish」定义 | **适用** | **本阶段唯一确定合规的形态**（见 §6 D1/D4） |
| **E6** | **用户自装、我们不分发** | Proprietary §3.1 / §6.5（第三方须自己取得许可）；§1.13 Distributor 定义 | **适用** | 见 §5 P-1：我们只留接口，不含任何 Live2D 内容 |

**结论（修正后）**：**「鲸鱼娘作为可分发的角色素材包」+「Live2D」按定义文义高概率落在 Expandable Application。** 这是"需要先做书面确认、并按乐观情况准备"的风险项，不是"已经确定违法"。**E5（不发布）与 E6（用户自装）是当前确定合规的两条路。**

### 1.3 为什么"我们是鲸鱼娘 + 可分发的角色素材包"强指向 Expandable

这是本评估的判定推理，逐条对齐定义（**注意最后一列从"是"改成"高概率"的理由**）：

| 定义要件 | DshCockpit 的现实 | 判定 |
|---|---|---|
| `having significant expandability` | Character Pack 体系（`resources/characters/deepseek-default/manifest.json`、`validate-character-pack.js`、`character-pack-installer.js`）**就是"用户/第三方添加角色包"的机制**：import local folder 或 ZIP → validate → install → activate，且有 Layer 2（官方）/ Layer 3（社区包，"仅可由用户自行安装"）分层 | **门槛要件很可能满足**（有完整外部加载链路 = 显著扩展性） |
| `uses and generates any indefinite number of models by adding or combining files or data (e.g. avatars)` | 同上，且角色形态正是 **avatar** | **高概率命中要件 A** |
| `containing multiple or other works in one title, or accessible to such works through one title` | 一个 App 内可承载多个角色（官方占位 + 社区包），办公室里多个 agent 各有角色 | **高概率命中要件 B** |

**修正后的准确表述**：

> 只要 DshCockpit 的 Live2D 支持形态是「可加载多个/第三方模型」，就**高概率**落在 Expandable Application——**但这是"按文义的解释结论"，不是"经 Live2D 确认的定性"**。最终定性权在 Live2D（协议解释 + §1.6「Publish」判定均明示"sole discretion"）。因此任何生产接入决策**必须先取得 Live2D 的书面定性意见**，不能由我们自己下结论。

**唯一能规避的形态**（准确记录，供将来判断）：如果 Live2D 模型**完全内置、不可替换、不可加载外部模型**，且一个 title 里只有**一个**作品 —— 那可能不构成 Expandable。但我们的**产品核心就是"可换角色"**（Layer 2/Layer 3 资产分层已写死在 LICENSE 里）。所以这条规避路径**与产品方向互斥**。

### 1.4 Publication License：即使不是 Expandable 也要签；但"何时才算 Publish"有明确边界

**Proprietary §2.1 原文**：

> 「except for the case falling under Section 2.2, the Customer **may not Publish or Distribute Derivative Work** for personal, Internal, Non-commercial, commercial, or any other purposes unless otherwise agreed in writing with Live2D. To Publish and Distribute the Derivative Work, the Customer **must execute and enter into a separate "Live2D Publication License Agreement"**.」

**§2.2 豁免**：General Users / Qualified Educational Institutions / Small-Scale Enterprises 可豁免——**但仅限非 Expandable**。

**Open Software §2.3 原文**：

> 「The Customer **may not Distribute or Publish** Derivative Works under the conditions set forth in 2.2.1 hereof unless the "Live2D Publication License Agreement" is **separately executed**.」

**「Publish」定义极宽（Proprietary §1.6）**：「to produce the Derivative Works … accessible and available by **distribution, transfer, broadcast, advertisement, announcement, sharing and other means**, whether individually, internally, **commercially, non-commercially** or in any other ways. **Live2D retains the right to determine whether or not an act by the Customer corresponds to "Publish" at its sole discretion.**」

**但"Publish"有下界（这条上一版没写，很重要）**：SDK Release License 页原文——

> 「**License only required upon releasing your content. Not during trial or development.**」

→ **开发、试用、内部验证不构成 Publish。** 因此：
- **把 App 发布到 GitHub Releases / 官网免费下载 = Publish**（「非商业」不豁免；豁免只按"业务规模"判，不按"是否收钱"判）。
- **本机内部跑通渲染、录屏不发布、不打包进安装包 = 不构成 Publish** → §6.1 的 D4 技术验证是**合规的**。

### 1.5 Cubism Core：专有二进制，但 `Redistributable Code` 允许**有条件**再分发（修正）

**上一版的错误表述**：「绝不 bundle；若必须用，走 §5.2.4 原样 + §5.2.1…」——这**自相矛盾**：既说"绝不 bundle"，又说"若必须用走 §5.2"。准确的事实是：

**§5 就是"允许再分发"的正面授权**（并非只有 §6.2 的禁止）：

- **§5.1 Right of Use and Redistribution**：「The Customer **may copy and distribute the Redistributable Code**. In addition, the Customer may allow the Distributors of Derivative Works and Output Files to copy and distribute the Redistributable Code as a part of the Derivative Works and Output Files of the Customer.」
- **§5.2 四项条件**：
  - **§5.2.1**「Add **important major functions** that use the Redistributable Code to Customer's Derivative Works and Output Files.」（必须添加使用该代码的**重要主要功能**）
  - **§5.2.2** 让分发者和终端用户同意**等价的保护条款**
  - **§5.2.3** 对 Live2D 作**免责、辩护、补偿**（含律师费）
  - **§5.2.4** 按 Live2D 提供的**原样**（object 或 source 形式）分发，不改
- **§5.3.2 真正的红线**：不得以「excluded license」方式改/分发。「excluded license」=「(i) 其代码以**源码形式**发布或分发；或 (ii) **第三方可修改**其代码」的许可证。**MIT 两项都满足 → MIT 是 excluded license。**
- **§6.2「No Distribution, Disclosure or Bundling」** 的限定语是「**Except as expressly permitted in this Agreement**」——§5 正是那个 "expressly permitted"。
- §6.1 No Modifications / §6.4 No Reverse Engineering（独立限制，与再分发授权并行）。

**修正后的准确表述**：

> Cubism Core（Redistributable Code 部分）**可以**随 DshCockpit 一起分发给终端用户，**前提是同时满足 §5.2.1–5.2.4**；**不允许**的是把它以 MIT（或任何允许源码分发/允许第三方修改的许可证）名义发布，也不允许修改它。也就是说：**"能不能分发"的答案是"能，但有条件"；"能不能当作 MIT 开源件"的答案是"不能"。** 上一版把前者也写成了"不能"，是过度收紧。

**Open Software §5.6「No Combination with Incompatible License」原文**：

> 「The Source Code may **not be altered or Distributed in such way as the excluded license applies** to part of the Software. … the "excluded license" means the license that meets the following conditions for use, alteration or Redistribution: (i) its code is **released or distributed in the source code form**; or (ii) **a third party may alter its code**.」

→ **这与 MIT 的定义正面冲突**：MIT 允许第三方修改、允许以源码形式发布。**把 Cubism 代码以 MIT 名义发布出去 = 违反 Open Software §5.6 / Proprietary §5.3.2。** 这一条依然成立且是最硬的一条。

### 1.6 【核心修正】终止（termination）后的后果 ≠ 未获审批（unauthorized publication）的后果

用户直接批评的那一条。**两条责任链必须分开写**，各自给条款依据。

#### 1.6.1 链路一：违约 → Live2D **行使解除权** → 解除后产生销毁义务

```
未获审批而出版（Proprietary §6.3 禁止行为）
        ↓  （构成 §8.1.1「engage in the prohibited acts stipulated under Section 6」）
Live2D「可以」立即解除本协议（§8.1.1：may immediately cancel … without giving notice）
        ↓  （这一步是 Live2D 的裁量行为，不是自动发生）
协议「已被解除」（terminated pursuant to Section 8.1）
        ↓  （§8.4 的触发前提在此才成立）
客户须「promptly destroy the Software, all copies thereof, and all Derivative Work
        including the Output Files and any other derivatives」（§8.4）
```

**条款依据**：

- **Proprietary §8.1**（解除权，不是自动）：「Live2D may immediately cancel this Agreement **without giving notice** to the Customer [if] … **8.1.1** If any Customers engage in the prohibited acts stipulated under **Section 6. Restrictions and Requirements**; …」
- **Proprietary §8.1.2**（一般违约有催告与合理补正期）：「If any Customers breach the provisions of this Agreement and **fail to correct the breach within a reasonable period upon notice** to them;」
- **Proprietary §8.4**（**销毁义务的前提是"已依 §8.1 解除"**）：「**If this Agreement is terminated pursuant to Section 8.1**, the Customer shall promptly destroy the Software, all copies thereof, and all Derivative Work including the Output Files and any other derivatives arising from use of the Software.」
- **Open Software §7.1 / §7.4** 结构完全相同：「If any Customers fall under any of the cases … **Live2D may immediately cancel this Agreement**」（§7.1）；「**If this Agreement is terminated pursuant to Section 7.1**, the Customer shall promptly destroy …」（§7.4）
- **Proprietary §2.1 末句**（另一条独立的解除路径）：「Live2D **reserves a right at its sole discretion to terminate this Agreement against certain Customer**.」

**法律含义（必须这样读）**：
1. **§8.4 是"解除的法律后果"，不是"违约的自动后果"。** 它自己写明了前提「If this Agreement is terminated pursuant to Section 8.1」。
2. 从违约（§6.3）到解除（§8.1.1）之间，有一个 **Live2D 的裁量行为**（`may immediately cancel`，而非 `shall`/`automatically`）。Live2D 可以选择解除，也可以选择不解除而只索赔。
3. 因此：**「未获审批发布 = 自动触发销毁全部派生作品」的表述是不准确的**；准确表述是「未获审批发布 = 违约，Live2D **有权（may）**解除协议；**一旦解除**，则依 §8.4 产生销毁义务」。

#### 1.6.2 链路二：违约 → 损害赔偿 / 禁令救济（**不需要先解除**）

```
未获审批而出版（§6.3 禁止行为 / §2.1 未经书面同意出版）
        ↓
① 损害赔偿：§12（含 Live2D 的合理律师费）
② 禁令/衡平救济：§4.2（Live2D 明确保留"injunctive, equitable, or other similar relief"）
③ （可选）解除 → 走链路一
```

**条款依据**：

- **Proprietary §12 Compensation for Damages**：「The Customer **shall be liable to Live2D for the damages** arising out of engagement in any restricted actions set forth in "**6. Restrictions and Requirements**" or Customer's breach of this Agreement. In case Live2D takes legal actions due to Customer's breach of this Agreement, the Customer shall be liable to Live2D for **reasonable attorney's fees**.」
- **Proprietary §4.2**：「Live2D **may seek and shall be entitled to injunctive, equitable, or other similar relief** to protect, maintain, defend, enforce, and preserve such rights, in addition to any other available remedies.」
- **Proprietary §8.3**：「Termination of the Agreement **shall not prevent Live2D from exercising a claim for damages** against the Customer.」（即：解除与索赔是并行的，不是二选一）
- **Proprietary §16 Survive**：§4 / §7 / §10 / §11 / §12 / §14 / §15 在协议期满或解除后**继续有效** → **解除并不能免除已经发生的损害赔偿责任**。

#### 1.6.3 两条链的对照表（可直接进 ADR）

| 维度 | 链路一：终止后的销毁 | 链路二：未获审批的即时责任 |
|---|---|---|
| **触发事实** | 未获审批出版 **且** Live2D 依 §8.1 解除协议 | 未获审批出版（§6.3 / §2.1）本身 |
| **是否需要 Live2D 先做出行为** | **需要**——`may immediately cancel`（§8.1.1，裁量） | **不需要**——违约即产生（§12） |
| **核心条款** | §8.4（+ 前提 §8.1）；Open §7.4（+ 前提 §7.1） | §12（损害赔偿）、§4.2（禁令）、§6.3（禁止行为本身） |
| **后果形态** | 销毁 Software / 副本 / **全部 Derivative Work（含 Output Files）** | 损害赔偿（含律师费）+ 可能的禁令 + 停止发行 |
| **是否自动** | **不自动**（先要解除；§8.1.2 一般违约还有催告与补正期） | **自动产生责任**（但是"责任"，不是"销毁义务"） |
| **上一版的错误** | 把它写成"未获审批即自动触发" | 上一版几乎没有单独写这一条，全被"销毁"盖住了 |

#### 1.6.4 一句话正确表述（替换上一版的"最危险单一陷阱"）

> **未获审批就发布 Live2D 内容 = 确定违约（§6.3），会立刻产生损害赔偿责任（§12，含 Live2D 律师费）并暴露于禁令风险（§4.2）；并且它构成 Live2D 依 §8.1.1 单方解除协议的理由——一旦解除，§8.4 才要求销毁软件副本与全部派生作品。销毁不是"发布那一刻自动发生"的后果，而是"Live2D 决定解除之后"的后果。这个区别决定了风险是"可谈判的金钱/禁令风险"还是"资产归零"，也决定了我们的应对策略（先停止发行 + 争取补签，而不是假设一切都完了）。**

### 1.7 许可风险表（严重度按"条件后果"重标）

| # | 风险 | 触发条件 | 后果（**精确到"是否必然"**） | 严重度 | 可行的边界 |
|---|---|---|---|---|---|
| **R1** | **被判为 Expandable Application 且未获批** | DshCockpit 支持加载多个/外部 Live2D 模型并分发 | 违约（§6.3）；**Live2D 有权（may）解除**（§8.1.1）；解除后须销毁（§8.4）；并存损害赔偿责任（§12/§8.3） | **高（条件性，非必然）** | 先取得 Live2D 书面定性；走 E5（不发布）或 E6（用户自装） |
| **R2** | **Publication License 未签即发布** | 发布任何含 Live2D 渲染的构建 | 同 R1（Publish 定义极宽，免费下载也算） | **高（条件性）** | 同上；或正式签约（个人/小微对**非 Expandable** 可豁免；我们大概率不满足"非 Expandable"） |
| **R3** | **把 Cubism Core 以 MIT 名义发布/修改** | `live2dcubismcore.min.js` 以源码形式进 `dist/`、或允许第三方修改、或以 `node_modules` 依赖身份被当作 MIT 件分发 | 违反 Proprietary **§5.3.2** / **§6.2** / **§6.1**；违反 Open **§5.6**（MIT 是 excluded license） | **高（这一条是硬红线）** | **不是"绝不 bundle"，而是"bundle 必须满足 §5.2.1–5.2.4"**：原样分发（§5.2.4）+ 有重要功能（§5.2.1）+ 用户同意等价条款（§5.2.2）+ 独立 NOTICE 与免责（§5.2.3）；**且绝不以 MIT 名义** |
| **R4** | **素材授权**：鲸鱼娘形象（大肥鱼）是社区二创 | 使用 `PC2005-cloud/dsh-pet` 的鲸鱼娘素材 | 该素材声明 **CC BY-NC-SA 4.0**（署名·**非商业**·相同方式共享），且注明"**不可以以任何形式商业化**"；原型「溟月」出自 B 站 @上善无形，DeepSeek 版设计出自 @ZipZipPipe | **高** | **绝不使用**该素材。我们已有独立占位资产（`resources/characters/deepseek-default/LICENSE`：官方占位、版权独立、不随 MIT、禁止用于 DshCockpit 以外发行物），正式稿走**约稿买断** |
| **R5** | **Cubism Editor 授权** | 制作模型（.moc3） | Editor 是**独立商业软件**，有 PRO 订阅、42 天试用、**激活数限制**；`live2D-editor-software-license-agreement` 独立协议 | **中** | 外包约稿时明确"模型制作方自备合法 Editor 授权"，合同里写清 |
| **R6** | **示例素材禁止流用** | 用 Cubism SDK 自带 sample 素材 | Proprietary §5.5 / Open §5.5：「Sample Material … **may not be used for any purposes other than Internal evaluation and Training**」；`CubismWebSamples/LICENSE.md` 列出的 8 个免费模型另有 `live2d-sample-model-terms` 逐模型条款 | **中** | 不用任何 sample 素材；若要用免费模型，逐模型读其 terms |
| **R7** | **商标/品牌误认** | 名字里带 Live2D / 用其 logo | Open §4.3 / Proprietary §4.3、§5.3.1 | **低** | 只用中性描述"支持 Live2D 模型格式"，需按其 brand guidelines |
| **R8** | **客户作品被 Live2D 公开** | 签约出版后 | Proprietary §2.1：「Live2D reserves a right to **publicize Customer's Derivative Work as examples**」 | **低** | 接受（这是签约出版的对价之一） |
| **R9** | **协议单方变更** | 任何时候 | Open §8 / Proprietary §17：「may be amended **from time to time** … at Live2D's sole discretion」，公布即生效；日文版为准（§15.2）；东京地裁专属管辖（§15.3） | **中** | 记录版本号（当前 Open v1.4 / Proprietary v2.1，均 2025-02-03）；锁版本不现实（协议不能锁） |
| **R10** | **判定权单方归属**（上一版未单列） | 任何定性争议 | §1.5/§1.6 均含「Live2D retains the right to determine … at its sole discretion」；§2.2 资格判定「will not accept any objection or protest」 | **中** | 任何生产决策前**先书面确认定性**；不要自己下结论 |

### 1.8 可引用条款清单（进 ADR / Issue 用，条款编号 + URL + **该条款真正说了什么**）

> 这一列是本版新增的：**把"最坏情形"与"条款原文"分开**，避免下次再出现"销毁条款 = 自动后果"的误读。

| # | 条款位置 | 原文（关键句） | **该条款真正说了什么 / 不说什么** | URL |
|---|---|---|---|---|
| **C1** | Proprietary v2.1 **§1.5**（定义） | 「"Expandable Application" means any Derivative Work **having significant expandability**. In particular, it includes … uses and generates any **indefinite number of models** … (e.g. avatars…) … **containing multiple or other works in one title**」 | 有「显著扩展性」门槛 + 列举为示例性；**不**说"凡 avatar 必属 Expandable" | Proprietary URL |
| **C2** | Proprietary **§2.1**（出版必须签约） | 「the Customer **may not Publish or Distribute Derivative Work** … unless otherwise agreed in writing with Live2D. … **must execute … "Live2D Publication License Agreement"**」 | 出版层需要单独签约；**不**说违反即销毁 | 同上 |
| **C3** | Proprietary **§2.1 第 2 段**（Expandable 需事前审批） | 「For Publishing Expandable Application, **prior to executing "Live2D Publication License Agreement", Customer shall make an application in advance and obtain approval** … Live2D may, at its sole discretion, approve or reject」 | 审批是出版**前置条件**；**不**说未审批的后果 | 同上 |
| **C4** | Proprietary **§2.2 末句**（**豁免不适用 Expandable**） | 「Also, this exemption is **not applicable for Publishing the Expandable Application** set forth herein the Section 6.3」 | 关闭了 E1（小微豁免）在 Expandable 情形下的适用；**不**关闭 E2（免费获批脚注） | 同上 |
| **C5** | Proprietary **§6.2**（禁止未授权分发/捆绑） | 「**No Distribution, Disclosure or Bundling** — **Except as expressly permitted in this Agreement**, the Customer may not distribute or disclose all or part of this Software, or **bundle the same with the Derivative Work**.」 | 有「Except as expressly permitted」限定 → **§5 就是那个例外**；**不**绝对禁止 bundle | 同上 |
| **C6** | Proprietary **§6.3**（无授权不得出版） | 「**No Unauthorized Publication** — Except in the case the exemption defined in the Section 2.2 is applied, the Customer **may not Publish Derivative Works without executing "Live2D Publication License Agreement"**.」 | 这是**禁止行为**条款（违约事实）；**不**是后果条款 | 同上 |
| **C7** | Proprietary **§5.3.2**（excluded license 定义，MIT 命中） | 「… in such a way that the **excluded license** is applied …: (i) its code is **released or distributed in the source code form**; or (ii) **a third party may alter its code**.」 | MIT 命中 → **不能以 MIT 名义分发 Cubism 代码**；**不**说不能分发 | 同上 |
| **C8** | Proprietary **§8.4**（**解除后**的销毁义务） | 「**If this Agreement is terminated pursuant to Section 8.1**, the Customer shall promptly **destroy the Software, all copies thereof, and all Derivative Work** including the Output Files…」 | **前提是"已被依 §8.1 解除"**；**不**是"违约即自动销毁" | 同上 |
| **C9** | Open Software v1.4 **§5.6**（不兼容许可证组合） | 「**No Combination with Incompatible License** — The Source Code may not be altered or Distributed in such way as the **excluded license** applies to part of the Software.」 | 与 C7 同构（源码侧）；**不**说不能随应用分发 | Open URL |
| **C10** | Open Software **§2.3**（出版许可） | 「The Customer **may not Distribute or Publish** Derivative Works … unless the "Live2D Publication License Agreement" is **separately executed**」 | 同 C2（框架侧）；**不**说违反即销毁 | 同上 |
| **C11** | Open **§5.5** / Proprietary **§5.5**（示例素材） | 「the Sample Material or Output Files including the Sample Material **may not be used for any purposes other than Internal evaluation of the Software and Training**」 | 仅限内部评估/培训；与"发布后果"是两条独立约束 | 两份协议均有 |
| **C12** | **Expandable 专页**（审查条件 + 费用 + **免费例外脚注**） | 「**Review and License Agreement are required for every Expandable Application**」；「applied to **all publishers including General Users and Small-Scale Enterprises**」；「as a general rule, fully free of charge is not eligible for approval」；**「Approval may be granted to fully free-of-charge Expandable Applications in some cases if separately specified conditions are met.」** | 有审查门槛 + **免费并非绝对排除**（上一版漏记后半句） | Expandable URL |
| **C13** | **SDK 许可总页**（豁免括号） | 「Individuals and Small-Scale Enterprises are exempted from the license and payment (**except Expandable Application**)」 | 与 C4 同义 | SDK About URL |
| **C14** | **SDK for Web 下载页**（需同时同意两份协议） | 「To download, please read and agree to the "Live2D Proprietary Software License Agreement" and "Live2D Open Software License Agreement".」 | 下载即受两份协议约束 | SDK Web URL |
| **C15** | **Proprietary §1.6**（Publish 定义极宽 + **裁量**） | 「"Publish" means … whether individually, internally, **commercially, non-commercially** or in any other ways. **Live2D retains the right to determine … at its sole discretion**.」 | 定义宽 + 判定权在 Live2D；配合「Not during trial or development」得到**下界** | Proprietary URL |
| **C16** | **Proprietary §17 / §15**（协议单方变更 / 法律适用） | 「may be amended **from time to time** as necessary, **at Live2D's sole discretion** … effective from the date of the latest amendment.」；§15.1–15.3 日本法 / 日文版优先 / 东京地裁 | 协议不可锁定；争议在日本法下 | 同上 |
| **C17**（新增） | Proprietary **§8.1**（**解除权**，链路一的中间环节） | 「Live2D **may immediately cancel** this Agreement **without giving notice** … **8.1.1** [if Customer engages in] the prohibited acts stipulated under **Section 6**；**8.1.2** [if breach not corrected] within a reasonable period upon notice」 | **解除是裁量行为**；一般违约还有催告补正期 | 同上 |
| **C18**（新增） | Proprietary **§12**（损害赔偿，链路二） | 「The Customer **shall be liable to Live2D for the damages** arising out of engagement in any restricted actions set forth in "6. Restrictions and Requirements" … liable for **reasonable attorney's fees**」 | **违约即产生**赔偿责任（无需先解除） | 同上 |
| **C19**（新增） | Proprietary **§4.2 + §8.3 + §16**（禁令 / 解除不免除索赔 / 存续） | §4.2「entitled to **injunctive, equitable, or other similar relief**」；§8.3「Termination … **shall not prevent** Live2D from exercising a claim for damages」；§16 列 §4/§7/§10/§11/§12/§14/§15 存续 | 禁令与索赔**并行且存续**；解除 ≠ 免责 | 同上 |
| **C20**（新增） | **SDK Release License 页**（Publish 的**下界**） | 「**License only required upon releasing your content. Not during trial or development.**」 | 开发/试用**不构成 Publish**；本阶段唯一确定合规的路径（E5） | SDK Release License URL |
| **C21**（新增） | **Open Software §7.1 / §7.4**（框架侧的同一结构） | 「**Live2D may immediately cancel** this Agreement」（§7.1）；「**If this Agreement is terminated pursuant to Section 7.1**, the Customer shall promptly **destroy** …」（§7.4） | 与 C17/C8 完全同构：**解除 → 销毁**，不是"违约 → 销毁" | Open URL |

**这 21 条是 ADR 需要的全部弹药。修正后的论证链是四环，不是三环**：

> **C1（按文义高概率为 Expandable，需书面确认）→ C4（Expandable 不享小微/免费豁免，但 C12 留了免费获批的例外口）→ C6/C17（未审批出版 = 禁止行为，Live2D **有权**解除）→ C8（**解除后**才销毁）+ C18/C19（无需解除即产生赔偿与禁令风险）**

---

## 2. 技术路线核查（PixiJS v8 生态，2026-11-01 实测）

### 2.1 我们已有的底座

| 项 | 实测 |
|---|---|
| `pixi.js` | **8.5.2**（`package.json` dependencies 实测） |
| 渲染器 | `src/office/render/pixi-office-renderer.js`（**4,673 行**）、`code-office.js`、`code-scene.js`、`iso-office.js`、`iso-projection.js`、`presentation-clock.js`、`frame-hygiene.js`、`fps-monitor.js` |
| 角色资产形态 | 帧动画（`resources/characters/deepseek-default/assets/animations/{side,walk,working}` + `expressions`；`animation/anchors.json` + `animations.json`） |
| 全仓 Live2D 痕迹 | `grep -rn "Live2D\|live2d" src/` → **0 命中**（只有 docs 里讨论） |

**结论：当前零 Live2D 代码，零技术债。这是一个干净的决策点。**（这条不随 Deferred 结论而变：**正因为零技术债，所以"暂缓"的成本是零、"重评"的成本也低**。）

### 2.2 渲染器候选（npm + GitHub 实测）

| 候选 | 版本 | 许可证 | PixiJS 要求 | stars | 最近推送 | 判定 |
|---|---|---|---|---|---|---|
| `pixi-live2d-display`（`guansss`，原版） | — | MIT | **PixiJS 6.x** | **1,516** | **2024-08-20**（2 年前） | **不用**：PixiJS 6，与我们 8.5.2 不兼容；已停更 |
| `@jannchie/pixi-live2d-display` | **1.4.0** | **MIT** | **`^8.0.0`** | 2 | 2026-08-26 | 可用但**几乎无社区**（2★），单人 fork |
| `@naari3/pixi-live2d-display` | 1.2.5 | MIT | `^8.0.0` | 6 | **2025-11-30** | 只支持 Cubism v5；近一年未动 |
| `untitled-pixi-live2d-engine` | **1.4.0** | **MIT** | **`^8.13.1`** + `@pixi/sound ^6.0.1` | **81** | **2026-09-20** | **技术上最合**（Cubism 2–5、lip-sync、Parallel Motion），但要求 pixi **8.13.1+**，我们是 **8.5.2** → 需升 pixi（跨 minor，风险） |
| `easy-live2d`（`Panzer-Jack`） | 1.0.0 | MIT | deps: `@pixi/sound ^6.0.1` | **219** | 2026-09-24 | 声明的卖点就是"让 Live2D 像 pixi sprite 一样好控"；但版本号 1.0.0、无 peerDeps 声明 pixi 版本 |
| `pixi-live2d-display-mulmotion`（`K-bai` 分支） | 0.5.0-mm-6 | MIT | **`^7.0.0`** | — | 2025-08-08 | 不用：PixiJS 7 |

**关键技术判断**：

1. **Cubism Core 必须单独引入**。所有渲染器都要求外部提供 `live2dcubismcore.min.js`（Cubism 4/5）或 `live2d.min.js`（Cubism 2.1）。官方直接链接 `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` 被 `pixi-live2d-display` README 明确标注「**quite unreliable, don't use it in production**」。→ 生产形态需自己持有该文件 → 触发 §1.5 / R3 的分发条件。
   **但注意**：§6.1 D4 的**内部验证**可以直接引用官方 CDN 或本地临时文件——**不发布就不构成分发**（C20）。
2. **PixiJS v8 生态的 Live2D 支持是"社区补丁级"，不是"产品级"**。4 个 v8 候选里 stars 最高 81、最好的要求 pixi 8.13.1+、最低的只有 2★。**没有一个是我们敢承诺"长期稳定"的依赖。**
3. **"支持 Live2D 所需的渲染管线改造"比想象小**：我们的 Pixi 8.5.2 已有完整渲染管线，Live2D 只是一个 `Container` 挂进去。**技术集成成本不高，代价全在许可与素材生产。**

### 2.3 素材生产链（比渲染更贵）

| 环节 | 现实 |
|---|---|
| 建模 | 需要 Cubism Editor（PRO 订阅或 42 天试用）+ 绑定师（真正的手艺活）。一个可动的、有表情多动作的角色模型在业界是 **周级到月级**工作 |
| 拆件 | 原画必须**分层**（头发/眼白/瞳/眉/嘴/身体/服装/饰品…），我们现有素材是**成品帧图**（`walk-left-01.png` 等），**没有分层源文件** → 要么重新出分层稿，要么做不了 Live2D |
| 动作 | 走路/坐下/说话/情绪都需在 Editor 里绑参数，不是"一次生成" |
| 口型 | 需 `ParamMouthOpenY` 等参数 + 音频驱动（MotionSync 是**另一个专有 Core**，Proprietary 协议同时覆盖） |

**这是本评估里最容易被低估的成本**：我们现有资产（帧图 + `anchors.json`）**在物理上无法转成 Live2D 模型**，必须重新制作分层原画 + 绑定。这不是"要不要试点"的问题，是"要不要投一笔美术钱"的问题。**这也是"暂缓"的第一条真实理由：不是许可不允许，而是我们在本阶段没有分层原画资产。**

---

## 3. 现有资产层与许可现状（读我方代码，不是猜）

| 项 | 实测 |
|---|---|
| 角色包目录 | `resources/characters/deepseek-default/`：`LICENSE` / `NOTICE` / `manifest.json` / `animation/{anchors,animations}.json` / `assets/{animations,expressions}` / `validation-report.json` |
| LICENSE 原文要点 | 「官方占位资产 — 鲸鱼娘 Whale Girl（**Layer 2**）」「版权独立声明，**不随核心代码 MIT 许可证**」「适用角色：鲸鱼娘 · 黑鲸总控 / 鲸鱼娘 · 蓝鲸员工」「图形基底：自绘简化鲸鱼轮廓（官方形象规划见 PREDEV §7.7：官方角色 = **约稿买断**，一套设定稿 + 双配色）」「**禁止**：将本资产用于 DshCockpit 以外的发行物」「第三方素材：本包**不含**任何社区角色素材（如女仆鲸鱼娘/溟月等，均为 **Layer 3 社区包**，仅可由用户自行安装且 manifest 需声明原作者与其许可证）」 |
| manifest.json | `author` / `license` 字段都存在，`runtimeCompatibility.schema: 1`，`schemaVersion: 1`，`version: 1.1.0` |
| 校验器 | `src/office/runtime/validate-character-pack.js`：必需字段列表里含 **`'license'`**（第 34 行），第 257 行**强制要求** `author` 与 `license` 非空 |
| 安装器 | `src/office/runtime/character-pack-installer.js`：ZIP 安全（拒穿越/绝对路径/symlink/加密条目/zip bomb，CRC-32 全验），`maxFileCount 512` / `maxFileBytes 4MiB` / `maxTotalBytes 64MiB` / `maxZipRatio 200`；`discovered → validated → installed → active` 生命周期 |

**关键判断**：我方**已经有一套正确的资产授权模型**（Layer 2 官方 / Layer 3 社区包，manifest 强制 author + license）。**这套模型正是"Expandable Application"的物理对应物**——它能加载不特定数量的外部模型。所以 §1.3 的判定不是理论推演，是**读我们自己的 LICENSE 与安装器代码得出的**。

**但要精确**：这套模型说明"我们具备显著扩展性"，**不等于**"我们已经构成 Expandable Application"。后者还需要"分发 + 含 Live2D 内容"这个事实。**当前我们零 Live2D 内容，所以当前毫无疑问不构成。** 风险出现在"未来接入 Live2D 并分发"这一步——这正是 Deferred 要管理的东西。

**同时这也是"想让 Live2D 进来就必须改产品"的准确含义**：要规避 Expandable，就得**拆掉 Layer 3 社区包机制**，而那是我们角色生态的基础。**所以正确的路线不是"改产品迁就许可"（这条路不做），也不是"永久放弃"（这个结论过强），而是"在许可条件与产品形态之间找到可接受的交点，否则保持 Deferred"。**

---

## 4. 替代路线核查（不接 Live2D 时的选项）

| 方案 | 许可 | 状态 | 判定 |
|---|---|---|---|
| **A. 现有帧动画 + 程序化叠加（当前路线）** | 自有 / MIT | **已落地**（P3.0/P3.1/P3.3/P3.4 per `OFFICE-V3-VISUAL-PLAN`） | **当前唯一正确路线** |
| **B. 视频直用（VP9-alpha WebM + `video.currentTime` 驱动）** | 自有素材 | 已调研（`2026-09-27-dsh-pet-teardown.md` 全文拆解），未实现 | **POC 候选**：Chromium 原生支持 VP9-alpha，Electron 无成本；比 Live2D 便宜一个数量级 |
| **C. Inochi2D** | **BSD-2-Clause**（`inochi2d` 1,832★，pushed 2026-10-03；`inochi-creator` 1,261★，pushed **2025-06-16**） | 开源 puppet 绑骨，**无专利/专有运行时问题** | **观察项**：许可证干净是最大优势，但 web 运行时生态薄弱（本次搜索未找到成熟的 web runtime 仓库）、Creator 已一年未更新。→ 若将来真要"参数驱动 2.5D"，优先重新评估它而不是 Live2D |
| **D. 自建骨骼（Spine/Rive 类）** | 各异 | — | **不做**：`2026-09-27-animation-tooling-landscape.md` §161 已确立「重度 3D/蒙皮/绑骨路线整体不学」 |

**Inochi2D 的意义**：它证明「参数驱动 2.5D」这条**技术路线**可以不碰 Live2D 的许可证。所以"我们需要 2.5D" 与 "我们需要 Live2D" 是两件事——**前者可能成立，后者当前不成立。**

---

## 5. 集成边界：如果将来一定要做 Live2D（记录，不执行）

按风险从低到高排列四条路径：

| 路径 | 做法 | 谁承担许可 | 我们能分发什么 | 评价 |
|---|---|---|---|---|
| **P-0 书面定性（**前置动作，新增**）** | 打样一个具体形态描述（模型来源、是否可加载外部模型、是否一个 title 多作品），走 Live2D 官方咨询/申请通道，取得**书面**定性意见 | 无（咨询阶段） | 无 | **所有其他路径的前置条件**。上一版直接跳到"签约 / 放弃"，跳过了"先问清楚"这一步 |
| **P-1 用户自装渲染器** | DshCockpit **不含**任何 Cubism 代码与模型；提供"角色渲染器注册点"。用户自己下载 Cubism SDK + 模型，放进 `userData/renderers/` | **用户自己**与 Live2D 签约（他自己是 Licensee / Publisher，Proprietary §3.1 / §6.5） | 只有接口，不含任何 Live2D 内容 | **唯一确定合规的生产形态**。但用户要自己搞定 SDK 下载 + Editor 授权，体验极差；且我们做注册点 = 为抽象而抽象（现在只有一个实现）→ **当前不做，但保留为 Deferred 的默认回归路径** |
| **P-2 官方签约出版** | 正式申请 Expandable 审查 + 签 Publication License + 交销售报表 + 展示 logo + 上 Showcase | **DshCockpit** 成为 Licensee | 可以分发（含 Redistributable Code，按 §5.2 条件） | **当前成本/对价不成立**：一个还没验证 PMF 的开源桌面项目，去签一个需要收入模型 + 分成 + Showcase 挂牌的协议。**注意：不是"不可能"，是"当前对价不成立"** |
| **P-3 换 Inochi2D** | 用 BSD-2 的 `inochi2d` 做参数驱动 2.5D | 无额外许可义务 | 自由 | **若 POC 证明"参数驱动"确实是用户要的，走这条** |

**明确不做（这些是"不做"而不是"暂缓"，因为它们与我们的铁律冲突而非与许可冲突）**：

- ❌ 把 Cubism 代码**以 MIT 名义**放进 `dist/` 或作为 `dependency`（违反 Proprietary §5.3.2 / Open §5.6）——**这是硬红线，与 Deferred 无关**。
- ❌ 用 `PC2005-cloud/dsh-pet` 的鲸鱼娘素材（CC BY-NC-SA 4.0 + "不可商业化"）。
- ❌ 用 Cubism SDK 的 sample 素材（只能内部评估/培训，§5.5）。
- ❌ 修改 Cubism Core / 反向工程（§6.1 / §6.4）。
- ❌ 对外宣称"支持 Live2D"（商标/误认风险 R7），在许可定性未定之前。

**从"明确不做"改为"暂缓、有条件可做"的一条**：

- ⏸ 在仓库里放 `.moc3` 文件 / 在安装包里放 Redistributable Code —— **上一版把它们列进"永远不做"是过强的**。准确是：**在没有走通 P-0 + P-2 之前不做**；走通后按 §5.2 条件可以随应用分发（`.moc3` 属模型数据，另受 Free Material / Editor 授权约束，需按模型来源单独判断）。

---

## 6. POC 边界（明确表态：当前阶段到底该做什么、不该做什么）

### 6.1 现在**该做**的（成本：≤1 人日，**确定无许可风险**）

| # | 动作 | 产出 | 为什么现在做 |
|---|---|---|---|
| D1 | **把本文件的许可结论 + Deferred 框架登记**（本文；索引归 Lead 同步 `docs/README.md`） | 文档 | 建立"为什么现在不做、什么时候重评"的组织记忆，防止下季度重新从零吵一遍 |
| D2 | **在 `docs/design/character-system.md` 里预留渲染后端接口**（Sprite / Video / **预留 Parametric 位**），**只写接口形状，不写实现** | 设计文档 | 让未来 Inochi2D 或 Live2D 能插入而不改架构；零成本 |
| D3 | **在 `product-principles.md` §1.2 的反模式表里补一条"Live2D 许可陷阱"**（按本版精确表述，写"需先书面定性"而非"绝对禁止"） | 一行 | 把调研结论固化成评审依据 |
| D4 | **技术验证（可选，仅内部）：用 `@jannchie/pixi-live2d-display@1.4.0` 在本机加载一个**免费可分发的** Cubism 示例模型，验证 Pixi 8.5.2 下的帧率与内存** | 一份内部数字 | **合规依据：C20「Not during trial or development」——内部验证不构成 Publish。** 但**产物不得进仓库、不得进安装包、不得截图发布**（截图发布可能构成 Publish，见 R2） |
| D5（新增） | **走 P-0：向 Live2D 官方咨询"我们这种形态是否构成 Expandable Application"** | 一份书面答复（或"无答复"记录） | **这是把 Deferred 变成可决策的唯一低成本动作**：定性未定之前，任何 POC 投入都是在为不确定性付费 |

### 6.2 现在**不该做**的（红线）

| # | 禁止项 | 理由 |
|---|---|---|
| N1 | ❌ 在 `src/` 写任何 Live2D 生产渲染代码 | 一写就要引入 Cubism Core 引用 → 触发 R3 的分发条件；且会把"零技术债"变成"带许可债的代码" |
| N2 | ❌ 把 `@jannchie/pixi-live2d-display` 或任何 Live2D 渲染器加进 `package.json` | 打包即分发（R2/R3） |
| N3 | ❌ 把 `live2dcubismcore.min.js` 放进仓库任何位置 | 我们 MIT + `docs/` 会被第三方 copy；以 MIT 名义分发 = 违反 §5.3.2 / Open §5.6（**这一条是硬红线**） |
| N4 | ❌ 购买/外包 Live2D 模型 | 沉没成本 + 素材归属复杂度 + 触发 Publication License；**在 P-0 定性未定前不得投入** |
| N5 | ❌ 产出任何"可分发的角色素材包"含 Live2D 内容 | **直接 = 我们自己去撞 Expandable Application 的审查门槛** |
| N6 | ❌ 对外宣称"支持 Live2D" | 商标/误认风险（R7）；且承诺了还没取得许可的能力 |
| N7 | ❌ 升级 pixi 到 8.13.1+ 只为试 Live2D | 与 `untitled-pixi-live2d-engine` 耦合，不值得为 POC 动核心依赖 |
| N8 | ❌ 改 Layer 3 社区包机制以规避 Expandable | 拆掉角色生态去迁就许可 = 方向错误（**但注意：这是"不做"，不是"因为许可不允许"**） |

### 6.3 POC 的**通过/否决**判据（如果将来真的开 POC）

**只有同时满足以下六条，POC 才算通过**（第 1 条从"许可路径已定"细化为"已取得书面定性"）：

1. **许可定性已书面确认**：Live2D 书面答复我们属于/不属于 Expandable，以及对应的许可路径。**无书面结论 = 不通过。**（替代上一版的"许可路径已定"——路径可以先假设，定性不能假设）
2. **素材可达**：有**已完成分层 + 已绑定**的模型源文件（不是"打算做"）。
3. **渲染稳定**：Pixi 8.5.2（或明确升级方案）下，办公室同屏 ≥8 角色 ≥30fps，内存增长 <200MB。
4. **不破坏现有资产层**：Layer 2/Layer 3 机制原样保留（即接受 Expandable 判定，不玩文字游戏）。
5. **有可回退开关**：`settings` 里一个开关回到帧动画，且回退后**不丢任何用户数据**。
6. **分发形态已合规**：若含 Redistributable Code，须逐条满足 §5.2.1–5.2.4；若含模型数据，须能追溯到合法的模型制作与分发授权。

**任一条不满足 → 继续走 A（帧 + 程序化），保持 Deferred，并把结论归档。**

---

## 7. 结论（给下一阶段）：Deferred / Re-evaluation

### 7.1 现状判定

**Deferred（暂缓生产接入）**。不是"永久拒绝"，也不是"暂缓 = 等它改好"。准确含义是：

> **在当前四个前置条件（无收入模型 / 无分层原画资产 / 无签约预算 / 无书面许可定性）同时成立时，不启动生产接入。任一条件变化，触发 Re-evaluation。**

### 7.2 三条支撑理由（每条都可独立被推翻）

| # | 理由 | 可被什么推翻 |
|---|---|---|
| **1** | **素材成本**：现有资产是成品帧图，**没有分层源文件**，物理上无法转 Live2D；要做必须重新出分层稿 + 绑定（周级到月级 + 美术预算） | 出现一笔明确的角色美术预算 + 分层稿到位 |
| **2** | **许可成本**：按文义高概率为 Expandable，审查条件要求收入模型 + 分成 + Showcase；免费形态原则上不利（但有 C12 脚注例外） | Live2D 书面定性为**非** Expandable；或书面确认我们属于可获批的免费形态 |
| **3** | **技术依赖**：v8 生态最优候选只 81★、且要求 pixi 8.13.1+（我们 8.5.2）；4 个 v8 候选无一是产品级 | 出现一个 ≥500★、peer pixi ^8.5、活跃维护的渲染器 |

**这三条里，第 1 条与第 2 条是"当前阶段"的判断，第 3 条是"生态"的判断。三者都不是"Live2D 不好"。**

### 7.3 Re-evaluation 触发条件（写死，避免以后拍脑袋）

> 下列**任一**条件成立，即重启 Live2D 评估（不需要全部满足）：
>
> **T1**（许可侧）Live2D 书面答复我们**不构成** Expandable Application；或书面确认免费/开源形态可获批（E2 路径落地）。
> **T2**（资产侧）角色美术进入**约稿买断**阶段，且合同明确包含「分层源文件 + Live2D 演绎权 + 制作方自备合法 Editor 授权」。
> **T3**（产品侧）`OFFICE-V3-VISUAL-PLAN` 的 A 路线（帧 + 程序化）与 B 路线（视频直用）**都被证明到顶**（有量化证据：帧率/表现力/内存任一不达标），且 Inochi2D 路线（P-3）经 POC 被否决。
> **T4**（生态侧）出现 ≥500★、`peerDependencies.pixi.js` 覆盖 `^8.5`、近 6 个月有提交、且 MIT/Apache-2.0 的 v8 渲染器。
> **T5**（商业侧）DshCockpit 出现**可支撑签约的真实收入模型**（P-2 的对价成立）。
>
> **不得因为"技术上很酷"或"竞品有"而提前启动。**

### 7.4 下一阶段的方向（不变）

1. **角色动效继续走 A（现有帧 + 程序化）**；如果 A 到顶，先试 **B（视频直用）**，再考虑 **C（Inochi2D）**。**Live2D 排在最后**，且必须满足 §6.3 六条。
2. **唯一现在要做的动作是"预留 + 定性"**：D2（渲染后端接口留参数驱动位，成本为零）+ **D5（走 P-0 取得书面定性，这是把 Deferred 变成可决策的最低成本动作）**。
3. **保留全部技术研究记录**（本文件 §2/§3/§4、渲染器候选表、素材生产链、替代路线），因为这些是**重评时的现成输入**，不是"已否决项目的存档"。

---

## 8. 待验证 / 无法核实清单

| 项 | 状态 | 原因 |
|---|---|---|
| 我们的具体形态是否被 Live2D 认定为 Expandable Application | **无法核实（需官方书面答复）** | 定义含「significant expandability」门槛 + Live2D 单方裁量；无公开判定标准。**这是本评估最大的不确定项 → D5/P-0** |
| 免费 Expandable 的获批条件（C12 脚注「separately specified conditions」） | **无法核实** | 官方未公开该"另行规定的条件"；只能通过正式申请得知 |
| Pixi 8.5.2 + `@jannchie/pixi-live2d-display@1.4.0` 的真实兼容性 | **未验证** | 未安装（D4 为可选动作，且需自有模型；本次评估为避免污染仓库未执行） |
| Cubism Core 当前版本号与 `RedistributableFiles.txt` 内容 | **无法核实** | 需下载 SDK 包（需接受 EULA 的注册流程）；官方 GitHub 仓库只提交 README/CHANGELOG/LICENSE/RedistributableFiles.txt，本次未逐一抓取（`CubismWebSamples/LICENSE.md` 里也没有 `RedistributableFiles.txt`） |
| Expandable Application 审查的实际通过率 | **无法核实** | Live2D 自述"may not be granted in all cases"，无公开通过率数据 |
| 鲸鱼娘形象的**原始权利人**完整授权链 | **部分核实** | 仅确认 `PC2005-cloud/dsh-pet` README 声明 CC BY-NC-SA 4.0 与"不可商业化"，原型归属 B 站 @上善无形 / @ZipZipPipe；**未与权利人直接核实**。我方现有资产为**自绘占位 + 规划约稿买断**，与社区素材无关 |
| Inochi2D 的 web 运行时成熟度 | **未验证** | GitHub 搜索未返回明确的 web runtime 仓库；`inochi-creator` 已 1 年未更新（pushed 2025-06-16） |
| 我方正式角色稿的授权形态 | **待定（T2 触发点）** | `resources/characters/deepseek-default/LICENSE` 写明"约稿买断后替换本占位资产"；买断合同条款（是否含 Live2D 演绎权）需法务确认 |

---

## 9. 证据索引（2026-11-01 实测 / 条款复核）

**许可原文（全文抓取并逐条复读）**
- Open Software License v1.4（2025-02-03）：https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html
  - 关键：§2.3（出版许可）、§5.6（excluded license）、§7.1/§7.4（**解除 → 销毁**的结构）
- Proprietary Software License v2.1（2025-02-03）：https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
  - 关键：§1.5（Expandable 定义）、§1.6（Publish 定义 + 裁量）、§2.1（出版 + 审批）、§2.2（豁免 + Expandable 除外）、§2.4（SLP）、§4.2（禁令）、§5（**Redistributable Code 的有条件再分发**）、§5.3.2（excluded license）、§6.2/§6.3（禁止行为）、**§8.1（解除权）/§8.4（解除后销毁）**、§8.3（解除不免除索赔）、§12（损害赔偿）、§16（存续）、§17（单方变更）、§15（日本法/东京地裁）
- Free Material License Agreement：https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html
- **SDK Release License（Publication License）页**：https://www.live2d.com/en/sdk/license/
  - 关键原文：**「License only required upon releasing your content. Not during trial or development.」**（Publish 的下界，C20）
- Expandable Applications 专页 + 审查条件 + 费用表 + **免费例外脚注**：https://www.live2d.com/en/sdk/license/expandable/
- SDK 许可总页（「Individuals and Small-Scale Enterprises are exempted … **(except Expandable Application)**」）：https://www.live2d.com/en/sdk/about/
- **VTuber 授权指引（年销 2000 万日元门槛 → 适用 Expandable 计划）**：https://www.live2d.com/en/sdk/license/vtuber-license/
- SDK for Web 下载页（需同时同意 Proprietary + Open 两份协议）：https://www.live2d.com/en/sdk/download/web/
- Editor 下载/授权页：https://www.live2d.com/cubism/download/editor/ （原文为 `/en/cubism/download/editor/`）

**官方仓库**
- `Live2D/CubismWebSamples`：397★，`license.spdx_id: NOASSERTION`，pushed 2026-04-02；**`LICENSE.md` 实测**分列 Cubism SDK Release License / Open Software / Proprietary / Free Material 四段，并列出 8 个免费模型（Haru/Hiyori/Mao/Mark/Natori/Ren/Rice/Wanko）及其逐模型 terms
- `Live2D/CubismWebFramework`：238★，`license.spdx_id: NOASSERTION`，pushed 2026-04-02；`LICENSE.md` 结构同上
- `Live2D/CubismWebMotionSyncComponents`：11★，`license.spdx_id: NOASSERTION`，pushed 2026-10-15

**渲染器（npm + GitHub 实测）**
- `guansss/pixi-live2d-display`：1,516★，MIT，PixiJS 6.x，pushed **2024-08-20**（停更）
- `@jannchie/pixi-live2d-display@1.4.0`：MIT，peer `pixi.js ^8.0.0`，2★，pushed 2026-08-26
- `@naari3/pixi-live2d-display@1.2.5`：MIT，PixiJS 8.x + Cubism 5，6★，pushed 2025-11-30
- `untitled-pixi-live2d-engine@1.4.0`：MIT，peer `pixi.js ^8.13.1` + `@pixi/sound ^6.0.1`，81★，pushed 2026-09-20
- `easy-live2d@1.0.0`（`Panzer-Jack`）：MIT，219★，pushed 2026-09-24
- `pixi-live2d-display-mulmotion@0.5.0-mm-6`：MIT，peer `pixi.js ^7.0.0`（不兼容）

**替代路线**
- `Inochi2D/inochi2d`：1,832★，**BSD-2-Clause**，pushed 2026-10-03
- `Inochi2D/inochi-creator`：1,261★，**BSD-2-Clause**，pushed **2025-06-16**

**我方代码与文档**
- `package.json`（`pixi.js: 8.5.2`，`license: MIT`）
- `LICENSE`（MIT，README 无关）
- `resources/characters/deepseek-default/{LICENSE,NOTICE,manifest.json}`
- `src/office/runtime/validate-character-pack.js`（`license` 为必需字段，第 34/257 行）
- `src/office/runtime/character-pack-installer.js`（ZIP 安全 + 生命周期）
- `src/office/render/pixi-office-renderer.js`（4,673 行，无 Live2D 痕迹）
- `docs/product/product-principles.md`（「Live2D 只做 POC，不进生产」）
- `docs/plans/active/OFFICE-V3-VISUAL-PLAN-2026-10-27.md` §45/§78/§85
- `docs/archive/strategy/2026-09-27-dsh-pet-teardown.md`（视频直用路线拆解）
- `docs/archive/strategy/2026-09-27-animation-tooling-landscape.md` §149/§161
- `PC2005-cloud/dsh-pet` 许可段：https://github.com/PC2005-cloud/dsh-pet （代码 MIT；**素材 CC BY-NC-SA 4.0，"不可以以任何形式商业化"**）
