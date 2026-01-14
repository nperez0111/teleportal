# Subdocuments

Teleportal has full support for Y.js subdocuments, allowing you to work with nested document structures.

## What are Subdocuments?

Subdocuments are Y.js documents that are embedded within other documents. They're useful for:
- Organizing complex document structures
- Isolating different parts of a document
- Managing permissions per subdocument
- Improving performance by loading subdocuments on demand

## Automatic Handling

Teleportal automatically handles subdocuments:

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

// Subdocuments are automatically loaded when created
provider.on("load-subdoc", ({ subdoc, provider: subdocProvider }) => {
  console.log("Subdocument loaded:", subdoc.guid);
  // subdocProvider is a Provider instance for the subdocument
});

provider.on("unload-subdoc", ({ subdoc }) => {
  console.log("Subdocument unloaded:", subdoc.guid);
});
```

## Creating Subdocuments

```typescript
const ymap = provider.doc.getMap("data");

// Create a subdocument
const subdoc = new Y.Doc();
ymap.set("subdoc", subdoc);

// Subdocument is automatically synced via Teleportal
```

## Accessing Subdocuments

```typescript
// Access subdocument providers
const subdocProvider = provider.subdocs.get("subdoc-guid");
if (subdocProvider) {
  await subdocProvider.synced;
  
  // Use the subdocument
  const subdocMap = subdocProvider.doc.getMap("data");
  subdocMap.set("key", "value");
}
```

## Working with Subdocuments

```typescript
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

await provider.synced;

// Create a subdocument
const ymap = provider.doc.getMap("data");
const subdoc = new Y.Doc();
ymap.set("nested-doc", subdoc);

// Listen to subdocument events
provider.on("load-subdoc", ({ subdoc, provider: subdocProvider }) => {
  console.log("Subdocument loaded:", subdoc.guid);
  
  // Work with subdocument
  const subdocMap = subdocProvider.doc.getMap("data");
  subdocMap.set("initialized", true);
});

// Access subdocument later
const subdocProvider = provider.subdocs.get(subdoc.guid);
if (subdocProvider) {
  await subdocProvider.synced;
  // Use subdocument
}
```

## Subdocument Synchronization

Subdocuments are automatically synchronized:
- When created, they're synced to the server
- When loaded, they're synced with the server
- Changes are propagated to all clients
- Each subdocument has its own sync state

## Next Steps

- [Provider Setup](./provider-setup.md) - Learn more about providers
- [Milestones](./milestones.md) - Create document snapshots
