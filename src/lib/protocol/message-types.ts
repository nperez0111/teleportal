import { encodeMessage } from "./encode";
import type {
  AwarenessRequestMessage,
  AwarenessUpdateMessage,
  DecodedAckMessage,
  DecodedAuthMessage,
  DecodedAwarenessRequest,
  DecodedAwarenessUpdateMessage,
  DecodedPresenceAnnounce,
  DecodedPresenceHeartbeat,
  DecodedPresenceJoin,
  DecodedPresenceLeave,
  DecodedPresenceUnannounce,
  PresenceMessageBinary,
  DecodedSyncDone,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
  EncodedAckMessage,
  EncodedDocUpdateMessage,
  EncodedRpcMessage,
  RpcError,
  RpcSuccess,
  SerializerContext,
} from "teleportal/protocol";

/**
 * A binary representation of a {@link Message} which concerns a document or awareness update.
 */
export type BinaryMessage =
  | EncodedDocUpdateMessage<DocStep>
  | AwarenessUpdateMessage
  | AwarenessRequestMessage
  | EncodedAckMessage
  | PresenceMessageBinary
  | EncodedRpcMessage;

/**
 * A decoded Y.js document update, which was deserialized from a {@link BinaryMessage}.
 * Can apply to either a document or awareness update.
 */
export type Message<Context extends Record<string, unknown> = any> =
  | AwarenessMessage<Context>
  | DocMessage<Context>
  | AckMessage<Context>
  | PresenceMessage<Context>
  | RpcMessage<Context>;

/**
 * A decoded Y.js document update, which was deserialized from a {@link BinaryMessage}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export type RawReceivedMessage = Message<any>;

/**
 * Base class for message types
 */
export abstract class CustomMessage<
  Context extends Record<string, unknown>,
  BinaryRepresentation extends BinaryMessage,
> {
  public abstract type: string;
  public abstract context: Context;
  public abstract document: string | undefined;
  public abstract payload: any;
  public abstract encrypted: boolean;

  constructor(encoded?: BinaryRepresentation) {
    this.#encoded = encoded;
  }

  #encoded: BinaryRepresentation | undefined;
  #id: string | undefined;

  public get encoded(): BinaryRepresentation {
    return this.#encoded ?? (this.#encoded = this.encode());
  }

  encode(): BinaryRepresentation {
    return encodeMessage(this as any) as BinaryRepresentation;
  }

  public get id(): string {
    if (this.#id) return this.#id;
    const data = this.encoded;
    let h1 = 0x811c9dc5;
    let h2 = 0x1000193;
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      h1 = Math.imul(h1 ^ b, 0x01000193);
      h2 = Math.imul(h2 ^ b, 0x100001b3);
    }
    this.#id = (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
    return this.#id;
  }

  public resetEncoded() {
    this.#encoded = undefined;
    this.#id = undefined;
  }

  /**
   * Whether this message must survive a durable pub/sub log (`"durable"`) or may travel over a
   * fire-and-forget channel that is dropped after a brief disconnect (`"ephemeral"`).
   *
   * Defaults to `"durable"` — the safe choice for unknown/future message types, so a new type
   * is persisted (and replayed after a blip) unless it explicitly opts out.
   *
   * INVARIANT: a message may return `"ephemeral"` only if its effect is **order-independent
   * relative to durable traffic** AND it **self-heals if dropped**. This is what makes it safe
   * for a durable backend to deliver ephemeral traffic over a separate, uncoordinated channel
   * from the durable stream (the two paths have no mutual ordering guarantee). Presence
   * (heartbeats + TTL), awareness (client-side clock guards), and acks (worthless after the
   * sender's retry timeout) all satisfy this.
   */
  public get durability(): "durable" | "ephemeral" {
    return "durable";
  }

  public toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      document: this.document,
      payload: this.payload,
      context: this.context,
      encrypted: this.encrypted,
      id: this.id,
      encoded: this.encoded,
    };
  }

  public toString(): string {
    return `Message(type: ${this.type}, payload: ${JSON.stringify(this.payload)}, document: ${this.document}, context: ${JSON.stringify(this.context)}, encrypted: ${this.encrypted}, id: ${this.id})`;
  }

  public valueOf(): string {
    return this.id;
  }
}

/**
 * A decoded Y.js awareness update, which was deserialized from a {@link Uint8Array}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export class AwarenessMessage<Context extends Record<string, unknown>> extends CustomMessage<
  Context,
  AwarenessUpdateMessage | AwarenessRequestMessage
> {
  public type = "awareness" as const;
  public context: Context;

  constructor(
    public document: string,
    public payload: DecodedAwarenessUpdateMessage | DecodedAwarenessRequest,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: AwarenessUpdateMessage | AwarenessRequestMessage,
  ) {
    super(encoded);
    this.context = context ?? ({} as Context);
  }

  /** Awareness is idempotent and clock-guarded client-side → ephemeral. */
  public override get durability(): "durable" | "ephemeral" {
    return "ephemeral";
  }
}

