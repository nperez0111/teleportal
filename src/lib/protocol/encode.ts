import { fromBase64 } from "lib0/buffer";
import * as encoding from "lib0/encoding";
import { type BinaryMessage, type Message } from "./message-types";
import type {
  DocStep,
  SerializerContext,
  StateVector,
  SyncDone,
  SyncStep1,
  SyncStep2,
  Update,
  UpdateStep,
} from "teleportal/protocol";

/**
 * Encode a {@link Message} into a {@link Uint8Array}.
 *
 * @param message - The encoded update.
 * @param serializer - Optional callback for custom serialization. Receives context and returns serialized bytes, or undefined to use default.
 * @returns The encoded update.
 */
export function encodeMessage(
  message: Message,
  serializer?: (context: SerializerContext) => Uint8Array | undefined,
): BinaryMessage {
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
    encoding.writeVarString(encoder, message.document ?? "");

    // encrypted or not
    encoding.writeUint8(encoder, message.encrypted ? 1 : 0);

    switch (message.type) {
      case "awareness": {
        // message type (doc/awareness)
        encoding.writeUint8(encoder, 1);

        switch (message.payload.type) {
          case "awareness-update": {
            // message type
            encoding.writeUint8(encoder, 0);
            // awareness update
            encoding.writeVarUint8Array(encoder, message.payload.update);
            break;
          }
          case "awareness-request": {
            // message type
            encoding.writeUint8(encoder, 1);
            break;
          }
          default: {
            // @ts-expect-error - this should be unreachable due to type checking
            message.payload.type;
            throw new Error("Invalid update.payload.type", {
              cause: { update: message },
            });
          }
        }
        break;
      }
      case "doc": {
        // message type (doc/awareness)
        encoding.writeUint8(encoder, 0);

        switch (message.payload.type) {
          case "sync-step-1": {
            // message type
            encoding.writeUint8(encoder, 0);
            // state vector
            encoding.writeVarUint8Array(encoder, message.payload.sv);
            break;
          }
          case "update":
          case "sync-step-2": {
            // message type
            encoding.writeUint8(
              encoder,
              message.payload.type === "sync-step-2" ? 1 : 2,
            );
            // update
            encoding.writeVarUint8Array(encoder, message.payload.update);
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
              message.payload.permission === "denied" ? 0 : 1,
            );
            // reason
            encoding.writeVarString(encoder, message.payload.reason);
            break;
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
          fromBase64(message.payload.messageId),
        );
        break;
      }
      case "rpc": {
        encoding.writeUint8(encoder, 4);

        // method name
        encoding.writeVarString(encoder, message.rpcMethod);

        const requestTypeIndex = ["request", "stream", "response"].indexOf(
          message.requestType,
        );
        if (requestTypeIndex === -1) {
          throw new Error("Invalid RPC request type", {
            cause: { update: message },
          });
        }
        // request type
        encoding.writeUint8(encoder, requestTypeIndex);

        // original request id
        if (
          message.requestType === "response" ||
          message.requestType === "stream"
        ) {
          if (!message.originalRequestId) {
            throw new Error(
              "Original request ID is required for response or stream messages",
              {
                cause: { message },
              },
            );
          }
          encoding.writeVarString(encoder, message.originalRequestId);
        }

        // is error or success
        encoding.writeUint8(
          encoder,
          message.payload.type === "success" ? 0 : 1,
        );
        if (message.payload.type === "success") {
          const serialized = serializer?.({
            type: "rpc",
            message,
            payload: message.payload.payload,
            encoder: encoding.createEncoder(),
          });
          // serialize payload
          if (serialized === undefined) {
            const payloadEncoder = encoding.createEncoder();
            encoding.writeAny(payloadEncoder, message.payload.payload as any);
            encoding.writeVarUint8Array(
              encoder,
              encoding.toUint8Array(payloadEncoder),
            );
          } else {
            encoding.writeVarUint8Array(encoder, serialized);
          }
        } else {
          // status code
          encoding.writeVarUint(encoder, message.payload.statusCode);
          // details
          encoding.writeVarString(encoder, message.payload.details);
          // has payload
          encoding.writeVarUint(encoder, message.payload.payload ? 1 : 0);
          // serialize payload
          encoding.writeAny(encoder, message.payload.payload as any);
        }

        break;
      }
      default: {
        // @ts-expect-error - this should be unreachable due to type checking
        message.type;
        throw new Error("Invalid update type", {
          cause: { update: message },
        });
      }
    }

    return encoding.toUint8Array(encoder) as BinaryMessage;
  } catch (err) {
    throw new Error("Failed to encode message", {
      cause: { update: message, err },
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
      case 0x03: {
        messageTypeNumber = messageType;
        break;
      }
      case "sync-step-1": {
        messageTypeNumber = 0x00;
        break;
      }
      case "sync-step-2": {
        messageTypeNumber = 0x01;
        break;
      }
      case "update": {
        messageTypeNumber = 0x02;
        break;
      }
      case "sync-done": {
        messageTypeNumber = 0x03;
        break;
      }
      default: {
        throw new Error("Invalid message type", {
          cause: { messageType },
        });
      }
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
