# Milestone RPC Methods

Milestone CRUD operations via RPC for Y.js document versioning.

## Overview

This package provides RPC methods for managing document milestones (snapshots), enabling:

- Listing milestones
- Retrieving milestone snapshots
- Creating new milestones
- Updating milestone names
- Deleting milestones
- Restoring deleted milestones

## Installation

```typescript
import {
  getServerHandlers,
  type MilestoneListRequest,
  type MilestoneCreateRequest,
  // ... other types
} from "teleportal/protocols/milestone";
```

## Server Integration

```typescript
import { Server } from "teleportal/server";
import { getServerHandlers } from "teleportal/protocols/milestone";

const server = new Server({
  // ... other options
  rpcHandlers: {
    ...getServerHandlers(),
  },
});
```

## Client Integration

The `Provider` automatically handles milestone RPC requests via its `RpcClient`. You can use the built-in methods:

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({ url: "wss://...", document: "my-doc" });

// List milestones
const milestones = await provider.listMilestones();

// Create a milestone
const milestone = await provider.createMilestone("v1.0");

// Get milestone snapshot
const snapshot = await provider.getMilestoneSnapshot(milestone.id);
```

## Methods

### milestoneList

List all milestones for a document.

**Request:**

```typescript
type MilestoneListRequest = {
  snapshotIds?: string[]; // Filter to specific milestones
  includeDeleted?: boolean; // Include deleted milestones
};
```

**Response:**

```typescript
type MilestoneListResponse = {
  milestones: Array<{
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    lifecycleState?: "active" | "deleted" | "archived" | "expired";
    expiresAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  }>;
};
```

### milestoneGet

Retrieve a milestone's snapshot data.

**Request:**

```typescript
type MilestoneGetRequest = {
  milestoneId: string;
};
```

**Response:**

```typescript
type MilestoneGetResponse = {
  milestoneId: string;
  snapshot: Uint8Array; // Y.js document state vector
};
```

### milestoneCreate

Create a new milestone from the current document state.

**Request:**

```typescript
type MilestoneCreateRequest = {
  name?: string; // Optional milestone name
  snapshot: Uint8Array; // Document state vector
};
```

**Response:**

```typescript
type MilestoneCreateResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};
```

### milestoneUpdateName

Update a milestone's name.

**Request:**

```typescript
type MilestoneUpdateNameRequest = {
  milestoneId: string;
  name: string;
};
```

**Response:**

```typescript
type MilestoneUpdateNameResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};
```

### milestoneDelete

Delete a milestone (soft delete).

**Request:**

```typescript
type MilestoneDeleteRequest = {
  milestoneId: string;
};
```

**Response:**

```typescript
type MilestoneDeleteResponse = {
  milestoneId: string;
};
```

### milestoneRestore

Restore a deleted milestone.

**Request:**

```typescript
type MilestoneRestoreRequest = {
  milestoneId: string;
};
```

**Response:**

```typescript
type MilestoneRestoreResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    lifecycleState?: "active" | "deleted" | "archived" | "expired";
    expiresAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};
```

## Storage Interface

Implement `MilestoneStorage` for custom storage backends:

```typescript
export interface MilestoneStorage {
  listMilestones(
    documentId: string,
    options?: { snapshotIds?: string[]; includeDeleted?: boolean },
  ): Promise<
    Array<{
      id: string;
      name: string;
      documentId: string;
      createdAt: number;
      deletedAt?: number;
      lifecycleState?: "active" | "deleted" | "archived" | "expired";
      expiresAt?: number;
      createdBy: { type: "user" | "system"; id: string };
    }>
  >;

  getMilestoneSnapshot(
    documentId: string,
    milestoneId: string,
  ): Promise<Uint8Array | null>;

  createMilestone(
    documentId: string,
    snapshot: Uint8Array,
    name?: string,
    userId?: string,
  ): Promise<{
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  }>;

  updateMilestoneName(
    documentId: string,
    milestoneId: string,
    name: string,
  ): Promise<{
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  }>;

  deleteMilestone(
    documentId: string,
    milestoneId: string,
    userId?: string,
  ): Promise<{ milestoneId: string }>;

  restoreMilestone(
    documentId: string,
    milestoneId: string,
    userId?: string,
  ): Promise<{
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    lifecycleState?: "active" | "deleted" | "archived" | "expired";
    expiresAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  }>;
}
```

## Context

Server handlers receive `RpcServerContext`, which is automatically enriched by the Session when invoking handlers:

```typescript
interface RpcServerContext<Context extends ServerContext = ServerContext> {
  /** The Server instance */
  server: Server<Context>;
  /** The namespaced document ID */
  documentId: string;
  /** The Session instance for this document */
  session: Session<Context>;
  /** User ID from the message context (if authenticated) */
  userId?: string;
  /** Client ID from the message context */
  clientId?: string;
}
```

The `session.storage` property provides access to the `DocumentStorage` for the document.

## Method Names

The RPC methods use the following string names:
- `"milestoneList"` - list milestones for a document
- `"milestoneGet"` - get a milestone snapshot
- `"milestoneCreate"` - create a new milestone
- `"milestoneUpdateName"` - update a milestone's name
- `"milestoneDelete"` - delete a milestone
- `"milestoneRestore"` - restore a deleted milestone

## See Also

- [RPC System](../rpc/README.md) - Core RPC types and handlers
- [Protocols Overview](../README.md) - Package overview
- [File Methods](../file/README.md) - File upload/download RPC methods
