import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";
import * as Y from "yjs";

import { type StateVector, type Update } from "teleportal";
import { UnencryptedDocumentStorage } from "../unencrypted";
import {
  AttributionMetadata,
  DocumentMetadata,
} from "../document-storage";
import { FileStorage } from "../file-storage";
import { createAttributionIdMap } from "../attribution";

const ATTRIBUTION_KEY_SUFFIX = ":attributions";

/**
 * A storage implementation that is backed by unstorage.
 *
 * It allows operating in two modes:
 * - key-scanning for other updates (useful in a relational DB)
 * - a single key for the update and a separate key for the state vector (useful in a key-value store).
 */
export class UnstorageDocumentStorage extends UnencryptedDocumentStorage {
  private readonly storage: Storage;
  private readonly options: { scanKeys: boolean; ttl: number };
  public readonly fileStorage: FileStorage | undefined;

  constructor(
    storage: Storage,
    options?: { scanKeys?: boolean; ttl?: number; fileStorage?: FileStorage },
  ) {
    super();
    this.storage = storage;
    this.options = { scanKeys: false, ttl: 5 * 1000, ...options };
    this.fileStorage = options?.fileStorage;
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

  /**
   * Persist a Y.js update to storage
   */
  async write(
    key: string,
    update: Update,
    overwriteKeysOrAttribution?: boolean | AttributionMetadata,
    attribution?: AttributionMetadata,
  ): Promise<void> {
    const updateKey = key + "-update-" + uuidv4();
    await this.storage.setItemRaw(updateKey, update);
    const overwriteKeys =
      typeof overwriteKeysOrAttribution === "boolean"
        ? overwriteKeysOrAttribution
        : false;
    const attributionMetadata =
      typeof overwriteKeysOrAttribution === "boolean"
        ? attribution
        : overwriteKeysOrAttribution;
    await this.mergeAttributions(key, update, attributionMetadata);

    if (this.options.scanKeys) {
      return;
    }
    await this.transaction(key, async () => {
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

  async writeDocumentMetadata(
    key: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    await this.storage.setItem(key + ":meta", metadata);
  }

  async fetchDocumentMetadata(key: string): Promise<DocumentMetadata> {
    return (
      ((await this.storage.getItem(key + ":meta")) as DocumentMetadata) ?? {}
    );
  }

  async deleteDocument(key: string): Promise<void> {
    // Cascade delete files
    if (this.fileStorage) {
      await this.fileStorage.deleteFilesByDocument(key);
    }

    // Delete metadata
    await this.storage.removeItem(key + ":meta");

    // Delete updates and index
    const keys = this.options.scanKeys
      ? new Set(await this.storage.getKeys(key + "-update-"))
      : ((await this.storage.getItem<{ keys: Set<string> }>(key))?.keys ??
        new Set());

    if (keys.size > 0) {
      await Promise.all(
        Array.from(keys).map((k) => this.storage.removeItem(k)),
      );
    }

    await this.storage.removeItem(key + ATTRIBUTION_KEY_SUFFIX);
    await this.storage.removeItem(key);
  }

  async getAttributions(key: string): Promise<Y.IdMap<any>> {
    const existing = await this.storage.getItemRaw<Uint8Array>(
      key + ATTRIBUTION_KEY_SUFFIX,
    );
    if (!existing) {
      return new Map() as Y.IdMap<any>;
    }
    return Y.decodeIdMap(existing) as Y.IdMap<any>;
  }

  private async mergeAttributions(
    key: string,
    update: Update,
    metadata?: AttributionMetadata,
  ): Promise<void> {
    if (!metadata) {
      return;
    }

    const attributionMap = createAttributionIdMap(update, metadata);
    if (!attributionMap) {
      return;
    }

    await this.transaction(key, async () => {
      const existing = await this.storage.getItemRaw<Uint8Array>(
        key + ATTRIBUTION_KEY_SUFFIX,
      );
      const target = existing
        ? (Y.decodeIdMap(existing) as Y.IdMap<any>)
        : (new Map() as Y.IdMap<any>);
      Y.insertIntoIdMap(target, attributionMap);
      await this.storage.setItemRaw(
        key + ATTRIBUTION_KEY_SUFFIX,
        Y.encodeIdMap(target),
      );
    });
  }
}
