import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { verifyPassword } from './auth-store.js';

export async function verifyCredentialsFromFile({ authCachePath, credentialsFile }) {
  const [username = '', password = ''] = fs.readFileSync(credentialsFile, 'utf8').split(/\r?\n/);
  const authDb = new DatabaseSync(authCachePath, { readonly: true });
  const user = authDb.prepare('SELECT * FROM auth_cache WHERE username = ?').get(username);

  if (!user) {
    return { ok: false, reason: 'USER_NOT_FOUND' };
  }

  if (user.status === 'disabled') {
    return { ok: false, reason: 'USER_DISABLED' };
  }

  if (user.status === 'deleted') {
    return { ok: false, reason: 'USER_DELETED' };
  }

  if (user.expires_at && new Date(user.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'USER_EXPIRED' };
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    return { ok: false, reason: 'INVALID_PASSWORD' };
  }

  return { ok: true, username };
}
