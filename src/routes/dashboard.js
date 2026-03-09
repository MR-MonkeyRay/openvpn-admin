import express from 'express';

export function createDashboardRoutes({ repo, configService, meta, requireAdmin }) {
  const router = express.Router();

  router.get('/dashboard', requireAdmin, (req, res) => {
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

  return router;
}
