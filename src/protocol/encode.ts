import * as encoding from "lib0/encoding";
import {
  type BinaryMessage,
  DocMessage,
  type Message,
  SnapshotMessage,
} from "./message-types";
import type {
  DocStep,
  EncodedDocUpdateMessage,
  StateVector,
  SyncStep1,
  SyncStep2,
  Update,
  UpdateStep,
} from "./types";

/**
 * Encode a {@link Message} into a {@link Uint8Array}.
 *
 * @param update - The encoded update.
 * @returns The encoded update.
 */
export function encodeMessage(update: Message): BinaryMessage {
  try {
    const encoder = encoding.createEncoder();
    // Y
    encoding.writeUint8(encoder, 0x59);
    // J
    encoding.writeUint8(encoder, 0x4a);
    // S
    encoding.writeUint8(encoder, 0x53);
    // version
    encoding.writeUint8(encoder, 0x01);
    // document name
    encoding.writeVarString(encoder, update.document);

    switch (update.type) {
      case "awareness": {
        // message type
        encoding.writeUint8(encoder, 1);
        // awareness update
        encoding.writeVarUint8Array(encoder, update.payload.update);
        break;
      }
      case "doc": {
        // message type
        encoding.writeUint8(encoder, 0);
        switch (update.payload.type) {
          case "sync-step-1": {
            // message type
            encoding.writeUint8(encoder, 0);
            // state vector
            encoding.writeVarUint8Array(encoder, update.payload.sv);
            break;
          }
          case "update":
          case "sync-step-2": {
            // message type
            encoding.writeUint8(
              encoder,
              update.payload.type === "sync-step-2" ? 1 : 2,
            );
            // update
            encoding.writeVarUint8Array(encoder, update.payload.update);
            break;
          }
          default: {
            throw new Error("Invalid doc.payload.type", {
              cause: { update },
            });
          }
        }
        break;
      }
      case "snapshot": {
        // message type
        encoding.writeUint8(encoder, 2);
        // snapshot message type
        encoding.writeVarString(encoder, update.payload.payload.type);
        // encode snapshot message payload based on type
        encodeSnapshotPayload(encoder, update.payload.payload);
        break;
      }
      default: {
        throw new Error("Invalid update type", {
          cause: { update },
        });
      }
    }

    return encoding.toUint8Array(encoder) as BinaryMessage;
  } catch (err) {
    console.error(err);
    throw new Error("Failed to encode message", {
      cause: { update, err },
    });
  }
}

/**
 * Encode snapshot message payload based on the message type
 */
function encodeSnapshotPayload(encoder: encoding.Encoder, payload: any): void {
  switch (payload.type) {
    case "list-snapshots": {
      // No additional data needed
      break;
    }
    case "list-snapshots-response": {
      encoding.writeVarUint(encoder, payload.snapshots.length);
      for (const snapshot of payload.snapshots) {
        encoding.writeVarUint(encoder, snapshot.id);
        encoding.writeVarString(encoder, snapshot.name);
        encoding.writeVarUint(encoder, snapshot.createdAt);
        encoding.writeVarString(encoder, snapshot.userId);
      }
      break;
    }
    case "snapshot-request": {
      encoding.writeVarString(encoder, payload.name);
      encoding.writeVarString(encoder, payload.currentSnapshotName);
      break;
    }
    case "snapshot-fetch-request": {
      encoding.writeVarUint(encoder, payload.snapshotId);
      break;
    }
    case "snapshot-fetch-response": {
      // Encode snapshot metadata
      encoding.writeVarUint(encoder, payload.snapshot.id);
      encoding.writeVarString(encoder, payload.snapshot.name);
      encoding.writeVarUint(encoder, payload.snapshot.createdAt);
      encoding.writeVarString(encoder, payload.snapshot.userId);
      // Encode snapshot content
      encoding.writeVarUint8Array(encoder, payload.content);
      break;
    }
    case "snapshot-revert-request": {
      encoding.writeVarUint(encoder, payload.snapshotId);
      break;
    }
    case "snapshot-revert-response": {
      // Encode snapshot metadata
      encoding.writeVarUint(encoder, payload.snapshot.id);
      encoding.writeVarString(encoder, payload.snapshot.name);
      encoding.writeVarUint(encoder, payload.snapshot.createdAt);
      encoding.writeVarString(encoder, payload.snapshot.userId);
      break;
    }
    case "snapshot-created-event": {
      // Encode snapshot metadata
      encoding.writeVarUint(encoder, payload.snapshot.id);
      encoding.writeVarString(encoder, payload.snapshot.name);
      encoding.writeVarUint(encoder, payload.snapshot.createdAt);
      encoding.writeVarString(encoder, payload.snapshot.userId);
      break;
    }
    case "snapshot-reverted-event": {
      // Encode snapshot metadata
      encoding.writeVarUint(encoder, payload.snapshot.id);
      encoding.writeVarString(encoder, payload.snapshot.name);
      encoding.writeVarUint(encoder, payload.snapshot.createdAt);
      encoding.writeVarString(encoder, payload.snapshot.userId);
      // Encode who performed the revert
      encoding.writeVarString(encoder, payload.revertedBy);
      break;
    }
    default: {
      throw new Error("Invalid snapshot message type", {
        cause: { payload },
      });
    }
  }
}

/**
 * Serialize a sync step 1 update.
 */
