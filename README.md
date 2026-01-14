# TelePortal

<img align="right" src="./assets/pepper.png?raw=true" height="240" />

> TelePortal: A storage, transport & runtime agnostic Y.js server/provider. Built on web primitives, supports subdocs, and handles everything without in-memory storage. Perfect for collaborative apps! 🚀

This is a **Y.js Server & Provider** that aims to be storage, transport, and runtime agnostic.

* **💾 Storage:** Storage is completely de-coupled from the library, you can store documents in a KV, relational database or even S3, totally up to you

  * Currently this is implemented with `unstorage` which can swap out drivers for many different storage schemes.

* **🔄 Transport:** everything is defined using Web standard streams and encodes to a `Uint8Array`

  * Use Websockets, HTTP, HTTP + SSE, anything you like that can fulfill a bidirectional communication

* **🏃 Runtime:** built on web primitives, everything should work on any JavaScript runtime, with minimal dependencies

<video src="./assets/teleportal.mp4" controls width="100%"></video>

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/teleportal?color=yellow)](https://npmjs.com/package/teleportal)
[![npm downloads](https://img.shields.io/npm/dm/teleportal?color=yellow)](https://npm.chart.dev/teleportal)

<!-- /automd -->

## Features

### Core Features

* **🌏 Ease-of-use:** We won't make you learn what a Y.Doc is, and make you store it somewhere, keep an instance of the provider, and you'll have everything you need!

* **📁 Sub-docs:** Full support for Y.js subdocs - there aren't many providers out there which have implemented this, this one does 😉

* **🏎️ Performance:** Built on top of web-native Streams APIs, supporting control-flow, backpressure. All without actually storing the documents in-memory

* **🔄 Zero in-memory storage:** Documents are never stored in memory on the server, making it perfect for scalable deployments

### Protocol & Synchronization

* **Binary Protocol:** Efficient binary protocol with magic number validation and version checking
* **Document Sync:** Full Y.js synchronization with sync-step-1, sync-step-2, updates, and sync-done messages
* **Awareness:** Real-time user presence, cursor positions, and selection states
* **Message Batching:** Multiple messages can be batched into a single transmission for efficiency
* **Ping/Pong:** Built-in keep-alive messages for connection health monitoring

### File Transfer

* **Chunked File Transfer:** Files are split into 64KB chunks for efficient transfer
* **Merkle Tree Verification:** Content-addressable storage with Merkle tree integrity verification
* **Large File Support:** Files up to 1GB supported
* **Encrypted Files:** Optional end-to-end encryption for file transfers
* **Incremental Uploads:** Support for resumable uploads from temporary storage

### Milestones (Document Snapshots)

* **Create Snapshots:** Capture document state at any point in time
* **List Milestones:** Query all milestones for a document
* **Lazy Loading:** Request milestone snapshots on-demand
* **Named Milestones:** Optional naming for milestones with update support
* **Metadata Management:** Track milestone creation times and document associations

### Storage

* **Storage Agnostic:** Interface-based design - implement for any storage backend
* **Multiple Implementations:**
  * **Unstorage:** Works with Redis, PostgreSQL, MySQL, SQLite, S3, Cloudflare R2, Azure Blob, and more
  * **In-Memory:** Fast in-memory storage for testing and development
  * **Encrypted/Unencrypted:** Support for both encrypted and unencrypted document storage
* **Separate Storage Types:**
  * Document storage (Y.js updates and metadata)
  * File storage (chunked files with Merkle trees)
  * Milestone storage (document snapshots)
  * Temporary upload storage (upload sessions)

### Transport & Connections

* **WebSocket:** Full WebSocket support with automatic reconnection
* **HTTP:** HTTP-based transport for environments where WebSockets aren't available
* **Server-Sent Events (SSE):** SSE support for one-way server-to-client communication
* **Fallback Connection:** Automatic fallback between WebSocket, HTTP, and SSE
* **Message Buffering:** Automatic message buffering when disconnected
* **Connection State Management:** Track connection state (connected, disconnected, connecting, errored)
* **In-Flight Message Tracking:** Monitor messages in transit

### End-to-End Encryption (E2EE)

* **AES-GCM Encryption:** Industry-standard encryption for document updates
* **Encrypted Transport:** Optional encryption layer for all document messages
* **Key Management:** Utilities for creating, importing, and exporting encryption keys
* **Encrypted File Support:** Files can be encrypted before chunking and transfer
* **Lamport Clock:** Vector clocks for encrypted message ordering

### Security & Authentication

* **JWT Token Authentication:** Built-in JWT token support using `jose` library
* **IAM-like Permissions:** Granular permission system with document pattern matching
* **Permission Types:** `read`, `write` per message
* **Pattern Matching:** Support for exact, prefix, wildcard, and suffix patterns
* **Room-based Access Control:** Multi-tenant support with room/organization isolation
* **Document Access Builder:** Fluent API for constructing complex permission rules
* **Token Expiration:** Configurable token expiration and validation

### Monitoring & Observability

* **Prometheus Metrics:** Built-in Prometheus metrics collection
* **Health Checks:** Health status endpoints with component checks
* **Status Endpoints:** Real-time server status (clients, sessions, messages)
* **Metrics Collected:**
  * Active clients and sessions
  * Total documents opened
  * Message counts by type
  * Message processing duration
  * Storage operation counts and duration
  * Error counts by type
* **Uptime Tracking:** Server uptime monitoring

### Developer Experience

* **DevTools Integration:** Built-in DevTools for debugging and monitoring
* **Agent Functionality:** Server-side document manipulation with Agent API
* **TypeScript Support:** Full TypeScript support with comprehensive type definitions
* **Comprehensive Logging:** Structured logging with `@logtape/logtape`
* **HTTP Server Handlers:** Ready-to-use HTTP handlers for integration
* **WebSocket Server Handlers:** Pre-built WebSocket upgrade and connection handlers

### Provider Features

* **Automatic Reconnection:** Smart reconnection logic with exponential backoff
* **Offline Persistence:** IndexedDB persistence for offline support
* **Subdoc Support:** Full Y.js subdoc synchronization
* **Connection Sharing:** Share connections across multiple providers
* **Observable Events:** Event-driven architecture with observable patterns

### Transport Middleware

* **Redis Transport:** Redis-based pub/sub for distributed deployments
* **NATS Transport:** NATS integration for message queuing
* **Rate Limiting:** Built-in rate limiting support
* **Message Validation:** Message validation middleware
* **ACK Support:** Acknowledgment support for reliable message delivery
* **PubSub Support:** Publish/subscribe patterns for multi-server deployments
* **Logger Transport:** Logging middleware for debugging

### Examples & Integrations

* **Excalidraw Example:** Complete example integration with Excalidraw
* **Playground:** Interactive playground for testing and development
* **Multiple Server Implementations:** Examples for Bun, Node.js, and more

## Quick Start

```typescript
import { Server } from "teleportal/server";
import { createInMemory } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createInMemory();
    return documentStorage;
  },
});

const handlers = getWebsocketHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});
```

## Installation

```bash
npm install teleportal
# or
bun add teleportal
# or
pnpm add teleportal
```

## Documentation

* [Protocol Documentation](./src/lib/README.md) - Complete protocol specification
* [Storage Documentation](./src/storage/README.md) - Storage interface and implementations
* [Provider Documentation](./src/providers/README.md) - Provider and connection architecture
* [Token Documentation](./src/token/README.md) - JWT authentication and permissions

## Exports

TelePortal provides multiple entry points:

* `teleportal` - Core library
* `teleportal/server` - Server implementation
* `teleportal/providers` - Client providers
* `teleportal/storage` - Storage interfaces and implementations
* `teleportal/http` - HTTP handlers
* `teleportal/websocket-server` - WebSocket server handlers
* `teleportal/protocol` - Protocol encoding/decoding
* `teleportal/protocol/encryption` - Encryption protocol
* `teleportal/transports` - Transport middleware
* `teleportal/transports/redis` - Redis transport
* `teleportal/transports/nats` - NATS transport
* `teleportal/token` - JWT token utilities
* `teleportal/encryption-key` - Encryption key management
* `teleportal/monitoring` - Metrics and monitoring
* `teleportal/devtools` - DevTools integration
* `teleportal/merkle-tree` - Merkle tree utilities

## Requirements

* Node.js >= 24
* Modern JavaScript runtime (Node.js, Bun, Deno, etc.)

## License

MPL-2.0

> [!NOTE]
> 🚧 This is still a work in progress. Feedback and contributions are welcome!
