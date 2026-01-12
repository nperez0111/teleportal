import type { Message } from "teleportal";
import type * as Y from "yjs";

/**
 * Direction of a message (sent from provider or received by provider)
 */
export type MessageDirection = "sent" | "received";

/**
 * Connection state type
 */
export type ConnectionStateType = "connected" | "connecting" | "disconnected" | "errored";

/**
 * Transport type
 */
export type TransportType = "websocket" | "http" | null;

/**
 * Connection state with transport information
 */
export type ConnectionState = {
  type: ConnectionStateType;
  transport: TransportType;
  error?: string;
  timestamp: number;
};

/**
 * A logged message entry with metadata
 */
export type MessageEntry = {
  id: string;
  direction: MessageDirection;
  message: Message;
  timestamp: number;
  documentId: string | undefined;
  size: number; // Size in bytes
};

/**
 * Sync state for a document
 */
export type SyncState = {
  documentId: string;
  synced: boolean;
  timestamp: number;
};

/**
 * Peer awareness state
 */
export type PeerState = {
  clientId: number;
  awareness: Record<string, unknown>;
  documents: Set<string>; // Documents this peer is on
  lastSeen: number;
};

/**
 * Snapshot data captured before/after a message
 */
export type SnapshotData = {
  messageId: string;
  documentId: string;
  before: Uint8Array | null; // null if snapshot wasn't captured
  after: Uint8Array | null;
  timestamp: number;
};

/**
 * Message type configuration for UI display
 */
export type MessageTypeConfig = {
  type: "doc" | "awareness" | "ack" | "file";
  payloadType?: string;
  icon: string;
  label: string;
  color?: string;
};

/**
 * Filter configuration
 */
export type FilterConfig = {
  direction: "all" | "sent" | "received";
  messageTypes: Set<string>; // Set of message type keys (e.g., "doc:update", "awareness:awareness-update")
  documentIds: Set<string>; // Filter by document IDs
  search: string; // Text search
  dateRange?: {
    start: number;
    end: number;
  };
};

/**
 * Statistics tracked by the devtool
 */
export type DevtoolStats = {
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  startTime: number;
  documents: Set<string>;
  peers: Map<number, PeerState>;
};

/**
 * UI theme
 */
export type Theme = "light" | "dark" | "system";

/**
 * Devtool options
 */
export type DevtoolOptions = {
  maxMessages?: number; // Default: 200
  maxSnapshots?: number; // Default: 50
  captureSnapshots?: boolean; // Default: true
  trackSubdocs?: boolean; // Default: true
  theme?: Theme; // Default: "system"
};

/**
 * Document information
 */
export type DocumentInfo = {
  id: string;
  isSubdoc: boolean;
  parentDocId?: string;
  synced: boolean;
  messageCount: number;
  lastActivity: number;
};

/**
 * UI panel state
 */
export type PanelState = {
  selectedMessageId: string | null;
  selectedDocumentId: string | null;
  expandedSections: Set<string>;
  filters: FilterConfig;
  theme: Theme;
  view: "messages" | "peers" | "stats" | "documents";
};
