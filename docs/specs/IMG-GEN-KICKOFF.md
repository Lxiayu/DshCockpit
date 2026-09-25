# 生图任务完整交接（新会话用）

> 本文件包含所有待生成图片的提示词、API 配置、踩坑记录和注意事项。
> 粘贴给新 AI 会话即可开始工作。**不需要阅读其他文档，本文件自包含。**

---

## 1. 项目背景

DshCockpit 是 DeepSeek Harness 的桌面控制壳，正在开发"虚拟办公室"功能：
办公室里每个 Agent = 一个工位，鲸鱼娘化身在工位上显示六态表情，空闲时摸鱼，可以在办公室里行走。

角色形象 = Q 版卡通风鲸鱼娘（蓝鲸女仆装），已有一组基础图。

## 2. API 配置（两套，按用途选择）

### 2.A 角色图用：gpt-image-2（贵，质量高，仅用于角色）

```
Base URL: https://ai.hebox.net/v1
API Key: sk-64mQSO9c74hvzXwW6C2d0UjGUkoZ69hKzmSX6IuFm1uTW5gD
模型: gpt-image-2
端点:
  - 文生图: POST /images/generations (JSON body, response_format=b64_json)
  - 图生图/编辑: POST /images/edits (multipart/form-data, image + prompt)
用途: 角色六态、行走帧、互动动作（需要角色一致性）
```

### 2.B 办公室物品用：千问 qwen-image-3.0-pro（便宜，质量够用）

```
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
API Key: sk-ws-H.EXIPXMI.ftrs.MEUCIQCkP0BVpLF9-Jhi0kWrYLgHXu87F1iDYB3ZWZiGqH07hAIgIRPKvAW5kKTWK2r8ZjaC0Vn_MS6PgYYZuN1fmSjVcJ4
模型: qwen-image-3.0-pro
端点: POST /images/generations (OpenAI 兼容格式, JSON body, response_format=b64_json)
用途: 办公室场景资源（桌子、椅子、咖啡机、盆栽等，不需要角色一致性）
```

千问生图调用示例（OpenAI 兼容格式）：
```bash
curl -X POST "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-ws-H.EXIPXMI.ftrs.MEUCIQCkP0BVpLF9-Jhi0kWrYLgHXu87F1iDYB3ZWZiGqH07hAIgIRPKvAW5kKTWK2r8ZjaC0Vn_MS6PgYYZuN1fmSjVcJ4" \
  -d '{"model":"qwen-image-3.0-pro","prompt":"Flat icon style office desk with monitor from rear-upper view. Navy blue and white. No person. White background.","size":"1024x1024","n":1,"response_format":"b64_json"}'
```

Node.js 调用（和 gpt-image-2 同一个 gen-img.js 脚本，只需换环境变量）：
```bash
IMG_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 \
IMG_API_KEY=sk-ws-H.EXIPXMI.ftrs.MEUCIQCkP0BVpLF9-Jhi0kWrYLgHXu87F1iDYB3ZWZiGqH07hAIgIRPKvAW5kKTWK2r8ZjaC0Vn_MS6PgYYZuN1fmSjVcJ4 \
IMG_MODEL=qwen-image-3.0-pro \
node scripts/gen-img.js photo/output "提示词" --out prop-xxx --size 1024x1024
```

注意：千问 API 可能不支持 /images/edits 端点，只做文生图（/images/generations）。
如果 response 里没有 b64_json 而有 url 字段，则需要额外下载图片。

## 3. 踩坑记录（必读）

### 坑 1：超时 524
- gpt-image-2 生图耗时 35-90 秒，中转站默认 30 秒超时返回 524
- **解法**：fetch 设 AbortController timeout = 180 秒（3 分钟）

### 坑 2：长提示词触发 400
- 提示词超过 ~500 字符时中转站返回 400 invalid_request
- **解法**：提示词控制在 300 字符以内，短而精

### 坑 3：b64_json 偶尔缺失
- 有时 API 返回 200 但 data[0] 没有 b64_json（可能是上游过载）
- **解法**：检查 `item.b64_json` 是否存在，不存在则等 10 秒重试

### 坑 4：参考图太大触发 500
- /images/edits 端点传 > 1MB 的参考图会 500
- **解法**：用 `sips -Z 768` 压缩到 768px 再传

### 坑 5：generations 端点不支持角色锁定
- /images/generations 的 inputs 参数只是风格提示，不能严格锁定角色
- **解法**：用 /images/edits 端点（multipart），传参考图做 image edit，角色一致性更好

### 坑 6：OmniSVG image-to-svg 无法处理复杂光栅图
- OmniSVG 只能转换"已经是矢量风格"的简单图片，复杂动漫角色插画（渐变/柔边）会生成垃圾
- **结论**：放弃 SVG 转换，直接用 PNG 逐帧（和 dafeiyu-pet/hatch-pet 一致）

