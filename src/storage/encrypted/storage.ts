import type { Storage } from "unstorage";

import type { StateVector, Update } from "teleportal";
import { DocumentStorage } from "../document-storage";
import {
  appendFauxUpdateList,
  decodeFauxUpdateList,
  encodeFauxStateVector,
  getEmptyFauxUpdateList,
} from "./encoding";

export class EncryptedDocumentStorage extends DocumentStorage {
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
  private async lock(key: string, cb: () => Promise<void>): Promise<number> {
    const meta = await this.storage.getMeta(key);
    const lockedTTL = meta?.ttl;
    if (lockedTTL && lockedTTL > Date.now()) {
      // Wait for the lock to be released with jitter to avoid thundering herd
      const jitter = Math.random() * 1000; // Random delay between 0-1000ms
      const waitTime = lockedTTL - Date.now() + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.lock(key, cb);
    }
    const ttl = Date.now() + this.options.ttl;
    await this.storage.setMeta(key, { ttl });
    await cb();
    await this.storage.setMeta(key, { ttl: Date.now() });
    return ttl;
  }

  async write(key: string, update: Update) {
    await this.lock(key, async () => {
      const content =
        (await this.storage.getItemRaw(key)) ?? getEmptyFauxUpdateList();

      // Decode, append, and store back the updates
      await this.storage.setItemRaw(
        key,
        appendFauxUpdateList(content, decodeFauxUpdateList(update)),
      );
    });
  }

  async fetch(key: string): Promise<{
    update: Update;
    stateVector: StateVector;
  } | null> {
    const update = await this.storage.getItemRaw(key);

    if (!update) {
      return null;
    }

    return {
      update,
      get stateVector() {
        // TODO implement state vectors for encrypted updates
        return encodeFauxStateVector({
          messageId: "implement",
        });
      },
    };
  }
}
