import type { TeleportalEventClient } from "./event-client.js";

export interface PanelOptions {
  eventClient: TeleportalEventClient;
  maxMessageEntries?: number;
}

export interface ConnectionTimelineEntry {
  state: string;
  transport: string | null;
  timestamp: number;
}

export interface MessageFilter {
  direction: "all" | "sent" | "received";
  types: Set<string>;
  search: string;
}

export interface MessageTypeConfig {
  type: string;
  payloadType: string | undefined;
  icon: string;
  label: string;
}

export interface Milestone {
  id: string;
  name: string;
  timestamp: number;
}

export interface PanelStats {
  sent: number;
  received: number;
  bytesSent: number;
  bytesReceived: number;
  startTime: number;
}

export type Theme = "system" | "light" | "dark";
