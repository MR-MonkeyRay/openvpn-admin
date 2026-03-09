export function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ ok: false, reason: 'AUTH_REQUIRED' });
      return;
    }
    res.redirect('/login');
    return;
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ ok: false, reason: 'AUTH_REQUIRED' });
      return;
    }
    res.redirect('/login');
    return;
  }
  const role = req.session.role ?? req.session.userRole;
  if (role !== 'admin') {
    if (req.path.startsWith('/api/')) {
      res.status(403).json({ ok: false, reason: 'FORBIDDEN' });
      return;
    }
    res.status(403).send('Forbidden');
    return;
  }
  next();
}
