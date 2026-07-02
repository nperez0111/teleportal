import { teleportalEventClient } from "teleportal/providers";
import type { DevtoolsMessage, ConnectionStateInfo, Statistics } from "./types";
import type { Message, RawReceivedMessage } from "teleportal";
import { DocumentTracker } from "./utils/document-tracker";
import type { SettingsManager } from "./settings-manager";

export class EventManager {
  private messages: DevtoolsMessage[] = [];
  private messageIndex = new Map<string, number>();
  private connection: any = null;
  private connectionState: ConnectionStateInfo | null = {
    type: "disconnected",
    transport: null,
    availableTransports: [],
    timestamp: Date.now(),
  };
  private statistics: Statistics = {
    totalMessages: 0,
    messagesByType: {},
    sentCount: 0,
    receivedCount: 0,
    connectionState: null,
    documentCount: 0,
    messageRate: 0,
  };

  private tracker = new DocumentTracker();
  private messageRateTimestamps: number[] = [];
  private ackMessages = new Map<
    string,
    {
      ackMessageId: string;
      ackMessage: Message | RawReceivedMessage;
      timestamp: number;
    }
  >();

  private unsubscribers: Array<() => void> = [];
  private listeners = new Set<() => void>();
  private pendingNotify = false;
  private settingsManager: SettingsManager;
  private generation = 0;

  constructor(settingsManager: SettingsManager) {
    this.settingsManager = settingsManager;
    this.setupEventListeners();
  }

  private rebuildIndex() {
    this.messageIndex.clear();
    for (let i = 0; i < this.messages.length; i++) {
      const id = this.messages[i].message.id || this.messages[i].id;
      this.messageIndex.set(id, i);
    }
  }

  private addMessageToStats(msg: DevtoolsMessage) {
    const type = msg.message.type === "doc" ? msg.message.payload.type : msg.message.type;
    this.statistics.messagesByType[type] = (this.statistics.messagesByType[type] || 0) + 1;
    if (msg.direction === "sent") this.statistics.sentCount++;
    else this.statistics.receivedCount++;
    this.statistics.totalMessages = this.messages.length;
  }

  private removeMessageFromStats(msg: DevtoolsMessage) {
    const type = msg.message.type === "doc" ? msg.message.payload.type : msg.message.type;
    if (this.statistics.messagesByType[type]) {
      this.statistics.messagesByType[type]--;
      if (this.statistics.messagesByType[type] <= 0) {
        delete this.statistics.messagesByType[type];
      }
    }
    if (msg.direction === "sent") this.statistics.sentCount--;
    else this.statistics.receivedCount--;
    this.statistics.totalMessages = this.messages.length;
  }

  private refreshStatsMeta() {
    const allDocs = this.tracker.getAllDocuments();
    this.statistics.documentCount = allDocs.length;
    this.statistics.connectionState = this.connectionState;

    const now = Date.now();
    this.messageRateTimestamps = this.messageRateTimestamps.filter((ts) => now - ts < 10000);
    this.statistics.messageRate = this.messageRateTimestamps.length / 10;
  }

