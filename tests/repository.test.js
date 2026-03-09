import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepository } from '../src/lib/repository.js';

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-admin-'));
  return createRepository({
    dbPath: path.join(tempDir, 'app.db'),
    authCachePath: path.join(tempDir, 'auth-cache.db'),
  });
}

test('repository persists users and exports auth cache sqlite', async () => {
  const repo = createFixture();
  await repo.migrate();

  await repo.createUser({
    username: 'alice',
    password: 'secret-123',
    role: 'user',
    displayName: 'Alice',
  });

  const users = repo.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'alice');

  const authUser = repo.getAuthUser('alice');
  assert.equal(authUser.username, 'alice');
  assert.equal(authUser.status, 'active');
});

test('repository resets passwords and disables users', async () => {
  const repo = createFixture();
  await repo.migrate();
  const user = await repo.createUser({ username: 'bob', password: 'old-pass', role: 'user' });

  await repo.resetPassword(user.id, 'new-pass');
  const updated = repo.findUserById(user.id);
  assert.ok(updated.password_hash);

  repo.disableUser(user.id);
  const authUser = repo.getAuthUser('bob');
  assert.equal(authUser.status, 'disabled');
});

test('repository records web login separately from vpn login', async () => {
  const repo = createFixture();
  await repo.migrate();
  const user = await repo.createUser({ username: 'carol', password: 'vpn-pass', role: 'user' });

  const loginResult = await repo.verifyUserCredentials('carol', 'vpn-pass');
  assert.equal(loginResult.ok, true);

  const afterWebLogin = repo.findUserById(user.id);
  assert.ok(afterWebLogin.lastWebLoginAt);
  assert.equal(afterWebLogin.lastVpnLoginAt, null);

  const afterVpnLogin = repo.recordVpnLogin(user.id, '2026-03-09T00:00:00.000Z');
  assert.equal(afterVpnLogin.lastVpnLoginAt, '2026-03-09T00:00:00.000Z');
  assert.ok(afterVpnLogin.lastWebLoginAt);
});

test('repository keeps profile export and download timestamps distinct', async () => {
  const repo = createFixture();
  await repo.migrate();
  const user = await repo.createUser({ username: 'dave', password: 'vpn-pass', role: 'user' });

  const exported = repo.recordProfileExport({
    userId: user.id,
    format: 'inline_ovpn',
    artifactPath: '/tmp/dave.ovpn',
    artifactHash: 'abc123',
    createdBy: 'admin',
  });

  const afterExport = repo.findUserById(user.id);
  assert.equal(afterExport.lastProfileDownloadAt, null);
  assert.equal(exported.downloadedAt, null);

  const downloaded = repo.markProfileExportDownloaded(exported.id, '2026-03-09T01:02:03.000Z');
  assert.equal(downloaded.downloaded_at, '2026-03-09T01:02:03.000Z');

  const afterDownload = repo.findUserById(user.id);
  assert.equal(afterDownload.lastProfileDownloadAt, '2026-03-09T01:02:03.000Z');
});
