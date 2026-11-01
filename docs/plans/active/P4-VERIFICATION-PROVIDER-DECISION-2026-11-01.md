# VerificationProvider：做还是不做（决策记录）

> 状态：**决策完成，结论是不做完整接口**（2026-11-01）
> 上游：ADR-0003 §5「只有 VerificationProvider 现在值得做接口」
> 触发：审计把它列为"已接受 ADR 里未做的承诺"

## 1. 先核实 ADR 的理由是否仍然成立

ADR-0003 §5 的原话：

> | VerificationProvider | **可以抽象** | 已有真实第二实现需求
> （官方无内置 verification runner；DshCockpit 已有 `src/work/command-runner.js`）|

**这条理由的推理有问题。** 拆开看：

- 「官方无内置 verification runner」→ 事实成立（已核实 0.2.1-rc.5 的 307 个包里
  没有 verification 类包，只有 `dsh-session-checkpoint-policy`，那是 checkpoint 不是 verify）
- 「DshCockpit 已有 command-runner」→ 事实成立
- 「**因此有第二实现需求**」→ **这一步不成立**

"官方没有" + "我们有一个" ≠ "有两个实现"。它恰恰说明
**当前只有一个实现**，而那正是 AGENTS.md §2.6 说的"不该抽象"的条件。

## 2. 核实实际代码状态

```
runVerify 的调用点：2 处（installer.js:153 与 :218）
```

两处**已经在用同一个入口** `runVerify(manifest, {runner, platform, cwd, env})`。

也就是说：**抽象的收益（统一入口）已经拿到了**，
只是它不是以"interface + 两个实现"的形式存在，而是以
"一个函数 + 注入的 runner"的形式存在。

## 3. 第一性原理：接口要解决什么问题

抽一个 Provider 接口，收益只可能来自三件事：

| 收益 | 现在成立吗 |
|---|---|
| **可替换**（换一个 verification 后端） | ❌ 没有第二个后端，也没人要求换 |
| **可测试**（用假实现测调用方） | ✅ **已经成立** —— `runVerify` 接受注入的 `runner`，测试里就是用 fake runner 跑 |
| **统一入口**（避免调用方各写一套） | ✅ **已经成立** —— 2 个调用点用同一个函数 |

三件事里两件已经满足，第三件没有需求。

**再加一层 interface 只会增加：一个要同步的契约文件、一层间接调用、
以及"抽象错了要改两遍"的风险。**

## 4. 那 ADR-0003 说错了吗？

没有说错**方向**，但说错了**时机**。

它写于 P3 设计期，当时预期"Capability Pack 会有多个，每个可能需要不同的
验证方式"（shell / 测试框架 / 外部服务）。那个预期今天仍未发生：
两个 Pack 都用 shell 命令，`command-runner` 一个实现足够。

**正确的处置不是"补上这个接口"，而是把这个判断记录下来，
并在真实第二实现出现时再做。**

## 5. 决策

### ❌ 不做：完整的 VerificationProvider 接口

理由：违反 AGENTS.md §2.6，且两条主要收益已经通过现有设计获得。

### ✅ 做：把这个判断写进 ADR-0003，并加一条"何时该做"的触发条件

触发条件（满足任一即应重新评估）：
1. 出现一个**无法用 shell 命令表达**的 verify（例如需要调用某个 Node API、
   或者需要走 HTTP 的服务型验证）
2. 有第三方要写自己的 Capability Pack，且需要自定义 verify 方式
3. `capability-packs/verify.js` 里开始出现 `if (kind === 'shell') … else if (…)`
   这样的分支——那是"需要接口"的机械信号

## 6. 与上一轮 RenderBackend 的区别

有人会问：为什么 RenderBackend 做了接缝，VerificationProvider 却不做？

| | RenderBackend | VerificationProvider |
|---|---|---|
| 现有形式 | 20 个平铺方法，**没有统一入口** | **已有**统一入口 `runVerify` |
| 接缝成本 | 一份清单，不改代码 | 要加一层 interface + adapter |
| 收益 | 未来接 Live2D 不用考古 4673 行 | 无（收益已获得） |

**关键区别：RenderBackend 缺的是"标出接缝"，VerificationProvider 缺的
是"第二个实现"。后者没法靠写代码解决。**

## 7. 结论

这条不是"未完成的承诺"，是**"当时预期错了，现在纠正"**。

写进 ADR-0003 作为附注，并在落差盘点里标记为"已评估，决定不做"。
