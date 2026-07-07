# Storage

The storage module provides a flexible, interface-based storage system for
Teleportal. All storage implementations are swappable -- implement the
interfaces and you can store to any backend you need.

## Architecture

The module is built on **interfaces, not implementations**:

- Any storage backend works: implement the interfaces for Redis, PostgreSQL,
  S3, MongoDB, or a custom API.
- Mix and match: use different implementations for different storage types
  (e.g., PostgreSQL for documents, S3 for files).
- Easy to test: swap in-memory implementations for testing.

Every storage type (DocumentStorage, FileStorage, MilestoneStorage, etc.) is
independent -- no coupling between them. You construct each one explicitly and
pass instances to their RPC handlers.

## Interfaces

All interfaces are defined in [`types.ts`](./types.ts).

### DocumentStorage

Stores Y.js document content, metadata, and handles synchronization.

- Store and retrieve document updates (Y.js binary V2 format)
- Manage document metadata (files, milestones, timestamps, size tracking)
- Handle sync operations (`handleSyncStep1`, `handleSyncStep2`)
- Support both encrypted (content-encrypted sidecars) and unencrypted documents
- Optional attribution storage (`storeAttribution` / `retrieveAttribution`)

The abstract base class [`AbstractDocumentStorage`](./document-storage.ts) uses
a **merge-on-read** pattern by default. Updates are appended to a pending log
on write (O(1)). Reads materialize the log by batch-merging all pending updates
with the base state via `Y.mergeUpdatesV2`. Subclasses implement storage
primitives: `appendUpdate`, `getPendingUpdates`, `clearPendingUpdates`,
`getBaseState`, `replaceBaseState`, plus metadata and delete methods.

### FileStorage

Stores file data (images, documents, etc.) associated with documents.

- Store files in chunks (64KB) with Merkle tree verification
- Content-addressed by merkle root hash
- Incremental upload from `TemporaryUploadStorage` via `storeFileFromUpload`
- Optional `temporaryUploadStorage` field for upload session management

### TemporaryUploadStorage

Handles temporary chunk storage during file uploads before files are committed
to `FileStorage`.

- Manage upload sessions (`beginUpload` / `completeUpload` / `deleteUpload`)
- Content-addressed: sessions can be shared across documents; conflicting
  metadata is rejected, identical retransmits are harmless
- Store chunks with merkle proof validation
- Clean up expired sessions

### MilestoneStorage

Stores document milestones (snapshots at specific points in time).

- Create and retrieve milestones with lazy snapshot hydration
- Soft delete / hard delete (two-phase: first delete marks as deleted, second
  removes permanently)
- Restore soft-deleted milestones
- `createdBy` field distinguishes user vs system milestones

### KeyRegistryStorage

Per-document, per-user wrapped encryption key storage for end-to-end
encryption. Defined in
[`protocols/key-registry/storage.ts`](../protocols/key-registry/storage.ts).

- `set` / `get` / `getAny` / `revoke` per-user wrapped keys
- `rotate` atomically replaces all keys and bumps the generation counter
  (optimistic concurrency via `expectedGeneration`)

### RateLimitStorage

Stores token-bucket rate limit state with TTL support.

- Get/set/delete rate limit state per key
- Transaction support for atomic check-and-decrement
- States expire after their TTL

## Concrete implementations

### In-memory (`in-memory/`)

Stores everything in process memory. Data is lost on restart.

| Class                            | Interface              |
| -------------------------------- | ---------------------- |
| `MemoryDocumentStorage`          | DocumentStorage        |
| `InMemoryFileStorage`            | FileStorage            |
| `InMemoryTemporaryUploadStorage` | TemporaryUploadStorage |
| `InMemoryMilestoneStorage`       | MilestoneStorage       |
| `InMemoryKeyRegistryStorage`     | KeyRegistryStorage     |

```typescript
import { MemoryDocumentStorage, InMemoryFileStorage } from "teleportal/storage";

const documentStorage = new MemoryDocumentStorage(/* encrypted */ true);
const fileStorage = new InMemoryFileStorage();
```

### IndexedDB (`idb/`)

Client-side storage using `lib0/indexeddb`. Used by the Provider for
encrypted-at-rest offline persistence.

| Class                | Interface                                |
| -------------------- | ---------------------------------------- |
| `IdbDocumentStorage` | DocumentStorage                          |
| `IdbFileCache`       | FileCache (chunk-level read/write cache) |

One IDB database per document with four object stores: `state` (compacted base
update + sidecar hash list), `meta` (JSON metadata), `sidecars`
(content-addressed encrypted blobs), `pending` (unmerged update log).

