import * as decoding from "lib0/decoding";
import {
  AwarenessMessage,
  type BinaryMessage,
  BlobMessage,
  DocMessage,
  type RawReceivedMessage,
} from "./message-types";
import type {
  AuthMessage,
  AwarenessRequestMessage,
  AwarenessStep,
  AwarenessUpdateMessage,
  DecodedAuthMessage,
  DecodedAwarenessRequest,
  DecodedAwarenessUpdateMessage,
  DecodedBlobPartMessage,
  DecodedRequestBlobMessage,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
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
        // blob message
        const payloadType = decoding.readUint8(decoder);
        let payload;
        if (payloadType === 0) {
          payload = decodeBlobPartStepWithDecoder(decoder);
        } else if (payloadType === 1) {
          payload = decodeRequestBlobStepWithDecoder(decoder);
        } else {
          throw new Error("Invalid blob payload type");
        }
        return new BlobMessage(
          documentName,
          payload,
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

function decodeBlobPartStepWithDecoder(
  decoder: decoding.Decoder,
): DecodedBlobPartMessage {
  try {
    const segmentIndex = decoding.readVarUint(decoder);
    const totalSegments = decoding.readVarUint(decoder);
    const contentId = decoding.readVarString(decoder);
    const name = decoding.readVarString(decoder);
    const contentType = decoding.readVarString(decoder);
    const data = decoding.readVarUint8Array(decoder);

    // Read merkle tree metadata (added for BLAKE3-style streaming)
    const merkleRootHash = decoding.readVarString(decoder);
    const merkleTreeDepth = decoding.readVarUint(decoder);
    const chunkHashesLength = decoding.readVarUint(decoder);
    
    const merkleChunkHashes: string[] = [];
    for (let i = 0; i < chunkHashesLength; i++) {
      merkleChunkHashes.push(decoding.readVarString(decoder));
    }
    
    const startChunkIndex = decoding.readVarUint(decoder);
    const endChunkIndex = decoding.readVarUint(decoder);

    return {
      type: "blob-part",
      segmentIndex,
      totalSegments,
      contentId,
      name,
      contentType,
      data,
      // Only include merkle tree metadata if it's present
      merkleRootHash: merkleRootHash || undefined,
      merkleTreeDepth: merkleTreeDepth > 0 ? merkleTreeDepth : undefined,
      merkleChunkHashes: merkleChunkHashes.length > 0 ? merkleChunkHashes : undefined,
      startChunkIndex: startChunkIndex > 0 || endChunkIndex > 0 ? startChunkIndex : undefined,
      endChunkIndex: startChunkIndex > 0 || endChunkIndex > 0 ? endChunkIndex : undefined,
    };
  } catch (err) {
    throw new Error("Failed to decode blob part step", {
      cause: { err },
    });
  }
}

function decodeRequestBlobStepWithDecoder(
  decoder: decoding.Decoder,
): DecodedRequestBlobMessage {
  try {
    const requestId = decoding.readVarString(decoder);
    const contentId = decoding.readVarString(decoder);
    const name = decoding.readVarString(decoder);

    return {
      type: "request-blob",
      requestId,
      contentId,
      name: name || undefined,
    };
  } catch (err) {
    throw new Error("Failed to decode request blob step", {
      cause: { err },
    });
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
        : D extends AuthMessage
          ? DecodedAuthMessage
          : never,
>(update: D): E {
  const decoder = decoding.createDecoder(update);
  return decodeDocStepWithDecoder(decoder);
}