/**
 * A received doc message, which was deserialized from a {@link Uint8Array}.
 *
 * It also supports decoding the underlying {@link DocStep} and encoding it back to a {@link SendableDocMessage}.
 */
export class DocMessage<Context extends Record<string, unknown>> extends CustomMessage<
  Context,
  EncodedDocUpdateMessage<DocStep>
> {
  public type = "doc" as const;
  public context: Context;

  constructor(
    public document: string,
    public payload:
      | DecodedSyncStep1
      | DecodedSyncStep2
      | DecodedSyncDone
      | DecodedUpdateStep
      | DecodedAuthMessage,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: EncodedDocUpdateMessage<DocStep>,
  ) {
    super(encoded);
    this.context = context ?? ({} as Context);
  }

  /**
   * The sync handshake (`sync-step-1`/`sync-done`/`auth-message`) is a request/response between a
   * specific client and the node it is talking to — replaying it to a node that wasn't there is
   * meaningless → ephemeral. Everything else that carries document state (`update`/`sync-step-2`
   * and any future state-bearing payload) defaults to durable — the safe choice, so a new
   * payload type is persisted unless it explicitly opts out here.
   */
  public override get durability(): "durable" | "ephemeral" {
    switch (this.payload.type) {
      case "sync-step-1":
      case "sync-done":
      case "auth-message":
        return "ephemeral";
      default:
        return "durable";
    }
  }
}

/**
 * A message that acknowledges the receipt of a message.
 */
export class AckMessage<Context extends Record<string, unknown>> extends CustomMessage<
  Context,
  EncodedAckMessage
> {
  public type = "ack" as const;
  public context: Context;
  public encrypted: boolean = false;
  public document = undefined;

  constructor(
    public payload: DecodedAckMessage,
    context?: Context,
  ) {
    super();
    this.context = context ?? ({} as Context);
  }

  /** An ack is worthless after the sender's retry timeout → ephemeral. */
  public override get durability(): "durable" | "ephemeral" {
    return "ephemeral";
  }
}

/**
 * A presence message announcing that a client joined or left a session.
 *
 * Presence is always cleartext (it carries no document content), so it conveys a
 * client's awareness clientID to the server even for end-to-end encrypted
 * documents — where the awareness payload itself is opaque to the server.
 */
export class PresenceMessage<Context extends Record<string, unknown>> extends CustomMessage<
  Context,
  PresenceMessageBinary
> {
  public type = "presence" as const;
  public context: Context;
  public encrypted: boolean = false;

  constructor(
    public document: string,
    public payload:
      | DecodedPresenceAnnounce
      | DecodedPresenceUnannounce
      | DecodedPresenceJoin
      | DecodedPresenceLeave
      | DecodedPresenceHeartbeat,
    context?: Context,
    encoded?: PresenceMessageBinary,
  ) {
    super(encoded);
    this.context = context ?? ({} as Context);
  }

  /** Presence self-heals via heartbeats + TTL → ephemeral. */
  public override get durability(): "durable" | "ephemeral" {
    return "ephemeral";
  }
}

/**
 * An RPC message for remote procedure calls.
 */
export class RpcMessage<Context extends Record<string, unknown>> extends CustomMessage<
  Context,
  EncodedRpcMessage
> {
  public type = "rpc" as const;
  public context: Context;
  #serializer?: (context: SerializerContext) => Uint8Array | undefined;

  constructor(
    public document: string | undefined,
    public payload: RpcSuccess | RpcError,
    public rpcMethod: string,
    public requestType: "request" | "stream" | "response",
    public originalRequestId: string | undefined,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: EncodedRpcMessage,
    serializer?: (context: SerializerContext) => Uint8Array | undefined,
  ) {
    super(encoded);
    this.context = context ?? ({} as Context);
    this.#serializer = serializer;
  }

  public override encode(): EncodedRpcMessage {
    return encodeMessage(this as any, this.#serializer) as EncodedRpcMessage;
  }

  public override toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      document: this.document,
      payload: this.payload,
      context: this.context,
      encrypted: this.encrypted,
      rpcMethod: this.rpcMethod,
      requestType: this.requestType,
      originalRequestId: this.originalRequestId,
      id: this.id,
      encoded: this.encoded,
    };
  }

  public override toString(): string {
    return `RpcMessage(type: ${this.type}, rpcMethod: ${this.rpcMethod}, requestType: ${this.requestType}, originalRequestId: ${this.originalRequestId}, payload: ${JSON.stringify(this.payload)}, document: ${this.document}, context: ${JSON.stringify(this.context)}, encrypted: ${this.encrypted}, id: ${this.id})`;
  }
}

/**
 * Checks if a message is a binary message.
 * @param message - The message to check.
 * @returns Whether the message is a binary message.
 */
export const isBinaryMessage = (message: Uint8Array): message is BinaryMessage => {
  return (
    // Y
    message[0] === 0x59 &&
    // J
    message[1] === 0x4a &&
    // S
    message[2] === 0x53
  );
};
