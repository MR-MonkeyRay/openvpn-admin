import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp } from './app.js';
import { createRepository } from './lib/repository.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_PORT = 3000;
const DEFAULT_SESSION_COOKIE_NAME = 'openvpn_admin.sid';

export function parseTrustProxy(value) {
  if (value === undefined || value === '') {
    return undefined;
  }

  if (value === 'true') return true;
  if (value === 'false') return false;

  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
}

function requireEnvFrom(env, name, { allowInsecureDefault = false } = {}) {
  const value = env[name];
  if (value !== undefined && value !== '') {
    return value;
  }

  if (allowInsecureDefault) {
    return undefined;
  }

  throw new Error(`Missing required environment variable: ${name}`);
}

export function ensureProductionRuntimeConfig(env = process.env) {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  const baseUrl = env.APP_BASE_URL || DEFAULT_BASE_URL;
  const parsedBaseUrl = new URL(baseUrl);

  if (parsedBaseUrl.protocol !== 'https:') {
    throw new Error('APP_BASE_URL must use https in production');
  }

  requireEnvFrom(env, 'SESSION_SECRET');
  requireEnvFrom(env, 'CSRF_SECRET', { allowInsecureDefault: true });
  requireEnvFrom(env, 'INIT_ADMIN_PASSWORD');

  const trustProxy = parseTrustProxy(env.TRUST_PROXY ?? env.APP_TRUST_PROXY);
  if (trustProxy === undefined || trustProxy === false || trustProxy === 0 || trustProxy === '0') {
    throw new Error('TRUST_PROXY (or APP_TRUST_PROXY) must be enabled in production behind a reverse proxy');
  }
}

export function resolveRuntimeConfig(env = process.env) {
  ensureProductionRuntimeConfig(env);

  const baseUrl = env.APP_BASE_URL || DEFAULT_BASE_URL;

  return {
    port: Number(env.PORT || env.APP_PORT || DEFAULT_PORT),
    baseUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY ?? env.APP_TRUST_PROXY),
    dbPath: path.resolve(env.APP_DB_PATH || './data/app.db'),
    authCachePath: path.resolve(env.AUTH_CACHE_DB_PATH || './data/auth-cache.db'),
    serverConfigPath: path.resolve(env.OVPN_SERVER_CONF_PATH || './data/server.conf'),
    exportDir: path.resolve(env.EXPORT_DIR || './data/exports'),
    bootstrapAdmin: {
      username: env.INIT_ADMIN_USERNAME || 'admin',
      password: env.INIT_ADMIN_PASSWORD || 'admin',
    },
    options: {
      sessionSecret: env.SESSION_SECRET,
      sessionCookieName: env.SESSION_COOKIE_NAME || DEFAULT_SESSION_COOKIE_NAME,
      baseUrl,
      instanceName: env.OVPN_INSTANCE_NAME || 'server',
      managementSocket: env.OVPN_MGMT_SOCKET || '/run/openvpn/server-management.sock',
      trustProxy: parseTrustProxy(env.TRUST_PROXY ?? env.APP_TRUST_PROXY),
      defaultRemote:
        env.OVPN_PUBLIC_HOST ||
        env.DEFAULT_REMOTE_HOST ||
        new URL(baseUrl).hostname,
    },
  };
}

export function createConfiguredApp(env = process.env) {
  const config = resolveRuntimeConfig(env);
  const repo = createRepository({
    dbPath: config.dbPath,
    authCachePath: config.authCachePath,
  });

  const { app, bootstrap } = createApp({
    repo,
    paths: {
      serverConfigPath: config.serverConfigPath,
      exportDir: config.exportDir,
    },
    bootstrapAdmin: config.bootstrapAdmin,
    options: config.options,
  });

  return { app, bootstrap, repo, config };
}

export async function bootstrapAndListen(env = process.env) {
  const { app, bootstrap, config } = createConfiguredApp(env);
  await bootstrap();

  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`openvpn-admin listening on ${config.port}`);
      resolve(server);
    });
  });
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  await bootstrapAndListen();
}
