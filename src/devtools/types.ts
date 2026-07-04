import type { Message, RawReceivedMessage } from "teleportal";
import type { Provider } from "teleportal/providers";

export type DevtoolsMessage = {
  id: string;
  message: Message | RawReceivedMessage;
  direction: "sent" | "received";
  timestamp: number;
  document: string | undefined;
  provider: Provider;
  connection: any;
  ackedBy?: {
    ackMessageId: string;
    ackMessage: Message | RawReceivedMessage;
    timestamp: number;
  };
};

/**
 * Where a document is in the sync handshake. "idle" means no sync activity
 * on the current connection (e.g. after a disconnect).
 */
export type DocumentSyncPhase = "idle" | "sync-step-1" | "sync-step-2" | "synced";

export type DocumentState = {
  id: string;
  name: string;
  provider: Provider;
  /** Document id of the parent, for subdocuments. */
  parentId?: string;
  isSubdoc: boolean;
  encrypted: boolean;
  syncPhase: DocumentSyncPhase;
  messageCount: number;
  bytesSent: number;
  bytesReceived: number;
  lastActivity: number;
};

export type ConnectionStateInfo = {
  type: "connected" | "connecting" | "disconnected" | "errored";
  hosting?: "direct" | "worker";
  transport: string | null;
  availableTransports: string[];
  error?: string;
  timestamp: number;
};

/**
 * One entry in the connection timeline: a state transition or a notable
 * diagnostic event (token refresh, reconnect scheduling, upgrade probe).
 */
export type ConnectionTimelineEntry = {
  timestamp: number;
  kind: "connected" | "connecting" | "disconnected" | "errored" | "info" | "warn";
  label: string;
  /** Full error text or extra context, shown on hover/expansion. */
  detail?: string;
};

export type Statistics = {
  totalMessages: number;
  messagesByType: Record<string, number>;
  sentCount: number;
  receivedCount: number;
  connectionState: ConnectionStateInfo | null;
  documentCount: number;
  messageRate: number; // messages per second
};

export type FilterState = {
  documentIds: string[];
  /**
   * Message types that should be hidden from the list.
   * Empty means "show all types".
   */
  hiddenMessageTypes: string[];
  direction: "all" | "sent" | "received";
  searchText: string;
};

export type DevtoolsSettings = {
  messageLimit: number;
  filters: FilterState;
};