```typescript
import { IdbDocumentStorage } from "teleportal/storage";

const storage = new IdbDocumentStorage("teleportal-my-doc", true);
await storage.handleUpdate("my-doc", update);
storage.close(); // close IDB handle on teardown
```

### Unstorage (`unstorage/`)

Works with any backend supported by
[unstorage](https://github.com/unjs/unstorage) (Redis, filesystem, S3, SQLite
via db0, etc.).

| Class                             | Interface              |
| --------------------------------- | ---------------------- |
| `UnstorageDocumentStorage`        | DocumentStorage        |
| `UnstorageFileStorage`            | FileStorage            |
| `UnstorageTemporaryUploadStorage` | TemporaryUploadStorage |
| `UnstorageMilestoneStorage`       | MilestoneStorage       |
| `UnstorageRateLimitStorage`       | RateLimitStorage       |
| `UnstorageKeyRegistryStorage`     | KeyRegistryStorage     |

All classes take an unstorage `Storage` instance plus options with a per-type
`keyPrefix`. Transactions use TTL-based locking via
[`withTransaction`](./unstorage/transaction.ts) (exponential backoff, default
5s TTL). An optional [`createEncryptedDriver`](./unstorage/encrypted-driver.ts)
wraps any unstorage driver with AES-GCM encryption at rest.

```typescript
import { createStorage } from "unstorage";
import { UnstorageDocumentStorage } from "teleportal/storage";

const storage = createStorage();
const docStorage = new UnstorageDocumentStorage(storage, {
  keyPrefix: "document",
  encrypted: true,
  ttl: 5000,
});
```

### Postgres (`postgres/`)

First-party Postgres adapters. Faster than unstorage: binary payloads live in
`bytea` (no base64/hex), pending-log appends are single O(1) inserts, and
locking uses session advisory locks instead of TTL polling.

