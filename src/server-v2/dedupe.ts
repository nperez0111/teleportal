/**
 * Dedupe messages to prevent duplicate messages from being applied.
 */
export class TtlDedupe {
  private readonly ttlMs: number;
  private readonly maxPerDoc: number;
  private readonly store = new Map<string, Map<string, number>>();

  constructor(options?: { ttlMs?: number; maxPerDoc?: number }) {
    this.ttlMs = options?.ttlMs ?? 30_000;
    this.maxPerDoc = options?.maxPerDoc ?? 1_000;
  }

  private pruneDoc(docMap: Map<string, number>, now: number) {
    for (const [id, ts] of docMap) {
      if (now - ts > this.ttlMs) {
        docMap.delete(id);
      }
    }
    // Size cap: drop oldest if needed
    if (docMap.size > this.maxPerDoc) {
      const entries = [...docMap.entries()].sort((a, b) => a[1] - b[1]);
      const toDelete = entries.length - this.maxPerDoc;
      for (let i = 0; i < toDelete; i++) {
        docMap.delete(entries[i][0]);
      }
    }
  }

  shouldAccept(documentId: string, messageId: string): boolean {
    const now = Date.now();
    const docMap = this.store.get(documentId) ?? new Map<string, number>();
    this.pruneDoc(docMap, now);
    const seen = docMap.has(messageId);
    if (!seen) {
      docMap.set(messageId, now);
      this.store.set(documentId, docMap);
    }
    return !seen;
  }

  clearDocument(documentId: string) {
    this.store.delete(documentId);
  }

  clearAll() {
    this.store.clear();
  }
}
