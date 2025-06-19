import {
  decodeMessage,
  encodeSnapshotListMessage,
  encodeSnapshotListResponseMessage,
  encodeSnapshotRequestMessage,
  encodeSnapshotFetchRequestMessage,
  encodeSnapshotFetchResponseMessage,
  encodeSnapshotRevertRequestMessage,
  encodeSnapshotRevertResponseMessage,
  encodeSnapshotCreatedEventMessage,
  encodeSnapshotRevertedEventMessage,
  type BinaryMessage,
} from "./index";

/**
 * Example usage of snapshot message types for client-server communication
 */

// Example 1: Client requests list of snapshots
export function exampleListSnapshots() {
  const documentName = "my-document";

  // Client sends request
  const listRequest = encodeSnapshotListMessage(documentName) as BinaryMessage;
  console.log("Client sends list request:", listRequest);

  // Server responds with snapshot list
  const snapshots = [
    {
      id: 1,
      name: "Initial version",
      createdAt: Date.now() - 86400000, // 1 day ago
      userId: "user1",
    },
    {
      id: 2,
      name: "After major changes",
      createdAt: Date.now() - 3600000, // 1 hour ago
      userId: "user2",
    },
  ];

  const listResponse = encodeSnapshotListResponseMessage(
    documentName,
    snapshots,
  ) as BinaryMessage;
  console.log("Server sends list response:", listResponse);

  // Client decodes response
  const decodedResponse = decodeMessage(listResponse);
  if (decodedResponse.type === "snapshot") {
    console.log("Decoded snapshots:", decodedResponse.payload.payload);
  }
}

// Example 2: Client creates a new snapshot
export function exampleCreateSnapshot() {
  const documentName = "my-document";
  const snapshotName = "Final version";
  const currentSnapshotName = "After major changes";

  // Client sends snapshot request
  const snapshotRequest = encodeSnapshotRequestMessage(
    documentName,
    snapshotName,
    currentSnapshotName,
  ) as BinaryMessage;
  console.log("Client sends snapshot request:", snapshotRequest);

  // Server creates snapshot and sends event
  const newSnapshot = {
    id: 3,
    name: snapshotName,
    createdAt: Date.now(),
    userId: "user1",
  };

  const createdEvent = encodeSnapshotCreatedEventMessage(
    documentName,
    newSnapshot,
  ) as BinaryMessage;
  console.log("Server sends created event:", createdEvent);
}

// Example 3: Client fetches a specific snapshot
export function exampleFetchSnapshot() {
  const documentName = "my-document";
  const snapshotId = 2;

  // Client sends fetch request
  const fetchRequest = encodeSnapshotFetchRequestMessage(
    documentName,
    snapshotId,
  ) as BinaryMessage;
  console.log("Client sends fetch request:", fetchRequest);

  // Server responds with snapshot data
  const snapshot = {
    id: 2,
    name: "After major changes",
    createdAt: Date.now() - 3600000,
    userId: "user2",
  };

  // Mock Y.js document content
  const content = new Uint8Array([1, 2, 3, 4, 5]);

  const fetchResponse = encodeSnapshotFetchResponseMessage(
    documentName,
    snapshot,
    content,
  ) as BinaryMessage;
  console.log("Server sends fetch response:", fetchResponse);

  // Client decodes response
  const decodedResponse = decodeMessage(fetchResponse);
  if (decodedResponse.type === "snapshot") {
    const payload = decodedResponse.payload.payload;
    if (payload.type === "snapshot-fetch-response") {
      console.log("Snapshot metadata:", payload.snapshot);
      console.log("Snapshot content:", payload.content);
    }
  }
}

// Example 4: Client reverts to a snapshot
export function exampleRevertToSnapshot() {
  const documentName = "my-document";
  const snapshotId = 1;
  const userId = "user1";

  // Client sends revert request
  const revertRequest = encodeSnapshotRevertRequestMessage(
    documentName,
    snapshotId,
  ) as BinaryMessage;
  console.log("Client sends revert request:", revertRequest);

  // Server processes revert and sends response
  const snapshot = {
    id: 1,
    name: "Initial version",
    createdAt: Date.now() - 86400000,
    userId: "user1",
  };

  const revertResponse = encodeSnapshotRevertResponseMessage(
    documentName,
    snapshot,
  ) as BinaryMessage;
  console.log("Server sends revert response:", revertResponse);

  // Server also sends event to all clients
  const revertedEvent = encodeSnapshotRevertedEventMessage(
    documentName,
    snapshot,
    userId,
  ) as BinaryMessage;
  console.log("Server sends reverted event:", revertedEvent);
}

// Example 5: Complete workflow
export function exampleCompleteWorkflow() {
  console.log("=== Snapshot Workflow Example ===");

  // 1. List snapshots
  exampleListSnapshots();

  // 2. Create new snapshot
  exampleCreateSnapshot();

  // 3. Fetch specific snapshot
  exampleFetchSnapshot();

  // 4. Revert to snapshot
  exampleRevertToSnapshot();

  console.log("=== Workflow Complete ===");
}

exampleCompleteWorkflow();
