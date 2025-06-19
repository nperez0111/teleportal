# Snapshot Message Types

This document describes the snapshot message types that allow clients and servers to communicate about document snapshots (point-in-time versions of documents).

## Overview

Snapshot messages enable the following functionality:
- **Listing snapshots**: Get metadata for all snapshots of a document
- **Fetching snapshots**: Retrieve a specific snapshot's metadata and content
- **Creating snapshots**: Create a new snapshot of the current document state
- **Reverting to snapshots**: Revert a document to a previous snapshot
- **Event notifications**: Receive notifications when snapshots are created or documents are reverted

## Message Types

### 1. List Snapshots

**Request**: `list-snapshots`
- **Purpose**: Request a list of all snapshots for a document
- **Payload**: Empty (no additional data)

**Response**: `list-snapshots-response`
- **Purpose**: Return list of snapshot metadata
- **Payload**: Array of snapshot objects with `id`, `name`, `createdAt`, and `userId`

### 2. Create Snapshot

**Request**: `snapshot-request`
- **Purpose**: Request creation of a new snapshot
- **Payload**:
  - `name`: Name for the new snapshot
  - `currentSnapshotName`: Name of the current snapshot (for uncommitted changes)

**Event**: `snapshot-created-event`
- **Purpose**: Notify all clients that a new snapshot was created
- **Payload**: Snapshot metadata

### 3. Fetch Snapshot

**Request**: `snapshot-fetch-request`
- **Purpose**: Request a specific snapshot's data
- **Payload**: `snapshotId`: ID of the snapshot to fetch

**Response**: `snapshot-fetch-response`
- **Purpose**: Return snapshot metadata and content
- **Payload**:
  - `snapshot`: Snapshot metadata
  - `content`: Y.js document content as Uint8Array

### 4. Revert to Snapshot

**Request**: `snapshot-revert-request`
- **Purpose**: Request to revert document to a specific snapshot
- **Payload**: `snapshotId`: ID of the snapshot to revert to

**Response**: `snapshot-revert-response`
- **Purpose**: Confirm the revert operation
- **Payload**: Snapshot metadata of the reverted snapshot

**Event**: `snapshot-reverted-event`
- **Purpose**: Notify all clients that document was reverted
- **Payload**:
  - `snapshot`: Snapshot metadata
  - `revertedBy`: User ID who performed the revert

## Snapshot Metadata

All snapshots include the following metadata:

```typescript
type Snapshot = {
  id: number;           // Unique identifier, incremented for each snapshot
  name: string;         // Human-readable name
  createdAt: number;    // Timestamp in milliseconds since Unix epoch
  userId: string;       // ID of user who created the snapshot
};
```

## Usage Examples

### Basic Workflow

```typescript
import {
  encodeSnapshotListMessage,
  encodeSnapshotRequestMessage,
  encodeSnapshotFetchRequestMessage,
  encodeSnapshotRevertRequestMessage,
  decodeMessage,
} from "./protocol";

// 1. List all snapshots
const listRequest = encodeSnapshotListMessage("my-document");
// Send to server...

// 2. Create a new snapshot
const createRequest = encodeSnapshotRequestMessage(
  "my-document",
  "Final version",
  "Current state"
);
// Send to server...

// 3. Fetch a specific snapshot
const fetchRequest = encodeSnapshotFetchRequestMessage("my-document", 2);
// Send to server...

// 4. Revert to a snapshot
const revertRequest = encodeSnapshotRevertRequestMessage("my-document", 1);
// Send to server...
```

### Server-Side Handling

```typescript
import { decodeMessage } from "./protocol";

function handleMessage(encodedMessage: Uint8Array) {
  const message = decodeMessage(encodedMessage);

  if (message.type === "snapshot") {
    const payload = message.payload.payload;

    switch (payload.type) {
      case "list-snapshots":
        // Return list of snapshots
        break;
      case "snapshot-request":
        // Create new snapshot
        break;
      case "snapshot-fetch-request":
        // Return snapshot data
        break;
      case "snapshot-revert-request":
        // Revert document
        break;
    }
  }
}
```

## Protocol Format

Snapshot messages use the same binary format as other protocol messages:

1. **Magic number**: "YJS" (3 bytes)
2. **Version**: 0x01 (1 byte)
3. **Document name**: Variable-length string
4. **Message type**: 0x02 for snapshot messages (1 byte)
5. **Snapshot message type**: Variable-length string
6. **Payload**: Encoded based on message type

## Helper Functions

The protocol provides helper functions for creating encoded messages:

- `encodeSnapshotListMessage(document)`
- `encodeSnapshotListResponseMessage(document, snapshots)`
- `encodeSnapshotRequestMessage(document, name, currentSnapshotName)`
- `encodeSnapshotFetchRequestMessage(document, snapshotId)`
- `encodeSnapshotFetchResponseMessage(document, snapshot, content)`
- `encodeSnapshotRevertRequestMessage(document, snapshotId)`
- `encodeSnapshotRevertResponseMessage(document, snapshot)`
- `encodeSnapshotCreatedEventMessage(document, snapshot)`
- `encodeSnapshotRevertedEventMessage(document, snapshot, revertedBy)`

## Error Handling

All snapshot operations should handle potential errors:

- **Invalid snapshot ID**: Return error for non-existent snapshots
- **Permission denied**: Check user permissions for snapshot operations
- **Storage errors**: Handle database/storage failures gracefully
- **Network errors**: Implement retry logic for failed requests

## Best Practices

1. **Snapshot naming**: Use descriptive names that indicate the state or purpose
2. **Regular snapshots**: Create snapshots at logical points (major changes, milestones)
3. **Cleanup**: Implement snapshot retention policies to manage storage
4. **Validation**: Validate snapshot content before applying reverts
5. **Notifications**: Always send events to keep all clients synchronized
6. **Atomic operations**: Ensure snapshot operations are atomic and consistent
