import { EventClient } from "@tanstack/devtools-event-client";
import { Message } from "teleportal";

export type ConnectionState =
  | { type: "connected"; transport: "websocket" | "http" }
  | { type: "connecting"; transport: "websocket" | "http" | null }
  | { type: "disconnected"; transport: null }
  | { type: "errored"; error: string; transport: null };

export type MessageEntry = {
  direction: "sent" | "received";
  message: Message;
  timestamp: number;
};

export type SyncState = {
  documentId: string;
  synced: boolean;
};

export type AwarenessState = {
  peers: Map<number, Record<string, unknown>>;
};

export type TeleportalEventMap = {
  "teleportal:connection-state": ConnectionState & { timestamp: number };
  "teleportal:sync-state": SyncState & { timestamp: number };
  "teleportal:awareness-state": AwarenessState & { timestamp: number };
  "teleportal:message-log": MessageEntry;
};

export class TeleportalEventClient extends EventClient<TeleportalEventMap> {
  constructor() {
    super({
      pluginId: "teleportal",
      debug: false,
    });
  }
}

export const teleportalEventClient = new TeleportalEventClient();
