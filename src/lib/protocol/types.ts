export type Tag<T, Tag> = T & { _tag: Tag };

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
 * A Y.js awareness update message, which includes the document name and the update.
 */
export type AwarenessRequestMessage = Tag<Uint8Array, "awareness-request">;

/**
 * A decoded Y.js auth message
 */
export type DecodedAwarenessRequest = {
  type: "awareness-request";
};

/**
 * A Y.js update, always encoded as UpdateV2.
 */
export type Update = Tag<Uint8Array, "update">;

/**
 * A Y.js state vector.
 */
export type StateVector = Tag<Uint8Array, "state-vector">;

/**
 * A Y.js SyncStep2 update, as an UpdateV2.
 */
export type SyncStep2Update = Tag<Uint8Array, "sync-step-2-update">;

/**
 * A Y.js sync step 1 update as encoded by the y-protocols implementation.
 */
export type SyncStep1 = Tag<Uint8Array, "sync-step-1">;

/**
 * A decoded Y.js {@link SyncStep1} update
 */
export type DecodedSyncStep1 = {
  type: "sync-step-1";
  sv: StateVector;
};

/**
 * A Y.js sync step 2 update as encoded by the y-protocols implementation.
 */
export type SyncStep2 = Tag<Uint8Array, "sync-step-2">;

/**
 * A decoded Y.js {@link SyncStep2} update
 */
export type DecodedSyncStep2 = {
  type: "sync-step-2";
  update: SyncStep2Update;
};

/**
 * A Y.js sync done message that indicates both sync step 1 and sync step 2 have been exchanged
 */
export type SyncDone = Tag<Uint8Array, "sync-done">;

/**
 * A decoded Y.js {@link SyncDone} message
 */
export type DecodedSyncDone = {
  type: "sync-done";
};

/**
 * A Y.js update step as encoded by the y-protocols implementation.
 */
export type UpdateStep = Tag<Uint8Array, "update-step">;

/**
 * A decoded Y.js {@link UpdateStep}
 */
export type DecodedUpdateStep = {
  type: "update";
  update: Update;
};

/**
 * A Y.js update step as encoded by the y-protocols implementation.
 */
export type AuthMessage = Tag<Uint8Array, "auth-message">;

/**
 * A decoded Y.js auth message
 */
export type DecodedAuthMessage = {
  type: "auth-message";
  permission: "denied";
  reason: string;
};

/**
 * A Y.js acknowledgement message
 */
export type EncodedAckMessage = Tag<Uint8Array, "ack">;

/**
 * An acknowledgement message
 */
export type DecodedAckMessage = {
  type: "ack";
  /**
   * The id of the message that was acknowledged.
   */
  messageId: string;
};

/**
 * Any Y.js update which concerns a document.
 */
export type DocStep =
  | SyncStep1
  | SyncStep2
  | SyncDone
  | UpdateStep
  | AuthMessage;

/**
 * Any Y.js update which contains awareness updates.
 */
export type AwarenessStep = AwarenessRequestMessage | AwarenessUpdateMessage;

/**
 * A Y.js message which concerns a document and encloses a {@link DocStep} and the document name.
 */
export type EncodedDocUpdateMessage<T extends DocStep> = Tag<Uint8Array, T>;

/**
 * A {@link MilestoneSnapshot} is a binary encoded snapshot of a document at a point in time.
 */
export type MilestoneSnapshot = Tag<Uint8Array, "milestone-snapshot">;

export type RpcRequestType = "request" | "stream" | "response";

export type RpcSuccess<Payload = unknown> = {
  type: "success";
  /**
   * The payload of a successful RPC response.
   */
  payload: Payload;
};

export type RpcError<Payload = unknown> = {
  type: "error";
  statusCode: number;
  details: string;
  /**
   * The payload of an error RPC response.
   */
  payload?: Payload;
};

export type RpcStream<Payload = unknown> = {
  type: "stream";
  /**
   * The payload of a stream RPC message.
   */
  payload: Payload;
};

export type RpcResponse<OK = unknown, Error = unknown> =
  | RpcSuccess<OK>
  | RpcError<Error>;

export type RpcRequest = unknown;

export type EncodedRpcMessage = Tag<Uint8Array, "rpc-message">;

export type DecodedRpcMessage<OK = unknown, Error = unknown> = {
  type: "rpc";
  method: string;
  requestType: RpcRequestType;
  originalRequestId?: string;
  payload: RpcResponse<OK, Error>;
};

import type { Message, RpcMessage, ServerContext } from "teleportal";
import type { Server } from "../../server/server";
import type { Session } from "../../server/session";

/**
 * Base context provided to all RPC handlers on the server.
 * This is automatically enriched by Session when invoking handlers.
 */
export interface RpcServerContext<
  Context extends ServerContext = ServerContext,
> {
  /** The Server instance */
  server: Server<Context>;
  /** The namespaced document ID */
  documentId: string;
  /** The Session instance for this document */
  session: Session<Context>;
  /** User ID from the message context (if authenticated) */
  userId?: Context["userId"];
  /** Client ID from the message context */
  clientId?: Context["clientId"];
  /** Any additional context from the original message */
  [key: string]: unknown;
}

export interface RpcServerRequestHandler<
  Request,
  Response,
  Stream = never,
  Context extends RpcServerContext = RpcServerContext,
> {
  handler: (
    payload: Request,
    context: Context,
  ) => Promise<{
    response: Response | RpcError;
    stream?: AsyncIterable<Stream>;
  }>;

  /**
   * Optional handler for incoming stream messages.
   * Used for protocols that receive streaming data (e.g., file uploads).
   * @param payload - The stream payload
   * @param context - The RPC context including session, server, etc.
   * @param messageId - The ID of the stream message (for ACK responses)
   * @param sendMessage - Function to send messages back to the client
   * @returns Promise that resolves when the stream chunk is processed
   */
  streamHandler?: (
    payload: Stream,
    context: Context,
    messageId: string,
    sendMessage: (message: Message<any>) => Promise<void>,
  ) => Promise<void>;

  /**
   * Optional initialization function called when the handler is registered with a Server.
   * Can return a cleanup function that will be called when the server is disposed.
   */
  init?: (server: Server<any>) => (() => void) | void;

  request?: {
    encode: (payload: Request) => Uint8Array;
    decode: (payload: Uint8Array) => Request;
  };
  response?: {
    encode: (payload: Response) => Uint8Array;
    decode: (payload: Uint8Array) => Response;
  };
  stream?: {
    encode: (payload: Stream) => Uint8Array;
    decode: (payload: Uint8Array) => Stream;
  };
}

export type RpcHandlerRegistry = {
  [method: string]: RpcServerRequestHandler<
    unknown,
    unknown,
    unknown,
    RpcServerContext
  >;
};

import type * as decoding from "lib0/decoding";
import type * as encoding from "lib0/encoding";

// Context for serialization (encoding)
export type RpcSerializerContext = {
  type: "rpc";
  message: RpcMessage<any>;
  payload: unknown;
  encoder: encoding.Encoder; // fresh encoder for lib0 encoding
};
export type SerializerContext = RpcSerializerContext; // extensible union

// Context for deserialization (decoding)
export type RpcDeserializerContext = {
  type: "rpc";
  method: string;
  requestType: RpcRequestType;
  originalRequestId?: string;
  payload: Uint8Array;
  decoder: decoding.Decoder; // positioned at payload start
};
export type DeserializerContext = RpcDeserializerContext; // extensible union
