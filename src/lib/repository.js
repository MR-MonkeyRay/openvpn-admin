import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { canAuthenticate, hashPassword, verifyPassword } from './auth-store.js';

function nowIso() {
  return new Date().toISOString();
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function mapUser(row) {
  return row
    ? {
        ...row,
        expiresAt: row.expires_at,
        lastWebLoginAt: row.last_web_login_at,
        lastVpnLoginAt: row.last_vpn_login_at,
        lastProfileDownloadAt: row.last_profile_download_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export function createRepository({ dbPath, authCachePath }) {
  ensureParent(dbPath);
  ensureParent(authCachePath);

  const db = new DatabaseSync(dbPath);
  const authDb = new DatabaseSync(authCachePath);

  return {
    async migrate() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          display_name TEXT,
          note TEXT,
          expires_at TEXT,
          last_web_login_at TEXT,
          last_vpn_login_at TEXT,
          last_profile_download_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS config_versions (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          content_text TEXT NOT NULL,
          diff_summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          applied INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          actor_user_id TEXT,
          actor_role TEXT,
          action_type TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT,
          summary TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profile_exports (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          format TEXT NOT NULL,
          server_config_version_id TEXT,
          artifact_path TEXT NOT NULL,
          artifact_hash TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          downloaded_at TEXT
        );
      `);

      authDb.exec(`
        CREATE TABLE IF NOT EXISTS auth_cache (
          user_id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at TEXT,
          exported_at TEXT NOT NULL
        );
      `);
    },

    listUsers() {
      return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(mapUser);
    },

    findUserById(id) {
      return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    },

    findUserByUsername(username) {
      return mapUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
    },

    async createUser(input) {
      const user = {
        id: crypto.randomUUID(),
        username: input.username,
        passwordHash: await hashPassword(input.password),
        role: input.role ?? 'user',
        status: input.status ?? 'active',
        displayName: input.displayName ?? input.username,
        note: input.note ?? '',
        expiresAt: input.expiresAt ?? null,
        lastWebLoginAt: null,
        lastVpnLoginAt: null,
        lastProfileDownloadAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      db.prepare(`
        INSERT INTO users (
          id, username, password_hash, role, status, display_name, note,
          expires_at, last_web_login_at, last_vpn_login_at,
          last_profile_download_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.username,
        user.passwordHash,
        user.role,
        user.status,
        user.displayName,
        user.note,
        user.expiresAt,
        user.lastWebLoginAt,
        user.lastVpnLoginAt,
        user.lastProfileDownloadAt,
        user.createdAt,
        user.updatedAt,
      );

      syncAuthUser(authDb, user);
      return this.findUserById(user.id);
    },

    async resetPassword(userId, password) {
      const user = this.findUserById(userId);
      const passwordHash = await hashPassword(password);
      const updatedAt = nowIso();

      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, updatedAt, userId);

      const updated = { ...user, passwordHash, updatedAt };
      syncAuthUser(authDb, updated);
      return this.findUserById(userId);
    },

    disableUser(userId) {
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('disabled', nowIso(), userId);
      const user = this.findUserById(userId);
      syncAuthUser(authDb, user);
      return user;
    },

    enableUser(userId) {
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('active', nowIso(), userId);
      const user = this.findUserById(userId);
      syncAuthUser(authDb, user);
      return user;
    },

    deleteUser(userId) {
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('deleted', nowIso(), userId);
      const user = this.findUserById(userId);
      syncAuthUser(authDb, user);
      return user;
    },

    updateUser(userId, patch) {
      const current = this.findUserById(userId);
      const next = {
        ...current,
        displayName: patch.displayName ?? current.display_name ?? current.displayName,
        role: patch.role ?? current.role,
        status: patch.status ?? current.status,
        note: patch.note ?? current.note,
        expiresAt: patch.expiresAt ?? current.expires_at ?? current.expiresAt,
        updatedAt: nowIso(),
      };

      db.prepare(`
        UPDATE users
        SET display_name = ?, role = ?, status = ?, note = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(next.displayName, next.role, next.status, next.note, next.expiresAt, next.updatedAt, userId);

      syncAuthUser(authDb, next);
      return this.findUserById(userId);
    },

    getAuthUser(username) {
      return authDb.prepare('SELECT * FROM auth_cache WHERE username = ?').get(username);
    },

    async verifyUserCredentials(username, password) {
      const user = this.findUserByUsername(username);
      if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
      if (!canAuthenticate(user)) {
        return { ok: false, reason: user.status === 'disabled' ? 'USER_DISABLED' : 'USER_EXPIRED' };
      }

      const ok = await verifyPassword(password, user.password_hash ?? user.passwordHash);
      if (!ok) return { ok: false, reason: 'INVALID_PASSWORD' };

      this.recordWebLogin(user.id);
      return { ok: true, user: this.findUserById(user.id) };
    },

    recordWebLogin(userId, at = nowIso()) {
      db.prepare('UPDATE users SET last_web_login_at = ?, updated_at = ? WHERE id = ?').run(at, at, userId);
      return this.findUserById(userId);
    },

    recordVpnLogin(userId, at = nowIso()) {
      db.prepare('UPDATE users SET last_vpn_login_at = ?, updated_at = ? WHERE id = ?').run(at, at, userId);
      return this.findUserById(userId);
    },

    createAuditLog(entry) {
      const log = {
        id: crypto.randomUUID(),
        actorUserId: entry.actorUserId ?? null,
        actorRole: entry.actorRole ?? null,
        actionType: entry.actionType,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        summary: entry.summary,
        detailsJson: JSON.stringify(entry.details ?? {}),
        createdAt: nowIso(),
      };

      db.prepare(`
        INSERT INTO audit_logs (id, actor_user_id, actor_role, action_type, target_type, target_id, summary, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        log.id,
        log.actorUserId,
        log.actorRole,
        log.actionType,
        log.targetType,
        log.targetId,
        log.summary,
        log.detailsJson,
        log.createdAt,
      );

      return log;
    },

    listAuditLogs() {
      return db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100').all();
    },

    recordProfileExport(entry) {
      const record = {
        id: crypto.randomUUID(),
        userId: entry.userId,
        format: entry.format,
        artifactPath: entry.artifactPath,
        artifactHash: entry.artifactHash,
        createdBy: entry.createdBy,
        createdAt: nowIso(),
        downloadedAt: null,
      };

      db.prepare(`
        INSERT INTO profile_exports (id, user_id, format, artifact_path, artifact_hash, created_by, created_at, downloaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.userId,
        record.format,
        record.artifactPath,
        record.artifactHash,
        record.createdBy,
        record.createdAt,
        record.downloadedAt,
      );

      return record;
    },

    listProfileExports(userId = null) {
      if (userId) {
        return db.prepare('SELECT * FROM profile_exports WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      }
      return db.prepare('SELECT * FROM profile_exports ORDER BY created_at DESC LIMIT 50').all();
    },

    findProfileExport(exportId) {
      return db.prepare('SELECT * FROM profile_exports WHERE id = ?').get(exportId);
    },

    markProfileExportDownloaded(exportId, at = nowIso()) {
      const item = this.findProfileExport(exportId);
      if (!item) {
        return null;
      }

      db.prepare('UPDATE profile_exports SET downloaded_at = ? WHERE id = ?').run(at, exportId);
      db.prepare('UPDATE users SET last_profile_download_at = ?, updated_at = ? WHERE id = ?').run(at, at, item.user_id);
      return this.findProfileExport(exportId);
    },

    saveConfigVersion(entry) {
      const version = {
        id: crypto.randomUUID(),
        scope: entry.scope,
        contentText: entry.contentText,
        diffSummary: entry.diffSummary,
        createdAt: nowIso(),
        createdBy: entry.createdBy,
        applied: entry.applied ? 1 : 0,
      };

      db.prepare(`
        INSERT INTO config_versions (id, scope, content_text, diff_summary, created_at, created_by, applied)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        version.id,
        version.scope,
        version.contentText,
        version.diffSummary,
        version.createdAt,
        version.createdBy,
        version.applied,
      );

      return version;
    },

    listConfigVersions() {
      return db.prepare('SELECT * FROM config_versions ORDER BY created_at DESC LIMIT 20').all();
    },
  };
}

function syncAuthUser(authDb, user) {
  authDb.prepare(`
    INSERT INTO auth_cache (user_id, username, password_hash, status, expires_at, exported_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      password_hash = excluded.password_hash,
      status = excluded.status,
      expires_at = excluded.expires_at,
      exported_at = excluded.exported_at
  `).run(
    user.id,
    user.username,
    user.passwordHash ?? user.password_hash,
    user.status,
    user.expiresAt ?? user.expires_at ?? null,
    nowIso(),
  );
}
