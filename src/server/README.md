# Server Module

The server module provides the core `Server` class that manages real-time collaborative document synchronization, client connections, and RPC operations. It serves as the central orchestrator for handling Y.js document updates, presence messages, RPC methods (milestones, file transfers, etc.), and message routing.

## Overview

The `Server` class is the main entry point for the Teleportal server-side implementation. It manages:

- **Document Sessions**: Creates and manages sessions for collaborative documents
- **Client Connections**: Handles client connections via transports (WebSocket, HTTP, etc.)
- **Message Processing**: Routes and processes all protocol messages (doc, presence, RPC, ACK)
- **Permission Checking**: Validates client permissions for document and RPC operations
- **Multi-Node Support**: Uses PubSub for cross-node message fanout in distributed deployments
- **Metrics & Monitoring**: Tracks server health, metrics, and operational status

## Architecture

### Core Components

```text
┌─────────────────────────────────────────────────────────────┐
│                         Server                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Sessions   │  │   Clients    │  │   PubSub     │       │
│  │   (Map)      │  │   (per doc)  │  │   (optional) │       │
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
- Processes presence messages (join/leave/heartbeat for cross-node awareness)
- Routes RPC messages (milestones, file transfers, custom handlers)
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
                    Rate Limiter (optional)
                          │
                          ▼
                    Message Validator
                    (permission check)
                          │
                          ▼
                    Session.apply()
                    ┌─────┴─────┐
                    │           │
                    ▼           ▼
              Doc/Presence   RPC Message
                    │           │
                    ▼           ▼
              Storage API   RPC Handlers
                    │           │
                    └─────┬─────┘
                          ▼
                    PubSub (if multi-node)
                          │
                          ▼
                    Broadcast to
                    other clients
```

## Server Options

```typescript
type ServerOptions<Context extends ServerContext> = {
  /**
   * Retrieve per-document storage.
   * Can be a direct instance, a promise, or a factory function called per-session.
   */
  storage:
    | DocumentStorage
    | Promise<DocumentStorage>
    | ((ctx: {
        documentId: string;
        context: Context;
        encrypted: boolean;
      }) => DocumentStorage | Promise<DocumentStorage>);

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
    rpcMethod?: string;
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

  /**
   * Configuration for document size limits and warnings.
   */
  documentSizeConfig?: {
    warningThreshold?: number;
    limit?: number;
  };

  /**
   * Configuration for automatic milestone triggers.
   */
  milestoneTriggerConfig?: {
    defaultTriggers?: MilestoneTrigger[];
  };

  /**
   * Configuration for client presence (join/leave) notifications
   * broadcast to a session's peers.
   */
  presenceConfig?: PresenceConfig<Context>;

  /**
   * Configuration for custom attribution metadata on document updates.
   */
  attributionConfig?: AttributionConfig<Context>;

  /**
   * RPC handlers for the server.
   * Built-in handlers (milestone, file) should be merged with any custom handlers.
   */
  rpcHandlers?: RpcHandlerRegistry;

  /**
   * Configuration for rate limiting on client transports.
   * If provided, all transports will be rate-limited before processing messages.
   * Rate limiting uses a rules-based approach where each rule defines its own
   * limits, tracking mode, and optional storage.
   */
  rateLimitConfig?: {
    rules: RateLimitRule<Context>[];
    maxMessageSize?: number; // default: 10MB
    maxDelayMs?: number; // default: 1000 — hold time before dropping; 0 = drop immediately
    rateLimitStorage?: RateLimitStorage;
    getUserId?: (message: Message<Context>) => string | undefined;
    getDocumentId?: (message: Message<Context>) => string | undefined;
    shouldSkipRateLimit?: (message: Message<Context>) => Promise<boolean> | boolean;
    onRateLimitExceeded?: (details: {
      ruleId: string;
      userId?: string;
      documentId?: string;
      trackBy: string;
      currentCount: number;
      maxMessages: number;
      windowMs: number;
      resetAt: number;
      message: Message<Context>;
    }) => void;
    onRateLimitDelay?: (details: {
      ruleId: string;
      userId?: string;
      documentId?: string;
      trackBy: string;
      delayMs: number;
      maxMessages: number;
      windowMs: number;
      message: Message<Context>;
    }) => void;
    onMessageSizeExceeded?: (details: {
      size: number;
      maxSize: number;
      message: Message<Context>;
    }) => void;
  };
};
```

