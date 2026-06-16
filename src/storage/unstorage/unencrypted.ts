import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";

import {
  getStateVectorFromUpdate,
  mergeUpdates,
  type UpdateV2,
  type VersionedUpdate,
} from "teleportal";
import { convertToV2, encodeVersionedBytes, decodeVersionedBytes } from "teleportal/protocol";
import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";
import type { Document, DocumentMetadata, EncodedContentMap } from "../types";
import { UnencryptedDocumentStorage } from "../unencrypted";
import { calculateDocumentSize } from "../utils";
import { withTransaction } from "./transaction";

/**
 * A storage implementation that is backed by unstorage.
 *
 * It allows operating in two modes:
 * - key-scanning for other updates (useful in a relational DB)
 * - a single key for the update and a separate key for the state vector (useful in a key-value store).
 */
export class UnstorageDocumentStorage extends UnencryptedDocumentStorage {
  private readonly storage: Storage;
  private readonly options: {
    scanKeys: boolean;
    ttl: number;
    keyPrefix: string;
    transactionBaseDelay: number;
  };
  constructor(
    storage: Storage,
    options?: {
      scanKeys?: boolean;
      ttl?: number;
      keyPrefix?: string;
      transactionBaseDelay?: number;
    },
  ) {
    super();
    this.storage = storage;
    this.options = {
      scanKeys: false,
      ttl: 5 * 1000,
      keyPrefix: "",
      transactionBaseDelay: 50,
      ...options,
    };
  }

  #getKey(key: string): string {
    return this.options.keyPrefix ? `${this.options.keyPrefix}:${key}` : key;
  }

  #getUpdateKeyPrefix(key: string): string {
    return this.#getKey(key) + "-update-";
  }

  #getMetadataKey(key: string): string {
    return this.#getKey(key) + ":meta";
  }

  #getAttributionKeyPrefix(key: string): string {
    return this.#getKey(key) + ":attribution";
  }

  #getAttributionKey(key: string): string {
    return this.#getAttributionKeyPrefix(key) + ":" + uuidv4();
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
      baseDelay: this.options.transactionBaseDelay,
    });
  }

  /**
   * Persist a Y.js update to storage. Stores the raw bytes with a version
   * prefix so the original encoding (V1 or V2) is preserved.
   */
  async handleUpdate(
    key: string,
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
    overwriteKeys?: boolean,
  ): Promise<void> {
    const prefixedKey = this.#getKey(key);
    const updateKey = this.#getUpdateKeyPrefix(key) + uuidv4();
    await this.storage.setItemRaw(updateKey, encodeVersionedBytes(update));

    if (attribution) {
      await this.storage.setItemRaw(this.#getAttributionKey(key), attribution);
    }
    if (this.options.scanKeys) {
      return;
    }
    await this.transaction(key, async () => {
      const doc = await this.storage.getItem<{ keys: string[] }>(prefixedKey);
      if (doc && Array.isArray(doc.keys) && !overwriteKeys) {
        doc.keys = [...new Set([...doc.keys, updateKey])];
        await this.storage.setItem(prefixedKey, doc);
      } else {
        await this.storage.setItem(prefixedKey, { keys: [updateKey] });
      }

      const meta = await this.getDocumentMetadata(key);
      const updateSize = calculateDocumentSize(update.data as UpdateV2);
      const sizeBytes = overwriteKeys ? updateSize : (meta.sizeBytes ?? 0) + updateSize;

      await this.writeDocumentMetadata(key, {
        ...meta,
        updatedAt: Date.now(),
        sizeBytes,
      });
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

    const stateVector = getStateVectorFromUpdate(update);
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

  /**
   * Compact all stored updates into a single V2 update. Individual updates may
   * be V1 or V2; they are all converted to V2 at merge time.
   */
  private async compact(key: string, asyncDeleteKeys = true): Promise<UpdateV2 | null> {
    const prefixedKey = this.#getKey(key);
    const keys = this.options.scanKeys
      ? new Set(await this.storage.getKeys(this.#getUpdateKeyPrefix(key)))
      : ((await this.storage.getItem<{ keys: Set<string> }>(prefixedKey))?.keys ?? new Set());

    if (keys.size === 0) {
      return null;
    }
    if (keys.size === 1) {
      const raw: Uint8Array | null = await this.storage.getItemRaw([...keys][0]);
      if (!raw) return null;
      const versioned = decodeVersionedBytes(raw);
      return convertToV2(versioned);
    }

    const rawUpdates = (
      await Promise.all([...keys].map((key) => this.storage.getItemRaw<Uint8Array>(key)))
    ).filter(Boolean) as Uint8Array[];

    const v2Updates = rawUpdates.map((raw) => convertToV2(decodeVersionedBytes(raw)));

    const update = mergeUpdates(v2Updates);

    const versioned: VersionedUpdate = { version: 2, data: update };
    const promise = this.handleUpdate(key, versioned, undefined, true).then(() => {
      return Promise.all([...keys].map((key) => this.storage.removeItem(key)));
    });

    if (asyncDeleteKeys) {
      await promise;
    }

    return update;
  }

  async unload(key: string): Promise<void> {
    await this.compact(key, false);
  }

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    await this.storage.setItem(this.#getMetadataKey(key), metadata);
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const existing = (await this.storage.getItem(
      this.#getMetadataKey(key),
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
      createdAt: typeof existing.createdAt === "number" ? existing.createdAt : now,
      updatedAt: typeof existing.updatedAt === "number" ? existing.updatedAt : now,
      encrypted: typeof existing.encrypted === "boolean" ? existing.encrypted : false,
    };
  }

  async retrieveAttribution(key: string): Promise<EncodedContentMap | null> {
    const attrKeys = await this.storage.getKeys(this.#getAttributionKeyPrefix(key));
    if (attrKeys.length === 0) return null;
    if (attrKeys.length === 1) {
      return await this.storage.getItemRaw(attrKeys[0]);
    }
    const maps = (
      await Promise.all(attrKeys.map((k) => this.storage.getItemRaw<EncodedContentMap>(k)))
    ).filter(Boolean) as EncodedContentMap[];
    if (maps.length === 0) return null;
    if (maps.length === 1) return maps[0];
    const merged = mergeContentMaps(maps.map((m) => decodeContentMap(m)));
    return encodeContentMap(merged) as EncodedContentMap;
  }

  async deleteDocument(key: string): Promise<void> {
    const prefixedKey = this.#getKey(key);
    // Delete metadata
    await this.storage.removeItem(this.#getMetadataKey(key));

    // Delete updates and index
    const keys = this.options.scanKeys
      ? new Set(await this.storage.getKeys(this.#getUpdateKeyPrefix(key)))
      : ((await this.storage.getItem<{ keys: Set<string> }>(prefixedKey))?.keys ?? new Set());

    if (keys.size > 0) {
      await Promise.all([...keys].map((k) => this.storage.removeItem(k)));
    }

    // Delete attribution data
    const attrKeys = await this.storage.getKeys(this.#getAttributionKeyPrefix(key));
    if (attrKeys.length > 0) {
      await Promise.all(attrKeys.map((k) => this.storage.removeItem(k)));
    }

    await this.storage.removeItem(prefixedKey);
  }
}
