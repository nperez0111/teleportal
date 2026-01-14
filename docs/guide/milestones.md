# Milestones

Milestones allow you to create snapshots of document state at specific points in time, useful for versioning, backups, and restoring previous states.

## Creating Milestones

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});

await provider.synced;

// Create a milestone with optional name
const milestone = await provider.createMilestone("Checkpoint 1");

// Or let server auto-generate name
const milestone2 = await provider.createMilestone();
```

## Listing Milestones

```typescript
// List all milestones
const milestones = await provider.listMilestones();

// List with incremental updates (only new milestones)
const newMilestones = await provider.listMilestones([
  "known-id-1",
  "known-id-2",
]);
```

## Getting Milestone Snapshots

```typescript
// Get milestone snapshot
const snapshot = await provider.getMilestoneSnapshot(milestone.id);

// Snapshot is a Uint8Array containing the document state
console.log("Snapshot size:", snapshot.length);
```

## Updating Milestone Names

```typescript
// Update milestone name
const updated = await provider.updateMilestoneName(
  milestone.id,
  "Updated Checkpoint 1"
);
```

## Restoring from Milestone

```typescript
import * as Y from "yjs";

// Get milestone snapshot
const snapshot = await provider.getMilestoneSnapshot(milestone.id);

// Create new Y.Doc and apply snapshot
const restoredDoc = new Y.Doc();
Y.applyUpdate(restoredDoc, snapshot);

// Use restored document
const ymap = restoredDoc.getMap("data");
console.log("Restored data:", ymap.toJSON());
```

## Milestone Metadata

```typescript
const milestones = await provider.listMilestones();

milestones.forEach((milestone) => {
  console.log("ID:", milestone.id);
  console.log("Name:", milestone.name);
  console.log("Document ID:", milestone.documentId);
  console.log("Created At:", milestone.createdAt);
});
```

## Use Cases

### Version History

```typescript
// Create milestone on save
async function saveDocument() {
  const milestone = await provider.createMilestone(
    `Version ${Date.now()}`
  );
  console.log("Saved milestone:", milestone.id);
}
```

### Backup

```typescript
// Create periodic backups
setInterval(async () => {
  const milestone = await provider.createMilestone(
    `Backup ${new Date().toISOString()}`
  );
  console.log("Backup created:", milestone.id);
}, 3600000); // Every hour
```

### Restore Point

```typescript
// Create restore point before major changes
const restorePoint = await provider.createMilestone("Before refactor");

// Make changes
// ...

// Restore if needed
if (needsRestore) {
  const snapshot = await provider.getMilestoneSnapshot(restorePoint.id);
  // Apply snapshot to document
}
```

## Error Handling

```typescript
try {
  const milestone = await provider.createMilestone("Checkpoint");
} catch (error) {
  if (error instanceof MilestoneOperationDeniedError) {
    console.error("Permission denied:", error.message);
  } else if (error instanceof MilestoneOperationError) {
    console.error("Operation failed:", error.message);
  }
}
```

## Next Steps

- [Provider Setup](./provider-setup.md) - Learn more about providers
- [Storage](./storage.md) - Learn about milestone storage
