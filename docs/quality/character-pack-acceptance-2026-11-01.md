# 角色包导入验收报告（Issue #24，2026-11-01）

> 探针：`scripts/acceptance/settings-packs-acceptance.js`（7/7 通过）
> 证据：[`acceptance/settings-packs-acceptance-2026-11-01.json`](acceptance/settings-packs-acceptance-2026-11-01.json)
> 离线守卫：`test/settings-packs-acceptance.test.js`（10 项）

## 0. 一句话结论

**7/7 通过。** 更重要的是：真机验收抓到了**两个离线测试全绿**的缺陷，
其中一个是**既有缺陷**（与角色包无关，但影响所有 office 设置）。

## 1. 交付内容（三个阶段）

| 阶段 | 交付 | 测试 |
|---|---|---|
| 1 | `character-pack-manager.js` —— 两套布局之间的翻译层 | 29 项（安装器 mock） |
| 2 | `office-pack-actions.js` + IPC 接线 | 16 项（payload/分派/架构约束） |
| 3 | 设置页 UI + `shell:packs-*` 桥接 | 13 项（i18n/preload↔IPC/错误分层） |

## 2. 第一性原理：为什么这不是"缺一根线"

Issue 原本写"安装器实现完整但零调用方"。核实的真正障碍是**两处架构不匹配**：

| 项目 | 现有渲染链 | 安装器 |
|---|---|---|
| packsRoot | `resources/characters`（打包后**只读**） | 需要可写目录 |
| 布局 | `<root>/<packId>/manifest.json` | `<root>/<packId>/versions/<ver>/` |
| 激活 | `settings.characterPackId` | `<root>/active.json` |

直接接线会得到两种坏结果之一：往 resources 写（打包失败+升级丢包），
或只写 settings 不装磁盘（选了个不存在的包）。

所以需要一层**布局翻译 + 激活契约**，不是一根线。

### 激活契约（唯一作者）

- **安装器**是磁盘事实的作者（active.json + 版本目录）
- **settings.characterPackId** 是用户意图的作者
- 不一致时以意图为准；意图不可用则回退内置并**如实上报**

顺序：先 `activate()`（磁盘），成功了才 `writeSelected()`（意图）。
反过来会造成"设置说 A、磁盘上没有 A"，重启后静默回退。

## 3. 真机验收抓到的两个缺陷

### 缺陷 1：office 页对用户不可达（既有缺陷）

```js
const PAGES = ['general', 'cost', 'runtime', ...];  // 漏了 'office'
```

`#page-office` 的 DOM 存在、导航按钮也存在，但 `showPage('office')`
判定不在白名单后**直接回退到 general**。

**后果**：office 设置（睡眠/速度/隐私模式）在此之前对用户完全不可达。
这与角色包无关，是一个长期存在的缺陷。

**为什么离线测试看不到**：它只查"字符串是否存在"。
页面的**可到达性**是运行时属性。

### 缺陷 2：flex-basis 在 column 容器里变成 height

`.setting-info` 带 `flex: 1 1 220px`。放进 `flex-direction: column`
容器后，`flex-basis: 220px` 变成了**高度**，撑出 220px 空白。

**只有截图能看出来**——DOM 断言全绿（rows=2、徽章正确、按钮存在），
视觉上一大块空白。这是本项目第一次靠"看图"发现的 bug。

修复：`.packs-section > .setting-info { flex: 0 0 auto; }`

## 4. 探针的 7 项检查

| # | 检查 | 为什么必要 |
|---|---|---|
| 1 | office 页真的 active | 白名单回归保护 |
| 2 | 列表真的被填充（rows≥2） | 只查元素存在会漏"在但没渲染" |
| 3 | 内置徽章 | 用户要能区分可卸载与否 |
| 4 | 使用中徽章 | 用户要知道当前用哪个 |
| 5 | 两个导入入口存在 | — |
| 6 | i18n 真解析（看**可见文本**） | `data-i18n` 属性本身含 key，整串匹配会误报 |
| 7 | 截图存证 | 前两个缺陷都只能靠它发现 |

## 5. 验收标准对照（Issue #24 原文）

| 标准 | 状态 |
|---|---|
| 能从设置页导入文件夹与 .zip | ✅ 两个按钮 + 主进程对话框 |
| 校验失败原因逐条可见 | ✅ `{title, hint, detail}` 三层，detail 默认折叠 |
| 导入成功后切换生效，重启后仍生效 | ✅ 写入 `settings.characterPackId`（持久化） |
| 卸载后回落内置，不出现空场景 | ✅ `resolveActive()` 永不返回空 |
| 恶意 zip 被拒且有明确提示 | ✅ 9 个错误码各有可操作提示 |
| 安装器本身零改动 | ✅ 依赖注入，导出面未变（有测试断言） |

**未做**：真实包文件的端到端导入（需要用户提供一个真实角色包）。
当前验证到"IPCs 往返 + UI 渲染 + 错误呈现"，安装器本身有 18 项既有测试。

## 6. 复现方式

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/settings-packs-acceptance.js
```

证据落在 `$TMPDIR/settings-packs-acceptance/`。
