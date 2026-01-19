# File Protocol

File upload and download via RPC with streaming support.

## Overview

This package provides RPC handlers for file transfers. Files are transferred via a streaming RPC protocol that supports:

- **fileUpload**: Initiate an upload, then stream file chunks to the server
- **fileDownload**: Request a file, then receive file chunks streamed back

The RPC system handles both the request/response flow and bidirectional streaming of file data.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Server                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Session (RPC System)                  │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │              getFileRpcHandlers()                │    │    │
│  │  │  ┌─────────────────┐  ┌─────────────────────┐   │    │    │
│  │  │  │   fileUpload    │  │    fileDownload     │   │    │    │
│  │  │  │  ├─ handler     │  │  └─ handler         │   │    │    │
│  │  │  │  ├─ streamHandler│  │     (returns stream)│   │    │    │
│  │  │  │  └─ init        │  │                     │   │    │    │
│  │  │  └─────────────────┘  └─────────────────────┘   │    │    │
│  │  │              ↓                    ↓              │    │    │
│  │  │         FileHandler (core logic)                 │    │    │
│  │  │              ↓                    ↓              │    │    │
│  │  │  ┌─────────────────────────────────────────┐    │    │    │
│  │  │  │           FileStorage                    │    │    │    │
│  │  │  │  ├─ TemporaryUploadStorage (uploads)    │    │    │    │
│  │  │  │  └─ getFile/storeFile (downloads)       │    │    │    │
│  │  │  └─────────────────────────────────────────┘    │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Server Integration

```typescript
import { Server } from "teleportal/server";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { InMemoryFileStorage } from "teleportal/storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "teleportal/storage/in-memory/temporary-upload-storage";

// Set up file storage with temporary upload support
const fileStorage = new InMemoryFileStorage();
fileStorage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();

const server = new Server({
  getStorage: async () => documentStorage,
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage),
  },
});
```

## Permission Checking

You can add custom permission checking for uploads and downloads:

```typescript
import { getFileRpcHandlers, FilePermissionOptions } from "teleportal/protocols/file";

const permissionOptions: FilePermissionOptions = {
  // Check if upload is allowed
  async checkUploadPermission(fileId, metadata, context) {
    // context includes: server, documentId, session, userId, clientId
    const hasWriteAccess = await checkUserAccess(context.userId, context.documentId);
    if (!hasWriteAccess) {
      return { allowed: false, reason: "No write access" };
    }
    return { allowed: true };
  },

  // Check if download is allowed
  async checkDownloadPermission(fileId, context) {
    const hasReadAccess = await checkUserAccess(context.userId, context.documentId);
    if (!hasReadAccess) {
      return { allowed: false, reason: "No read access" };
    }
    // Optionally return metadata to populate the response
    return { allowed: true };
  },
};

const server = new Server({
  getStorage: async () => documentStorage,
  rpcHandlers: {
    ...getFileRpcHandlers(fileStorage, permissionOptions),
  },
});
```

## Client Integration

The `Provider` handles file RPC requests via its `rpcHandlers` option. Register file handlers:

```typescript
import { Provider } from "teleportal/providers";
import { getFileClientHandlers } from "teleportal/protocols/file";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  rpcHandlers: {
    ...getFileClientHandlers(),
  },
});

// Upload a file
const file = new File([content], "example.txt", { type: "text/plain" });
const fileId = await provider.uploadFile(file);

// Download a file
const downloadedFile = await provider.downloadFile(fileId);
```

## RPC Methods

### fileUpload

Initiate a file upload and stream chunks to the server.

**Request (RPC type: `request`):**

```typescript
type FileUploadRequest = {
  fileId: string;        // Content-addressable ID (hash of file)
  filename: string;      // Original filename
  size: number;          // File size in bytes
  mimeType: string;      // MIME type
  lastModified: number;  // Timestamp
  encrypted: boolean;    // Whether file is encrypted
};
```

**Response:**

```typescript
type FileUploadResponse = {
  fileId: string;
  allowed: boolean;
  reason?: string;       // Present if not allowed
  statusCode?: number;   // 403 if denied, 500 on error
};
```

**Stream (RPC type: `stream`):**

After receiving an allowed response, the client streams file chunks:

```typescript
type FilePartStream = {
  fileId: string;
  chunkIndex: number;
  chunkData: Uint8Array;
  merkleProof: Uint8Array[];  // Proof for chunk integrity
  totalChunks: number;
  bytesUploaded: number;
  encrypted: boolean;
};
```

