import { ensureCsrfToken } from './csrf.js';

export function createSessionLocals({ repo, meta }) {
  return (req, res, next) => {
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
  };
}
