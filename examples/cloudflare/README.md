# Teleportal on Cloudflare Workers + Durable Objects

Runs the Teleportal Y.js sync server on Cloudflare Workers using
[`teleportal/cloudflare`](../../src/cloudflare/README.md): one Durable Object
hosts the `Server` with every storage interface backed directly by Durable
Object storage, and a bundled ProseMirror client demos collaborative editing.

## Architecture

- **Static assets** (`public/`): the demo page and the locally-bundled
  browser client (`client.js`). Served by Cloudflare's asset handling —
  requests that match no asset fall through to the Worker.
- **Worker** (`src/worker.ts`): forwards everything under `/api/*` (WebSocket
  upgrades and HTTP/SSE alike) to a single Durable Object instance, stripping
  the `/api` prefix. Everything landing in one instance is what lets
  WebSocket and SSE/HTTP clients share the same sessions and in-memory
  PubSub.
- **Durable Object** (`src/durable-object.ts`): the Teleportal `Server` wired
  with `DurableObjectDocumentStorage` plus file, milestone, key-registry, and
  rate-limit storage — all persisted in the DO's own SQLite-backed storage.
  WebSockets go through crossws's Cloudflare adapter (hibernation API); HTTP
  and SSE go through `getHTTPHandlers`.
- **Client** (`src/client.ts`): `Provider` from `teleportal/providers`
  (WebSocket with automatic HTTP/SSE fallback) + y-prosemirror. It is bundled
  from this repo's source so the wire protocol always matches the server.

No KV namespace, R2 bucket, or other resources to set up — Durable Object
storage is the only persistence, and `wrangler dev` emulates it locally.

## Development

From the repo root:

```bash
bun install
cd examples/cloudflare
bun run dev
```

Then open http://localhost:8787 in two tabs and type. The server bundles
straight from the repo's TypeScript source (wrangler's bundler honors the
`teleportal/*` paths in `tsconfig.json`), so no repo build step is needed.

## Testing

`src/integration.test.ts` spawns `wrangler dev` (workerd runs fully offline)
and checks the SSE wire format plus WebSocket and SSE/HTTP sync round-trips
with persistence. It runs as part of the repo's `bun run test`, or alone:

```bash
bun test src/integration.test.ts
```

With a dev server already running, `bun run e2e` performs the same
round-trips against it.

## Deploy

```bash
bun run deploy
```

## Scope and caveats

- **No auth**: every connection gets a static `{ userId, room }` context. For
  real deployments use `TokenManager` (`teleportal/token`) with
  `tokenAuthenticatedHTTPHandler` / a token check in `onUpgrade` — jose runs
  fine on workerd.
- **One Durable Object instance** (`idFromName("teleportal")`) serves the
  whole app, which caps throughput at one instance's capacity. To shard,
  derive the instance name from the room in `src/worker.ts`.
- **Hibernation**: workerd may evict an idle Durable Object while keeping
  WebSockets open. On the next message the server closes the stale socket and
  the client reconnects and resyncs automatically. Open SSE connections
  prevent hibernation entirely.
- **Value size**: SQLite-backed Durable Object storage caps values at 2 MiB.
  A document's compacted state and a milestone snapshot are each one value;
  file chunks (1 MiB) always fit.
