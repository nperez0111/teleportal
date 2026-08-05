import * as decoding from "lib0/decoding";
import {
  AckMessage,
  AwarenessMessage,
  type BinaryMessage,
  DocMessage,
  RpcMessage,
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
  DecodedSyncDone,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DeserializerContext,
  DocStep,
  EncodedDocUpdateMessage,
  EncodedRpcMessage,
  RpcError,
  RpcSuccess,
  SyncDone,
  SyncStep1,
  SyncStep2,
  UpdateStep,
} from "teleportal/protocol";

/**
 * Decode a Y.js encoded update into a {@link Message}.
 *
 * @param update - The encoded update.
 * @param deserializer - Optional callback for custom deserialization. Receives context and returns deserialized value, or undefined to use default.
 * @returns The decoded update, which should be considered untrusted at this point.
 */
export function decodeMessage(
  update: BinaryMessage,
  deserializer?: (context: DeserializerContext) => unknown | undefined,
): RawReceivedMessage {
  try {
    const decoder = decoding.createDecoder(update);
    const [y, j, s] = [
      decoding.readUint8(decoder),
      decoding.readUint8(decoder),
      decoding.readUint8(decoder),
    ];
    if (y !== 0x59 || j !== 0x4a || s !== 0x53) {
      throw new Error("Invalid magic number");
    }
    const version = decoding.readUint8(decoder);
    if (version !== 0x02) {
      throw new Error("Invalid version");
    }
    const documentName = decoding.readVarString(decoder);

    const encrypted = decoding.readUint8(decoder) === 1;

    // Best-effort flag. For native message types the class getter is authoritative (awareness
    // and ack are best-effort by construction); only rpc carries a per-method policy that must
    // survive the wire.
    const bestEffort = decoding.readUint8(decoder) === 1;

    const targetType = decoding.readUint8(decoder);

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
      case 0x04: {
        return decodeRpcMessageWithDecoder(
          documentName,
          decoder,
          encrypted,
          bestEffort,
          update as EncodedRpcMessage,
          deserializer,
        );
      }
      default: {
        throw new Error("Invalid target type", {
          cause: { targetType },
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to decode update message: ${errorMessage}`, {
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
        const syncStep2Version = decoding.readUint8(decoder);
        return {
          type: "sync-step-2",
          update: { version: syncStep2Version, data: decoding.readVarUint8Array(decoder) },
        } as E;
      }
      case 0x02: {
        const updateVersion = decoding.readUint8(decoder);
        return {
          type: "update",
          update: { version: updateVersion, data: decoding.readVarUint8Array(decoder) },
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

function decodeAckMessageWithDecoder(decoder: decoding.Decoder): DecodedAckMessage {
  const messageId = decoding.readVarString(decoder);
  // flags: bit0 = has retryAfter (retryable NACK), bit1 = has error (permanent NACK)
  const flags = decoding.readUint8(decoder);
  const message: DecodedAckMessage = { type: "ack", messageId };
  if (flags & 1) {
    message.retryAfter = decoding.readVarUint(decoder);
  }
  if (flags & 2) {
    message.error = decoding.readVarString(decoder);
  }
  return message;
}

function decodeRpcMessageWithDecoder(
  documentName: string,
  decoder: decoding.Decoder,
  encrypted: boolean,
  bestEffort: boolean,
  encoded: EncodedRpcMessage,
  deserializer?: (context: DeserializerContext) => unknown | undefined,
): RpcMessage<any> {
  // method name
  const rpcMethod = decoding.readVarString(decoder);

  const requestTypeIndex = decoding.readUint8(decoder);

  const requestType = (["request", "stream", "response"] as const)[requestTypeIndex];

  if (!requestType) {
    throw new Error("Invalid RPC request type", {
      cause: { requestTypeIndex },
    });
  }

  let originalRequestId: string | undefined;
  if (requestType === "response" || requestType === "stream") {
    // Presence flag: pushes are "response" messages correlated to no request.
    if (decoding.readUint8(decoder) === 1) {
      originalRequestId = decoding.readVarString(decoder);
    }
  }

  const isSuccess = decoding.readUint8(decoder) === 0;

  let payload: RpcSuccess | RpcError;
  if (isSuccess) {
    const payloadBytes = decoding.readVarUint8Array(decoder);
    const payloadDecoder = decoding.createDecoder(payloadBytes);
    const deserialized = deserializer?.({
      type: "rpc",
      method: rpcMethod,
      requestType,
      payload: payloadBytes,
      decoder: payloadDecoder,
    });
    if (deserialized === undefined) {
      payload = {
        type: "success",
        payload: decoding.readAny(payloadDecoder),
      };
    } else {
      payload = {
        type: "success",
        payload: deserialized,
      };
    }
  } else {
    const statusCode = decoding.readVarUint(decoder);
    const details = decoding.readVarString(decoder);
    const hasPayload = decoding.readUint8(decoder) === 1;

    payload = {
      type: "error",
      statusCode,
      details,
      payload: hasPayload ? decoding.readAny(decoder) : undefined,
    };
  }

  return new RpcMessage(
    documentName,
    payload as any,
    rpcMethod,
    requestType,
    originalRequestId,
    undefined,
    encrypted,
    encoded,
    undefined,
    // Durability is only consulted on the authoring node at publish time, so it does not
    // travel the wire; the ack policy must, so receivers know not to ack best-effort pushes.
    { ack: !bestEffort },
  );
}
