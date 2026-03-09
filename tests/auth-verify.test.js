import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createRepository } from '../src/lib/repository.js';
import { verifyCredentialsFromFile } from '../src/lib/auth-verify.js';

function createFixture(prefix = 'ovpn-auth-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const authCachePath = path.join(tempDir, 'auth-cache.db');
  const repo = createRepository({
    dbPath: path.join(tempDir, 'app.db'),
    authCachePath,
  });

  return { tempDir, authCachePath, repo };
}

test('auth_verify validates active user credentials from shared auth cache', async () => {
  const { tempDir, authCachePath, repo } = createFixture();
  await repo.migrate();
  await repo.createUser({ username: 'carol', password: 'vpn-pass', role: 'user' });

  const credentialsFile = path.join(tempDir, 'credentials.txt');
  fs.writeFileSync(credentialsFile, `carol\nvpn-pass\n`, 'utf8');

  const result = await verifyCredentialsFromFile({
    authCachePath,
    credentialsFile,
  });

  assert.equal(result.ok, true);
  assert.equal(result.username, 'carol');
});

test('auth_verify rejects disabled users', async () => {
  const { tempDir, authCachePath, repo } = createFixture();
  await repo.migrate();
  const user = await repo.createUser({ username: 'dave', password: 'vpn-pass', role: 'user' });
  repo.disableUser(user.id);

  const credentialsFile = path.join(tempDir, 'credentials.txt');
  fs.writeFileSync(credentialsFile, `dave\nvpn-pass\n`, 'utf8');

  const result = await verifyCredentialsFromFile({
    authCachePath,
    credentialsFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'USER_DISABLED');
});

test('auth_verify script returns EX_USAGE when credentials file arg is missing', () => {
  const result = spawnSync(process.execPath, ['scripts/auth_verify.mjs'], {
    cwd: path.join(process.cwd()),
  });

  assert.equal(result.status, 64);
});

test('auth_verify script returns EX_SOFTWARE when auth cache is unreadable', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-auth-script-'));
  const credentialsFile = path.join(tempDir, 'credentials.txt');
  fs.writeFileSync(credentialsFile, `erin\nsecret\n`, 'utf8');

  const result = spawnSync(process.execPath, ['scripts/auth_verify.mjs', credentialsFile], {
    cwd: path.join(process.cwd()),
    env: {
      ...process.env,
      AUTH_CACHE_DB_PATH: path.join(tempDir, 'missing', 'auth-cache.db'),
    },
  });

  assert.equal(result.status, 70);
});

test('auth_verify script returns 1 for invalid credentials', async () => {
  const { tempDir, authCachePath, repo } = createFixture('ovpn-auth-script-valid-');
  await repo.migrate();
  await repo.createUser({ username: 'frank', password: 'vpn-pass', role: 'user' });

  const credentialsFile = path.join(tempDir, 'credentials.txt');
  fs.writeFileSync(credentialsFile, `frank\nwrong-pass\n`, 'utf8');

  const result = spawnSync(process.execPath, ['scripts/auth_verify.mjs', credentialsFile], {
    cwd: path.join(process.cwd()),
    env: {
      ...process.env,
      AUTH_CACHE_DB_PATH: authCachePath,
    },
  });

  assert.equal(result.status, 1);
});
