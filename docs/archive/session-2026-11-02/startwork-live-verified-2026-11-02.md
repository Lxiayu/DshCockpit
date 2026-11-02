# 「交给团队」真机上线验证（2026-11-02 10:52）

> **这是第一次在真实 App 里、由真实用户点击触发的端到端验证。**

## 0. 结果

**整条链路打通了。**

用户在 Mission Desk 里点击「交给团队」后：

```
02:52:03.933 [mission] startWork: ensureSession runtimeUrl=yes
02:52:03.956 [mission] startWork: prompt runtimeUrl=yes sid=session-a4648c len=140
```

**23 毫秒内完成**：创建会话 → 把 140 字符的任务送达。

## 1. 绑定确认

`~/.dsh/mission-sessions.json`：

```json
{
  "version": 1,
  "sessions": {
    "mis-b437fbdd068d": {
      "sessionId": "session-a4648cbc-167e-40fa-80d7-b6827c818b1e",
      "boundAtMs": 1793587923956
    }
  }
}
```

**`mis-b437fbdd068d` 正是用户截图里那个「调研现在关于 Agent team 的相关前沿内容」的 Mission。**

它现在真的绑定到了一个正在工作的 Harness 会话。

## 2. Agent 真的在干活

日志显示密集的 assistant 流式产出：

```
02:52:28  assistant-stream end (session-): 3 ended, 575 chunk(s)
02:52:50  assistant-stream end (session-): 5 ended, 926 chunk(s)
02:52:54  assistant-stream end (session-): 6 ended, 1138 chunk(s)
02:52:58  assistant-stream end (session-): 7 ended, 1400 chunk(s)
02:53:02  assistant-stream end (session-): 8 ended, 2044 chunk(s)
02:53:10  assistant-stream end (session-): 9 ended, 2164 chunk(s)
```

**2164 个 chunk，9 轮 assistant 输出。** 这不是"消息被接收"，
是 Agent 真的在做调研任务。

## 3. 为什么这个验证不可替代

| 验证层级 | 能证明什么 | 不能证明什么 |
|---|---|---|
| 单元测试 | 参数校验、逻辑分支 | 真实 runtime 行为 |
| UI fixture 探针 | 按钮存在、提示显示 | 后端真的接通 |
| 隔离 runtime 自检 | 协议可用、Agent 能动 | App 里的接线对不对 |
| **真机用户点击** | **整条链路** | — |

三层缺一不可。**今天这次是最后一层。**

## 4. 用户现在实际能看到的

```
1. 创建 Mission「调研 Agent team 相关前沿内容」
2. 在「交给团队」写一句话，点按钮
3. 看到「已交给团队，还没有完成的轮次。」
4. 几秒后（自动刷新）看到「已执行 1 轮 · 3 步」
5. 继续自动刷新 → 「已执行 2 轮 · 8 步」+ Agent 原话预览
6. 点「在 Harness 中查看这个 Mission 的执行 →」看完整内容
7. 切回 Mission，进度继续自动更新
```

**从"不知道下一步做什么"到"能看到团队正在为这个 Mission 工作并读它的回复"。**

## 5. 一个发现：workspace 为空时回退到 home

`settings.effective().workspace` 为空时，绑定文件写到 `~/.dsh/`。

**这是既有行为**（`workspaceDirOf: () => settings.effective().workspace || os.homedir()`），
不是这次引入的。但它意味着：**用户没设置 workspace 时，Mission 数据落在 home 下**。

这不是 bug，但值得记下来——如果将来要做"项目级 Mission 隔离"，
需要先让用户明确选择 workspace。

## 6. 现在的位置

### 已经能做的（用户视角）

| 能力 | 状态 |
|---|---|
| 创建 Mission 并记录目标/边界/决策/发现/假设/证据 | ✅ |
| **把工作交给团队并真的启动 Agent** | ✅ **今天打通** |
| **看到执行进度自动更新** | ✅ |
| **看到 Agent 的回复预览** | ✅ |
| 跳转 Harness 看完整执行 | ✅ |
| 待办两层分类（决策 vs 提醒） | ✅ |
| 团队任务 + 阻塞关系（启用 team profile 时） | ✅ |
| plan-review 折叠审阅 | ✅ |

### 还不能做的

| 缺口 | 影响 |
|---|---|
| Agent 产出**不会自动变成 Deliverable** | 用户得手动登记产物 |
| 进度**只显示最后一轮** | 多轮历史要切 Harness |
| 一个 Mission **只能绑一个会话** | 长期项目受限 |
| Work Receipt 状态机 | 无法标记"已验收" |

## 7. 下一步建议

**最该做的**：把 Agent 的产出**自动变成 Mission 里的 Deliverable**。

理由：现在 Agent 干完活，Mission 里只有一句预览。
用户还是要自己去登记产物。这是"回写"的最后一步。

但它需要先决定：**怎么判断"这次产出算不算一个交付物"？**
——这又回到 Work Receipt 的判定权问题。
