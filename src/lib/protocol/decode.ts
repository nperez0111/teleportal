import { toBase64 } from "lib0/buffer";
import * as decoding from "lib0/decoding";
import {
  AckMessage,
  AwarenessMessage,
  type BinaryMessage,
  DocMessage,
  FileMessage,
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
  DecodedFileAuthMessage,
  DecodedFileDownload,
  DecodedFilePart,
  DecodedFileUpload,
  DecodedSyncDone,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
  EncodedDocUpdateMessage,
  EncodedFileStep,
  FileStep,
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
          update as EncodedDocUpdateMessage<DocStep>,
        );
      }
      case 0x01: {
        return new AwarenessMessage(
          documentName,
          decodeAwarenessStepWithDecoder(decoder),
          undefined,
          encrypted,
          update as AwarenessUpdateMessage | AwarenessRequestMessage,
        );
      }
      case 0x02: {
        return new AckMessage(decodeAckMessageWithDecoder(decoder), undefined);
      }
      case 0x03: {
        return new FileMessage(
          documentName,
          decodeFileStepWithDecoder(decoder),
          undefined,
          encrypted,
          update as EncodedFileStep<FileStep>,
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
          : D extends AttributionRequestMessage
            ? DecodedAttributionRequest
            : D extends AttributionResponseMessage
              ? DecodedAttributionResponse
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
      case 0x05: {
        return {
          type: "attribution-request",
        } as E;
      }
      case 0x06: {
        return {
          type: "attribution-response",
          attributions: decoding.readVarUint8Array(decoder),
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
          : D extends AttributionRequestMessage
            ? DecodedAttributionRequest
            : D extends AttributionResponseMessage
              ? DecodedAttributionResponse
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

function decodeFileStepWithDecoder(
  decoder: decoding.Decoder,
):
  | DecodedFileDownload
  | DecodedFileUpload
  | DecodedFilePart
  | DecodedFileAuthMessage {
  try {
    const messageType = decoding.readUint8(decoder);
    switch (messageType) {
      case 0x00: {
        // file-download
        const fileId = decoding.readVarString(decoder);
        return {
          type: "file-download",
          fileId,
        };
      }
      case 0x01: {
        // file-upload
        const encrypted = decoding.readUint8(decoder) === 1;
        const fileId = decoding.readVarString(decoder);
        const filename = decoding.readVarString(decoder);
        const size = decoding.readVarUint(decoder);
        const mimeType = decoding.readVarString(decoder);
        const lastModified = decoding.readVarUint(decoder);

        return {
          type: "file-upload",
          fileId,
          filename,
          size,
          mimeType,
          lastModified,
          encrypted,
        };
      }
      case 0x02: {
        // file-part
        const fileId = decoding.readVarString(decoder);
        const chunkIndex = decoding.readVarUint(decoder);
        const chunkData = decoding.readVarUint8Array(decoder);
        const merkleProofLength = decoding.readVarUint(decoder);
        const merkleProof: Uint8Array[] = [];
        for (let i = 0; i < merkleProofLength; i++) {
          merkleProof.push(decoding.readVarUint8Array(decoder));
        }
        const totalChunks = decoding.readVarUint(decoder);
        const bytesUploaded = decoding.readVarUint(decoder);
        const encrypted = decoding.readUint8(decoder) === 1;

        return {
          type: "file-part",
          fileId,
          chunkIndex,
          chunkData,
          merkleProof,
          totalChunks,
          bytesUploaded,
          encrypted,
        };
      }
      case 0x03: {
        const permission =
          decoding.readUint8(decoder) === 0 ? "denied" : "allowed";
        if (permission !== "denied") {
          throw new Error("Invalid permission", {
            cause: { permission },
          });
        }
        const fileId = decoding.readVarString(decoder);
        const statusCode = decoding.readVarUint(decoder);
        const hasReason = decoding.readUint8(decoder) === 1;
        const reason = hasReason ? decoding.readVarString(decoder) : undefined;
        return {
          type: "file-auth-message",
          permission: "denied",
          fileId,
          reason: reason,
          statusCode: statusCode as 404 | 403 | 500,
        };
      }
      default: {
        throw new Error(`Failed to decode file step, unexpected value`, {
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
