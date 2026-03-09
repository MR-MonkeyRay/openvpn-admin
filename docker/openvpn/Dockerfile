FROM kylemanna/openvpn:latest

ARG VERSION=dev
ARG BUILD_DATE
ARG VCS_REF

LABEL org.opencontainers.image.title="openvpn-admin-openvpn"
LABEL org.opencontainers.image.description="OpenVPN server with admin panel auth integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.source="https://github.com/mr-monkeyray/openvpn-admin"
LABEL org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache nodejs

COPY scripts/auth_verify.mjs /opt/openvpn-admin/auth_verify.mjs
COPY docker/openvpn/auth_verify /opt/openvpn-admin/auth_verify
COPY docker/openvpn/docker-entrypoint.sh /usr/local/bin/openvpn-admin-openvpn-entrypoint

RUN chmod 0755 /opt/openvpn-admin/auth_verify /usr/local/bin/openvpn-admin-openvpn-entrypoint

ENTRYPOINT ["/usr/local/bin/openvpn-admin-openvpn-entrypoint"]