Requires the optional `postgres` peer dependency -- or, on Bun, no dependency
at all (the adapters type against a minimal
[`Sql` interface](./postgres/types.ts) that both
[`postgres`](https://github.com/porsager/postgres) and `Bun.sql` satisfy).

| Class                        | Interface          |
| ---------------------------- | ------------------ |
| `PostgresDocumentStorage`    | DocumentStorage    |
| `PostgresMilestoneStorage`   | MilestoneStorage   |
| `PostgresRateLimitStorage`   | RateLimitStorage   |
| `PostgresKeyRegistryStorage` | KeyRegistryStorage |

Run `ensureSchema(sql, { tablePrefix })` once at startup. All `CREATE ... IF
NOT EXISTS` with a version stamp that fails loudly on mismatch.

```typescript
import postgres from "postgres";
import { PostgresDocumentStorage, ensureSchema } from "teleportal/storage/postgres";

const sql = postgres("postgres://localhost/mydb", { max: 10 });
await ensureSchema(sql);

const storage = new PostgresDocumentStorage(sql, { encrypted: true });
// Call storage.close() at shutdown to release the lock connection.
```

Key design decisions:

- `transaction()` uses session advisory locks on one dedicated pooled
  connection per adapter; configure the wait bound with `lockTimeoutMs`
  (default 30s, throws `LockTimeoutError`)
- Composite writes (key rotation, document deletion, attribution compaction)
  use `BEGIN/COMMIT`
- Rate-limit table is `UNLOGGED` (token buckets are reconstructible)
- Attribution blobs append O(1) and self-compact past a threshold
- Each adapter reserves one lock connection lazily; use `max >= 2` (10+
  recommended)

### S3 (`s3/`)

First-party file storage for AWS S3, Cloudflare R2, and MinIO. Built on the
optional [`aws4fetch`](https://github.com/mhart/aws4fetch) peer dependency
(~6KB SigV4 signer, zero deps).

| Class                      | Interface              |
| -------------------------- | ---------------------- |
| `S3FileStorage`            | FileStorage            |
| `S3TemporaryUploadStorage` | TemporaryUploadStorage |

```typescript
import { S3FileStorage, S3Http, S3TemporaryUploadStorage } from "teleportal/storage/s3";

const s3 = new S3Http({
  endpoint: "https://<account>.r2.cloudflarestorage.com",
  bucket: "my-bucket",
  region: "auto",
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
});

const temp = new S3TemporaryUploadStorage(s3);
const files = new S3FileStorage(s3, { temporaryUploadStorage: temp });
```

Key design decisions:

- Content-addressed layout under `{prefix}files/{fileId}/` with the manifest
  written last as the commit point -- readers never observe partial files
- Chunk uploads carry their merkle leaf hash as object metadata, so
  `completeUpload` builds the tree from HEAD requests (no re-download)
- Promotion to durable storage uses server-side `CopyObject` when both stores
  share a bucket -- upload bytes cross the app exactly once
- Retries with exponential backoff + jitter (429/5xx/network, honoring
  `Retry-After`); per-attempt request timeouts; typed `S3Error`
- Downloads use bounded parallelism (`concurrency`, default 8) and fail loudly
  on missing chunks

## Wrappers and composition

### TieredDocumentStorage

Composes two `AbstractDocumentStorage` instances into a two-tier system: a fast
tier (e.g. in-memory) for active documents and a slow tier (e.g. Postgres or
unstorage) for durable persistence. Documents are loaded from the slow tier on
first access; all subsequent reads/writes operate on the fast tier. Dirty
documents are periodically flushed to the slow tier in the background.

```typescript
import { TieredDocumentStorage, MemoryDocumentStorage } from "teleportal/storage";

const tiered = new TieredDocumentStorage(
  new MemoryDocumentStorage(true),
  new UnstorageDocumentStorage(storage, { encrypted: true }),
  {
    persistIntervalMs: 5000, // sweep every 5s (default)
    maxDirtyAgeMs: 30_000, // force persist after 30s (default)
    persistBatchSize: 50, // max docs per sweep (default)
    evictAfterMs: 60_000, // evict clean docs from fast tier
    onPersistError: (id, err) => console.error(id, err),
  },
);

// Manual flush when needed (e.g. before shutdown)
await tiered.flushAll();
// Implements Symbol.asyncDispose -- flushes on dispose
```

### MergeOnWriteStorage

Decorator that turns any `AbstractDocumentStorage` subclass into a
merge-on-write storage. Overrides `handleUpdate` to eagerly merge each incoming
update into the base state, so the pending log is always empty and reads are
simple base-state lookups.

```typescript
import { MergeOnWriteStorage, MemoryDocumentStorage } from "teleportal/storage";

const storage = new MergeOnWriteStorage(new MemoryDocumentStorage(true));
```

### VirtualStorage

Configurable wrapper that adds batching and buffering to any `DocumentStorage`.
Buffers writes in memory and flushes them in configurable batches (by size or
time). Reads flush pending writes first to ensure consistency.

```typescript
import { VirtualStorage } from "teleportal/storage";

const batched = new VirtualStorage(existingDocumentStorage, {
  batchMaxSize: 100, // flush every 100 updates
  batchWaitMs: 2000, // or every 2 seconds
});
```

### TieredRateLimitStorage

Wraps any `RateLimitStorage` with an in-memory LRU cache. Reads hit the cache
first; writes are write-through (cache updated synchronously, backing store
fire-and-forget). Since rate limit state is ephemeral and TTL-based, slight
cache staleness is acceptable.

```typescript
import { TieredRateLimitStorage } from "teleportal/storage";

const tiered = new TieredRateLimitStorage(backingStorage, {
  maxCacheSize: 10_000, // default
});
```

## Utilities

- [`rate-limit-utils.ts`](./rate-limit-utils.ts) -- Token bucket math:
  `calculateTokensToAdd`, `refillRateLimitState`, `createInitialState`,
  `isStateExpired`, `getRateLimitKey`
- [`utils.ts`](./utils.ts) -- `calculateDocumentSize`, `bytesEqual`
- [`batch.ts`](./batch.ts) -- Internal batching primitive used by
  `VirtualStorage`

## Creating custom implementations

Subclass `AbstractDocumentStorage` and implement the storage primitives:

```typescript
import type { DocumentMetadata } from "teleportal/storage";
import type { IndexedSidecar } from "teleportal/protocol/encryption";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
} from "teleportal/storage";

export class MyStorage extends AbstractDocumentStorage {
  constructor(encrypted = true) {
    super(encrypted);
  }

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    /* ... */
  }
  async getPendingUpdates(key: string) {
    /* ... */
  }
  async clearPendingUpdates(key: string, upToCursor: number) {
    /* ... */
  }
  async getBaseState(key: string): Promise<DocumentState | null> {
    /* ... */
  }
  async replaceBaseState(key: string, update: Uint8Array, sidecars: IndexedSidecar[]) {
    /* ... */
  }
  async writeDocumentMetadata(key: string, metadata: DocumentMetadata) {
    /* ... */
  }
  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    /* ... */
  }
  async deleteDocument(key: string) {
    /* ... */
  }

  // Optional overrides:
  // transaction<T>(key: string, cb: () => Promise<T>): Promise<T>
  // storeAttribution(key: string, attribution: EncodedContentMap): Promise<void>
}
```

For `FileStorage`, `MilestoneStorage`, `KeyRegistryStorage`, and
`RateLimitStorage`, implement the interfaces directly from `types.ts`.
