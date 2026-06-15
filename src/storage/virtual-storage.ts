import { batch } from "./batch";
import type {
  DocumentStorage,
  DocumentMetadata,
  Document,
  EncodedContentMap,
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

interface BufferedUpdate {
  update: Update;
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

  retrieveAttribution?: (
    documentId: string,
  ) => Promise<EncodedContentMap | null>;

  #storage: DocumentStorage;
  #buffer = new Map<
    string,
    { updates: BufferedUpdate[]; metadata?: DocumentMetadata }
  >();
  #batchProcessor: (item: {
    key: string;
    updates: BufferedUpdate[];
    metadata?: DocumentMetadata;
  }) => void;

  constructor(
    storage: DocumentStorage,
    options: VirtualStorageOptions = defaultOptions,
  ) {
    this.#storage = storage;
    this.storageType = storage.storageType;

    if (storage.retrieveAttribution) {
      this.retrieveAttribution = (documentId: string) =>
        this.#storage.retrieveAttribution!(documentId);
    }

    // Set up batch processor
    this.#batchProcessor = batch(
      async (
        batches: Array<{
          key: string;
          updates: BufferedUpdate[];
          metadata?: DocumentMetadata;
        }>,
      ) => {
        for (const { key, updates, metadata } of batches) {
          for (const { update, attribution } of updates) {
            await this.#storage.handleUpdate(key, update, attribution);
          }
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

  async handleUpdate(
    documentId: string,
    update: Update,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    this.#addToBuffer(documentId, { updates: [{ update, attribution }] });
  }

  async writeDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    this.#addToBuffer(documentId, { metadata });
  }

  #addToBuffer(
    documentId: string,
    item: { updates?: BufferedUpdate[]; metadata?: DocumentMetadata },
  ) {
    const existing = this.#buffer.get(documentId) ?? { updates: [] };
    const merged = {
      updates: [...existing.updates, ...(item.updates ?? [])],
      metadata: item.metadata ?? existing.metadata,
    };
    this.#buffer.set(documentId, merged);

    this.#batchProcessor({ key: documentId, ...merged });
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

  async handleSyncStep1(
    documentId: string,
    syncStep1: StateVector,
  ): Promise<Document> {
    await this.#flushPending(documentId);
    return this.#storage.handleSyncStep1(documentId, syncStep1);
  }

  async handleSyncStep2(
    documentId: string,
    syncStep2: SyncStep2Update,
  ): Promise<void> {
    return this.#storage.handleSyncStep2(documentId, syncStep2);
  }

  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return this.#storage.transaction(documentId, cb);
  }

  async #flushPending(documentId: string): Promise<void> {
    const pending = this.#buffer.get(documentId);
    if (pending) {
      this.#buffer.delete(documentId);
      for (const { update, attribution } of pending.updates) {
        await this.#storage.handleUpdate(documentId, update, attribution);
      }
      if (pending.metadata) {
        await this.#storage.writeDocumentMetadata(documentId, pending.metadata);
      }
    }
  }
}
