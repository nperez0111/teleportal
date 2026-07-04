# Storage Module

The storage module provides a flexible, interface-based storage system for Teleportal. **All storage implementations are swappable** - you can use the provided implementations or create your own custom storage backends for any storage system you need.

## Design Philosophy

The storage module is built on **interfaces, not implementations**. This means:

- ✅ **Any storage backend works** - Implement the interfaces and you can store to Redis, PostgreSQL, S3, MongoDB, or even a custom API
- ✅ **Mix and match** - Use different implementations for different storage types (e.g., PostgreSQL for documents, S3 for files)
- ✅ **Easy to test** - Swap in-memory implementations for testing
- ✅ **Future-proof** - Add new storage backends without changing existing code

## Storage Types

The storage module consists of four main storage interfaces:

### 1. DocumentStorage

Stores document content, metadata, and handles Y.js synchronization.

**Key Responsibilities:**

- Store and retrieve document updates (Y.js binary format)
- Manage document metadata (files, milestones, timestamps)
- Handle sync operations (sync-step-1, sync-step-2)
- Support both encrypted and unencrypted documents

**Interface:** [`DocumentStorage`](./types.ts#L415)

### 2. FileStorage

Stores file data (images, documents, etc.) associated with documents.

**Key Responsibilities:**

- Store files in chunks (64KB) with Merkle tree verification
- Manage file metadata (filename, size, MIME type)
- Link files to documents
- Support incremental uploads from temporary storage

**Interface:** [`FileStorage`](./types.ts#L189)

### 3. MilestoneStorage

Stores document milestones (snapshots at specific points in time).

**Key Responsibilities:**

- Create and retrieve milestones
- Store milestone snapshots
- Manage milestone metadata (names, timestamps, createdBy)
- Handle soft delete and restore operations

**Milestone Creation:**

All milestones must include a `createdBy` field that indicates who or what created the milestone:

- `{ type: "user", id: userId }` - Created by a user via `milestone-create-request`
- `{ type: "system", id: nodeId }` - Created automatically by the system (triggers, API)

**Interface:** [`MilestoneStorage`](./types.ts#L231)

### 4. TemporaryUploadStorage

Handles temporary storage during file uploads before files are committed to FileStorage.

**Key Responsibilities:**

- Manage upload sessions
- Store chunks during upload
- Verify Merkle proofs
- Clean up expired uploads

**Interface:** [`TemporaryUploadStorage`](./types.ts#L73)

### 5. Document Size Tracking

Document storage implementations automatically track the size of documents in bytes. This metadata is stored in `sizeBytes` field of `DocumentMetadata`.

**Metadata Fields:**

- `sizeBytes`: Current size of the document in bytes
- `sizeWarningThreshold`: Optional threshold in bytes to trigger a warning event

### 7. RateLimitStorage

Stores rate limit state (token buckets) with TTL support.

**Key Responsibilities:**

- Store rate limit tokens and last refill time
- Support TTL (Time To Live) for automatic expiration
- Transaction support for atomic updates

**Interface:** [`RateLimitStorage`](./types.ts#L503)

## Provided Implementations

### Postgres Implementation (`teleportal/storage/postgres`)

First-party Postgres adapters for every server-side storage type. Faster than
the generic unstorage path: binary payloads live in `bytea` (no base64/hex
inflation), pending-log appends are single O(1) inserts into an append-only
table with one composite index, and locking uses Postgres advisory locks
instead of TTL polling.

Requires the optional `postgres` peer dependency — or, on Bun, no dependency
at all: the adapters type against a minimal structural interface that both
[`postgres`](https://github.com/porsager/postgres) and Bun's built-in
`Bun.sql` satisfy.

**Usage:**

```typescript
import postgres from "postgres"; // or: import { SQL } from "bun"
import {
  PostgresDocumentStorage,
  PostgresKeyRegistryStorage,
  PostgresMilestoneStorage,
  PostgresRateLimitStorage,
  ensureSchema,
} from "teleportal/storage/postgres";

const sql = postgres("postgres://user:pass@localhost:5432/app", { max: 10 });
await ensureSchema(sql); // idempotent CREATE IF NOT EXISTS; safe on startup

const server = new Server({
  storage: async (ctx) => new PostgresDocumentStorage(sql, { encrypted: ctx.encrypted }),
});

const milestoneStorage = new PostgresMilestoneStorage(sql);
const rateLimitStorage = new PostgresRateLimitStorage(sql);
const keyRegistryStorage = new PostgresKeyRegistryStorage(sql);
```

**Key Features:**

- `ensureSchema(sql, { tablePrefix })` manages the schema (all
  `CREATE ... IF NOT EXISTS`, with a version stamp that fails loudly on
  mismatch); `SCHEMA_SQL` exports the raw DDL for external migration tooling
- `transaction()` uses session advisory locks on one dedicated pooled
  connection per adapter (auto-released if the process dies — no TTL expiry
  window); configure the wait bound with `lockTimeoutMs` (default 30s, throws
  `LockTimeoutError`)
- Composite writes that must be atomic (key rotation, document deletion,
  attribution compaction) run in real `BEGIN/COMMIT` transactions
- The rate-limit table is `UNLOGGED` (token buckets are reconstructible, so
  WAL is skipped on the per-message hot path); wrap with
  `TieredRateLimitStorage` to serve reads from memory
- Attribution blobs append O(1) and self-compact past a threshold
- Pool sizing: each adapter reserves one lock connection lazily, so use
  `max >= 2` (10+ recommended); the adapters never call `sql.end()` — call
  `close()` on each adapter to release its lock connection at shutdown

### S3 Implementation (`teleportal/storage/s3`)

First-party file storage for AWS S3, Cloudflare R2, and MinIO, built on the
optional [`aws4fetch`](https://github.com/mhart/aws4fetch) peer dependency
(~6KB SigV4 signer over standard `fetch` — no AWS SDK).

**Usage:**

```typescript
import { S3FileStorage, S3Http, S3TemporaryUploadStorage } from "teleportal/storage/s3";

const s3 = new S3Http({
  endpoint: "https://<account>.r2.cloudflarestorage.com", // or MinIO/AWS
  bucket: "my-bucket",
  region: "auto", // R2; use the real region for AWS
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
});

const temporaryUploadStorage = new S3TemporaryUploadStorage(s3);
const fileStorage = new S3FileStorage(s3, { temporaryUploadStorage });
```

**Key Features:**

- Content-addressed layout under `{prefix}files/{fileId}/` with the manifest
  written last as a commit point — readers never observe partial files;
  identical content is deduplicated (stored once, skipped on re-upload)
- Chunk uploads carry their merkle leaf hash as object metadata, so
  `completeUpload` builds the tree from HEAD requests instead of re-reading
  chunk bytes, and promotion to durable storage uses server-side
  `CopyObject` when both stores share a bucket — upload bytes cross the app
  exactly once
- Retries with exponential backoff + jitter (429/5xx/network, honoring
  `Retry-After`), per-attempt request timeouts, typed `S3Error`
- Downloads fetch chunks with bounded parallelism (`concurrency`, default 8)
  and fail loudly on missing chunks instead of serving corrupt files
- `cleanupExpiredUploads()` expires stale sessions (default 24h); also add a
  native S3/R2 lifecycle rule on `{prefix}uploads/` as defense-in-depth
- MinIO works out of the box with `pathStyle: true` (the default)

### Unstorage Implementation

The **unstorage** implementation works with any storage backend supported by [unstorage](https://github.com/unjs/unstorage), including:

- **Key-value stores**: Redis, Memcached, etcd
- **Databases**: PostgreSQL, MySQL, SQLite (via db0)
- **File systems**: Local filesystem, S3, Cloudflare R2, Azure Blob
- **In-memory**: For testing and development

**Usage:**

```typescript
import { createStorage } from "unstorage";
import { UnstorageDocumentStorage, UnstorageRateLimitStorage } from "teleportal/storage";
import redisDriver from "unstorage/drivers/redis";

const storage = createStorage({
  driver: redisDriver({
    base: "teleportal:",
    // ... redis config
  }),
});

const server = new Server({
  storage: async (ctx) => {
    return new UnstorageDocumentStorage(storage, {
      keyPrefix: "document",
      encrypted: ctx.encrypted,
    });
  },
});

// Create Rate Limit Storage
const rateLimitStorage = new UnstorageRateLimitStorage(storage, {
  keyPrefix: "rate-limit",
});
```

**Key Features:**

- Configurable key prefix per storage type
- Supports both encrypted and unencrypted documents via the `encrypted` flag
- Transaction support with TTL-based locking (default: 5000ms)
- All storage instances are completely independent

### IndexedDB Implementation (Client-side)

The **IDB** implementation stores data in IndexedDB using `lib0/indexeddb`. Used by the Provider for encrypted-at-rest offline persistence.

**Key Features:**

- Zero additional dependencies (uses `lib0/indexeddb`, already a transitive dep)
- Stores binary directly (IndexedDB supports structured clone — no base64)
- Atomic multi-tab writes via `transaction()` override
- Fails cleanly when `indexedDB` is unavailable (SSR/Node)
- Same `AbstractDocumentStorage` base as the server — content-encrypted payloads stored as-is

**Usage:**

```typescript
import { IdbDocumentStorage } from "teleportal/storage";

// One DB per document, named by prefix + document ID
const storage = new IdbDocumentStorage("teleportal-my-doc", true);
await storage.handleUpdate("my-doc", update);
const doc = await storage.getDocument("my-doc");
storage.close(); // close IDB handle on teardown
```

### In-Memory Implementation

The **in-memory** implementation stores everything in process memory. Perfect for:

- Testing
- Development
- Single-server deployments
- Prototyping

**Usage:**

```typescript
import { MemoryDocumentStorage } from "teleportal/storage";

const server = new Server({
  storage: async (ctx) => {
    return new MemoryDocumentStorage(ctx.encrypted);
  },
});
```

**Key Features:**

- Zero configuration
- Fast (no I/O)
- Data lost on restart
- Supports both encrypted and unencrypted documents via the constructor flag

## Creating Custom Storage Implementations

You can create custom storage implementations for any backend. Here's how:

### Example: Custom DocumentStorage

The base class uses a **merge-on-read** pattern. Updates are appended to a pending
log on write (O(1)). Reads materialize the log by batch-merging all pending updates
with the base state. Your subclass implements the storage primitives below.

```typescript
import type { DocumentMetadata } from "teleportal/storage";
import type { IndexedSidecar } from "teleportal/protocol/encryption";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
} from "teleportal/storage";

export class MyCustomDocumentStorage extends AbstractDocumentStorage {
  // Encrypted is the default; pass `false` for a plaintext document.
  constructor(encrypted: boolean = true) {
    super(encrypted);
  }

  // -- Pending log (merge-on-read) --

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    await myBackend.appendToPendingLog(key, entry);
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    const list = await myBackend.getPendingLog(key);
    return { updates: list, cursor: list.length };
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    await myBackend.clearPendingLog(key, upToCursor);
  }

  // -- Base (compacted) state --

  async getBaseState(key: string): Promise<DocumentState | null> {
    const data = await myBackend.getState(key);
    if (!data) return null;
    return { update: data.update, sidecars: data.sidecars ?? [] };
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    await myBackend.storeState(key, { update, sidecars });
  }

  // -- Metadata --

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    await myBackend.storeMetadata(key, metadata);
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    return (
      (await myBackend.getMetadata(key)) ?? {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: this.encrypted,
      }
    );
  }

  // -- Cleanup --

  async deleteDocument(key: string): Promise<void> {
    await myBackend.deleteDocument(key);
  }

  // Optional: Override transaction if your backend supports it
  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return await myBackend.transaction(key, cb);
  }
}
```

### Example: Custom FileStorage

```typescript
import type { FileStorage, File, FileMetadata, FileUploadResult } from "teleportal/storage";

export class S3FileStorage implements FileStorage {
  readonly type = "file-storage" as const;
  temporaryUploadStorage?: TemporaryUploadStorage;

  async getFile(fileId: string): Promise<File | null> {
    // Retrieve from S3
    const metadata = await s3.getObjectMetadata(fileId);
    if (!metadata) return null;

    // Fetch chunks from S3
    const chunks = await Promise.all(metadata.chunkKeys.map((key) => s3.getObject(key)));

    return {
      id: fileId,
      metadata: metadata.fileMetadata,
      chunks,
      contentId: metadata.contentId,
    };
  }

  async deleteFile(fileId: string): Promise<void> {
    await s3.deleteObject(fileId);
    // Also delete chunks...
  }

  async storeFileFromUpload(uploadResult: FileUploadResult): Promise<void> {
    // Store chunks incrementally in S3
    for (let i = 0; i < uploadResult.totalChunks; i++) {
      const chunk = await uploadResult.getChunk(i);
      await s3.putObject(`file:${uploadResult.fileId}:chunk:${i}`, chunk);
    }
    // Store metadata
    await s3.putObjectMetadata(uploadResult.fileId, {
      metadata: uploadResult.progress.metadata,
      contentId: uploadResult.contentId,
    });
  }
}
```

## Storage Composition

Storage implementations are completely independent. Each storage type (DocumentStorage, FileStorage, MilestoneStorage) operates separately without any coupling. This allows you to use different backends for different storage types.

```typescript
// Use PostgreSQL for documents, S3 for files, and Redis for milestones
const documentStorage = new PostgresDocumentStorage(db);
const fileStorage = new S3FileStorage(s3Client);
const milestoneStorage = new RedisMilestoneStorage(redisClient);

// Each storage instance is independent - no wiring needed
```

### VirtualStorage Wrapper

**VirtualStorage** is a configurable wrapper that adds batching and buffering to any `DocumentStorage` implementation, improving write performance by reducing DB I/O operations.

**Key Features:**

- **Write Buffering**: Buffers document updates and metadata in memory
- **Batched Persistence**: Batches writes using a custom batching mechanism (configurable max size and time)
- **Read Consistency**: Flushes pending writes on reads to ensure data consistency
- **Framework-Agnostic**: Works with any `DocumentStorage` implementation

**Usage:**

```typescript
import { VirtualStorage } from "teleportal/storage";

// Wrap any existing storage with batching
const batchedStorage = new VirtualStorage(existingDocumentStorage, {
  batchMaxSize: 100, // Batch every 100 updates
  batchWaitMs: 2000, // Or every 2 seconds
});

// Use as normal DocumentStorage
await batchedStorage.handleUpdate("doc1", update);
const doc = await batchedStorage.getDocument("doc1"); // Flushes pending writes
```

**When to Use:**

- High-frequency collaborative updates
- Slow storage backends (remote DBs, object storage)
- Reducing I/O overhead in write-heavy applications

**Configuration:**

- `batchMaxSize`: Maximum updates per batch (default: 100)
- `batchWaitMs`: Maximum time to wait before flushing (default: 2000ms)
- Batches flush when either limit is reached

**Performance Impact:**

- **Writes**: Faster acknowledgment (buffered), reduced DB calls
- **Reads**: Slight overhead from potential flush, but ensures consistency
- **Memory**: Uses memory for buffering (proportional to batch size)

This wrapper is especially useful for collaborative apps where many small updates need to be persisted efficiently.

### MergeOnWriteStorage Wrapper

**MergeOnWriteStorage** is a decorator that turns any `AbstractDocumentStorage` subclass into a merge-on-write storage. It overrides `handleUpdate` to eagerly merge each incoming update into the base state, so the pending log is always empty and reads are simple base-state lookups.

**Usage:**

```typescript
import { MergeOnWriteStorage, MemoryDocumentStorage } from "teleportal/storage";

// Wrap any AbstractDocumentStorage subclass
const storage = new MergeOnWriteStorage(new MemoryDocumentStorage());
```

**When to Use:**

- Read-heavy workloads where you want reads to be fast (no merge cost)
- When write latency is acceptable (each write pays the merge cost)

### TieredDocumentStorage Wrapper

**TieredDocumentStorage** composes two `AbstractDocumentStorage` instances into a two-tier system — a fast tier for active documents and a slow tier for durable persistence. All reads and writes go to the fast tier; dirty documents are periodically flushed to the slow tier in the background.

**Usage:**

```typescript
import {
  TieredDocumentStorage,
  MemoryDocumentStorage,
  UnstorageDocumentStorage,
} from "teleportal/storage";

const fast = new MemoryDocumentStorage();
const slow = new UnstorageDocumentStorage(storage, { keyPrefix: "doc" });

const tiered = new TieredDocumentStorage(fast, slow, {
  persistIntervalMs: 5000, // Sweep every 5 seconds (default: 5000)
  maxDirtyAgeMs: 30000, // Force persist after 30 seconds (default: 30000)
  persistBatchSize: 50, // Max documents per sweep (default: 50)
  evictAfterMs: 60000, // Evict clean docs from fast tier after 1 min of inactivity
  onPersistError: (docId, err) => console.error(`Persist failed for ${docId}`, err),
});

// Use as normal DocumentStorage
const server = new Server({ storage: tiered });

// Manual flush when needed (e.g., before shutdown)
await tiered.flushAll();
```

**How it works:**

- Documents are loaded from the slow tier on first access and cached in the fast tier.
- All subsequent reads and writes operate on the fast tier (fast path).
- A background sweep runs every `persistIntervalMs`, flushing dirty documents to the slow tier in batches of `persistBatchSize`.
- Documents that have been dirty longer than `maxDirtyAgeMs` are prioritized.
- Clean documents can be evicted from the fast tier after `evictAfterMs` of inactivity to bound memory.
- Attribution data is buffered and flushed alongside the document state.

**When to Use:**

- Production deployments where you want in-memory read/write speed with durable persistence
- High-frequency collaborative updates where you can tolerate a short window of data loss on crash (bounded by `persistIntervalMs`)
- Large document sets where keeping everything in memory is impractical (use `evictAfterMs` to bound the fast tier)

**Lifecycle:** Implements `Symbol.asyncDispose` — use `await using` or call `flushAll()` before shutdown to ensure all dirty documents are persisted.

## Constructing Storage

Each storage type is a class you instantiate directly. You construct each one
explicitly and pass the file/milestone instances to their RPC handlers. This keeps
every storage instance fully independent so you can mix backends freely.

### Unstorage classes

`UnstorageDocumentStorage`, `UnstorageFileStorage`, `UnstorageMilestoneStorage`,
`UnstorageTemporaryUploadStorage`, and `UnstorageRateLimitStorage` all take an
[unstorage](https://github.com/unjs/unstorage) instance plus an options object
with a per-type `keyPrefix`.

```typescript
import {
  UnstorageDocumentStorage,
  UnstorageFileStorage,
  UnstorageMilestoneStorage,
  UnstorageTemporaryUploadStorage,
} from "teleportal/storage";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const temporaryUploadStorage = new UnstorageTemporaryUploadStorage(storage, {
  keyPrefix: "file",
});

const fileStorage = new UnstorageFileStorage(storage, {
  keyPrefix: "file",
  temporaryUploadStorage,
});

const milestoneStorage = new UnstorageMilestoneStorage(storage, {
  keyPrefix: "document-milestone",
});

// Create handlers with storage instances
const fileHandlers = getFileRpcHandlers(fileStorage);
const milestoneHandlers = getMilestoneRpcHandlers(milestoneStorage);

// Document storage is created per request via the Server `storage` option
const server = new Server({
  storage: async (ctx) =>
    new UnstorageDocumentStorage(storage, {
      keyPrefix: "document",
      encrypted: ctx.encrypted,
    }),
  rpcHandlers: { ...fileHandlers, ...milestoneHandlers },
});
```

**`UnstorageDocumentStorage` options:**

- `keyPrefix`: Namespace prefix for this storage's keys.
- `encrypted`: When `true` (the **default**), the storage tags the document as content-encrypted (it stores the plaintext CRDT structure update alongside the encrypted content sidecars). Pass `false` for a plaintext document. The server treats encrypted and plaintext content identically — this flag only tags metadata; the server never sees content or keys. Wire this from `ctx.encrypted` so it follows the session's mode.
- `ttl`: Transaction lock timeout in milliseconds (default: 5000ms). Prevents deadlocks by automatically releasing locks after this duration.

### In-memory classes

`MemoryDocumentStorage`, `InMemoryFileStorage`, `InMemoryMilestoneStorage`, and
`InMemoryTemporaryUploadStorage` store everything in process memory.

```typescript
import {
  MemoryDocumentStorage,
  InMemoryFileStorage,
  InMemoryMilestoneStorage,
} from "teleportal/storage";

// Defaults to encrypted; pass `new MemoryDocumentStorage(false)` for plaintext
const documentStorage = new MemoryDocumentStorage();
const fileStorage = new InMemoryFileStorage();
const milestoneStorage = new InMemoryMilestoneStorage();
```

## Architecture Notes

### Separation of Concerns

- **DocumentStorage** handles document content and metadata
- **FileStorage** handles file data independently
- **TemporaryUploadStorage** handles upload sessions separately
- **MilestoneStorage** handles snapshots independently

This separation allows you to:

- Store documents in a database and files in object storage
- Use different backends for different storage types
- Scale each storage type independently

### Key Prefixes

When using the same storage backend for multiple storage types, use key prefixes to namespace them:

```typescript
new UnstorageFileStorage(storage, { keyPrefix: "file" }); // Files stored as "file:file:..."
new UnstorageDocumentStorage(storage, { keyPrefix: "document" }); // Documents stored as "document:..."
new UnstorageMilestoneStorage(storage, { keyPrefix: "document-milestone" }); // Milestones stored as "document-milestone:..."
```

This prevents key collisions and allows you to:

- Use the same Redis instance for multiple applications
- Organize data by type
- Easily query or delete by prefix

### Transactions

DocumentStorage supports transactions for atomic operations. Implementations can:

- Use database transactions (PostgreSQL, MySQL)
- Use distributed locks (Redis, etcd) with TTL-based timeout
- Use optimistic locking
- Or simply execute sequentially (in-memory)

The interface is flexible enough to support any transaction model.

**Transaction TTL:**
The unstorage implementation uses TTL-based locking (default: 5000ms). This prevents deadlocks by automatically releasing locks after the timeout period. Adjust the `ttl` option based on your expected transaction duration and network latency.

## Examples

### Using PostgreSQL for Documents & Milestones, S3/R2 for Files

```typescript
import postgres from "postgres";
import {
  PostgresDocumentStorage,
  PostgresMilestoneStorage,
  ensureSchema,
} from "teleportal/storage/postgres";
import { S3FileStorage, S3Http, S3TemporaryUploadStorage } from "teleportal/storage/s3";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const sql = postgres(process.env.DATABASE_URL!, { max: 10 });
await ensureSchema(sql);

const s3 = new S3Http({
  endpoint: process.env.S3_ENDPOINT!,
  bucket: process.env.S3_BUCKET!,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
});
const temporaryUploadStorage = new S3TemporaryUploadStorage(s3);
const fileStorage = new S3FileStorage(s3, { temporaryUploadStorage });

const milestoneStorage = new PostgresMilestoneStorage(sql);

const server = new Server({
  storage: async (ctx) => new PostgresDocumentStorage(sql, { encrypted: ctx.encrypted }),
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage),
    ...getMilestoneRpcHandlers(milestoneStorage),
  },
});
```

### Using Redis for Everything

```typescript
import { createStorage } from "unstorage";
import redisDriver from "unstorage/drivers/redis";
import {
  UnstorageDocumentStorage,
  UnstorageFileStorage,
  UnstorageMilestoneStorage,
} from "teleportal/storage";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const storage = createStorage({
  driver: redisDriver({
    base: "teleportal:",
    url: "redis://localhost:6379",
  }),
});

const fileStorage = new UnstorageFileStorage(storage, { keyPrefix: "file" });
const milestoneStorage = new UnstorageMilestoneStorage(storage, {
  keyPrefix: "document-milestone",
});

const server = new Server({
  storage: async (ctx) =>
    new UnstorageDocumentStorage(storage, { keyPrefix: "doc", encrypted: ctx.encrypted }),
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage),
    ...getMilestoneRpcHandlers(milestoneStorage),
  },
});
```

### Using In-Memory for Testing

```typescript
import {
  MemoryDocumentStorage,
  InMemoryFileStorage,
  InMemoryMilestoneStorage,
} from "teleportal/storage";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const fileStorage = new InMemoryFileStorage();
const milestoneStorage = new InMemoryMilestoneStorage();

const server = new Server({
  storage: async () => new MemoryDocumentStorage(),
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage),
    ...getMilestoneRpcHandlers(milestoneStorage),
  },
});
```

### Accessing Milestone Storage

```typescript
import { InMemoryMilestoneStorage } from "teleportal/storage";

const milestoneStorage = new InMemoryMilestoneStorage();

// Create a milestone
const milestoneId = await milestoneStorage.createMilestone({
  name: "Version 1.0",
  documentId: "doc-123",
  createdAt: Date.now(),
  snapshot: {
    /* milestone snapshot */
  },
  createdBy: { type: "system", id: "node-1" },
});

// Get all milestones for a document
const milestones = await milestoneStorage.getMilestones("doc-123");
```

## Best Practices

1. **Create storage instances independently** - Each storage type (DocumentStorage, FileStorage, MilestoneStorage) is independent
2. **Create RPC handlers for file/milestone operations** - Use `getFileRpcHandlers()` and `getMilestoneRpcHandlers()` to create handlers
3. **Server only knows about DocumentStorage** - The Server receives handlers created with specific storage, but only DocumentStorage is passed via the `storage` option
4. **Set appropriate TTL** - Adjust transaction TTL based on your expected operation duration and network latency (default: 5000ms)
5. **Separate concerns** - Use different backends for documents vs files when it makes sense (e.g., PostgreSQL for documents, S3 for files)
6. **Use key prefixes** - Namespace your data to avoid collisions and enable easy querying/deletion by prefix
7. **Always provide `createdBy`** - The `createdBy` field is required when creating milestones to distinguish user vs system milestones
8. **Handle errors gracefully** - Storage operations can fail, handle errors appropriately
9. **Test with in-memory** - Use in-memory storage for fast, isolated tests

## Interface Reference

See [`types.ts`](./types.ts) for complete interface definitions:

- [`DocumentStorage`](./types.ts#L415)
- [`FileStorage`](./types.ts#L189)
- [`MilestoneStorage`](./types.ts#L231)
- [`TemporaryUploadStorage`](./types.ts#L73)

## Summary

The storage module is designed to be **flexible and swappable**. The provided implementations (unstorage, in-memory) are just examples - you can implement the interfaces for any storage backend you need. This design allows Teleportal to work with virtually any storage system while keeping the core logic storage-agnostic.
