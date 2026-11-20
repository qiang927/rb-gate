# robin-gateway container.
#
# pggo (AI Studio) needs the native WAA signer: a Go/SpiderMonkey binary that
# replays a Firefox 152 profile and mints BotGuard proofs. Building it needs
# the Go toolchain, zig and ~150MB of SpiderMonkey static libraries, so the
# linux/amd64 binary is vendored under waa-signer/bin/ (MIT, source pinned from
# aistudio-api a28a6c5). Rebuild it yourself with waa-signer/build.sh if you
# want a different platform or the upstream moved.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
ENV WAA_SIGNER_PATH=/app/waa-signer/bin/waa-signer

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

COPY waa-signer/bin/waa-signer /app/waa-signer/bin/waa-signer
RUN chmod 0755 /app/waa-signer/bin/waa-signer \
    && mkdir -p /data \
    && chown -R node:node /app /data

USER node

EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "src/server.js"]
