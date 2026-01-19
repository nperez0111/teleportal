# Teleportal Protocols

This package contains the protocol implementations for Teleportal's Y.js Sync Server, including the core RPC system and built-in RPC methods.

## Packages

- [`teleportal/protocol`](../lib/protocol/README.md) - Core RPC messaging system (RPC types and message classes are exported from `teleportal/protocol`)
- [`teleportal/protocols/milestone`](./milestone/README.md) - Milestone RPC methods
- [`teleportal/protocols/file`](./file/README.md) - File RPC methods

## Overview

The protocols package provides a formal RPC (Remote Procedure Call) messaging system that replaces manual request/response pairs. It offers:

- **Extensible method registration** - Register custom RPC methods with handlers
- **Request/response correlation** - Messages use IDs to match responses to requests
- **Type-safe handlers** - Discriminated unions for success/error responses
- **Streaming support** - Optional streaming via async iterables
- **Custom serialization** - Support for custom encoders/decoders

## Quick Start

### Server

```typescript
import { Server } from "teleportal/server";
import { getServerHandlers as getMilestoneHandlers } from "teleportal/protocols/milestone";
import { getServerHandlers as getFileHandlers } from "teleportal/protocols/file";

const server = new Server({
  // ... other options
  rpcHandlers: {
    ...getMilestoneHandlers(),
    ...getFileHandlers(),
  },
});
```

### Client

The `Provider` automatically handles RPC requests via its internal `RpcClient`:

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({ url: "wss://...", document: "my-doc" });

// Milestone operations
const milestones = await provider.listMilestones();
const milestone = await provider.createMilestone("v1.0");

// File operations (requires rpcHandlers with file handlers)
const fileId = await provider.uploadFile(file, optionalFileId, optionalEncryptionKey);
const downloadedFile = await provider.downloadFile(fileId, optionalEncryptionKey);
```

## Message Format

RPC messages use a binary format with the following structure:

```
[message type: 0x04]
[method name: varstring]
[request type: uint8]     // 0=request, 1=stream, 2=response
[original request ID: varstring]  // present for stream/response
[payload length: varint]
[payload: bytes]
```

### Request Types

- **request** (0x00): Initial RPC request from client to server
- **stream** (0x01): Streaming chunk from server to client
- **response** (0x02): Final response (success or error)

### Response Types

- **success**: `{ type: "success", payload: unknown }`
- **error**: `{ type: "error", statusCode: number, details: string, payload?: unknown }`

## See Also

- [RPC System](../lib/protocol/README.md) - Core RPC types, encoding, handlers, and serialization/deserialization (exported from `teleportal/protocol`)
- [Milestone Methods](./milestone/README.md) - Milestone CRUD operations via RPC
- [File Methods](./file/README.md) - File upload/download authorization via RPC
