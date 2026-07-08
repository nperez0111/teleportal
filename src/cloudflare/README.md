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
structured clone, so updates, sidecars, chunks, and wrapped keys stay binary
(`Uint8Array`s round-trip natively; no base64/JSON encoding).

| Class                                 | Interface                | Default `keyPrefix` |
| ------------------------------------- | ------------------------ | ------------------- |
| `DurableObjectDocumentStorage`        | `DocumentStorage`        | `""` (none)         |
| `DurableObjectFileStorage`            | `FileStorage`            | `"file"`            |
| `DurableObjectTemporaryUploadStorage` | `TemporaryUploadStorage` | `"file"`            |
| `DurableObjectMilestoneStorage`       | `MilestoneStorage`       | `"milestone"`       |
| `DurableObjectRateLimitStorage`       | `RateLimitStorage`       | `"rate-limit"`      |
| `DurableObjectKeyRegistryStorage`     | `KeyRegistryStorage`     | `"key-registry"`    |

Each constructor takes `(storage: DurableObjectStorageLike, options?)`. Every
implementation partitions the shared `ctx.storage` keyspace by its `keyPrefix`,
so multiple storages can safely share one Durable Object's storage.
`DurableObjectDocumentStorage` also takes `encrypted?: boolean` (default
`true`).

### Key layouts

`{key}` is a Teleportal document/room id; `{prefix}` is the configured
`keyPrefix`.

**Document** (`DurableObjectDocumentStorage`):

```
{prefix}:{key}:state                -- { update, sidecars } (compacted base state)
{prefix}:{key}:meta                 -- DocumentMetadata
{prefix}:{key}:pending:{seq}        -- one PendingUpdate per key (seq zero-padded to 16)
{prefix}:{key}:attribution:{uuid}   -- attribution content-map blobs
```

**File** (`DurableObjectFileStorage`):

```
{prefix}:file-manifest:{fileId}     -- { metadata, contentId, totalChunks, serializedMerkleTree }
{prefix}:file-chunk:{fileId}:{i}    -- chunk bytes (≤1 MiB each)
```

**Temporary upload** (`DurableObjectTemporaryUploadStorage`):

```
{prefix}:upload-session:{uploadId}  -- { metadata, bytesUploaded, chunkIndexes, documentIds, lastActivity }
{prefix}:upload-chunk:{uploadId}:{i}-- chunk bytes (≤1 MiB each)
```

**Milestone** (`DurableObjectMilestoneStorage`):

```
{prefix}:milestone:{documentId}:meta           -- encoded meta doc (all milestones' metadata)
{prefix}:milestone:{documentId}:content:{id}   -- one encoded milestone snapshot
```

**Rate limit** (`DurableObjectRateLimitStorage`):

```
{prefix}:{key}                      -- { state, expiresAt }
```

**Key registry** (`DurableObjectKeyRegistryStorage`):

```
{prefix}:{documentId}               -- { generation, keys: Record<userId, wrappedKey> }
```

### Concurrency & transactions

A Durable Object instance is the single writer for its storage, so
`transaction()` is just an in-memory per-key mutex (`KeyedMutex`) — no TTL or
advisory locks needed. It exists only because Durable Objects interleave
concurrent requests at `await` points that leave storage (e.g. crypto), so the
mutex serializes read-modify-write sequences on the same key within one
instance. `KeyedMutex` chains callbacks per key via promises and drops the
per-key entry once its chain drains, so it never leaks; a rejected callback
does not poison later waiters on the same key.

Implementation notes:

- **Document pending log.** One update per key (`pending:{seq}`, `seq`
  zero-padded to 16 digits so lexicographic `list()` order equals insertion
  order), so `appendUpdate` is an O(1) write, not a read-append-rewrite. A
  per-document in-memory counter (`#nextSeq`) hands out sequence numbers; it is
  seeded once from the persisted log tail. The seeding `list()` is shared
  across concurrent first appends and counter advancement has no intervening
  `await`, so concurrent appends never collide on a sequence number.
  `getPendingUpdates` returns a `cursor` (a count); `clearPendingUpdates`
  removes only that many leading entries, so updates appended concurrently
  survive a compaction.
