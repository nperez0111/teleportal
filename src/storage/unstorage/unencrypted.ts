import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";
import * as Y from "yjs";

import { type StateVector, type Update } from "teleportal";
import { UnencryptedDocumentStorage } from "../unencrypted/document-storage";
import {
  DocumentMetadata,
  FileStorage,
  MilestoneStorage,
  Document,
} from "../types";

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
  public readonly milestoneStorage: MilestoneStorage | undefined;

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
    this.milestoneStorage = options?.milestoneStorage;
  }

  /**
   * Lock a key for 5 seconds
   * @param documentId - The document ID
   * @param cb - The callback to execute
   * @returns The TTL of the lock
   */
  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    const meta = await this.storage.getMeta(documentId);
    const lockedTTL = meta?.ttl;
    if (lockedTTL && lockedTTL > Date.now()) {
      // Wait for the lock to be released with jitter to avoid thundering herd
      const jitter = Math.random() * 1000; // Random delay between 0-1000ms
      const waitTime = lockedTTL - Date.now() + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return await this.transaction(documentId, cb);
    }
    const ttl = Date.now() + this.options.ttl;
    await this.storage.setMeta(documentId, { ttl, ...meta });
    const result = await cb();
    await this.storage.setMeta(documentId, { ttl: Date.now(), ...meta });
    return result;
  }

  /**
   * Persist a Y.js update to storage
   */
  async handleUpdate(
    documentId: string,
    update: Update,
    overwriteKeys?: boolean,
  ): Promise<void> {
    const updateKey = documentId + "-update-" + uuidv4();
    await this.storage.setItemRaw(updateKey, update);
    if (this.options.scanKeys) {
      return;
    }
    await this.transaction(documentId, async () => {
      const doc = await this.storage.getItem<{ keys: string[] }>(documentId);
      if (doc && Array.isArray(doc.keys) && !overwriteKeys) {
        doc.keys = Array.from(new Set(doc.keys.concat(updateKey)));
        await this.storage.setItem(documentId, doc);
      } else {
        await this.storage.setItem(documentId, { keys: [updateKey] });
      }
    });
  }

  /**
   * Retrieve a Y.js update from storage
   */
  async getDocument(documentId: string): Promise<Document | null> {
    const update = await this.compact(documentId);

    if (!update) {
      return null;
    }

    const stateVector = Y.encodeStateVectorFromUpdateV2(update) as StateVector;
    const metadata = await this.getDocumentMetadata(documentId);

    return {
      id: documentId,
      metadata,
      content: {
        update,
        stateVector,
      },
    };
  }

  private async compact(
    documentId: string,
    asyncDeleteKeys = true,
  ): Promise<Update | null> {
    const keys = this.options.scanKeys
      ? new Set(await this.storage.getKeys(documentId + "-update-"))
      : ((await this.storage.getItem<{ keys: Set<string> }>(documentId))
          ?.keys ?? new Set());

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
    const promise = this.handleUpdate(documentId, update, true).then(() => {
      return Promise.all(
        Array.from(keys).map((key) => this.storage.removeItem(key)),
      );
    });

    if (asyncDeleteKeys) {
      await promise;
    }

    return update;
  }

  async unload(documentId: string): Promise<void> {
    await this.compact(documentId, false);
  }

  async writeDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    await this.storage.setItem(documentId + ":meta", metadata);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    return (
      ((await this.storage.getItem(documentId + ":meta")) as DocumentMetadata) ??
      {}
    );
  }

  async deleteDocument(documentId: string): Promise<void> {
    // Cascade delete files
    if (this.fileStorage) {
      await this.fileStorage.deleteFilesByDocument(documentId);
    }

    // Cascade delete milestones
    if (this.milestoneStorage) {
        // Milestone storage interface doesn't have deleteMilestonesByDocument?
        // Wait, types.ts says `deleteMilestone(documentId, id | id[])`.
        // We need to fetch milestones first?
        const milestones = await this.milestoneStorage.getMilestones(documentId);
        if (milestones.length > 0) {
            await this.milestoneStorage.deleteMilestone(documentId, milestones.map(m => m.id));
        }
    }

    // Delete metadata
    await this.storage.removeItem(documentId + ":meta");

    // Delete updates and index
    const keys = this.options.scanKeys
      ? new Set(await this.storage.getKeys(documentId + "-update-"))
      : ((await this.storage.getItem<{ keys: Set<string> }>(documentId))
          ?.keys ?? new Set());

    if (keys.size > 0) {
      await Promise.all(
        Array.from(keys).map((k) => this.storage.removeItem(k)),
      );
    }

    await this.storage.removeItem(documentId);
  }
}
