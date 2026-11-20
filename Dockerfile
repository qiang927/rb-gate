# robin-gateway container.
#
# Stage 1 builds the native WAA signer (Go + SpiderMonkey 152). The signer is
# what turns an AI Studio cookie into a BotGuard-proofed MakerSuite request, so
# it cannot be replaced by pure JS. Building it here keeps the runtime image
# small and makes Render builds self-contained.
FROM golang:1.27-bookworm AS signer

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xz-utils \
        build-essential \
        file \
    && rm -rf /var/lib/apt/lists/*

# waa-signer is vendored (MIT, pin: aistudio-api a28a6c5) so builds do not
# depend on GitHub being reachable; build.sh still fetches the SpiderMonkey
# static libraries and zig from their release servers.
COPY waa-signer /src/waa-signer
WORKDIR /src/waa-signer
RUN ./build.sh

# ---- runtime ----
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

COPY --from=signer /src/waa-signer/bin/waa-signer /app/waa-signer/bin/waa-signer
RUN chmod 0755 /app/waa-signer/bin/waa-signer \
    && mkdir -p /data \
    && chown -R node:node /app /data

USER node

EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "src/server.js"]
