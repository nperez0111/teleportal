# Server Module

The server module provides the core `Server` class that manages real-time collaborative document synchronization, client connections, and file operations. It serves as the central orchestrator for handling Y.js document updates, awareness messages, file transfers, and milestone operations.

## Overview

The `Server` class is the main entry point for the Teleportal server-side implementation. It manages:

- **Document Sessions**: Creates and manages sessions for collaborative documents
- **Client Connections**: Handles client connections via transports (WebSocket, HTTP, etc.)
- **Message Processing**: Routes and processes all protocol messages (doc, awareness, file, ACK)
- **Permission Checking**: Validates client permissions for document and file operations
- **Multi-Node Support**: Uses PubSub for cross-node message fanout in distributed deployments
- **Metrics & Monitoring**: Tracks server health, metrics, and operational status

## Architecture

### Core Components

```text
┌─────────────────────────────────────────────────────────────┐
│                         Server                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Sessions   │  │   Clients    │  │   PubSub     │       │
│  │   (Map)     │  │   (per doc)  │  │   (optional) │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │               │
│         └─────────────────┴─────────────────┘               │
│                            │                                │
│                            ▼                               │
│                   ┌─────────────────┐                       │
│                   │ Message Router  │                       │
│                   └────────┬────────┘                       │
└────────────────────────────┼────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   Transports    │
                    │ (WebSocket/HTTP)│
                    └─────────────────┘
```

### Session Management

A **Session** represents an active collaborative document. Each session:

- Manages multiple clients connected to the same document
- Handles Y.js document synchronization (sync-step-1, sync-step-2, updates)
- Processes awareness updates (cursor positions, user presence)
- Manages milestone operations (create, list, retrieve snapshots)
- Automatically cleans up when all clients disconnect (after 60s timeout)
- Uses PubSub to replicate messages across server nodes

### Client Management

A **Client** represents a single connection to the server. Each client:

- Has a unique ID (auto-generated or provided)
- Connects via a `Transport` (WebSocket, HTTP, etc.)
- Can be connected to multiple document sessions simultaneously
- Sends and receives messages through the transport
- Automatically removed from sessions on disconnect

### Message Processing Flow

```text
Client → Transport → Server.createClient()
                          │
                          ▼
                    Message Validator
                    (permission check)
                          │
                          ▼
                    Message Router
                    ┌─────┴─────┐
                    │           │
                    ▼           ▼
              File Message   Doc/Awareness
                    │           │
                    ▼           ▼
              FileHandler   Session.apply()
                    │           │
                    ▼           ▼
              Storage API   PubSub (if multi-node)
                    │           │
                    └─────┬─────┘
                          ▼
                    Broadcast to
                    other clients
```

## Server Options

```typescript
type ServerOptions<Context extends ServerContext> = {
  /**
   * Retrieve per-document storage.
   * Called when a session is created for a document.
   */
  getStorage: (ctx: {
    documentId: string;
    context: Context;
    encrypted: boolean;
  }) => Promise<DocumentStorage>;

  /**
   * Optional permission checker for read/write operations.
   * Either documentId or fileId will be provided, but not both.
   * Returns true if the operation is allowed, false otherwise.
   */
  checkPermission?: (ctx: {
    context: Context;
    documentId?: string;
    fileId?: string;
    message: Message<Context>;
    type: "read" | "write";
  }) => Promise<boolean>;

  /**
   * PubSub backend for cross-node fanout.
   * Defaults to InMemoryPubSub (single-node).
   * Use Redis, RabbitMQ, etc. for multi-node deployments.
   */
  pubSub?: PubSub;

  /**
   * Node ID for this server instance.
   * Used to filter out messages from the same node in PubSub.
   * Defaults to a random UUID.
   */
  nodeId?: string;
};
```

## Usage

### Basic Setup

```typescript
import { Server } from "teleportal/server";
import { createInMemory } from "teleportal/storage";

const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createInMemory({
      encrypted: ctx.encrypted,
    });
    return documentStorage;
  },
});
```

### With Permission Checking

```typescript
const server = new Server({
  getStorage: async (ctx) => {
    // ... create storage
  },
  checkPermission: async ({ context, documentId, fileId, message, type }) => {
    // Check if user has permission
    const userId = context.userId;
    
    if (documentId) {
      // Check document permissions
      return await hasDocumentAccess(userId, documentId, type);
    } else if (fileId) {
      // Check file permissions
      return await hasFileAccess(userId, fileId, type);
    }
    
    return false;
  },
});
```

