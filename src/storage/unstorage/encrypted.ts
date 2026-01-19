import type { Storage } from "unstorage";

import { EncryptedBinary } from "teleportal/encryption-key";
import type { EncryptedMessageId } from "teleportal/protocol/encryption";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
} from "../encrypted";
import { withTransaction } from "./transaction";

export class UnstorageEncryptedDocumentStorage extends EncryptedDocumentStorage {
  private readonly storage: Storage;
  private readonly options: { ttl: number; keyPrefix: string };
  constructor(
    storage: Storage,
    options?: {
      ttl?: number;
      keyPrefix?: string;
    },
  ) {
    super();
    this.storage = storage;
    this.options = { ttl: 5 * 1000, keyPrefix: "", ...options };
  }

  #getKey(key: string): string {
    return this.options.keyPrefix ? `${this.options.keyPrefix}:${key}` : key;
  }

  #getMetadataKey(key: string): string {
    return this.#getKey(key) + ":meta";
  }

  #getMessageKey(key: string, messageId: string): string {
    return this.#getKey(key) + ":" + messageId;
  }

  /**
   * Lock a key for 5 seconds
   * @param key - The key to lock
   * @param cb - The callback to execute
   * @returns The TTL of the lock
   */
  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    const prefixedKey = this.#getKey(key);
    return withTransaction(this.storage, prefixedKey, async () => cb(), {
      ttl: this.options.ttl,
    });
  }

  async writeDocumentMetadata(
    key: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void> {
    await this.storage.setItem(this.#getMetadataKey(key), metadata);
  }

  async getDocumentMetadata(key: string): Promise<EncryptedDocumentMetadata> {
    const now = Date.now();
    const metadata = await this.storage.getItem(this.#getMetadataKey(key));
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
    await this.storage.setItemRaw<EncryptedBinary>(
      this.#getMessageKey(key, messageId),
      payload,
    );
  }

  async fetchEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedBinary | null> {
    const payload = await this.storage.getItemRaw<EncryptedBinary>(
      this.#getMessageKey(key, messageId),
    );
    return payload;
  }

  async deleteDocument(key: string): Promise<void> {
    const metadata = await this.getDocumentMetadata(key);
    const prefixedKey = this.#getKey(key);

    // Delete all messages
    const promises = [];
    for (const clientId in metadata.seenMessages) {
      for (const counter in metadata.seenMessages[clientId]) {
        const messageId = metadata.seenMessages[clientId][counter];
        promises.push(
          this.storage.removeItem(this.#getMessageKey(key, messageId)),
        );
      }
    }
    await Promise.all(promises);

    // Delete metadata
    await this.storage.removeItem(this.#getMetadataKey(key));
  }
}
