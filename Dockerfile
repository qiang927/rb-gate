# robin-gateway container.
#
# A single Node process: robin credentials (oauth_token -> master token) power
# the Gemini web channel (web-*) and the Code Assist channel (agy-*).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "src/server.js"]
