# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1-alpine AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS release
RUN mkdir -p playground docs
COPY docs/package.json docs/
COPY playground/package.json playground/
COPY package.json bun.lock bunfig.toml .
RUN bun install --filter '!docs'


COPY . .
RUN bun run build:demo

# COPY --from=install /temp/dev/node_modules node_modules
# COPY --from=prerelease /usr/src/app/index.ts .
# COPY --from=prerelease /usr/src/app/package.json .

# run the app
ENV NODE_ENV=production
USER bun
EXPOSE 3000/tcp

# Health check using the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT [ "bun", "run", "./playground/bun/server.ts" ]
