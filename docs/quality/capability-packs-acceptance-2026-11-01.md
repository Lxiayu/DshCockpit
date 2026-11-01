# 能力包页面真机验收报告（P3.5，2026-11-01）

> 探针：`scripts/acceptance/capability-packs-acceptance.js`（13/13 通过）
> 证据：[`acceptance/capability-packs-acceptance-2026-11-01.json`](acceptance/capability-packs-acceptance-2026-11-01.json)

## 0. 一句话结论

**13/13 通过。** 真机验收抓到**三个离线测试全绿的缺陷**。

## 1. 起点：又一个"实现完整但零调用方"

```
createCapabilityInstaller  196 行 + 33 项测试
调用方                      0
```

与 Issue #24（角色包安装器）当时的状况完全相同。**库完整 ≠ 用户能用。**

## 2. 三个设计决定

### 2.1 单开一页，不并入「插件」页

| | 插件页管理的 | 能力包 |
|---|---|---|
| 是什么 | **官方 dsh 生态**的扩展 | **本应用**的能力声明 |
| 验证 | 无 | **必须 verify 通过才能装** |

混在一起会让用户以为两者可靠性保证相同。

### 2.2 通道名用完整 `capability-packs`

`shell:packs-*` 已被**角色包**（Issue #24）占用。撞车 =
"卸角色包"和"卸能力包"变成同一件事——数据灾难。
缩写 `cpacks` 虽短，但下一个人看不懂。

### 2.3 页面只呈现，不重新推导

安装成败 → `installer` 的 `code`；四态 → `runVerify` 的 `state`。
页面自己判断会产生"库说 not-verified、页面显示绿色"。

## 3. 真机验收抓到的三个缺陷（离线都全绿）

### 缺陷 1：点击后看不到任何反馈

```js
async function loadCapabilityPacks() {
  capPackStatus('');   // ← 无条件清空
```

安装成功后设置了消息，紧接着 reload 又把它清掉。用户点了按钮，
屏幕一片空白，不知道成功没有。

修正：加 `clearStatus` 参数，安装/卸载后的 reload 保留消息。

### 缺陷 2：i18n key 撞车

能力包与角色包都用了 `packs_desc` / `packs_title` 前缀。角色包先占用，
于是能力包页面显示成了「安装自定义角色外观。包可以是一个文件夹或 .zip。」

修正：能力包统一用 `capPacks_` 前缀。

### 缺陷 3：DOM id 撞车

两页都写了 `id="packs-status"`。`$('packs-status')` 只返回第一个，
于是**能力包的状态写进了角色包页面**。

修正：能力包用 `cap-packs-status`。

### 为什么离线测试全绿

静态断言能查「这个 key 在不在 i18n 表里」，查不到
「两个页面共用一个 DOM id」——那是运行时属性。
这与 P2.3 的白板验收是同一类问题。

## 4. IPC 层的一个参数顺序坑

```js
guard(async (installer, _e2, packId) => ...)
```

`ipcMain.handle` 回调签名是 `(event, ...args)`，而 `guard` 已经剥掉了 event。
于是 `packId` 拿到的是**事件对象**，永远返回 `PACK_ID_INVALID`。

这个 bug 在离线测试里会被 fixture 掩盖（如果 fixture 也传错）。

## 5. 验收结果（13 项）

| # | 检查 | 实际值 |
|---|---|---|
| 1 | 页面可达（PAGES 白名单） | `active=true` |
| 2 | 导航项存在 | ✅ |
| 3-4 | 两个列表各渲染 2 行 | rows=2 / 2 |
| 5 | passed 包显示「通过」 | `工作区验证 @1.0.0通过卸载` |
| 6 | **skipped 包显示「已跳过」且不含「通过」** | `研究报告 @1.0.0已跳过卸载` |
| 7 | 点击安装走 IPC | calls=1 |
| 8 | 安装结果显示 verify 状态 | `已安装（verify 通过） · 通过` |
| 9 | 失败显示**具体原因** | `安装失败: exit code 1` |
| 10 | 点击卸载走 IPC | calls=1 |
| 11 | i18n 无原始 key | title=`能力包` |
| 12 | 截图 | 2560×1630 |
| 13 | 无致命错误 | ✅ |

第 6 条是本项目最重要的纪律：**skipped 绝不能算 passed**。
探针断言 skipped 徽章存在且**不含**「通过」字样。

## 6. 复现方式

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/capability-packs-acceptance.js
```

## 7. 已知偶发

`test/runtime-mux.test.js` 的 `reconnect re-opens every registered stream`
在并发下偶发失败，单独重跑与全量重跑均通过。P2.4 时也出现过同一条。
**如实记录**为已知偶发，不是本次引入。
