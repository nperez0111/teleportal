# WebSocket Server

Teleportal provides WebSocket server handlers that integrate with your WebSocket server.

## Basic Setup

```typescript
import { getWebsocketHandlers } from "teleportal/websocket-server";
import { Server } from "teleportal/server";

const server = new Server({
  // ... server configuration
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

## Bun WebSocket Server

```typescript
import { getWebsocketHandlers } from "teleportal/websocket-server";

const handlers = getWebsocketHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});

Bun.serve({
  fetch(req, server) {
    if (req.headers.get("upgrade") === "websocket") {
      return handlers.upgrade(req, server);
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: handlers.websocket,
  port: 3000,
});
```

## Node.js WebSocket Server

```typescript
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const handlers = getWebsocketHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

wss.on("upgrade", (request, socket, head) => {
  handlers.upgrade(request, socket, head);
});

httpServer.listen(3000);
```

## Handler Options

```typescript
interface WebsocketHandlersOptions<Context> {
  // Called when a WebSocket connection is established
  onConnect: (ctx: {
    transport: Transport;
    context: Context;
    id: string;
  }) => Promise<void>;

  // Called when a WebSocket connection is closed
  onDisconnect: (id: string) => Promise<void>;

  // Optional: Called during WebSocket upgrade
  onUpgrade?: (request: Request) => Promise<{
    context?: Context;
  }>;
}
```

## Authentication

You can add authentication during the upgrade phase:

```typescript
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({
  secret: "your-secret-key",
  expiresIn: 3600,
});

const handlers = getWebsocketHandlers({
  onUpgrade: async (request) => {
    // Extract token from query string or headers
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ||
                 request.headers.get("authorization")?.replace("Bearer ", "");

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

## Connection Context

The context object is passed through to the server and can contain any information:

```typescript
interface ConnectionContext {
  userId?: string;
  room?: string;
  token?: string;
  // ... any custom fields
}
```

## Error Handling

Errors during upgrade or connection are handled automatically:

```typescript
const handlers = getWebsocketHandlers({
  onUpgrade: async (request) => {
    try {
      // ... authentication
      return { context: { userId: "user-123" } };
    } catch (error) {
      // Return error response
      throw new Response("Authentication failed", { status: 401 });
    }
  },
  onConnect: async ({ transport, context, id }) => {
    try {
      await server.createClient(transport, context, id);
    } catch (error) {
      console.error("Failed to create client:", error);
      // Connection will be closed
    }
  },
});
```

## Next Steps

- [HTTP Server](./http-server.md) - Set up HTTP/SSE connections
- [Authentication](./authentication.md) - Add authentication and permissions
- [Provider Setup](./provider-setup.md) - Connect clients to the server
