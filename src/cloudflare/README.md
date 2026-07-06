# `teleportal/cloudflare`

Run a Teleportal sync server on Cloudflare Workers with Durable Objects.

The model: a Worker forwards all sync traffic (WebSocket upgrades **and**
HTTP/SSE) to a single Durable Object instance, which hosts the Teleportal
`Server`. Because every connection lands in the same instance, WebSocket
clients and SSE/HTTP clients share one set of sessions and the in-memory
PubSub — no cross-instance coordination needed.

## Storage

Every Teleportal storage interface has a direct implementation on Durable
Object storage (`ctx.storage`) — no adapter layer in between. Values ride
structured clone, so updates, sidecars, chunks, and wrapped keys stay binary.

| Class                                 | Interface                |
| ------------------------------------- | ------------------------ |
| `DurableObjectDocumentStorage`        | `DocumentStorage`        |
| `DurableObjectFileStorage`            | `FileStorage`            |
| `DurableObjectTemporaryUploadStorage` | `TemporaryUploadStorage` |
| `DurableObjectMilestoneStorage`       | `MilestoneStorage`       |
| `DurableObjectRateLimitStorage`       | `RateLimitStorage`       |
| `DurableObjectKeyRegistryStorage`     | `KeyRegistryStorage`     |

Implementation notes:

- The document pending log stores one update per key (zero-padded sequence
  numbers), so appends are O(1) writes.
- `transaction()` is an in-memory per-key mutex. A Durable Object instance is
  the single writer for its storage, so no TTL or advisory locks are needed —
  the mutex only prevents interleaving between concurrent requests inside the
  same instance.
- Rate-limit TTLs are stamped expiry timestamps (Durable Object storage has
  no native TTL); expired state reads as absent and is deleted lazily.
- Use SQLite-backed Durable Objects (`new_sqlite_classes` in the migration):
  available on the free plan, 2 MiB per value. A document's compacted state
  and a milestone snapshot are each a single value, which bounds document
  size. File chunks are 1 MiB and always fit.

## WebSockets

`getDurableObjectWebsocketHooks({ server, onUpgrade })` wraps
`getWebsocketHandlers` from `teleportal/websocket-server` for crossws's
Cloudflare adapter (`crossws/adapters/cloudflare`), which has two quirks this
package accounts for:

- The durable upgrade path drops the context returned by the upgrade hook.
  The wrapper stashes it per-request and re-applies it to `peer.context`
  before `open` runs.
- The adapter uses the WebSocket hibernation API. When an instance is evicted
  and later woken by a message, the peer's in-memory state is gone; the
  websocket-server hooks detect this and close the socket so the client
  reconnects and resyncs.

This package never imports `crossws/adapters/cloudflare` itself (that module
only resolves inside workerd) — instantiate it in your Worker code and pass it
to `getDurableObjectHandlers`.

## Durable Object wiring

```ts
import crossws from "crossws/adapters/cloudflare";
import { Server } from "teleportal/server";
import { getHTTPHandlers } from "teleportal/http";
import {
  DurableObjectDocumentStorage,
  getDurableObjectHandlers,
  getDurableObjectWebsocketHooks,
} from "teleportal/cloudflare";

export class TeleportalDurableObject {
  ctx;
  env;
  #handlers;

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state; // crossws expects the state on `.ctx`
    this.env = env;

    const server = new Server({
      storage: async () =>
        new DurableObjectDocumentStorage(state.storage, { keyPrefix: "document" }),
    });

    const getContext = () => ({ userId: "someone", room: "docs" });

    this.#handlers = getDurableObjectHandlers({
      ws: crossws({
        hooks: getDurableObjectWebsocketHooks({
          server,
          onUpgrade: async () => ({ context: getContext() }),
        }),
      }),
      http: getHTTPHandlers({ server, getContext }),
    });
  }

  fetch(request: Request) {
    return this.#handlers.fetch(this, request);
  }
  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    return this.#handlers.webSocketMessage(this, ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    return this.#handlers.webSocketClose(this, ws, code, reason, wasClean);
  }
  webSocketPublish(topic: string, data: unknown, opts?: unknown) {
    return this.#handlers.webSocketPublish(this, topic, data, opts);
  }
}
```

The Worker resolves the instance and forwards everything — WebSocket upgrades
pass through `stub.fetch` unchanged:

```ts
export default {
  async fetch(request: Request, env: Env) {
    const stub = env.TELEPORTAL_DO.get(env.TELEPORTAL_DO.idFromName("teleportal"));
    return stub.fetch(request);
  },
};
```

See [`examples/cloudflare`](../../examples/cloudflare) for a complete,
deployable example (wrangler config, static assets, bundled browser client,
and all storages wired into RPC handlers).

## Scaling beyond one instance

`idFromName("teleportal")` pins the whole app to one Durable Object. To shard,
derive the instance name from the room (e.g. `idFromName(room)`) in both the
Worker and any place that mints client URLs — every client of a room must land
on the same instance.
