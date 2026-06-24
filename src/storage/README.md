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

**Interface:** [`DocumentStorage`](./types.ts#L372)

### 2. FileStorage

Stores file data (images, documents, etc.) associated with documents.

**Key Responsibilities:**

- Store files in chunks (64KB) with Merkle tree verification
- Manage file metadata (filename, size, MIME type)
- Link files to documents
- Support incremental uploads from temporary storage

**Interface:** [`FileStorage`](./types.ts#L198)

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

**Interface:** [`MilestoneStorage`](./types.ts#L257)

### 4. TemporaryUploadStorage

Handles temporary storage during file uploads before files are committed to FileStorage.

**Key Responsibilities:**

- Manage upload sessions
- Store chunks during upload
- Verify Merkle proofs
- Clean up expired uploads

**Interface:** [`TemporaryUploadStorage`](./types.ts#L63)

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

**Interface:** [`RateLimitStorage`](./types.ts#L591)

## Provided Implementations

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

```typescript
import type { DocumentMetadata } from "teleportal/storage";
import type { IndexedSidecar } from "teleportal/protocol/encryption";
import { AbstractDocumentStorage, type DocumentState } from "teleportal/storage";

export class MyCustomDocumentStorage extends AbstractDocumentStorage {
  // Encrypted is the default; pass `false` for a plaintext document.
  constructor(encrypted: boolean = true) {
    super(encrypted);
  }

  // Implement persistence — the base class handles merge, sync, dedup, attribution
  async getDocumentState(documentId: string): Promise<DocumentState | null> {
    const data = await myBackend.getState(documentId);
    if (!data) return null;
    return { update: data.update, sidecars: data.sidecars ?? [] };
  }

  async replaceDocumentState(
    documentId: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    await myBackend.storeState(documentId, { update, sidecars });
  }

  async writeDocumentMetadata(documentId: string, metadata: DocumentMetadata): Promise<void> {
    await myBackend.storeMetadata(documentId, metadata);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    return (
      (await myBackend.getMetadata(documentId)) ?? {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: this.encrypted,
      }
    );
  }

  async deleteDocument(documentId: string): Promise<void> {
    await myBackend.deleteDocument(documentId);
  }

  // Optional: Override transaction if your backend supports it
  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return await myBackend.transaction(documentId, cb);
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
    for (let i = 0; i < expectedChunks; i++) {
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

### Using PostgreSQL for Documents, S3 for Files, Redis for Milestones

```typescript
import { createStorage } from "unstorage";
import postgresDriver from "unstorage/drivers/postgres";
import { UnstorageDocumentStorage, UnstorageFileStorage } from "teleportal/storage";
import { RedisMilestoneStorage } from "./custom-redis-milestone";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const docStorage = createStorage({
  driver: postgresDriver({ connectionString: "..." }),
});

const fileStorage = new UnstorageFileStorage(docStorage, { keyPrefix: "file" });

// Create independent storage for milestones
const msStorage = new RedisMilestoneStorage(redisClient);

// Create handlers for each storage type
const fileHandlers = getFileRpcHandlers(fileStorage);
const milestoneHandlers = getMilestoneRpcHandlers(msStorage);

const server = new Server({
  storage: async (ctx) =>
    new UnstorageDocumentStorage(docStorage, {
      keyPrefix: "doc",
      encrypted: ctx.encrypted,
    }),
  rpcHandlers: {
    ...fileHandlers,
    ...milestoneHandlers,
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

- [`DocumentStorage`](./types.ts#L372)
- [`FileStorage`](./types.ts#L198)
- [`MilestoneStorage`](./types.ts#L257)
- [`TemporaryUploadStorage`](./types.ts#L63)

## Summary

The storage module is designed to be **flexible and swappable**. The provided implementations (unstorage, in-memory) are just examples - you can implement the interfaces for any storage backend you need. This design allows Teleportal to work with virtually any storage system while keeping the core logic storage-agnostic.
