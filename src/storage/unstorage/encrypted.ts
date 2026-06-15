import { fromBase64, toBase64 } from "lib0/buffer";
import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";

import { EncryptedBinary } from "teleportal/encryption-key";
import type {
  EncryptedSnapshot,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  decodeContentMap,
  encodeContentMap,
  getEmptyEncodedContentIds,
  mergeContentMaps,
} from "teleportal/attribution";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
  EncryptedSnapshotMetadata,
  StoredEncryptedUpdate,
} from "../encrypted";
import type { EncodedContentMap } from "../types";
import { withTransaction } from "./transaction";

type StoredUpdateRecord = {
  id: string;
  snapshotId: string;
  clientId: number;
  counter: number;
  serverVersion: number;
  payload: string;
};

function serializeUpdate(update: StoredEncryptedUpdate): StoredUpdateRecord {
  return {
    id: update.id,
    snapshotId: update.snapshotId,
    clientId: update.timestamp[0],
    counter: update.timestamp[1],
    serverVersion: update.serverVersion,
    payload: toBase64(update.payload),
  };
}

function deserializeUpdate(record: StoredUpdateRecord): StoredEncryptedUpdate {
  return {
    id: record.id,
    snapshotId: record.snapshotId,
    timestamp: [record.clientId, record.counter],
    payload: fromBase64(record.payload) as EncryptedBinary,
    serverVersion: record.serverVersion,
    contentIds: getEmptyEncodedContentIds(),
  };
}

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

  #getSnapshotPayloadKey(key: string, snapshotId: string): string {
    return this.#getKey(key) + `:snapshot:${snapshotId}:payload`;
  }

  #getSnapshotMetaKey(key: string, snapshotId: string): string {
    return this.#getKey(key) + `:snapshot:${snapshotId}:meta`;
  }

  #getSnapshotUpdatesKey(key: string, snapshotId: string): string {
    return this.#getKey(key) + `:snapshot:${snapshotId}:updates`;
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
        snapshots: [],
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

  async storeSnapshot(
    key: string,
    snapshot: EncryptedSnapshot,
    metadata: EncryptedSnapshotMetadata,
  ): Promise<void> {
    await this.storage.setItemRaw<EncryptedBinary>(
      this.#getSnapshotPayloadKey(key, snapshot.id),
      snapshot.payload,
    );
    await this.storage.setItem(
      this.#getSnapshotMetaKey(key, snapshot.id),
      metadata,
    );
  }

  async fetchSnapshot(
    key: string,
    snapshotId: string,
  ): Promise<EncryptedSnapshot | null> {
    const payload = await this.storage.getItemRaw<EncryptedBinary>(
      this.#getSnapshotPayloadKey(key, snapshotId),
    );
    if (!payload) {
      return null;
    }
    const metadata = await this.getSnapshotMetadata(key, snapshotId);
    return {
      id: snapshotId,
      parentSnapshotId: metadata?.parentSnapshotId ?? null,
      payload,
    };
  }

  async writeSnapshotMetadata(
    key: string,
    metadata: EncryptedSnapshotMetadata,
  ): Promise<void> {
    await this.storage.setItem(
      this.#getSnapshotMetaKey(key, metadata.id),
      metadata,
    );
  }

  async getSnapshotMetadata(
    key: string,
    snapshotId: string,
  ): Promise<EncryptedSnapshotMetadata | null> {
    const metadata = await this.storage.getItem(
      this.#getSnapshotMetaKey(key, snapshotId),
    );
    return (metadata as EncryptedSnapshotMetadata) ?? null;
  }

  async storeUpdate(key: string, update: StoredEncryptedUpdate): Promise<void> {
    const updatesKey = this.#getSnapshotUpdatesKey(key, update.snapshotId);
    const existing = (await this.storage.getItem(updatesKey)) as
      | StoredUpdateRecord[]
      | null;
    const updates = existing ?? [];
    updates.push(serializeUpdate(update));
    await this.storage.setItem(updatesKey, updates);
  }

  async fetchUpdates(
    key: string,
    snapshotId: string,
    afterVersion: number,
  ): Promise<StoredEncryptedUpdate[]> {
    const updatesKey = this.#getSnapshotUpdatesKey(key, snapshotId);
    const existing = (await this.storage.getItem(updatesKey)) as
      | StoredUpdateRecord[]
      | null;
    if (!existing) {
      return [];
    }
    return existing
      .filter((update) => update.serverVersion > afterVersion)
      .sort((a, b) => a.serverVersion - b.serverVersion)
      .map(deserializeUpdate);
  }

  override async handleUpdate(
    key: string,
    update: EncryptedUpdatePayload,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    await super.handleUpdate(key, update);
    if (attribution) {
      await this.storage.setItemRaw(this.#getAttributionKey(key), attribution);
    }
  }

  async retrieveAttribution(
    key: string,
  ): Promise<EncodedContentMap | null> {
    const attrKeys = await this.storage.getKeys(
      this.#getAttributionKeyPrefix(key),
    );
    if (attrKeys.length === 0) return null;
    if (attrKeys.length === 1) {
      return await this.storage.getItemRaw(attrKeys[0]);
    }
    const maps = (
      await Promise.all(
        attrKeys.map((k) => this.storage.getItemRaw<EncodedContentMap>(k)),
      )
    ).filter(Boolean) as EncodedContentMap[];
    if (maps.length === 0) return null;
    if (maps.length === 1) return maps[0];
    const merged = mergeContentMaps(maps.map((m) => decodeContentMap(m)));
    return encodeContentMap(merged) as EncodedContentMap;
  }

  async deleteDocument(key: string): Promise<void> {
    const metadata = await this.getDocumentMetadata(key);
    const snapshotIds = Array.isArray(metadata.snapshots)
      ? metadata.snapshots
      : [];
    const promises: Promise<unknown>[] = [];
    for (const snapshotId of snapshotIds) {
      promises.push(
        this.storage.removeItem(this.#getSnapshotPayloadKey(key, snapshotId)),
        this.storage.removeItem(this.#getSnapshotMetaKey(key, snapshotId)),
        this.storage.removeItem(this.#getSnapshotUpdatesKey(key, snapshotId)),
      );
    }
    await Promise.all(promises);

    // Delete attribution data
    const attrKeys = await this.storage.getKeys(
      this.#getAttributionKeyPrefix(key),
    );
    if (attrKeys.length > 0) {
      await Promise.all(attrKeys.map((k) => this.storage.removeItem(k)));
    }

    // Delete metadata
    await this.storage.removeItem(this.#getMetadataKey(key));
  }
}