## Usage

### Basic Setup

```typescript
import { Server } from "teleportal/server";
import { MemoryDocumentStorage } from "teleportal/storage";

// Option 1: Direct instance (shared across all documents)
const server = new Server({
  storage: new MemoryDocumentStorage(),
});

// Option 2: Factory function (per-document storage)
const server2 = new Server({
  storage: async (ctx) => {
    return new MemoryDocumentStorage();
  },
});
```

### With Permission Checking

```typescript
const server = new Server({
  storage: async (ctx) => {
    // ... create storage
  },
  checkPermission: async ({ context, documentId, fileId, message, type, rpcMethod }) => {
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
  storage: async (ctx) => {
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
await using server = new Server({ ... });
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

### Document Messages (`doc`)

- **sync-step-1**: Client sends state vector, server responds with missing updates
- **sync-step-2**: Server sends updates, client applies them
- **update**: Real-time document updates from clients
- **sync-done**: Synchronization completion signal
- **auth-message**: Permission denied/granted responses

### Presence Messages (`presence`)

- **presence-announce**: Client announces its awareness client ID (triggers join broadcast and roster replay)
- **presence-unannounce**: Client retracts a single awareness client ID (e.g. one tab in a SharedWorker closed)
- **presence-join**: Server-authored notification that a peer joined
- **presence-leave**: Server-authored notification that a peer left
- **presence-heartbeat**: Periodic snapshot of a node's local clients (cross-node roster, self-healing)

### RPC Messages (`rpc`)

- **request**: Client sends an RPC request (milestones, file operations, custom methods)
- **stream**: Streaming chunks (e.g., file upload parts)
- **response**: Server response to an RPC request

### ACK Messages (`ack`)

- **ack**: Message delivery confirmation (with optional `retryAfter` for rate limiting)

## Rate Limiting

The server supports automatic rate limiting on all client transports when `rateLimitConfig` is provided. Rate limiting uses a rules-based approach where multiple rules can be defined, each with its own limits, tracking mode, and optional storage override.

### Rate Limit Configuration

```typescript
import { Server } from "teleportal/server";