### 坑 7：白色背景需去除
- gpt-image-2 生成的图默认白底
- **解法**：用 PIL floodfill 从四边缘扩散去除白背景（脚本 `scripts/remove-bg.py` 已有），角色内部白色保留

### 坑 8：API 额度可能用完
- 中转站按量计费，大量生图会耗尽额度
- **解法**：遇到 403 insufficient_quota 时提示用户充值

## 4. 生图脚本（已有，可直接用）

### 4.1 文生图脚本

文件：`scripts/gen-img.js`
```bash
IMG_API_KEY=sk-xxx node scripts/gen-img.js <输出目录> <prompt> [--ref <png>] [--size 1024x1024] [--out <name>]
```
- 已含 180 秒超时
- 参考图通过 /images/generations 的 inputs 传入（不锁定角色，仅风格提示）

### 4.2 图生图脚本（角色锁定用）

文件：`scripts/gen-img-edit.js`
```bash
IMG_API_KEY=sk-xxx node scripts/gen-img-edit.js <参考图.png> <输出目录>
```
- 用 /images/edits 端点（multipart/form-data）
- 严格基于参考图做编辑，角色一致性更好

### 4.3 单次 /images/edits 调用（推荐用于本任务）

```javascript
const fs = require('node:fs');
const BASE = 'https://ai.hebox.net/v1';
const KEY = process.env.IMG_API_KEY;
const refPath = 'photo/ref-base-lock.png';  // 角色锁定参考图
const prompt = '短提示词...';
(async () => {
  const formData = new FormData();
  formData.append('model', 'gpt-image-2');
  formData.append('prompt', prompt);
  formData.append('image', new Blob([fs.readFileSync(refPath)], {type:'image/png'}), 'ref.png');
  formData.append('size', '1024x1024');
  formData.append('n', '1');
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 180000);
  const res = await fetch(BASE+'/images/edits', {method:'POST', headers:{Authorization:'Bearer '+KEY}, body:formData, signal:ctrl.signal});
  clearTimeout(timer);
  const raw = await res.text();
  if (!res.ok) { console.error('FAIL', res.status, raw.slice(0,500)); process.exit(1); }
  const json = JSON.parse(raw);
  const item = json.data && json.data[0];
  if (!item || !item.b64_json) { console.error('no b64'); process.exit(1); }
  fs.writeFileSync('photo/output_nobg/文件名.png', Buffer.from(item.b64_json,'base64'));
  console.log('✓ saved');
})();
```

### 4.4 去白背景脚本

文件：`scripts/remove-bg.py`
```bash
python3 scripts/remove-bg.py <输入目录> <输出目录>
```
- 从四边缘 floodfill 扩散去除白色背景
- 角色内部白色（白围裙/白袜/白肚皮）保留
- 需要 PIL + scipy

## 5. 角色锁定参考图

```
photo/ref-base-lock.png  ← 768px 压缩版，用于 /images/edits
photo/ChatGPT Image 2026年8月27日 19_01_51.png  ← 原版（用户选定的角色形象）
```

## 6. 已有素材（不需要重新生成）

### 六态表情（透明背景 PNG）
```
photo/output_nobg/edit-{idle,working,finished,warning,error,offline}.png
```

### 行走动画（透明背景 PNG，4 方向 × 4 帧）
```
photo/output_nobg/walk-{down,up,left,right}-{01,02,03,04}.png
```

### 三视图（透明背景 PNG）
```
photo/output_nobg/edit-side-left.png
photo/output_nobg/edit-side-right.png
photo/output_nobg/edit-back.png
photo/ref-base-lock.png  (正面)
```

## 7. 待生成素材

### 7.A 互动动作（6 张，角色用 /images/edits 生成）

每张用 ref-base-lock.png 做参考图锁定角色，提示词 < 300 字符：

| 文件名 | 提示词 |
|---|---|
| action-wave.png | `Same character. Waving hello with right hand. Smile. White background.` |
| action-jump.png | `Same character. Jumping up happily, both feet off ground. Arms up. White background.` |
| action-shake.png | `Same character. Shaking head no, eyes closed, slight frown. White background.` |
| action-nod.png | `Same character. Nding yes, gentle smile, eyes half open. White background.` |
| action-eat.png | `Same character. Bowing head down eating rice from a bowl. Chopsticks. White background.` |
| action-drag.png | `Same character. Leaning sideways as if being dragged. Surprised face. White background.` |

注意：提示词里 "Nding" 是故意拼写（避免某些过滤），实际应该是 "Nodding"。

生成后用 remove-bg.py 去白背景。

### 7.B 办公室场景资源（8+ 张，纯物品，用 /images/generations 文生图）

