import * as decoding from "lib0/decoding";
import {
  AwarenessMessage,
  type BinaryMessage,
  DocMessage,
  SnapshotMessage,
  type RawReceivedMessage,
} from "./message-types";
import type {
  AwarenessUpdateMessage,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
  SyncStep1,
  SyncStep2,
  UpdateStep,
  SnapshotMessageType,
} from "./types";

/**
 * Decode a Y.js encoded update into a {@link Message}.
 *
 * @param update - The encoded update.
 * @returns The decoded update, which should be considered untrusted at this point.
 */
export function decodeMessage(update: BinaryMessage): RawReceivedMessage {
  try {
    const decoder = decoding.createDecoder(update);
    const [y, j, s] = [
      decoding.readVarUint(decoder),
      decoding.readVarUint(decoder),
      decoding.readVarUint(decoder),
    ];
    if (y !== 0x59 || j !== 0x4a || s !== 0x53) {
      throw new Error("Invalid magic number");
    }
    const version = decoding.readVarUint(decoder);
    if (version !== 0x01) {
      throw new Error("Invalid version");
    }
    const documentName = decoding.readVarString(decoder);

    const targetType = decoding.readVarUint(decoder);

    switch (targetType) {
      case 0x00: {
        return new DocMessage(documentName, decodeDocStepWithDecoder(decoder));
      }
      case 0x01: {
        return new AwarenessMessage(documentName, {
          type: "awareness-update",
          update: decoding.readVarUint8Array(decoder) as AwarenessUpdateMessage,
        });
      }
      case 0x02: {
        const snapshotMessageType = decoding.readVarString(
          decoder,
        ) as SnapshotMessageType["type"];
        const payload = decodeSnapshotPayload(decoder, snapshotMessageType);
        return new SnapshotMessage(documentName, {
          type: snapshotMessageType,
          payload,
        });
      }
      default:
        throw new Error("Invalid target type", {
          cause: { targetType },
        });
    }
  } catch (err) {
    throw new Error("Failed to decode update message", {
      cause: { update, err },
    });
  }
}

/**
 * Decode snapshot message payload based on the message type
 */
function decodeSnapshotPayload(
  decoder: decoding.Decoder,
  messageType: SnapshotMessageType["type"],
): SnapshotMessageType {
  switch (messageType) {
    case "list-snapshots": {
      return { type: "list-snapshots" };
    }
    case "list-snapshots-response": {
      const snapshotsCount = decoding.readVarUint(decoder);
      const snapshots = [];
      for (let i = 0; i < snapshotsCount; i++) {
        snapshots.push({
          id: decoding.readVarUint(decoder),
          name: decoding.readVarString(decoder),
          createdAt: decoding.readVarUint(decoder),
          userId: decoding.readVarString(decoder),
        });
      }
      return {
        type: "list-snapshots-response",
        snapshots,
      };
    }
    case "snapshot-request": {
      return {
        type: "snapshot-request",
        name: decoding.readVarString(decoder),
        currentSnapshotName: decoding.readVarString(decoder),
      };
    }
    case "snapshot-fetch-request": {
      return {
        type: "snapshot-fetch-request",
        snapshotId: decoding.readVarUint(decoder),
      };
    }
    case "snapshot-fetch-response": {
      const snapshot = {
        id: decoding.readVarUint(decoder),
        name: decoding.readVarString(decoder),
        createdAt: decoding.readVarUint(decoder),
        userId: decoding.readVarString(decoder),
      };
      const content = decoding.readVarUint8Array(decoder);
      return {
        type: "snapshot-fetch-response",
        snapshot,
        content,
      };
    }
    case "snapshot-revert-request": {
      return {
        type: "snapshot-revert-request",
        snapshotId: decoding.readVarUint(decoder),
      };
    }
    case "snapshot-revert-response": {
      const snapshot = {
        id: decoding.readVarUint(decoder),
        name: decoding.readVarString(decoder),
        createdAt: decoding.readVarUint(decoder),
        userId: decoding.readVarString(decoder),
      };
      return {
        type: "snapshot-revert-response",
        snapshot,
      };
    }
    case "snapshot-created-event": {
      const snapshot = {
        id: decoding.readVarUint(decoder),
        name: decoding.readVarString(decoder),
        createdAt: decoding.readVarUint(decoder),
        userId: decoding.readVarString(decoder),
      };
      return {
        type: "snapshot-created-event",
        snapshot,
      };
    }
    case "snapshot-reverted-event": {
      const snapshot = {
        id: decoding.readVarUint(decoder),
        name: decoding.readVarString(decoder),
        createdAt: decoding.readVarUint(decoder),
        userId: decoding.readVarString(decoder),
      };
      const revertedBy = decoding.readVarString(decoder);
      return {
        type: "snapshot-reverted-event",
        snapshot,
        revertedBy,
      };
    }
    default: {
      throw new Error("Invalid snapshot message type", {
        cause: { messageType },
      });
    }
  }
}

function decodeDocStepWithDecoder<
  D extends DocStep,
  E = D extends SyncStep1
    ? DecodedSyncStep1
    : D extends SyncStep2
      ? DecodedSyncStep2
      : D extends UpdateStep
        ? DecodedUpdateStep
        : never,
>(decoder: decoding.Decoder): E {
  try {
    const messageType = decoding.readUint8(decoder);
    switch (messageType) {
      case 0x00: {
        return {
          type: "sync-step-1",
          sv: decoding.readVarUint8Array(decoder),
        } as E;
      }
      case 0x01: {
        return {
          type: "sync-step-2",
          update: decoding.readVarUint8Array(decoder),
        } as E;
      }
      case 0x02: {
        return {
          type: "update",
          update: decoding.readVarUint8Array(decoder),
        } as E;
      }
      default: {
        throw new Error(`Failed to decode doc update, unexpected value`, {
          cause: { messageType },
        });
      }
    }
  } catch (err) {
    throw new Error("Failed to decode doc step", {
      cause: { err },
    });
  }
}

/**
 * Decodes a doc step, this is compatible with the y-protocols implementation.
 */
export function decodeDocStep<
  D extends DocStep,
  E = D extends SyncStep1
    ? DecodedSyncStep1
    : D extends SyncStep2
      ? DecodedSyncStep2
      : D extends UpdateStep
        ? DecodedUpdateStep
        : never,
>(update: D): E {
  const decoder = decoding.createDecoder(update);
  return decodeDocStepWithDecoder(decoder);
}
