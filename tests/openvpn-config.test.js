import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClientProfile,
  buildServerConfig,
  diffText,
  parseServerConfig,
} from '../src/lib/openvpn-config.js';

test('parseServerConfig extracts supported directives', () => {
  const configText = [
    'port 1194',
    'proto udp',
    'server 10.8.0.0 255.255.255.0',
    'management /run/openvpn/server-management.sock unix',
    'status /etc/openvpn/server/openvpn-status.log',
    'ca /etc/openvpn/server/ca.crt',
    'cert /etc/openvpn/server/server.crt',
    'key /etc/openvpn/server/server.key',
    'push "redirect-gateway def1 bypass-dhcp"',
    'push "dhcp-option DNS 1.1.1.1"',
    'verify-client-cert none',
    'username-as-common-name',
    'auth-user-pass-verify /etc/openvpn/scripts/auth_verify via-file',
  ].join('\n');

  const parsed = parseServerConfig(configText);

  assert.equal(parsed.port, '1194');
  assert.equal(parsed.proto, 'udp');
  assert.equal(parsed.serverNetwork, '10.8.0.0 255.255.255.0');
  assert.equal(parsed.verifyClientCert, 'none');
  assert.equal(parsed.usernameAsCommonName, true);
  assert.equal(parsed.authUserPassVerify, '/etc/openvpn/scripts/auth_verify via-file');
  assert.equal(parsed.managementSocket, '/run/openvpn/server-management.sock');
  assert.equal(parsed.statusPath, '/etc/openvpn/server/openvpn-status.log');
  assert.equal(parsed.caPath, '/etc/openvpn/server/ca.crt');
  assert.equal(parsed.certPath, '/etc/openvpn/server/server.crt');
  assert.equal(parsed.keyPath, '/etc/openvpn/server/server.key');
  assert.deepEqual(parsed.pushRules, [
    'redirect-gateway def1 bypass-dhcp',
    'dhcp-option DNS 1.1.1.1',
  ]);
});

test('buildServerConfig writes authentication directives for password-only mode', () => {
  const text = buildServerConfig({
    port: '1194',
    proto: 'udp',
    serverNetwork: '10.8.0.0 255.255.255.0',
    dev: 'tun',
    auth: 'SHA256',
    dataCiphers: 'AES-256-GCM:AES-128-GCM',
    verifyClientCert: 'none',
    usernameAsCommonName: true,
    authUserPassVerify: '/etc/openvpn/scripts/auth_verify via-file',
    pushRules: ['redirect-gateway def1 bypass-dhcp', 'dhcp-option DNS 1.1.1.1'],
  });

  assert.match(text, /verify-client-cert none/);
  assert.match(text, /username-as-common-name/);
  assert.match(text, /auth-user-pass-verify \/etc\/openvpn\/scripts\/auth_verify via-file/);
  assert.match(text, /management \/run\/openvpn\/server-management\.sock unix/);
  assert.match(text, /status \/etc\/openvpn\/server\/openvpn-status\.log/);
  assert.match(text, /ca \/etc\/openvpn\/server\/ca\.crt/);
  assert.match(text, /script-security 2/);
});

test('buildClientProfile emits auth-user-pass based config', () => {
  const profile = buildClientProfile({
    baseUrl: 'vpn.example.com',
    server: {
      port: '1194',
      proto: 'udp',
      auth: 'SHA256',
      dataCiphers: 'AES-256-GCM:AES-128-GCM',
      pushRules: ['redirect-gateway def1 bypass-dhcp', 'dhcp-option DNS 10.8.0.1'],
      tlsCryptInline: '<tls-crypt>KEY</tls-crypt>',
      caInline: '<ca>CERT</ca>',
    },
  });

  assert.match(profile, /auth-user-pass/);
  assert.match(profile, /auth-nocache/);
  assert.match(profile, /remote vpn\.example\.com 1194/);
  assert.match(profile, /<ca>CERT<\/ca>/);
});

test('parseServerConfig preserves raw extra directives and tls-auth mode', () => {
  const parsed = parseServerConfig([
    'port 443',
    'proto tcp',
    'tls-auth /etc/openvpn/server/tls-auth.key 0',
    'keepalive 20 60',
    'log-append /var/log/openvpn.log',
    'explicit-exit-notify 1',
    'sndbuf 0',
  ].join('\n'));

  assert.equal(parsed.tlsMode, 'tls-auth');
  assert.equal(parsed.keepalive, '20 60');
  assert.equal(parsed.logPath, '/var/log/openvpn.log');
  assert.equal(parsed.rawExtra, 'explicit-exit-notify 1\nsndbuf 0');
});

test('buildServerConfig appends rawExtra and diffText highlights removals and additions', () => {
  const text = buildServerConfig({
    port: '443',
    proto: 'tcp',
    serverNetwork: '10.9.0.0 255.255.255.0',
    auth: 'SHA512',
    dataCiphers: 'AES-256-GCM',
    authUserPassVerify: '/etc/openvpn/scripts/auth_verify via-file',
    tlsMode: 'tls-auth',
    rawExtra: 'explicit-exit-notify 1\nsndbuf 0',
    pushRules: [],
  });

  assert.match(text, /tls-auth \/etc\/openvpn\/server\/tls-auth\.key 0/);
  assert.match(text, /explicit-exit-notify 1/);
  assert.match(text, /sndbuf 0/);

  const diff = diffText('port 1194\nproto udp\nkeepalive 10 120', 'port 443\nproto tcp');
  assert.match(diff, /- port 1194/);
  assert.match(diff, /\+ port 443/);
  assert.match(diff, /- keepalive 10 120/);
});
