# DshCockpit 官网

新版鲸鱼娘主题官网，从 S1 已评审的 `website/design/whale-office` 迁入。主仓库本目录是后续修改与部署的来源。

## 本地与构建

```sh
npm ci
npm run dev
npm run build
npm run preview
```

把 `dist/` 内容部署到静态服务器。公开素材位于 `public/assets/`；Vite 会原样复制，动态帧动画路径不会被打包重命名。下载列表读取服务器 `/downloads/index.json`，由 `deploy/sync-releases.py` 自动生成。

## 服务器部署与下载镜像

HTTP 网站已部署到 dshcockpit.site。详细路径、备份、同步启用命令与当前限制见 [deploy/OPERATIONS.md](deploy/OPERATIONS.md)。

下载区提供最近成功同步的稳定版本、平台选择、发布日期、文件大小与 GitHub 更新说明。只有经过服务器同步的完整安装包会出现在列表中。服务器出站访问 GitHub 超时，因此目前同步服务已安装但暂未启用；页面会显示同步提示。

本地预览没有服务器版本索引时同样显示同步提示，不伪造版本或可下载文件。二维码有效期与图片需一同维护。

## 素材

- Logo：主仓库 `photo/logo.jpg` 的等比例缩小版；原件保留。
- 微信群：用户提供的 `photo/c8b05f9618b8c0840cc8aa9d9c29306d.png`，原样复制。
- office-real.mp4 / webp：主仓库应用实录，12 秒日常巡游与闲聊。
- walk/：S1 `photo/output/b-plan-player.html` 对应的帧序图集，83ms／帧。
- idle / working / idle-lunch / finished：S1 现有角色资源的 WebP 导出。

首屏插画与交互状态展示仍标注概念示意；真实视频独立标注实录。页面包含系统识别、手动选择版本、减少动态效果支持、离屏动画暂停与 ICP 链接。网站当前提供中文页面，中英文项目介绍在根目录 README 中。
