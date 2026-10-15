# Provider 与许可政策 — studio 模块

> 读者：(a) 配置本工具的人；(b) 后续阶段实现"model↔key 对应强制"的代码（计划落在 `studio/lib/providers.js`）。
> 定位：studio 的 provider 注册表形状 + 密钥政策 + 许可红线 + 成本记账规则。
> 与 `studio/docs/provenance.md` 的分工：provenance 答"这帧从哪来、能不能复现"；本文答"由哪个 provider、哪把 key、什么许可产出"。
> 当前 de-facto 配置 = `scripts/gen-img.js` / `gen-img-edit.js` / `gen-frames.js` / `gen-props.js` / `gen-actions.js` 的 env 读法 + `~/.dsh-secrets.env`（本地，不入库）。
> **红线：本文以及任何日志/导出中，都不出现 key 的值。** 只出现 env var 名或 secrets 文件键名（引用形式）。生成本文时读到的任何字面密钥，一律以 `[REDACTED]` 代替，不记录、不复述、不存哈希以外的任何派生值。

---

## 0. TL;DR

1. **三类 provider class**：`image`（生图/改图）、`video`（文/图生视频）、`llm`（提示词配方与编排）。`image` 已实盘两条路（hebox 中转、DashScope 千问），`video` 一条路（DashScope MiniMax-H3），`llm` **尚无注册条目**（`待确认`）。
2. **key 只从两处来**：进程 env var，或 `~/.dsh-secrets.env`（本地 secrets 文件，仓库外）。两者都取不到 → 拒绝执行，不进网络。
3. **model↔key 必须对应**：`gpt-*` → hebox，`qwen-*` → DashScope，`gemini-*` → tu-zi，`MiniMax-H3` → DashScope。对不上就拒，错误码 `PROVIDER_MODEL_KEY_MISMATCH`。
4. **许可红线**：主链只走 Apache-2.0 商用安全件（Qwen-Image-Edit、Wan2.2-Animate）；FLUX dev/Kontext dev 非商用、MimicMotion/MusePose 随 SVD 受限，只作可选并在 UI 与 provenance 标注。
5. **成本一律"以官网当日为准"**：本仓文档未给出任何 studio 路线的价格数字，本文不编造；接入时按"当日官网 + 抓取日期"记账。

---

## 1. Provider classes 与 registry 形状

### 1.1 三条 class

| class | 干什么 | 当前状态 |
|---|---|---|
| `image` | 文生图 / 图生图编辑 / 网格切片源 | 实盘使用（角色帧、办公室道具） |
| `video` | 文生/图生视频（行走视频 → 抠像 → 逐帧） | 实盘使用过一次（b-plan 行走视频） |
| `llm` | 动作节拍提示词配方、布局草稿、编排决策 | **未注册**：`baseURL`/`model`/key 全部 `待确认`（需求证据：`2026-09-27-one-image-to-asset-set-research.md` 方向 2、方向 7） |

### 1.2 注册条目字段（`studio/lib/providers.js` 的契约）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 稳定标识，如 `hebox-gpt-image-2`；日志与 provenance 用这个，不用 key |
| `name` | string | 是 | 人读名字，如 `hebox relay (OpenAI-compatible)` |
| `class` | `'llm'\|'image'\|'video'` | 是 | 决定 params 模板走哪一套 |
| `baseURL` | string | 是 | 不含 key；未知写 `待确认`，**不猜** |
| `model` | string | 是 | 模型 id；冲突时以覆盖表为准（§2） |
| `keyRef` | string | 是 | **引用形式**：`env:IMG_GPT2_API_KEY` 或 `file:~/.dsh-secrets.env#IMG_GPT2_API_KEY`。绝不放值 |
| `keyAliases` | string[] | 否 | 同一 provider 允许的其他 key 名（含 `file:` 形式），用于 R1 判定 |
| `auth` | object | 是 | `{ header:'Authorization', scheme:'Bearer' }` 或 `{ header:'x-goog-api-key', scheme:'' }` |
| `endpoints` | string[] | 是 | 该 provider 实际支持的路径，如 `['/images/edits','/images/generations']` |
| `params` | object | 是 | 参数模板（见 §1.3），空对象表示沿用调用方默认 |
| `timeoutMs` | number | 是 | 单次调用超时 |
| `retries` | object | 是 | `{ attempts, backoffMs }` |
| `costNote` | string | 是 | 记账口径 + 当日价格来源（§6） |
| `license` | object | 是 | `{ component, baseModel, commercial, evidence }`——见 §4 |

