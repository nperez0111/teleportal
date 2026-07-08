# TelePortal

<img align="right" src="./assets/pepper.png?raw=true" height="240" />

> TelePortal: A storage, transport & runtime agnostic Y.js server & provider. Built on web primitives, end-to-end encrypted by default, and never keeps documents in memory. The self-hosted backbone for collaborative apps. 🚀

TelePortal is a library of tools, built on [Y.js](https://yjs.dev), that you add to _your application_ to enable real-time collaborative editing — the kind you see in Google Docs, Notion, and Figma.

That "add to your application" part is the whole point. TelePortal is a **collaborative editing framework, not a sync server**. A sync server runs alongside your app with its own storage, endpoints, and APIs that you then have to integrate with. TelePortal instead lives _inside_ your server: it reuses your storage, your auth, your runtime, and scales with your app. There's no separate service to run.

Y.js is powerful, but it isn't approachable — wiring up a production sync server is a lot of work. The goal of TelePortal is to lower that barrier: drop it into the app you already have and get real-time collaboration without standing up new infrastructure.

### Why TelePortal?

It aims to have properties other Y.js servers don't:

- **🏃 Runs anywhere** — Any JS runtime (Bun, Node.js, Deno, Cloudflare Workers), any storage backend, over any transport. It's built from the ground up on web-native primitives — the server can even run on the client (not sure why you would, but you can!).

- **🧩 Built into your app** — No separate service. Reuse your existing storage, auth, and endpoints, and scale collaboration alongside everything else.

- **💾 Storage agnostic** — Persist documents in a KV store, Postgres, S3/R2, Cloudflare Durable Objects, or your own backend. Storage is fully decoupled behind a small interface, with `unstorage`, Postgres, S3, in-memory, and Cloudflare implementations included.

- **🔄 Transport agnostic** — Everything is modeled as Web-standard streams that encode to `Uint8Array`. Use WebSockets, HTTP, HTTP+SSE, or anything bidirectional — with automatic fallback between them.

- **🔒 End-to-end encryption** — Content-level E2EE is on by default: the server merges, syncs, and attributes edits **without ever seeing your plaintext**.

- **🪶 Zero in-memory storage** — Documents are loaded on demand and evicted when idle, so your server's memory footprint stays flat no matter how many documents exist.

![TelePortal Demo](./assets/teleportal.gif)

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/teleportal?color=yellow)](https://npmjs.com/package/teleportal)
[![npm downloads](https://img.shields.io/npm/dm/teleportal?color=yellow)](https://npm.chart.dev/teleportal)

<!-- /automd -->

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/teleportal)](https://npmx.dev/package/teleportal)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/license/teleportal)](https://npmx.dev/package/teleportal)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/size/teleportal)](https://npmx.dev/package/teleportal)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/downloads-month/teleportal)](https://npmx.dev/package/teleportal)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/dependencies/teleportal)](https://npmx.dev/package/teleportal)

## Features

### Core Features

- **🌏 Ease-of-use:** We won't make you learn what a Y.Doc is, and make you store it somewhere, keep an instance of the provider, and you'll have everything you need!

- **📁 Sub-docs:** Full support for Y.js subdocs - there aren't many providers out there which have implemented this, this one does 😉

- **🏎️ Performance:** Built on top of web-native Streams APIs, supporting control-flow, backpressure. All without actually storing the documents in-memory

- **🔄 Zero in-memory storage:** Documents are never stored in memory on the server, making it perfect for scalable deployments

### Protocol & Synchronization

- **Binary Protocol:** Efficient binary protocol with magic number validation and version checking
- **Document Sync:** Full Y.js synchronization with sync-step-1, sync-step-2, updates, and sync-done messages
- **Awareness:** Real-time user presence, cursor positions, and selection states
- **Message Batching:** Multiple messages can be batched into a single transmission for efficiency
- **Ping/Pong:** Built-in keep-alive messages for connection health monitoring

### File Transfer

- **Chunked File Transfer:** Files are streamed in chunks (1MB default, configurable) for efficient transfer
- **Merkle Tree Verification:** Content-addressed storage with Merkle-tree integrity verification — the id _is_ the content hash, so uploads dedupe and resume for free
- **Large File Support:** Files up to 1GB
- **Encrypted Files:** End-to-end encryption for file transfers; the tree hashes ciphertext, so integrity is verified before anything is decrypted
- **Resumable Uploads:** Interrupted uploads resume from temporary storage instead of restarting

### Milestones (Document Snapshots)

- **Create Snapshots:** Capture document state at any point in time
- **List Milestones:** Query all milestones for a document
- **Lazy Loading:** Request milestone snapshots on-demand
- **Named Milestones:** Optional naming for milestones with update support
- **Metadata Management:** Track milestone creation times and document associations

### Storage

- **Storage Agnostic:** Interface-based design - implement for any storage backend
- **Multiple Implementations:**
  - **Unstorage:** Works with Redis, PostgreSQL, MySQL, SQLite, S3, Cloudflare R2, Azure Blob, and more
  - **In-Memory:** Fast in-memory storage for testing and development
  - **Encrypted/Unencrypted:** Support for both encrypted and unencrypted document storage
- **Separate Storage Types:**
  - Document storage (Y.js updates and metadata)
  - File storage (chunked files with Merkle trees)
  - Milestone storage (document snapshots)
  - Temporary upload storage (upload sessions)

### Transport & Connections

- **WebSocket:** Full WebSocket support with automatic reconnection
- **HTTP:** HTTP-based transport for environments where WebSockets aren't available
- **Server-Sent Events (SSE):** SSE support for one-way server-to-client communication
- **Fallback Connection:** Automatic fallback between WebSocket, HTTP, and SSE
- **Message Buffering:** Automatic message buffering when disconnected
- **Connection State Management:** Track connection state (connected, disconnected, connecting, errored)
- **In-Flight Message Tracking:** Monitor messages in transit

### End-to-End Encryption (E2EE)

- **AES-GCM Encryption:** Industry-standard encryption for document updates
- **Content-Level Encryption:** Only user content is encrypted (into sidecars); CRDT metadata stays in plaintext so the server can still merge, sync, and attribute edits without decrypting
- **Key Management:** Utilities for creating, importing, and exporting encryption keys
- **Encrypted File Support:** Files can be encrypted before chunking and transfer

### Security & Authentication

- **JWT Token Authentication:** Built-in JWT support via `jose`, with the signing algorithm pinned to HS256
- **IAM-like Permissions:** Granular permission system with document pattern matching
- **Permission Types:** `read` / `write`, checked per message
- **Pattern Matching:** Glob-style document patterns (`*` wildcard) with allow and `!`-exclusion rules; all other characters are matched literally
- **Room-based Access Control:** Multi-tenant support with room/organization isolation
- **Document Access Builder:** Fluent API for constructing complex permission rules
- **Token Expiration:** Configurable token expiration and validation

### Monitoring & Observability

- **Prometheus Metrics:** Built-in Prometheus-format metrics collection
- **Status Endpoint:** Real-time server status (active clients, sessions, message breakdown, document sizes)
- **Metrics Collected:**
  - Active clients and sessions
  - Total documents opened
  - Message counts by wire type
  - Message processing duration
  - Storage operation counts and duration
  - Error counts by type
- **Uptime Tracking:** Server uptime monitoring

### Developer Experience

- **DevTools Integration:** Built-in DevTools for debugging and monitoring
- **Agent Functionality:** Server-side document manipulation with Agent API
- **TypeScript Support:** Full TypeScript support with comprehensive type definitions
- **Comprehensive Logging:** Structured logging with `@logtape/logtape`
- **HTTP Server Handlers:** Ready-to-use HTTP handlers for integration
- **WebSocket Server Handlers:** Pre-built WebSocket upgrade and connection handlers

### Provider Features

- **Automatic Reconnection:** Smart reconnection logic with exponential backoff
- **Offline Persistence:** IndexedDB persistence for offline support
- **Subdoc Support:** Full Y.js subdoc synchronization
- **Connection Sharing:** Share connections across multiple providers
- **Observable Events:** Event-driven architecture with observable patterns

### Transport Middleware

- **Redis Transport:** Redis-based pub/sub for distributed deployments
- **NATS Transport:** NATS integration for message queuing
- **Rate Limiting:** Built-in rate limiting support
- **Message Validation:** Message validation middleware
- **ACK Support:** Acknowledgment support for reliable message delivery
- **PubSub Support:** Publish/subscribe patterns for multi-server deployments
- **Logger Transport:** Logging middleware for debugging

### Examples & Integrations

- **Excalidraw Example:** Complete example integration with Excalidraw
- **Playground:** Interactive playground for testing and development
- **Multiple Server Implementations:** Examples for Bun, Node.js, and more

## How easy is it?

This sets up a server with WebSocket support, and it runs on any JS runtime:

```typescript
import { serve } from "crossws/server";
import { Server } from "teleportal/server";
import { MemoryDocumentStorage } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const server = new Server({
  storage: new MemoryDocumentStorage(),
});

server.on("document-load", (event) => {
  console.log("Document loaded:", event.documentId);
});

serve({
  websocket: getWebsocketHandlers({
    server,
    onUpgrade: async () => {
      return { context: { userId: "nick", room: "test" } };
    },
  }),
  fetch: () => new Response("Not found", { status: 404 }),
});
```

The client connects, syncs, and makes a change:

```typescript
import { Provider, websocketTransport } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "test",
  encryptionKey: createEncryptionKey(),
  transports: [websocketTransport()],
});

await provider.synced;

// provider.doc is a standard Y.Doc — use it as you would anywhere.
const text = provider.doc.getText("test");
text.insert(0, "Hello, world!");

await provider.flush();
await provider.destroy();
```

See the [Getting Started guide](https://teleportal.tools/docs/getting-started/) and the [guides/](./guides/) directory for more examples.

## Installation

```bash
npm install teleportal
# or
bun add teleportal
# or
pnpm add teleportal
```

## Documentation

Full documentation lives at **[teleportal.tools](https://teleportal.tools/)**:

- [Getting Started](https://teleportal.tools/docs/getting-started/) - Build your first collaborative app in ~10 minutes
- [What is TelePortal?](https://teleportal.tools/docs/what-is-teleportal/) - How it compares to y-websocket, Hocuspocus, and Liveblocks
- [Core Concepts](https://teleportal.tools/docs/core-concepts/protocol/) - Protocol, server, provider, transport, and attribution
- [Guides](https://teleportal.tools/docs/guides/) - Auth, persistent storage, scaling, encryption, file transfers, and more

Each subsystem also ships a detailed technical README next to its source:

- [Protocol](./src/lib/README.md) · [Storage](./src/storage/README.md) · [Providers](./src/providers/README.md) · [Server](./src/server/README.md) · [Transports](./src/transports/README.md) · [Token & Auth](./src/token/README.md) · [Encryption Keys](./src/encryption-key/README.md) · [Cloudflare](./src/cloudflare/README.md) · [Monitoring](./src/monitoring/README.md)

## Exports

TelePortal is fully tree-shakeable and exposes focused entry points:

| Entry point                          | What it provides                                             |
| ------------------------------------ | ------------------------------------------------------------ |
| `teleportal`                         | Core library and shared types                                |
| `teleportal/server`                  | Server implementation                                        |
| `teleportal/providers`               | Client providers and transports                              |
| `teleportal/providers/worker`        | Shared-worker provider                                       |
| `teleportal/storage`                 | Storage interfaces and in-memory / unstorage implementations |
| `teleportal/storage/postgres`        | Postgres storage                                             |
| `teleportal/storage/s3`              | S3 file storage                                              |
| `teleportal/http`                    | HTTP + SSE handlers                                          |
| `teleportal/websocket-server`        | WebSocket server handlers                                    |
| `teleportal/cloudflare`              | Cloudflare Workers / Durable Objects support                 |
| `teleportal/protocol`                | Protocol encoding/decoding                                   |
| `teleportal/protocol/encryption`     | Content encryption protocol                                  |
| `teleportal/protocols/milestone`     | Milestone (snapshot) RPC                                     |
| `teleportal/protocols/file`          | File-transfer RPC                                            |
| `teleportal/protocols/attribution`   | Attribution (authorship) RPC                                 |
| `teleportal/protocols/key-registry`  | Key-distribution RPC + HTTP management                       |
| `teleportal/transports`              | Transport middleware (ack, logger, validation, pubsub, ...)  |
| `teleportal/transports/redis`        | Redis pub/sub transport                                      |
| `teleportal/transports/nats`         | NATS transport                                               |
| `teleportal/transports/rate-limiter` | Rate-limiting middleware                                     |
| `teleportal/token`                   | JWT token utilities and permissions                          |
| `teleportal/encryption-key`          | Encryption key management                                    |
| `teleportal/attribution`             | Attribution data model and set operations                    |
| `teleportal/monitoring`              | Prometheus metrics and monitoring                            |
| `teleportal/devtools`                | DevTools integration                                         |
| `teleportal/merkle-tree`             | Merkle-tree utilities                                        |
| `teleportal/agent`                   | Server-side document manipulation                            |

## Requirements

- Node.js >= 24
- Modern JavaScript runtime (Node.js, Bun, Deno, etc.)

## License

MPL-2.0

> [!NOTE]
> 🚧 This is still a work in progress. Feedback and contributions are welcome!
