import express from 'express';

export function createAuditRoutes({ repo, requireAdmin, requireCsrf }) {
  const router = express.Router();

  // Web: audit page
  router.get('/audit', requireAdmin, (req, res) => {
    res.render('audit', {
      auditLogs: repo.listAuditLogs(),
      onlineSessions: [],
      authFailures: [],
    });
  });

  // API: list audit logs
  router.get('/api/audit-logs', requireAdmin, (req, res) => {
    res.json({ auditLogs: repo.listAuditLogs() });
  });

  // Web: disconnect session
  router.post('/audit/sessions/:username/disconnect', requireAdmin, requireCsrf, (req, res) => {
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

  return router;
}