### With Multi-Node PubSub

```typescript
import { RedisPubSub } from "teleportal/pubsub/redis";

const server = new Server({
  getStorage: async (ctx) => {
    // ... create storage
  },
  pubSub: new RedisPubSub({
    url: "redis://localhost:6379",
  }),
  nodeId: process.env.NODE_ID || `node-${uuidv4()}`,
});
```

### Creating Clients

```typescript
import { WebSocketTransport } from "teleportal/transports/websocket";

// Create a client from a WebSocket connection
const transport = new WebSocketTransport(websocket, {
  document: "my-document",
  context: { userId: "user-123", clientId: "client-456" },
  encrypted: false,
});

const client = server.createClient({
  transport,
  id: "client-456", // optional, auto-generated if not provided
  abortSignal: abortController.signal, // optional, auto-disconnects on abort
});
```

### Document Operations

```typescript
// Get or create a session for a document
const session = await server.getOrOpenSession("my-document", {
  encrypted: false,
  client, // optional, adds client to session
  context: { userId: "user-123", clientId: "client-456" },
});

// Delete a document
await server.deleteDocument("my-document", context, false);
```

### Disconnecting Clients

```typescript
// Disconnect a specific client
server.disconnectClient("client-456", "manual");

// Or pass the client instance
server.disconnectClient(client, "manual");
```

### Server Lifecycle

```typescript
// Dispose the server (closes all sessions and connections)
await server[Symbol.asyncDispose]();

// Or using explicit resource management
using server = new Server({ ... });
// Server automatically disposes when exiting scope
```

## Multi-Tenancy Support

The server supports multi-tenancy through **room-based document namespacing**. If the context contains a `room` property, documents are automatically namespaced:

```typescript
// Document ID: "my-doc"
// Room: "tenant-123"
// Namespaced ID: "tenant-123/my-doc"

const session = await server.getOrOpenSession("my-doc", {
  encrypted: false,
  context: {
    userId: "user-1",
    clientId: "client-1",
    room: "tenant-123", // Multi-tenancy support
  },
});

// Storage operations use "tenant-123/my-doc" as the document ID
// PubSub messages are namespaced to prevent cross-tenant leakage
```

This allows:

- **Isolation**: Documents from different tenants are completely isolated
- **Shared Storage**: Same storage backend can be used for all tenants
- **Automatic Namespacing**: No manual prefix management required

## Message Types

The server handles all Teleportal protocol message types:

### Document Messages

- **sync-step-1**: Client sends state vector, server responds with missing updates
- **sync-step-2**: Server sends updates, client applies them
- **update**: Real-time document updates from clients
- **sync-done**: Synchronization completion signal
- **auth-message**: Permission denied/granted responses
- **milestone-***: Milestone operations (list, create, update, retrieve)

### Awareness Messages

- **awareness-update**: User presence and cursor information
- **awareness-request**: Request current awareness state

### File Messages

- **file-upload**: Initiate file upload with metadata
- **file-download**: Request file download by content ID
- **file-part**: Chunk data with Merkle proof
- **file-auth-message**: File operation authorization responses

### ACK Messages

- **ack**: Message delivery confirmation

## Permission Checking

The server supports optional permission checking via the `checkPermission` option. The checker is called for:

- **Document operations**: `sync-step-2`, `update`, milestone operations
- **File operations**: `file-upload`, `file-download`, `file-part`

### Permission Check Behavior

