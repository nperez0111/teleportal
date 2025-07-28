import type { Storage } from "unstorage";

import {
  EncryptedMessageId,
  EncryptedUpdate,
} from "../../encryption-state-vector/encoding";
import { DocumentMetadata, EncryptedDocumentStorage } from "../encrypted";

export class UnstorageEncryptedDocumentStorage extends EncryptedDocumentStorage {
  private readonly storage: Storage;
  private readonly options: { ttl: number };

  constructor(storage: Storage, options?: { ttl?: number }) {
    super();
    this.storage = storage;
    this.options = { ttl: 5 * 1000, ...options };
  }

  /**
   * Lock a key for 5 seconds
   * @param key - The key to lock
   * @param cb - The callback to execute
   * @returns The TTL of the lock
   */
  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    const meta = await this.storage.getMeta(key);
    const lockedTTL = meta?.ttl;
    if (lockedTTL && lockedTTL > Date.now()) {
      // Wait for the lock to be released with jitter to avoid thundering herd
      const jitter = Math.random() * 1000; // Random delay between 0-1000ms
      const waitTime = lockedTTL - Date.now() + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return await this.transaction(key, cb);
    }
    const ttl = Date.now() + this.options.ttl;
    await this.storage.setMeta(key, { ttl, ...meta });
    const result = await cb();
    await this.storage.setMeta(key, { ttl: Date.now(), ...meta });
    return result;
  }

  async writeDocumentMetadata(
    key: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    await this.storage.setItem(key + ":meta", metadata);
  }

  async fetchDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const metadata = await this.storage.getItem(key + ":meta");
    if (!metadata) {
      return { seenMessages: {} };
    }
    return metadata as DocumentMetadata;
  }

  async storeEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
    payload: EncryptedUpdate,
  ): Promise<void> {
    await this.storage.setItemRaw(key + ":" + messageId, payload);
  }

  async fetchEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedUpdate> {
    // TODO null handling
    const payload = await this.storage.getItemRaw(key + ":" + messageId);
    return payload as EncryptedUpdate;
  }
}
