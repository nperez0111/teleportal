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

export type DocumentState = {
  id: string;
  name: string;
  provider: Provider;
  synced: boolean;
  messageCount: number;
  lastActivity: number;
};

export type ConnectionStateInfo = {
  type: "connected" | "connecting" | "disconnected" | "errored";
  transport: "websocket" | "http" | null;
  error?: string;
  timestamp: number;
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
