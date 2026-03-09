#!/usr/bin/env node

import { verifyCredentialsFromFile } from '../src/lib/auth-verify.js';

const credentialsFile = process.argv[2];
const authCachePath = process.env.AUTH_CACHE_DB_PATH || '/var/lib/openvpn-admin/auth-cache.db';

if (!credentialsFile) {
  process.exit(64);
}

try {
  const result = await verifyCredentialsFromFile({ authCachePath, credentialsFile });
  process.exit(result.ok ? 0 : 1);
} catch {
  process.exit(70);
}
