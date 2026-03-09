import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createConfigService } from './lib/config-service.js';

function defaultMeta(options) {
  return {
    instanceName: options.instanceName ?? 'server',
    managementSocket: options.managementSocket ?? '/run/openvpn/server-management.sock',
    managementMode: 'Unix Socket',
    tlsMode: options.baseUrl?.startsWith('https://') ? 'https' : 'http',
  };
}

export function createApp({ repo, paths, bootstrapAdmin = null, options = {} }) {
  const app = express();
  app.disable('x-powered-by');
  const meta = defaultMeta(options);
  const secureCookies = meta.tlsMode === 'https';
  const sessionCookieName = options.sessionCookieName ?? 'openvpn_admin.sid';
  const configService = createConfigService({
    serverConfigPath: paths.serverConfigPath,
    exportDir: paths.exportDir,
    repo,
  });

  fs.mkdirSync(paths.exportDir, { recursive: true });
  app.set('view engine', 'ejs');
  app.set('views', path.resolve('src/views'));
  if (options.trustProxy !== undefined) {
    app.set('trust proxy', options.trustProxy);
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (secureCookies) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }

    next();
  });

  app.use('/public', express.static(path.resolve('src/public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    session({
      name: sessionCookieName,
      secret: options.sessionSecret ?? crypto.randomUUID(),
      resave: false,
      rolling: false,
      saveUninitialized: false,
      proxy: options.trustProxy !== undefined,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        path: '/',
      },
    }),
  );

  app.locals.bootstrap = async () => {
    await repo.migrate();
    configService.readRawConfig();

    if (bootstrapAdmin && !repo.findUserByUsername(bootstrapAdmin.username)) {
      await repo.createUser({
        username: bootstrapAdmin.username,
        password: bootstrapAdmin.password,
        role: 'admin',
        displayName: 'Administrator',
      });
    }
  };

  app.use((req, res, next) => {
    const sessionUser = req.session.userId ? repo.findUserById(req.session.userId) : null;
    const csrfToken = ensureCsrfToken(req);
    res.locals.currentUser = sessionUser;
    res.locals.user = sessionUser;
    res.locals.meta = meta;
    res.locals.appMeta = meta;
    res.locals.csrfToken = csrfToken;
    res.locals.flashes = req.session.flashes ?? [];
    res.locals.flashMessages = req.session.flashes ?? [];
    req.flash = (type, message) => {
      req.session.flashes = [{ type, message }];
    };

    if (req.session.flashes?.length) {
      const flashes = req.session.flashes;
      res.on('finish', () => {
        if (req.session) req.session.flashes = [];
      });
      res.locals.flashes = flashes;
      res.locals.flashMessages = flashes;
    }

    next();
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'openvpn-admin' });
  });

  app.get('/', (req, res) => {
    res.redirect(req.session.userId ? '/dashboard' : '/login');
  });

  app.get('/login', (req, res) => {
    res.render('login', { formValues: {}, meta });
  });

  app.get('/api/auth/csrf', (req, res) => {
    res.json({ csrfToken: ensureCsrfToken(req) });
  });

  app.post(['/auth/login', '/api/auth/login'], requireCsrf, async (req, res) => {
    const { username, password } = req.body;
    const result = await repo.verifyUserCredentials(username, password);

    if (!result.ok) {
      if (req.path.startsWith('/api/')) {
        res.status(401).json(result);
        return;
      }

      req.flash('error', '用户名或密码错误');
      res.status(401).render('login', { formValues: { username }, meta });
      return;
    }

    req.session.userId = result.user.id;
    req.session.role = result.user.role;
    repo.createAuditLog({
      actorUserId: result.user.id,
      actorRole: result.user.role,
      actionType: 'auth.login',
      targetType: 'user',
      targetId: result.user.id,
      summary: `${result.user.username} logged in`,
    });

    if (req.path.startsWith('/api/')) {
      res.json({ ok: true, user: sanitizeUser(result.user) });
      return;
    }

    res.redirect(result.user.role === 'admin' ? '/dashboard' : '/me/profile');
  });

  app.post(['/auth/logout', '/api/auth/logout'], requireCsrf, (req, res) => {
    req.session.destroy(() => {
      if (req.path.startsWith('/api/')) {
        res.json({ ok: true });
        return;
      }
      res.redirect('/login');
    });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: sanitizeUser(repo.findUserById(req.session.userId)) });
  });

  app.get('/dashboard', requireAdmin, (req, res) => {
    const users = repo.listUsers();
    const auditLogs = repo.listAuditLogs();
    const exportsList = repo.listProfileExports();
    res.render('dashboard', {
      dashboardStats: {
        onlineCount: 0,
        enabledUsers: users.filter((user) => user.status === 'active').length,
        failedAuthCount: 0,
        rollbackReadyCount: repo.listConfigVersions().length,
      },
      sessions: [],
      auditLogs,
      alertsList: [],
      configSummary: {
        ...configService.readConfigForm(),
        authMode: 'username + password',
        lastAppliedAt: repo.listConfigVersions()[0]?.created_at ?? null,
      },
      serviceStatus: {
        serviceName: `openvpn-server@${meta.instanceName}.service`,
        state: 'running',
      },
      exportsList,
    });
  });

  app.get('/config', requireAdmin, (req, res) => {
    res.render('config', {
      openvpnConfig: configService.readConfigForm(),
      configVersions: repo.listConfigVersions(),
      diffText: '',
      validationResult: { status: 'ok', message: 'ready' },
    });
  });

  app.get('/api/openvpn/config', requireAdmin, (req, res) => {
    res.json({
      config: configService.readConfigForm(),
      versions: repo.listConfigVersions(),
    });
  });

  app.post('/config/preview', requireAdmin, requireCsrf, (req, res) => {
    const preview = configService.preview(mapConfigForm(req.body));
    res.render('config', {
      openvpnConfig: mapConfigForm(req.body),
      configVersions: repo.listConfigVersions(),
      diffText: preview.diff,
      validationResult: { status: 'warning', message: 'preview only' },
    });
  });

  app.post(['/config/save', '/api/openvpn/config/save'], requireAdmin, requireCsrf, (req, res) => {
    const form = mapConfigForm(req.body);
    const preview = configService.save(form, repo.findUserById(req.session.userId)?.username ?? 'system');
    repo.createAuditLog({
      actorUserId: req.session.userId,
      actorRole: 'admin',
      actionType: 'config.save',
      targetType: 'openvpn-config',
      summary: 'Saved OpenVPN config draft',
      details: { diff: preview.diff },
    });

    if (req.path.startsWith('/api/')) {
      res.status(201).json({ ok: true, diff: preview.diff });
      return;
    }
    req.flash('success', '配置草稿已保存');
    res.redirect('/config');
  });

  app.post(['/config/apply', '/api/openvpn/config/apply'], requireAdmin, requireCsrf, (req, res) => {
    const form = mapConfigForm(req.body);
    const applied = configService.apply(form, repo.findUserById(req.session.userId)?.username ?? 'system');
    repo.createAuditLog({
      actorUserId: req.session.userId,
      actorRole: 'admin',
      actionType: 'config.apply',
      targetType: 'openvpn-config',
      summary: 'Applied OpenVPN config',
      details: { versionId: applied.version.id },
    });

    if (req.path.startsWith('/api/')) {
      res.json({ ok: true, version: applied.version });
      return;
    }
    req.flash('success', '配置已应用');
    res.redirect('/config');
  });

  app.post('/config/rollback/:versionId', requireAdmin, requireCsrf, (req, res) => {
    const version = configService.rollback(req.params.versionId);
    repo.createAuditLog({
      actorUserId: req.session.userId,
      actorRole: 'admin',
      actionType: 'config.rollback',
      targetType: 'openvpn-config',
      targetId: version.id,
      summary: 'Rolled back OpenVPN config',
      details: { versionId: version.id },
    });
    req.flash('success', '已回滚配置版本');
    res.redirect('/config');
  });

  app.get('/users', requireAdmin, (req, res) => {
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

  app.get('/api/users', requireAdmin, (req, res) => {
    res.json({ users: repo.listUsers().map(sanitizeUser) });
  });

  app.post('/users/:id', requireAdmin, requireCsrf, async (req, res) => {
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

  app.post(['/users', '/api/users'], requireAdmin, requireCsrf, async (req, res) => {
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

    if (req.path.startsWith('/api/')) {
      res.status(201).json({ user: sanitizeUser(user) });
      return;
    }

    req.flash('success', '用户已创建');
    res.redirect('/users');
  });

  app.post('/users/:id/reset-password', requireAdmin, requireCsrf, async (req, res) => {
    await repo.resetPassword(req.params.id, req.body.password);
    req.flash('success', '密码已重置');
    res.redirect(`/users?selected=${req.params.id}`);
  });

  app.post('/users/:id/disable', requireAdmin, requireCsrf, (req, res) => {
    repo.disableUser(req.params.id);
    req.flash('success', '用户已禁用');
    res.redirect('/users');
  });

  app.post('/users/:id/enable', requireAdmin, requireCsrf, (req, res) => {
    repo.enableUser(req.params.id);
    req.flash('success', '用户已启用');
    res.redirect('/users');
  });

  app.post('/users/:id/profiles', requireAdmin, requireCsrf, (req, res) => {
    const user = repo.findUserById(req.params.id);
    configService.generateProfile({
      user,
      remoteHost: options.defaultRemote ?? new URL(options.baseUrl ?? 'http://vpn.example.com').hostname,
      actor: repo.findUserById(req.session.userId)?.username ?? 'system',
    });
    req.flash('success', '已生成客户端下载配置');
    res.redirect('/users');
  });

  app.get('/profiles/:id/download', requireAdmin, (req, res) => {
    const item = repo.findProfileExport(req.params.id);
    if (!item) {
      res.status(404).send('Not found');
      return;
    }
    repo.markProfileExportDownloaded?.(item.id);
    res.download(item.artifact_path);
  });

  app.post('/api/profiles/generate', requireAdmin, requireCsrf, (req, res) => {
    const user = repo.findUserById(req.body.userId);
    if (!user) {
      res.status(404).json({ ok: false, reason: 'USER_NOT_FOUND' });
      return;
    }

    const generated = configService.generateProfile({
      user,
      remoteHost: req.body.remote || options.defaultRemote || new URL(options.baseUrl ?? 'http://vpn.example.com').hostname,
      format: req.body.format || 'inline_ovpn',
      actor: repo.findUserById(req.session.userId)?.username ?? 'system',
    });

    res.status(201).json({ ok: true, profile: generated });
  });

  app.get('/api/profiles', requireAdmin, (req, res) => {
    res.json({ exports: repo.listProfileExports() });
  });

  app.get('/api/profiles/:id/download', requireAdmin, (req, res) => {
    const item = repo.findProfileExport(req.params.id);
    if (!item) {
      res.status(404).json({ ok: false, reason: 'EXPORT_NOT_FOUND' });
      return;
    }
    repo.markProfileExportDownloaded?.(item.id);
    res.download(item.artifact_path);
  });

  app.get('/audit', requireAdmin, (req, res) => {
    res.render('audit', {
      auditLogs: repo.listAuditLogs(),
      onlineSessions: [],
      authFailures: [],
    });
  });

  app.get('/api/audit-logs', requireAdmin, (req, res) => {
    res.json({ auditLogs: repo.listAuditLogs() });
  });

  app.post('/audit/sessions/:username/disconnect', requireAdmin, requireCsrf, (req, res) => {
    repo.createAuditLog({
      actorUserId: req.session.userId,
      actorRole: 'admin',
      actionType: 'session.disconnect',
      targetType: 'session',
      targetId: req.params.username,
      summary: `Requested disconnect for ${req.params.username}`,
    });
    req.flash('success', '已记录断开请求');
    res.redirect('/audit');
  });

  app.get('/me/profile', requireAuth, (req, res) => {
    const currentUser = repo.findUserById(req.session.userId);
    res.render('me-profile', {
      myProfile: currentUser,
      downloadsList: repo.listProfileExports(currentUser.id),
      connectionHistory: [],
    });
  });

  app.post('/me/profile/generate', requireAuth, requireCsrf, (req, res) => {
    const user = repo.findUserById(req.session.userId);
    configService.generateProfile({
      user,
      remoteHost: req.body.remote || options.defaultRemote || new URL(options.baseUrl ?? 'http://vpn.example.com').hostname,
      format: req.body.format || 'inline_ovpn',
      actor: user.username,
    });
    req.flash('success', '已生成最新配置');
    res.redirect('/me/profile');
  });

  app.get('/me/profile/download/:id', requireAuth, (req, res) => {
    const item = repo.findProfileExport(req.params.id);
    if (!item || item.user_id !== req.session.userId) {
      res.status(404).send('Not found');
      return;
    }
    repo.markProfileExportDownloaded?.(item.id);
    res.download(item.artifact_path);
  });

  return app;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    res.redirect('/login');
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    res.redirect('/login');
    return;
  }

  const role = req.session.role ?? req.session.userRole;
  if (role !== 'admin') {
    res.status(403).send('Forbidden');
    return;
  }

  next();
}

function requireCsrf(req, res, next) {
  if (isValidCsrf(req)) {
    next();
    return;
  }

  if (isApiRequest(req)) {
    res.status(403).json({ ok: false, reason: 'CSRF_INVALID' });
    return;
  }

  res.status(403).send('Forbidden');
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomUUID();
  }

  return req.session.csrfToken;
}

function isApiRequest(req) {
  return req.path.startsWith('/api/');
}

function isValidCsrf(req) {
  const submittedToken = req.get('x-csrf-token') ?? req.body?.csrfToken ?? req.body?._csrf;
  return Boolean(submittedToken) && submittedToken === req.session.csrfToken;
}

function sanitizeUser(user) {
  const { password_hash, passwordHash, ...safeUser } = user;
  return safeUser;
}

function mapConfigForm(body) {
  return {
    bindAddress: body.bindAddress,
    port: body.port,
    protocol: body.protocol,
    network: body.network,
    dnsServers: body.dnsServers,
    pushRoutes: body.pushRoutes,
    cipher: body.cipher,
    auth: body.auth,
    ccdPath: body.ccdPath,
    logPath: body.logPath,
    tlsMode: body.tlsMode,
    keepalive: body.keepalive,
    rawExtra: body.rawExtra,
  };
}
