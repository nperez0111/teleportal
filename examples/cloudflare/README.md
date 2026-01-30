# Teleportal on Cloudflare Durable Objects

This example runs the Teleportal Y.js sync server on Cloudflare Workers using a single Durable Object (DO). All requests—WebSocket upgrades and HTTP (sync API + fallback HTML)—are forwarded to the DO.

## Architecture

- **Worker**: Receives every request. For `Upgrade: websocket` it calls the crossws adapter’s `handleUpgrade`, which resolves the DO stub and returns `stub.fetch(request)`. For non-upgrade requests it gets the same DO stub and returns `stub.fetch(request)` so HTTP is also served from the DO.
- **Durable Object**: One instance (`idFromName("teleportal")`). In the DO constructor: unstorage with Cloudflare KV (`TELEPORTAL_STORAGE`), Teleportal `Server`, crossws with `getWebsocketHandlers` (static context `userId: "user"`, `room: "docs"`), and `getHTTPHandlers` with static `getContext` and a fetch fallback that returns HTML from the simple example. No token manager. In `fetch()`: if WebSocket upgrade, `handleDurableUpgrade`; otherwise the HTTP handler.

## Prerequisites

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- A Cloudflare account
- KV namespace `86a1b5441bea4ec9b0ba2d42e33c1c87` (create in dashboard or via wrangler if needed)

## Setup

From the repo root:

```bash
bun install
cd examples/cloudflare
bun install
```

## Development

```bash
bun run dev
```

## Deploy

```bash
bun run deploy
```

## Scope

- **One DO**: Single DO instance (`idFromName("teleportal")`) for the whole app. One DO per document is a possible follow-up.
- **Static context**: No JWT or token manager; `userId` and `room` are fixed for testing.
- **Client HTML**: Fallback fetch returns the simple example HTML from the main repo (raw GitHub).
