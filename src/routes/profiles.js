import express from 'express';

export function createProfilesRoutes({ repo, configService, options, requireAdmin, requireCsrf }) {
  const router = express.Router();

  // Web: download profile
  router.get('/profiles/:id/download', requireAdmin, (req, res) => {
    const item = repo.findProfileExport(req.params.id);
    if (!item) {
      res.status(404).send('Not found');
      return;
    }
    repo.markProfileExportDownloaded?.(item.id);
    res.download(item.artifact_path);
  });

  // API: generate profile
  router.post('/api/profiles/generate', requireAdmin, requireCsrf, (req, res) => {
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

  // API: list profiles
  router.get('/api/profiles', requireAdmin, (req, res) => {
    res.json({ exports: repo.listProfileExports() });
  });

  // API: download profile
  router.get('/api/profiles/:id/download', requireAdmin, (req, res) => {
    const item = repo.findProfileExport(req.params.id);
    if (!item) {
      res.status(404).json({ ok: false, reason: 'EXPORT_NOT_FOUND' });
      return;
    }
    repo.markProfileExportDownloaded?.(item.id);
    res.download(item.artifact_path);
  });

  return router;
}
