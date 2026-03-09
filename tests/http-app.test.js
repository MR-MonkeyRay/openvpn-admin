import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepository } from '../src/lib/repository.js';
import { createApp } from '../src/app.js';

function createFixture({ withAdmin = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-http-'));
  const repo = createRepository({
    dbPath: path.join(tempDir, 'app.db'),
    authCachePath: path.join(tempDir, 'auth-cache.db'),
  });
  const app = createApp({
    repo,
    paths: {
      serverConfigPath: path.join(tempDir, 'server.conf'),
      exportDir: path.join(tempDir, 'exports'),
    },
    bootstrapAdmin: withAdmin
      ? {
          username: 'admin',
          password: 'admin-pass',
        }
      : null,
  });

  return { tempDir, repo, app };
}

function findRoute(app, matcher) {
  return app.router.stack.find((layer) => layer.route && matcher(layer.route));
}

async function invokeHandlers(handlers, req, res) {
  for (let index = 0; index < handlers.length; index += 1) {
    const handler = handlers[index].handle;

    await new Promise((resolve, reject) => {
      let settled = false;
      const next = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      try {
        const result = handler(req, res, next);
        if (result && typeof result.then === 'function') {
          result.then(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          }).catch((error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
          return;
        }

        if (handler.length < 3 && !settled) {
          settled = true;
          resolve();
          return;
        }

        if (res.finished && !settled) {
          settled = true;
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });

    if (res.finished) {
      break;
    }
  }
}

function createReq(overrides = {}) {
  const headers = Object.fromEntries(
    Object.entries(overrides.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    body: {},
    params: {},
    query: {},
    session: {},
    path: '/',
    headers,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
    ...overrides,
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    redirect(location) {
      this.redirectTo = location;
      this.finished = true;
      return this;
    },
    download(filePath) {
      this.downloadedPath = filePath;
      this.finished = true;
      return this;
    },
  };
}

function withCsrf(session = {}) {
  const csrfToken = 'test-csrf-token';
  return {
    session: { ...session, csrfToken },
    csrfToken,
  };
}

test('health endpoint responds ok', async () => {
  const { app, repo } = createFixture();
  await app.locals.bootstrap();

  const route = findRoute(app, (route) => route.path === '/health');
  const req = createReq();
  const res = createRes();

  await invokeHandlers(route.route.stack, req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: 'ok', service: 'openvpn-admin' });
  assert.equal(repo.listUsers().length, 0);
});

test('admin can log in and create a user via API', async () => {
  const { app, repo } = createFixture({ withAdmin: true });
  await app.locals.bootstrap();

  const loginRoute = findRoute(app, (route) => Array.isArray(route.path) && route.path.includes('/api/auth/login'));
  const loginCsrf = withCsrf();
  const loginReq = createReq({
    path: '/api/auth/login',
    body: { username: 'admin', password: 'admin-pass', csrfToken: loginCsrf.csrfToken },
    session: loginCsrf.session,
  });
  const loginRes = createRes();

  await invokeHandlers(loginRoute.route.stack, loginReq, loginRes);

  assert.equal(loginRes.statusCode, 200);
  assert.equal(loginRes.body.ok, true);
  assert.equal(loginReq.session.role, 'admin');
  assert.ok(loginReq.session.userId);
  assert.ok(repo.findUserById(loginReq.session.userId).lastWebLoginAt);

  const createUserRoute = findRoute(
    app,
    (route) => Array.isArray(route.path) && route.path.includes('/api/users') && route.methods.post,
  );
  const createUserCsrf = withCsrf({
    userId: loginReq.session.userId,
    role: loginReq.session.role,
  });
  const createReqPayload = createReq({
    path: '/api/users',
    body: { username: 'alice', password: 'vpn-pass', role: 'user', csrfToken: createUserCsrf.csrfToken },
    session: createUserCsrf.session,
  });
  const createResPayload = createRes();

  await invokeHandlers(createUserRoute.route.stack, createReqPayload, createResPayload);

  assert.equal(createResPayload.statusCode, 201);
  assert.equal(createResPayload.body.user.username, 'alice');
  assert.equal(repo.getAuthUser('alice').status, 'active');
});

test('api mutation rejects missing csrf token', async () => {
  const { app } = createFixture({ withAdmin: true });
  await app.locals.bootstrap();

  const route = findRoute(app, (currentRoute) => Array.isArray(currentRoute.path) && currentRoute.path.includes('/api/users'));
  const req = createReq({
    path: '/api/users',
    body: { username: 'mallory', password: 'vpn-pass', role: 'user' },
    session: { userId: 'admin-id', role: 'admin', csrfToken: 'expected-token' },
  });
  const res = createRes();

  await invokeHandlers(route.route.stack, req, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { ok: false, reason: 'CSRF_INVALID' });
});

test('api csrf token endpoint returns a session token', async () => {
  const { app } = createFixture();
  await app.locals.bootstrap();

  const route = findRoute(app, (currentRoute) => currentRoute.path === '/api/auth/csrf');
  const req = createReq({ path: '/api/auth/csrf', session: {} });
  const res = createRes();

  await invokeHandlers(route.route.stack, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.csrfToken, 'string');
  assert.equal(req.session.csrfToken, res.body.csrfToken);
});

test('config rollback writes an audit log entry', async () => {
  const { app, repo } = createFixture({ withAdmin: true });
  await app.locals.bootstrap();

  const version = repo.saveConfigVersion({
    scope: 'server',
    contentText: 'port 1194',
    diffSummary: 'initial',
    createdBy: 'admin',
    applied: true,
  });
  const currentAdmin = repo.findUserByUsername('admin');
  const csrf = withCsrf({ userId: currentAdmin.id, role: 'admin' });
  const route = findRoute(app, (currentRoute) => currentRoute.path === '/config/rollback/:versionId');
  const req = createReq({
    path: `/config/rollback/${version.id}`,
    params: { versionId: version.id },
    body: { csrfToken: csrf.csrfToken },
    session: csrf.session,
    flash(type, message) {
      this.lastFlash = { type, message };
    },
  });
  const res = createRes();

  await invokeHandlers(route.route.stack, req, res);

  assert.equal(res.redirectTo, '/config');
  const auditLog = repo.listAuditLogs().find((entry) => entry.action_type === 'config.rollback');
  assert.ok(auditLog);
  assert.equal(auditLog.target_id, version.id);
});

test('profile download marks export as downloaded', async () => {
  const { app, repo, tempDir } = createFixture({ withAdmin: true });
  await app.locals.bootstrap();

  const admin = repo.findUserByUsername('admin');
  const artifactPath = path.join(tempDir, 'exports', 'admin.ovpn');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'client', 'utf8');

  const record = repo.recordProfileExport({
    userId: admin.id,
    format: 'inline_ovpn',
    artifactPath,
    artifactHash: 'hash',
    createdBy: 'admin',
  });

  const route = findRoute(app, (currentRoute) => currentRoute.path === '/api/profiles/:id/download');
  const req = createReq({
    path: `/api/profiles/${record.id}/download`,
    params: { id: record.id },
    session: { userId: admin.id, role: 'admin' },
  });
  const res = createRes();

  await invokeHandlers(route.route.stack, req, res);

  assert.equal(res.downloadedPath, artifactPath);
  const downloaded = repo.findProfileExport(record.id);
  assert.ok(downloaded.downloaded_at);
  assert.equal(repo.findUserById(admin.id).lastProfileDownloadAt, downloaded.downloaded_at);
});

test('app enables trust proxy when configured', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-http-'));
  const repo = createRepository({
    dbPath: path.join(tempDir, 'app.db'),
    authCachePath: path.join(tempDir, 'auth-cache.db'),
  });
  const app = createApp({
    repo,
    paths: {
      serverConfigPath: path.join(tempDir, 'server.conf'),
      exportDir: path.join(tempDir, 'exports'),
    },
    options: {
      trustProxy: 1,
      sessionSecret: 'unit-test-secret',
    },
  });

  await app.locals.bootstrap();

  assert.equal(app.get('trust proxy'), 1);
});
