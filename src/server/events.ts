import type { ServerContext } from "teleportal";
import type { Session } from "./session";

export type DocumentUnloadReason = "cleanup" | "delete" | "dispose";

export type ClientDisconnectReason =
  | "abort"
  | "stream-ended"
  | "manual"
  | "error";

export type ClientMessageDirection = "in" | "out";

export type DocumentMessageSource = "client" | "replication";

export type SessionEvents<Context extends ServerContext = ServerContext> = {
  /**
   * Emitted when a client joins this session.
   */
  "client-join": (data: {
    clientId: string;
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
    context?: Context;
  }) => void;

  /**
   * Emitted when a client leaves this session.
   */
  "client-leave": (data: {
    clientId: string;
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
  }) => void;

  /**
   * Emitted when a message is applied to the document.
   * This provides visibility into document-level message processing.
   * Source "client" means from an authenticated client, "replication" means from another node.
   */
  "document-message": (data: {
    clientId: string | undefined;
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
    messageId: string;
    messageType: string;
    payloadType: string | undefined;
    encrypted: boolean;
    context: Context;
    source: DocumentMessageSource;
    sourceNodeId?: string;
    deduped?: boolean;
  }) => void;

  /**
   * Emitted when a document's size exceeds the warning threshold.
   */
  "document-size-warning": (data: {
    documentId: string;
    namespacedDocumentId: string;
    sizeBytes: number;
    warningThreshold: number;
    context: Context;
  }) => void;

  /**
   * Emitted when a document's size exceeds the limit.
   */
  "document-size-limit-exceeded": (data: {
    documentId: string;
    namespacedDocumentId: string;
    sizeBytes: number;
    sizeLimit: number;
    context: Context;
  }) => void;

  /**
   * Emitted when a milestone is created.
   */
  "milestone-created": (data: {
    documentId: string;
    namespacedDocumentId: string;
    milestoneId: string;
    milestoneName: string;
    triggerType?: "manual" | "time-based" | "update-count" | "event-based";
    triggerId?: string;
    context: Context;
  }) => void;

  /**
   * Emitted when a milestone is deleted.
   */
  "milestone-deleted": (data: {
    documentId: string;
    namespacedDocumentId: string;
    milestoneId: string;
    deletedBy?: string;
    context: Context;
  }) => void;

  /**
   * Emitted when a milestone is restored from soft-deletion.
   */
  "milestone-restored": (data: {
    documentId: string;
    namespacedDocumentId: string;
    milestoneId: string;
    context: Context;
  }) => void;

  /**
   * Emitted when a document write operation completes.
   * This is emitted after the update has been written to storage.
   */
  "document-write": (data: {
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
    encrypted: boolean;
    context?: Context;
  }) => void;

  /**
   * Emitted when the session is about to be disposed.
   * This allows handlers to clean up any session-related resources.
   */
  dispose: (data: {
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
  }) => void;
};

export type ServerEvents<Context extends ServerContext = ServerContext> = {
  /**
   * Emitted when a document session is created and loaded.
   * This happens when the first client connects to a document.
   */
  "document-load": (data: {
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
    encrypted: boolean;
    context: Context;
  }) => void;

  /**
   * Emitted when a new session is opened.
   * This provides handlers with access to the Session instance for setting up listeners.
   */
  "session-open": (data: {
    session: Session<Context>;
    documentId: string;
    namespacedDocumentId: string;
    encrypted: boolean;
    context: Context;
  }) => void;

  /**
   * Emitted when a document session is unloaded/disposed.
   * This happens when all clients disconnect and the session times out,
   * when the document is deleted, or when the server is disposing.
   */
  "document-unload": (data: {
    documentId: string;
    namespacedDocumentId: string;
    sessionId: string;
    encrypted: boolean;
    reason: DocumentUnloadReason;
  }) => void;

  /**
   * Emitted when a document is deleted from storage.
   * This happens when deleteDocument is called.
   */
  "document-delete": (data: {
    documentId: string;
    namespacedDocumentId: string;
    encrypted: boolean;
    context: Context;
  }) => void;

  /**
   * Emitted when a document's size exceeds the warning threshold.
   */
  "document-size-warning": (data: {
    documentId: string;
    namespacedDocumentId: string;
    sizeBytes: number;
    warningThreshold: number;
    context: Context;
  }) => void;

  /**
   * Emitted when a document's size exceeds the limit.
   */
  "document-size-limit-exceeded": (data: {
    documentId: string;
    namespacedDocumentId: string;
    sizeBytes: number;
    sizeLimit: number;
    context: Context;
  }) => void;

  /**
   * Emitted when a client connects to the server.
   * This happens when createClient is called.
   * Note: The context may not be available yet (comes with first message).
   */
  "client-connect": (data: { clientId: string; context?: Context }) => void;

  /**
   * Emitted when a client disconnects from the server.
   * This happens when disconnectClient is called or the client stream ends.
   * Note: The context may reflect the state at disconnect time.
   */
  "client-disconnect": (data: {
    clientId: string;
    reason: ClientDisconnectReason;
    context?: Context;
  }) => void;

  /**
   * Emitted when a message flows between client and server.
   * This provides visibility into all traffic for metrics or webhooks.
   * Direction "in" is client->server, "out" is server->client.
   */
  "client-message": (data: {
    clientId: string;
    messageId: string;
    documentId: string | undefined;
    messageType: string;
    payloadType: string | undefined;
    encrypted: boolean;
    context: Context;
    direction: ClientMessageDirection;
    error?: string;
  }) => void;

  /**
   * Emitted when the server starts shutting down.
   * This happens before sessions are disposed.
   */
  "before-server-shutdown": (data: {
    nodeId: string;
    activeSessions: number;
    pendingSessions: number;
  }) => void;

  /**
   * Emitted when the server has completed shutting down.
   */
  "after-server-shutdown": (data: { nodeId: string }) => void;

  /**
   * Emitted when a milestone is created.
   */
  "milestone-created": (data: {
    documentId: string;
    namespacedDocumentId: string;
    milestoneId: string;
    milestoneName: string;
    triggerType?: "manual" | "time-based" | "update-count" | "event-based";
    triggerId?: string;
    context: Context;
  }) => void;

  /**
   * Emitted when a milestone is deleted.
   */
  "milestone-deleted": (data: {
    documentId: string;
    namespacedDocumentId: string;
    milestoneId: string;
    deletedBy?: string;
    context: Context;
  }) => void;

  /**
   * Emitted when a milestone is restored from soft-deletion.
   */
  "milestone-restored": (data: {
    documentId: string;
    namespacedDocumentId: string;
    milestoneId: string;
    context: Context;
  }) => void;

  /**
   * Emitted when rate limit is exceeded
   */
  "rate-limit-exceeded": (data: {
    userId: string;
    documentId?: string;
    trackBy: string;
    currentCount: number;
    maxMessages: number;
    windowMs: number;
    resetAt: number;
  }) => void;

  /**
   * Emitted when rate limit state is updated
   */
  "rate-limit-state-updated": (data: {
    key: string;
    tokens: number;
    trackBy: string;
  }) => void;
};
