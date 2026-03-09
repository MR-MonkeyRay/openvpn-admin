# OpenVPN 用户名密码认证脚本说明

本文档说明当前仓库中 OpenVPN 用户名密码认证脚本的接入方式、输入格式与现状。

对应文件：

- 脚本入口：`scripts/auth_verify.mjs`
- 认证逻辑：`src/lib/auth-verify.js`

## 1. 接入方式

OpenVPN 通过以下指令调用认证脚本：

```conf
script-security 2
auth-user-pass-verify /etc/openvpn/scripts/auth_verify via-file
```

其中脚本路径由部署时卷映射或宿主机路径决定；在当前默认配置中，
Web UI 生成的 `server.conf` 会写入上面的 `via-file` 模式。

## 2. 输入格式

`via-file` 模式下，OpenVPN 会把临时文件路径作为脚本第一个参数传入。

临时文件内容为两行：

```text
<username>
<password>
```

`scripts/auth_verify.mjs` 会读取该文件，并把用户名/密码交给
`src/lib/auth-verify.js` 校验。

## 3. 当前认证数据来源

当前实现使用独立 SQLite 认证缓存库，而不是直接访问主业务表。

默认路径通常为：

```text
/var/lib/openvpn-admin/auth-cache.db
```

也可以通过环境变量覆盖：

```bash
AUTH_CACHE_DB_PATH=/path/to/auth-cache.db
```

缓存表结构为：

```sql
CREATE TABLE auth_cache (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  exported_at TEXT NOT NULL
);
```

字段说明：

- `username`：VPN 登录用户名
- `password_hash`：密码哈希
- `status`：当前用户状态，如 `active` / `disabled` / `deleted`
- `expires_at`：到期时间，为空表示不过期
- `exported_at`：最近一次同步到缓存的时间

## 4. 当前脚本行为

当前认证脚本会执行以下步骤：

1. 读取用户名与密码文件
2. 以只读方式打开认证缓存库
3. 按用户名查询 `auth_cache`
4. 校验以下条件：
   - 用户存在
   - 用户未被 `disabled`
   - 用户未被 `deleted`
   - 用户未过期
   - 密码哈希校验通过
5. 返回成功或失败

## 5. 当前退出码现状

**按当前仓库实现**，`scripts/auth_verify.mjs` 的退出码行为如下：

- `0`：认证成功
- `1`：认证失败
- `1`：脚本缺少必需参数时也会直接退出

也就是说，当前实现尚未区分“输入无效”和“内部依赖异常”等更细分错误码；
运维排障时应结合 OpenVPN 日志与本地自测一起判断。

## 6. 与 Web UI 的同步关系

当前应用在以下动作后会刷新认证缓存：

- 创建用户
- 重置密码
- 启用/禁用用户
- 删除用户
- 更新用户资料中与认证相关的字段

因此 OpenVPN 认证脚本读取的是一份面向认证场景的只读缓存，而非管理 UI 的完整数据表。

## 7. 部署建议

- 认证缓存文件应仅允许应用写入、认证脚本只读访问
- `auth_verify` 应设置为可执行
- 不要在脚本日志中打印明文密码
- 变更脚本或缓存路径后，应重新确认 `server.conf` 中的
  `auth-user-pass-verify` 指令是否仍指向正确位置

## 8. 本地自测建议

可在本地准备一个两行格式的凭据文件，再执行脚本：

```bash
printf 'alice\nsecret\n' > /tmp/ovpn-cred.txt
AUTH_CACHE_DB_PATH=./data/auth-cache.db node scripts/auth_verify.mjs /tmp/ovpn-cred.txt
```

然后检查退出码：

```bash
echo $?
```

如果认证失败，可继续检查：

- `auth-cache.db` 中是否存在对应用户
- 用户状态是否为 `active`
- `expires_at` 是否已过期
- 缓存是否已经同步为最新密码哈希
