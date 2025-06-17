import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";
import * as Y from "yjs";

import type { StateVector, Update } from "../lib";
import { DocumentStorage } from "../storage";

/**
 * A storage implementation that is backed by unstorage.
 *
 * It allows operating in two modes:
 * - key-scanning for other updates (useful in a relational DB)
 * - a single key for the update and a separate key for the state vector (useful in a key-value store).
 */
export class UnstorageDocumentStorage implements DocumentStorage {
  private readonly storage: Storage;
  private readonly options: { scanKeys: boolean; ttl: number };

  constructor(storage: Storage, options: { scanKeys?: boolean; ttl?: number }) {
    this.storage = storage;
    this.options = { scanKeys: false, ttl: 5 * 1000, ...options };
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

  /**
   * Persist a Y.js update to storage
   */
  async write(
    key: string,
    update: Update,
    overwriteKeys?: boolean,
  ): Promise<void> {
    const updateKey = key + "-update-" + uuidv4();
    await this.storage.setItemRaw(updateKey, update);
    if (this.options.scanKeys) {
      return;
    }
    await this.lock(key, async () => {
      const doc = await this.storage.getItem<{ keys: string[] }>(key);
      if (doc && Array.isArray(doc.keys) && !overwriteKeys) {
        doc.keys = Array.from(new Set(doc.keys.concat(updateKey)));
        await this.storage.setItem(key, doc);
      } else {
        await this.storage.setItem(key, { keys: [updateKey] });
      }
    });
  }

  /**
   * Retrieve a Y.js update from storage
   */
  async fetch(key: string): Promise<{
    update: Update;
    stateVector: StateVector;
  } | null> {
    const update = await this.compact(key);

    if (!update) {
      return null;
    }

    return {
      update,
      get stateVector() {
        const stateVector = Y.encodeStateVectorFromUpdateV2(
          update,
        ) as StateVector;
        Object.defineProperty(this, "stateVector", { value: stateVector });
        return stateVector;
      },
    };
  }

  private async compact(
    key: string,
    asyncDeleteKeys = true,
  ): Promise<Update | null> {
    const keys = this.options.scanKeys
      ? new Set(await this.storage.getKeys(key + "-update-"))
      : ((await this.storage.getItem<{ keys: Set<string> }>(key))?.keys ??
        new Set());

    if (keys.size === 0) {
      return null;
    }
    if (keys.size === 1) {
      return await this.storage.getItemRaw(Array.from(keys)[0]);
    }

    const update = Y.mergeUpdatesV2(
      // TODO little naive, but it's ok for now
      (
        await Promise.all(
          Array.from(keys).map((key) => this.storage.getItemRaw(key)),
        )
      ).filter(Boolean),
    ) as Update;

    // asynchronously store the update and delete the keys
    const promise = this.write(key, update, true).then(() => {
      return Promise.all(
        Array.from(keys).map((key) => this.storage.removeItem(key)),
      );
    });

    if (asyncDeleteKeys) {
      await promise;
    }

    return update;
  }

  async unload(key: string): Promise<void> {
    await this.compact(key, false);
  }
}
