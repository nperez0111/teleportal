# WebSocket Server

WebSocket server implementation for Teleportal, built on the [`crossws`](https://github.com/unjs/crossws) library. Handles the bridge between raw WebSocket connections and the Teleportal `Server`.

## Architecture

Two entry points:

1. **`getWebsocketHandlers`** -- low-level: you own the upgrade/auth, you get back `crossws.Hooks`.
2. **`tokenAuthenticatedWebsocketHandler`** -- high-level: extracts a `?token=` query param, verifies it with a `TokenManager`, and wires everything up.

### Connection lifecycle

```text
1. upgrade    onUpgrade() authenticates, returns context + optional headers
2. open       BinaryTransport created, server.createClient() called, onConnect() fires
3. message    Binary validated, pushed to channel, onMessage() fires (observability only)
4. close      onDisconnect() fires, client disconnected, channel + transport closed
5. error      Channel error signalled, consumer loop exits
```

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

Extracts `?token=` from the upgrade URL, verifies it via `tokenManager.verifyToken()`, and uses the token payload as the connection context.

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

- **`source`** -- a `Channel<BinaryMessage>` fed by incoming WebSocket frames.
- **`write()`** -- calls `peer.send()`. Logs backpressure (Bun returns -1/0 on `ws.send` for queued/dropped).
- **`close()`** -- closes the peer socket so a wedged connection triggers immediate client reconnect.

## Error handling

| Phase | Behavior |
|-------|----------|
| `upgrade` throws `Response` | Returned to client as-is |
| `upgrade` throws other | 401 Unauthorized |
| `open` (createClient) fails | Logged, peer closed |
| `message` hook throws | Logged; message still delivered |
| `close` hook throws | Logged; cleanup still runs |
| `error` event | Forwarded to channel, consumer loop exits |

## Dependencies

- **`crossws`** -- not bundled, install separately (`bun add crossws`)
- **`teleportal`** -- core types (`BinaryMessage`, `isBinaryMessage`, `ServerContext`)
- **`teleportal/server`** -- `Server`, `Client`, `emitWideEvent`
- **`teleportal/transports`** -- `fromBinaryTransport` (converts `BinaryTransport` to `Transport`)
