import type { Storage } from "unstorage";

import { EncryptedBinary } from "teleportal/encryption-key";
import type { EncryptedMessageId } from "teleportal/protocol/encryption";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
} from "../encrypted";
import type { FileStorage, MilestoneStorage } from "../types";
import { UnstorageMilestoneStorage } from "./milestone-storage";

export class UnstorageEncryptedDocumentStorage extends EncryptedDocumentStorage {
  private readonly storage: Storage;
  private readonly options: { ttl: number; keyPrefix: string };

  constructor(
    storage: Storage,
    options?: { ttl?: number; keyPrefix?: string; fileStorage?: FileStorage; milestoneStorage?: MilestoneStorage },
  ) {
    super();
    this.storage = storage;
    this.options = { ttl: 5 * 1000, keyPrefix: "", ...options };
    this.fileStorage = options?.fileStorage;
    this.milestoneStorage =
      options?.milestoneStorage ??
      new UnstorageMilestoneStorage(storage, {
        keyPrefix: this.options.keyPrefix
          ? `${this.options.keyPrefix}:milestone`
          : "milestone",
      });
  }

  #getKey(key: string): string {
    return this.options.keyPrefix ? `${this.options.keyPrefix}:${key}` : key;
  }

  /**
   * Lock a key for 5 seconds
   * @param key - The key to lock
   * @param cb - The callback to execute
   * @returns The TTL of the lock
   */
  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    const prefixedKey = this.#getKey(key);
    const meta = await this.storage.getMeta(prefixedKey);
    const lockedTTL = meta?.ttl;
    if (lockedTTL && lockedTTL > Date.now()) {
      // Wait for the lock to be released with jitter to avoid thundering herd
      const jitter = Math.random() * 1000; // Random delay between 0-1000ms
      const waitTime = lockedTTL - Date.now() + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return await this.transaction(key, cb);
    }
    const ttl = Date.now() + this.options.ttl;
    await this.storage.setMeta(prefixedKey, { ttl, ...meta });
    const result = await cb();
    await this.storage.setMeta(prefixedKey, { ttl: Date.now(), ...meta });
    return result;
  }

  async writeDocumentMetadata(
    key: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void> {
    const prefixedKey = this.#getKey(key);
    await this.storage.setItem(prefixedKey + ":meta", metadata);
  }

  async getDocumentMetadata(key: string): Promise<EncryptedDocumentMetadata> {
    const now = Date.now();
    const prefixedKey = this.#getKey(key);
    const metadata = await this.storage.getItem(prefixedKey + ":meta");
    if (!metadata) {
      return {
        createdAt: now,
        updatedAt: now,
        encrypted: true,
        seenMessages: {},
      };
    }
    const m = metadata as EncryptedDocumentMetadata;
    return {
      ...m,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now,
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now,
      encrypted: typeof m.encrypted === "boolean" ? m.encrypted : true,
    };
  }

  async storeEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
    payload: EncryptedBinary,
  ): Promise<void> {
    const prefixedKey = this.#getKey(key);
    await this.storage.setItemRaw<EncryptedBinary>(
      prefixedKey + ":" + messageId,
      payload,
    );
  }

  async fetchEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedBinary | null> {
    const prefixedKey = this.#getKey(key);
    const payload = await this.storage.getItemRaw<EncryptedBinary>(
      prefixedKey + ":" + messageId,
    );
    return payload;
  }

  async deleteDocument(key: string): Promise<void> {
    if (this.fileStorage) {
      await this.fileStorage.deleteFilesByDocument(key);
    }

    const metadata = await this.getDocumentMetadata(key);
    const prefixedKey = this.#getKey(key);

    // Delete all messages
    const promises = [];
    for (const clientId in metadata.seenMessages) {
      for (const counter in metadata.seenMessages[clientId]) {
        const messageId = metadata.seenMessages[clientId][counter];
        promises.push(this.storage.removeItem(prefixedKey + ":" + messageId));
      }
    }
    await Promise.all(promises);

    // Delete metadata
    await this.storage.removeItem(prefixedKey + ":meta");
  }
}
