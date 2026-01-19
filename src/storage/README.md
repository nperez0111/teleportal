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
import { createUnstorage } from "teleportal/storage";
import redisDriver from "unstorage/drivers/redis";

const storage = createStorage({
  driver: redisDriver({
    base: "teleportal:",
    // ... redis config
  }),
});

const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createUnstorage(storage, {
      fileKeyPrefix: "file",
      documentKeyPrefix: "doc",
      encrypted: ctx.documentId.includes("encrypted"),
    });
    return documentStorage;
  },
});

// Create Rate Limit Storage
import { UnstorageRateLimitStorage } from "teleportal/storage";

const rateLimitStorage = new UnstorageRateLimitStorage(storage, {
  keyPrefix: "rate-limit",
});
```

**Key Features:**

- Configurable key prefixes for file, document, and milestone storage
- Supports both encrypted and unencrypted documents
- Transaction support with TTL-based locking (default: 5000ms)
- Can scan keys (useful for relational databases) or use indexed keys
- All storage instances are completely independent

### In-Memory Implementation

The **in-memory** implementation stores everything in process memory. Perfect for:

- Testing
- Development
- Single-server deployments
- Prototyping

**Usage:**

```typescript
import { createInMemory } from "teleportal/storage";

const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createInMemory({
      encrypted: ctx.documentId.includes("encrypted"),
      useYDoc: true, // Use YDoc storage for Y.js documents
    });
    return documentStorage;
  },
});
```

**Key Features:**

- Zero configuration
- Fast (no I/O)
- Data lost on restart
- Supports YDoc storage mode

## Creating Custom Storage Implementations

You can create custom storage implementations for any backend. Here's how:

### Example: Custom DocumentStorage

```typescript
import type {
  DocumentStorage,
  Document,
  DocumentMetadata,
} from "teleportal/storage";
import { UnencryptedDocumentStorage } from "teleportal/storage/unencrypted";

export class MyCustomDocumentStorage extends UnencryptedDocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "unencrypted" = "unencrypted";

  // Implement required methods
  async handleUpdate(documentId: string, update: Update): Promise<void> {
    // Store update in your backend
    await myBackend.storeUpdate(documentId, update);
  }

  async getDocument(documentId: string): Promise<Document | null> {
    // Retrieve from your backend
    const update = await myBackend.getUpdate(documentId);
    if (!update) return null;

    // Build document from your storage
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update,
        stateVector: computeStateVector(update),
      },
    };
  }

  async writeDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    await myBackend.storeMetadata(documentId, metadata);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    return (await myBackend.getMetadata(documentId)) ?? defaultMetadata();
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
import type {
  FileStorage,
  File,
  FileMetadata,
  FileUploadResult,
} from "teleportal/storage";

export class S3FileStorage implements FileStorage {
  readonly type = "file-storage" as const;
  temporaryUploadStorage?: TemporaryUploadStorage;

