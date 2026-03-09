import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildClientProfile, buildServerConfig, diffText, parseServerConfig } from './openvpn-config.js';

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

export function createConfigService({ serverConfigPath, exportDir, repo }) {
  ensureParent(serverConfigPath);
  fs.mkdirSync(exportDir, { recursive: true });
  const serverDir = path.dirname(serverConfigPath);

  return {
    readRawConfig() {
      if (!fs.existsSync(serverConfigPath)) {
        const initial = buildServerConfig(defaultConfig());
        fs.writeFileSync(serverConfigPath, `${initial}\n`, 'utf8');
      }

      return fs.readFileSync(serverConfigPath, 'utf8');
    },

    readConfigForm() {
      const parsed = parseServerConfig(this.readRawConfig());
      return {
        version: repo.listConfigVersions()[0]?.id ?? 'bootstrap',
        bindAddress: parsed.local ?? '0.0.0.0',
        port: parsed.port,
        protocol: parsed.proto,
        network: parsed.serverNetwork,
        dnsServers: extractDns(parsed.pushRules).join(','),
        pushRoutes: extractRoutes(parsed.pushRules).join(','),
        cipher: parsed.dataCiphers,
        dataCiphers: parsed.dataCiphers,
        auth: parsed.auth,
        ccdPath: parsed.ccdPath ?? '/etc/openvpn/server/ccd',
        logPath: parsed.logPath ?? '/etc/openvpn/server/openvpn.log',
        tlsMode: parsed.tlsMode ?? 'tls-crypt',
        keepalive: parsed.keepalive ?? '10 120',
        rawExtra: parsed.rawExtra ?? '',
      };
    },

    buildCandidate(form) {
      const pushRules = [];

      for (const item of splitCsv(form.pushRoutes)) {
        pushRules.push(`route ${item}`);
      }

      for (const dns of splitCsv(form.dnsServers)) {
        pushRules.push(`dhcp-option DNS ${dns}`);
      }

      if (form.redirectGateway !== false) {
        pushRules.unshift('redirect-gateway def1 bypass-dhcp');
      }

      return buildServerConfig({
        local: form.bindAddress || '0.0.0.0',
        port: String(form.port || '1194'),
        proto: form.protocol || 'udp',
        dev: 'tun',
        serverNetwork: form.network || '10.8.0.0 255.255.255.0',
        auth: form.auth || 'SHA256',
        dataCiphers: form.cipher || form.dataCiphers || 'AES-256-GCM:AES-128-GCM',
        verifyClientCert: 'none',
        usernameAsCommonName: true,
        authUserPassVerify: '/etc/openvpn/scripts/auth_verify via-file',
        ccdPath: form.ccdPath || '/etc/openvpn/server/ccd',
        keepalive: form.keepalive || '10 120',
        managementSocket: '/run/openvpn/server-management.sock',
        statusPath: '/etc/openvpn/server/openvpn-status.log',
        logPath: form.logPath || '/etc/openvpn/server/openvpn.log',
        caPath: '/etc/openvpn/server/ca.crt',
        certPath: '/etc/openvpn/server/server.crt',
        keyPath: '/etc/openvpn/server/server.key',
        tlsMode: form.tlsMode || 'tls-crypt',
        tlsCryptPath: '/etc/openvpn/server/tls-crypt.key',
        tlsAuthPath: '/etc/openvpn/server/tls-auth.key',
        pushRules,
        rawExtra: form.rawExtra || '',
      });
    },

    preview(form) {
      const beforeText = this.readRawConfig();
      const afterText = this.buildCandidate(form);
      return {
        beforeText,
        afterText,
        diff: diffText(beforeText.trim(), afterText.trim()),
      };
    },

    save(form, actor = 'system') {
      const preview = this.preview(form);
      fs.writeFileSync(serverConfigPath, `${preview.afterText}\n`, 'utf8');
      repo.saveConfigVersion({
        scope: 'server',
        contentText: preview.afterText,
        diffSummary: summarizeDiff(preview.diff),
        createdBy: actor,
        applied: false,
      });
      return preview;
    },

    apply(form, actor = 'system') {
      const preview = this.preview(form);
      fs.writeFileSync(serverConfigPath, `${preview.afterText}\n`, 'utf8');
      const version = repo.saveConfigVersion({
        scope: 'server',
        contentText: preview.afterText,
        diffSummary: summarizeDiff(preview.diff),
        createdBy: actor,
        applied: true,
      });
      return { ...preview, version };
    },

    rollback(versionId) {
      const version = repo.listConfigVersions().find((item) => item.id === versionId);
      if (!version) throw new Error(`Config version not found: ${versionId}`);
      fs.writeFileSync(serverConfigPath, `${version.content_text}\n`, 'utf8');
      return version;
    },

    generateProfile({ user, remoteHost, format = 'inline_ovpn', actor = 'system' }) {
      const parsed = parseServerConfig(this.readRawConfig());
      const profileText = buildClientProfile({
        baseUrl: remoteHost,
        server: {
          ...parsed,
          caInline: wrapInlineBlock('ca', readRequiredAsset(path.join(serverDir, 'ca.crt'))),
          tlsCryptInline: parsed.tlsMode === 'tls-crypt'
            ? wrapInlineBlock('tls-crypt', readRequiredAsset(path.join(serverDir, 'tls-crypt.key')))
            : '',
        },
      });

      const extension = format === 'zip' ? 'zip' : 'ovpn';
      const fileName = `${user.username}-${Date.now()}.${extension}`;
      const artifactPath = path.join(exportDir, fileName);
      fs.writeFileSync(artifactPath, profileText, 'utf8');

      const artifactHash = crypto.createHash('sha256').update(profileText).digest('hex');
      repo.recordProfileExport({
        userId: user.id,
        format,
        artifactPath,
        artifactHash,
        createdBy: actor,
      });

      return { artifactPath, artifactHash, content: profileText, format };
    },
  };
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractDns(rules) {
  return rules
    .filter((rule) => rule.startsWith('dhcp-option DNS '))
    .map((rule) => rule.replace('dhcp-option DNS ', ''));
}

function extractRoutes(rules) {
  return rules
    .filter((rule) => rule.startsWith('route '))
    .map((rule) => rule.replace('route ', ''));
}

function summarizeDiff(diff) {
  const lines = diff.split('\n').filter((line) => line.startsWith('+ ') || line.startsWith('- '));
  return lines.slice(0, 4).join(' | ') || 'No material changes';
}

function readRequiredAsset(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required OpenVPN asset not found: ${filePath}`);
  }

  return fs.readFileSync(filePath, 'utf8').trim();
}

function wrapInlineBlock(tag, content) {
  return `<${tag}>${content}</${tag}>`;
}

function defaultConfig() {
  return {
    local: '0.0.0.0',
    port: '1194',
    proto: 'udp',
    serverNetwork: '10.8.0.0 255.255.255.0',
    auth: 'SHA256',
    dataCiphers: 'AES-256-GCM:AES-128-GCM',
    verifyClientCert: 'none',
    usernameAsCommonName: true,
    authUserPassVerify: '/etc/openvpn/scripts/auth_verify via-file',
    ccdPath: '/etc/openvpn/server/ccd',
    keepalive: '10 120',
    managementSocket: '/run/openvpn/server-management.sock',
    statusPath: '/etc/openvpn/server/openvpn-status.log',
    logPath: '/etc/openvpn/server/openvpn.log',
    caPath: '/etc/openvpn/server/ca.crt',
    certPath: '/etc/openvpn/server/server.crt',
    keyPath: '/etc/openvpn/server/server.key',
    tlsMode: 'tls-crypt',
    tlsCryptPath: '/etc/openvpn/server/tls-crypt.key',
    tlsAuthPath: '/etc/openvpn/server/tls-auth.key',
    pushRules: ['redirect-gateway def1 bypass-dhcp', 'dhcp-option DNS 1.1.1.1'],
    rawExtra: '',
  };
}
