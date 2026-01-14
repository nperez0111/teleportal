# Offline Persistence

Teleportal supports offline persistence using IndexedDB, allowing documents to be available even when offline.

## Enabling Offline Persistence

Offline persistence is enabled by default:

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
  enableOfflinePersistence: true, // default
});
```

## Configuration

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
  enableOfflinePersistence: true,
  indexedDBPrefix: "my-app-", // Custom IndexedDB prefix
});
```

## How It Works

1. **Local Storage**: Document updates are stored in IndexedDB
2. **Offline Access**: Documents are available even when offline
3. **Automatic Sync**: When connection is restored, changes are synced automatically
4. **Conflict Resolution**: Y.js handles conflict resolution automatically

## Document Loading

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

// Loaded resolves when local data is loaded (even if offline)
await provider.loaded;

// Synced resolves when synced with server
await provider.synced;
```

## Offline Detection

```typescript
provider.on("update", (state) => {
  if (state.type === "disconnected") {
    console.log("Offline - using local data");
  } else if (state.type === "connected") {
    console.log("Online - syncing changes");
  }
});
```

## Manual Persistence

You can manually persist documents:

```typescript
import { persistToIndexedDB } from "teleportal/providers";

await persistToIndexedDB(provider.doc, "my-document", {
  prefix: "my-app-",
});
```

## Next Steps

- [Provider Setup](./provider-setup.md) - Learn more about providers
- [Connections](./connections.md) - Learn about connection management
