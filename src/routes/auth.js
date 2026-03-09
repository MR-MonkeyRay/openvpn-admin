import express from 'express';
import { ensureCsrfToken } from '../middleware/csrf.js';

function sanitizeUser(user) {
  const { password_hash, passwordHash, ...safeUser } = user;
  return safeUser;
}

export function createAuthRoutes({ repo, meta, requireCsrf, requireAuth }) {
  const router = express.Router();

  // Web login page
  router.get('/login', (req, res) => {
    res.render('login', { formValues: {}, meta });
  });

  // API: get CSRF token
  router.get('/api/auth/csrf', (req, res) => {
    res.json({ csrfToken: ensureCsrfToken(req) });
  });

  // Web login
  router.post('/auth/login', requireCsrf, async (req, res) => {
    const { username, password } = req.body;
    const result = await repo.verifyUserCredentials(username, password);
    if (!result.ok) {
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
    res.redirect(result.user.role === 'admin' ? '/dashboard' : '/me/profile');
  });

  // API login
  router.post('/api/auth/login', requireCsrf, async (req, res) => {
    const { username, password } = req.body;
    const result = await repo.verifyUserCredentials(username, password);
    if (!result.ok) {
      res.status(401).json(result);
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
    res.json({ ok: true, user: sanitizeUser(result.user) });
  });

  // Web logout
  router.post('/auth/logout', requireCsrf, (req, res) => {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  // API logout
  router.post('/api/auth/logout', requireCsrf, (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  // API: get current user
  router.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: sanitizeUser(repo.findUserById(req.session.userId)) });
  });

  return router;
}
