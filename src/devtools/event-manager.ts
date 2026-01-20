import { teleportalEventClient } from "teleportal/providers";
import type { DevtoolsMessage, ConnectionStateInfo, Statistics } from "./types";
import type { Message, RawReceivedMessage } from "teleportal";
import { DocumentTracker } from "./utils/document-tracker";
import type { SettingsManager } from "./settings-manager";

export class EventManager {
  private messages: DevtoolsMessage[] = [];
  private connectionState: ConnectionStateInfo | null = {
    type: "disconnected",
    transport: null,
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
  private settingsManager: SettingsManager;

  constructor(settingsManager: SettingsManager) {
    this.settingsManager = settingsManager;
    this.setupEventListeners();
  }

  private setupEventListeners() {
    // Listen to received messages
    const unsubReceived = teleportalEventClient.on(
      "received-message",
      (event) => {
        const { message, provider, connection } = event.payload;

        // Check connection state from the connection object if available
        if (
          connection &&
          typeof connection.state === "object" &&
          connection.state
        ) {
          const connState = connection.state;
          const transport =
            connState.type === "connected"
              ? connState.context.connectionType
              : null;
          if (
            (connState.type && connState.type !== this.connectionState?.type) ||
            transport !== this.connectionState?.transport
          ) {
            const newState: ConnectionStateInfo = {
              type: connState.type,
              transport,
              error:
                connState.type === "errored"
                  ? connState.error?.message || String(connState.error)
                  : undefined,
              timestamp: Date.now(),
            };
            this.connectionState = newState;
            this.updateStatistics();
            this.emitChange();
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
            const msgIndex = this.messages.findIndex((msg) => {
              const msgId = msg.message.id || msg.id;
              return msgId === ackedMessageId;
            });
            if (msgIndex !== -1) {
              this.messages[msgIndex] = {
                ...this.messages[msgIndex],
                ackedBy: {
                  ackMessageId,
                  ackMessage: message,
                  timestamp: Date.now(),
                },
              };
              this.updateStatistics();
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

        // Check for duplicates by message ID before adding
        const existing = this.messages.find((msg) => {
          const msgId = msg.message.id || msg.id;
          return msgId === messageId;
        });
        if (existing) {
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
        // Enforce message limit
        const limit = this.settingsManager.getSettings().messageLimit;
        if (this.messages.length > limit) {
          this.messages = this.messages.slice(-limit);
        }

        this.messageRateTimestamps.push(Date.now());
        this.updateStatistics();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubReceived);

    // Listen to sent messages
    const unsubSent = teleportalEventClient.on(
      "sent-message",
      (event) => {
        const { message, provider, connection } = event.payload;

        // Check connection state from the connection object if available
        if (
          connection &&
          typeof connection.state === "object" &&
          connection.state
        ) {
          const connState = connection.state;
          if (connState.type && connState.type !== this.connectionState?.type) {
            const newState: ConnectionStateInfo = {
              type: connState.type,
              transport: connState.type === "connected" ? "websocket" : null,
              error:
                connState.type === "errored"
                  ? connState.error?.message || String(connState.error)
                  : undefined,
              timestamp: Date.now(),
            };
            this.connectionState = newState;
            this.updateStatistics();
            this.emitChange();
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
            const msgIndex = this.messages.findIndex((msg) => {
              const msgId = msg.message.id || msg.id;
              return msgId === ackedMessageId;
            });
            if (msgIndex !== -1) {
              this.messages[msgIndex] = {
                ...this.messages[msgIndex],
                ackedBy: {
                  ackMessageId,
                  ackMessage: message,
                  timestamp: Date.now(),
                },
              };
              this.updateStatistics();
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

        // Check for duplicates by message ID before adding
        const existing = this.messages.find((msg) => {
          const msgId = msg.message.id || msg.id;
          return msgId === messageId;
        });
        if (existing) {
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
        const limit = this.settingsManager.getSettings().messageLimit;
        if (this.messages.length > limit) {
          this.messages = this.messages.slice(-limit);
        }

        this.messageRateTimestamps.push(Date.now());
        this.updateStatistics();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubSent);

    // Listen to subdoc load (may not be emitted to teleportalEventClient, but try anyway)
    try {
      const unsubLoadSubdoc = teleportalEventClient.on(
        "load-subdoc",
        (event: any) => {
          const { document, provider } = event.payload;
          this.tracker.addDocument(document, provider, document);
          this.updateStatistics();
          this.emitChange();
        },
        { withEventTarget: true },
      );
      this.unsubscribers.push(unsubLoadSubdoc);
    } catch (e) {
      // Event might not be available
    }

    // Listen to subdoc unload (may not be emitted to teleportalEventClient, but try anyway)
    try {
      const unsubUnloadSubdoc = teleportalEventClient.on(
        "unload-subdoc",
        (event: any) => {
          const { document } = event.payload;
          this.tracker.removeDocument(document);
          this.updateStatistics();
          this.emitChange();
        },
        { withEventTarget: true },
      );
      this.unsubscribers.push(unsubUnloadSubdoc);
    } catch (e) {
      // Event might not be available
    }

    // Listen to connection events
    const unsubConnected = teleportalEventClient.on(
      "connected",
      (event) => {
        const newState = {
          type: "connected" as const,
          transport: "websocket" as const,
          timestamp: Date.now(),
        };
        this.connectionState = newState;
        this.updateStatistics();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubConnected);

    const unsubDisconnected = teleportalEventClient.on(
      "disconnected",
      (event) => {
        const newState = {
          type: "disconnected" as const,
          transport: null,
          timestamp: Date.now(),
        };
        this.connectionState = newState;
        this.updateStatistics();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubDisconnected);

    const unsubUpdate = teleportalEventClient.on(
      "update",
      (event) => {
        const { state } = event.payload;
        const newState: ConnectionStateInfo = {
          type: state.type,
          transport: state.type === "connected" ? "websocket" : null,
          error:
            state.type === "errored"
              ? state.error?.message || String(state.error)
              : undefined,
          timestamp: Date.now(),
        };
        this.connectionState = newState;
        this.updateStatistics();
        this.emitChange();
      },
      { withEventTarget: true },
    );
    this.unsubscribers.push(unsubUpdate);

    // Listen to settings changes to update message limit
    this.settingsManager.subscribe(() => {
      const limit = this.settingsManager.getSettings().messageLimit;
      if (this.messages.length > limit) {
        this.messages = this.messages.slice(-limit);
        this.updateStatistics();
        this.emitChange();
      }
    });
  }

  private updateStatistics() {
    const allDocs = this.tracker.getAllDocuments();

    const messagesByType: Record<string, number> = {};
    let sentCount = 0;
    let receivedCount = 0;

    this.messages.forEach((msg) => {
      const type =
        msg.message.type === "doc"
          ? msg.message.payload.type
          : msg.message.type;
      messagesByType[type] = (messagesByType[type] || 0) + 1;

      if (msg.direction === "sent") sentCount++;
      else receivedCount++;
    });

    // Calculate message rate (messages per second over last 10 seconds)
    const now = Date.now();
    this.messageRateTimestamps = this.messageRateTimestamps.filter(
      (ts) => now - ts < 10000,
    );
    const rate = this.messageRateTimestamps.length / 10;

    this.statistics = {
      totalMessages: this.messages.length,
      messagesByType,
      sentCount,
      receivedCount,
      connectionState: this.connectionState,
      documentCount: allDocs.length,
      messageRate: rate,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange() {
    this.listeners.forEach((l) => l());
  }

  getMessages(): DevtoolsMessage[] {
    return this.messages;
  }

  getConnectionState(): ConnectionStateInfo | null {
    return this.connectionState;
  }

  getStatistics(): Statistics {
    return this.statistics;
  }

  clearMessages() {
    this.messages = [];
    this.ackMessages.clear();
    this.messageRateTimestamps = [];
    this.updateStatistics();
    this.emitChange();
  }

  destroy() {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
    this.listeners.clear();
  }
}