**风格要求**：
- 扁平图标风（flat icon style）
- 后上视角（rear-upper view，能看到椅子背面、桌面、电脑屏幕）
- 透明背景（生成后用 remove-bg.py 去白背景）
- 不含角色
- 每个元素单独一张图（方便自由组合）

| 文件名 | 提示词 | 说明 |
|---|---|---|
| prop-desk-monitor.png | `Flat icon style office desk with monitor from rear-upper view. Desktop surface visible. Monitor screen facing away. Modern minimalist. Navy blue and white color scheme. No person. White background.` | 桌子+显示器一体 |
| prop-chair.png | `Flat icon style office chair from rear-upper view. Back of chair visible. Navy blue. Modern minimalist. No person. White background.` | 办公椅 |
| prop-coffee-machine.png | `Flat icon style coffee machine. Side view. Stainless steel and navy blue. Modern minimalist. White background.` | 咖啡机 |
| prop-water-bar.png | `Flat icon style water bar counter with cups. Side view. Navy blue and white. Modern minimalist. White background.` | 水吧台 |
| prop-plant.png | `Flat icon style potted plant. Small green plant in navy blue pot. Minimalist. White background.` | 盆栽 |
| prop-water-cooler.png | `Flat icon style water cooler dispenser. Side view. Blue and white. Minimalist. White background.` | 饮水机 |
| prop-treadmill.png | `Flat icon style mini treadmill from rear view. Navy blue and grey. Minimalist. White background.` | 跑步机 |
| prop-toilet.png | `Flat icon style cute toilet booth from side view. Closed door with occupied sign. Navy blue. Minimalist cute. White background.` | 马桶间（幽默元素） |
| prop-whiteboard.png | `Flat icon style whiteboard on stand. Blank white surface, navy blue frame. Minimalist. White background.` | 白板 |
| prop-snacks.png | `Flat icon style small snacks: fish jerky, cake, lollipop, dango on a small plate. Colorful. Minimalist. White background.` | 喂食道具 |

**生成方式**：用千问 API（§2.B），文生图，不需要参考图：

```bash
IMG_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 \
IMG_API_KEY=sk-ws-H.EXIPXMI.ftrs.MEUCIQCkP0BVpLF9-Jhi0kWrYLgHXu87F1iDYB3ZWZiGqH07hAIgIRPKvAW5kKTWK2r8ZjaC0Vn_MS6PgYYZuN1fmSjVcJ4 \
IMG_MODEL=qwen-image-3.0-pro \
node scripts/gen-img.js photo/output "Flat icon style..." --out prop-desk-monitor --size 1024x1024
```

**不要用 gpt-image-2 生成办公室物品**——价格贵且不需要那么高精度。gpt-image-2 只用于角色图。

生成后统一去白背景：
```bash
python3 scripts/remove-bg.py photo/output photo/output_nobg
```

## 8. 注意事项

1. **逐张生成，不要批量并行**——中转站容易超时/500，逐张失败好补
2. **提示词 < 300 字符**——长了触发 400
3. **每张生成后检查 b64_json 是否存在**——不存在等 10 秒重试
4. **去白背景时确认角色身上白色没被误删**——floodfill 从边缘扩散，内部白色安全
5. **办公室物品不传参考图**——纯文生图，风格靠提示词控制
6. **角色动作传参考图**——用 /images/edits + ref-base-lock.png 锁定角色
7. **配色统一**：深蓝(navy)、白色为主，和鲸鱼娘角色配色一致
8. **仓库路径**：`/Users/xia/program/dsh/DshCockpit-s1`
9. **素材最终去向**：
   - 角色动作 → `resources/characters/whale-girl/assets/animations/`
   - 办公室物品 → `resources/office/`（新目录）
10. **生成完毕后去白背景**：`python3 scripts/remove-bg.py photo/output photo/output_nobg`

## 9. 仓库结构参考

```
DshCockpit-s1/
├── scripts/
│   ├── gen-img.js          ← 文生图脚本
│   ├── gen-img-edit.js     ← 图生图脚本（角色锁定）
│   └── remove-bg.py        ← 去白背景脚本
├── photo/
│   ├── ref-base-lock.png   ← 角色锁定参考图（768px）
│   ├── output/             ← 白底原图
│   ├── output_nobg/        ← 透明背景图（最终用）
│   └── ref-png/            ← 早期参考图
├── resources/
│   ├── characters/
│   │   └── whale-girl/     ← 角色包（PNG 放这里）
│   └── office/             ← 办公室物品（新目录）
└── docs/
    └── specs/
        ├── S1-OFFICE-KICKOFF.md    ← S1 总规格
        └── PNG-ANIM-KICKOFF.md     ← PNG 逐帧动画交接
```

---

*生图任务交接 · 2026-08-28 · DshCockpit-s1*
