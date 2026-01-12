import * as Y from "yjs";
import type { Message } from "teleportal";
import type { DevtoolOptions, SnapshotData } from "./types.js";

/**
 * Manages Y.js document snapshots for before/after message comparison
 */
export class SnapshotManager {
  private snapshots: Map<string, SnapshotData> = new Map();
  private maxSnapshots: number;
  private captureEnabled: boolean;
  private documentSnapshots: Map<string, Uint8Array> = new Map(); // Current snapshot per document

  constructor(options: DevtoolOptions = {}) {
    this.maxSnapshots = options.maxSnapshots ?? 50;
    this.captureEnabled = options.captureSnapshots ?? true;
  }

  /**
   * Capture snapshot before applying a message
   */
  captureBefore(messageId: string, documentId: string, ydoc: Y.Doc): void {
    if (!this.captureEnabled) return;

    // Only capture for document update messages
    if (!this.shouldCaptureSnapshot(documentId, ydoc)) {
      return;
    }

    try {
      const snapshot = Y.encodeStateAsUpdateV2(ydoc);
      this.documentSnapshots.set(documentId, snapshot);

      // Get or create snapshot data
      let snapshotData = this.snapshots.get(messageId);
      if (!snapshotData) {
        snapshotData = {
          messageId,
          documentId,
          before: null,
          after: null,
          timestamp: Date.now(),
        };
        this.snapshots.set(messageId, snapshotData);
      }
      snapshotData.before = snapshot;
    } catch (error) {
      console.warn("Failed to capture before snapshot:", error);
    }
  }

  /**
   * Capture snapshot after applying a message
   */
  captureAfter(messageId: string, documentId: string, ydoc: Y.Doc): void {
    if (!this.captureEnabled) return;

    // Only capture for document update messages
    if (!this.shouldCaptureSnapshot(documentId, ydoc)) {
      return;
    }

    try {
      const snapshot = Y.encodeStateAsUpdateV2(ydoc);
      this.documentSnapshots.set(documentId, snapshot);

      // Get or create snapshot data
      let snapshotData = this.snapshots.get(messageId);
      if (!snapshotData) {
        snapshotData = {
          messageId,
          documentId,
          before: null,
          after: null,
          timestamp: Date.now(),
        };
        this.snapshots.set(messageId, snapshotData);
      }
      snapshotData.after = snapshot;
      snapshotData.timestamp = Date.now();

      // Enforce max snapshots limit (FIFO)
      this.enforceLimit();
    } catch (error) {
      console.warn("Failed to capture after snapshot:", error);
    }
  }

  /**
   * Check if we should capture a snapshot for this message/document
   */
  private shouldCaptureSnapshot(documentId: string, ydoc: Y.Doc): boolean {
    // We'll capture snapshots for all document update messages
    // The caller should check if the message type warrants a snapshot
    return true;
  }

  /**
   * Check if a message type should have snapshots captured
   */
  shouldCaptureForMessage(message: Message): boolean {
    if (!this.captureEnabled) return false;

    // Only capture for document messages that modify the document
    if (message.type !== "doc") return false;

    const payload = message.payload as { type?: string };
    const type = payload?.type;

    // Capture for sync-step-2 and update messages (these modify the document)
    return type === "sync-step-2" || type === "update";
  }

  /**
   * Get snapshot data for a message
   */
  getSnapshot(messageId: string): SnapshotData | undefined {
    return this.snapshots.get(messageId);
  }

  /**
   * Get all snapshots
   */
  getSnapshots(): Map<string, SnapshotData> {
    return new Map(this.snapshots);
  }

  /**
   * Get current snapshot for a document
   */
  getCurrentSnapshot(documentId: string): Uint8Array | undefined {
    return this.documentSnapshots.get(documentId);
  }

  /**
   * Clear all snapshots
   */
  clear(): void {
    this.snapshots.clear();
    this.documentSnapshots.clear();
  }

  /**
   * Clear snapshots for a specific document
   */
  clearDocument(documentId: string): void {
    for (const [messageId, snapshot] of this.snapshots.entries()) {
      if (snapshot.documentId === documentId) {
        this.snapshots.delete(messageId);
      }
    }
    this.documentSnapshots.delete(documentId);
  }

  /**
   * Enforce max snapshots limit (FIFO eviction)
   */
  private enforceLimit(): void {
    if (this.snapshots.size <= this.maxSnapshots) {
      return;
    }

    // Sort by timestamp (oldest first) and remove excess
    const entries = Array.from(this.snapshots.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = entries.slice(0, entries.length - this.maxSnapshots);
    for (const [messageId] of toRemove) {
      this.snapshots.delete(messageId);
    }
  }

  /**
   * Get snapshot statistics
   */
  getStats(): {
    total: number;
    withBefore: number;
    withAfter: number;
    withBoth: number;
  } {
    let withBefore = 0;
    let withAfter = 0;
    let withBoth = 0;

    for (const snapshot of this.snapshots.values()) {
      if (snapshot.before && snapshot.after) {
        withBoth++;
      } else if (snapshot.before) {
        withBefore++;
      } else if (snapshot.after) {
        withAfter++;
      }
    }

    return {
      total: this.snapshots.size,
      withBefore,
      withAfter,
      withBoth,
    };
  }
}
