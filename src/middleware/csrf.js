import crypto from 'node:crypto';

export function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomUUID();
  }
  return req.session.csrfToken;
}

export function isValidCsrf(req) {
  const submittedToken = req.get('x-csrf-token') ?? req.body?.csrfToken ?? req.body?._csrf;
  return Boolean(submittedToken) && submittedToken === req.session.csrfToken;
}

export function requireCsrf(req, res, next) {
  if (isValidCsrf(req)) {
    next();
    return;
  }
  if (req.path.startsWith('/api/')) {
    res.status(403).json({ ok: false, reason: 'CSRF_INVALID' });
    return;
  }
  res.status(403).send('Forbidden');
}
