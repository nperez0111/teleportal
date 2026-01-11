import { batch } from "./batch";
import type {
  DocumentStorage,
  DocumentMetadata,
  Document,
} from "teleportal/storage";
import type { StateVector, SyncStep2Update, Update } from "teleportal";

export interface VirtualStorageOptions {
  batchMaxSize: number;
  batchWaitMs: number;
}

const defaultOptions: VirtualStorageOptions = {
  batchMaxSize: 100,
  batchWaitMs: 2000,
};

/**
 * VirtualStorage is an in-memory abstraction layer over DocumentStorage that batches writes
 * to improve performance by reducing DB operations. Writes are buffered in memory and
 * periodically flushed to the underlying storage.
 */
export class VirtualStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  readonly storageType: "encrypted" | "unencrypted";

  #storage: DocumentStorage;
  #buffer = new Map<
    string,
    { updates: Update[]; metadata?: DocumentMetadata }
  >();
  #batchProcessor: (item: {
    key: string;
    updates: Update[];
    metadata?: DocumentMetadata;
  }) => void;

  constructor(
    storage: DocumentStorage,
    options: VirtualStorageOptions = defaultOptions,
  ) {
    this.#storage = storage;
    this.storageType = storage.storageType;

    // Set up batch processor
    this.#batchProcessor = batch(
      async (
        batches: Array<{
          key: string;
          updates: Update[];
          metadata?: DocumentMetadata;
        }>,
      ) => {
        for (const { key, updates, metadata } of batches) {
          // Flush updates
          for (const update of updates) {
            await this.#storage.handleUpdate(key, update);
          }
          // Flush metadata if present
          if (metadata) {
            await this.#storage.writeDocumentMetadata(key, metadata);
          }
        }
      },
      {
        maxSize: options.batchMaxSize,
        wait: options.batchWaitMs,
      },
    );
  }

  get fileStorage() {
    return this.#storage.fileStorage;
  }

  get milestoneStorage() {
    return this.#storage.milestoneStorage;
  }

  /**
   * Buffer an update for later batch processing.
   */
  async handleUpdate(documentId: string, update: Update): Promise<void> {
    this.#addToBuffer(documentId, { updates: [update] });
  }

  /**
   * Buffer metadata for later batch processing.
   */
  async writeDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    this.#addToBuffer(documentId, { metadata });
  }

  /**
   * Add item to buffer and trigger batch processing.
   */
  #addToBuffer(
    documentId: string,
    item: { updates?: Update[]; metadata?: DocumentMetadata },
  ) {
    const existing = this.#buffer.get(documentId) ?? { updates: [] };
    const merged = {
      updates: [...existing.updates, ...(item.updates ?? [])],
      metadata: item.metadata ?? existing.metadata,
    };
    this.#buffer.set(documentId, merged);

    // Trigger batch processing
    this.#batchProcessor({ key: documentId, ...merged });
  }

  /**
   * Flush any pending writes for a document, then read.
   */
  async getDocument(documentId: string): Promise<Document | null> {
    await this.#flushPending(documentId);
    return this.#storage.getDocument(documentId);
  }

  /**
   * Flush any pending writes for a document, then read metadata.
   */
  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    await this.#flushPending(documentId);
    return this.#storage.getDocumentMetadata(documentId);
  }

  /**
   * Flush pending writes before deleting.
   */
  async deleteDocument(documentId: string): Promise<void> {
    await this.#flushPending(documentId);
    return this.#storage.deleteDocument(documentId);
  }

  /**
   * Forward sync step 1 (read operation).
   */
  async handleSyncStep1(
    documentId: string,
    syncStep1: StateVector,
  ): Promise<Document> {
    await this.#flushPending(documentId);
    return this.#storage.handleSyncStep1(documentId, syncStep1);
  }

  /**
   * Forward sync step 2 (write operation), but buffer it.
   */
  async handleSyncStep2(
    documentId: string,
    syncStep2: SyncStep2Update,
  ): Promise<void> {
    // Assume sync step 2 involves updates, buffer it
    // For now, forward directly since it might call handleUpdate internally
    return this.#storage.handleSyncStep2(documentId, syncStep2);
  }

  /**
   * Forward transaction.
   */
  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return this.#storage.transaction(documentId, cb);
  }

  /**
   * Forward file operations.
   */
  async addFileToDocument(documentId: string, fileId: string): Promise<void> {
    return this.#storage.addFileToDocument(documentId, fileId);
  }

  async removeFileFromDocument(
    documentId: string,
    fileId: string,
  ): Promise<void> {
    return this.#storage.removeFileFromDocument(documentId, fileId);
  }

  /**
   * Flush pending writes for a specific document immediately.
   */
  async #flushPending(documentId: string): Promise<void> {
    const pending = this.#buffer.get(documentId);
    if (pending) {
      this.#buffer.delete(documentId);
      // Process immediately
      for (const update of pending.updates) {
        await this.#storage.handleUpdate(documentId, update);
      }
      if (pending.metadata) {
        await this.#storage.writeDocumentMetadata(documentId, pending.metadata);
      }
    }
  }
}
