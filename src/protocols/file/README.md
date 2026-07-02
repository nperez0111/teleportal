# File Protocol

File upload and download via RPC with chunked streaming and Merkle proof verification.

## Overview

This protocol provides RPC handlers for file transfers:

- **fileUpload**: Initiate an upload, then stream encrypted/plaintext chunks to the server
- **fileDownload**: Request a file, then receive chunks streamed back

Files are transferred as 64KB chunks with Merkle proof integrity verification. Both upload and download support optional E2EE via the provider's encryption key.

## File Structure

```
src/protocols/file/
  methods.ts    — method contracts (defineMethod/defineProtocol) + request/response types
  server.ts     — server handlers (createHandlers)
  client.ts     — client extension (RpcExtension wrapper)
  transfer.ts   — file transfer state machine (chunked upload/download, Merkle proofs)
  index.ts      — public exports
```

The file protocol uses a multipart method kind for uploads (the only protocol that does). The `transfer.ts` state machine manages the bidirectional chunk streaming, ACK tracking, and encryption — `client.ts` is a thin `RpcExtension` wrapper that delegates to it.

## Server Integration

```typescript
import { Server } from "teleportal/server";
import { getFileRpcHandlers } from "teleportal/protocols/file";

const fileStorage = new InMemoryFileStorage();
fileStorage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();

const server = new Server({
  storage: async () => documentStorage,
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage),
  },
});
```

### Chunk Size

The server controls the wire chunk size and communicates it to the client during upload initialization. Defaults to 1MB if not configured.

```typescript
const server = new Server({
  storage: async () => documentStorage,
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage, { chunkSize: 256 * 1024 }), // 256KB chunks
  },
});
```

### Permission Checking

```typescript
import { getFileRpcHandlers, type FileHandlerOptions } from "teleportal/protocols/file";

const options: FileHandlerOptions = {
  chunkSize: 512 * 1024, // 512KB chunks
  async checkUploadPermission(fileId, metadata, context) {
    const allowed = await checkAccess(context.userId, context.documentId, "write");
    return allowed ? { allowed: true } : { allowed: false, reason: "No write access" };
  },
  async checkDownloadPermission(fileId, context) {
    const allowed = await checkAccess(context.userId, context.documentId, "read");
    return allowed ? { allowed: true } : { allowed: false, reason: "No read access" };
  },
};

const server = new Server({
  storage: async () => documentStorage,
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage, options),
  },
});
```

## Client Integration

```typescript
import { Provider } from "teleportal/providers";
import { createFileRpc } from "teleportal/protocols/file";
import { createEncryptionKey } from "teleportal/encryption-key";

const encryptionKey = await createEncryptionKey();

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  encryptionKey,
  rpc: {
    file: () => createFileRpc({ encryptionKey }),
  },
});

const fileId = await provider.rpc.file.upload(myFile);
const file = await provider.rpc.file.download(fileId);
```

## Contract

The protocol contract is defined in `methods.ts`:

```typescript
import { fileProtocol } from "teleportal/protocols/file";

// fileProtocol.methods:
//   upload   → wire name "fileUpload"   (kind: "multipart")
//   download → wire name "fileDownload" (kind: "request-response")
```

Upload uses the `"multipart"` method kind — it has both a `handler` (initiation) and a `streamHandler` (chunk processing). Download is `"request-response"` but returns a stream of file parts in the response.

## Error Handling

All client methods throw `RpcOperationError` (from `teleportal/rpc`) on failure:

```typescript
import { RpcOperationError } from "teleportal/rpc";

try {
  await provider.rpc.file.upload(myFile);
} catch (error) {
  if (error instanceof RpcOperationError) {
    console.log(error.protocol); // "file"
    console.log(error.operation); // "upload"
  }
}
```

## Transfer Flow

### Upload

```
Client                                Server
  │  ──── fileUpload request ────────►  │  Check permission, initiate session
  │  ◄──── fileUpload response ───────  │  { allowed: true, chunkSize }
  │  ──── stream (chunk 0) ──────────►  │  Store chunk
  │  ◄──── ACK ──────────────────────  │
  │  ──── stream (chunk 1) ──────────►  │
  │  ◄──── ACK ──────────────────────  │
  │  ...                                │
  │  ──── stream (last chunk) ───────►  │  Rebuild tree, complete upload, move to durable storage
  │  ◄──── ACK ──────────────────────  │
```

The client sends chunks as soon as each is encrypted (pipelined with the wire),
and the **upload stream omits per-chunk Merkle proofs** (`merkleProof: []`): the
server ignores them on upload and recomputes the Merkle tree from the stored
chunks at completion, deriving the authoritative `contentId` from that tree.
Download is the integrity boundary — there the server generates proofs from its
rebuilt tree and the client verifies each chunk against the root.

The server returns its configured `chunkSize` in the upload response. The client uses this to split the file into chunks. If not provided, defaults to 1MB.

### Download

```
Client                                Server
  │  ──── fileDownload request ──────►  │  Check permission, get metadata
  │  ◄──── stream (chunk 0) ─────────  │
  │  ◄──── stream (chunk 1) ─────────  │
  │  ...                                │
  │  ◄──── stream (last chunk) ──────  │
  │  ◄──── fileDownload response ────  │  { filename, size, mimeType, ... }
```

## Methods

### fileUpload

Initiate a file upload and stream chunks to the server.

**Request:** `FileUploadRequest` — `{ fileId, filename, size, mimeType, lastModified, encrypted }`

**Response:** `FileUploadResponse` — `{ fileId, allowed, reason?, statusCode?, chunkSize? }`

**Stream:** `FilePartStream` — `{ fileId, chunkIndex, chunkData, merkleProof, totalChunks, bytesUploaded, encrypted }` (`merkleProof` is populated for downloads and empty for uploads)

### fileDownload

Request a file download, receiving metadata and streamed chunks.

**Request:** `FileDownloadRequest` — `{ fileId }`

**Response:** `FileDownloadResponse` — `{ fileId, filename, size, mimeType, lastModified, encrypted, allowed, reason?, statusCode?, totalChunks? }`

## Constants

- **MAX_FILE_SIZE**: 1GB
- **Default chunk size**: 1MB, configurable via `getFileRpcHandlers(storage, { chunkSize })`. For encrypted files, plaintext chunks are `chunkSize - 28` bytes (AES-GCM overhead).
- **Cleanup interval**: 5 minutes (expired uploads)

## See Also

- [`teleportal/rpc`](../../lib/rpc/) — RPC framework primitives
- [Milestone Protocol](../milestone/README.md) — Document milestone/versioning
- [Attribution Protocol](../attribution/README.md) — Attribution (authorship) methods
