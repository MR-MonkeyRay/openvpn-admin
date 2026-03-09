import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRepository } from '../src/lib/repository.js';
import { createConfigService } from '../src/lib/config-service.js';

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovpn-config-service-'));
  const repo = createRepository({
    dbPath: path.join(tempDir, 'app.db'),
    authCachePath: path.join(tempDir, 'auth-cache.db'),
  });

  return {
    tempDir,
    repo,
    service: createConfigService({
      serverConfigPath: path.join(tempDir, 'server.conf'),
      exportDir: path.join(tempDir, 'exports'),
      repo,
    }),
  };
}

test('config service bootstraps a runnable container-friendly server config', async () => {
  const { service, repo } = createFixture();
  await repo.migrate();

  const text = service.readRawConfig();

  assert.match(text, /management \/run\/openvpn\/server-management\.sock unix/);
  assert.match(text, /status \/etc\/openvpn\/server\/openvpn-status\.log/);
  assert.match(text, /ca \/etc\/openvpn\/server\/ca\.crt/);
  assert.match(text, /cert \/etc\/openvpn\/server\/server\.crt/);
  assert.match(text, /key \/etc\/openvpn\/server\/server\.key/);
  assert.match(text, /client-config-dir \/etc\/openvpn\/server\/ccd/);
});

test('config service exports profile with inline CA and tls-crypt data', async () => {
  const { service, repo, tempDir } = createFixture();
  await repo.migrate();

  fs.writeFileSync(path.join(tempDir, 'ca.crt'), 'CA_CERT_DATA\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'tls-crypt.key'), 'TLS_CRYPT_DATA\n', 'utf8');

  const user = await repo.createUser({ username: 'alice', password: 'vpn-pass', role: 'user' });
  service.readRawConfig();

  const generated = service.generateProfile({ user, remoteHost: 'vpn.example.com' });

  assert.match(generated.content, /<ca>CA_CERT_DATA<\/ca>/);
  assert.match(generated.content, /<tls-crypt>TLS_CRYPT_DATA<\/tls-crypt>/);
  assert.match(generated.content, /tls-crypt inline/);
  assert.doesNotMatch(generated.content, /PLACEHOLDER_/);
});

test('config service preview/apply/rollback preserves versions and form values', async () => {
  const { service, repo } = createFixture();
  await repo.migrate();
  service.readRawConfig();

  const form = {
    bindAddress: '127.0.0.1',
    port: '443',
    protocol: 'tcp',
    network: '10.9.0.0 255.255.255.0',
    dnsServers: '9.9.9.9,1.1.1.1',
    pushRoutes: '10.20.0.0 255.255.0.0,10.30.0.0 255.255.0.0',
    cipher: 'AES-256-GCM:AES-128-GCM',
    auth: 'SHA512',
    ccdPath: '/custom/ccd',
    logPath: '/custom/openvpn.log',
    tlsMode: 'tls-auth',
    keepalive: '20 60',
    rawExtra: 'explicit-exit-notify 1',
  };

  const preview = service.preview(form);
  assert.match(preview.diff, /\+ port 443/);
  assert.match(preview.afterText, /tls-auth \/etc\/openvpn\/server\/tls-auth\.key 0/);
  assert.match(preview.afterText, /push "route 10\.20\.0\.0 255\.255\.0\.0"/);
  assert.match(preview.afterText, /explicit-exit-notify 1/);

  const applied = service.apply(form, 'worker-3');
  assert.equal(applied.version.createdBy, 'worker-3');
  assert.equal(applied.version.applied, 1);

  const savedForm = service.readConfigForm();
  assert.equal(savedForm.bindAddress, '127.0.0.1');
  assert.equal(savedForm.port, '443');
  assert.equal(savedForm.protocol, 'tcp');
  assert.equal(savedForm.dnsServers, '9.9.9.9,1.1.1.1');
  assert.equal(savedForm.pushRoutes, '10.20.0.0 255.255.0.0,10.30.0.0 255.255.0.0');
  assert.equal(savedForm.tlsMode, 'tls-auth');
  assert.match(savedForm.rawExtra, /script-security 2/);
  assert.match(savedForm.rawExtra, /explicit-exit-notify 1/);

  const initialVersionId = repo.listConfigVersions().find((entry) => entry.created_by === 'worker-3')?.id;
  assert.ok(initialVersionId);

  const reverted = service.rollback(initialVersionId);
  assert.equal(reverted.id, initialVersionId);
  assert.match(service.readRawConfig(), /port 443/);
});
