# HTTP Server

Teleportal provides HTTP handlers for environments where WebSockets aren't available or for HTTP/SSE-based connections.

## Basic Setup

```typescript
import { getHttpHandlers } from "teleportal/http";
import { Server } from "teleportal/server";

const server = new Server({
  // ... server configuration
});

const handlers = getHttpHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});
```

## Express.js Integration

```typescript
import express from "express";
import { getHttpHandlers } from "teleportal/http";
import { Server } from "teleportal/server";

const app = express();
const server = new Server({
  // ... server configuration
});

const handlers = getHttpHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});

// Use the handlers
app.post("/teleportal/:documentId", handlers.handle);
app.get("/teleportal/:documentId", handlers.handle);

app.listen(3000);
```

## Bun HTTP Server

```typescript
import { getHttpHandlers } from "teleportal/http";
import { Server } from "teleportal/server";

const server = new Server({
  // ... server configuration
});

const handlers = getHttpHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});

Bun.serve({
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/teleportal/")) {
      return handlers.handle(req);
    }
    return new Response("Not found", { status: 404 });
  },
  port: 3000,
});
```

## Handler Options

```typescript
interface HttpHandlersOptions<Context> {
  // Called when an HTTP connection is established
  onConnect: (ctx: {
    transport: Transport;
    context: Context;
    id: string;
  }) => Promise<void>;

  // Called when an HTTP connection is closed
  onDisconnect: (id: string) => Promise<void>;

  // Optional: Called during request handling
  onRequest?: (request: Request) => Promise<{
    context?: Context;
  }>;
}
```

## Authentication

Add authentication during request handling:

```typescript
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({
  secret: "your-secret-key",
  expiresIn: 3600,
});

const handlers = getHttpHandlers({
  onRequest: async (request) => {
    // Extract token from headers
    const token = request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      throw new Response("No token provided", { status: 401 });
    }

    // Verify token
    const result = await tokenManager.verifyToken(token);
    if (!result.valid || !result.payload) {
      throw new Response("Invalid token", { status: 401 });
    }

    return {
      context: {
        userId: result.payload.userId,
        room: result.payload.room,
        token,
      },
    };
  },
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});
```

## Client Usage

Clients can connect using `HttpConnection`:

```typescript
import { Provider } from "teleportal/providers";
import { HttpConnection } from "teleportal/providers/http";

const connection = new HttpConnection({
  url: "http://localhost:3000",
  headers: {
    Authorization: "Bearer token",
  },
});

const provider = new Provider({
  client: connection,
  document: "my-document",
});

await provider.synced;
```

## Server-Sent Events (SSE)

For one-way server-to-client communication, you can use SSE:

```typescript
// Server
app.get("/teleportal/:documentId/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send events
  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(interval);
  });
});
```

## Next Steps

- [WebSocket Server](./websocket-server.md) - Set up WebSocket connections
- [Provider Setup](./provider-setup.md) - Connect clients to the server
- [Authentication](./authentication.md) - Add authentication and permissions
