#!/usr/bin/env sh
set -eu

OVPN_DIR="${OVPN_DATA_DIR:-/etc/openvpn}"
SERVER_DIR="${OVPN_SERVER_DIR:-${OVPN_DIR}/server}"
SCRIPTS_DIR="${OVPN_SCRIPTS_DIR:-${OVPN_DIR}/scripts}"
RUN_DIR="${OVPN_RUN_DIR:-/run/openvpn}"
CONF_PATH="${OVPN_SERVER_CONF_PATH:-${SERVER_DIR}/server.conf}"
PUBLIC_HOST="${OVPN_PUBLIC_HOST:-127.0.0.1}"
OVPN_PORT="${OVPN_PORT:-1194}"
OVPN_PROTO="${OVPN_PROTO:-udp}"
OVPN_SERVER_NETWORK="${OVPN_SERVER_NETWORK:-10.8.0.0 255.255.255.0}"
OVPN_AUTO_INIT="${OVPN_AUTO_INIT:-true}"
EASYRSA_REQ_CN="${EASYRSA_REQ_CN:-OpenVPN Admin CA}"

mkdir -p "${OVPN_DIR}" "${SERVER_DIR}" "${SCRIPTS_DIR}" "${RUN_DIR}" "${SERVER_DIR}/ccd"

copy_if_missing() {
  src="$1"
  dest="$2"
  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
  fi
}

ensure_pki() {
  if [ -f "${SERVER_DIR}/ca.crt" ] && [ -f "${SERVER_DIR}/server.crt" ] && [ -f "${SERVER_DIR}/server.key" ] && [ -f "${SERVER_DIR}/tls-crypt.key" ]; then
    return 0
  fi

  if [ "$OVPN_AUTO_INIT" != "true" ]; then
    echo "missing OpenVPN PKI files and OVPN_AUTO_INIT is disabled" >&2
    exit 1
  fi

  echo "[openvpn] bootstrapping PKI"
  touch "${OVPN_DIR}/vars"
  ovpn_genconfig -u "${OVPN_PROTO}://${PUBLIC_HOST}:${OVPN_PORT}"
  EASYRSA_BATCH=1 EASYRSA_REQ_CN="${EASYRSA_REQ_CN}" ovpn_initpki nopass

  copy_if_missing "${OVPN_DIR}/pki/ca.crt" "${SERVER_DIR}/ca.crt"
  copy_if_missing "${OVPN_DIR}/pki/issued/server.crt" "${SERVER_DIR}/server.crt"
  copy_if_missing "${OVPN_DIR}/pki/private/server.key" "${SERVER_DIR}/server.key"
  copy_if_missing "${OVPN_DIR}/pki/ta.key" "${SERVER_DIR}/tls-crypt.key"
}

ensure_server_config() {
  if [ ! -f "$CONF_PATH" ] && [ -f "${OVPN_DIR}/openvpn.conf" ]; then
    cp "${OVPN_DIR}/openvpn.conf" "$CONF_PATH"
  fi

  if [ ! -f "$CONF_PATH" ]; then
    cat > "$CONF_PATH" <<EOF
# Managed by OpenVPN Admin
local 0.0.0.0
port ${OVPN_PORT}
proto ${OVPN_PROTO}
dev tun
server ${OVPN_SERVER_NETWORK}
topology subnet
keepalive 10 120
auth SHA256
data-ciphers AES-256-GCM:AES-128-GCM
script-security 2
verify-client-cert none
auth-user-pass-verify /etc/openvpn/scripts/auth_verify via-file
client-config-dir /etc/openvpn/server/ccd
management /run/openvpn/server-management.sock unix
status /etc/openvpn/server/openvpn-status.log
log-append /etc/openvpn/server/openvpn.log
username-as-common-name
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 1.1.1.1"
ca /etc/openvpn/server/ca.crt
cert /etc/openvpn/server/server.crt
key /etc/openvpn/server/server.key
tls-crypt /etc/openvpn/server/tls-crypt.key
EOF
  fi
}

ensure_pki
ensure_server_config

if [ ! -f "${SCRIPTS_DIR}/auth_verify" ]; then
  cp /opt/openvpn-admin/auth_verify "${SCRIPTS_DIR}/auth_verify"
  chmod 0755 "${SCRIPTS_DIR}/auth_verify"
fi

cp "$CONF_PATH" "${OVPN_DIR}/openvpn.conf"

exec ovpn_run
