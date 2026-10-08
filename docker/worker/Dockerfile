ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim

# Keep the same native runtime and toolchain as the root image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates python3 make g++ pkg-config \
        libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
        chromium curl git && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@10.26.0

ENV HUSKY=0
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

ENV NODE_OPTIONS=--max-old-space-size=8192

WORKDIR /usr/src

# Copy app source
COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm build:docker --concurrency=1 && node scripts/check-runtime-dependencies.cjs

# --- Healthcheck Setup ---

WORKDIR /app/healthcheck

COPY docker/worker/healthcheck/package.json . 

RUN npm install --omit=dev

COPY docker/worker/healthcheck/healthcheck.js .

# --- End Healthcheck Setup ---

# Set the main working directory back
WORKDIR /usr/src

# Environment variables for port configuration
ENV WORKER_PORT=5566

# Expose port (can be overridden by env var)
EXPOSE ${WORKER_PORT}

# Give the node user ownership of the application files (node:*-bookworm-slim already has this user)
RUN chown -R node:node /usr/src /app

# Switch to non-root user
USER node

# Start healthcheck in background and flowise worker in foreground
CMD ["/bin/sh", "-c", "node /app/healthcheck/healthcheck.js & sleep 5 && pnpm run start-worker"]
