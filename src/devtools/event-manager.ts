import { teleportalEventClient } from "teleportal/providers";
import { onFileTransferProgress, type FileTransferProgress } from "teleportal/protocols/file";
import type {
  DevtoolsMessage,
  ConnectionStateInfo,
  ConnectionTimelineEntry,
  DocumentState,
  Statistics,
} from "./types";
import type { Message, RawReceivedMessage } from "teleportal";
import { DocumentTracker } from "./utils/document-tracker";
import {
  PresenceTracker,
  type PresenceFeedEntry,
  type PresencePeer,
} from "./utils/presence-tracker";
import { formatDuration } from "./utils/message-utils";
import type { SettingsManager } from "./settings-manager";

const TIMELINE_LIMIT = 200;
const TRANSFER_PROGRESS_LIMIT = 100;

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
  private presence = new PresenceTracker();
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

  private timeline: ConnectionTimelineEntry[] = [];
  private lastConnectedAt: number | null = null;
  private diagnosticUnsubscribe: (() => void) | null = null;

  /**
   * Live file-transfer progress by fileId. Chunk messages deliberately stay
   * off the message pipeline (see Connection.sendStream), so transfer state
   * arrives via the file protocol's tiny progress events instead.
   */
  private transferProgress = new Map<string, FileTransferProgress>();

  constructor(settingsManager: SettingsManager) {
    this.settingsManager = settingsManager;
    this.setupEventListeners();
  }

  /**
   * Captures the connection object and subscribes to its diagnostic events
   * (token refreshes, reconnect scheduling, upgrade probes) for the timeline.
   */
  private attachConnection(connection: any) {
    if (!connection || connection === this.connection) return;
    this.connection = connection;
    this.diagnosticUnsubscribe?.();
    this.diagnosticUnsubscribe = null;
    if (typeof connection.on === "function") {
      try {
        this.diagnosticUnsubscribe = connection.on("diagnostic", (event: any) => {
          this.recordDiagnostic(event);
          this.emitChange();
        });
      } catch {
        // Connection implementation without diagnostic events
      }
    }
  }

  private pushTimeline(entry: ConnectionTimelineEntry) {
    this.timeline.push(entry);
    if (this.timeline.length > TIMELINE_LIMIT) {
      this.timeline.splice(0, this.timeline.length - TIMELINE_LIMIT);
    }
    this.generation++;
  }

  private recordDiagnostic(event: any) {
    switch (event?.type) {
      case "token-refresh":
        this.pushTimeline({
          timestamp: Date.now(),
          kind: "info",
          label: `token refreshed (${event.reason})`,
        });
        break;
      case "token-refresh-error":
        this.pushTimeline({
          timestamp: Date.now(),
          kind: "warn",
          label: "token refresh failed",
          detail: event.error,
        });
        break;
      case "reconnect-scheduled":
        this.pushTimeline({
          timestamp: Date.now(),
          kind: "info",
          label: `reconnect #${event.attempt}/${event.maxAttempts} in ${formatDuration(event.delayMs)}`,
        });
        break;
      case "upgrade-probe":
        this.pushTimeline({
          timestamp: Date.now(),
          kind: "info",
          label:
            event.result === "upgraded"
              ? "upgraded to preferred transport (probe succeeded)"
              : "upgrade probe: preferred transport still unavailable",
        });
        break;
    }
  }

  /**
   * Single write path for connection state: dedupes repeats (multiple
   * providers observe the same connection) and records real transitions on
   * the timeline.
   */
  private applyConnectionState(newState: ConnectionStateInfo) {
    const prev = this.connectionState;
    if (
      prev &&
      prev.type === newState.type &&
      prev.transport === newState.transport &&
      prev.error === newState.error
    ) {
      return;
    }

    this.connectionState = newState;
    if (newState.type === "connected") {
      this.lastConnectedAt = newState.timestamp;
    }

    const label =
      newState.type === "connected" || newState.type === "connecting"
        ? `${newState.type}${newState.transport ? ` (${newState.transport})` : ""}`
        : newState.type;
    this.pushTimeline({
      timestamp: newState.timestamp,
      kind: newState.type,
      label,
      detail: newState.error,
    });
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

        this.attachConnection(connection);

        // Check connection state from the connection object if available
        if (connection && typeof connection.state === "object" && connection.state) {
          const connState = connection.state;
          if (connState.type) {
            this.applyConnectionState({
              type: connState.type,
              hosting: connection.hosting,
              transport: connState.type === "connected" ? (connState.transport ?? null) : null,
              availableTransports: connection.availableTransports ?? [],
              error:
                connState.type === "errored"
                  ? connState.error?.message || String(connState.error)
                  : undefined,
              timestamp: Date.now(),
            });
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

        const messageId = message.id;

        // O(1) duplicate check
        if (this.messageIndex.has(messageId)) {
          this.messageRateTimestamps.push(Date.now());
          return;
        }

        this.tracker.recordMessage(docId, message, "received");
        this.presence.recordMessage(message);

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
    );
    this.unsubscribers.push(unsubReceived);

    // Listen to sent messages
    const unsubSent = teleportalEventClient.on("teleportal-provider:sent-message", (event) => {
      const { message, provider, connection } = event.payload;

      this.attachConnection(connection);

      // Check connection state from the connection object if available
      if (connection && typeof connection.state === "object" && connection.state) {
        const connState = connection.state;
        if (connState.type) {
          this.applyConnectionState({
            type: connState.type,
            hosting: connection.hosting,
            transport: connState.type === "connected" ? (connState.transport ?? null) : null,
            availableTransports: connection.availableTransports ?? [],
            error:
              connState.type === "errored"
                ? connState.error?.message || String(connState.error)
                : undefined,
            timestamp: Date.now(),
          });
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

      const messageId = message.id;

      // O(1) duplicate check
      if (this.messageIndex.has(messageId)) {
        this.messageRateTimestamps.push(Date.now());
        return;
      }

      this.tracker.recordMessage(docId, message, "sent");

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
    });
    this.unsubscribers.push(unsubSent);

    // Listen to subdoc load (may not be emitted to teleportalEventClient, but try anyway)
    try {
      const unsubLoadSubdoc = teleportalEventClient.on(
        "teleportal-provider:load-subdoc",
        (event: any) => {
          // `document` is the PARENT provider's document; the subdoc's own
          // provider carries the namespaced id ("parent/guid").
          const { document, provider, subdoc } = event.payload;
          this.tracker.addDocument(document, provider, document);
          this.tracker.addDocument(provider?.document ?? document, provider, subdoc?.guid, {
            parentId: document,
            isSubdoc: true,
          });
          this.refreshStatsMeta();
          this.generation++;
          this.emitChange();
        },
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
          const { document, provider } = event.payload;
          this.tracker.removeDocument(provider?.document ?? document);
          this.refreshStatsMeta();
          this.generation++;
          this.emitChange();
        },
      );
      this.unsubscribers.push(unsubUnloadSubdoc);
    } catch {
      // Event might not be available
    }

    // Listen to connection events
    const unsubConnected = teleportalEventClient.on("teleportal-provider:connected", (event) => {
      const connection = event.payload.connection;
      this.attachConnection(connection);
      const connState = connection?.state;
      this.applyConnectionState({
        type: "connected",
        hosting: connection?.hosting,
        transport: connState?.type === "connected" ? (connState.transport ?? null) : null,
        availableTransports: connection?.availableTransports ?? [],
        timestamp: Date.now(),
      });
      this.refreshStatsMeta();
      this.emitChange();
    });
    this.unsubscribers.push(unsubConnected);

    const unsubDisconnected = teleportalEventClient.on(
      "teleportal-provider:disconnected",
      (_event) => {
        this.applyConnectionState({
          type: "disconnected",
          hosting: this.connection?.hosting,
          transport: null,
          availableTransports: this.connection?.availableTransports ?? [],
          timestamp: Date.now(),
        });
        // Every document re-syncs on the next connection.
        this.tracker.resetSyncState();
        // Peers re-join on the next connection.
        this.presence.clearPeers();
        this.generation++;
        this.refreshStatsMeta();
        this.emitChange();
      },
    );
    this.unsubscribers.push(unsubDisconnected);

    const unsubUpdate = teleportalEventClient.on("teleportal-provider:update", (event) => {
      const { state, connection } = event.payload;
      this.attachConnection(connection);
      this.applyConnectionState({
        type: state.type,
        hosting: this.connection?.hosting,
        transport: state.type === "connected" ? (state.transport ?? null) : null,
        availableTransports: this.connection?.availableTransports ?? [],
        error: state.type === "errored" ? state.error?.message || String(state.error) : undefined,
        timestamp: Date.now(),
      });
      this.refreshStatsMeta();
      this.emitChange();
    });
    this.unsubscribers.push(unsubUpdate);

    // File-transfer progress (uploads have no visible chunk messages)
    this.unsubscribers.push(
      onFileTransferProgress((progress) => {
        // Delete-then-set keeps insertion order = recency for eviction.
        this.transferProgress.delete(progress.fileId);
        this.transferProgress.set(progress.fileId, progress);
        if (this.transferProgress.size > TRANSFER_PROGRESS_LIMIT) {
          const oldest = this.transferProgress.keys().next().value;
          if (oldest !== undefined) this.transferProgress.delete(oldest);
        }
        this.generation++;
        this.emitChange();
      }),
    );

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

  getConnectionTimeline(): ConnectionTimelineEntry[] {
    return this.timeline;
  }

  getTransferProgress(): ReadonlyMap<string, FileTransferProgress> {
    return this.transferProgress;
  }

  getConnection(): any {
    return this.connection;
  }

  /** Timestamp of the last transition into "connected", for uptime display. */
  getLastConnectedAt(): number | null {
    return this.lastConnectedAt;
  }

  getPresencePeers(): PresencePeer[] {
    if (this.presencePeersCache && this.presenceCacheGeneration === this.generation) {
      return this.presencePeersCache;
    }
    this.presencePeersCache = this.presence.getPeers();
    this.presenceCacheGeneration = this.generation;
    return this.presencePeersCache;
  }

  getPresenceFeed(): PresenceFeedEntry[] {
    return this.presence.getFeed();
  }

  private presencePeersCache: PresencePeer[] | null = null;
  private presenceCacheGeneration = -1;

  private documentsCache: DocumentState[] | null = null;
  private documentsCacheGeneration = -1;

  getDocuments(): DocumentState[] {
    if (this.documentsCache && this.documentsCacheGeneration === this.generation) {
      return this.documentsCache;
    }
    this.documentsCache = this.tracker.getAllDocuments();
    this.documentsCacheGeneration = this.generation;
    return this.documentsCache;
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
    this.diagnosticUnsubscribe?.();
    this.diagnosticUnsubscribe = null;
    this.listeners.clear();
  }
}
