import type { Message, ServerContext } from "teleportal";

export type TeleportalServerEventReason =
  | "cleanup"
  | "delete"
  | "dispose"
  | "abort"
  | "stream-ended"
  | "manual";

export type TeleportalServerEventBase = {
  /**
   * ISO timestamp at emission time.
   */
  ts: string;
  /**
   * Node ID of this server instance.
   */
  nodeId: string;
};

export type TeleportalDocumentRef<Context extends ServerContext> = {
  /**
   * Client-facing document ID (what the client sent).
   */
  documentId: string;
  /**
   * Namespaced document ID used for storage/pubsub (e.g. `${room}/${document}`).
   */
  namespacedDocumentId: string;
  sessionId: string;
  encrypted: boolean;
  /**
   * Context used to resolve the namespaced document ID (multi-tenant).
   *
   * Note: this is whatever context the caller passed to the server when opening
   * the document. It is included so consumers can build webhook payloads / audit
   * logs / metrics.
   */
  context: Context;
};

export type TeleportalClientRef = {
  clientId: string;
};

export type TeleportalClientMessageEvent<Context extends ServerContext> =
  TeleportalServerEventBase &
    TeleportalClientRef & {
      direction: "in" | "out";
      /**
       * For inbound messages, this is the message received from the transport.
       * For outbound messages, this is the message written to the client stream.
       */
      message: Message<Context>;
      /**
       * Convenience fields for indexing.
       */
      messageType: Message<Context>["type"];
      payloadType?: string;
      documentId?: string;
      encrypted?: boolean;
      /**
       * If an outbound message failed to write, this is populated.
       */
      error?: {
        name: string;
        message: string;
      };
    };

export type TeleportalDocumentMessageEvent<Context extends ServerContext> =
  TeleportalServerEventBase & {
    source: "client" | "replication";
    clientId?: string;
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
    encrypted: boolean;
    message: Message<Context>;
    messageType: Message<Context>["type"];
    payloadType?: string;
    sourceNodeId?: string;
    deduped?: boolean;
  };

/**
 * Server-level event map for the teleportal sync server.
 *
 * Consumers can attach handlers and forward these to a webhook sink, metrics
 * pipeline, or audit logger.
 */
export type TeleportalServerEvents<Context extends ServerContext> = {
  /**
   * A session for a document has been created and loaded.
   */
  "document-load": (event: TeleportalServerEventBase &
    TeleportalDocumentRef<Context>) => void | Promise<void>;
  /**
   * A session for a document has been disposed/cleaned up.
   */
  "document-unload": (event: TeleportalServerEventBase &
    Omit<TeleportalDocumentRef<Context>, "context"> & {
      reason: Extract<TeleportalServerEventReason, "cleanup" | "delete" | "dispose">;
    }) => void | Promise<void>;
  /**
   * A document has been deleted from storage (and any active session closed).
   */
  "document-delete": (event: TeleportalServerEventBase & {
    documentId: string;
    namespacedDocumentId: string;
    encrypted: boolean;
    context: Context;
  }) => void | Promise<void>;

  /**
   * A client has been created and connected to the server.
   */
  "client-connect": (event: TeleportalServerEventBase & TeleportalClientRef) => void | Promise<void>;
  /**
   * A client has been disconnected from the server (and removed from sessions).
   */
  "client-disconnect": (event: TeleportalServerEventBase &
    TeleportalClientRef & {
      reason: TeleportalServerEventReason;
    }) => void | Promise<void>;

  /**
   * A client joined a document session.
   */
  "document-client-connect": (event: TeleportalServerEventBase &
    TeleportalClientRef &
    Omit<TeleportalDocumentRef<Context>, "context">) => void | Promise<void>;
  /**
   * A client left a document session.
   */
  "document-client-disconnect": (event: TeleportalServerEventBase &
    TeleportalClientRef &
    Omit<TeleportalDocumentRef<Context>, "context"> & {
      reason: TeleportalServerEventReason;
    }) => void | Promise<void>;

  /**
   * Any message flowing between client transport and server.
   */
  "client-message": (event: TeleportalClientMessageEvent<Context>) => void | Promise<void>;
  /**
   * Any message applied to a document session (from client or replication).
   */
  "document-message": (event: TeleportalDocumentMessageEvent<Context>) => void | Promise<void>;
};

