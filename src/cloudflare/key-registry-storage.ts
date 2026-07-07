import type {
  KeyRegistryMeta,
  KeyRegistryRecord,
  KeyRegistryStorage,
  WrappedKeyEntry,
} from "../protocols/key-registry/storage";

import { type DurableObjectStorageLike, KeyedMutex } from "./types";

type StoredDocumentKeys = {
  generation: number;
  /** Wrapped keys stay binary — Durable Object values are structured-clonable,
   * so no base64 round-trip is needed. */
  keys: Record<string, Uint8Array>;
};

/**
 * Key registry storage backed directly by Durable Object storage.
 *
 * Storage layout:
 * - `{prefix}:{documentId}` -- { generation, keys: Record<userId, wrappedKey> }
 */
export class DurableObjectKeyRegistryStorage implements KeyRegistryStorage {
  readonly type = "key-registry-storage" as const;

  readonly #storage: DurableObjectStorageLike;
  readonly #keyPrefix: string;
  readonly #mutex = new KeyedMutex();

  constructor(
    storage: DurableObjectStorageLike,
    options?: {
      keyPrefix?: string;
    },
  ) {
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "key-registry";
  }

  #key(documentId: string): string {
    return `${this.#keyPrefix}:${documentId}`;
  }

  async get(documentId: string, userId: string): Promise<KeyRegistryRecord | null> {
    const doc = await this.#storage.get<StoredDocumentKeys>(this.#key(documentId));
    if (!doc) return null;
    const wrappedKey = doc.keys[userId];
    if (!wrappedKey) return null;
    return { wrappedKey, generation: doc.generation };
  }

  async getAny(documentId: string): Promise<(KeyRegistryRecord & { userId: string }) | null> {
    const doc = await this.#storage.get<StoredDocumentKeys>(this.#key(documentId));
    if (!doc) return null;
    const entries = Object.entries(doc.keys);
    if (entries.length === 0) return null;
    const [userId, wrappedKey] = entries[0]!;
    return { userId, wrappedKey, generation: doc.generation };
  }

  async set(documentId: string, entries: WrappedKeyEntry[]): Promise<number> {
    return this.transaction(documentId, async () => {
      const doc = (await this.#storage.get<StoredDocumentKeys>(this.#key(documentId))) ?? {
        generation: 0,
        keys: {},
      };
      for (const { userId, wrappedKey } of entries) {
        doc.keys[userId] = wrappedKey;
      }
      await this.#storage.put(this.#key(documentId), doc);
      return doc.generation;
    });
  }

  async revoke(documentId: string, userIds: string[]): Promise<number> {
    return this.transaction(documentId, async () => {
      const doc = await this.#storage.get<StoredDocumentKeys>(this.#key(documentId));
      if (!doc) return 0;
      for (const userId of userIds) {
        delete doc.keys[userId];
      }
      await this.#storage.put(this.#key(documentId), doc);
      return doc.generation;
    });
  }

  async getMeta(documentId: string): Promise<KeyRegistryMeta> {
    const doc = await this.#storage.get<StoredDocumentKeys>(this.#key(documentId));
    if (!doc) return { generation: 0, userIds: [] };
    return {
      generation: doc.generation,
      userIds: Object.keys(doc.keys),
    };
  }

  async rotate(
    documentId: string,
    entries: WrappedKeyEntry[],
    expectedGeneration: number,
  ): Promise<number> {
    return this.transaction(documentId, async () => {
      const doc = (await this.#storage.get<StoredDocumentKeys>(this.#key(documentId))) ?? {
        generation: 0,
        keys: {},
      };
      if (doc.generation !== expectedGeneration) {
        // Message kept identical across backends — callers match on it.
        throw new Error(
          `Key rotation conflict: expected generation ${expectedGeneration}, ` +
            `but current is ${doc.generation}`,
        );
      }
      const newKeys: Record<string, Uint8Array> = {};
      for (const { userId, wrappedKey } of entries) {
        newKeys[userId] = wrappedKey;
      }
      doc.keys = newKeys;
      doc.generation++;
      await this.#storage.put(this.#key(documentId), doc);
      return doc.generation;
    });
  }

  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return this.#mutex.run(this.#key(documentId), cb);
  }
}