const server = new Server({
  storage: async (ctx) => {
    // ... create storage
  },
  rateLimitConfig: {
    rules: [
      {
        id: "per-user",
        maxMessages: 100,
        windowMs: 1000,
        trackBy: "user",
      },
      {
        id: "per-document",
        maxMessages: 500,
        windowMs: 10000,
        trackBy: "document",
      },
    ],
    maxMessageSize: 10 * 1024 * 1024, // 10MB (default)
    // Optional: Default storage for all rules (individual rules can override)
    // rateLimitStorage: myRateLimitStorage,
    // Optional: Default user/document ID extractors
    // getUserId: (msg) => msg.context.userId,
    // getDocumentId: (msg) => msg.document,
    // Optional: Skip rate limiting for certain messages
    shouldSkipRateLimit: async (msg) => {
      return msg.context.userId === "admin";
    },
    // Optional: Callbacks for rate limit events
    onRateLimitExceeded: (details) => {
      console.log("Rate limit exceeded", details);
    },
  },
});
```

### Rate Limit Rules

Each rule in the `rules` array defines:

- **`id`**: Unique identifier for the rule (used in metrics and events)
- **`maxMessages`**: Maximum messages per window (number or function)
- **`windowMs`**: Time window in milliseconds (number or function)
- **`trackBy`**: How to track limits for this rule

### Rate Limit Tracking Modes

- **`"user"`**: Track rate limits per user ID. All connections from the same user share the same limit.
- **`"document"`**: Track rate limits per document ID. All users editing the same document share the same limit.
- **`"user-document"`**: Track rate limits per user-document pair. Each user has separate limits for each document.
- **`"transport"`**: Track rate limits per transport instance (in-memory only, not shared).

### Rate Limit Storage

- **In-memory** (default): Rate limits are per-transport instance. Not shared across server instances.
- **Persistent storage** (Redis/Unstorage): Rate limits are shared across all server instances. Recommended for multi-node deployments.

### Flow control

When `maxDelayMs` is set (default: 1000ms), a rate-limited message is held until its token bucket refills rather than dropped immediately. This slows a fast client to the allowed rate without losing messages. If the hold time exceeds `maxDelayMs`, the message is dropped and the client receives a NACK with `retryAfter`. Set `maxDelayMs: 0` to drop immediately.

### Integration with Permissions

Rate limiting is applied **before** permission checking. Messages that exceed rate limits are rejected with an ACK containing a `retryAfter` hint. ACK messages are automatically excluded from rate limiting.

### Metrics

Rate limit metrics are automatically recorded via the server's `MetricsCollector`:

- Rate limit exceeded events
- Rate limit state operations (get/set)
- Breakdown by tracking mode

## Permission Checking

The server supports optional permission checking via the `checkPermission` option. The checker is called for:

- **Document operations**: `sync-step-1` (read), `sync-step-2` (write), `update` (write)
- **RPC operations**: Any RPC request, with `rpcMethod` provided in the context

### Permission Check Behavior

1. **ACK messages**: Always allowed (they're acknowledgments, not requests)
2. **Read operations**: Checked when client requests data (e.g., sync-step-1)
3. **Write operations**: Checked when client sends updates (e.g., sync-step-2, update)
4. **RPC operations**: Checked with the `rpcMethod` name for fine-grained control
5. **Denied responses**: Server sends appropriate auth-message or RPC error response

### Example Permission Checker

```typescript
const server = new Server({
  storage: async (ctx) => {
    // ... create storage
  },
  checkPermission: async ({ context, documentId, fileId, message, type, rpcMethod }) => {
    const userId = context.userId;

    // Document permissions
    if (documentId) {
      if (type === "read") {
        return await canReadDocument(userId, documentId);
      } else if (type === "write") {
        // Special handling for sync-step-2 without write permission:
        // Server will drop the message and send sync-done instead
        return await canWriteDocument(userId, documentId);
      }
    }

    // File permissions (fileId comes from RPC stream messages)
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

// Emitted when a new session is opened (provides the Session instance)
server.on("session-open", (data) => {
  console.log("Session opened:", data.session.id);
  console.log("Document:", data.documentId);
  // Set up session-level event listeners here
});

// Emitted when a document session is unloaded
server.on("document-unload", (data) => {
  console.log("Document unloaded:", data.documentId);
  console.log("Reason:", data.reason); // "cleanup" | "delete" | "dispose"
});

// Emitted when a milestone is created
server.on("milestone-created", (data) => {
  console.log("Milestone created:", data.milestoneId);
  console.log("Trigger:", data.triggerType); // "manual" | "time-based" | "update-count" | "event-based"
});

// Emitted when a milestone is soft deleted
server.on("milestone-deleted", (data) => {
  console.log("Milestone soft deleted:", data.milestoneId);
  console.log("Deleted by:", data.deletedBy);
});

// Emitted when a milestone is restored
server.on("milestone-restored", (data) => {
  console.log("Milestone restored:", data.milestoneId);
});

// Emitted when a document is deleted
server.on("document-delete", (data) => {
  console.log("Document deleted:", data.documentId);
});

// Emitted when document size exceeds warning threshold
server.on("document-size-warning", (data) => {
  console.log("Size warning:", data.documentId);
  console.log("Size:", data.sizeBytes);
  console.log("Threshold:", data.warningThreshold);
});

// Emitted when document size exceeds limit
server.on("document-size-limit-exceeded", (data) => {
  console.log("Size limit exceeded:", data.documentId);
  console.log("Size:", data.sizeBytes);
  console.log("Limit:", data.sizeLimit);
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
  console.log("Client:", data.clientId);
  console.log("Direction:", data.direction); // "in" | "out"
  console.log("Type:", data.message.type);
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
//   messageTypeBreakdown: { doc: 500, presence: 200, rpc: 100 },
//   rateLimitExceededTotal: 5,
//   rateLimitBreakdown: { ... },
//   rateLimitTopOffenders: [ ... ],
//   rateLimitRecentEvents: [ ... ],
//   uptime: 3600,
//   timestamp: "2024-01-01T00:00:00.000Z",
//   totalDocumentSizeBytes: 1048576,
//   documentsOverWarningThreshold: 1,
//   documentsOverLimit: 0
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

## RPC & File Handling

File operations and milestones are handled through the RPC system. The server dispatches
RPC messages to registered handlers in `rpcHandlers`. Built-in handlers exist for file
upload/download and milestone operations.

```typescript
import { createFileHandler, createMilestoneHandler } from "teleportal/protocols";

const server = new Server({
  storage: myStorage,
  rpcHandlers: {
    ...createFileHandler(),
    ...createMilestoneHandler(),
    // Add your own custom RPC handlers here
  },
});
```

## Error Handling

The server handles errors gracefully:

- **Permission Denied**: Sends appropriate auth-message to client
- **Storage Errors**: Logged and propagated to client
- **Message Processing Errors**: Logged, ACK sent, error not propagated (prevents connection drop)
- **Session Creation Errors**: Logged, pending session removed, error propagated

### Error Response Types

- **Document Auth Message**: Sent for denied document operations (`doc` messages with `auth-message` payload)
- **RPC Error Response**: Sent for denied RPC operations (403 status code with "Permission denied")
- **Sync Done**: Sent when a read-only client sends sync-step-2 (graceful denial)

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

### Bun + crossws Integration

```typescript
import { crossws } from "crossws/adapters/bun";
import { Server } from "teleportal/server";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({ secret: process.env.TOKEN_SECRET! });

const server = new Server({
  storage: myStorage,
  /* ... */
});

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({ server, tokenManager }),
);

export default {
  port: 3000,
  fetch: ws.fetch,
  websocket: ws.websocket,
};
```

### Metrics and health endpoints

```typescript
const handler = async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/metrics") {
    return new Response(await server.getMetrics(), {
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (url.pathname === "/health") {
    const health = await server.getHealth();
    return Response.json(health);
  }

  if (url.pathname === "/status") {
    return Response.json(await server.getStatus());
  }

  return new Response("Not Found", { status: 404 });
};
```

## Summary

The `Server` class is the core of the Teleportal server implementation. It manages document sessions, client connections, message routing, and RPC operations. With support for multi-tenancy, permission checking, presence, attribution, metrics, and multi-node deployments, it provides a robust foundation for building collaborative applications.

Key features:

- Session Management: Automatic session creation and cleanup
- Client Handling: Multi-client support per document
- Message Routing: Handles all protocol message types (doc, presence, RPC, ACK)
- Permission Checking: Optional fine-grained access control with RPC method awareness
- Multi-Node Support: PubSub integration for distributed deployments
- Multi-Tenancy: Room-based document namespacing
- Presence: Cross-node join/leave/heartbeat with TTL-based self-healing
- Attribution: Automatic authorship tracking on document updates
- Metrics & Monitoring: Prometheus metrics and health checks
- RPC System: Extensible handler registry for milestones, files, and custom operations
- Event System: Observable events for integration
- Error Handling: Graceful error handling and client notifications