### 1.3 `params` 模板字段（按 class）

| class | 模板字段 | 默认值依据 |
|---|---|---|
| `image` | `size`（`1024x1024` / DashScope 侧改写为 `1024*1024`）、`n`、`response_format:'b64_json'`、`inputs[]`（身份参考，仅风格提示）、`editRefs[]`（`/images/edits` multipart） | `scripts/gen-img.js:47-53`、`scripts/gen-props.js:65`、`scripts/gen-frames.js:316-331` |
| `image` | `promptLimit: 300`（字符）、`refMaxPx: 768`（`sips -Z 768` 压缩） | `scripts/gen-frames.js:29,266-269`；`docs/specs/IMG-GEN-KICKOFF.md` §3 坑 2/坑 4 |
| `video` | `durationSec: 6.5`、`resolution:'1440x1440'`、`watermark:false`、`async:true`（任务轮询）、`fps:24` | `photo/video-matting-kit/上走重跑提示词.md` L3；`任务书-视频抠像.md` §0 |
| `llm` | `temperature`、`maxTokens`、`system` | `待确认`（尚无注册条目） |

### 1.4 注册表示例（占位值，不含任何真实 key）

```js
// studio/lib/providers.js —— registry 形状示例（值为占位符）
const REGISTRY = [
  {
    id: 'hebox-gpt-image-2',
    name: 'hebox relay (OpenAI-compatible)',
    class: 'image',
    baseURL: 'https://ai.hebox.net/v1',
    model: 'gpt-image-2',
    keyRef: 'env:IMG_GPT2_API_KEY',
    keyAliases: ['env:IMG_API_KEY', 'file:~/.dsh-secrets.env#IMG_GPT2_API_KEY'],
    auth: { header: 'Authorization', scheme: 'Bearer' },
    endpoints: ['/images/generations', '/images/edits'],
    params: { size: '1024x1024', n: 1, response_format: 'b64_json', promptLimit: 300, refMaxPx: 768 },
    timeoutMs: 180000,
    retries: { attempts: 2, backoffMs: 10000 },
    costNote: '角色专用，贵；额度以中转站当日为准',
    license: { component: '中转站服务条款', baseModel: 'gpt-image-2（上游许可待确认）', commercial: 'unverified', evidence: 'docs/specs/IMG-GEN-KICKOFF.md §2.A' },
  },
  {
    id: 'dashscope-qwen-image',
    name: 'DashScope Qwen（原生多模态端点）',
    class: 'image',
    baseURL: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-image-edit',
    keyRef: 'env:IMG_QWEN_API_KEY',
    keyAliases: ['file:~/.dsh-secrets.env#IMG_QWEN_API_KEY'],
    auth: { header: 'Authorization', scheme: 'Bearer' },
    endpoints: ['/services/aigc/multimodal-generation/generation'],
    params: { size: '1024*1024', contentOrder: '[images..., text]' },
    timeoutMs: 180000,
    retries: { attempts: 2, backoffMs: 10000 },
    costNote: '办公室道具用，便宜；价格以官网当日为准',
    license: { component: 'DashScope 服务条款', baseModel: 'Qwen-Image-Edit（开放权重 Apache-2.0）', commercial: 'verify-per-site', evidence: 'IMG-GEN-KICKOFF.md §2.B + research.md §④.1' },
  },
  {
    id: 'dashscope-minimax-h3',
    name: 'DashScope MiniMax-H3（视频）',
    class: 'video',
    baseURL: '待确认',
    model: 'MiniMax-H3',
    keyRef: 'env:IMG_QWEN_API_KEY',
    keyAliases: [],
    auth: { header: 'Authorization', scheme: 'Bearer' },
    endpoints: ['待确认'],
    params: { durationSec: 6.5, resolution: '1440x1440', watermark: false, async: true, fps: 24 },
    timeoutMs: 180000,
    retries: { attempts: 2, backoffMs: 10000 },
    costNote: '异步任务轮询，按次/按秒计费口径待确认',
    license: { component: 'DashScope 服务条款', baseModel: 'MiniMax-H3（许可待确认）', commercial: 'unverified', evidence: 'photo/video-matting-kit/上走重跑提示词.md L3' },
  },
];
```

