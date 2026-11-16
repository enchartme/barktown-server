# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ARG AUDIOWAVEFORM_VERSION=1.10.1
WORKDIR /app
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in arm64|amd64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl ffmpeg; \
    curl -fsSL --retry 3 \
      "https://github.com/bbc/audiowaveform/releases/download/${AUDIOWAVEFORM_VERSION}/audiowaveform_${AUDIOWAVEFORM_VERSION}-1-12_${arch}.deb" \
      -o /tmp/audiowaveform.deb; \
    apt-get install -y --no-install-recommends /tmp/audiowaveform.deb; \
    rm -f /tmp/audiowaveform.deb; \
    rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.mjs server-private.mjs ingest-service.mjs dump-db.mjs ./
COPY lib ./lib
USER node
CMD ["node", "server.mjs"]
