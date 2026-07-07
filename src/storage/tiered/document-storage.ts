import type { IndexedSidecar } from "../../lib/protocol/encryption/content-cipher";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
} from "../document-storage";
import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";
import type { Document, DocumentMetadata, DocumentStorage, EncodedContentMap } from "../types";
import type { StateVector, VersionedSyncStep2Update, VersionedUpdate } from "teleportal";

export interface TieredDocumentStorageOptions {
  /** Interval in ms between persist sweeps (default: 5000) */
  persistIntervalMs?: number;
  /** Max time in ms a document can stay dirty before forced persist (default: 30000) */
  maxDirtyAgeMs?: number;
  /** Max documents to persist per sweep (default: 50) */
  persistBatchSize?: number;
  /** Evict clean documents from fast tier after this many ms of inactivity (default: undefined = never) */
  evictAfterMs?: number;
  /** Callback for background persist failures */
  onPersistError?: (documentId: string, error: unknown) => void;
}

const defaults = {
  persistIntervalMs: 5000,
  maxDirtyAgeMs: 30_000,
  persistBatchSize: 50,
} satisfies Partial<TieredDocumentStorageOptions>;

function compactAttributionMaps(maps: EncodedContentMap[]): EncodedContentMap {
  if (maps.length === 1) return maps[0];
  const merged = mergeContentMaps(maps.map((m) => decodeContentMap(m)));
  return encodeContentMap(merged);
}

/**
 * Composes two {@link AbstractDocumentStorage} instances into a two-tier
 * storage system following the yhub pattern. Merge-strategy-agnostic — the
 * fast and slow tiers each decide their own merge behavior.
 *
 * - **fast tier** (intermediate): quick-access store for active documents.
 * - **slow tier** (persistence): durable store for all documents.
 *
 * Documents are loaded from the slow tier on first access. All subsequent
 * reads/writes operate on the fast tier. Dirty documents are periodically
 * flushed back to the slow tier for durability.
 */
export class TieredDocumentStorage extends AbstractDocumentStorage {
  #fast: AbstractDocumentStorage;
  #slow: AbstractDocumentStorage;
  #options: Required<
    Pick<TieredDocumentStorageOptions, "persistIntervalMs" | "maxDirtyAgeMs" | "persistBatchSize">
  > &
    Pick<TieredDocumentStorageOptions, "evictAfterMs" | "onPersistError">;

