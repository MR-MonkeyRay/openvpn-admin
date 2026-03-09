FROM kylemanna/openvpn:latest

RUN apk add --no-cache nodejs

COPY scripts/auth_verify.mjs /opt/openvpn-admin/auth_verify.mjs
COPY docker/openvpn/auth_verify /opt/openvpn-admin/auth_verify
COPY docker/openvpn/docker-entrypoint.sh /usr/local/bin/openvpn-admin-openvpn-entrypoint

RUN chmod 0755 /opt/openvpn-admin/auth_verify /usr/local/bin/openvpn-admin-openvpn-entrypoint

ENTRYPOINT ["/usr/local/bin/openvpn-admin-openvpn-entrypoint"]
