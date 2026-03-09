FROM node:24-bookworm-slim AS base

ARG VERSION=dev
ARG BUILD_DATE
ARG VCS_REF

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM base AS runtime

ARG VERSION=dev
ARG BUILD_DATE
ARG VCS_REF

LABEL org.opencontainers.image.title="openvpn-admin"
LABEL org.opencontainers.image.description="OpenVPN management panel with Web UI"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.source="https://github.com/mr-monkeyray/openvpn-admin"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=3000

RUN groupadd --system app && useradd --system --gid app --create-home app

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/views ./src/views
COPY --from=build /app/src/public ./src/public

RUN mkdir -p /app/data /app/logs && chown -R app:app /app

USER app

EXPOSE 3000

CMD ["node", "src/server.js"]
