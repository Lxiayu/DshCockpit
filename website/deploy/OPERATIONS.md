# 服务器运维（2026-09-26）

站点：http://dshcockpit.site （同时支持 www）；当前 HTTP 已部署。HTTPS 尚未配置，服务器访问 GitHub 和 Let's Encrypt 超时，维护者已要求暂缓处理出站网络。

## 路径

- 网页：`/www/wwwroot/dshcockpit.site`
- 安装包：`/www/wwwroot/dshcockpit.site/downloads/<tag>/<asset>`
- 版本索引：`/www/wwwroot/dshcockpit.site/downloads/index.json`
- 同步脚本：`/opt/dshcockpit/sync-releases.py`
- Nginx：`/www/server/panel/vhost/nginx/dshcockpit.site.conf`
- 部署前备份：`/var/backups/dshcockpit/site-before-20260926.tgz`、`nginx-before-20260926.conf`

## 网络恢复后启用同步

```bash
sudo systemctl start dsh-release-sync.service
sudo journalctl -u dsh-release-sync.service -n 100 --no-pager
# 首次同步成功后再开启每小时自动检查
sudo systemctl enable --now dsh-release-sync.timer
```

手动同步命令就是 `sudo systemctl start dsh-release-sync.service`。默认最近 5 个稳定 Release；排除草稿、预发布、slim、blockmap 和 mac 自动更新 ZIP，保存 Windows EXE／便携 ZIP 与 macOS DMG。按 GitHub 文件大小和可用的 SHA256 校验，下载完整后才替换版本索引；失败保留旧索引。旧文件不自动删除，便于下载续传与回退，应定期检查磁盘。

如后续配置可信出站代理，在 `/etc/dsh-release-sync.env` 写入 HTTPS_PROXY；该文件若含凭据应设为 root:root 600。无需 GitHub Token 访问公开仓库。当前 timer 已安装但未启用，尚未验证真实拉包成功链路。

## HTTPS

确认服务器可访问证书服务后再申请证书，配置 Nginx 443、自动续期与 HTTP 跳转。certbot 已安装，尚未申请证书；不要在证书有效前强制跳转 HTTPS。

## 更新网站

本地 `npm run build --prefix website`，只上传 `website/dist/` 内容。保留服务器的 downloads/，不要用无排除规则的目录清空或 rsync --delete 覆盖安装包。

## 上线检查

检查首页、视频 Range 请求、二维码、手机布局、版本索引和真实安装包下载。交流群图片标注 2026-10-03 前有效，需要及时更新。