---

## 2. 当前 model ↔ key 对应表（含证据）

| model 模式 / id | provider | baseURL | key 来源（名，非值） | 端点 | 证据 |
|---|---|---|---|---|---|
| `gpt-image-2`（`gpt-*`） | hebox 中转 | `https://ai.hebox.net/v1` | `IMG_API_KEY`（脚本默认）/ `IMG_GPT2_API_KEY`（gen-frames 前缀）/ `IMG_BASE`、`IMG_MODEL` | `/images/generations`、`/images/edits` | `scripts/gen-img.js:18-20`；`scripts/gen-img-edit.js:15-17`；`scripts/gen-actions.js:15-17`；`scripts/gen-frames.js:258-260`；`docs/specs/IMG-GEN-KICKOFF.md` §2.A |
| `qwen-image-3.0-pro`（`qwen-*`） | DashScope 千问 | OpenAI 兼容：`https://dashscope.aliyuncs.com/compatible-mode/v1`；原生：`https://dashscope.aliyuncs.com/api/v1` | `IMG_API_KEY` + `IMG_MODEL`（`gen-props.js`）/ `IMG_QWEN_API_KEY`、`IMG_QWEN_BASE_URL`、`IMG_QWEN_MODEL`（gen-frames） | 原生 `/services/aigc/multimodal-generation/generation`；兼容模式 `/images/generations` | `scripts/gen-props.js:11-19`；`docs/specs/IMG-GEN-KICKOFF.md` §2.B；`scripts/gen-frames.js:334`（compatible-mode → api/v1 改写） |
| `qwen-image-edit` | DashScope 千问 | 同上（原生） | 同上 | 原生多模态端点 | `scripts/gen-frames.js:468`（`--provider dashscope` 时默认锁死此 model）；`test/office-gen-frames.test.js:93-98` |
| `gemini-*` | tu-zi 中转 | `待确认`（`NANOBANANA_BASE_URL`，未在仓库固化） | `NANOBANANA_API_KEY` / `NANOBANANA_MODEL` | `{root}/v1beta/models/{model}:generateContent` | `scripts/gen-frames.js:273`（注释"tu-zi gemini 原生"）、`:283`、`:290`、`:465`（`--provider tuzi` → `NANOBANANA`）。**默认 model id 不在仓库中，`待确认`** |
| `MiniMax-H3` | DashScope（视频） | `待确认`（仓库无视频生成脚本；按 DashScope 原生 api/v1 推定，未核验） | `待确认`（视频路线未在脚本中固化 env 名） | `待确认`（异步任务 + 轮询） | `photo/video-matting-kit/上走重跑提示词.md` L3（"生成路径：DashScope MiniMax-H3，规格沿用：时长 6.5s、1440×1440（2K）、watermark=false、异步任务轮询"）；`任务书-视频抠像.md` §0（"MiniMax-H3 生成"）、§2（"在 DashScope 重制"）；`photo/video-test/walk-*-minimax-h3-2k.mp4` 文件名 |

**读表须知**

- `qwen-*` 的**两套 baseURL 并存**是事实不是笔误：OpenAI 兼容模式（`compatible-mode/v1`，`IMG-GEN-KICKOFF.md` §2.B）与原生多模端点（`api/v1`，`gen-props.js:11`）。千问"可能不支持 `/images/edits` 端点，只做文生图"（`IMG-GEN-KICKOFF.md` §2 末注）——注册表里 DashScope 图像条目不列 `/images/edits`。
- 超出上表的任何组合（例如用 DashScope 的 key 调 hebox 的 baseURL）= 未注册组合，按 §3 R1 拒。
- key 归属只能由 **keyRef 名字**判定，不能由 key 字面前缀判定：hebox 与 DashScope 的 key 都是 `sk-` 起头（`IMG-GEN-KICKOFF.md` §2.A/§2.B），前缀无区分度。
- `llm` class 的对应行**暂缺**（无注册条目、无 env 约定），配置时按同规则补：`env:<NAME>_API_KEY` + `_BASE_URL` + `_MODEL` 三件套，落 `~/.dsh-secrets.env`。

