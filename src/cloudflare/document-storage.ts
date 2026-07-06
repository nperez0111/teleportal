import { uuidv4 } from "lib0/random";

import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";
import type { IndexedSidecar } from "teleportal/protocol/encryption";
import {
  AbstractDocumentStorage,
  type DocumentMetadata,
  type DocumentState,
  type EncodedContentMap,
  type PendingUpdate,
} from "teleportal/storage";

import {
  deleteKeys,
  type DurableObjectStorageLike,
  KeyedMutex,
  listAll,
  listAllKeys,
} from "./types";

/**
 * Pending-log sequence numbers are zero-padded so lexicographic key order
 * (what `list()` returns) matches insertion order.
 */
const SEQ_PAD = 16;

/**
 * Document storage backed directly by Durable Object storage.
 *
 * Values are stored via structured clone — updates and sidecars stay binary
 * with no base64/JSON round-trip. Each pending update gets its own key
 * (`{prefix}:{doc}:pending:{seq}`) so appends are O(1) writes rather than a
 * read-append-rewrite of one array.
 *
 * Storage layout:
 * - `{prefix}:{key}:state`               -- { update, sidecars }
 * - `{prefix}:{key}:meta`                -- document metadata
 * - `{prefix}:{key}:pending:{seq}`       -- one pending update per key
 * - `{prefix}:{key}:attribution:{uuid}`  -- attribution blobs
 *
 * Note: a value must fit Durable Object storage's per-value limit
 * (2 MiB for SQLite-backed objects), which bounds the compacted state of a
 * single document.
 */
export class DurableObjectDocumentStorage extends AbstractDocumentStorage {
  readonly #storage: DurableObjectStorageLike;
  readonly #keyPrefix: string;
  readonly #mutex = new KeyedMutex();
  /**
   * Next pending-log sequence number per document. The Durable Object
   * instance is the single writer for its storage, so an in-memory counter
   * (seeded from the log tail on first touch) stays authoritative.
   */
  readonly #nextSeq = new Map<string, number>();

  constructor(
    storage: DurableObjectStorageLike,
    options?: {
      keyPrefix?: string;
      encrypted?: boolean;
    },
  ) {
    super(options?.encrypted ?? true);
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "";
  }

  #getKey(key: string): string {
    return this.#keyPrefix ? `${this.#keyPrefix}:${key}` : key;
  }

  #getMetadataKey(key: string): string {
    return this.#getKey(key) + ":meta";
  }

  #getStateKey(key: string): string {
    return this.#getKey(key) + ":state";
  }

  #getPendingKeyPrefix(key: string): string {
    return this.#getKey(key) + ":pending:";
  }

  #getAttributionKeyPrefix(key: string): string {
    return this.#getKey(key) + ":attribution:";
  }

  override transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return this.#mutex.run(this.#getKey(key), cb);
  }

  // ── Pending log ────────────────────────────────────────────────────────

  async #allocateSeq(key: string): Promise<number> {
    let next = this.#nextSeq.get(key);
    if (next === undefined) {
      const tail = await this.#storage.list({
        prefix: this.#getPendingKeyPrefix(key),
        reverse: true,
        limit: 1,
      });
      const lastKey = tail.keys().next().value as string | undefined;
      next = lastKey === undefined ? 0 : Number(lastKey.slice(-SEQ_PAD)) + 1;
    }
    this.#nextSeq.set(key, next + 1);
    return next;
  }

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    const seq = await this.#allocateSeq(key);
    await this.#storage.put(
      this.#getPendingKeyPrefix(key) + String(seq).padStart(SEQ_PAD, "0"),
      entry,
    );
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    const entries = await listAll<PendingUpdate>(this.#storage, this.#getPendingKeyPrefix(key));
    const updates = [...entries.values()];
    return { updates, cursor: updates.length };
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    const keys = await listAllKeys(this.#storage, this.#getPendingKeyPrefix(key));
    await deleteKeys(this.#storage, keys.slice(0, upToCursor));
  }

  // ── Base state ─────────────────────────────────────────────────────────

  async getBaseState(key: string): Promise<DocumentState | null> {
    return (await this.#storage.get<DocumentState>(this.#getStateKey(key))) ?? null;
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    await this.#storage.put<DocumentState>(this.#getStateKey(key), { update, sidecars });
  }

  // ── Metadata ───────────────────────────────────────────────────────────

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    await this.#storage.put(this.#getMetadataKey(key), metadata);
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const metadata = await this.#storage.get<DocumentMetadata>(this.#getMetadataKey(key));
    if (!metadata) {
      return { createdAt: now, updatedAt: now, encrypted: this.encrypted };
    }
    return {
      ...metadata,
      createdAt: typeof metadata.createdAt === "number" ? metadata.createdAt : now,
      updatedAt: typeof metadata.updatedAt === "number" ? metadata.updatedAt : now,
      encrypted: typeof metadata.encrypted === "boolean" ? metadata.encrypted : this.encrypted,
    };
  }

  // ── Attribution ────────────────────────────────────────────────────────

  override async storeAttribution(key: string, attribution: EncodedContentMap): Promise<void> {
    await this.#storage.put(this.#getAttributionKeyPrefix(key) + uuidv4(), attribution);
  }

  async retrieveAttribution(key: string): Promise<EncodedContentMap | null> {
    const entries = await listAll<EncodedContentMap>(
      this.#storage,
      this.#getAttributionKeyPrefix(key),
    );
    const maps = [...entries.values()].filter(Boolean);
    if (maps.length === 0) return null;
    if (maps.length === 1) return maps[0];
    const merged = mergeContentMaps(maps.map((m) => decodeContentMap(m)));
    return encodeContentMap(merged) as EncodedContentMap;
  }

  // ── Delete ─────────────────────────────────────────────────────────────

  async deleteDocument(key: string): Promise<void> {
    const keys = [
      this.#getStateKey(key),
      this.#getMetadataKey(key),
      ...(await listAllKeys(this.#storage, this.#getPendingKeyPrefix(key))),
      ...(await listAllKeys(this.#storage, this.#getAttributionKeyPrefix(key))),
    ];
    await deleteKeys(this.#storage, keys);
    this.#nextSeq.delete(key);
  }
}
