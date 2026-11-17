# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# The bundled Linux addon can require a newer glibc than Bookworm provides.
RUN rm -f node_modules/better-sqlite3/prebuilds/*.node \
    && node "$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js" rebuild \
        --directory node_modules/better-sqlite3 --release --nodedir=/usr/local

FROM node:24-bookworm-slim
ARG AUDIOWAVEFORM_VERSION=1.10.1
WORKDIR /app
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in arm64|amd64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 python3-venv; \
    curl -fsSL --retry 3 \
      "https://github.com/bbc/audiowaveform/releases/download/${AUDIOWAVEFORM_VERSION}/audiowaveform_${AUDIOWAVEFORM_VERSION}-1-12_${arch}.deb" \
      -o /tmp/audiowaveform.deb; \
    apt-get install -y --no-install-recommends /tmp/audiowaveform.deb; \
    rm -f /tmp/audiowaveform.deb; \
    rm -rf /var/lib/apt/lists/*

COPY deploy/requirements-reanalysis.txt ./deploy/
RUN python3 -m venv /opt/barktown-reanalysis \
    && /opt/barktown-reanalysis/bin/python -m pip install --no-cache-dir --only-binary=:all: -r deploy/requirements-reanalysis.txt

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.mjs server-private.mjs ingest-service.mjs dump-db.mjs ./
COPY lib ./lib
COPY deploy/database.mjs deploy/require-db.sh ./deploy/
USER node
RUN /opt/barktown-reanalysis/bin/python -c 'import numpy; from ai_edge_litert.interpreter import Interpreter'
# Fail the image build if the runtime cannot open and query SQLite.
RUN node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(":memory:"); console.log(db.prepare("SELECT sqlite_version() AS sqlite").get()); db.close()'
CMD ["node", "server.mjs"]
