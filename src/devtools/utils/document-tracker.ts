import type { Provider } from "teleportal/providers";
import type { DocumentState } from "../types";

export class DocumentTracker {
  private documents = new Map<string, DocumentState>();

  addDocument(id: string, provider: Provider, name?: string): void {
    if (!this.documents.has(id)) {
      this.documents.set(id, {
        id,
        name: name || id,
        provider,
        synced: false,
        messageCount: 0,
        lastActivity: Date.now(),
      });
    }
  }

  removeDocument(id: string): void {
    this.documents.delete(id);
  }

  updateDocumentActivity(id: string): void {
    const doc = this.documents.get(id);
    if (doc) {
      doc.lastActivity = Date.now();
      doc.messageCount++;
    }
  }

  updateDocumentSyncStatus(id: string, synced: boolean): void {
    const doc = this.documents.get(id);
    if (doc) {
      doc.synced = synced;
    }
  }

  getDocument(id: string): DocumentState | undefined {
    return this.documents.get(id);
  }

  getAllDocuments(): DocumentState[] {
    return Array.from(this.documents.values());
  }

  getDocumentsForProvider(provider: Provider): DocumentState[] {
    return Array.from(this.documents.values()).filter(
      (doc) => doc.provider === provider,
    );
  }

  clear(): void {
    this.documents.clear();
  }
}
