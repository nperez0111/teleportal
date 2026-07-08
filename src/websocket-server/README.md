# WebSocket Server

WebSocket server implementation for Teleportal, built on the [`crossws`](https://github.com/unjs/crossws) library. Handles the bridge between raw WebSocket connections and the Teleportal `Server`.

## Architecture

Two entry points:

1. **`getWebsocketHandlers`** -- low-level: you own the upgrade/auth, you get back `crossws.Hooks`.
2. **`tokenAuthenticatedWebsocketHandler`** -- high-level: extracts a `?token=` query param, verifies it with a `TokenManager`, and wires everything up.

### Connection lifecycle

```text
1. upgrade    onUpgrade() authenticates, returns context + optional headers.
              On success crossws stashes the context on the peer; teleportal
              adds `x-powered-by: teleportal` (plus any headers you return).
2. open       Channel + BinaryTransport created, server.createClient() called,
              per-peer state (clientId/channel/transport/client) stored on
              peer.context, onConnect() fires. If createClient() throws, the
              peer is closed.
3. message    Stale-peer guard runs first; binary validated, pushed to the
              channel, onMessage() fires (observability only).
4. close      onDisconnect() fires, server.disconnectClient() called, channel +
              transport closed. Every step is wrapped so one failure can't skip
              the rest.
5. error      Channel error signalled (if the channel still exists), consumer
              loop exits.
```

### Stale peers (Durable Object hibernation)

The crossws Cloudflare adapter can restore a hibernated Durable Object's
WebSockets **without** re-running the `open` hook, leaving the per-peer
channel/client/transport state empty. The `message` hook detects this (missing
`peer.context.channel?.send` or `peer.context.client`) and closes the peer so
the client reconnects and resyncs, rather than throwing inside the hook. The
`error` hook likewise guards the channel with `?.` for the same reason.

## API

### `getWebsocketHandlers`

```typescript
function getWebsocketHandlers<T extends ServerContext>(options: {
  server: Server<T>;
  onUpgrade: (request: Request) => Promise<{
    context: Omit<T, "clientId">;
    headers?: Record<string, string>;
  }>;
  onConnect?: (ctx: {
    client: Client<T>;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  onDisconnect?: (ctx: {
    client: Client<T>;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  onMessage?: (ctx: {
    client: Client<T>;
    message: BinaryMessage;
    peer: crossws.Peer;
  }) => void | Promise<void>;
}): crossws.Hooks;
```

- **`onUpgrade`** (required) -- authenticate the request. Throw a `Response` to reject.
- **`onConnect`** (optional) -- fires after the client is registered with the server.
- **`onDisconnect`** (optional) -- fires before cleanup. A throwing hook does not prevent cleanup.
- **`onMessage`** (optional) -- observability hook. The message is delivered to the server regardless of whether this hook succeeds or throws.

### `tokenAuthenticatedWebsocketHandler`

```typescript
function tokenAuthenticatedWebsocketHandler<T extends ServerContext>(options: {
  server: Server<T>;
  tokenManager: TokenManager;
  hooks?: Partial<Omit<Parameters<typeof getWebsocketHandlers<T>>[0], "server">>;
}): crossws.Hooks;
```

Extracts `?token=` from the upgrade URL, verifies it via `tokenManager.verifyToken()`, and uses the token payload as the connection context. A missing or invalid token rejects the upgrade with `401 Unauthorized`.

The `hooks` object forwards `onConnect`/`onDisconnect`/`onMessage` to `getWebsocketHandlers`. It may also supply an `onUpgrade` hook to **augment** the connection: its returned `context` is merged under the verified token payload (so it cannot override authenticated fields — the token payload wins on key conflicts), and its returned `headers` are forwarded to the upgrade response.

```typescript
import { crossws } from "crossws";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({ secret: "your-secret-key" });

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
    hooks: {
      onConnect: async ({ client, id }) => {
        console.log(`Client ${id} connected`);
      },
    },
  }),
);
```

Client connects with `wss://host/ws?token=<jwt>`.

## Transport bridge

Each WebSocket connection gets a `BinaryTransport`:

- **`source`** -- a `Channel<BinaryMessage>` fed by incoming WebSocket frames. Note the channel is unbounded, so `message` uses the throwing `channel.send()` (it only throws once the channel is closed/errored).
- **`write()`** -- calls `peer.send()`. A non-positive numeric result (Bun returns `-1` for queued/backpressured and `0` for dropped) is logged as a `websocket_send_backpressure` wide event — a dropped server→client frame is a silent update loss until the next resync. If `peer.send()` **throws**, it logs `websocket_send_threw` and re-throws so the server's consume loop can tear the connection down.
- **`close()`** -- closes the peer socket (best-effort; swallows errors if already closed) so a wedged connection triggers immediate client reconnect instead of waiting out the client's receive timeout.

Note that `fromBinaryTransport` answers WebSocket `ping` control messages inline (replying with a `pong`) so they never surface as decoded messages.

## Error handling

| Phase                       | Behavior                                  |
| --------------------------- | ----------------------------------------- |
| `upgrade` throws `Response` | Returned to client as-is                  |
| `upgrade` throws other      | 401 Unauthorized                          |
| `open` (createClient) fails | Logged, peer closed                       |
| `message` hook throws       | Logged; message still delivered           |
| `close` hook throws         | Logged; cleanup still runs                |
| `error` event               | Forwarded to channel, consumer loop exits |

## Dependencies

- **`crossws`** -- not bundled, install separately (`bun add crossws`)
- **`teleportal`** -- core types (`BinaryMessage`, `isBinaryMessage`, `ServerContext`)
- **`teleportal/server`** -- `Server`, `Client`, `emitWideEvent`
- **`teleportal/transports`** -- `fromBinaryTransport` (converts `BinaryTransport` to `Transport`)
