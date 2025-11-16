import { toBase64 } from "lib0/buffer";
import * as decoding from "lib0/decoding";
import {
  AckMessage,
  AwarenessMessage,
  FileMessage,
  type BinaryMessage,
  DocMessage,
  type RawReceivedMessage,
} from "./message-types";
import type {
  AuthMessage,
  AwarenessRequestMessage,
  AwarenessStep,
  AwarenessUpdateMessage,
  DecodedAckMessage,
  DecodedAuthMessage,
  DecodedAwarenessRequest,
  DecodedAwarenessUpdateMessage,
  DecodedFileProgress,
  DecodedFileRequest,
  DecodedSyncDone,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
  SyncDone,
  SyncStep1,
  SyncStep2,
  UpdateStep,
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

    const encrypted = decoding.readUint8(decoder) === 1;

    const targetType = decoding.readVarUint(decoder);

    switch (targetType) {
      case 0x00: {
        return new DocMessage(
          documentName,
          decodeDocStepWithDecoder(decoder),
          undefined,
          encrypted,
          update,
        );
      }
      case 0x01: {
        return new AwarenessMessage(
          documentName,
          decodeAwarenessStepWithDecoder(decoder),
          undefined,
          encrypted,
          update,
        );
      }
      case 0x02: {
        return new AckMessage(
          documentName,
          decodeAckMessageWithDecoder(decoder),
          undefined,
        );
      }
        case 0x03: {
          return new FileMessage(
            decodeFileStepWithDecoder(decoder),
            undefined,
            encrypted,
            update,
          );
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

function decodeDocStepWithDecoder<
  D extends DocStep,
  E = D extends SyncStep1
    ? DecodedSyncStep1
    : D extends SyncStep2
      ? DecodedSyncStep2
      : D extends SyncDone
        ? DecodedSyncDone
        : D extends UpdateStep
          ? DecodedUpdateStep
          : D extends AuthMessage
            ? DecodedAuthMessage
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
      case 0x03: {
        return {
          type: "sync-done",
        } as E;
      }
      case 0x04: {
        return {
          type: "auth-message",
          permission: decoding.readUint8(decoder) === 0 ? "denied" : "allowed",
          reason: decoding.readVarString(decoder),
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

function decodeAwarenessStepWithDecoder<
  D extends AwarenessStep,
  E = D extends AwarenessUpdateMessage
    ? DecodedAwarenessUpdateMessage
    : D extends AwarenessRequestMessage
      ? DecodedAwarenessRequest
      : never,
>(decoder: decoding.Decoder): E {
  try {
    const messageType = decoding.readUint8(decoder);
    switch (messageType) {
      case 0x00: {
        return {
          type: "awareness-update",
          update: decoding.readVarUint8Array(decoder),
        } as E;
      }
      case 0x01: {
        return {
          type: "awareness-request",
        } as E;
      }
      default: {
        throw new Error(`Failed to decode doc update, unexpected value`, {
          cause: { messageType },
        });
      }
    }
  } catch (err) {
    throw new Error("Failed to decode awareness step", {
      cause: { err },
    });
  }
}

function decodeFileStepWithDecoder(
  decoder: decoding.Decoder,
): DecodedFileRequest | DecodedFileProgress {
  try {
    const messageType = decoding.readUint8(decoder);
    switch (messageType) {
      case 0x00: {
        const direction = decoding.readUint8(decoder) === 0 ? "upload" : "download";
        const fileId = decoding.readVarString(decoder);
        const filename = decoding.readVarString(decoder);
        const size = decoding.readVarUint(decoder);
        const mimeType = decoding.readVarString(decoder);
        const hasContentId = decoding.readUint8(decoder) === 1;
        const contentId = hasContentId
          ? decoding.readVarUint8Array(decoder)
          : undefined;
        const hasStatus = decoding.readUint8(decoder) === 1;
        let status: "accepted" | "rejected" | undefined;
        let reason: string | undefined;
        if (hasStatus) {
          status = decoding.readUint8(decoder) === 0 ? "accepted" : "rejected";
          const hasReason = decoding.readUint8(decoder) === 1;
          if (hasReason) {
            reason = decoding.readVarString(decoder);
          }
        }
        const hasResume = decoding.readUint8(decoder) === 1;
        const resumeFromChunk = hasResume ? decoding.readVarUint(decoder) : undefined;
        const hasBytes = decoding.readUint8(decoder) === 1;
        const bytesUploaded = hasBytes ? decoding.readVarUint(decoder) : undefined;
        const isEncrypted = decoding.readUint8(decoder) === 1;
        const result: DecodedFileRequest = {
          type: "file-request",
          direction,
          fileId,
          filename,
          size,
          mimeType,
          contentId,
          status,
          reason,
          resumeFromChunk,
          bytesUploaded,
          encrypted: isEncrypted || undefined,
        };
        return result;
      }
      case 0x01: {
        const fileId = decoding.readVarString(decoder);
        const chunkIndex = decoding.readVarUint(decoder);
        const totalChunks = decoding.readVarUint(decoder);
        const bytesUploaded = decoding.readVarUint(decoder);
        const encrypted = decoding.readUint8(decoder) === 1;
        const chunkData = decoding.readVarUint8Array(decoder);
        const proofLength = decoding.readVarUint(decoder);
        const merkleProof: Uint8Array[] = [];
        for (let i = 0; i < proofLength; i++) {
          merkleProof.push(decoding.readVarUint8Array(decoder));
        }
        const result: DecodedFileProgress = {
          type: "file-progress",
          fileId,
          chunkIndex,
          chunkData,
          merkleProof,
          totalChunks,
          bytesUploaded,
          encrypted,
        };
        return result;
      }
      default: {
        throw new Error("Failed to decode file message, unexpected subtype", {
          cause: { messageType },
        });
      }
    }
  } catch (err) {
    throw new Error("Failed to decode file step", {
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
      : D extends SyncDone
        ? DecodedSyncDone
        : D extends UpdateStep
          ? DecodedUpdateStep
          : D extends AuthMessage
            ? DecodedAuthMessage
            : never,
>(update: D): E {
  const decoder = decoding.createDecoder(update);
  return decodeDocStepWithDecoder(decoder);
}

function decodeAckMessageWithDecoder(
  decoder: decoding.Decoder,
): DecodedAckMessage {
  return {
    type: "ack",
    messageId: toBase64(decoding.readVarUint8Array(decoder)),
  };
}
