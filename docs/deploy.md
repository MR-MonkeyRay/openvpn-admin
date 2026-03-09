# OpenVPN Admin 部署说明

本文档说明当前仓库支持的两种部署方式：

1. **默认一体化 Docker 模式**：同时运行 `openvpn-admin` 与 `openvpn`
2. **Legacy Host 模式**：宿主机已安装 OpenVPN，仅容器化 `openvpn-admin`

默认推荐第一种。

## 1. 默认部署形态

默认 `docker-compose.yml` 会启动两个服务：

- `openvpn-admin`
  - 提供 Web UI、用户管理、审计日志、配置编辑、客户端下载配置导出
- `openvpn`
  - 提供实际 OpenVPN 服务进程，并通过 `auth-user-pass-verify` 使用认证缓存

共享卷如下：

- `openvpn_server`
  - 保存 `server.conf`、证书、密钥、状态/日志文件
- `openvpn_scripts`
  - 保存 `auth_verify` 认证脚本
- `openvpn_run`
  - 保存 management Unix socket
- `app_data`
  - 保存 `app.db`、`auth-cache.db`、导出配置等应用数据
- `app_logs`
  - 保存应用日志目录

## 2. 宿主机前置条件

一体化模式要求宿主机具备：

1. 已安装 `Docker` 与 `Docker Compose`
2. 宿主机内核已启用 `tun`
3. 容器可访问 `/dev/net/tun`
4. 已放通对外 VPN 端口，默认 `1194/udp`

可先检查：

```bash
ls -l /dev/net/tun
docker compose version
```

如果 `/dev/net/tun` 不存在，可先在宿主机加载：

```bash
sudo modprobe tun
```

## 3. 环境变量

复制模板：

```bash
cp .env.example .env
```

至少应检查这些变量：

- `APP_BASE_URL`
- `SESSION_SECRET`
- `CSRF_SECRET`
- `INIT_ADMIN_USERNAME`
- `INIT_ADMIN_PASSWORD`
- `TRUST_PROXY`
- `SESSION_COOKIE_NAME`
- `OVPN_INSTANCE_NAME`
- `OVPN_PORT`
- `OVPN_PROTO`
- `OVPN_PUBLIC_HOST`
- `OVPN_AUTO_INIT`
- `OVPN_SERVER_NETWORK`
- `OVPN_SERVER_CONF_PATH`
- `OVPN_AUTH_SCRIPT_PATH`
- `OVPN_MGMT_SOCKET`

关键变量说明：

- `OVPN_PUBLIC_HOST`
  - 生成客户端配置时，作为 `.ovpn` 的 `remote` 主机名来源
- `OVPN_SERVER_CONF_PATH`
  - Web UI 读写的 OpenVPN 服务端配置路径
- `OVPN_AUTH_SCRIPT_PATH`
  - OpenVPN `auth-user-pass-verify` 使用的脚本路径
- `OVPN_MGMT_SOCKET`
  - Web UI 展示的 management socket 路径
- `TRUST_PROXY`
  - 反向代理部署时必须与代理跳数匹配，常见单层代理可设为 `1`
- `SESSION_COOKIE_NAME`
  - 自定义会话 Cookie 名称，避免使用默认名称

生产环境中务必替换：

- `SESSION_SECRET`
- `CSRF_SECRET`
- `INIT_ADMIN_PASSWORD`

并确保：

- `APP_BASE_URL` 在生产环境必须使用 `https://`
- 管理端必须放在受信任反向代理之后，并正确设置 `TRUST_PROXY`
- 首次登录后立即轮换初始管理员密码

## 4. 首次启动

执行：

```bash
docker compose up -d --build
```

当前 Compose 编排会：

1. 构建 `openvpn-admin` 镜像
2. 构建 `docker/openvpn/Dockerfile` 对应的 `openvpn` 镜像
3. 挂载共享卷供两侧读写同一份 OpenVPN 资产和应用数据
4. 启动后由应用在首次访问时初始化数据库与默认配置

首次访问时：

1. 打开 `APP_BASE_URL`
2. 使用 `INIT_ADMIN_USERNAME` / `INIT_ADMIN_PASSWORD` 登录
3. 登录后尽快修改初始管理员密码