  async getFile(fileId: string): Promise<File | null> {
    // Retrieve from S3
    const metadata = await s3.getObjectMetadata(fileId);
    if (!metadata) return null;

    // Fetch chunks from S3
    const chunks = await Promise.all(
      metadata.chunkKeys.map((key) => s3.getObject(key)),
    );

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

## Factory Functions

Factory functions simplify creating storage instances. They create independent storage instances with consistent configuration - no wiring between storage types.

### `createUnstorage(storage, options?)`

Creates document, file, and milestone storage based on the same unstorage instance with different key prefixes. All storage instances are completely independent.

**What's created:**

- `documentStorage` - Main document storage (encrypted or unencrypted based on options)
- `fileStorage` - File storage with `temporaryUploadStorage` integration
- `milestoneStorage` - Milestone storage

**Important:** Each storage instance is independent. To use file or milestone handlers, create them separately and pass to handler factories:

```typescript
import { createUnstorage, getFileRpcHandlers } from "teleportal/storage";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const { documentStorage, fileStorage, milestoneStorage } = createUnstorage(
  storage,
  {
    fileKeyPrefix: "file",
    documentKeyPrefix: "document",
    milestoneKeyPrefix: "document-milestone",
  },
);

// Create handlers with storage instances
const fileHandlers = getFileRpcHandlers(fileStorage);
const milestoneHandlers = getMilestoneRpcHandlers(milestoneStorage);

// Pass handlers to Server - server only knows about documentStorage
```

**Options explained:**

- `scanKeys`: When `true`, uses key scanning to find updates (better for relational databases). When `false`, uses indexed keys (better for key-value stores like Redis).
- `ttl`: Transaction lock timeout in milliseconds. Prevents deadlocks by automatically releasing locks after this duration.

### `createInMemory(options?)`

Creates in-memory document, file, and milestone storage. All storage instances are completely independent.

**What's created:**

- `documentStorage` - Main document storage (encrypted or YDoc-based)
- `fileStorage` - File storage with `temporaryUploadStorage` integration
- `milestoneStorage` - Milestone storage (when using unstorage-based implementation)

**Usage:**

```typescript
const { documentStorage, fileStorage } = createInMemory({
  encrypted: false, // Default: false
  useYDoc: false, // Default: false (note: currently both branches use YDocStorage)
});
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
createUnstorage(storage, {
  fileKeyPrefix: "file", // Files stored as "file:file:..."
  documentKeyPrefix: "document", // Documents stored as "document:..."
  milestoneKeyPrefix: "document-milestone", // Milestones stored as "document-milestone:..."
});
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

**Key Scanning vs Indexed Keys:**

- **`scanKeys: false`** (default): Uses indexed keys stored in a document metadata object. Better for key-value stores like Redis, Memcached, etc. Faster for reads but requires maintaining the index.
- **`scanKeys: true`**: Scans for keys matching a pattern. Better for relational databases like PostgreSQL where scanning is efficient. No index maintenance required but may be slower for large document sets.

## Examples

### Using PostgreSQL for Documents, S3 for Files, Redis for Milestones

```typescript
import { createStorage } from "unstorage";
import postgresDriver from "unstorage/drivers/postgres";
import { createUnstorage } from "teleportal/storage";
import { S3FileStorage } from "./custom-s3-storage";
import { RedisMilestoneStorage } from "./custom-redis-milestone";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const docStorage = createStorage({
  driver: postgresDriver({ connectionString: "..." }),
});

const { documentStorage, fileStorage, milestoneStorage } = createUnstorage(
  docStorage,
  {
    documentKeyPrefix: "doc",
    scanKeys: true, // Recommended for relational databases
  },
);

// Create independent storage for milestones
const msStorage = new RedisMilestoneStorage(redisClient);

// Create handlers for each storage type
const fileHandlers = getFileRpcHandlers(fileStorage);
const milestoneHandlers = getMilestoneRpcHandlers(msStorage);

const server = new Server({
  getStorage: async (ctx) => documentStorage,
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
import { createUnstorage } from "teleportal/storage";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const storage = createStorage({
  driver: redisDriver({
    base: "teleportal:",
    url: "redis://localhost:6379",
  }),
});

const { documentStorage, fileStorage, milestoneStorage } = createUnstorage(
  storage,
  {
    fileKeyPrefix: "file",
    documentKeyPrefix: "doc",
    encrypted: false,
  },
);

const server = new Server({
  getStorage: async (ctx) => documentStorage,
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage),
    ...getMilestoneRpcHandlers(milestoneStorage),
  },
});
```

### Using In-Memory for Testing

```typescript
import { createInMemory } from "teleportal/storage";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const { documentStorage, fileStorage } = createInMemory();

// Create handlers for file and milestone storage
const fileHandlers = getFileRpcHandlers(fileStorage);
// Note: createInMemory currently doesn't create milestoneStorage - create it separately if needed

const server = new Server({
  getStorage: async () => documentStorage,
  rpcHandlers: {
    ...fileHandlers,
  },
});
```

### Accessing Milestone Storage

```typescript
const { documentStorage } = createUnstorage(storage);

// Milestone storage is automatically created and linked
const milestoneStorage = documentStorage.milestoneStorage;

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
2. **Use handler factories for file/milestone operations** - Use `getFileRpcHandlers()` and `getMilestoneRpcHandlers()` to create handlers
3. **Server only knows about DocumentStorage** - The Server receives handlers created with specific storage, but only DocumentStorage is passed via `getStorage()`
4. **Choose the right `scanKeys` option** - Use `scanKeys: true` for relational databases (PostgreSQL, MySQL), `scanKeys: false` for key-value stores (Redis, Memcached)
5. **Set appropriate TTL** - Adjust transaction TTL based on your expected operation duration and network latency (default: 5000ms)
6. **Separate concerns** - Use different backends for documents vs files when it makes sense (e.g., PostgreSQL for documents, S3 for files)
7. **Use key prefixes** - Namespace your data to avoid collisions and enable easy querying/deletion by prefix
8. **Always provide `createdBy`** - The `createdBy` field is required when creating milestones to distinguish user vs system milestones
9. **Handle errors gracefully** - Storage operations can fail, handle errors appropriately
10. **Test with in-memory** - Use in-memory storage for fast, isolated tests

## Interface Reference

See [`types.ts`](./types.ts) for complete interface definitions:

- [`DocumentStorage`](./types.ts#L372)
- [`FileStorage`](./types.ts#L198)
- [`MilestoneStorage`](./types.ts#L257)
- [`TemporaryUploadStorage`](./types.ts#L63)

## Summary

The storage module is designed to be **flexible and swappable**. The provided implementations (unstorage, in-memory) are just examples - you can implement the interfaces for any storage backend you need. This design allows Teleportal to work with virtually any storage system while keeping the core logic storage-agnostic.
