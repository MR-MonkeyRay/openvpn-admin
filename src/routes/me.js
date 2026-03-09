import express from 'express';

export function createMeRoutes({ repo, configService, options, requireAuth, requireCsrf }) {
  const router = express.Router();

  // Web: my profile page
  router.get('/me/profile', requireAuth, (req, res) => {
    const currentUser = repo.findUserById(req.session.userId);
    res.render('me-profile', {
      myProfile: currentUser,
      downloadsList: repo.listProfileExports(currentUser.id),
      connectionHistory: [],
    });
  });

  // Web: generate my profile
  router.post('/me/profile/generate', requireAuth, requireCsrf, (req, res) => {
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

  // Web: download my profile
  router.get('/me/profile/download/:id', requireAuth, (req, res) => {
    const item = repo.findProfileExport(req.params.id);
    if (!item || item.user_id !== req.session.userId) {
      res.status(404).send('Not found');
      return;
    }
    repo.markProfileExportDownloaded?.(item.id);
    res.download(item.artifact_path);
  });

  return router;
}
