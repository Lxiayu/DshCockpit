# 服务器运维（2026-09-26）

站点：http://dshcockpit.site （同时支持 www）；当前 HTTP 已部署。自有 SSL 证书已安装，服务器内部 HTTPS 校验通过；公网 HTTPS 尚未连通，等待确认云防火墙／安全组 443 入站。服务器访问 GitHub 和 Let's Encrypt 超时。

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

已安装维护者提供的 TrustAsia 证书，覆盖 dshcockpit.site 和 www.dshcockpit.site，证书与私钥公钥匹配。到期时间为 2026-11-17 16:59:59 UTC（北京时间 11 月 18 日 00:59:59），需在到期前更新；当前没有自动续期。

- 证书：`/www/server/panel/vhost/cert/dshcockpit.site/fullchain.pem`
- 私钥：同目录 `privkey.pem`，root 所有，权限 600；不得提交仓库。
- 配置备份：`/var/backups/dshcockpit/nginx-before-tls.conf`
- 已开启 TLS 1.2/1.3，Nginx 配置校验与 reload 成功。
- 服务器内部以域名和正常证书校验访问 127.0.0.1:443 返回 200。
- 本地公网 curl 和浏览器连接失败，抓包窗口未捕获到对应 443 请求。系统 UFW 已放行 443；云防火墙／安全组和客户端线路仍需排查，尚不能确认具体拦截位置。
- 保留 HTTP，不启用强制跳转，待公网 HTTPS 正常后再配置。

参考文章 https://zhuanlan.zhihu.com/p/374584044 建议修改 hosts。2026-09-26 使用 curl --resolve 保留域名与证书校验，尝试 GitHub/API 多个 IP（含公共 DNS 查询结果）及 release-assets 域名，均在 TCP 443 超时，因此未持久修改 hosts。此办法未解决当前网络问题；COS 仅为未验证备选，尚未开通或产生相关服务成本。

## 更新网站

本地 `npm run build --prefix website`，只上传 `website/dist/` 内容。保留服务器的 downloads/，不要用无排除规则的目录清空或 rsync --delete 覆盖安装包。

## 上线检查

检查首页、视频 Range 请求、二维码、手机布局、版本索引和真实安装包下载。交流群图片标注 2026-10-03 前有效，需要及时更新。

## GitHub Actions 主动上传（2026-09-26）

`mirror-downloads` 在 release-win / release-mac 成功结束后触发，也可手动执行，每 6 小时补偿检查。GitHub Runner 运行同一同步脚本，下载并校验最近 5 个稳定版本，再用 rsync 校验传输；最后单独原子替换 index.json。发布互斥，不删除旧包。

部署账号 dshdeploy 没有 sudo；专用密钥在 authorized_keys 中通过 restrict 与 rrsync 限制为下载目录写入，禁止删除和任意 shell。密钥与经现有 SSH 连接读取的主机公钥存入 GitHub Actions Secrets，不提交到仓库。服务器原来的拉取 timer 保持停用，避免两种同步同时写目录。

```sh
gh workflow run mirror-downloads.yml --repo Lxiayu/DshCockpit
gh run list --workflow mirror-downloads.yml --repo Lxiayu/DshCockpit
```

实测结果：2026-09-26 两次 GitHub Runner 均在 SSH TCP 22 连接阶段超时，未进入认证；尚未成功上传。workflow 已在 GitHub 暂停，避免周期性失败，线路解决后先启用再手动触发：`gh workflow enable mirror-downloads.yml --repo Lxiayu/DshCockpit`。不要把“工作流已配置”等同于“同步已通”。