Each chunk receives an ACK message from the server.

### fileDownload

Request a file download, receiving metadata and streamed chunks.

**Request:**

```typescript
type FileDownloadRequest = {
  fileId: string;
};
```

**Response:**

```typescript
type FileDownloadResponse = {
  fileId: string;
  filename: string;
  size: number;
  mimeType: string;
  lastModified: number;
  encrypted: boolean;
  allowed: boolean;
  reason?: string;       // Present if not allowed
  statusCode?: number;   // 404 if not found
};
```

**Stream (server → client):**

The server streams `FilePartStream` chunks back to the client, followed by the final response.

## File Transfer Flow

### Upload Flow

```
Client                                Server
  │                                      │
  │  ──── fileUpload request ────────►   │
  │                                      │  Check permission
  │                                      │  Initiate upload session
  │  ◄──── fileUpload response ───────   │
  │        (allowed: true)               │
  │                                      │
  │  ──── fileUpload stream (chunk 0) ►  │
  │                                      │  Store chunk, verify merkle proof
  │  ◄──── ACK ────────────────────────  │
  │                                      │
  │  ──── fileUpload stream (chunk 1) ►  │
  │                                      │  Store chunk
  │  ◄──── ACK ────────────────────────  │
  │                                      │
  │  ...                                 │
  │                                      │
  │  ──── fileUpload stream (last) ───►  │
  │                                      │  Complete upload
  │  ◄──── ACK ────────────────────────  │  Move to durable storage
  │                                      │
```

### Download Flow

```
Client                                Server
  │                                      │
  │  ──── fileDownload request ──────►   │
  │                                      │  Check permission
  │                                      │  Get file metadata
  │                                      │
  │  ◄──── fileDownload stream (chunk 0) │
  │  ◄──── fileDownload stream (chunk 1) │
  │  ...                                 │
  │  ◄──── fileDownload stream (last) ── │
  │                                      │
  │  ◄──── fileDownload response ──────  │
  │        (with file metadata)          │
  │                                      │
```

## Handler Structure

The `getFileRpcHandlers` function returns an `RpcHandlerRegistry` with:

```typescript
{
  fileUpload: {
    // Handle upload initiation requests
    handler: (payload, context) => Promise<{ response, stream? }>,

    // Handle incoming file chunks (stream messages)
    streamHandler: (payload, context, messageId, sendMessage) => Promise<void>,

    // Initialize handler (sets up periodic cleanup)
    init: (server) => () => void,  // Returns cleanup function
  },

  fileDownload: {
    // Handle download requests, returns stream of file parts
    handler: (payload, context) => Promise<{ response, stream? }>,
  },
}
```

## Storage Requirements

File operations require a `FileStorage` implementation with:

```typescript
interface FileStorage {
  // For uploads - optional, enables upload support
  temporaryUploadStorage?: TemporaryUploadStorage;

  // For downloads
  getFile(fileId: string): Promise<File | null>;

  // For completing uploads
  storeFileFromUpload(result: UploadResult): Promise<void>;
}

interface TemporaryUploadStorage {
  beginUpload(fileId: string, metadata: FileMetadata): Promise<void>;
  storeChunk(fileId: string, index: number, data: Uint8Array, proof: Uint8Array[]): Promise<void>;
  getUploadProgress(fileId: string): Promise<UploadProgress | null>;
  completeUpload(fileId: string): Promise<UploadResult>;
  cleanupExpiredUploads(): Promise<void>;
}
```

## Context

Server handlers receive `RpcServerContext`:

```typescript
interface RpcServerContext {
  server: Server;           // The Server instance
  documentId: string;       // The namespaced document ID
  session: Session;         // The Session instance
  userId?: string;          // User ID (if authenticated)
  clientId?: string;        // Client ID
}
```

## Constants

- **MAX_FILE_SIZE**: 1GB (1024 * 1024 * 1024 bytes)
- **Cleanup interval**: 5 minutes (expired uploads are periodically cleaned)

## Exports

```typescript
import {
  // Main factory function
  getFileRpcHandlers,

  // Core file handler class (for advanced use)
  FileHandler,

  // Types
  FilePermissionOptions,
  FileUploadRequest,
  FileUploadResponse,
  FileDownloadRequest,
  FileDownloadResponse,
  FilePartStream,
} from "teleportal/protocols/file";
```

## See Also

- [Milestone Protocol](../milestone/README.md) - Document milestone/versioning
- [Protocols Overview](../README.md) - All protocol packages
- [Storage](../../storage/README.md) - Storage interfaces
