import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepository } from '../src/lib/repository.js';
import { createApp } from '../src/app.js';

// 用于不需要 HTTP 请求的测试（如 trust proxy 测试）
function createFixture({ withAdmin = false, appOptions } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-http-'));
  const repo = createRepository({
    dbPath: path.join(tempDir, 'app.db'),
    authCachePath: path.join(tempDir, 'auth-cache.db'),
  });
  const { app, bootstrap } = createApp({
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
    options: appOptions,
  });

  return { tempDir, repo, app, bootstrap };
}

// 启动真实 HTTP 服务
async function startApp(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-http-'));
  const repo = createRepository({
    dbPath: path.join(tempDir, 'app.db'),
    authCachePath: path.join(tempDir, 'auth-cache.db'),
  });
  const { app, bootstrap } = createApp({
    repo,
    paths: {
      serverConfigPath: path.join(tempDir, 'server.conf'),
      exportDir: path.join(tempDir, 'exports'),
    },
    bootstrapAdmin: options.withAdmin ? { username: 'admin', password: 'admin-pass' } : null,
    options: options.appOptions,
  });
  await bootstrap();
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { tempDir, repo, app, server, baseUrl };
}

// 获取 CSRF token（需要先获取 session cookie）
async function getCsrf(baseUrl, cookieJar = '') {
  const res = await fetch(`${baseUrl}/api/auth/csrf`, {
    headers: cookieJar ? { cookie: cookieJar } : {},
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookies = cookieJar
    ? cookieJar
    : setCookie.map(c => c.split(';')[0]).join('; ');
  const { csrfToken } = await res.json();
  return { csrfToken, cookies };
}

// 管理员登录，返回 cookies
async function adminLogin(baseUrl) {
  const { csrfToken, cookies } = await getCsrf(baseUrl);
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      cookie: cookies,
    },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass' }),
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const newCookies = setCookie.length
    ? setCookie.map(c => c.split(';')[0]).join('; ')
    : cookies;
  const body = await res.json();
  return { body, cookies: newCookies, status: res.status };
}

test('health endpoint responds ok', async (t) => {
  const fixture = await startApp();
  t.after(() => fixture.server.close());

  const res = await fetch(`${fixture.baseUrl}/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { status: 'ok', service: 'openvpn-admin' });
  assert.equal(fixture.repo.listUsers().length, 0);
});

test('admin can log in and create a user via API', async (t) => {
  const fixture = await startApp({ withAdmin: true });
  t.after(() => fixture.server.close());

  // 登录
  const loginResult = await adminLogin(fixture.baseUrl);
  assert.equal(loginResult.status, 200);
  assert.equal(loginResult.body.ok, true);

  // 创建用户
  const { csrfToken, cookies } = await getCsrf(fixture.baseUrl, loginResult.cookies);
  const createRes = await fetch(`${fixture.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      cookie: cookies,
    },
    body: JSON.stringify({ username: 'alice', password: 'vpn-pass', role: 'user' }),
  });
  const createBody = await createRes.json();

  assert.equal(createRes.status, 201);
  assert.equal(createBody.user.username, 'alice');
  assert.equal(fixture.repo.getAuthUser('alice').status, 'active');
});

test('api mutation rejects missing csrf token', async (t) => {
  const fixture = await startApp({ withAdmin: true });
  t.after(() => fixture.server.close());

  // 先登录获取 session cookie
  const { cookies } = await adminLogin(fixture.baseUrl);

  // 不带 CSRF token 发送请求
  const res = await fetch(`${fixture.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookies,
    },
    body: JSON.stringify({ username: 'mallory', password: 'vpn-pass', role: 'user' }),
  });
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.deepEqual(body, { ok: false, reason: 'CSRF_INVALID' });
});

test('api csrf token endpoint returns a session token', async (t) => {
  const fixture = await startApp();
  t.after(() => fixture.server.close());

  const res = await fetch(`${fixture.baseUrl}/api/auth/csrf`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(typeof body.csrfToken, 'string');
});

test('config rollback writes an audit log entry', async (t) => {
  const fixture = await startApp({ withAdmin: true });
  t.after(() => fixture.server.close());

  // 创建一个配置版本
  const version = fixture.repo.saveConfigVersion({
    scope: 'server',
    contentText: 'port 1194',
    diffSummary: 'initial',
    createdBy: 'admin',
    applied: true,
  });

  // 登录并执行 rollback
  const { cookies } = await adminLogin(fixture.baseUrl);
  const { csrfToken } = await getCsrf(fixture.baseUrl, cookies);

  const res = await fetch(`${fixture.baseUrl}/config/rollback/${version.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      cookie: cookies,
    },
    body: JSON.stringify({}),
    redirect: 'manual',
  });

  // 验证重定向到 /config
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/config');

  // 验证审计日志
  const auditLog = fixture.repo.listAuditLogs().find((entry) => entry.action_type === 'config.rollback');
  assert.ok(auditLog);
  assert.equal(auditLog.target_id, version.id);
});

