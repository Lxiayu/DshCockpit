# 发布到 GitHub（便携 zip 方案）

**发布物是便携 zip**（大型 Windows 开源项目的通行做法，如 MaaAssistantArknights 的 `MAA-*-win-x64.zip`）：用户下载 → 解压 → 双击根目录的 `DshCockpit.exe` 即用。无需安装器、无需管理员权限、不会被 NSIS 固态压缩卡住。用户也可以从源码启动（README 有 `npm start` 说明）。

发布后，已安装的壳会在启动/每 4 小时自动检查更新（electron-updater 读取 GitHub Releases 的 `latest.yml`），展示更新说明并提供「立即重启」。

## 前置

1. 一个 GitHub 仓库（如 `dsh-cockpit`）；
2. 一个 **Personal Access Token**，权限勾选 `repo`（[生成 PAT](https://github.com/settings/tokens) 或 `gh auth login`）；
3. 本机可访问 GitHub。

## 首次发布（Windows 便携 zip）

```powershell
# 1. 创建仓库（用 gh CLI，或网页新建后跳过）
gh repo create dsh-cockpit --public --description "DshCockpit — DeepSeek Harness desktop shell (portable)"

# 2. 设置发布目标 + Token（electron-builder.yml 用环境变量读取，无需改配置）
$env:DSH_REPO_OWNER = "<你的 GitHub 用户名>"
$env:DSH_REPO_NAME = "dsh-cockpit"
$env:GH_TOKEN      = "ghp_xxx"   # 或先执行 gh auth login

# 3. 生成内置运行时种子（打包前执行一次；已存在则跳过）
node scripts/prepare-runtime.js

# 4. 构建并发布（上传 zip + latest.yml 到 GitHub Releases）
cd dsh-cockpit
npm run publish:win
```

发布成功后 Release 页会有 `v0.1.0`：
- `DshCockpit-0.1.0-win-x64.zip`（便携包，解压即用）
- `latest.yml` + `*.zip.blockmap`（electron-updater 更新源）

## 后续版本更新

改 `package.json` 的 `version`（如 `0.1.1`）→ 重新执行 `scripts/prepare-runtime.js`（如需随包更新内置运行时版本）→ `npm run publish:win` → 已装壳自动收到更新。

## 常用命令

| 命令 | 说明 |
|---|---|
| `node scripts/prepare-runtime.js` | 生成 `vendor/runtime/<version>` 内置运行时种子 |
| `npm run build:win` | 构建便携 zip（`dist/DshCockpit-<ver>-win-x64.zip`） |
| `npm run build:win:dir` | 只构建未打包目录（快速冒烟） |
| `npm run build:win:nsis` | 按需构建 NSIS 安装器（默认不用，见 electron-builder.yml） |
| `npm run publish:win` | 构建并发布到 GitHub Releases |
| `npm start` | 从源码运行（无需打包） |

## 注意

- **未签名**：exe 会触发 SmartScreen「未知发布者」（社区项目常见，见 README）；要消除需购买 Authenticode 证书（`CSC_LINK` 环境变量）。
- **更新说明**：electron-updater 会把 GitHub Release 正文当作更新说明展示在「立即重启」对话框里，发布时写清变更。
- **版本线**：`version` 必须递增（electron-updater 按 semver 比较）。
- **macOS**：在 macOS 上执行 `npm run publish:mac`（需 Developer ID 签名 + 公证，配置见 electron-builder.yml 注释）。
