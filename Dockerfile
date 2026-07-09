# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1-alpine AS base
WORKDIR /usr/src/app

FROM base AS release
RUN mkdir -p examples/blocknote examples/excalidraw examples/prosemirror showcase docs
COPY docs/package.json docs/
COPY examples/blocknote/package.json examples/blocknote/
COPY examples/excalidraw/package.json examples/excalidraw/
COPY examples/prosemirror/package.json examples/prosemirror/
COPY showcase/package.json showcase/
COPY package.json bun.lock bunfig.toml .
RUN bun install --filter '!docs'

COPY . .

# Bun's development server bundles HTML imports on the fly and uses React's
# JSX dev runtime, so we intentionally leave NODE_ENV unset for the showcase.
USER bun
EXPOSE 3000/tcp

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --spider http://localhost:3000/health --no-verbose --tries=1 || exit 1

ENTRYPOINT [ "bun", "run", "./showcase/server.ts" ]
