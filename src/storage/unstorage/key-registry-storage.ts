import { fromBase64, toBase64 } from "teleportal/utils";
import type { Storage } from "unstorage";

import type {
  KeyRegistryStorage,
  KeyRegistryRecord,
  KeyRegistryMeta,
  WrappedKeyEntry,
} from "../../protocols/key-registry/storage";
import { type TransactionOptions, withTransaction } from "./transaction";

type StoredDocumentKeys = {
  generation: number;
  keys: Record<string, string>;
};

export class UnstorageKeyRegistryStorage implements KeyRegistryStorage {
  readonly type = "key-registry-storage" as const;

  constructor(
    private storage: Storage,
    private options: { keyPrefix?: string } = {},
    private transactionOptions: TransactionOptions = { ttl: 5000 },
  ) {}

  private key(documentId: string): string {
    const prefix = this.options.keyPrefix ?? "key-registry";
    return `${prefix}:${documentId}`;
  }

  async get(documentId: string, userId: string): Promise<KeyRegistryRecord | null> {
    const doc = await this.storage.getItem<StoredDocumentKeys>(this.key(documentId));
    if (!doc) return null;
    const encoded = doc.keys[userId];
    if (!encoded) return null;
    return { wrappedKey: fromBase64(encoded), generation: doc.generation };
  }

  async getAny(documentId: string): Promise<(KeyRegistryRecord & { userId: string }) | null> {
    const doc = await this.storage.getItem<StoredDocumentKeys>(this.key(documentId));
    if (!doc) return null;
    const entries = Object.entries(doc.keys);
    if (entries.length === 0) return null;
    const [userId, encoded] = entries[0]!;
    return { userId, wrappedKey: fromBase64(encoded), generation: doc.generation };
  }

  async set(documentId: string, entries: WrappedKeyEntry[]): Promise<number> {
    const doc = (await this.storage.getItem<StoredDocumentKeys>(this.key(documentId))) ?? {
      generation: 0,
      keys: {},
    };
    for (const { userId, wrappedKey } of entries) {
      doc.keys[userId] = toBase64(wrappedKey);
    }
    await this.storage.setItem(this.key(documentId), doc);
    return doc.generation;
  }

  async revoke(documentId: string, userIds: string[]): Promise<number> {
    const doc = await this.storage.getItem<StoredDocumentKeys>(this.key(documentId));
    if (!doc) return 0;
    for (const userId of userIds) {
      delete doc.keys[userId];
    }
    await this.storage.setItem(this.key(documentId), doc);
    return doc.generation;
  }

  async getMeta(documentId: string): Promise<KeyRegistryMeta> {
    const doc = await this.storage.getItem<StoredDocumentKeys>(this.key(documentId));
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
    const doc = (await this.storage.getItem<StoredDocumentKeys>(this.key(documentId))) ?? {
      generation: 0,
      keys: {},
    };
    if (doc.generation !== expectedGeneration) {
      throw new Error(
        `Key rotation conflict: expected generation ${expectedGeneration}, ` +
          `but current is ${doc.generation}`,
      );
    }
    const newKeys: Record<string, string> = {};
    for (const { userId, wrappedKey } of entries) {
      newKeys[userId] = toBase64(wrappedKey);
    }
    doc.keys = newKeys;
    doc.generation++;
    await this.storage.setItem(this.key(documentId), doc);
    return doc.generation;
  }

  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return withTransaction(
      this.storage,
      `lock:${this.key(documentId)}`,
      () => cb(),
      this.transactionOptions,
    );
  }
}
