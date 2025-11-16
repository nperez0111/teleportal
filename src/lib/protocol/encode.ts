import { fromBase64 } from "lib0/buffer";
import * as encoding from "lib0/encoding";
import { type BinaryMessage, type Message } from "./message-types";
import type {
  DocStep,
  StateVector,
  SyncDone,
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
    // document name (empty string for file messages)
    encoding.writeVarString(encoder, update.document ?? "");

    // encrypted or not
    encoding.writeUint8(encoder, update.encrypted ? 1 : 0);

    switch (update.type) {
      case "awareness": {
        // message type (doc/awareness)
        encoding.writeUint8(encoder, 1);

        switch (update.payload.type) {
          case "awareness-update": {
            // message type
            encoding.writeUint8(encoder, 0);
            // awareness update
            encoding.writeVarUint8Array(encoder, update.payload.update);
            break;
          }
          case "awareness-request": {
            // message type
            encoding.writeUint8(encoder, 1);
            break;
          }
          default: {
            // @ts-expect-error - this should be unreachable due to type checking
            update.payload.type;
            throw new Error("Invalid update.payload.type", {
              cause: { update },
            });
          }
        }
        break;
      }
      case "doc": {
        // message type (doc/awareness)
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
          case "sync-done": {
            // message type
            encoding.writeUint8(encoder, 3);
            break;
          }
          case "auth-message": {
            // message type
            encoding.writeUint8(encoder, 4);
            // permission
            encoding.writeUint8(
              encoder,
              update.payload.permission === "denied" ? 0 : 1,
            );
            // reason
            encoding.writeVarString(encoder, update.payload.reason);
            break;
          }
          default: {
            // @ts-expect-error - this should be unreachable due to type checking
            update.payload.type;
            throw new Error("Invalid doc.payload.type", {
              cause: { update },
            });
          }
        }
        break;
      }
      case "ack": {
        // message type (doc/awareness)
        encoding.writeUint8(encoder, 2);
        // message id
        encoding.writeVarUint8Array(
          encoder,
          fromBase64(update.payload.messageId),
        );
        break;
      }
      case "file": {
        // message type (doc/awareness/file)
        encoding.writeUint8(encoder, 3);

        switch (update.payload.type) {
          case "file-request": {
            // file message type
            encoding.writeUint8(encoder, 0);
            // direction (0=upload, 1=download)
            encoding.writeUint8(
              encoder,
              update.payload.direction === "upload" ? 0 : 1,
            );
            // fileId (UUID string)
            encoding.writeVarString(encoder, update.payload.fileId);
            // filename
            encoding.writeVarString(encoder, update.payload.filename);
            // size
            encoding.writeVarUint(encoder, update.payload.size);
            // mimeType
            encoding.writeVarString(encoder, update.payload.mimeType);
            // contentId (optional, only for downloads)
            if (update.payload.contentId) {
              encoding.writeUint8(encoder, 1); // has contentId
              encoding.writeVarUint8Array(encoder, update.payload.contentId);
            } else {
              encoding.writeUint8(encoder, 0); // no contentId
            }
            break;
          }
          case "file-progress": {
            // file message type
            encoding.writeUint8(encoder, 1);
            // fileId (UUID string)
            encoding.writeVarString(encoder, update.payload.fileId);
            // chunkIndex
            encoding.writeVarUint(encoder, update.payload.chunkIndex);
            // chunkData
            encoding.writeVarUint8Array(encoder, update.payload.chunkData);
            // merkleProof array length
            encoding.writeVarUint(encoder, update.payload.merkleProof.length);
            // merkleProof array items
            for (const proofHash of update.payload.merkleProof) {
              encoding.writeVarUint8Array(encoder, proofHash);
            }
            // totalChunks
            encoding.writeVarUint(encoder, update.payload.totalChunks);
            // bytesUploaded
            encoding.writeVarUint(encoder, update.payload.bytesUploaded);
            // encrypted flag
            encoding.writeUint8(encoder, update.payload.encrypted ? 1 : 0);
            break;
          }
          default: {
            // @ts-expect-error - this should be unreachable due to type checking
            update.payload.type;
            throw new Error("Invalid file payload type", {
              cause: { update },
            });
          }
        }
        break;
      }
      default: {
        // @ts-expect-error - this should be unreachable due to type checking
        update.type;
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
 * Serialize a doc step, this is compatible with the y-protocols implementation.
 */
export function encodeDocStep<
  T extends
    | 0
    | 1
    | 2
    | 3
    | "sync-step-1"
    | "sync-step-2"
    | "sync-done"
    | "update",
  S extends DocStep = T extends 0 | "sync-step-1"
    ? SyncStep1
    : T extends 1 | "sync-step-2"
      ? SyncStep2
      : T extends 2 | "update"
        ? UpdateStep
        : T extends 3 | "sync-done"
          ? SyncDone
          : never,
>(
  messageType: T,
  payload: S extends SyncStep1
    ? StateVector
    : S extends SyncDone
      ? undefined
      : Update,
): S {
  try {
    const encoder = encoding.createEncoder();
    let messageTypeNumber: 0 | 1 | 2 | 3;
    switch (messageType) {
      case 0x00:
      case 0x01:
      case 0x02:
      case 0x03:
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
      case "sync-done":
        messageTypeNumber = 0x03;
        break;
      default:
        throw new Error("Invalid message type", {
          cause: { messageType },
        });
    }
    encoding.writeUint8(encoder, messageTypeNumber);
    if (payload !== undefined) {
      encoding.writeVarUint8Array(encoder, payload);
    }

    return encoding.toUint8Array(encoder) as S;
  } catch (err) {
    throw new Error("Failed to encode doc step", {
      cause: { messageType, payload, err },
    });
  }
}
