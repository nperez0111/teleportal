import * as Y from "yjs";
import type { Message } from "teleportal";
import type { Connection } from "../connection.js";
import type { Provider } from "../provider.js";
import { MessageTracker } from "./message-tracker.js";
import { PeerTracker } from "./peer-tracker.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { DevtoolPanel } from "./ui/panel.js";
import type {
  ConnectionState,
  DevtoolOptions,
  MessageEntry,
  PeerState,
  SyncState,
} from "./types.js";

/**
 * Main Devtool class that integrates message tracking, snapshots, peer tracking, and UI
 */
export class Devtool {
  private provider: Provider<any>;
  private connection: Connection<any>;
  private options: Required<DevtoolOptions>;
  private messageTracker: MessageTracker;
  private snapshotManager: SnapshotManager;
  private peerTracker: PeerTracker;
  private panel: DevtoolPanel | null = null;
  private container: HTMLElement | null = null;

  // Cleanup functions
  private cleanupFns: (() => void)[] = [];

  // State tracking
  private connectionState: ConnectionState | null = null;
  private syncStates: Map<string, SyncState> = new Map();
  private documentProviders: Map<string, Provider<any>> = new Map(); // Track providers per document

  constructor(
    provider: Provider<any>,
    connection: Connection<any>,
    options: DevtoolOptions = {},
  ) {
    this.provider = provider;
    this.connection = connection;
    this.options = {
      maxMessages: options.maxMessages ?? 200,
      maxSnapshots: options.maxSnapshots ?? 50,
      captureSnapshots: options.captureSnapshots ?? true,
      trackSubdocs: options.trackSubdocs ?? true,
      theme: options.theme ?? "system",
    };

    // Initialize trackers
    this.messageTracker = new MessageTracker(this.options);
    this.snapshotManager = new SnapshotManager(this.options);
    this.peerTracker = new PeerTracker(this.options);

    // Set up message tracking callback
    this.messageTracker.setOnMessage((entry) => {
      this.onMessageTracked(entry);
    });

    // Set up peer tracking callback
    this.peerTracker.setOnPeerChange((peers) => {
      if (this.panel) {
        this.panel.updatePeers(peers);
      }
    });

    // Hook into provider
    this.hookProvider();
  }

  /**
   * Mount the devtool to a container element
   */
  mount(container: HTMLElement): void {
    this.container = container;

    // Create and mount panel
    this.panel = new DevtoolPanel(this.options.theme);
    this.panel.mount(container);

    // Initial data update
    this.updatePanel();
  }

  /**
   * Unmount the devtool
   */
  unmount(): void {
    if (this.panel) {
      this.panel.unmount();
      this.panel = null;
    }
    this.container = null;
  }

  /**
   * Hook into the provider to track messages, snapshots, and peers
   */
  private hookProvider(): void {
    // Hook into connection for message tracking
    const connectionCleanup = this.messageTracker.hookConnection(this.connection);
    this.cleanupFns.push(connectionCleanup);

    // Hook into transport streams for message interception
    const transportHooks = this.messageTracker.hookTransportStreams(
      this.provider.transport as any,
    );
    this.cleanupFns.push(transportHooks.cleanup);

    // Replace transport streams with wrapped versions
    // Note: This is a bit tricky - we need to intercept at the right point
    // For now, we'll rely on connection hooks which are simpler

    // Hook into awareness for peer tracking
    const awarenessCleanup = this.peerTracker.hookAwareness(
      this.provider.awareness,
      this.provider.document,
    );
    this.cleanupFns.push(awarenessCleanup);

    // Track main document provider
    this.documentProviders.set(this.provider.document, this.provider);

    // Listen to connection state changes
    const connectionStateCleanup = this.connection.on("update", (state) => {
      this.updateConnectionState(state);
    });
    this.cleanupFns.push(connectionStateCleanup);

    // Listen to provider sync events
    this.provider.doc.on("sync", (synced: boolean) => {
      this.updateSyncState(this.provider.document, synced);
    });

    // Listen to subdoc events if tracking subdocs
    if (this.options.trackSubdocs) {
      const subdocCleanup = this.provider.on("load-subdoc", ({ subdoc, provider, document }) => {
        this.documentProviders.set(document, provider);

        // Hook into subdoc awareness
        const subdocAwarenessCleanup = this.peerTracker.hookAwareness(
          provider.awareness,
          document,
        );
        this.cleanupFns.push(subdocAwarenessCleanup);

        // Track subdoc sync
        provider.doc.on("sync", (synced: boolean) => {
          this.updateSyncState(document, synced);
        });
      });

      const unloadCleanup = this.provider.on("unload-subdoc", ({ document }) => {
        this.documentProviders.delete(document);
        this.syncStates.delete(document);
        if (this.panel) {
          this.panel.updateSyncState(document, false);
        }
      });

      this.cleanupFns.push(subdocCleanup, unloadCleanup);
    }

    // Hook into Y.Doc updates for snapshot capture
    this.hookYDocUpdates();
  }

