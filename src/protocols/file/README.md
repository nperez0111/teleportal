# File Protocol

File upload and download via RPC with chunked streaming and Merkle proof verification.

## Overview

This protocol provides RPC handlers for file transfers:

- **fileUpload**: Initiate an upload, then stream encrypted/plaintext chunks to the server
- **fileDownload**: Request a file, then receive chunks streamed back

Files are transferred as chunks with Merkle proof integrity verification. Both upload and download support optional E2EE via the provider's encryption key.

Uploads are **content-addressed, resumable, and deduplicated**:

- The client encrypts the whole file and folds its Merkle root — the `contentId` — _before_ sending the upload request. That id is both the upload session id and the durable file id.
- **Resume**: a re-upload of the same file (a retry, or even after a page reload) re-derives the same `contentId`, so the server finds the existing session and replies with `existingChunks`; the client streams only what's missing.
- **Dedup**: if the content already exists durably, the server attaches it to the requesting document and replies `alreadyExists: true` — the client resolves without streaming a single chunk.

Resume and dedup require a **stable** `contentId`, which in turn requires deterministic encryption. The client uses [`createDeterministicEncryptor`](../../encryption-key/README.md) (keyed HMAC-derived IVs) for file chunks. If the encryption key is non-extractable, it falls back to random IVs — uploads still work, but each attempt gets a fresh `contentId`, so cross-attempt resume and dedup won't hit.

> **Trade-off — convergent encryption leaks equality.** Deterministic encryption makes identical plaintext chunks encrypt to identical ciphertext, so the server can tell when two uploads (under the same key) share content — that _is_ the dedup mechanism, and it is per-key scoped. It is chunk-granular: the server can also observe shared prefixes and repeated regions between files. Unencrypted uploads dedup globally, and `alreadyExists` is an existence oracle for anyone who can hash a candidate plaintext. Knowing a `contentId` is a capability to attach+download the file (as it already was for downloads); use `checkUploadPermission` / `checkDownloadPermission` for deployments that must gate this. Dedup identity is a function of (content, key, chunk size).

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
Client                                             Server
  │  [encrypt whole file, fold Merkle root → contentId] │
  │  ──── fileUpload {fileId: contentId, chunkSize} ──► │  permission check
  │                                                     │  chunkSize mismatch? → { chunkSizeMismatch }
  │                                                     │  getFile(contentId) hit → attach to doc,
  │  ◄──── { allowed, chunkSize, alreadyExists?,        │    { alreadyExists: true }
  │          existingChunks? } ───────────────────────  │  else begin/resume session
  │  [alreadyExists → resolve, done]                    │
  │  ──── stream (missing chunks only) ───────────────► │  store chunk
  │  ◄──── ACK ───────────────────────────────────────  │
  │  ...                                                │
  │  (last chunk) ────────────────────────────────────► │  verify root == contentId,
  │  ◄──── ACK ───────────────────────────────────────  │    move to durable storage, attach to doc
```

Because the `contentId` is known before the request, dedup and resume cost no
extra round-trips (they are answered in the upload response). The trade-off is
that the client encrypts+hashes the whole file before the first chunk goes out;
encryption is parallelized, so the added time-to-first-byte is roughly
0.4–0.5 ms/MB (≈90 ms for 200 MB, ≈470 ms for 1 GB) — small next to transfer
time, and saved entirely on a dedup/resume hit.

The **upload stream omits per-chunk Merkle proofs** (`merkleProof: []`): the
server ignores them on upload and recomputes the Merkle tree from the stored
chunks at completion, verifying it equals the client-claimed `contentId` (a
mismatch discards the session so a retry starts clean). Download is the
integrity boundary — there the server generates proofs from its rebuilt tree and
the client verifies each chunk against the root.

If the client's `chunkSize` doesn't match the server's configured size, the
server replies `{ chunkSizeMismatch: true, chunkSize }` and creates no session;
the client re-chunks with the server's size (which changes the `contentId`) and
resends once. The negotiated size is cached to avoid repeating this.

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

**Request:** `FileUploadRequest` — `{ fileId, filename, size, mimeType, lastModified, encrypted, chunkSize? }` (`fileId` is the content-addressed Merkle root; `chunkSize` is what the client chunked with)

**Response:** `FileUploadResponse` — `{ fileId, allowed, reason?, statusCode?, chunkSize?, existingChunks?, alreadyExists?, chunkSizeMismatch? }`

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
