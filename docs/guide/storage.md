# Storage Configuration

Teleportal's storage system is completely decoupled from the library. You can use any storage backend by implementing the storage interfaces or using the provided implementations.

## Storage Types

Teleportal uses four main storage interfaces:

1. **DocumentStorage** - Stores document content and metadata
2. **FileStorage** - Stores file data (images, documents, etc.)
3. **MilestoneStorage** - Stores document milestones (snapshots)
4. **TemporaryUploadStorage** - Handles temporary storage during file uploads

## In-Memory Storage

Perfect for development and testing:

```typescript
import { createInMemory } from "teleportal/storage";

const { documentStorage, fileStorage } = createInMemory({
  encrypted: false, // Default: false
  useYDoc: false,   // Default: false
});
```

**Features:**
- Zero configuration
- Fast (no I/O)
- Data lost on restart
- Supports YDoc storage mode

## Unstorage Implementation

Works with any storage backend supported by [unstorage](https://github.com/unjs/unstorage):

### Redis

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

const { documentStorage, fileStorage } = createUnstorage(storage, {
  fileKeyPrefix: "file",
  documentKeyPrefix: "doc",
  encrypted: false,
});
```

### PostgreSQL

```typescript
import { createStorage } from "unstorage";
import postgresDriver from "unstorage/drivers/postgres";
import { createUnstorage } from "teleportal/storage";

const storage = createStorage({
  driver: postgresDriver({
    connectionString: "postgresql://user:password@localhost:5432/dbname",
  }),
});

const { documentStorage, fileStorage } = createUnstorage(storage, {
  fileKeyPrefix: "file",
  documentKeyPrefix: "doc",
});
```

### S3 / Cloudflare R2

```typescript
import { createStorage } from "unstorage";
import s3Driver from "unstorage/drivers/s3";
import { createUnstorage } from "teleportal/storage";

const storage = createStorage({
  driver: s3Driver({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: "us-east-1",
    bucket: "my-bucket",
  }),
});

const { documentStorage, fileStorage } = createUnstorage(storage);
```

## Custom Storage Implementation

You can create custom storage implementations for any backend:

### Custom DocumentStorage

```typescript
import type { DocumentStorage, Document } from "teleportal/storage";
import { UnencryptedDocumentStorage } from "teleportal/storage/unencrypted";

export class MyCustomDocumentStorage extends UnencryptedDocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "unencrypted" = "unencrypted";

  async handleUpdate(documentId: string, update: Update): Promise<void> {
    // Store update in your backend
    await myBackend.storeUpdate(documentId, update);
  }

  async getDocument(documentId: string): Promise<Document | null> {
    const update = await myBackend.getUpdate(documentId);
    if (!update) return null;

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
}
```

### Custom FileStorage

```typescript
import type { FileStorage, File } from "teleportal/storage";

export class S3FileStorage implements FileStorage {
  readonly type = "file-storage" as const;

  async getFile(fileId: string): Promise<File | null> {
    const metadata = await s3.getObjectMetadata(fileId);
    if (!metadata) return null;

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
  }

  // ... implement other methods
}
```

## Storage Composition

You can mix and match different storage backends:

```typescript
// Use PostgreSQL for documents, S3 for files
const docStorage = createUnstorage(postgresStorage, {
  documentKeyPrefix: "doc",
});

const fileStorage = new S3FileStorage(s3Client);
docStorage.fileStorage = fileStorage;

// Use in server
const server = new Server({
  getStorage: async (ctx) => {
    return docStorage;
  },
});
```

## VirtualStorage (Batching)

`VirtualStorage` adds batching and buffering to any `DocumentStorage` implementation:

```typescript
import { VirtualStorage } from "teleportal/storage";

// Wrap any existing storage with batching
const batchedStorage = new VirtualStorage(existingDocumentStorage, {
  batchMaxSize: 100,  // Batch every 100 updates
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

## Encrypted Storage

Support for encrypted documents:

```typescript
const { documentStorage } = createUnstorage(storage, {
  encrypted: true, // Enable encryption
});

// Or conditionally based on document ID
const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createUnstorage(storage, {
      encrypted: ctx.documentId.includes("encrypted"),
    });
    return documentStorage;
  },
});
```

## Key Prefixes

Use key prefixes to namespace your data:

```typescript
createUnstorage(storage, {
  fileKeyPrefix: "file",      // Files: "file:file:..."
  documentKeyPrefix: "doc",   // Documents: "doc:..."
});
```

This prevents key collisions and allows you to:
- Use the same Redis instance for multiple applications
- Organize data by type
- Easily query or delete by prefix

## Transactions

DocumentStorage supports transactions for atomic operations:

```typescript
await documentStorage.transaction(documentId, async () => {
  await documentStorage.handleUpdate(documentId, update);
  await documentStorage.writeDocumentMetadata(documentId, metadata);
});
```

Implementations can use:
- Database transactions (PostgreSQL, MySQL)
- Distributed locks (Redis, etcd)
- Optimistic locking
- Or simply execute sequentially (in-memory)

## Best Practices

1. **Use factory functions** when possible - They handle initialization correctly
2. **Separate concerns** - Use different backends for documents vs files when it makes sense
3. **Use key prefixes** - Namespace your data to avoid collisions
4. **Implement transactions** - If your backend supports them, use them for consistency
5. **Handle errors gracefully** - Storage operations can fail, handle errors appropriately
6. **Test with in-memory** - Use in-memory storage for fast, isolated tests

## Next Steps

- [Server Setup](./server-setup.md) - Use storage in your server
- [Custom Storage](./custom-storage.md) - Create custom storage implementations
- [API Reference](../api/storage.md) - Complete storage API documentation
