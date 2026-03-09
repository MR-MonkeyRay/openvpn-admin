export function notFoundHandler(req, res, _next) {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ ok: false, reason: 'NOT_FOUND' });
    return;
  }
  res.status(404).send('Not Found');
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  console.error(`[error] ${req.method} ${req.path}:`, err.message || err);

  if (req.path.startsWith('/api/')) {
    res.status(status).json({ ok: false, reason: 'INTERNAL_ERROR' });
    return;
  }
  res.status(status).send('Internal Server Error');
}
