# Milestone Protocol

Milestone CRUD operations via RPC for Y.js document versioning.

## Overview

This protocol provides RPC methods for managing document milestones (snapshots):

- Listing milestones
- Retrieving milestone snapshots
- Creating new milestones
- Updating milestone names
- Deleting milestones (soft delete)
- Restoring deleted milestones

## File Structure

```
src/protocols/milestone/
  methods.ts   — method contracts (defineMethod/defineProtocol) + request/response types
  server.ts    — server handlers (createHandlers)
  client.ts    — client extension (createClientExtension)
  index.ts     — public exports
```

## Server Integration

```typescript
import { Server } from "teleportal/server";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";

const server = new Server({
  storage: async () => documentStorage,
  rpcHandlers: {
    ...getMilestoneRpcHandlers(milestoneStorage),
  },
});
```

### Automatic Milestones (Triggers)

The server handlers support automatic milestone creation via triggers:

```typescript
const server = new Server({
  storage: async () => documentStorage,
  rpcHandlers: {
    ...getMilestoneRpcHandlers(milestoneStorage, {
      triggers: [
        { id: "every-100", type: "update-count", enabled: true, config: { updateCount: 100 } },
        { id: "hourly", type: "time-based", enabled: true, config: { interval: 3600000 } },
      ],
      onMilestoneCreated: (milestoneId, documentId) => {
        console.log(`Auto-milestone ${milestoneId} for ${documentId}`);
      },
    }),
  },
});
```

## Client Integration

```typescript
import { Provider } from "teleportal/providers";
import { createMilestoneRpc } from "teleportal/protocols/milestone";
import { createEncryptionKey } from "teleportal/encryption-key";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  encryptionKey: await createEncryptionKey(),
  rpc: {
    milestones: createMilestoneRpc,
  },
});

const milestones = await provider.rpc.milestones.list();
const milestone = await provider.rpc.milestones.create("v1.0");
const snapshot = await provider.rpc.milestones.getSnapshot(milestone.id);
```

## Contract

The protocol contract is defined in `methods.ts` using `defineMethod`/`defineProtocol` from `teleportal/rpc`. All six methods use type-first definitions (no schema validation, since payloads include binary `Uint8Array` snapshots):

```typescript
import { milestoneProtocol } from "teleportal/protocols/milestone";

// milestoneProtocol.methods:
//   list       → wire name "milestoneList"
//   get        → wire name "milestoneGet"
//   create     → wire name "milestoneCreate"
//   updateName → wire name "milestoneUpdateName"
//   delete     → wire name "milestoneDelete"
//   restore    → wire name "milestoneRestore"
```

## Encryption (E2EE)

For end-to-end-encrypted documents (a `Provider` created with an `encryptionKey`),
`create` encrypts the snapshot before it leaves the client, wrapping it in the same
content-encrypted payload format the server uses for automatic milestones. `getSnapshot`
decrypts the payload back into a single plaintext Y.js update.

Server-generated automatic milestones store the document's existing encrypted payload
and `getSnapshot` decrypts them through the same path — so both client-created and
automatic milestones work identically on E2EE documents.

## Error Handling

All client methods throw `RpcOperationError` (from `teleportal/rpc`) on failure:

```typescript
import { RpcOperationError } from "teleportal/rpc";

try {
  await provider.rpc.milestones.create("v1");
} catch (error) {
  if (error instanceof RpcOperationError) {
    console.log(error.protocol); // "milestone"
    console.log(error.operation); // "create"
    console.log(error.cause); // underlying RPC error
  }
}
```

## Methods

### milestoneList

List all milestones for a document.

**Request:** `{ snapshotIds?: string[]; includeDeleted?: boolean }`

**Response:** `{ milestones: MilestoneMetaFull[] }`

### milestoneGet

Retrieve a milestone's snapshot data.

**Request:** `{ milestoneId: string }`

**Response:** `{ milestoneId: string; snapshot: Uint8Array }`

### milestoneCreate

Create a new milestone from the current document state.

**Request:** `{ name?: string; snapshot: Uint8Array }`

**Response:** `{ milestone: MilestoneMeta }`

### milestoneUpdateName

Update a milestone's name.

**Request:** `{ milestoneId: string; name: string }`

**Response:** `{ milestone: MilestoneMeta }`

### milestoneDelete

Delete a milestone (soft delete).

**Request:** `{ milestoneId: string }`

**Response:** `{ milestoneId: string }`

### milestoneRestore

Restore a deleted milestone.

**Request:** `{ milestoneId: string }`

**Response:** `{ milestone: MilestoneMetaFull }`

## See Also

- [`teleportal/rpc`](../../lib/rpc/) — RPC framework primitives
- [Attribution Protocol](../attribution/README.md) — Attribution (authorship) methods
- [File Protocol](../file/README.md) — File upload/download methods
