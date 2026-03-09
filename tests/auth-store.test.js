import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canAuthenticate,
  createUser,
  disableUser,
  exportAuthCache,
  resetPassword,
  verifyPassword,
} from '../src/lib/auth-store.js';

test('createUser exports cache and verifies password', async () => {
  const store = { users: [] };

  const user = await createUser(store, {
    username: 'alice',
    password: 'secret-123',
    role: 'user',
  });

  assert.equal(user.username, 'alice');
  assert.equal(user.role, 'user');
  assert.equal(store.users.length, 1);
  assert.equal(await verifyPassword('secret-123', user.passwordHash), true);

  const cache = exportAuthCache(store);
  assert.deepEqual(cache[0].username, 'alice');
  assert.equal(cache[0].status, 'active');
});

test('disabled users no longer authenticate and password reset updates hash', async () => {
  const store = { users: [] };

  const user = await createUser(store, {
    username: 'bob',
    password: 'old-pass',
    role: 'user',
  });

  const updated = await resetPassword(store, user.id, 'new-pass');
  assert.equal(await verifyPassword('new-pass', updated.passwordHash), true);
  assert.equal(await verifyPassword('old-pass', updated.passwordHash), false);

  const disabled = disableUser(store, user.id);
  assert.equal(disabled.status, 'disabled');

  const cache = exportAuthCache(store);
  assert.equal(cache[0].status, 'disabled');
});

test('verifyPassword rejects malformed hashes and canAuthenticate enforces status and expiry', async () => {
  const store = { users: [] };
  const activeUser = await createUser(store, {
    username: 'carol',
    password: 'expires-pass',
    role: 'user',
  });

  assert.equal(await verifyPassword('expires-pass', 'bad-format-hash'), false);
  assert.equal(canAuthenticate(activeUser), true);

  const expiredUser = {
    ...activeUser,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };
  assert.equal(canAuthenticate(expiredUser), false);

  const futureUser = {
    ...activeUser,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.equal(canAuthenticate(futureUser), true);

  const disabledUser = {
    ...activeUser,
    status: 'disabled',
  };
  assert.equal(canAuthenticate(disabledUser), false);
});