  #loaded = new Set<string>();
  #dirty = new Map<string, number>();
  #lastAccess = new Map<string, number>();
  #loading = new Map<string, Promise<void>>();
  #pendingAttributions = new Map<string, EncodedContentMap[]>();
  #attributionLoaded = new Set<string>();
  #persistTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(
    fast: AbstractDocumentStorage,
    slow: AbstractDocumentStorage,
    options?: TieredDocumentStorageOptions,
  ) {
    super(fast.encrypted);
    this.#fast = fast;
    this.#slow = slow;
    this.#options = {
      persistIntervalMs: options?.persistIntervalMs ?? defaults.persistIntervalMs,
      maxDirtyAgeMs: options?.maxDirtyAgeMs ?? defaults.maxDirtyAgeMs,
      persistBatchSize: options?.persistBatchSize ?? defaults.persistBatchSize,
      evictAfterMs: options?.evictAfterMs,
      onPersistError: options?.onPersistError,
    };

    this.#startPersistTimer();
  }

  // ── Abstract primitive implementations (delegate to fast tier) ─────────

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    await this.#ensureLoaded(key);
    await this.#fast.appendUpdate(key, entry);
    this.#markDirty(key);
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    await this.#ensureLoaded(key);
    return this.#fast.getPendingUpdates(key);
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    await this.#fast.clearPendingUpdates(key, upToCursor);
  }

  async getBaseState(key: string): Promise<DocumentState | null> {
    await this.#ensureLoaded(key);
    return this.#fast.getBaseState(key);
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    if (!this.#loaded.has(key)) {
      this.#loaded.add(key);
      this.#lastAccess.set(key, Date.now());
    }
    await this.#fast.replaceBaseState(key, update, sidecars);
    this.#markDirty(key);
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    await this.#ensureLoaded(key);
    return this.#fast.getDocumentMetadata(key);
  }

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    await this.#ensureLoaded(key);
    await this.#fast.writeDocumentMetadata(key, metadata);
    this.#markDirty(key);
  }

  async deleteDocument(key: string): Promise<void> {
    await Promise.all([this.#fast.deleteDocument(key), this.#slow.deleteDocument(key)]);
    this.#loaded.delete(key);
    this.#dirty.delete(key);
    this.#lastAccess.delete(key);
    this.#loading.delete(key);
    this.#pendingAttributions.delete(key);
    this.#attributionLoaded.delete(key);
  }

  // ── Transaction ────────────────────────────────────────────────────────

  override async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return this.#fast.transaction(key, cb);
  }

  // ── Hot-path overrides ─────────────────────────────────────────────────
  // Ensure load once and delegate to fast tier directly, eliminating
  // redundant async hops through the abstract methods.

  override async handleUpdate(
    key: string,
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    await this.#ensureLoaded(key);
    await this.#fast.handleUpdate(key, update);
    this.#markDirty(key);
    if (attribution) {
      await this.storeAttribution(key, attribution);
    }
  }

  override async getDocumentState(key: string): Promise<DocumentState | null> {
    await this.#ensureLoaded(key);
    return this.#fast.getDocumentState(key);
  }

  override async replaceDocumentState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    if (!this.#loaded.has(key)) {
      this.#loaded.add(key);
      this.#lastAccess.set(key, Date.now());
    }
    await this.#fast.replaceDocumentState(key, update, sidecars);
    this.#markDirty(key);
  }

  override async getDocument(key: string): Promise<Document | null> {
    await this.#ensureLoaded(key);
    return this.#fast.getDocument(key);
  }

  override async handleSyncStep1(key: string, syncStep1: StateVector): Promise<Document> {
    await this.#ensureLoaded(key);
    return this.#fast.handleSyncStep1(key, syncStep1);
  }

  override async handleSyncStep2(key: string, syncStep2: VersionedSyncStep2Update): Promise<void> {
    await this.#ensureLoaded(key);
    await this.#fast.handleSyncStep2(key, syncStep2);
    this.#markDirty(key);
  }

  // ── Attribution ────────────────────────────────────────────────────────

  override async storeAttribution(key: string, attribution: EncodedContentMap): Promise<void> {
    await this.#fast.storeAttribution(key, attribution);

    const existing = this.#pendingAttributions.get(key) ?? [];
    existing.push(attribution);
    this.#pendingAttributions.set(key, existing);
    this.#markDirty(key);
  }

  async retrieveAttribution(documentId: string): Promise<EncodedContentMap | null> {
    await this.#ensureLoaded(documentId);

    if (!this.#attributionLoaded.has(documentId)) {
      const slowAttr = await (this.#slow as DocumentStorage).retrieveAttribution?.(documentId);
      if (slowAttr) {
        await this.#fast.storeAttribution(documentId, slowAttr);
      }
      this.#attributionLoaded.add(documentId);
    }

    const fast = this.#fast as DocumentStorage;
    if (fast.retrieveAttribution) {
      return fast.retrieveAttribution(documentId);
    }
    return null;
  }

  // ── Load-on-first-access ───────────────────────────────────────────────

  async #ensureLoaded(key: string): Promise<void> {
    if (this.#loaded.has(key)) {
      this.#lastAccess.set(key, Date.now());
      return;
    }

    const inflight = this.#loading.get(key);
    if (inflight) {
      await inflight;
      return;
    }

    const loadPromise = this.#loadFromSlow(key);
    this.#loading.set(key, loadPromise);
    try {
      await loadPromise;
    } finally {
      this.#loading.delete(key);
    }
  }

  async #loadFromSlow(key: string): Promise<void> {
    const [state, metadata] = await Promise.all([
      this.#slow.getDocumentState(key),
      this.#slow.getDocumentMetadata(key),
    ]);

    if (state) {
      await this.#fast.replaceDocumentState(key, state.update, state.sidecars);
      await this.#fast.writeDocumentMetadata(key, metadata);
    }

    this.#loaded.add(key);
    this.#lastAccess.set(key, Date.now());
  }

  // ── Dirty tracking ─────────────────────────────────────────────────────

  #markDirty(key: string) {
    if (!this.#dirty.has(key)) {
      this.#dirty.set(key, Date.now());
    }
    this.#lastAccess.set(key, Date.now());
  }

  // ── Persist (fast → slow) ──────────────────────────────────────────────

  #startPersistTimer() {
    if (this.#persistTimer) return;
    this.#persistTimer = setInterval(() => {
      void this.#persistSweep();
    }, this.#options.persistIntervalMs);
    if (typeof this.#persistTimer === "object" && "unref" in this.#persistTimer) {
      (this.#persistTimer as { unref: () => void }).unref();
    }
  }

  async #persistSweep(): Promise<void> {
    if (this.#disposed) return;

    const now = Date.now();
    const toPersist: string[] = [];

    for (const [key, dirtyTime] of this.#dirty) {
      if (
        now - dirtyTime >= this.#options.maxDirtyAgeMs ||
        toPersist.length < this.#options.persistBatchSize
      ) {
        toPersist.push(key);
      }
      if (toPersist.length >= this.#options.persistBatchSize) break;
    }

    for (const key of toPersist) {
      try {
        await this.#persistDocument(key);
      } catch (error) {
        this.#options.onPersistError?.(key, error);
      }
    }

    if (this.#options.evictAfterMs != null) {
      const evictBefore = now - this.#options.evictAfterMs;
      for (const [key, lastAccess] of this.#lastAccess) {
        if (lastAccess < evictBefore && !this.#dirty.has(key)) {
          await this.#evictDocument(key);
        }
      }
    }
  }

  async #persistDocument(key: string): Promise<void> {
    const state = await this.#fast.getDocumentState(key);
    const metadata = await this.#fast.getDocumentMetadata(key);

    if (state) {
      await this.#slow.transaction(key, async () => {
        await this.#slow.replaceDocumentState(key, state.update, state.sidecars);
        await this.#slow.writeDocumentMetadata(key, metadata);
      });
      // Compact fast tier: clears the pending log so the same updates
      // aren't re-materialized on subsequent reads.
      await this.#fast.replaceDocumentState(key, state.update, state.sidecars);
    }

    const attributions = this.#pendingAttributions.get(key);
    if (attributions?.length) {
      const compacted = compactAttributionMaps(attributions);
      await this.#slow.storeAttribution(key, compacted);
      this.#pendingAttributions.delete(key);
    }

    this.#dirty.delete(key);
  }

  async #evictDocument(key: string): Promise<void> {
    if (this.#dirty.has(key)) return;
    await this.#fast.deleteDocument(key);
    this.#loaded.delete(key);
    this.#lastAccess.delete(key);
    this.#attributionLoaded.delete(key);
  }

  // ── Public flush / dispose ─────────────────────────────────────────────

  async flush(documentId: string): Promise<void> {
    if (this.#dirty.has(documentId)) {
      await this.#persistDocument(documentId);
    }
  }

  async flushAll(): Promise<void> {
    const keys = [...this.#dirty.keys()];
    for (const key of keys) {
      try {
        await this.#persistDocument(key);
      } catch (error) {
        this.#options.onPersistError?.(key, error);
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed = true;
    if (this.#persistTimer) {
      clearInterval(this.#persistTimer);
      this.#persistTimer = null;
    }
    await this.flushAll();
  }
}
