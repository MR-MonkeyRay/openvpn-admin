function normalizeQuoted(value) {
  return value.replace(/^"|"$/g, '');
}

export function parseServerConfig(configText) {
  const parsed = {
    local: '0.0.0.0',
    port: '1194',
    proto: 'udp',
    dev: 'tun',
    serverNetwork: '10.8.0.0 255.255.255.0',
    auth: 'SHA256',
    dataCiphers: 'AES-256-GCM:AES-128-GCM',
    verifyClientCert: 'none',
    usernameAsCommonName: false,
    authUserPassVerify: '',
    ccdPath: '',
    keepalive: '10 120',
    logPath: '',
    statusPath: '',
    managementSocket: '',
    caPath: '/etc/openvpn/server/ca.crt',
    certPath: '/etc/openvpn/server/server.crt',
    keyPath: '/etc/openvpn/server/server.key',
    tlsMode: 'tls-crypt',
    rawExtra: '',
    pushRules: [],
  };

  const extraLines = [];

  for (const rawLine of configText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('push ')) {
      parsed.pushRules.push(normalizeQuoted(line.slice(5).trim()));
      continue;
    }

    const [directive, ...rest] = line.split(/\s+/);
    const value = rest.join(' ');

    switch (directive) {
      case 'local':
        parsed.local = value;
        break;
      case 'port':
        parsed.port = value;
        break;
      case 'proto':
        parsed.proto = value;
        break;
      case 'dev':
        parsed.dev = value;
        break;
      case 'server':
        parsed.serverNetwork = value;
        break;
      case 'auth':
        parsed.auth = value;
        break;
      case 'data-ciphers':
        parsed.dataCiphers = value;
        break;
      case 'verify-client-cert':
        parsed.verifyClientCert = value;
        break;
      case 'auth-user-pass-verify':
        parsed.authUserPassVerify = value;
        break;
      case 'client-config-dir':
        parsed.ccdPath = value;
        break;
      case 'keepalive':
        parsed.keepalive = value;
        break;
      case 'log':
      case 'log-append':
        parsed.logPath = value;
        break;
      case 'status':
        parsed.statusPath = value;
        break;
      case 'management':
        if (value.endsWith(' unix')) {
          parsed.managementSocket = value.replace(/\s+unix$/, '');
        } else {
          parsed.managementSocket = value;
        }
        break;
      case 'ca':
        parsed.caPath = value;
        break;
      case 'cert':
        parsed.certPath = value;
        break;
      case 'key':
        parsed.keyPath = value;
        break;
      case 'tls-auth':
        parsed.tlsMode = 'tls-auth';
        break;
      case 'tls-crypt':
        parsed.tlsMode = 'tls-crypt';
        break;
      case 'username-as-common-name':
        parsed.usernameAsCommonName = true;
        break;
      default:
        extraLines.push(line);
        break;
    }
  }

  parsed.rawExtra = extraLines.join('\n');

  return parsed;
}

export function buildServerConfig(input) {
  const lines = [
    '# Managed by OpenVPN Admin',
    `local ${input.local ?? '0.0.0.0'}`,
    `port ${input.port}`,
    `proto ${input.proto}`,
    `dev ${input.dev ?? 'tun'}`,
    `server ${input.serverNetwork}`,
    `keepalive ${input.keepalive ?? '10 120'}`,
    `auth ${input.auth ?? 'SHA256'}`,
    `data-ciphers ${input.dataCiphers ?? 'AES-256-GCM:AES-128-GCM'}`,
    'script-security 2',
    `verify-client-cert ${input.verifyClientCert ?? 'none'}`,
    `auth-user-pass-verify ${input.authUserPassVerify}`,
    `client-config-dir ${input.ccdPath ?? '/etc/openvpn/server/ccd'}`,
    `management ${input.managementSocket ?? '/run/openvpn/server-management.sock'} unix`,
    `status ${input.statusPath ?? '/etc/openvpn/server/openvpn-status.log'}`,
    `log-append ${input.logPath ?? '/etc/openvpn/server/openvpn.log'}`,
    `ca ${input.caPath ?? '/etc/openvpn/server/ca.crt'}`,
    `cert ${input.certPath ?? '/etc/openvpn/server/server.crt'}`,
    `key ${input.keyPath ?? '/etc/openvpn/server/server.key'}`,
  ];

  if (input.usernameAsCommonName) {
    lines.push('username-as-common-name');
  }

  for (const rule of input.pushRules ?? []) {
    lines.push(`push "${rule}"`);
  }

  if (input.tlsMode === 'tls-auth') {
    lines.push(`tls-auth ${input.tlsAuthPath ?? '/etc/openvpn/server/tls-auth.key'} 0`);
  } else if (input.tlsMode === 'tls-crypt') {
    lines.push(`tls-crypt ${input.tlsCryptPath ?? '/etc/openvpn/server/tls-crypt.key'}`);
  }

  if (input.rawExtra) {
    lines.push(input.rawExtra.trim());
  }

  return lines.join('\n');
}

export function buildClientProfile({ baseUrl, server }) {
  const remoteHost = baseUrl || 'vpn.example.com';
  const lines = [
    'client',
    'dev tun',
    `proto ${server.proto}`,
    `remote ${remoteHost} ${server.port}`,
    'nobind',
    'persist-key',
    'persist-tun',
    'auth-user-pass',
    'auth-nocache',
    'remote-cert-tls server',
    `auth ${server.auth}`,
    `data-ciphers ${server.dataCiphers}`,
  ];

  if (server.caInline) {
    lines.push(server.caInline);
  }

  if (server.tlsCryptInline) {
    lines.push(server.tlsCryptInline);
    lines.push('tls-crypt inline');
  }

  return lines.join('\n');
}

export function diffText(beforeText, afterText) {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  const diff = [];

  for (let index = 0; index < maxLength; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];

    if (beforeLine === afterLine) {
      if (beforeLine !== undefined) diff.push(`  ${beforeLine}`);
      continue;
    }

    if (beforeLine !== undefined) diff.push(`- ${beforeLine}`);
    if (afterLine !== undefined) diff.push(`+ ${afterLine}`);
  }

  return diff.join('\n');
}
