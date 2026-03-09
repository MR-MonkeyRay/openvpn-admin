# openvpn-admin

一个面向小型到中型团队的 OpenVPN 管理面板，提供 Web UI、用户账号管理、
认证缓存同步、OpenVPN 服务端配置编辑，以及客户端 `.ovpn` 导出能力。

当前仓库默认面向 **Docker 一体化部署**：

- `openvpn-admin`：管理界面与应用逻辑
- `openvpn`：实际 VPN 服务
- 通过共享卷共享 `server.conf`、证书/密钥、认证脚本、认证缓存与导出产物

## 功能概览

- 管理员登录与会话管理
- 用户创建、启用、禁用、删除、重置密码
- 同步只读认证缓存，供 OpenVPN `auth-user-pass-verify` 使用
- Web UI 编辑、预览、保存、应用 OpenVPN `server.conf`
- 导出内联 `ca` / `tls-crypt` 的客户端 `.ovpn` 配置
- 审计日志、配置版本记录、配置回滚入口
- 管理员视角与普通用户自助下载视角

## 项目结构

```text
src/                 应用源码
  app.js             Express 应用与路由
  server.js          进程入口
  lib/               用户库、配置服务、认证逻辑
  views/             EJS 页面模板
  public/            静态资源
scripts/             OpenVPN 认证脚本与宿主机 wrapper
docs/                部署与认证脚本文档
tests/               Node 原生测试
```

## 运行要求

- Node.js 24+
- pnpm
- Docker / Docker Compose（部署时）
- 宿主机支持 `/dev/net/tun`（一体化部署时）

## 本地开发

1. 安装依赖：

```bash
pnpm install
```

2. 复制环境变量：

```bash
cp .env.example .env
```

3. 启动开发模式：

```bash
pnpm dev
```

默认监听：`http://127.0.0.1:3000`

## 常用脚本

```bash
pnpm dev
pnpm preflight
pnpm healthcheck
pnpm start
pnpm test
pnpm lint
pnpm build
```

当前脚本含义：

- `pnpm dev`：以 `node --watch src/server.js` 启动
- `pnpm preflight`：执行启动前配置校验并尝试加载服务入口，适合部署前检查
- `pnpm healthcheck`：请求 `/health` 并校验返回 `status=ok`
- `pnpm start`：直接运行 `src/server.js`
- `pnpm test`：执行 `node --test`
- `pnpm lint`：对 `src/`、`tests/`、`scripts/` 下的 `.js/.mjs` 文件执行 `node --check` 语法检查
- `pnpm build`：当前仅输出 “No build step required”

## 环境变量重点

建议至少确认以下变量：

- `APP_BASE_URL`
- `SESSION_SECRET`
- `CSRF_SECRET`
- `INIT_ADMIN_USERNAME`
- `INIT_ADMIN_PASSWORD`
- `TRUST_PROXY`
- `OVPN_PUBLIC_HOST`
- `OVPN_PORT`
- `OVPN_PROTO`
- `OVPN_SERVER_CONF_PATH`
- `OVPN_MGMT_SOCKET`

示例模板见 `.env.example`。

## Docker 部署模式

### 1. 默认一体化模式

```bash
docker compose up -d --build
```

该模式会同时启动：

- `openvpn-admin`
- `openvpn`

并创建以下卷：

- `openvpn_server`
- `openvpn_scripts`
- `openvpn_run`
- `app_data`
- `app_logs`

适合新机器直接落地，不要求宿主机预装 OpenVPN 服务。

### 2. Legacy Host 模式

```bash
docker compose -f docker-compose.host.yml up -d --build
```

该模式只运行 `openvpn-admin`，要求宿主机已经准备好 OpenVPN 服务、脚本目录、
运行目录和应用数据目录。

## 当前实现说明

- 应用数据库默认位于 `./data/app.db`
- 认证缓存默认位于 `./data/auth-cache.db`
- OpenVPN 服务端配置默认位于 `./data/server.conf`
- 客户端导出目录默认位于 `./data/exports`
- 首次启动时若管理员不存在，会使用
  `INIT_ADMIN_USERNAME` / `INIT_ADMIN_PASSWORD` 自动引导
- 当前 Web UI 保存或应用配置后，仍需由运维侧执行 OpenVPN 重启使其生效

## 文档索引

- 部署说明：`docs/deploy.md`
- OpenVPN 认证脚本说明：`docs/openvpn-auth-script.md`

## 测试

运行全部测试：

```bash
pnpm test
```

如果只验证某一部分，可以使用 Node 原生测试过滤：

```bash
node --test tests/http-app.test.js
```

## 已知边界

- 当前 lint 为最小静态检查：使用 `node --check` 做语法校验，不包含风格规则
- 当前 `build` 为占位命令，不生成额外构建产物
- 配置写入后不会在 UI 中直接重启 OpenVPN 服务
- 认证脚本与运维集成依赖共享卷或宿主机路径映射正确