---

## 3. Enforcement rules（后续阶段在 `studio/lib/providers.js` 实现）

### 3.0 检查顺序（顺序即语义）

```
resolveProviderEntry(input)
  1. leak 预检（R3）        ← 最早：在把 key 塞进任何 header/body 之前
  2. model → provider 解析（R1a）  未知前缀 → PROVIDER_MODEL_UNREGISTERED
  3. keyRef → 值解析（R2）         取不到/空白/占位 → PROVIDER_KEY_MISSING
  4. provider ↔ key 名对应（R1b）
  5. 组装请求 → 才允许 fetch
```

错误对象统一形状（绝不含 key 值）：

```js
{ ok: false, code: 'PROVIDER_MODEL_KEY_MISMATCH',
  message: 'model "gpt-image-2" 属于 provider hebox，但 key 来源属于 dashscope',
  detail: { model, modelProvider, provider, keyRef, keyFingerprint: 'sk-6…(48) sha256:1a2b3c4d' } }
```

### 3.1 `PROVIDER_MODEL_KEY_MISMATCH` —— 模型用错了 provider 的 key

触发条件（满足任一即拒，拒绝时机在**发网之前**）：

| # | 条件 | 例子 |
|---|---|---|
| a | 条目声明的 `provider` ≠ 由 model 前缀/覆盖表推出的 provider | `model:'gpt-image-2'` 但条目挂在 dashscope 下 |
| b | 解析出的 key **来源名**不在该 provider 的 `keyAliases`（含 `env:`/`file:` 形式）集合内 | 拿着 `IMG_QWEN_API_KEY` 去跑 `gpt-image-2` |
| c | 同一次调用里出现两个 provider 的 key（例如同时给了 `IMG_GPT2_API_KEY` 与 `IMG_QWEN_API_KEY`） | 环境脏了/复制粘贴错了 |

判定用的**解析表**（与 §2 同源，代码里就是这张表）：

```
MODEL_PREFIX_PROVIDER = {
  'gpt-':     'hebox',
  'qwen-':    'dashscope',
  'gemini-':  'tuzi',
  'minimax':  'dashscope',
  'MiniMax-H3': 'dashscope',   // 精确覆盖，优先于前缀
}
PROVIDER_KEY_NAMES = {
  hebox:    ['IMG_API_KEY', 'IMG_GPT2_API_KEY'],
  dashscope:['IMG_API_KEY', 'IMG_QWEN_API_KEY'],
  tuzi:     ['NANOBANANA_API_KEY'],
}
```

注意 `IMG_API_KEY` 是**共享别名**（`gen-img.js`/`gen-props.js` 都读它）：单凭这个名字判不出 provider，所以 R1 的真实判据是 **provider + key 名 + model 三者的联合一致性**，而不是某一个字段。名字撞车时按"model 推出的 provider"为准，并在 warning 里提示"`IMG_API_KEY` 是共享名，建议改用带 provider 前缀的形式"。

### 3.2 `PROVIDER_KEY_MISSING` —— 选中 provider 没有 key

- 触发：`keyRef`（及其 `keyAliases`）在进程 env 与 `~/.dsh-secrets.env` 里都取不到；或取到的值是空白、`sk-xxx`、`<...>`、`changeme` 之类的占位符。
- 拒绝时机：任何网络调用之前；脚本退出码非 0，stderr 给指引（`gen-frames.js:261` 的现有做法可沿用）。
- 报错只含 **keyRef 名 + secrets 文件路径模式**，例：`no API key: set IMG_QWEN_API_KEY or fill ~/.dsh-secrets.env#IMG_QWEN_API_KEY`。
- 不静默降级：**不允许**"缺 key 就换个 provider 试试"——那正是错配的温床；要么显式换 provider 并重跑全部检查，要么失败。

### 3.3 `PROVIDER_KEY_LEAK_SHAPE` —— key 出现在请求体/日志/导出里

