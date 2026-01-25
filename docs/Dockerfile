FROM oven/bun:1-alpine AS build

WORKDIR /app

COPY . .

RUN bun install

RUN bun run build

FROM httpd:2.4 AS runtime

COPY --from=build /app/dist /usr/local/apache2/htdocs/

EXPOSE 80
