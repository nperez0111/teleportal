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
- Manage milestone metadata (names, timestamps)

**Interface:** [`MilestoneStorage`](./types.ts#L257)

### 4. TemporaryUploadStorage

Handles temporary storage during file uploads before files are committed to FileStorage.

**Key Responsibilities:**

- Manage upload sessions
- Store chunks during upload
- Verify Merkle proofs
- Clean up expired uploads

**Interface:** [`TemporaryUploadStorage`](./types.ts#L63)

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
```

**Key Features:**

- Configurable key prefixes for file and document storage
- Supports both encrypted and unencrypted documents
- Transaction support with TTL-based locking
- Can scan keys (useful for relational databases) or use indexed keys

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

  async listFileMetadataByDocument(
    documentId: string,
  ): Promise<FileMetadata[]> {
    // Query S3 for files with this documentId
    return await s3.listFilesByDocument(documentId);
  }

  async deleteFilesByDocument(documentId: string): Promise<void> {
    const files = await this.listFileMetadataByDocument(documentId);
    await Promise.all(files.map((f) => this.deleteFile(f.id)));
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

Storage implementations can be composed together. For example:

```typescript
// Use PostgreSQL for documents, S3 for files
const documentStorage = new PostgresDocumentStorage(db);
const fileStorage = new S3FileStorage(s3Client);
documentStorage.fileStorage = fileStorage;

// Or use Redis for everything
const { documentStorage, fileStorage } = createUnstorage(redisStorage, {
  fileKeyPrefix: "file",
  documentKeyPrefix: "doc",
});
```

### VirtualStorage Wrapper

**VirtualStorage** is a configurable wrapper that adds batching and buffering to any `DocumentStorage` implementation, improving write performance by reducing DB I/O operations.

**Key Features:**

- **Write Buffering**: Buffers document updates and metadata in memory
- **Batched Persistence**: Uses TanStack Pacer to batch writes (configurable max size and time)
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

Factory functions simplify creating storage pairs that work together:

### `createUnstorage(storage, options?)`

Creates document and file storage based on the same unstorage instance with different key prefixes.

```typescript
const { documentStorage, fileStorage } = createUnstorage(storage, {
  fileKeyPrefix: "file", // Default: "file"
  documentKeyPrefix: "doc", // Default: ""
  encrypted: false, // Default: false
  scanKeys: false, // Default: false
  ttl: 5000, // Default: 5000ms
});
```

### `createInMemory(options?)`

Creates in-memory document and file storage.

```typescript
const { documentStorage, fileStorage } = createInMemory({
  encrypted: false, // Default: false
  useYDoc: false, // Default: false
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
  documentKeyPrefix: "doc", // Documents stored as "doc:..."
});
```

This prevents key collisions and allows you to:

- Use the same Redis instance for multiple applications
- Organize data by type
- Easily query or delete by prefix

### Transactions

DocumentStorage supports transactions for atomic operations. Implementations can:

- Use database transactions (PostgreSQL, MySQL)
- Use distributed locks (Redis, etcd)
- Use optimistic locking
- Or simply execute sequentially (in-memory)

The interface is flexible enough to support any transaction model.

## Examples

### Using PostgreSQL for Documents, S3 for Files

```typescript
import { createStorage } from "unstorage";
import postgresDriver from "unstorage/drivers/postgres";
import { createUnstorage } from "teleportal/storage";
import { S3FileStorage } from "./custom-s3-storage";

const docStorage = createStorage({
  driver: postgresDriver({ connectionString: "..." }),
});

const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createUnstorage(docStorage, {
      documentKeyPrefix: "doc",
    });

    // Use custom S3 storage for files
    documentStorage.fileStorage = new S3FileStorage(s3Client);

    return documentStorage;
  },
});
```

### Using Redis for Everything

```typescript
import { createStorage } from "unstorage";
import redisDriver from "unstorage/drivers/redis";
import { createUnstorage } from "teleportal/storage";

const storage = createStorage({
  driver: redisDriver({
    base: "teleportal:",
    url: "redis://localhost:6379",
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
```

### Using In-Memory for Testing

```typescript
import { createInMemory } from "teleportal/storage";

const server = new Server({
  getStorage: async () => {
    const { documentStorage } = createInMemory();
    return documentStorage;
  },
});
```

## Best Practices

1. **Use factory functions** when possible - They handle initialization correctly
2. **Separate concerns** - Use different backends for documents vs files when it makes sense
3. **Use key prefixes** - Namespace your data to avoid collisions
4. **Implement transactions** - If your backend supports them, use them for consistency
5. **Handle errors gracefully** - Storage operations can fail, handle errors appropriately
6. **Test with in-memory** - Use in-memory storage for fast, isolated tests

## Interface Reference

See [`types.ts`](./types.ts) for complete interface definitions:

- [`DocumentStorage`](./types.ts#L372)
- [`FileStorage`](./types.ts#L198)
- [`MilestoneStorage`](./types.ts#L257)
- [`TemporaryUploadStorage`](./types.ts#L63)
- [`DocumentMetadataUpdater`](./types.ts#L178)

## Summary

The storage module is designed to be **flexible and swappable**. The provided implementations (unstorage, in-memory) are just examples - you can implement the interfaces for any storage backend you need. This design allows Teleportal to work with virtually any storage system while keeping the core logic storage-agnostic.
