# Server Setup

The Teleportal server manages document sessions, client connections, and coordinates synchronization. It's designed to be storage-agnostic and works with any storage backend.

## Basic Server

The simplest server setup uses in-memory storage:

```typescript
import { Server } from "teleportal/server";
import { createInMemory } from "teleportal/storage";

const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createInMemory();
    return documentStorage;
  },
});
```

## Server Options

The `Server` constructor accepts the following options:

```typescript
interface ServerOptions<Context> {
  // Required: Function that returns storage for a document
  getStorage: (ctx: { documentId: string; context: Context }) => Promise<DocumentStorage>;

  // Optional: Permission checking function
  checkPermission?: (ctx: {
    context: Context;
    documentId?: string;
    fileId?: string;
    message: Message;
  }) => Promise<boolean>;

  // Optional: Custom logger
  logger?: Logger;

  // Optional: Enable metrics collection
  enableMetrics?: boolean;
}
```

## Storage Configuration

The `getStorage` function is called for each document operation. It receives context about the document and should return the appropriate storage instance.

### In-Memory Storage

Perfect for development and testing:

```typescript
const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createInMemory({
      encrypted: ctx.documentId.includes("encrypted"),
    });
    return documentStorage;
  },
});
```

### Unstorage (Redis, PostgreSQL, etc.)

Use with any unstorage-compatible backend:

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

See [Storage Configuration](./storage.md) for more details.

## Permission Checking

You can add permission checking to control access to documents:

```typescript
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({
  secret: "your-secret-key",
  expiresIn: 3600,
});

const server = new Server({
  getStorage: async (ctx) => {
    // ... storage setup
  },
  checkPermission: async ({ context, documentId, message }) => {
    const token = (context as any).token;
    if (!token) return false;

    const result = await tokenManager.verifyToken(token);
    if (!result.valid || !result.payload) return false;

    const requiredPermission = message.type === "awareness" ? "read" : "write";
    return tokenManager.hasDocumentPermission(
      result.payload,
      documentId!,
      requiredPermission
    );
  },
});
```

See [Authentication](./authentication.md) for more details.

## Creating Clients

Clients are created when connections are established:

```typescript
// Via WebSocket handlers
const handlers = getWebsocketHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});

// Or manually
const client = server.createClient(transport, context, clientId);
```

## Document Sessions

Documents are automatically created when clients connect:

```typescript
// Get or create a document session
const session = await server.getOrOpenSession(documentId, {
  encrypted: false,
  client,
  context,
});

// Remove a client from a session
session.removeClient(client);

// Close a session
await session.close();
```

## Server Methods

### `createClient(transport, context, id)`

Creates a new client connection.

### `disconnectClient(id)`

Disconnects a client and cleans up resources.

### `getOrOpenSession(documentId, options)`

Gets an existing session or creates a new one.

### `getSession(documentId)`

Gets an existing session (returns `null` if not found).

## Context

The `context` object is passed through the server and can contain any information you need:

```typescript
interface ServerContext {
  userId?: string;
  room?: string;
  token?: string;
  // ... any custom fields
}
```

Context is available in:
- `getStorage` function
- `checkPermission` function
- Session operations

## Error Handling

The server handles errors gracefully:

```typescript
const server = new Server({
  getStorage: async (ctx) => {
    try {
      // ... storage setup
    } catch (error) {
      console.error("Storage error:", error);
      throw error; // Server will handle it
    }
  },
});
```

## Next Steps

- [WebSocket Server](./websocket-server.md) - Set up WebSocket connections
- [HTTP Server](./http-server.md) - Set up HTTP/SSE connections
- [Storage Configuration](./storage.md) - Configure different storage backends
- [Authentication](./authentication.md) - Add authentication and permissions
