# Debug Session: win-jank (Windows v0.2.0 严重卡顿)

**Session ID**: `win-jank`
**Status**: [RESOLVED]
**Started**: 2026-08-15

## 症状

- 刚运行程序就卡顿
- 输入框输入卡顿，甚至无法切换输入法
- 开始对话页面未响应
- 点击设置卡一会才打开
- 设置页滚动卡

## 证据收集

插桩日志（5 个会话）：
```
[perf] poll: collect=18863ms(5sess) push=0ms cost=5ms
[perf] poll: collect=13984ms(5sess) push=1ms cost=1ms
[perf] poll: collect=47ms(5sess) push=1ms cost=0ms  (缓存命中后)
```

## 根因

**H1 确认**：token poll 的 collect 耗时 14-19 秒（首次无缓存）。虽然 collect 是 async，但 parseSessionLog 内部用 `fs.readFileSync` + zstd 解压 + 逐行 JSON.parse 全部同步，阻塞主线程。

附加问题（代码审查发现）：
- P2: dirSizeMB 同步递归 + 每文件 statSync（设置页打开时触发）
- P3: bestNodeBin/nodeCandidates 无缓存，每次 spawn where.exe
- P4: searchSessions 全程同步

## 修复

| # | 文件 | 修复 |
|---|------|------|
| P1 | token-stats.js | parseSessionLogAsync 用 fsp.readFile/fsp.stat 真正异步 |
| P2 | main.js | dirSizeMBAsync + storageInfo/storageCleanup 改 async |
| P3 | main.js | bestNodeBin/nodeCandidates 模块级缓存 |
| P4 | session-search.js | searchSessions 改 async + fsp |

## 验证

- 42/42 单元测试通过
- 语法检查通过