test('profile download marks export as downloaded', async (t) => {
  const fixture = await startApp({ withAdmin: true });
  t.after(() => fixture.server.close());

  // 准备 profile export 记录
  const admin = fixture.repo.findUserByUsername('admin');
  const artifactPath = path.join(fixture.tempDir, 'exports', 'admin.ovpn');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'client', 'utf8');

  const record = fixture.repo.recordProfileExport({
    userId: admin.id,
    format: 'inline_ovpn',
    artifactPath,
    artifactHash: 'hash',
    createdBy: 'admin',
  });

  // 登录并下载 profile
  const { cookies } = await adminLogin(fixture.baseUrl);

  const res = await fetch(`${fixture.baseUrl}/api/profiles/${record.id}/download`, {
    headers: { cookie: cookies },
  });

  assert.equal(res.status, 200);
  const content = await res.text();
  assert.equal(content, 'client');

  // 验证 downloaded_at 被更新
  const downloaded = fixture.repo.findProfileExport(record.id);
  assert.ok(downloaded.downloaded_at);
  assert.equal(fixture.repo.findUserById(admin.id).lastProfileDownloadAt, downloaded.downloaded_at);
});

test('app enables trust proxy when configured', async () => {
  const { app, bootstrap } = createFixture({ appOptions: { trustProxy: 1, sessionSecret: 'unit-test-secret' } });
  await bootstrap();

  assert.equal(app.get('trust proxy'), 1);
});

test('unauthenticated api request returns 401 json', async (t) => {
  const fixture = await startApp({ withAdmin: true });
  t.after(() => fixture.server.close());

  const res = await fetch(`${fixture.baseUrl}/api/users`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'AUTH_REQUIRED' });
});

test('non-admin api request returns 403 json', async (t) => {
  const fixture = await startApp({ withAdmin: true });
  t.after(() => fixture.server.close());

  // 先创建普通用户
  const { cookies: adminCookies } = await adminLogin(fixture.baseUrl);
  const { csrfToken } = await getCsrf(fixture.baseUrl, adminCookies);
  await fetch(`${fixture.baseUrl}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, cookie: adminCookies },
    body: JSON.stringify({ username: 'alice', password: 'pass123', role: 'user' }),
  });

  // 用普通用户登录
  const { csrfToken: csrfForLogin, cookies: freshCookies } = await getCsrf(fixture.baseUrl);
  const loginRes = await fetch(`${fixture.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfForLogin, cookie: freshCookies },
    body: JSON.stringify({ username: 'alice', password: 'pass123' }),
    redirect: 'manual',
  });
  const setCookie = loginRes.headers.getSetCookie?.() ?? [];
  const aliceCookies = setCookie.length ? setCookie.map(c => c.split(';')[0]).join('; ') : freshCookies;

  // 用普通用户访问管理 API
  const res = await fetch(`${fixture.baseUrl}/api/users`, {
    headers: { cookie: aliceCookies },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'FORBIDDEN' });
});

test('api 404 returns json and web 404 returns text', async (t) => {
  const fixture = await startApp({});
  t.after(() => fixture.server.close());

  // API 404
  const apiRes = await fetch(`${fixture.baseUrl}/api/nonexistent`);
  assert.equal(apiRes.status, 404);
  const apiBody = await apiRes.json();
  assert.deepEqual(apiBody, { ok: false, reason: 'NOT_FOUND' });

  // Web 404
  const webRes = await fetch(`${fixture.baseUrl}/nonexistent-page`);
  assert.equal(webRes.status, 404);
  const webBody = await webRes.text();
  assert.equal(webBody, 'Not Found');
});

test('web logout redirects and api logout returns json', async (t) => {
  const fixture = await startApp({ withAdmin: true });
  t.after(() => fixture.server.close());

  // API logout
  const { cookies: apiCookies } = await adminLogin(fixture.baseUrl);
  const { csrfToken: apiCsrf } = await getCsrf(fixture.baseUrl, apiCookies);
  const apiLogoutRes = await fetch(`${fixture.baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { 'x-csrf-token': apiCsrf, cookie: apiCookies },
    redirect: 'manual',
  });
  assert.equal(apiLogoutRes.status, 200);
  const apiBody = await apiLogoutRes.json();
  assert.deepEqual(apiBody, { ok: true });

  // Web logout
  const { cookies: webCookies } = await adminLogin(fixture.baseUrl);
  const { csrfToken: webCsrf } = await getCsrf(fixture.baseUrl, webCookies);
  const webLogoutRes = await fetch(`${fixture.baseUrl}/auth/logout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: webCookies,
    },
    body: `csrfToken=${webCsrf}`,
    redirect: 'manual',
  });
  assert.equal(webLogoutRes.status, 302);
  assert.ok(webLogoutRes.headers.get('location')?.includes('/login'));
});

test('root path redirects to login when unauthenticated', async (t) => {
  const fixture = await startApp({});
  t.after(() => fixture.server.close());

  const res = await fetch(`${fixture.baseUrl}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});
