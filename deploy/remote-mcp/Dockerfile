# DIAPORIA remote research/read-only MCP service. Build context = repository root:
#   docker compose -f deploy/remote-mcp/compose.yaml build
# Base images are pinned by digest (recorded 2026-11-10); bump deliberately.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Optional build secret "npm_ca": extra CA bundle for builds behind a TLS-inspecting proxy. Never baked into the image.
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist/src ./dist/src
COPY deploy/remote-mcp/healthcheck.mjs ./healthcheck.mjs
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/src/remote/main.js"]