## 5. 运行期行为

当前实现下，Web UI 负责：

- 管理用户
- 同步认证缓存
- 读取、预览、保存、应用 `server.conf`
- 生成客户端配置并记录导出条目

当前实现下，修改配置后**不会**在 UI 内直接重启 OpenVPN 服务；
运维仍需手工执行：

```bash
docker compose restart openvpn
```

查看运行状态可使用：

```bash
docker compose ps
docker compose logs openvpn --tail=100
docker compose logs openvpn-admin --tail=100
```

部署前后可额外执行最小自检：

```bash
pnpm preflight
pnpm healthcheck
```

- `pnpm preflight` 适合在发布前检查关键环境变量和生产约束
- `pnpm healthcheck` 适合在服务启动后验证 `/health` 是否返回正常结果

## 6. 数据与备份建议

至少备份以下内容：

- `app_data` 卷中的 `app.db`、`auth-cache.db`、导出产物
- `openvpn_server` 卷中的 `server.conf`、`ca.crt`、`server.crt`、`server.key`
- `openvpn_scripts` 卷中的认证脚本
- `app_logs` 中需要保留的日志

推荐升级流程：

```bash
docker compose down
docker compose up -d --build
```

## 7. HTTPS 与反向代理建议

建议在 `openvpn-admin` 前放置反向代理负责 TLS 终止。

最低建议：

- 管理端仅通过 HTTPS 暴露
- 反向代理透传 `X-Forwarded-Proto`
- 配置 `TRUST_PROXY`，其值需与真实代理层数一致
- 仅允许可信网段或来源 IP 访问管理端
- 为管理端开启 HSTS，并避免把后台直接暴露到公网

当前应用在生产环境会拒绝以下高风险配置：

- `APP_BASE_URL` 仍是 `http://`
- 缺少 `SESSION_SECRET`
- 缺少 `INIT_ADMIN_PASSWORD`
- 未启用 `TRUST_PROXY`

## 8. 常见问题

### 8.1 `openvpn` 容器启动失败

- 检查 `/dev/net/tun` 是否存在
- 检查容器是否已授予 `NET_ADMIN`
- 查看 `docker compose logs openvpn`

### 8.2 用户能登录 UI，但 VPN 认证失败

- 检查 `app_data` 中 `auth-cache.db` 是否已更新
- 检查 `openvpn_scripts` 中 `auth_verify` 是否存在且可执行
- 查看 `docker compose logs openvpn` 的认证失败日志

### 8.3 导出的 `.ovpn` 无法连接

- 检查 `OVPN_PUBLIC_HOST` 是否正确
- 检查 `openvpn_server` 中是否存在 `ca.crt` 与 `tls-crypt.key`
- 检查 OpenVPN 服务端监听端口/协议是否与导出配置一致
- 修改配置后是否已执行 `docker compose restart openvpn`

## 9. Legacy Host 模式

如果宿主机已经运行 OpenVPN，可使用：

```bash
docker compose -f docker-compose.host.yml up -d --build
```

该模式会把宿主机目录映射进容器，典型包括：

- `${HOST_OPENVPN_SERVER_DIR:-/etc/openvpn/server}`
- `${HOST_OPENVPN_SCRIPTS_DIR:-/etc/openvpn/scripts}`
- `${HOST_OPENVPN_RUN_DIR:-/run/openvpn}`
- `${HOST_APP_DATA_DIR:-/var/lib/openvpn-admin}`
- `${HOST_APP_LOG_DIR:-/var/log/openvpn-admin}`
- `${HOST_WRAPPER_PATH:-/usr/local/bin/openvpn-admin-wrapper}`

适合已有 OpenVPN 服务、仅想补充 Web 管理面的场景。

## 10. 验收清单

- 新机器可直接执行 `docker compose up -d --build`
- `openvpn` 容器可绑定 `${OVPN_PORT}/${OVPN_PROTO}`
- `openvpn-admin` 可创建用户并同步认证缓存
- 导出的 `.ovpn` 包含真实 `ca` 与 `tls-crypt` 内容
- 配置修改后可通过重启 `openvpn` 服务生效
- `docker-compose.host.yml` 仍可用于宿主机 OpenVPN 模式
