# Provider Setup

The `Provider` class manages Y.js document synchronization on the client side. It handles connection management, offline persistence, and awareness updates.

## Basic Usage

```typescript
import { Provider } from "teleportal/providers";

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
```

## Provider Options

```typescript
interface ProviderOptions {
  // Connection URL (required)
  url: string;

  // Document ID (required)
  document: string;

  // Optional: Existing Y.Doc instance
  ydoc?: Y.Doc;

  // Optional: Existing Awareness instance
  awareness?: Awareness;

  // Optional: Enable offline persistence (default: true)
  enableOfflinePersistence?: boolean;

  // Optional: IndexedDB prefix (default: 'teleportal-')
  indexedDBPrefix?: string;

  // Optional: Custom connection instance
  client?: Connection;

  // Optional: Custom transport factory
  getTransport?: (ctx) => Transport;
}
```

## Connection Types

### Automatic Connection (Default)

The provider automatically creates a `FallbackConnection` that tries WebSocket first, then falls back to HTTP:

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});
```

### WebSocket Only

```typescript
import { WebSocketConnection } from "teleportal/providers/websocket";

const connection = new WebSocketConnection({
  url: "ws://localhost:3000",
});

const provider = new Provider({
  client: connection,
  document: "my-document",
});
```

### HTTP/SSE Only

```typescript
import { HttpConnection } from "teleportal/providers/http";

const connection = new HttpConnection({
  url: "http://localhost:3000",
});

const provider = new Provider({
  client: connection,
  document: "my-document",
});
```

## Document Access

### Y.Doc

Access the Y.js document directly:

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

await provider.synced;

// Get Y.js types
const ymap = provider.doc.getMap("data");
const yarray = provider.doc.getArray("items");
const ytext = provider.doc.getText("content");

// Make changes
ymap.set("key", "value");
yarray.push(["item1", "item2"]);
ytext.insert(0, "Hello");
```

### Awareness

Access the awareness instance for presence/cursor information:

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

// Set local awareness state
provider.awareness.setLocalStateField("user", {
  name: "Alice",
  color: "#ff0000",
});

// Listen to awareness changes
provider.awareness.on("change", (changes) => {
  console.log("Awareness changed:", changes);
});
```

## Connection State

Monitor connection state:

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

// Get current state
const state = provider.state;
console.log("Connection state:", state.type);

// Listen to state changes
provider.on("update", (state) => {
  console.log("State changed:", state.type);
  if (state.type === "connected") {
    console.log("Connected!");
  } else if (state.type === "errored") {
    console.error("Error:", state.error);
  }
});

// Wait for connection
try {
  await provider.synced;
  console.log("Fully synced!");
} catch (error) {
  console.error("Sync failed:", error);
}
```

## Document Switching

Switch to a different document while reusing the connection:

```typescript
// Switch to a new document
const newProvider = provider.switchDocument({
  document: "new-document-id",
});

// Old provider is destroyed, new provider is ready
await newProvider.synced;
```

## Subdocuments

Subdocuments are automatically handled:

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

// Listen to subdocument events
provider.on("load-subdoc", ({ subdoc, provider: subdocProvider }) => {
  console.log("Subdocument loaded:", subdoc.guid);
  // subdocProvider is a Provider instance for the subdocument
});

provider.on("unload-subdoc", ({ subdoc }) => {
  console.log("Subdocument unloaded:", subdoc.guid);
});

// Access subdocuments
const subdocProvider = provider.subdocs.get("subdoc-guid");
if (subdocProvider) {
  await subdocProvider.synced;
}
```

## Milestones

Create and manage document milestones (snapshots):

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

// List milestones
const milestones = await provider.listMilestones();

// Create a milestone
const milestone = await provider.createMilestone("Checkpoint 1");

// Get milestone snapshot
const snapshot = await provider.getMilestoneSnapshot(milestone.id);

// Update milestone name
await provider.updateMilestoneName(milestone.id, "Updated Name");
```

## Offline Persistence

Offline persistence is enabled by default using IndexedDB:

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
  enableOfflinePersistence: true, // default
  indexedDBPrefix: "my-app-",     // custom prefix
});

// Document will be loaded from IndexedDB if available
await provider.loaded; // Resolves when local data is loaded
await provider.synced; // Resolves when synced with server
```

## Cleanup

Destroy the provider when done:

```typescript
// Destroy provider and connection
provider.destroy();

// Or destroy provider but keep connection
provider.destroy({ destroyConnection: false });

// Or keep the Y.Doc
provider.destroy({ destroyDoc: false });

// Using explicit resource management
using provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});
// Automatically destroyed when out of scope
```

## Next Steps

- [Connections](./connections.md) - Learn more about connection types
- [Offline Persistence](./offline-persistence.md) - Configure offline support
- [Subdocuments](./subdocuments.md) - Work with subdocuments
- [Milestones](./milestones.md) - Create and manage milestones
