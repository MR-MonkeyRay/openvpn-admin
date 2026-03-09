import express from 'express';

function sanitizeUser(user) {
  const { password_hash, passwordHash, ...safeUser } = user;
  return safeUser;
}

export function createUsersRoutes({ repo, configService, options, requireAdmin, requireCsrf }) {
  const router = express.Router();

  // Web: users list page
  router.get('/users', requireAdmin, (req, res) => {
    const userList = repo.listUsers();
    const selected = req.query.selected ? repo.findUserById(req.query.selected) : null;
    res.render('users', {
      userList,
      selected,
      exportsList: repo.listProfileExports().map((item) => ({
        ...item,
        username: repo.findUserById(item.user_id)?.username ?? '--',
      })),
    });
  });

  // API: list users
  router.get('/api/users', requireAdmin, (req, res) => {
    res.json({ users: repo.listUsers().map(sanitizeUser) });
  });

  // Web: update user
  router.post('/users/:id', requireAdmin, requireCsrf, async (req, res) => {
    const user = repo.findUserById(req.params.id);
    if (!user) {
      res.status(404).send('Not found');
      return;
    }

    if (req.body.password) {
      await repo.resetPassword(req.params.id, req.body.password);
    }

    repo.updateUser(req.params.id, {
      displayName: req.body.displayName,
      role: req.body.role,
      status: req.body.status,
      note: req.body.note,
      expiresAt: req.body.expiresAt || null,
    });

    req.flash('success', '用户已更新');
    res.redirect(`/users?selected=${req.params.id}`);
  });

  // Web: create user
  router.post('/users', requireAdmin, requireCsrf, async (req, res) => {
    const user = await repo.createUser({
      username: req.body.username,
      password: req.body.password,
      role: req.body.role || 'user',
      displayName: req.body.displayName || req.body.username,
      note: req.body.note || '',
      expiresAt: req.body.expiresAt || null,
    });

    repo.createAuditLog({
      actorUserId: req.session.userId,
      actorRole: 'admin',
      actionType: 'user.create',
      targetType: 'user',
      targetId: user.id,
      summary: `Created user ${user.username}`,
    });

    req.flash('success', '用户已创建');
    res.redirect('/users');
  });

  // API: create user
  router.post('/api/users', requireAdmin, requireCsrf, async (req, res) => {
    const user = await repo.createUser({
      username: req.body.username,
      password: req.body.password,
      role: req.body.role || 'user',
      displayName: req.body.displayName || req.body.username,
      note: req.body.note || '',
      expiresAt: req.body.expiresAt || null,
    });

    repo.createAuditLog({
      actorUserId: req.session.userId,
      actorRole: 'admin',
      actionType: 'user.create',
      targetType: 'user',
      targetId: user.id,
      summary: `Created user ${user.username}`,
    });

    res.status(201).json({ user: sanitizeUser(user) });
  });

  // Web: reset password
  router.post('/users/:id/reset-password', requireAdmin, requireCsrf, async (req, res) => {
    await repo.resetPassword(req.params.id, req.body.password);
    req.flash('success', '密码已重置');
    res.redirect(`/users?selected=${req.params.id}`);
  });

  // Web: disable user
  router.post('/users/:id/disable', requireAdmin, requireCsrf, (req, res) => {
    repo.disableUser(req.params.id);
    req.flash('success', '用户已禁用');
    res.redirect('/users');
  });

  // Web: enable user
  router.post('/users/:id/enable', requireAdmin, requireCsrf, (req, res) => {
    repo.enableUser(req.params.id);
    req.flash('success', '用户已启用');
    res.redirect('/users');
  });

  // Web: generate profile for user
  router.post('/users/:id/profiles', requireAdmin, requireCsrf, (req, res) => {
    const user = repo.findUserById(req.params.id);
    configService.generateProfile({
      user,
      remoteHost: options.defaultRemote ?? new URL(options.baseUrl ?? 'http://vpn.example.com').hostname,
      actor: repo.findUserById(req.session.userId)?.username ?? 'system',
    });
    req.flash('success', '已生成客户端下载配置');
    res.redirect('/users');
  });

  return router;
}
