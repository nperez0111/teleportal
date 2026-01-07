import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";
import * as Y from "yjs";

import { type StateVector, type Update } from "teleportal";
import { UnencryptedDocumentStorage } from "../unencrypted";
import type {
  Document,
  DocumentMetadata,
  FileStorage,
  MilestoneStorage,
} from "../types";
import { UnstorageMilestoneStorage } from "./milestone-storage";

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

  constructor(
    storage: Storage,
    options?: {
      scanKeys?: boolean;
      ttl?: number;
      fileStorage?: FileStorage;
      milestoneStorage?: MilestoneStorage;
    },
  ) {
    super();
    this.storage = storage;
    this.options = { scanKeys: false, ttl: 5 * 1000, ...options };
    this.fileStorage = options?.fileStorage;
    this.milestoneStorage =
      options?.milestoneStorage ?? new UnstorageMilestoneStorage(storage);
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
  async handleUpdate(
    key: string,
    update: Update,
    overwriteKeys?: boolean,
  ): Promise<void> {
    const updateKey = key + "-update-" + uuidv4();
    await this.storage.setItemRaw(updateKey, update);
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

    // Best-effort: bump updatedAt for the document.
    await this.transaction(key, async () => {
      const meta = await this.getDocumentMetadata(key);
      await this.writeDocumentMetadata(key, { ...meta, updatedAt: Date.now() });
    });
  }

  /**
   * Retrieve a Y.js update from storage
   */
  async getDocument(key: string): Promise<Document | null> {
    const update = await this.compact(key);

    if (!update) {
      return null;
    }

    const stateVector = Y.encodeStateVectorFromUpdateV2(update) as StateVector;
    const metadata = await this.getDocumentMetadata(key);

    return {
      id: key,
      metadata,
      content: {
        update,
        stateVector,
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
    const promise = this.handleUpdate(key, update, true).then(() => {
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

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const existing = (await this.storage.getItem(
      key + ":meta",
    )) as DocumentMetadata | null;

    if (!existing) {
      return {
        createdAt: now,
        updatedAt: now,
        encrypted: false,
      };
    }

    return {
      ...existing,
      createdAt:
        typeof existing.createdAt === "number" ? existing.createdAt : now,
      updatedAt:
        typeof existing.updatedAt === "number" ? existing.updatedAt : now,
      encrypted:
        typeof existing.encrypted === "boolean" ? existing.encrypted : false,
    };
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

    await this.storage.removeItem(key);
  }
}
