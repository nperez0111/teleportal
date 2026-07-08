import { batch } from "./batch";
import type {
  DocumentStorage,
  DocumentMetadata,
  Document,
  EncodedContentMap,
} from "teleportal/storage";
import type { StateVector, VersionedSyncStep2Update, VersionedUpdate } from "teleportal";

export interface VirtualStorageOptions {
  batchMaxSize: number;
  batchWaitMs: number;
}

const defaultOptions: VirtualStorageOptions = {
  batchMaxSize: 100,
  batchWaitMs: 2000,
};

interface BufferedUpdate {
  update: VersionedUpdate;
  attribution?: EncodedContentMap;
}

/**
 * VirtualStorage is an in-memory abstraction layer over DocumentStorage that batches writes
 * to improve performance by reducing DB operations. Writes are buffered in memory and
 * periodically flushed to the underlying storage.
 */
export class VirtualStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  readonly storageType: "encrypted" | "unencrypted";

  retrieveAttribution?: (documentId: string) => Promise<EncodedContentMap | null>;

  #storage: DocumentStorage;
  #buffer = new Map<string, { updates: BufferedUpdate[]; metadata?: DocumentMetadata }>();
  /**
   * In-flight flush per key. Guarantees a key's buffered writes are drained by
   * exactly one flusher at a time, so a batch-triggered flush and a read-path
   * flush of the same key never double-apply the buffer.
   */
  #flushing = new Map<string, Promise<void>>();
  /** Enqueue a key for a batched (timer/size-triggered) flush. */
  #scheduleFlush: (key: string) => void;

  constructor(storage: DocumentStorage, options: VirtualStorageOptions = defaultOptions) {
    this.#storage = storage;
    this.storageType = storage.storageType;

    if (storage.retrieveAttribution) {
      this.retrieveAttribution = (documentId: string) =>
        this.#storage.retrieveAttribution!(documentId);
    }

    // The batch collects dirty keys and flushes each once when the batch fires
    // (by size or wait). Draining is keyed off `#buffer`, not the batch item,
    // so a key enqueued multiple times is still flushed exactly once.
    this.#scheduleFlush = batch(
      (keys: string[]) => {
        for (const key of new Set(keys)) {
          void this.#flushPending(key);
        }
      },
      {
        maxSize: options.batchMaxSize,
        wait: options.batchWaitMs,
      },
    );
  }

  async handleUpdate(
    documentId: string,
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    this.#addToBuffer(documentId, { updates: [{ update, attribution }] });
  }

  async writeDocumentMetadata(documentId: string, metadata: DocumentMetadata): Promise<void> {
    this.#addToBuffer(documentId, { metadata });
  }

  #addToBuffer(
    documentId: string,
    item: { updates?: BufferedUpdate[]; metadata?: DocumentMetadata },
  ) {
    const existing = this.#buffer.get(documentId) ?? { updates: [] };
    this.#buffer.set(documentId, {
      updates: [...existing.updates, ...(item.updates ?? [])],
      metadata: item.metadata ?? existing.metadata,
    });

    this.#scheduleFlush(documentId);
  }

  async getDocument(documentId: string): Promise<Document | null> {
    await this.#flushPending(documentId);
    return this.#storage.getDocument(documentId);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    await this.#flushPending(documentId);
    return this.#storage.getDocumentMetadata(documentId);
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.#flushPending(documentId);
    return this.#storage.deleteDocument(documentId);
  }

  async handleSyncStep1(documentId: string, syncStep1: StateVector): Promise<Document> {
    await this.#flushPending(documentId);
    return this.#storage.handleSyncStep1(documentId, syncStep1);
  }

  async handleSyncStep2(documentId: string, syncStep2: VersionedSyncStep2Update): Promise<void> {
    return this.#storage.handleSyncStep2(documentId, syncStep2);
  }

  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return this.#storage.transaction(documentId, cb);
  }

  async #flushPending(documentId: string): Promise<void> {
    // Serialize flushes of the same key so a batch-triggered flush and a
    // read-triggered flush can't both drain (and re-apply) the buffer.
    const inflight = this.#flushing.get(documentId);
    if (inflight) return inflight;

    const run = (async () => {
      // Drain in a loop: writes buffered while an earlier flush was awaiting
      // I/O still get persisted before this flusher resolves, preserving order.
      for (;;) {
        const pending = this.#buffer.get(documentId);
        if (!pending) return;
        this.#buffer.delete(documentId);
        for (const { update, attribution } of pending.updates) {
          await this.#storage.handleUpdate(documentId, update, attribution);
        }
        if (pending.metadata) {
          await this.#storage.writeDocumentMetadata(documentId, pending.metadata);
        }
      }
    })();

    this.#flushing.set(documentId, run);
    try {
      await run;
    } finally {
      this.#flushing.delete(documentId);
    }
  }
}