- 触发：命中下列任一模式（在**请求体、header dump、日志行、`.params.json`、导出 HTML/截图文本、错误对象**里）。
- 拒绝时机：网络调用**之前**（pre-flight 扫描请求体与待打印文本），命中即拒；日志/导出侧则是"拒绝写入该行/该文件"。
- 报错只给**位置 + 指纹**（哪个字段、第几行、命中模式名、`sha256` 前 8 位），绝不给原值。

| 模式名 | 正则（示意） | 说明 |
|---|---|---|
| `sk-key` | `sk-[A-Za-z0-9_\-]{8,}` | 本仓两家中转的 key 都是这个形状 |
| `bearer` | `Bearer\s+\S{8,}` | header 里允许出现，但不允许被打印/落盘 |
| `token-kv` | `(?i)\b(api[-_]?key|token)\s*[:=]\s*\S{8,}` | JSON body / env dump / 配置文本 |
| `goog-header` | `(?i)x-goog-api-key\s*[:=]\s*\S{8,}` | `gen-frames.js:290` 用的 header |
| `cookie` | `(?i)^(set-)?cookie\s*:` | 整行即拒 |

配套的**指纹格式**（允许打印的唯一形态）：`<前4位>…(<长度>) sha256:<前8位hex>`；长度不足 8 位时只打长度。指纹本身可以进日志、进 provenance、进报错。

### 3.4 边界情形（写实现时容易漏的）

1. **key 只能以两种身份存在**：请求 header（调用瞬间）与指纹（其余一切地方）。body 里出现 key 形状 → 直接 `PROVIDER_KEY_LEAK_SHAPE`。
2. **响应回显**：上游 4xx/5xx 常把请求体回显在 `raw` 里（`gen-img.js:74` 之类会把 `raw.slice(0,1000)` 写进 Error message）。Error message 也必须过 R3 扫描后再 throw。
3. **provenance 落盘**：`.params.json` 记 `provider`/`model`/`promptHash`/`seed`（`studio/docs/provenance.md` §3），**不记 key、不记 Authorization header**；`recordParams` 之前对整条 JSON 跑一次 R3。
4. **占位符豁免**：测试夹具里的 `sk-test-1234` 之类应通过"占位符清单"显式豁免，而不是关掉扫描。
5. **shell 历史/CI**：`~/.dsh-secrets.env` 不入库、不进 `git log`；CI 里用 env 注入，不写进 workflow 文件。

---

## 4. 许可判定（每模型 / 每路线）

**规则（主链口径）**：主链只走**商用安全（Apache-2.0）**路线；非商用/受限模型只能作为**可选**路线，且必须在 UI 与 provenance 里显式标注。provenance 中**组件许可**与**底模许可**分开两条记录（SD 系尤其如此：IP-Adapter Apache-2.0，底模另带 OpenRAIL 条款）。`commercial` 取值：`commercial-safe` / `non-commercial` / `restricted` / `verify-per-site` / `unverified`。

