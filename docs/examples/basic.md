# Basic Example

A complete example showing how to set up a Teleportal server and connect a client.

## Server

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

// Start server (Bun example)
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

## Client

```typescript
import { Provider } from "teleportal/providers";
import * as Y from "yjs";

async function main() {
  // Create provider
  const provider = await Provider.create({
    url: "ws://localhost:3000",
    document: "my-document",
  });

  // Wait for sync
  await provider.synced;
  console.log("Connected and synced!");

  // Get Y.js types
  const ymap = provider.doc.getMap("data");
  const yarray = provider.doc.getArray("items");

  // Set initial values
  ymap.set("counter", 0);
  yarray.push(["item1", "item2"]);

  // Listen to changes
  ymap.observe((event) => {
    console.log("Map changed:", event.changes);
  });

  yarray.observe((event) => {
    console.log("Array changed:", event.changes);
  });

  // Make changes
  ymap.set("counter", ymap.get("counter") + 1);
  yarray.push(["item3"]);

  // Listen to connection state
  provider.on("update", (state) => {
    console.log("Connection state:", state.type);
  });
}

main();
```

## Running the Example

1. Save the server code as `server.ts`
2. Save the client code as `client.ts`
3. Start the server:
   ```bash
   bun run server.ts
   ```
4. Run the client:
   ```bash
   bun run client.ts
   ```
5. Open multiple client instances to see real-time synchronization!

## What's Happening

1. **Server Setup**: The server is created with in-memory storage and WebSocket handlers
2. **Client Connection**: The client connects to the server and creates a provider
3. **Synchronization**: The provider syncs the Y.js document with the server
4. **Real-time Updates**: Changes made to the document are automatically synchronized across all clients

## Next Steps

- [With Authentication](../examples/authentication.md) - Add authentication
- [With Encryption](../examples/encryption.md) - Add encryption
- [File Upload](../examples/file-upload.md) - Upload files
