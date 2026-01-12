import type { Awareness } from "y-protocols/awareness";
import type { DevtoolOptions, PeerState } from "./types.js";

/**
 * Tracks peer awareness states across all documents
 */
export class PeerTracker {
  private peers: Map<number, PeerState> = new Map();
  private onPeerChangeCallback?: (peers: Map<number, PeerState>) => void;
  private documentToPeers: Map<string, Set<number>> = new Map(); // Document ID -> Set of client IDs

  constructor(options: DevtoolOptions = {}) {
    // Options can be used for future configuration
  }

  /**
   * Set callback for when peer states change
   */
  setOnPeerChange(callback: (peers: Map<number, PeerState>) => void): void {
    this.onPeerChangeCallback = callback;
  }

  /**
   * Hook into an Awareness instance for a specific document
   */
  hookAwareness(
    awareness: Awareness,
    documentId: string,
  ): () => void {
    // Initial update
    this.updateFromAwareness(awareness, documentId);

    // Listen for changes
    const onChange = () => {
      this.updateFromAwareness(awareness, documentId);
    };

    awareness.on("change", onChange);

    // Return cleanup function
    return () => {
      awareness.off("change", onChange);
      // Remove this document from all peers
      this.removeDocument(documentId);
    };
  }

  /**
   * Update peer states from an Awareness instance
   */
  private updateFromAwareness(awareness: Awareness, documentId: string): void {
    const states = awareness.getStates();
    const now = Date.now();

    // Update existing peers and add new ones
    for (const [clientId, awarenessData] of states.entries()) {
      let peer = this.peers.get(clientId);
      if (!peer) {
        peer = {
          clientId,
          awareness: {},
          documents: new Set(),
          lastSeen: now,
        };
        this.peers.set(clientId, peer);
      }

      // Update awareness data
      peer.awareness = awarenessData as Record<string, unknown>;
      peer.lastSeen = now;
      peer.documents.add(documentId);

      // Update document-to-peers mapping
      if (!this.documentToPeers.has(documentId)) {
        this.documentToPeers.set(documentId, new Set());
      }
      this.documentToPeers.get(documentId)!.add(clientId);
    }

    // Remove peers that are no longer in the awareness states
    // But keep them if they're in other documents
    const currentClientIds = new Set(states.keys());
    for (const [clientId, peer] of this.peers.entries()) {
      if (!currentClientIds.has(clientId)) {
        // Remove from this document
        peer.documents.delete(documentId);
        const docPeers = this.documentToPeers.get(documentId);
        if (docPeers) {
          docPeers.delete(clientId);
        }

        // If peer is no longer in any document, remove them
        if (peer.documents.size === 0) {
          this.peers.delete(clientId);
        }
      }
    }

    // Notify callback
    if (this.onPeerChangeCallback) {
      this.onPeerChangeCallback(new Map(this.peers));
    }
  }

  /**
   * Remove a document from tracking (when document is closed)
   */
  private removeDocument(documentId: string): void {
    const docPeers = this.documentToPeers.get(documentId);
    if (!docPeers) return;

    // Remove document from all peers
    for (const clientId of docPeers) {
      const peer = this.peers.get(clientId);
      if (peer) {
        peer.documents.delete(documentId);
        // If peer is no longer in any document, remove them
        if (peer.documents.size === 0) {
          this.peers.delete(clientId);
        }
      }
    }

    this.documentToPeers.delete(documentId);

    // Notify callback
    if (this.onPeerChangeCallback) {
      this.onPeerChangeCallback(new Map(this.peers));
    }
  }

  /**
   * Get all peers
   */
  getPeers(): Map<number, PeerState> {
    return new Map(this.peers);
  }

  /**
   * Get a specific peer by client ID
   */
  getPeer(clientId: number): PeerState | undefined {
    return this.peers.get(clientId);
  }

  /**
   * Get peers for a specific document
   */
  getPeersForDocument(documentId: string): PeerState[] {
    const docPeers = this.documentToPeers.get(documentId);
    if (!docPeers) return [];

    const result: PeerState[] = [];
    for (const clientId of docPeers) {
      const peer = this.peers.get(clientId);
      if (peer) {
        result.push(peer);
      }
    }
    return result;
  }

  /**
   * Get all document IDs that have peers
   */
  getDocuments(): Set<string> {
    return new Set(this.documentToPeers.keys());
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalPeers: number;
    totalDocuments: number;
    peersPerDocument: Map<string, number>;
  } {
    const peersPerDocument = new Map<string, number>();
    for (const [documentId, clientIds] of this.documentToPeers.entries()) {
      peersPerDocument.set(documentId, clientIds.size);
    }

    return {
      totalPeers: this.peers.size,
      totalDocuments: this.documentToPeers.size,
      peersPerDocument,
    };
  }

  /**
   * Clear all peer data
   */
  clear(): void {
    this.peers.clear();
    this.documentToPeers.clear();
    if (this.onPeerChangeCallback) {
      this.onPeerChangeCallback(new Map());
    }
  }
}
