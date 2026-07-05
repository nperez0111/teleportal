import * as Y from "yjs";

import type { VersionedUpdate } from "teleportal";
import type { EncryptedUpdatePayload } from "../lib/protocol/encryption/encoding";
import type { IndexedSidecar } from "../lib/protocol/encryption/content-cipher";
import { decodeContentEncryptedPayload } from "../lib/protocol/encryption/encoding";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
  buildIncomingSidecars,
  applySidecarUpdate,
  normalizeMetadata,
} from "./document-storage";
import type { DocumentMetadata, DocumentStorage, EncodedContentMap } from "./types";

/**
 * Decorator that turns any {@link AbstractDocumentStorage} into a
 * merge-on-write storage. Overrides {@link handleUpdate} to eagerly merge
 * each incoming update into the base state, so the pending log is always
 * empty and reads are simple base-state lookups.
 *
 * Use this to opt specific storage instances into the classic merge-on-write
 * behavior while the base class defaults to merge-on-read.
 */
export class MergeOnWriteStorage extends AbstractDocumentStorage {
  #inner: AbstractDocumentStorage;

  constructor(inner: AbstractDocumentStorage) {
    super(inner.encrypted);
    this.#inner = inner;
  }

  // ── Merge-on-write handleUpdate ────────────────────────────────────────

  override async handleUpdate(
    key: string,
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    await this.transaction(key, async () => {
      const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
      if (decoded.structureUpdate.length === 0) return;

      const incomingSidecars = await buildIncomingSidecars(decoded);
      const now = Date.now();
      const existing = await this.#inner.getBaseState(key);

      let merged: Uint8Array;
      let newSidecars: IndexedSidecar[];

      if (existing) {
        merged = Y.mergeUpdatesV2([existing.update, decoded.structureUpdate]);
        newSidecars = applySidecarUpdate(existing.sidecars, incomingSidecars, decoded.compaction);
      } else {
        merged = decoded.structureUpdate;
        newSidecars = [...incomingSidecars];
      }

      await this.#inner.replaceBaseState(key, merged, newSidecars);

      const metadata = normalizeMetadata(
        await this.#inner.getDocumentMetadata(key),
        now,
        this.encrypted,
      );
      await this.#inner.writeDocumentMetadata(key, {
        ...metadata,
        updatedAt: now,
        sizeBytes: merged.length + newSidecars.reduce((s, b) => s + b.encrypted.length, 0),
      });

      if (attribution) {
        await this.#inner.storeAttribution(key, attribution);
      }
    });
  }

  // ── Delegate all abstract primitives to inner ──────────────────────────

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    return this.#inner.appendUpdate(key, entry);
  }
  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    return this.#inner.getPendingUpdates(key);
  }
  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    return this.#inner.clearPendingUpdates(key, upToCursor);
  }
  async getBaseState(key: string): Promise<DocumentState | null> {
    return this.#inner.getBaseState(key);
  }
  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    return this.#inner.replaceBaseState(key, update, sidecars);
  }
  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    return this.#inner.getDocumentMetadata(key);
  }
  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    return this.#inner.writeDocumentMetadata(key, metadata);
  }
  async deleteDocument(key: string): Promise<void> {
    return this.#inner.deleteDocument(key);
  }
  override async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return this.#inner.transaction(key, cb);
  }
  override async storeAttribution(key: string, attribution: EncodedContentMap): Promise<void> {
    return this.#inner.storeAttribution(key, attribution);
  }
  async retrieveAttribution(documentId: string): Promise<EncodedContentMap | null> {
    const inner = this.#inner as DocumentStorage;
    return inner.retrieveAttribution?.(documentId) ?? null;
  }
}