| 模型 / 路线 | 许可 | 商用判定 | 证据（文档） | 置信度 |
|---|---|---|---|---|
| Qwen-Image-Edit | Apache-2.0（20B，2511 版多图编辑/多视角） | **commercial-safe**，主链默认 | `2026-09-27-one-image-to-asset-set-research.md` §TL;DR-1、§方向1、§④.1 | 高（2026-09-27 多源核验） |
| Wan2.2-Animate | Apache-2.0（14B，animation/replacement 双模式） | **commercial-safe**，动作主链默认 | 同上 §TL;DR-2、§方向2、§④.1 | 高 |
| FLUX.1 [dev] / Kontext [dev] | 非商用（dev 权重） | **non-commercial**：禁止商用；商用以 BFL API/企业授权另计 | 同上 §TL;DR-1、§方向1、§④.1 | 高 |
| MimicMotion / MusePose | 随 SVD 底模条款受限 | **restricted**：商用前必读 LICENSE/NOTICE；默认选 Wan2.2-Animate | 同上 §方向2、§④.1 | 高 |
| SD 系底模（SD1.5/SDXL）+ IP-Adapter/ControlNet | OpenRAIL / OpenRAIL++（允许商用但带使用限制条款）；组件 Apache-2.0 | **restricted**：可商用但须分别记录组件与底模许可 | 同上 §方向1、§方向8、§④.1 | 中高 |
| dsh-pet（peer 项目） | 代码 MIT；素材/提示词/源视频"允许开源使用，禁止商用" | 代码 MIT 可学可商用；**素材与提示词禁商用**，只学结构不搬内容 | `2026-09-27-dsh-pet-teardown.md` §0、§2.6、§⑤-6 | 高 |
| PixelLab / Retro Diffusion / AutoSprite | 以官网当日为准 | **verify-per-site**：接入前逐个复核商用条款与输出归属 | research.md §方向1、§方向8、§④.1 | 未核（文档明确声明未核验） |
| 豆包 / Kling / Sora（视频生成平台） | 以官网当日为准 | **verify-per-site**：商用条款与输出归属落地前逐个核 | research.md §④.1、§方向2 | 未核 |
| `gpt-image-2`（hebox 中转） | 中转站服务条款；上游模型许可未记录 | **unverified**：中转代理的上游许可与输出归属需问中转站；本仓无任何许可证据 | `docs/specs/IMG-GEN-KICKOFF.md` §2.A（只给配置，无许可信息） | 未核 |
| `qwen-image-3.0-pro` / `qwen-image-edit`（DashScope API） | 开放权重 Apache-2.0（Qwen-Image-Edit 模型卡）；**API 服务条款另行计算** | 权重层 commercial-safe；服务层 **verify-per-site**——两条都要记进 provenance | research.md §TL;DR-1/§④.1（"Qwen/Wan/PixelLab 商用条款需落地前复核"）+ `IMG-GEN-KICKOFF.md` §2.B | 权重层高 / 服务层未核 |
| `MiniMax-H3`（DashScope 视频） | 本仓无任何许可记录 | **unverified** | `photo/video-matting-kit/任务书-视频抠像.md` §0（只说"MiniMax-H3 生成"） | 未核 |
| `gemini-*`（tu-zi 中转） | 本仓无任何许可记录 | **unverified** | `scripts/gen-frames.js:273`（只有协议注释） | 未核 |

**两条必须写进实现的派生规则**

1. **UI 标注**：`commercial ∈ {non-commercial, restricted, unverified}` 的模型，在选择器/任务卡片上显示许可标签与"仅供实验/不可进发布包"水印；`commercial-safe` 才允许出现在发布链（action-publisher）的默认路由里。
2. **provenance 双记录**：每条 generation 记录写 `license: { component, baseModel, commercial, evidence, checkedOn }`——组件许可与底模许可各一条，缺一条就标 `unverified`，不猜。
3. **成果版权话术**：纯 prompt 产出在美国不受版权保护（US Copyright Office Part 2, 2025-01；research.md §④.2）。产品文案不得承诺"生成资产归用户所有版权"，只承诺"记录人类编排/修改的证据链"。

---

## 5. 密钥处理政策

1. **来源只有两处**：进程 env var；`~/.dsh-secrets.env`（仓库外的本地 secrets 文件，`gen-frames.js:252-257` 的读法：正则按行取 `<KEY>=(.*)`，取不到再回落 `process.env`）。
2. **命名约定**：`<PROVIDER>_API_KEY` / `_BASE_URL` / `_MODEL` 三件套；`IMG_API_KEY`/`IMG_MODEL`/`IMG_BASE` 是历史共享名（`gen-img.js:18-20`、`gen-props.js:17-19`），新代码一律用带 provider 前缀的形式（`IMG_GPT2_*`、`IMG_QWEN_*`、`NANOBANANA_*`）。
3. **绝不**：提交进 git；写进任何 `docs/**`、`scripts/**`、`src/**`、`studio/**` 的文件；打进 npm 包/发行版；进日志、进 `.params.json`、进导出文件、进错误信息、进 issue/邮件正文。
4. **打印规则**：永远不打 key 本体，只打指纹 `<前4位>…(<长度>) sha256:<前8位hex>`（§3.3）。本文写作时读到的任何字面密钥以 `[REDACTED]` 代替。
5. **导出扫描**：任何"导出一批素材/一个报告/一个 HTML 播放器"的出口，都过一遍 §3.3 的五条模式，命中 `PROVIDER_KEY_LEAK_SHAPE` 即拒绝该次导出。
6. **`docs/specs/IMG-GEN-KICKOFF.md`**：gitignored（`.gitignore:19`），**必须保持 ignored**。该文件历史上以明文记录过两套配置（本文不引用其 key 值，一律 `[REDACTED]`）——它是本地配置参考，不是登记册：正式配置应落在 `~/.dsh-secrets.env` + 本文 §1.2 的注册表里。若要把它推送到任何远端，先确认 key 已轮换。
7. **轮换**：任何出现在聊天记录/终端回显/截图里的 key，视为已泄露，轮换之；`~/.dsh-secrets.env` 权限保持 `600`。

