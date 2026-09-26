# 发布流程（v0.4.0 起）

发布由 **GitHub Actions** 完成：推 `v*` tag → 自动构建 → 自动创建 Release。本地只做验证与打 tag。

## 1. 发版前（本地）

```bash
npm test                     # 全量单元测试（1514 项）——CI 不再跑测试，本地这一步是唯一门禁
npm run build                # 可选：本地出包，跑一遍产物闸门（verify-dist）
```

确认三处版本一致：`package.json` 的 `version`（当前 `0.4.0`）、`runtimeVersion`（内置运行时，当前 `0.1.5-rc.2`）、
`.github/release-body.md`（发布正文，只写「本版新增/修改/性能」）。

## 2. 打 tag 并推送（触发构建）

```bash
git tag -a v0.4.1 -m "v0.4.1 — 一句话主题"      # tag 注释会出现在仓库的 tag 列表里
git push origin master --follow-tags            # 推 master 与 tag；tag 触发 release-mac / release-win
```

> 若 tag 已推过、需要改内容：`git tag -d <tag> && git tag -a <tag> -m … && git push --force origin <tag>`。
> 强制推 tag 会**重跑构建**并覆盖 Release 资产，属预期行为。

## 3. CI 做什么（`release-mac.yml` / `release-win.yml`）

1. `npm install` → `scripts/prepare-runtime.js --version $runtimeVersion`（有缓存，冷装约 10~20 分钟）
2. `scripts/build.js --mac|--win … --publish never`
3. **产物闸门**：`verify-dist`（asar 内创作块必须为 0 / 生产表面清单齐备 / 条目数上限）+ `e2e-smoke`
   （打包产物冷启动 → 等 boot URL → 探 HTTP 200）
4. 通过后 `softprops/action-gh-release` 创建/更新 Release，正文取 `.github/release-body.md`

失败排查：`gh run list` → `gh run view <id> --log-failed`。冒烟失败时日志会打印打包产物的壳日志
（含运行时版本、DSH_HOME、退出码），据此判断是运行时没起来还是产物缺件。

## 4. 发布后

- 下载 Windows / macOS 产物做真机验证（Windows 清单见 `docs/strategy/2026-09-24-windows-perf-audit.md` 的 V1–V10）
- 应用内自动更新：安装版走 `latest.yml` / `latest-mac.yml`（Release 资产里必须包含这两个文件与 blockmap）

## 5. 注意

- **未签名**：Windows 首次安装会有 SmartScreen 提示，macOS 首次打开需右键「打开」。证书就绪后填 `CSC_LINK` 等 secrets 即可。
- **内置运行时**以 `package.json.runtimeVersion` 为准；本机若已安装更新版本，壳会优先使用本机版本。
- 单元测试不在发布流水线内；定时 `upstream-compat` 会跑测试并**邮件汇报**结果，不阻塞发布。
