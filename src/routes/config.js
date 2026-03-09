import express from 'express';

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

export function createConfigRoutes({ repo, configService, requireAdmin, requireCsrf }) {
  const router = express.Router();

  // Web: config page
  router.get('/config', requireAdmin, (req, res) => {
    res.render('config', {
      openvpnConfig: configService.readConfigForm(),
      configVersions: repo.listConfigVersions(),
      diffText: '',
      validationResult: { status: 'ok', message: 'ready' },
    });
  });

  // API: get config
  router.get('/api/openvpn/config', requireAdmin, (req, res) => {
    res.json({
      config: configService.readConfigForm(),
      versions: repo.listConfigVersions(),
    });
  });

  // Web: preview config
  router.post('/config/preview', requireAdmin, requireCsrf, (req, res) => {
    const preview = configService.preview(mapConfigForm(req.body));
    res.render('config', {
      openvpnConfig: mapConfigForm(req.body),
      configVersions: repo.listConfigVersions(),
      diffText: preview.diff,
      validationResult: { status: 'warning', message: 'preview only' },
    });
  });

  // Web: save config
  router.post('/config/save', requireAdmin, requireCsrf, (req, res) => {
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
    req.flash('success', '配置草稿已保存');
    res.redirect('/config');
  });

  // API: save config
  router.post('/api/openvpn/config/save', requireAdmin, requireCsrf, (req, res) => {
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
    res.status(201).json({ ok: true, diff: preview.diff });
  });

  // Web: apply config
  router.post('/config/apply', requireAdmin, requireCsrf, (req, res) => {
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
    req.flash('success', '配置已应用');
    res.redirect('/config');
  });

  // API: apply config
  router.post('/api/openvpn/config/apply', requireAdmin, requireCsrf, (req, res) => {
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
    res.json({ ok: true, version: applied.version });
  });

  // Web: rollback config
  router.post('/config/rollback/:versionId', requireAdmin, requireCsrf, (req, res) => {
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

  return router;
}