---

## 6. 成本

**记账规则**：价格/额度随时间变动，一律**以官网当日为准**；每条 provider 条目在接入当天把"当日官网数字 + 抓取日期 + 来源 URL"写进 `costNote` 与 provenance 记录，不写继承数。下表是骨架——**没有一行有真实数字**，因为本仓文档未给出任何 studio 路线的定价（不编造）。

| 路线 | provider / model | 计价口径 | 当日价格 | 抓取日期 | 证据 |
|---|---|---|---|---|---|
| 角色六态/互动帧 | hebox / `gpt-image-2` | 按次（贵） | per official site（中转站） | 待填 | `IMG-GEN-KICKOFF.md` §2.A（"贵，质量高，仅用于角色"）、§3 坑 8（403 insufficient_quota 按量计费） |
| 办公室道具 | DashScope / `qwen-image-3.0-pro` | 按次（便宜） | per official site | 待填 | `IMG-GEN-KICKOFF.md` §2.B（"便宜，质量够用"） |
| 角色帧（frames 链） | DashScope / `qwen-image-edit`；tu-zi / `gemini-*`；hebox / `gpt-image-2` | 按次 | per official site | 待填 | `scripts/gen-frames.js:464-468`（三路可选） |
| 行走视频 | DashScope / `MiniMax-H3` | 待确认（异步任务，按次或按秒） | per official site | 待填 | `photo/video-matting-kit/上走重跑提示词.md` L3（规格，无价格） |
| LLM 配方/编排 | `待确认` | 订阅制 or 按 token | per official site | 待填 | research.md §方向2/§方向7（"现有 LLM 订阅"） |

文档中出现的唯一具体价格是 **Move One $48/月（180 credits）**（`2026-09-27-animation-tooling-landscape.md` 方向 5），那是 3D 动捕参照、**不是 studio 路线**，仅作为"有数字就必须带出处与日期"的范例保留。QC/打包/归一化/一致性检查均为本地轻量运算，无外部费用（research.md §④.5）。

---

## 7. 待确认 / 未核验清单（实现前必须补齐）

| # | 事项 | 现状 | 需要谁确认 |
|---|---|---|---|
| 1 | tu-zi 的 `baseURL` 与默认 `gemini-*` model id | 只在 `~/.dsh-secrets.env` 里，仓库无记录 → `待确认` | 配置者（读本地 secrets，不外传） |
| 2 | `MiniMax-H3` 视频路的 baseURL / endpoint / env key 名 | 仓库无视频生成脚本，只能从任务书文档推定 → `待确认` | 配置者 |
| 3 | `llm` class 的 provider 条目（baseURL/model/keyRef） | 无注册条目 → `待确认` | 配置者 |
| 4 | hebox 中转、`gpt-image-2` 的上游许可与输出归属 | 无任何许可证据 → `unverified` | 中转站方 |
| 5 | DashScope API 服务层商用条款（区别于 Qwen 开放权重 Apache-2.0） | research.md 明示"落地前复核" → `verify-per-site` | 官网当日 |
| 6 | PixelLab / Retro Diffusion / AutoSprite / 豆包 / Kling / Sora 商用条款与输出归属 | 文档明确未核验 → `verify-per-site` | 官网当日 |
| 7 | 视频分辨率口径不一致 | `任务书-视频抠像.md` §0 写 1408×1408，`上走重跑提示词.md` L3 写 1440×1440（2K） | 实测 ffprobe（源 mp4 在 `photo/video-matting-kit/videos/`） |
| 8 | `IMG_API_KEY` 共享名归属 | 三套脚本共用，无法单凭名字判 provider | 已用 §3.1 三要素联合判定绕过；长期建议改名 |
