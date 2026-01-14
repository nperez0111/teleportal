# Quick Start

Get up and running with Teleportal in minutes.

## Server Setup

First, let's create a simple server:

```typescript
import { Server } from "teleportal/server";
import { createInMemory } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

// Create server with in-memory storage
const server = new Server({
  getStorage: async (ctx) => {
    const { documentStorage } = createInMemory();
    return documentStorage;
  },
});

// Create WebSocket handlers
const handlers = getWebsocketHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});

// Use with your WebSocket server (example with Bun)
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

## Client Setup

Now, let's create a client that connects to the server:

```typescript
import { Provider } from "teleportal/providers";
import * as Y from "yjs";

// Create a provider
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document-id",
});

// Wait for document to be loaded and synced
await provider.loaded;
await provider.synced;

// Access the Y.js document
const ymap = provider.doc.getMap("data");
ymap.set("key", "value");

// Listen to updates
ymap.observe((event) => {
  console.log("Document updated:", event);
});

// Listen to connection state
provider.on("update", (state) => {
  console.log("Connection state:", state.type);
});
```

## Complete Example

Here's a complete example that demonstrates both server and client:

### Server (server.ts)

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

### Client (client.ts)

```typescript
import { Provider } from "teleportal/providers";

async function main() {
  const provider = await Provider.create({
    url: "ws://localhost:3000",
    document: "my-document",
  });

  await provider.synced;
  console.log("Connected and synced!");

  const ymap = provider.doc.getMap("data");
  
  // Set initial value
  ymap.set("counter", 0);

  // Listen to changes
  ymap.observe((event) => {
    console.log("Change:", event.changes);
  });

  // Update value
  ymap.set("counter", ymap.get("counter") + 1);
}

main();
```

## Running the Example

1. Start the server:
   ```bash
   bun run server.ts
   ```

2. Run the client:
   ```bash
   bun run client.ts
   ```

3. Open multiple client instances to see real-time synchronization!

## What's Next?

- [Server Setup](./server-setup.md) - Learn more about server configuration
- [Provider Setup](./provider-setup.md) - Learn more about client providers
- [Storage Configuration](./storage.md) - Use different storage backends
- [Examples](../examples/basic.md) - See more examples
