import { fromBase64, toBase64 } from "lib0/buffer";
import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";

import { EncryptedBinary } from "teleportal/encryption-key";
import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";
import type { IndexedSidecar, SidecarIndex } from "teleportal/protocol/encryption";
import type { SidecarCompaction } from "../../lib/protocol/encryption/encoding";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
} from "../document-storage";
import type { DocumentMetadata, EncodedContentMap } from "../types";
import { withTransaction } from "./transaction";

type StoredIndexedSidecar = {
  encrypted: string;
  index: SidecarIndex;
  hash: string;
};

type StoredState = {
  update: string;
  sidecars: StoredIndexedSidecar[];
};

type StoredPendingUpdate = {
  structureUpdate: string;
  sidecars: StoredIndexedSidecar[];
  compaction?: {
    sidecar: string;
    index: SidecarIndex;
    hash: string;
    sourceHashes: string[];
  };
};

function serializeState(state: DocumentState): StoredState {
  return {
    update: toBase64(state.update),
    sidecars: state.sidecars.map((s) => ({
      encrypted: toBase64(s.encrypted),
      index: s.index,
      hash: toBase64(s.hash),
    })),
  };
}

function deserializeState(record: StoredState): DocumentState {
  return {
    update: fromBase64(record.update),
    sidecars: record.sidecars.map((s) => ({
      encrypted: fromBase64(s.encrypted) as EncryptedBinary,
      index: s.index,
      hash: fromBase64(s.hash),
    })),
  };
}

function serializePendingUpdate(entry: PendingUpdate): StoredPendingUpdate {
  return {
    structureUpdate: toBase64(entry.structureUpdate),
    sidecars: entry.sidecars.map((s) => ({
      encrypted: toBase64(s.encrypted),
      index: s.index,
      hash: toBase64(s.hash),
    })),
    compaction: entry.compaction
      ? {
          sidecar: toBase64(entry.compaction.sidecar),
          index: entry.compaction.index,
          hash: toBase64(entry.compaction.hash),
          sourceHashes: entry.compaction.sourceHashes.map((h) => toBase64(h)),
        }
      : undefined,
  };
}

function deserializePendingUpdate(stored: StoredPendingUpdate): PendingUpdate {
  const compaction: SidecarCompaction | undefined = stored.compaction
    ? {
        sidecar: fromBase64(stored.compaction.sidecar) as EncryptedBinary,
        index: stored.compaction.index,
        hash: fromBase64(stored.compaction.hash),
        sourceHashes: stored.compaction.sourceHashes.map((h) => fromBase64(h)),
      }
    : undefined;
  return {
    structureUpdate: fromBase64(stored.structureUpdate),
    sidecars: stored.sidecars.map((s) => ({
      encrypted: fromBase64(s.encrypted) as EncryptedBinary,
      index: s.index,
      hash: fromBase64(s.hash),
    })),
    compaction,
  };
}

/**
 * Unstorage-backed document storage.
 *
 * Storage layout:
 * - `{prefix}:{key}:state`               -- JSON: base64 V2 update + sidecars
 * - `{prefix}:{key}:meta`                -- JSON: document metadata
 * - `{prefix}:{key}:pending`             -- JSON: array of pending updates
 * - `{prefix}:{key}:attribution:{uuid}`  -- raw attribution blobs
 */
export class UnstorageDocumentStorage extends AbstractDocumentStorage {
  private readonly storage: Storage;
  private readonly options: { ttl: number; keyPrefix: string };

  constructor(
    storage: Storage,
    options?: {
      ttl?: number;
      keyPrefix?: string;
      encrypted?: boolean;
    },
  ) {
    super(options?.encrypted ?? true);
    this.storage = storage;
    this.options = { ttl: 5 * 1000, keyPrefix: "", ...options };
  }

  #getKey(key: string): string {
    return this.options.keyPrefix ? `${this.options.keyPrefix}:${key}` : key;
  }

  #getMetadataKey(key: string): string {
    return this.#getKey(key) + ":meta";
  }

  #getStateKey(key: string): string {
    return this.#getKey(key) + ":state";
  }

  #getPendingKey(key: string): string {
    return this.#getKey(key) + ":pending";
  }

  #getAttributionKeyPrefix(key: string): string {
    return this.#getKey(key) + ":attribution";
  }

  #getAttributionKey(key: string): string {
    return this.#getAttributionKeyPrefix(key) + ":" + uuidv4();
  }

  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    const prefixedKey = this.#getKey(key);
    return withTransaction(this.storage, prefixedKey, async () => cb(), {
      ttl: this.options.ttl,
    });
  }

  // ── Pending log ────────────────────────────────────────────────────────

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    const stored =
      ((await this.storage.getItem(this.#getPendingKey(key))) as StoredPendingUpdate[] | null) ??
      [];
    stored.push(serializePendingUpdate(entry));
    await this.storage.setItem(this.#getPendingKey(key), stored);
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    const stored =
      ((await this.storage.getItem(this.#getPendingKey(key))) as StoredPendingUpdate[] | null) ??
      [];
    return {
      updates: stored.map(deserializePendingUpdate),
      cursor: stored.length,
    };
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    const stored =
      ((await this.storage.getItem(this.#getPendingKey(key))) as StoredPendingUpdate[] | null) ??
      [];
    if (upToCursor >= stored.length) {
      await this.storage.removeItem(this.#getPendingKey(key));
    } else {
      await this.storage.setItem(this.#getPendingKey(key), stored.slice(upToCursor));
    }
  }

  // ── Base state ─────────────────────────────────────────────────────────

  async getBaseState(key: string): Promise<DocumentState | null> {
    const stored = (await this.storage.getItem(this.#getStateKey(key))) as StoredState | null;
    if (!stored) return null;
    return deserializeState(stored);
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    await this.storage.setItem(this.#getStateKey(key), serializeState({ update, sidecars }));
  }

  // ── Metadata ───────────────────────────────────────────────────────────

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    await this.storage.setItem(this.#getMetadataKey(key), metadata);
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const metadata = await this.storage.getItem(this.#getMetadataKey(key));
    if (!metadata) {
      return { createdAt: now, updatedAt: now, encrypted: this.encrypted };
    }
    const m = metadata as DocumentMetadata;
    return {
      ...m,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now,
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now,
      encrypted: typeof m.encrypted === "boolean" ? m.encrypted : this.encrypted,
    };
  }

  // ── Attribution ────────────────────────────────────────────────────────

  override async storeAttribution(key: string, attribution: EncodedContentMap): Promise<void> {
    await this.storage.setItemRaw(this.#getAttributionKey(key), attribution);
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

  // ── Delete ─────────────────────────────────────────────────────────────

  async deleteDocument(key: string): Promise<void> {
    const promises: Promise<unknown>[] = [];

    promises.push(this.storage.removeItem(this.#getStateKey(key)));
    promises.push(this.storage.removeItem(this.#getPendingKey(key)));

    const attrKeys = await this.storage.getKeys(this.#getAttributionKeyPrefix(key));
    if (attrKeys.length > 0) {
      promises.push(...attrKeys.map((k) => this.storage.removeItem(k)));
    }

    promises.push(this.storage.removeItem(this.#getMetadataKey(key)));

    await Promise.all(promises);
  }
}
