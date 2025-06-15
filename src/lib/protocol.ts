import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { uuidv4 } from "lib0/random";

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
/**
 * A Y.js update, always encoded as UpdateV2.
 */
export type Update = Tag<Uint8Array, "update">;

/**
 * A Y.js awareness update message, which includes the document name and the update.
 */
export type AwarenessUpdateMessage = Tag<Uint8Array, "awareness-update">;

/**
 * A decoded Y.js awareness update message.
 */
export type DecodedAwarenessUpdateMessage = {
  type: "awareness-update";
  update: AwarenessUpdateMessage;
};

/**
 * A Y.js state vector.
 */
export type StateVector = Tag<Uint8Array, "state-vector">;

/**
 * A Y.js sync step 1 update as encoded by the y-protocols implementation.
 */
export type SyncStep1 = Tag<Uint8Array, "sync-step-1">;

/*
 * A decoded Y.js sync step 1 update.
 */
export type DecodedSyncStep1 = {
  type: "sync-step-1";
  sv: StateVector;
};

/**
 * A Y.js sync step 2 update as encoded by the y-protocols implementation.
 */
export type SyncStep2 = Tag<Uint8Array, "sync-step-2">;

/*
 * A decoded Y.js sync step 2 update.
 */
export type DecodedSyncStep2 = {
  type: "sync-step-2";
  update: Update;
};

/**
 * A Y.js update step as encoded by the y-protocols implementation.
 */
export type UpdateStep = Tag<Uint8Array, "update-step">;

/*
 * A decoded Y.js update step.
 */
export type DecodedUpdateStep = {
  type: "update";
  update: Update;
};

/**
 * Any Y.js update which concerns a document.
 */
export type DocStep = SyncStep1 | SyncStep2 | UpdateStep;

/**
 * A Y.js message which concerns a document and encloses a {@link DocStep} and the document name.
 */
export type EncodedDocUpdateMessage<T extends DocStep> = Tag<Uint8Array, T>;

/**
 * A Y.js message which concerns a document or awareness update.
 */
export type BinaryMessage =
  | EncodedDocUpdateMessage<DocStep>
  | AwarenessUpdateMessage;

/**
 * A decoded Y.js document update, which was deserialized from a {@link Uint8Array}.
 * Can apply to either a document or awareness update.
 */
export type Message<Context extends Record<string, unknown> = any> =
  | AwarenessMessage<Context>
  | DocMessage<Context>;

/**
 * A decoded Y.js document update, which was deserialized from a {@link Uint8Array}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export type RawReceivedMessage = Message<any>;

/**
 * A decoded Y.js awareness update, which was deserialized from a {@link Uint8Array}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export class AwarenessMessage<Context extends Record<string, unknown>> {
  public type = "awareness" as const;
  public context: Context;
  public id: string;

  constructor(
    public document: string,
    public payload: DecodedAwarenessUpdateMessage,
    context?: Context,
  ) {
    this.id = uuidv4();
    this.context = context ?? ({} as Context);
  }

  public get encoded() {
    const encoded = encodeMessage(this);
    Object.defineProperty(this, "encoded", { value: encoded });
    return encoded;
  }
}

/**
 * A received doc message, which was deserialized from a {@link Uint8Array}.
 *
 * It also supports decoding the underlying {@link DocStep} and encoding it back to a {@link SendableDocMessage}.
 */
export class DocMessage<Context extends Record<string, unknown>> {
  public type = "doc" as const;
  public context: Context;
  public id: string;

  constructor(
    public document: string,
    public payload: DecodedSyncStep1 | DecodedSyncStep2 | DecodedUpdateStep,
    context?: Context,
  ) {
    this.id = uuidv4();
    this.context = context ?? ({} as Context);
  }

  public get encoded() {
    const encoded = encodeMessage(this);
    Object.defineProperty(this, "encoded", { value: encoded });
    return encoded;
  }
}

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
