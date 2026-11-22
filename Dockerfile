# robin-gateway container.
#
# One Node process serves the Gemini web channel (web-*) from browser cookies,
# plus an optional Clash/Mihomo proxy pool for outgoing traffic.

# Mihomo (Clash Meta) core for the proxy pool. Pulled from Docker Hub so the
# repo does not need to carry a 60MB binary.
FROM metacubex/mihomo:latest AS mihomo

FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
ENV MIHOMO_PATH=/usr/local/bin/mihomo

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=mihomo /mihomo /usr/local/bin/mihomo
RUN chmod 0755 /usr/local/bin/mihomo && /usr/local/bin/mihomo -v | head -1 || true

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "src/server.js"]
