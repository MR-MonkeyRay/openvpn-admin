#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
INSTANCE="${2:-server}"
CONF="${3:-/etc/openvpn/server/server.conf}"

case "$ACTION" in
  test-config)
    exec /usr/sbin/openvpn --config "$CONF" --test-parse
    ;;
  restart-service)
    exec /usr/bin/systemctl restart "openvpn-server@${INSTANCE}.service"
    ;;
  status-service)
    exec /usr/bin/systemctl status "openvpn-server@${INSTANCE}.service" --no-pager
    ;;
  *)
    echo "unsupported action: $ACTION" >&2
    exit 64
    ;;
esac
