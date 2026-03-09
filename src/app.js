import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createConfigService } from './lib/config-service.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import { requireCsrf } from './middleware/csrf.js';
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';
import { createSecurityHeaders } from './middleware/security-headers.js';
import { createSessionLocals } from './middleware/session-locals.js';
import { createAuthRoutes } from './routes/auth.js';
import { createAuditRoutes } from './routes/audit.js';
import { createConfigRoutes } from './routes/config.js';
import { createDashboardRoutes } from './routes/dashboard.js';
import { createMeRoutes } from './routes/me.js';
import { createProfilesRoutes } from './routes/profiles.js';
import { createUsersRoutes } from './routes/users.js';

function defaultMeta(options) {
  return {
    instanceName: options.instanceName ?? 'server',
    managementSocket: options.managementSocket ?? '/run/openvpn/server-management.sock',
    managementMode: 'Unix Socket',
    tlsMode: options.baseUrl?.startsWith('https://') ? 'https' : 'http',
  };
}

export function createApp({ repo, paths, bootstrapAdmin = null, options = {} }) {
  const app = express();
  app.disable('x-powered-by');
  const meta = defaultMeta(options);
  const secureCookies = meta.tlsMode === 'https';
  const sessionCookieName = options.sessionCookieName ?? 'openvpn_admin.sid';
  const configService = createConfigService({
    serverConfigPath: paths.serverConfigPath,
    exportDir: paths.exportDir,
    repo,
  });

  fs.mkdirSync(paths.exportDir, { recursive: true });
  app.set('view engine', 'ejs');
  app.set('views', path.resolve('src/views'));
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);

  app.use(createSecurityHeaders({ secureCookies }));
  app.use('/public', express.static(path.resolve('src/public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    session({
      name: sessionCookieName,
      secret: options.sessionSecret ?? crypto.randomUUID(),
      resave: false,
      rolling: false,
      saveUninitialized: false,
      proxy: options.trustProxy !== undefined,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        path: '/',
      },
    }),
  );

  const bootstrap = async () => {
    await repo.migrate();
    configService.readRawConfig();
    if (bootstrapAdmin && !repo.findUserByUsername(bootstrapAdmin.username)) {
      await repo.createUser({
        username: bootstrapAdmin.username,
        password: bootstrapAdmin.password,
        role: 'admin',
        displayName: 'Administrator',
      });
    }
  };

  app.use(createSessionLocals({ repo, meta }));

  // Root routes
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'openvpn-admin' }));
  app.get('/', (req, res) => res.redirect(req.session.userId ? '/dashboard' : '/login'));

  // Mount route modules
  const routeDeps = { repo, configService, meta, options, requireAuth, requireAdmin, requireCsrf };
  app.use(createAuthRoutes(routeDeps));
  app.use(createDashboardRoutes(routeDeps));
  app.use(createConfigRoutes(routeDeps));
  app.use(createUsersRoutes(routeDeps));
  app.use(createProfilesRoutes(routeDeps));
  app.use(createAuditRoutes(routeDeps));
  app.use(createMeRoutes(routeDeps));

  // Error handling (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, bootstrap };
}
