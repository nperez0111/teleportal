import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";
import type { IndexedSidecar } from "../../lib/protocol/encryption/content-cipher";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
} from "../document-storage";
import type { DocumentMetadata, EncodedContentMap } from "../types";

type DocumentRecord = {
  metadata: DocumentMetadata;
  state: DocumentState | null;
};

/**
 * Cached merged attribution for a document.
 *
 * `merged` is the encoded ContentMap folded from the first `coveredCount`
 * entries of `list` (the exact raw-append array it was built from). A read only
 * has to decode+merge the entries appended *after* `coveredCount`, turning a
 * per-read O(total-attribution) decode+merge+encode into an O(new-attribution)
 * one.
 *
 * The `list` reference is part of the cache key: if the document's raw list is
 * replaced by a fresh array (e.g. a test resets `attributionMaps`, or the doc is
 * deleted and re-created), the identity check fails and the cache is rebuilt,
 * so the cache can never serve bytes from a stale list.
 */
type AttributionCacheEntry = {
  list: EncodedContentMap[];
  merged: EncodedContentMap;
  coveredCount: number;
};

export class MemoryDocumentStorage extends AbstractDocumentStorage {
  public static docs = new Map<string, DocumentRecord>();
  public static attributionMaps = new Map<string, EncodedContentMap[]>();
  /**
   * Per-document cache of the merged attribution map. Kept in lock-step with
   * {@link attributionMaps}: cleared on delete, consulted/updated on retrieve.
   */
  public static attributionCache = new Map<string, AttributionCacheEntry>();
  public static pendingUpdates = new Map<string, PendingUpdate[]>();

  #pending: Map<string, PendingUpdate[]>;

  constructor(
    encrypted: boolean = true,
    private options: {
      write: (key: string, doc: DocumentRecord) => Promise<void>;
      fetch: (key: string) => Promise<DocumentRecord | undefined>;
      delete: (key: string) => Promise<void>;
      pendingMap?: Map<string, PendingUpdate[]>;
    } = {
      write: async (key, doc) => {
        MemoryDocumentStorage.docs.set(key, doc);
      },
      fetch: async (key) => {
        return MemoryDocumentStorage.docs.get(key);
      },
      delete: async (key) => {
        MemoryDocumentStorage.docs.delete(key);
      },
    },
  ) {
    super(encrypted);
    this.#pending = options.pendingMap ?? MemoryDocumentStorage.pendingUpdates;
  }

  // ── Pending log (merge-on-read) ────────────────────────────────────────

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    const list = this.#pending.get(key) ?? [];
    list.push(entry);
    this.#pending.set(key, list);
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    const list = this.#pending.get(key) ?? [];
    return { updates: [...list], cursor: list.length };
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    const list = this.#pending.get(key);
    if (!list) return;
    if (upToCursor >= list.length) {
      this.#pending.delete(key);
    } else {
      list.splice(0, upToCursor);
    }
  }

  // ── Base state ─────────────────────────────────────────────────────────

  async getBaseState(key: string): Promise<DocumentState | null> {
    const doc = await this.options.fetch(key);
    return doc?.state ?? null;
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    const now = Date.now();
    const existing =
      (await this.options.fetch(key)) ??
      ({
        metadata: { createdAt: now, updatedAt: now, encrypted: this.encrypted },
        state: null,
      } satisfies DocumentRecord);
    await this.options.write(key, {
      ...existing,
      state: { update, sidecars },
    });
  }

  // ── Metadata ───────────────────────────────────────────────────────────

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    const existing = await this.options.fetch(key);
    await this.options.write(key, {
      metadata,
      state: existing?.state ?? null,
    });
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const doc = await this.options.fetch(key);
    if (!doc) {
      return { createdAt: now, updatedAt: now, encrypted: this.encrypted };
    }
    const m = doc.metadata;
    return {
      ...m,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now,
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now,
      encrypted: typeof m.encrypted === "boolean" ? m.encrypted : this.encrypted,
    };
  }

  // ── Attribution ────────────────────────────────────────────────────────

  static ATTRIBUTION_COMPACTION_THRESHOLD = 20;

  override async storeAttribution(key: string, attribution: EncodedContentMap): Promise<void> {
    let list = MemoryDocumentStorage.attributionMaps.get(key);
    if (!list) {
      list = [];
      MemoryDocumentStorage.attributionMaps.set(key, list);
    }
    list.push(attribution);
    // Appends beyond the compaction threshold are folded into the cache eagerly
    // so the raw list can be collapsed and never grows unbounded between reads.
    if (list.length >= MemoryDocumentStorage.ATTRIBUTION_COMPACTION_THRESHOLD) {
      MemoryDocumentStorage.#foldAttribution(key, list);
    }
  }

  async retrieveAttribution(documentId: string): Promise<EncodedContentMap | null> {
    const list = MemoryDocumentStorage.attributionMaps.get(documentId);
    if (!list || list.length === 0) return null;
    return MemoryDocumentStorage.#foldAttribution(documentId, list);
  }

  /**
   * Fold every entry of `list` into the document's merged-attribution cache and
   * return the merged blob. Repeated calls with no new appends return the cached
   * blob without decoding anything; a call after N new appends only decodes and
   * merges those N entries plus the cached blob.
   *
   * The returned bytes are identical to
   * `encodeContentMap(mergeContentMaps(list.map(decodeContentMap)))` over the
   * full list — {@link mergeContentMaps} normalizes ranges deterministically, so
   * folding the cached prefix first and the new suffix after preserves the wire
   * form (a Y.js v14 / yhub compatibility contract).
   */
  static #foldAttribution(key: string, list: EncodedContentMap[]): EncodedContentMap {
    let cached = MemoryDocumentStorage.attributionCache.get(key);

    // A cache built from a different array (list was reset/recreated) is stale.
    if (cached && cached.list !== list) {
      cached = undefined;
      MemoryDocumentStorage.attributionCache.delete(key);
    }

    // Cache already covers the whole list — nothing new to decode.
    if (cached && cached.coveredCount === list.length) {
      // Collapse the raw list to the single merged blob so subsequent reads and
      // appends stay cheap. `coveredCount` stays 1 to match the collapsed list.
      if (list.length > 1) {
        list.length = 0;
        list.push(cached.merged);
        cached.coveredCount = 1;
      }
      return cached.merged;
    }

    // Fold only the entries appended since the cache was last built.
    const toMerge: EncodedContentMap[] = [];
    if (cached) {
      toMerge.push(cached.merged);
      for (let i = cached.coveredCount; i < list.length; i++) {
        toMerge.push(list[i]);
      }
    } else {
      for (const m of list) toMerge.push(m);
    }

    const merged =
      toMerge.length === 1
        ? toMerge[0]
        : (encodeContentMap(
            mergeContentMaps(toMerge.map((m) => decodeContentMap(m))),
          ) as EncodedContentMap);

    // Collapse the raw list to the merged blob and record it in the cache. The
    // cache holds the same `list` reference so a later reset invalidates it.
    list.length = 0;
    list.push(merged);
    MemoryDocumentStorage.attributionCache.set(key, { list, merged, coveredCount: 1 });
    return merged;
  }

  // ── Delete ─────────────────────────────────────────────────────────────

  async deleteDocument(key: string): Promise<void> {
    await this.options.delete(key);
    this.#pending.delete(key);
    MemoryDocumentStorage.attributionMaps.delete(key);
    MemoryDocumentStorage.attributionCache.delete(key);
  }
}