1. **ACK messages**: Always allowed (they're acknowledgments, not requests)
2. **Read operations**: Checked when client requests data (sync-step-1, file-download)
3. **Write operations**: Checked when client sends updates (sync-step-2, update, file-upload)
4. **Denied responses**: Server sends appropriate auth-message with denial reason

### Example Permission Checker

```typescript
const server = new Server({
  getStorage: async (ctx) => {
    // ... create storage
  },
  checkPermission: async ({ context, documentId, fileId, message, type }) => {
    const userId = context.userId;
    
    // Document permissions
    if (documentId) {
      if (type === "read") {
        return await canReadDocument(userId, documentId);
      } else if (type === "write") {
        // Special handling for sync-step-2 without write permission
        if (
          message.type === "doc" &&
          message.payload.type === "sync-step-2"
        ) {
          // Client tried to send updates but doesn't have write permission
          // Server will drop the message and send sync-done instead
          return false;
        }
        return await canWriteDocument(userId, documentId);
      }
    }
    
    // File permissions
    if (fileId) {
      if (type === "read") {
        return await canReadFile(userId, fileId);
      } else if (type === "write") {
        return await canWriteFile(userId, fileId);
      }
    }
    
    return false;
  },
});
```

## Events

The server extends `Observable` and emits the following events:

### Document Events

```typescript
// Emitted when a document session is created and loaded
server.on("document-load", (data) => {
  console.log("Document loaded:", data.documentId);
  console.log("Session ID:", data.sessionId);
  console.log("Encrypted:", data.encrypted);
});

// Emitted when a document session is unloaded
server.on("document-unload", (data) => {
  console.log("Document unloaded:", data.documentId);
  console.log("Reason:", data.reason); // "cleanup" | "delete" | "dispose"
});

// Emitted when a document is deleted
server.on("document-delete", (data) => {
  console.log("Document deleted:", data.documentId);
});
```

### Client Events

```typescript
// Emitted when a client connects
server.on("client-connect", (data) => {
  console.log("Client connected:", data.clientId);
});

// Emitted when a client disconnects
server.on("client-disconnect", (data) => {
  console.log("Client disconnected:", data.clientId);
  console.log("Reason:", data.reason); // "abort" | "stream-ended" | "manual" | "error"
});

// Emitted for all client messages (for metrics/webhooks)
server.on("client-message", (data) => {
  console.log("Message:", data.messageId);
  console.log("Direction:", data.direction); // "in" | "out"
  console.log("Type:", data.messageType);
});
```

### Server Lifecycle Events

```typescript
// Emitted before server shutdown starts
server.on("before-server-shutdown", (data) => {
  console.log("Shutting down:", data.nodeId);
  console.log("Active sessions:", data.activeSessions);
});

// Emitted after server shutdown completes
server.on("after-server-shutdown", (data) => {
  console.log("Shutdown complete:", data.nodeId);
});
```

## Metrics & Monitoring

The server automatically tracks metrics via Prometheus:

```typescript
// Get Prometheus-formatted metrics
const metrics = await server.getMetrics();
console.log(metrics);
// Output: Prometheus text format with counters, gauges, histograms
```

### Available Metrics

- **`sessions_active`**: Current number of active sessions (gauge)
- **`clients_active`**: Current number of active clients (gauge)
- **`documents_opened_total`**: Total documents opened (counter)
- **`messages_processed_total`**: Total messages processed (counter)
- **`messages_processed_total{type="doc"}`**: Messages by type (counter)
- **`message_duration_seconds`**: Message processing duration (histogram)

### Health Checks

```typescript
// Get health status
const health = await server.getHealth();
console.log(health);
// {
//   status: "healthy" | "unhealthy",
//   timestamp: "2024-01-01T00:00:00.000Z",
//   checks: { ... },
//   uptime: 3600
// }
```

### Operational Status

```typescript
// Get detailed operational status
const status = await server.getStatus();
console.log(status);
// {
//   nodeId: "node-123",
//   activeClients: 10,
//   activeSessions: 5,
//   pendingSessions: 0,
//   totalMessagesProcessed: 1000,
//   totalDocumentsOpened: 50,
//   messageTypeBreakdown: {
//     doc: 500,
//     awareness: 300,
//     file: 200
//   },
//   uptime: 3600,
//   timestamp: "2024-01-01T00:00:00.000Z"
// }
```

## Session Lifecycle

Sessions are created on-demand when the first client connects to a document:

1. **Creation**: `getOrOpenSession()` is called
2. **Loading**: Session loads document from storage
3. **Active**: Session processes messages and manages clients
4. **Cleanup**: Session is scheduled for cleanup when all clients disconnect (60s delay)
5. **Disposal**: Session is disposed and removed from memory

### Race Condition Prevention

The server prevents race conditions during session creation:

- **Pending Sessions Map**: Tracks in-progress session creation
- **Concurrent Requests**: Multiple clients requesting the same document wait for the same session promise
- **Encryption State Validation**: Ensures encryption state matches existing sessions

### Session Cleanup

Sessions are automatically cleaned up when:

- All clients disconnect (after 60s timeout)
- Document is deleted
- Server is disposed

The cleanup delay (60s) allows clients to reconnect without losing the session state.

## File Handling

File messages are processed by a `FileHandler` that:

- Manages file uploads with chunk verification
- Handles file downloads with Merkle proof validation
- Stores files via the session's `fileStorage`
- Requires `fileStorage` to be configured on the document storage

```typescript
// File storage must be configured on document storage
const { documentStorage, fileStorage } = createUnstorage(storage, {
  fileKeyPrefix: "file",
  documentKeyPrefix: "doc",
});

// FileHandler is automatically created per file message
// Uses session.storage.fileStorage for file operations
```

## Error Handling

The server handles errors gracefully:

- **Permission Denied**: Sends appropriate auth-message to client
- **Storage Errors**: Logged and propagated to client
- **Message Processing Errors**: Logged, ACK sent, error not propagated (prevents connection drop)
- **Session Creation Errors**: Logged, pending session removed, error propagated

### Error Response Types

- **Document Auth Message**: Sent for denied document operations
- **File Auth Message**: Sent for denied file operations (with HTTP status codes)
- **Milestone Auth Message**: Sent for denied milestone operations

## Best Practices

1. **Use PubSub for Multi-Node**: Deploy with Redis/RabbitMQ PubSub for horizontal scaling
2. **Implement Permission Checking**: Always implement `checkPermission` for production
3. **Monitor Metrics**: Expose Prometheus metrics endpoint for monitoring
4. **Handle Events**: Listen to server events for logging, webhooks, or analytics
5. **Graceful Shutdown**: Use `Symbol.asyncDispose` for clean server shutdown
6. **Session Cleanup**: Sessions auto-cleanup, but monitor for memory leaks
7. **Multi-Tenancy**: Use room-based namespacing for tenant isolation
8. **Error Handling**: Implement comprehensive error handling in permission checkers

## Integration Examples

### Express.js Integration

```typescript
import express from "express";
import { Server } from "teleportal/server";
import { WebSocketTransport } from "teleportal/transports/websocket";

const app = express();
const server = new Server({ /* ... */ });

// WebSocket endpoint
app.get("/ws", (req, res) => {
  const ws = new WebSocket(req, res);
  const transport = new WebSocketTransport(ws, {
    document: req.query.document as string,
    context: { userId: req.user.id },
    encrypted: false,
  });
  
  server.createClient({ transport });
});

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  const metrics = await server.getMetrics();
  res.setHeader("Content-Type", "text/plain");
  res.send(metrics);
});

// Health check endpoint
app.get("/health", async (req, res) => {
  const health = await server.getHealth();
  res.json(health);
});
```

### Bun HTTP Server Integration

```typescript
import { Server } from "bun";
import { Server as TeleportalServer } from "teleportal/server";
import { HttpTransport } from "teleportal/transports/http";

const teleportalServer = new TeleportalServer({ /* ... */ });

Bun.serve({
  port: 3000,
  websocket: {
    message: (ws, message) => {
      // Handle WebSocket messages
    },
    open: (ws) => {
      const transport = new WebSocketTransport(ws, { /* ... */ });
      teleportalServer.createClient({ transport });
    },
  },
  fetch: async (req) => {
    // Handle HTTP/SSE connections
    if (req.url.endsWith("/sse")) {
      const transport = new HttpTransport(req, { /* ... */ });
      teleportalServer.createClient({ transport });
      return new Response();
    }
    
    // Metrics endpoint
    if (req.url.endsWith("/metrics")) {
      return new Response(await teleportalServer.getMetrics(), {
        headers: { "Content-Type": "text/plain" },
      });
    }
    
    return new Response("Not Found", { status: 404 });
  },
});
```

## Summary

The `Server` class is the core of the Teleportal server implementation. It manages document sessions, client connections, message routing, and file operations. With support for multi-tenancy, permission checking, metrics, and multi-node deployments, it provides a robust foundation for building collaborative applications.

Key features:

- ✅ **Session Management**: Automatic session creation and cleanup
- ✅ **Client Handling**: Multi-client support per document
- ✅ **Message Routing**: Handles all protocol message types
- ✅ **Permission Checking**: Optional fine-grained access control
- ✅ **Multi-Node Support**: PubSub integration for distributed deployments
- ✅ **Multi-Tenancy**: Room-based document namespacing
- ✅ **Metrics & Monitoring**: Prometheus metrics and health checks
- ✅ **File Operations**: Integrated file upload/download handling
- ✅ **Event System**: Observable events for integration
- ✅ **Error Handling**: Graceful error handling and client notifications
