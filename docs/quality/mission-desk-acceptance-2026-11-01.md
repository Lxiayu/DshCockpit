# Mission Desk 真机验收报告（2026-11-01）

> 脚本：`scripts/acceptance/mission-desk-acceptance.js`
> 结果：[`acceptance/mission-desk-acceptance-2026-11-01.json`](acceptance/mission-desk-acceptance-2026-11-01.json)
> 离线守卫：`test/mission-desk-acceptance.test.js`（13 项）

## 0. 一句话结论

**10/10 通过。** P1 第一次获得运行级证据——此前所有 Mission 测试都是
源码字符串与纯函数断言，从未验证过窗口能否真的打开、DOM 是否真的正确。

## 1. 为什么必须做真机验收

离线测试覆盖的是"代码写对了吗"，真机验的是"用户看到的是对的吗"。
两者的差距在 P1 尤其大，因为 Mission Desk 的核心设计约束**全部是视觉/结构性的**：

| 设计约束（domain-model §2.1.1） | 离线能测吗 | 真机能测吗 |
|---|---|---|
| Active / Focused / Running 三轴分开 | ❌ 只能查源码有 `class: 'badge '` | ✅ 查 DOM 里是否真是两个节点 |
| 不可用时如实说"不可用" | ❌ 只能查字符串存在 | ✅ 查渲染出的文本 |
| sandbox/contextIsolation 生效 | ❌ 只能查配置项写了 | ✅ 查 renderer 里有没有 node 全局 |
| will-navigate 拦截 | ❌ 只能查有没有监听 | ✅ 真的尝试导航看是否被挡 |

## 2. 实测结果

| # | 检查项 | 实际值 |
|---|---|---|
| 1 | 页面渲染 header | `Mission Desk` |
| 2 | preload 桥 `dshShell.mission` | `function` |
| 3 | 列表渲染 Mission | `cards=1` |
| 4 | **三个轴分开** | badge=`active` / live=`实时状态不可用`，**sameNode=false** |
| 5 | **诚实降级** | 显示"实时状态不可用" |
| 6 | 不谎报"未运行" | 不含"无 Agent" |
| 7 | focused 不是 Mission 状态 | `.badge.focused` count=0 |
| 8 | renderer 无 node 全局 | `true` |
| 9 | 导航被拦截 | blocked=1，protocol 仍是 `file:` |
| 10 | 截图存证 | 2080×1384 |

### 第 4 项是最关键的一条

截图确认：`active` 徽章与 `实时状态不可用` 是**两个独立的 DOM 元素**，
并且并排显示时视觉上也不混淆。

这正是 domain-model §2.1.1 的硬要求：
> Active（这个项目还在推进）≠ Running（此刻有 Agent 在跑）

如果把两者合并成一个徽章，用户会把"我在看这个"误读成"这个在跑"。
这个错误在代码 review 时几乎看不出来（都是一个 span + 一个 class），
只有真机截图能证明它没发生。

### 第 5/6 项是诚实性要求

Mission Core 不拥有 `running`/`awaitingUser`（那是 Harness 的事实）。
没有 Harness 快照时，UI 必须说"**实时状态不可用**"，
而不是显示一个灰点让人以为"确定没在跑"。

- **不可用** = 我们现在读不到
- **没有在跑** = 我们读到了，值是 false

这两件事在界面上必须能被区分，否则用户会基于错误信息做决定。

## 3. 过程中发现的环境陷阱

首次运行报：

```
TypeError: Cannot read properties of undefined (reading 'whenReady')
```

根因**不是脚本错误**，而是环境里 `ELECTRON_RUN_AS_NODE=1` 让 Electron
跑在 node 模式，于是 `require('electron')` 返回路径字符串而不是 API。

正确调用方式：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-acceptance.js
```

> 记录这一点是因为它的报错信息完全不指向根因——
> 下一个人遇到同样问题不必再查一遍。

## 4. 离线守卫（为什么真机脚本也要有测试）

真机脚本不在 CI 里跑，所以它坏了**没人会知道**。三类失败模式可以离线静态检查：

| 失败模式 | 后果 | 守卫 |
|---|---|---|
| 引用的 HTML/preload 路径写错 | 真机跑才报错，且报错指向 loadFile | 路径存在性断言 |
| DOM 选择器与页面结构脱节 | 真机全 FAIL，根因是"探针过时" | 选择器 ↔ 页面结构交叉断言 |
| 偷偷写用户真实工作区 | 用"验证"污染生产，比没验证更糟 | 断言用 mkdtemp + 不用 homedir |

`test/mission-desk-acceptance.test.js` 13 项覆盖这三类，加上：
退出码反映成败、截图必须存证、每个检查走 record() 而非 ad-hoc log、
探针不得挪进 `test/`（会因无图形会话让 CI 挂掉）。

## 5. 复现方式

```bash
# 需要图形会话（CI 无）
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
  scripts/acceptance/mission-desk-acceptance.js

# 证据落在
$TMPDIR/mission-desk-acceptance/{results.json, mission-desk.png}
```

## 6. 结论对 P1 状态的影响

| 项 | 之前 | 现在 |
|---|---|---|
| Mission Core 纯逻辑 | ✅ 113 项离线测试 | 不变 |
| IPC 接线 | ✅ 27+6 项离线测试 | 不变 |
| UI 源码契约 | ✅ 20 项静态断言 | 不变 |
| **UI 真机渲染** | ❌ **未验证** | ✅ **10/10 通过** |
| Brief 同步 | ✅ 21 项离线测试 | 不变 |
| Brief 在真会话中生效 | ❌ 未验证 | ⚠️ 需真实模型调用（#23） |

**P1 现在只剩一项未验证：Brief 是否真的被下次会话的 Agent 读到。**
那需要驱动一次真实会话（Issue #23），不阻塞 Mission Core 本身。
