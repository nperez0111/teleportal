import * as decoding from "lib0/decoding";
import { encoding } from "lib0";

/**
 * Binary encoding of the Yjs protocol.
 *
 * The format (version 1) is as follows:
 * - 3 bytes: magic number "YJS" (0x59, 0x4a, 0x53)
 * - 1 byte: version (0x01)
 * - 1 byte: length of document name
 * - document name: the name of the document
 * - yjs base protocol (type + data payload)
 */

export type Tag<T, Tag> = T & { _tag: Tag };
export type Update = Tag<Uint8Array, "update">;
export type AwarenessUpdateMessage = Tag<Uint8Array, "awareness-update">;
export type StateVector = Tag<Uint8Array, "state-vector">;
export type SyncStep1 = Tag<Uint8Array, "sync-step-1">;
export type SyncStep2 = Tag<Uint8Array, "sync-step-2">;
export type UpdateStep = Tag<Uint8Array, "update-step">;
export type DocStep = SyncStep1 | SyncStep2 | UpdateStep;
export type EncodedDocUpdateMessage<T extends DocStep> = Tag<Uint8Array, T>;
export type YEncodedMessage =
  | EncodedDocUpdateMessage<DocStep>
  | AwarenessUpdateMessage;

/**
 * A Y.js message, to be sent over the wire, which will be serialized to a {@link Uint8Array} for transport.
 *
 * Can apply to either a document or awareness update.
 */
export type SendableMessage = {
  /**
   * The document name.
   */
  document: string;
} & (
  | {
      type: "awareness";
      payload: {
        type: "awareness-update";
        // TODO do we want to re-implement Awareness updates, or just pass around opaque binary?
        update: AwarenessUpdateMessage;
      };
    }
  | {
      type: "doc";
      payload:
        | {
            type: "sync-step-1";
            payload: SyncStep1;
          }
        | {
            type: "sync-step-2";
            payload: SyncStep2;
          }
        | {
            type: "update";
            payload: UpdateStep;
          };
    }
);

/**
 * A decoded Y.js document update, which was deserialized from a {@link Uint8Array}.
 * Can apply to either a document or awareness update.
 */
export type ReceivedMessage<Context extends Record<string, unknown>> =
  | AwarenessMessage<Context>
  | DocMessage<Context>;

/**
 * A decoded Y.js document update, which was deserialized from a {@link Uint8Array}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export type RawReceivedMessage = ReceivedMessage<{}>;

export class AwarenessMessage<Context extends Record<string, unknown>> {
  public type = "awareness" as const;
  public context: Context;

  constructor(
    public document: string,
    public update: AwarenessUpdateMessage,
    context?: Context,
  ) {
    this.context = context ?? ({} as Context);
  }

  public get decoded() {
    throw new Error("Not implemented");
  }
}

export class DocMessage<Context extends Record<string, unknown>> {
  public type = "doc" as const;
  public context: Context;

  constructor(
    public document: string,
    public update: DocStep,
    context?: Context,
  ) {
    this.context = context ?? ({} as Context);
  }

  public get decoded() {
    const decoded = decodeDocStep(this.update);
    // Lazy decode the update, without re-evaluating the decoder
    Object.defineProperty(this, "decoded", { value: decoded });
    return decoded;
  }
}

/**
 * Decode a Y.js encoded update into a {@link ReceivedMessage}.
 *
 * @param update - The encoded update.
 * @returns The decoded update.
 */
export function decodeUpdateMessage(
  update: YEncodedMessage,
): RawReceivedMessage {
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
      return new DocMessage(
        documentName,
        decoding.readTailAsUint8Array(decoder) as DocStep,
      );
    }
    case 0x01: {
      return new AwarenessMessage(
        documentName,
        decoding.readTailAsUint8Array(decoder) as AwarenessUpdateMessage,
      );
    }
    default:
      throw new Error("Invalid target type", {
        cause: { targetType },
      });
  }
}

/**
 * Encode a {@link SendableMessage} into a {@link Uint8Array}.
 *
 * @param update - The encoded update.
 * @returns The encoded update.
 */
export function encodeMessage(update: SendableMessage): YEncodedMessage {
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
      encoding.writeUint8Array(encoder, update.payload.update);
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
          encoding.writeUint8Array(encoder, update.payload.payload);
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
          encoding.writeUint8Array(encoder, update.payload.payload);
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
    default: {
      throw new Error("Invalid update type", {
        cause: { update },
      });
    }
  }

  return encoding.toUint8Array(encoder) as YEncodedMessage;
}

/**
 * Serialize a sync step 1 update.
 */
export function encodeSyncStep1Message(
  document: string,
  payload: SyncStep1,
): EncodedDocUpdateMessage<SyncStep1> {
  return encodeMessage({
    type: "doc",
    document,
    payload: {
      type: "sync-step-1",
      payload,
    },
  }) as EncodedDocUpdateMessage<SyncStep1>;
}

/**
 * Serialize a sync step 2 update.
 */
export function encodeSyncStep2Message(
  document: string,
  payload: SyncStep2,
): EncodedDocUpdateMessage<SyncStep2> {
  return encodeMessage({
    type: "doc",
    document,
    payload: {
      type: "sync-step-2",
      payload,
    },
  }) as EncodedDocUpdateMessage<SyncStep2>;
}

/**
 * Serialize an update message.
 */
export function encodeUpdateStepMessage(
  document: string,
  payload: UpdateStep,
): EncodedDocUpdateMessage<UpdateStep> {
  return encodeMessage({
    type: "doc",
    document,
    payload: {
      type: "update",
      payload,
    },
  }) as EncodedDocUpdateMessage<UpdateStep>;
}

/**
 * Serialize a doc step.
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
}

export function decodeDocStep<
  D extends DocStep,
  E = D extends SyncStep1
    ? {
        type: "sync-step-1";
        payload: StateVector;
      }
    : D extends SyncStep2
      ? {
          type: "sync-step-2";
          payload: Update;
        }
      : D extends UpdateStep
        ? {
            type: "update";
            payload: Update;
          }
        : never,
>(update: D): E {
  const decoder = decoding.createDecoder(update);
  const messageType = decoding.readUint8(decoder);
  switch (messageType) {
    case 0x00: {
      return {
        type: "sync-step-1",
        payload: decoding.readVarUint8Array(decoder),
      } as E;
    }
    case 0x01: {
      return {
        type: "sync-step-2",
        payload: decoding.readVarUint8Array(decoder),
      } as E;
    }
    case 0x02: {
      return {
        type: "update",
        payload: decoding.readVarUint8Array(decoder),
      } as E;
    }
    default: {
      throw new Error(`Failed to decode doc update, unexpected value`, {
        cause: { messageType },
      });
    }
  }
}
