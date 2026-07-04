import type { Provider } from "teleportal/providers";
import type { Message, RawReceivedMessage } from "teleportal";
import type { DocumentState } from "../types";

export class DocumentTracker {
  private documents = new Map<string, DocumentState>();

  addDocument(
    id: string,
    provider: Provider,
    name?: string,
    options?: { parentId?: string; isSubdoc?: boolean },
  ): DocumentState {
    let doc = this.documents.get(id);
    if (!doc) {
      doc = {
        id,
        name: name || id,
        provider,
        parentId: options?.parentId,
        isSubdoc: options?.isSubdoc ?? false,
        encrypted: false,
        syncPhase: "idle",
        messageCount: 0,
        bytesSent: 0,
        bytesReceived: 0,
        lastActivity: Date.now(),
      };
      this.documents.set(id, doc);
    } else if (options?.parentId && !doc.parentId) {
      doc.parentId = options.parentId;
      doc.isSubdoc = true;
    }
    return doc;
  }

  removeDocument(id: string): void {
    this.documents.delete(id);
  }

  /**
   * Records a message against its document: activity, traffic counters,
   * encryption, and the sync handshake phase.
   */
  recordMessage(
    id: string,
    message: Message | RawReceivedMessage,
    direction: "sent" | "received",
  ): void {
    const doc = this.documents.get(id);
    if (!doc) return;

    doc.lastActivity = Date.now();
    doc.messageCount++;
    const bytes = message.encoded.byteLength;
    if (direction === "sent") doc.bytesSent += bytes;
    else doc.bytesReceived += bytes;

    if (message.encrypted) doc.encrypted = true;

    if (message.type === "doc") {
      switch (message.payload.type) {
        case "sync-step-1":
          doc.syncPhase = "sync-step-1";
          break;
        case "sync-step-2":
          doc.syncPhase = "sync-step-2";
          break;
        case "sync-done":
          doc.syncPhase = "synced";
          break;
      }
    }
  }

  /** Called on disconnect: every document has to re-sync on the next connection. */
  resetSyncState(): void {
    for (const doc of this.documents.values()) {
      doc.syncPhase = "idle";
    }
  }

  getDocument(id: string): DocumentState | undefined {
    return this.documents.get(id);
  }

  getAllDocuments(): DocumentState[] {
    return [...this.documents.values()];
  }

  getDocumentsForProvider(provider: Provider): DocumentState[] {
    return [...this.documents.values()].filter((doc) => doc.provider === provider);
  }

  clear(): void {
    this.documents.clear();
  }
}
