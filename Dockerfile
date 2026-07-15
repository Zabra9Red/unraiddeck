# UnraidDeck — immagine multi-stage, amd64 (Unraid è solo x86_64), porta 8787.

# ---- Stage build: deps native (better-sqlite3 su musl) + build frontend ----
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- Stage runtime: solo artefatti + tini (PID 1) ----
FROM node:22-alpine
ARG UNRAIDDECK_VERSION
RUN apk add --no-cache tini ffmpeg file libarchive-tools p7zip exiftool poppler-utils vips-tools openssl ttf-dejavu
ENV NODE_ENV=production \
    TZ=Europe/Rome \
    UNRAIDDECK_VERSION=${UNRAIDDECK_VERSION}

WORKDIR /app
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY backend/ ./backend/
COPY --from=build /app/frontend/dist ./frontend/dist

# Root necessario per /var/run/docker.sock (documentato nel README).
# Mai --privileged; usare sempre --security-opt no-new-privileges=true.

EXPOSE 8787
VOLUME /config

# Niente curl: wget è nella busybox di Alpine
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8787/api/health || wget -qO /dev/null http://127.0.0.1:8788/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/src/server.js"]
