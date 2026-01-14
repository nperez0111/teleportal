# Authentication Example

This example shows how to add JWT-based authentication to your Teleportal server and client.

## Server

```typescript
import { Server } from "teleportal/server";
import { createInMemory } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";
import { createTokenManager } from "teleportal/token";

// Create token manager
const tokenManager = createTokenManager({
  secret: process.env.JWT_SECRET || "your-secret-key",
  expiresIn: 3600, // 1 hour
  issuer: "my-app",
});

// Create server with permission checking
const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createInMemory();
    return documentStorage;
  },
  checkPermission: async ({ context, documentId, message }) => {
    const token = (context as any).token;
    if (!token) return false;

    // Verify token
    const result = await tokenManager.verifyToken(token);
    if (!result.valid || !result.payload) return false;

    const payload = result.payload;

    // Check room access
    if (payload.room !== (context as any).room) return false;

    // Check document permissions
    if (!documentId) {
      throw new Error("documentId is required for doc messages");
    }
    const requiredPermission = message.type === "awareness" ? "read" : "write";
    return tokenManager.hasDocumentPermission(
      payload,
      documentId,
      requiredPermission
    );
  },
});

// Create WebSocket handlers with authentication
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

    const payload = result.payload;

    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      throw new Response("Token expired", { status: 401 });
    }

    return {
      context: {
        userId: payload.userId,
        room: payload.room,
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

console.log("Server running on ws://localhost:3000");
```

## Token Generation (API Endpoint)

```typescript
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({
  secret: process.env.JWT_SECRET || "your-secret-key",
  expiresIn: 3600,
});

// Example: Generate token for a user
async function generateToken(userId: string, room: string) {
  const token = await tokenManager.createUserToken(userId, room, [
    "read", "write", "comment", "suggest"
  ]);
  return token;
}

// Example: Generate admin token
async function generateAdminToken(userId: string, room: string) {
  const token = await tokenManager.createAdminToken(userId, room);
  return token;
}

// Example: Generate custom token
async function generateCustomToken(userId: string, room: string) {
  const token = await tokenManager.createDocumentToken(userId, room, [
    {
      pattern: "shared/*",
      permissions: ["read", "comment"]
    },
    {
      pattern: "projects/my-project/*",
      permissions: ["read", "write", "comment", "suggest"]
    },
    {
      pattern: `${userId}/*`,
      permissions: ["read", "write", "comment", "suggest", "admin"]
    }
  ]);
  return token;
}
```

## Client

```typescript
import { Provider } from "teleportal/providers";

async function main() {
  // Get token from your auth system
  const token = await getTokenFromAuth(); // Your auth function

  // Create provider with token
  const provider = await Provider.create({
    url: `ws://localhost:3000?token=${token}`,
    document: "my-document",
  });

  // Or use Authorization header (if using HTTP)
  // const connection = new HttpConnection({
  //   url: "http://localhost:3000",
  //   headers: {
  //     Authorization: `Bearer ${token}`,
  //   },
  // });
  // const provider = new Provider({
  //   client: connection,
  //   document: "my-document",
  // });

  await provider.synced;
  console.log("Connected and authenticated!");

  // Use the document
  const ymap = provider.doc.getMap("data");
  ymap.set("key", "value");
}

main();
```

## Complete Example with Express

```typescript
import express from "express";
import { createTokenManager } from "teleportal/token";

const app = express();
const tokenManager = createTokenManager({
  secret: process.env.JWT_SECRET || "your-secret-key",
  expiresIn: 3600,
});

// Login endpoint
app.post("/api/login", async (req, res) => {
  const { userId, room } = req.body;

  // Verify user credentials (your auth logic)
  // ...

  // Generate token
  const token = await tokenManager.createUserToken(userId, room, [
    "read", "write", "comment", "suggest"
  ]);

  res.json({ token });
});

// Token refresh endpoint
app.post("/api/refresh", async (req, res) => {
  const { token } = req.body;

  const result = await tokenManager.verifyToken(token);
  if (!result.valid || !result.payload) {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Generate new token
  const newToken = await tokenManager.createUserToken(
    result.payload.userId,
    result.payload.room,
    // Extract permissions from existing token
    result.payload.documentAccess.flatMap(da => da.permissions)
  );

  res.json({ token: newToken });
});

app.listen(3001);
```

## Next Steps

- [With Encryption](./encryption.md) - Add encryption to authenticated sessions
- [File Upload](./file-upload.md) - Upload files with authentication