- **Attribution.** Each `storeAttribution` writes a fresh `attribution:{uuid}`
  blob; `retrieveAttribution` folds them with `mergeContentMaps`. Append-only
  writes avoid lost updates without locking.
- **Milestones** are scoped by `documentId`: both the meta doc and each content
  blob live under `milestone:{documentId}:…`, and snapshot hydration passes
  `(documentId, id)` through, so a milestone id never resolves or hydrates
  under the wrong document. `deleteMilestone` soft-deletes on the first call
  (marks `lifecycleState: "deleted"`) and hard-deletes the content blob on the
  second. A never-deleted milestone stores no `lifecycleState` (it is omitted
  from the wire), and `getMilestones({ lifecycleState: "active" })` treats that
  absence as `"active"`, so freshly-created milestones are returned.
- **File uploads** are content-addressed (`uploadId` is the merkle root), so a
  session may be shared across documents: `beginUpload` merges `documentId`s
  and rejects conflicting content metadata (`size`/`encrypted`); `storeChunk`
  is idempotent on identical retransmits and rejects conflicting bytes for an
  already-stored chunk (poisoning guard). Chunks survive `completeUpload` and
  are removed only by `deleteUpload`, so a failed durable store stays
  retriable.
- **Rate-limit TTLs** are stamped expiry timestamps (Durable Object storage has
  no native TTL); expired state reads as absent and is deleted lazily on the
  next read.
- **Key registry** keeps a monotonic `generation` per document for optimistic
  concurrency: `rotate` throws a `Key rotation conflict` (message shared across
  backends) unless `expectedGeneration` matches; `set`/`revoke` return the
  current generation unchanged.

### Value-size limits

Use SQLite-backed Durable Objects (`new_sqlite_classes` in the migration):
available on the free plan, with a 2 MiB per-value limit. A document's
compacted state and a milestone snapshot are each a single value, which bounds
document size. File chunks are 1 MiB and always fit. Bulk `delete()` accepts at
most 128 keys per call, so `deleteKeys` batches deletions and `listAll`
paginates with `startAfter`.

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

## Exports

From `teleportal/cloudflare` (see `index.ts`):

- Storage classes: `DurableObjectDocumentStorage`, `DurableObjectFileStorage`,
  `DurableObjectTemporaryUploadStorage`, `DurableObjectMilestoneStorage`,
  `DurableObjectRateLimitStorage`, `DurableObjectKeyRegistryStorage`.
- Wiring: `getDurableObjectWebsocketHooks`, `getDurableObjectHandlers`.
- Types/utilities: `DurableObjectStorageLike`, `DurableObjectStateLike`,
  `DurableObjectListOptions`, `CrosswsDurableAdapterLike`, `KeyedMutex`.

The package deliberately does **not** import `@cloudflare/workers-types`
(whose ambient globals clash with `@types/bun` in this repo's typecheck) or
`crossws/adapters/cloudflare` (which imports `cloudflare:workers` at module
scope and only resolves inside workerd). Instead it declares the minimal
structural types it needs (`DurableObjectStorageLike`,
`CrosswsDurableAdapterLike`); real Cloudflare/crossws objects satisfy them
structurally. You instantiate the crossws adapter in your Worker and pass it in.

## Testing

`FakeDOStorage` (`fake-do-storage.ts`) is an in-memory stand-in for
`DurableObjectStorageLike`, used by every test in this directory. It mirrors
the semantics that matter for correctness: values round-trip through
`structuredClone` (so a non-clonable value fails a test the same way real
storage would), `list()` returns entries in UTF-8 key order honoring
`prefix`/`start`/`startAfter`/`end`/`limit`/`reverse`, and bulk `delete()`
throws above 128 keys like the real API. It is a test-only helper (not part of
the package's public `./cloudflare` export); tests import it by relative path
and pass it straight into any storage class:

```ts
import { FakeDOStorage } from "./fake-do-storage";

const storage = new DurableObjectDocumentStorage(new FakeDOStorage(), {
  keyPrefix: "document",
});
```
