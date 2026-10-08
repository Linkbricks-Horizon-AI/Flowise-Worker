# Build local monorepo image
# docker build --no-cache -t  flowise .

# Run image
# docker run -d -p 3000:3000 flowise

ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim

# ONNX ships glibc binaries; Debian avoids Alpine/musl loader failures.
# Cairo/Pango also support a source-build fallback for Canvas.
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

WORKDIR /usr/src/flowise

# Copy app source
COPY . .

# Install dependencies and build (excluding sdk packages not needed for Docker)
RUN pnpm install --frozen-lockfile && \
    pnpm build:docker --concurrency=1 && \
    node scripts/check-runtime-dependencies.cjs

# Give the node user ownership of the application files
RUN chown -R node:node .

# Switch to non-root user (node user already exists in node:24-bookworm-slim)
USER node

EXPOSE 3000

CMD [ "pnpm", "start" ]