  /**
   * Hook into Y.Doc updates to capture snapshots
   */
  private hookYDocUpdates(): void {
    // We need to intercept messages before they're applied to capture "before" snapshots
    // and after they're applied to capture "after" snapshots

    // This is complex because we need to intercept at the transport level
    // For now, we'll capture snapshots when we detect update messages

    // Listen to doc updates
    const updateHandler = (update: Uint8Array, origin: any) => {
      // This fires after the update is applied
      // We can't easily capture "before" here, so we'll focus on "after" snapshots
      // The snapshot manager will handle this when we call captureAfter
    };

    this.provider.doc.on("updateV2", updateHandler);
    this.cleanupFns.push(() => {
      this.provider.doc.off("updateV2", updateHandler);
    });
  }

  /**
   * Handle when a message is tracked
   */
  private onMessageTracked(entry: MessageEntry): void {
    // Update panel with new message
    if (this.panel) {
      const allMessages = this.messageTracker.getMessages();
      this.panel.updateMessages(allMessages);
    }

    // Capture snapshots if this is a document update message
    if (this.snapshotManager.shouldCaptureForMessage(entry.message)) {
      const documentId = entry.message.document;
      if (documentId) {
        const provider = this.documentProviders.get(documentId);
        if (provider) {
          // Capture before snapshot (if we can)
          if (entry.direction === "received") {
            this.snapshotManager.captureBefore(entry.id, documentId, provider.doc);
          }

          // We'll capture after snapshot when the update is applied
          // This is handled by listening to doc updates
        }
      }
    }
  }

  /**
   * Update connection state
   */
  private updateConnectionState(state: any): void {
    const timestamp = Date.now();
    let transport: "websocket" | "http" | null = null;

    // Extract transport from state context
    if (state.context && typeof state.context === "object") {
      const context = state.context as { connectionType?: string };
      if (context.connectionType) {
        transport = context.connectionType as "websocket" | "http";
      }
    }

    this.connectionState = {
      type: state.type,
      transport,
      error: state.error?.message,
      timestamp,
    };

    if (this.panel) {
      this.panel.updateConnectionState(this.connectionState);
    }
  }

  /**
   * Update sync state for a document
   */
  private updateSyncState(documentId: string, synced: boolean): void {
    this.syncStates.set(documentId, {
      documentId,
      synced,
      timestamp: Date.now(),
    });

    if (this.panel) {
      this.panel.updateSyncState(documentId, synced);
    }
  }

  /**
   * Update panel with all current data
   */
  private updatePanel(): void {
    if (!this.panel) return;

    const messages = this.messageTracker.getMessages();
    this.panel.updateMessages(messages);

    if (this.connectionState) {
      this.panel.updateConnectionState(this.connectionState);
    }

    for (const syncState of this.syncStates.values()) {
      this.panel.updateSyncState(syncState.documentId, syncState.synced);
    }

    const peers = this.peerTracker.getPeers();
    this.panel.updatePeers(peers);
  }

  /**
   * Get message tracker
   */
  getMessageTracker(): MessageTracker {
    return this.messageTracker;
  }

  /**
   * Get snapshot manager
   */
  getSnapshotManager(): SnapshotManager {
    return this.snapshotManager;
  }

  /**
   * Get peer tracker
   */
  getPeerTracker(): PeerTracker {
    return this.peerTracker;
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.messageTracker.clear();
    this.snapshotManager.clear();
    if (this.panel) {
      this.panel.updateMessages([]);
    }
  }

  /**
   * Destroy the devtool and clean up
   */
  destroy(): void {
    this.unmount();

    // Run all cleanup functions
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];

    // Clear trackers
    this.messageTracker.clear();
    this.snapshotManager.clear();
    this.peerTracker.clear();
  }
}