export function encodeSyncStep1Message(
  document: string,
  payload: StateVector,
): EncodedDocUpdateMessage<SyncStep1> {
  return new DocMessage(document, {
    type: "sync-step-1",
    sv: payload,
  }).encoded as EncodedDocUpdateMessage<SyncStep1>;
}

/**
 * Serialize a sync step 2 update.
 */
export function encodeSyncStep2Message(
  document: string,
  payload: Update,
): EncodedDocUpdateMessage<SyncStep2> {
  return new DocMessage(document, {
    type: "sync-step-2",
    update: payload,
  }).encoded as EncodedDocUpdateMessage<SyncStep2>;
}

/**
 * Serialize an update message.
 */
export function encodeUpdateStepMessage(
  document: string,
  payload: Update,
): EncodedDocUpdateMessage<UpdateStep> {
  return new DocMessage(document, {
    type: "update",
    update: payload,
  }).encoded as EncodedDocUpdateMessage<UpdateStep>;
}

/**
 * Serialize a doc step, this is compatible with the y-protocols implementation.
 */
export function encodeDocStep<
  T extends 0 | 1 | 2 | "sync-step-1" | "sync-step-2" | "update",
  S extends DocStep = T extends 0 | "sync-step-1"
    ? SyncStep1
    : T extends 1 | "sync-step-2"
      ? SyncStep2
      : T extends 2 | "update"
        ? UpdateStep
        : never,
>(messageType: T, payload: S extends SyncStep1 ? StateVector : Update): S {
  try {
    const encoder = encoding.createEncoder();
    let messageTypeNumber: 0 | 1 | 2;
    switch (messageType) {
      case 0x00:
      case 0x01:
      case 0x02:
        messageTypeNumber = messageType;
        break;
      case "sync-step-1":
        messageTypeNumber = 0x00;
        break;
      case "sync-step-2":
        messageTypeNumber = 0x01;
        break;
      case "update":
        messageTypeNumber = 0x02;
        break;
      default:
        throw new Error("Invalid message type", {
          cause: { messageType },
        });
    }
    encoding.writeUint8(encoder, messageTypeNumber);
    encoding.writeVarUint8Array(encoder, payload);

    return encoding.toUint8Array(encoder) as S;
  } catch (err) {
    throw new Error("Failed to encode doc step", {
      cause: { messageType, payload, err },
    });
  }
}

/**
 * Serialize a snapshot list request message.
 */
export function encodeSnapshotListMessage(document: string): Uint8Array {
  return new SnapshotMessage(document, {
    type: "list-snapshots",
    payload: { type: "list-snapshots" },
  }).encoded;
}

/**
 * Serialize a snapshot list response message.
 */
export function encodeSnapshotListResponseMessage(
  document: string,
  snapshots: Array<{
    id: number;
    name: string;
    createdAt: number;
    userId: string;
  }>,
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "list-snapshots-response",
    payload: {
      type: "list-snapshots-response",
      snapshots,
    },
  }).encoded;
}

/**
 * Serialize a snapshot request message.
 */
export function encodeSnapshotRequestMessage(
  document: string,
  name: string,
  currentSnapshotName: string,
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "snapshot-request",
    payload: {
      type: "snapshot-request",
      name,
      currentSnapshotName,
    },
  }).encoded;
}

/**
 * Serialize a snapshot fetch request message.
 */
export function encodeSnapshotFetchRequestMessage(
  document: string,
  snapshotId: number,
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "snapshot-fetch-request",
    payload: {
      type: "snapshot-fetch-request",
      snapshotId,
    },
  }).encoded;
}

/**
 * Serialize a snapshot fetch response message.
 */
export function encodeSnapshotFetchResponseMessage(
  document: string,
  snapshot: {
    id: number;
    name: string;
    createdAt: number;
    userId: string;
  },
  content: Uint8Array,
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "snapshot-fetch-response",
    payload: {
      type: "snapshot-fetch-response",
      snapshot,
      content,
    },
  }).encoded;
}

/**
 * Serialize a snapshot revert request message.
 */
export function encodeSnapshotRevertRequestMessage(
  document: string,
  snapshotId: number,
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "snapshot-revert-request",
    payload: {
      type: "snapshot-revert-request",
      snapshotId,
    },
  }).encoded;
}

/**
 * Serialize a snapshot revert response message.
 */
export function encodeSnapshotRevertResponseMessage(
  document: string,
  snapshot: {
    id: number;
    name: string;
    createdAt: number;
    userId: string;
  },
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "snapshot-revert-response",
    payload: {
      type: "snapshot-revert-response",
      snapshot,
    },
  }).encoded;
}

/**
 * Serialize a snapshot created event message.
 */
export function encodeSnapshotCreatedEventMessage(
  document: string,
  snapshot: {
    id: number;
    name: string;
    createdAt: number;
    userId: string;
  },
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "snapshot-created-event",
    payload: {
      type: "snapshot-created-event",
      snapshot,
    },
  }).encoded;
}

/**
 * Serialize a snapshot reverted event message.
 */
export function encodeSnapshotRevertedEventMessage(
  document: string,
  snapshot: {
    id: number;
    name: string;
    createdAt: number;
    userId: string;
  },
  revertedBy: string,
): Uint8Array {
  return new SnapshotMessage(document, {
    type: "snapshot-reverted-event",
    payload: {
      type: "snapshot-reverted-event",
      snapshot,
      revertedBy,
    },
  }).encoded;
}