  private setupEventListeners() {
    // Listen to received messages
    const unsubReceived = teleportalEventClient.on(
      "teleportal-provider:received-message",
      (event) => {
        const { message, provider, connection } = event.payload;

        if (connection) this.connection = connection;

        // Check connection state from the connection object if available
        if (connection && typeof connection.state === "object" && connection.state) {
          const connState = connection.state;
          const transport = connState.type === "connected" ? (connState.transport ?? null) : null;
          if (
            (connState.type && connState.type !== this.connectionState?.type) ||
            transport !== this.connectionState?.transport
          ) {
            const newState: ConnectionStateInfo = {
              type: connState.type,
              hosting: connection.hosting,
              transport,
              availableTransports: connection.availableTransports ?? [],
              error:
                connState.type === "errored"
                  ? connState.error?.message || String(connState.error)
                  : undefined,
              timestamp: Date.now(),
            };
            this.connectionState = newState;
          }
        }

        // Handle ACK messages separately - don't add to list, but track them
        if (message.type === "ack" && message.payload?.type === "ack") {
          const ackedMessageId = message.payload.messageId;
          if (ackedMessageId) {
            const ackMessageId = message.id;

            // Store ACK info
            this.ackMessages.set(ackedMessageId, {
              ackMessageId,
              ackMessage: message,
              timestamp: Date.now(),
            });

            // Update the corresponding message to mark it as ACKed
            const msgIndex = this.messageIndex.get(ackedMessageId);
            if (msgIndex !== undefined) {
              this.messages[msgIndex] = {
                ...this.messages[msgIndex],
                ackedBy: {
                  ackMessageId,
                  ackMessage: message,
                  timestamp: Date.now(),
                },
              };
              this.generation++;
              this.refreshStatsMeta();
              this.emitChange();
            }
          }

          this.messageRateTimestamps.push(Date.now());
          return;
        }

        const docId = message.document || "unknown";
        this.tracker.addDocument(docId, provider, docId);
        this.tracker.updateDocumentActivity(docId);

        const messageId = message.id;

        // O(1) duplicate check
        if (this.messageIndex.has(messageId)) {
          this.messageRateTimestamps.push(Date.now());
          return;
        }

        const devtoolsMessage: DevtoolsMessage = {
          id: messageId,
          message,
          direction: "received",
          timestamp: Date.now(),
          document: docId,
          provider,
          connection,
        };

        this.messages.push(devtoolsMessage);
        this.messageIndex.set(messageId, this.messages.length - 1);

        // Enforce message limit
        const limit = this.settingsManager.getSettings().messageLimit;
        if (this.messages.length > limit) {
          const removed = this.messages.splice(0, this.messages.length - limit);
          for (const msg of removed) {
            this.removeMessageFromStats(msg);
          }
          this.rebuildIndex();
        }

        this.addMessageToStats(devtoolsMessage);
        this.messageRateTimestamps.push(Date.now());
        this.generation++;
        this.refreshStatsMeta();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubReceived);

    // Listen to sent messages
    const unsubSent = teleportalEventClient.on(
      "teleportal-provider:sent-message",
      (event) => {
        const { message, provider, connection } = event.payload;

        if (connection) this.connection = connection;

        // Check connection state from the connection object if available
        if (connection && typeof connection.state === "object" && connection.state) {
          const connState = connection.state;
          if (connState.type && connState.type !== this.connectionState?.type) {
            const newState: ConnectionStateInfo = {
              type: connState.type,
              hosting: connection.hosting,
              transport: connState.type === "connected" ? (connState.transport ?? null) : null,
              availableTransports: connection.availableTransports ?? [],
              error:
                connState.type === "errored"
                  ? connState.error?.message || String(connState.error)
                  : undefined,
              timestamp: Date.now(),
            };
            this.connectionState = newState;
          }
        }

        // Handle ACK messages separately - don't add to list, but track them
        if (message.type === "ack" && message.payload?.type === "ack") {
          const ackedMessageId = message.payload.messageId;
          if (ackedMessageId) {
            const ackMessageId = message.id;

            // Store ACK info
            this.ackMessages.set(ackedMessageId, {
              ackMessageId,
              ackMessage: message,
              timestamp: Date.now(),
            });

            // Update the corresponding message to mark it as ACKed
            const msgIndex = this.messageIndex.get(ackedMessageId);
            if (msgIndex !== undefined) {
              this.messages[msgIndex] = {
                ...this.messages[msgIndex],
                ackedBy: {
                  ackMessageId,
                  ackMessage: message,
                  timestamp: Date.now(),
                },
              };
              this.generation++;
              this.refreshStatsMeta();
              this.emitChange();
            }
          }

          this.messageRateTimestamps.push(Date.now());
          return;
        }

        const docId = message.document || "unknown";
        this.tracker.addDocument(docId, provider, docId);
        this.tracker.updateDocumentActivity(docId);

        const messageId = message.id;

        // O(1) duplicate check
        if (this.messageIndex.has(messageId)) {
          this.messageRateTimestamps.push(Date.now());
          return;
        }

        const devtoolsMessage: DevtoolsMessage = {
          id: messageId,
          message,
          direction: "sent",
          timestamp: Date.now(),
          document: docId,
          provider,
          connection,
        };

        this.messages.push(devtoolsMessage);
        this.messageIndex.set(messageId, this.messages.length - 1);
        const limit = this.settingsManager.getSettings().messageLimit;
        if (this.messages.length > limit) {
          const removed = this.messages.splice(0, this.messages.length - limit);
          for (const msg of removed) {
            this.removeMessageFromStats(msg);
          }
          this.rebuildIndex();
        }

        this.addMessageToStats(devtoolsMessage);
        this.messageRateTimestamps.push(Date.now());
        this.generation++;
        this.refreshStatsMeta();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubSent);

    // Listen to subdoc load (may not be emitted to teleportalEventClient, but try anyway)
    try {
      const unsubLoadSubdoc = teleportalEventClient.on(
        "teleportal-provider:load-subdoc",
        (event: any) => {
          const { document, provider } = event.payload;
          this.tracker.addDocument(document, provider, document);
          this.refreshStatsMeta();
          this.emitChange();
        },
        { withEventTarget: true },
      );
      this.unsubscribers.push(unsubLoadSubdoc);
    } catch {
      // Event might not be available
    }

    // Listen to subdoc unload (may not be emitted to teleportalEventClient, but try anyway)
    try {
      const unsubUnloadSubdoc = teleportalEventClient.on(
        "teleportal-provider:unload-subdoc",
        (event: any) => {
          const { document } = event.payload;
          this.tracker.removeDocument(document);
          this.refreshStatsMeta();
          this.emitChange();
        },
        { withEventTarget: true },
      );
      this.unsubscribers.push(unsubUnloadSubdoc);
    } catch {
      // Event might not be available
    }

    // Listen to connection events
    const unsubConnected = teleportalEventClient.on(
      "teleportal-provider:connected",
      (event) => {
        const connection = event.payload.connection;
        if (connection) this.connection = connection;
        const connState = connection?.state;
        const newState: ConnectionStateInfo = {
          type: "connected",
          hosting: connection?.hosting,
          transport: connState?.type === "connected" ? (connState.transport ?? null) : null,
          availableTransports: connection?.availableTransports ?? [],
          timestamp: Date.now(),
        };
        this.connectionState = newState;
        this.refreshStatsMeta();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubConnected);

    const unsubDisconnected = teleportalEventClient.on(
      "teleportal-provider:disconnected",
      (_event) => {
        const newState: ConnectionStateInfo = {
          type: "disconnected",
          hosting: this.connection?.hosting,
          transport: null,
          availableTransports: this.connection?.availableTransports ?? [],
          timestamp: Date.now(),
        };
        this.connectionState = newState;
        this.refreshStatsMeta();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubDisconnected);

    const unsubUpdate = teleportalEventClient.on(
      "teleportal-provider:update",
      (event) => {
        const { state } = event.payload;
        const newState: ConnectionStateInfo = {
          type: state.type,
          hosting: this.connection?.hosting,
          transport: state.type === "connected" ? (state.transport ?? null) : null,
          availableTransports: this.connection?.availableTransports ?? [],
          error: state.type === "errored" ? state.error?.message || String(state.error) : undefined,
          timestamp: Date.now(),
        };
        this.connectionState = newState;
        this.refreshStatsMeta();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubUpdate);

    // Listen to settings changes to update message limit
    this.settingsManager.subscribe(() => {
      const limit = this.settingsManager.getSettings().messageLimit;
      if (this.messages.length > limit) {
        const removed = this.messages.splice(0, this.messages.length - limit);
        for (const msg of removed) {
          this.removeMessageFromStats(msg);
        }
        this.rebuildIndex();
        this.statistics.totalMessages = this.messages.length;
        this.generation++;
        this.refreshStatsMeta();
        this.emitChange();
      }
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange() {
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    queueMicrotask(() => {
      this.pendingNotify = false;
      this.listeners.forEach((l) => l());
    });
  }

  getMessages(): DevtoolsMessage[] {
    return this.messages;
  }

  getGeneration(): number {
    return this.generation;
  }

  getConnectionState(): ConnectionStateInfo | null {
    return this.connectionState;
  }

  getStatistics(): Statistics {
    return this.statistics;
  }

  async switchTransport(name: string): Promise<void> {
    if (this.connection && typeof this.connection.switchTransport === "function") {
      await this.connection.switchTransport(name);
    }
  }

  clearMessages() {
    this.messages = [];
    this.messageIndex.clear();
    this.ackMessages.clear();
    this.messageRateTimestamps = [];
    this.statistics = {
      totalMessages: 0,
      messagesByType: {},
      sentCount: 0,
      receivedCount: 0,
      connectionState: this.connectionState,
      documentCount: this.statistics.documentCount,
      messageRate: 0,
    };
    this.generation++;
    this.emitChange();
  }

  destroy() {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
    this.listeners.clear();
  }
}
