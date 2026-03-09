import crypto from 'node:crypto';

const ARGON_MEMORY = 65536;
const ARGON_PASSES = 3;
const ARGON_PARALLELISM = 1;
const ARGON_TAG_LENGTH = 32;

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix = 'usr') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = await argon2(password, salt);
  return [
    'argon2id',
    ARGON_MEMORY,
    ARGON_PASSES,
    ARGON_PARALLELISM,
    salt.toString('hex'),
    digest.toString('hex'),
  ].join('$');
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;

  const [kind, memory, passes, parallelism, saltHex, digestHex] = storedHash.split('$');
  if (kind !== 'argon2id' || !memory || !passes || !parallelism || !saltHex || !digestHex) {
    return false;
  }

  const actualDigest = await argon2(password, Buffer.from(saltHex, 'hex'), {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
  });

  return crypto.timingSafeEqual(actualDigest, Buffer.from(digestHex, 'hex'));
}

export async function createUser(store, input) {
  const user = {
    id: generateId(),
    username: input.username,
    passwordHash: await hashPassword(input.password),
    role: input.role ?? 'user',
    status: 'active',
    displayName: input.displayName ?? input.username,
    note: input.note ?? '',
    expiresAt: input.expiresAt ?? null,
    lastWebLoginAt: null,
    lastVpnLoginAt: null,
    lastProfileDownloadAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  store.users.push(user);
  return user;
}

export async function resetPassword(store, userId, password) {
  const user = requireUser(store, userId);
  user.passwordHash = await hashPassword(password);
  user.updatedAt = nowIso();
  return user;
}

export function disableUser(store, userId) {
  const user = requireUser(store, userId);
  user.status = 'disabled';
  user.updatedAt = nowIso();
  return user;
}

export function exportAuthCache(store) {
  return store.users.map((user) => ({
    userId: user.id,
    username: user.username,
    passwordHash: user.passwordHash,
    status: user.status,
    expiresAt: user.expiresAt,
    exportedAt: nowIso(),
  }));
}

export function canAuthenticate(user) {
  if (!user) return false;
  if (user.status !== 'active') return false;
  if (!user.expiresAt) return true;
  return new Date(user.expiresAt).getTime() > Date.now();
}

function requireUser(store, userId) {
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }
  return user;
}

function argon2(password, salt, options = {}) {
  return new Promise((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      {
        message: Buffer.from(password),
        nonce: salt,
        parallelism: options.parallelism ?? ARGON_PARALLELISM,
        tagLength: ARGON_TAG_LENGTH,
        memory: options.memory ?? ARGON_MEMORY,
        passes: options.passes ?? ARGON_PASSES,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}
