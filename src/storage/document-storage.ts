import * as Y from "yjs";

import type { StateVector, UpdateV2, VersionedSyncStep2Update, VersionedUpdate } from "teleportal";
import { getEmptyStateVector } from "teleportal";
import type { EncryptedUpdatePayload } from "../lib/protocol/encryption/encoding";
import type { IndexedSidecar } from "../lib/protocol/encryption/content-cipher";
import {
  buildSidecarIndexFromUpdateMeta,
  hashSidecar,
  sidecarOverlapsDiff,
} from "../lib/protocol/encryption/content-cipher";
import {
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
  getEmptyContentEncryptedPayload,
} from "../lib/protocol/encryption/encoding";
import type { SidecarCompaction } from "../lib/protocol/encryption/encoding";
import type { Document, DocumentMetadata, DocumentStorage, EncodedContentMap } from "./types";
import { bytesEqual } from "./utils";

/**
 * Internal representation of a document's persisted state: a merged V2
 * structure update plus its associated encrypted sidecars. For unencrypted
 * documents the sidecars array is empty.
 */
export type DocumentState = {
  update: Uint8Array;
  sidecars: IndexedSidecar[];
};

/**
 * A decoded but unmerged update waiting in the pending log.
 */
export type PendingUpdate = {
  structureUpdate: Uint8Array;
  sidecars: IndexedSidecar[];
  compaction?: SidecarCompaction;
};

export function normalizeMetadata(
  metadata: DocumentMetadata | null,
  now: number,
  encrypted: boolean,
): DocumentMetadata {
  const base = metadata ?? ({} as DocumentMetadata);
  return {
    ...base,
    createdAt: typeof base.createdAt === "number" ? base.createdAt : now,
    updatedAt: typeof base.updatedAt === "number" ? base.updatedAt : now,
    encrypted,
  };
}

/**
 * Build {@link IndexedSidecar}s from a decoded content-encrypted payload.
 * Returns an empty array when the payload carries no sidecars or the update
 * has no insert structs (delete-only diff).
 */
export async function buildIncomingSidecars(
  decoded: import("../lib/protocol/encryption/encoding").ContentEncryptedPayload,
): Promise<IndexedSidecar[]> {
  if (decoded.encryptedSidecars.length === 0) return [];
  const incomingMeta = Y.parseUpdateMetaV2(decoded.structureUpdate);
  const index = buildSidecarIndexFromUpdateMeta(incomingMeta);
  if (index.length === 0) return [];
  return Promise.all(
    decoded.encryptedSidecars.map(async (encrypted) => ({
      encrypted,
      index,
      hash: await hashSidecar(encrypted),
    })),
  );
}

/**
 * Apply incoming sidecars (and an optional compaction record) to an existing
 * sidecar list. Returns the new combined list.
 */
export function applySidecarUpdate(
  existing: IndexedSidecar[],
  incoming: IndexedSidecar[],
  compaction?: import("../lib/protocol/encryption/encoding").SidecarCompaction,
): IndexedSidecar[] {
  if (compaction) {
    const matchedIndices = new Set<number>();
    for (const sourceHash of compaction.sourceHashes) {
      const idx = existing.findIndex((s) => bytesEqual(s.hash, sourceHash));
      if (idx !== -1) matchedIndices.add(idx);
    }
    if (matchedIndices.size === compaction.sourceHashes.length) {
      const compactedSidecar: IndexedSidecar = {
        encrypted: compaction.sidecar,
        index: compaction.index,
        hash: compaction.hash,
      };
      const keptSidecars = existing.filter((_, i) => !matchedIndices.has(i));
      return [compactedSidecar, ...keptSidecars, ...incoming];
    }
  }
  return incoming.length === 0 ? existing : [...existing, ...incoming];
}

/**
 * Document storage base class — merge-on-read by default.
 *
 * Updates are appended to a pending log on write (O(1)). Reads materialize
 * the log by batch-merging all pending updates with the base state via a
 * single {@link Y.mergeUpdatesV2} call. This trades storage for CPU: writes
 * are cheaper, reads pay the merge cost.
 *
 * Subclasses implement the storage primitives (append, get base, etc.).
 * Wrap with a merge-on-write decorator to get eager merging instead.
 */
export abstract class AbstractDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  readonly encrypted: boolean;

  get storageType(): "encrypted" | "unencrypted" {
    return this.encrypted ? "encrypted" : "unencrypted";
  }

  constructor(encrypted: boolean = true) {
    this.encrypted = encrypted;
  }

  // ── Abstract primitives (subclass implements) ──────────────────────────

  /** Append an unmerged update to the pending log. */
  abstract appendUpdate(key: string, entry: PendingUpdate): Promise<void>;

  /**
   * Return all pending updates and a cursor marking how many were read.
   * {@link clearPendingUpdates} uses the cursor to remove only the entries
   * that were consumed, so updates appended concurrently survive.
   */
  abstract getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }>;

  /** Remove the first {@link upToCursor} entries from the pending log. */
  abstract clearPendingUpdates(key: string, upToCursor: number): Promise<void>;

  /** Return the last compacted (fully merged) state, or null for new documents. */
  abstract getBaseState(key: string): Promise<DocumentState | null>;

  /** Overwrite the compacted base state. */
  abstract replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void>;

  abstract getDocumentMetadata(key: string): Promise<DocumentMetadata>;
  abstract writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void>;
  abstract deleteDocument(key: string): Promise<void>;

  async storeAttribution(_key: string, _attribution: EncodedContentMap): Promise<void> {}

  transaction<T>(_key: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  // ── Concrete: materialize on read ──────────────────────────────────────

  /**
   * Materializes the document state by batch-merging any pending updates
   * with the base state. Returns the fully merged result.
   */
  async getDocumentState(key: string): Promise<DocumentState | null> {
    const base = await this.getBaseState(key);
    const { updates: pending } = await this.getPendingUpdates(key);
    if (pending.length === 0) return base;
    return materialize(base, pending);
  }

  /**
   * Set the canonical document state: replaces the base and clears the
   * entire pending log. Called by {@link handleCompaction} and by
   * {@link TieredDocumentStorage} flush.
   */
  async replaceDocumentState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    await this.replaceBaseState(key, update, sidecars);
    await this.clearPendingUpdates(key, Infinity);
  }

  // ── Concrete: append on write ──────────────────────────────────────────

  /**
   * Append an update to the pending log (O(1), no merge).
   */
  async handleUpdate(
    key: string,
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    await this.transaction(key, async () => {
      const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
      if (decoded.structureUpdate.length === 0) return;

      const incomingSidecars = await buildIncomingSidecars(decoded);

      await this.appendUpdate(key, {
        structureUpdate: decoded.structureUpdate,
        sidecars: incomingSidecars,
        compaction: decoded.compaction,
      });

      const now = Date.now();
      const metadata = normalizeMetadata(await this.getDocumentMetadata(key), now, this.encrypted);
      await this.writeDocumentMetadata(key, { ...metadata, updatedAt: now });

      if (attribution) {
        await this.storeAttribution(key, attribution);
      }
    });
  }

  // ── Inherited read methods (work via getDocumentState) ─────────────────

  async handleSyncStep1(key: string, syncStep1: StateVector): Promise<Document> {
    const now = Date.now();
    const metadata = normalizeMetadata(await this.getDocumentMetadata(key), now, this.encrypted);
    const state = await this.getDocumentState(key);

    if (!state) {
      return {
        id: key,
        metadata: { ...metadata, updatedAt: now },
        content: {
          update: getEmptyContentEncryptedPayload() as UpdateV2,
          stateVector: getEmptyStateVector(),
        },
      };
    }

    const diff = Y.diffUpdateV2(state.update, syncStep1);
    const serverSV = Y.encodeStateVectorFromUpdateV2(state.update) as StateVector;

    let encryptedSidecars: Uint8Array[];
    if (state.sidecars.length === 0) {
      encryptedSidecars = [];
    } else {
      const diffMeta = Y.parseUpdateMetaV2(diff);
      encryptedSidecars = state.sidecars
        .filter((s) => sidecarOverlapsDiff(s.index, diffMeta))
        .map((s) => s.encrypted);
    }

    const update = encodeContentEncryptedPayload({
      structureUpdate: diff,
      encryptedSidecars,
    }) as unknown as UpdateV2;

    return {
      id: key,
      metadata: { ...metadata, updatedAt: now },
      content: { update, stateVector: serverSV },
    };
  }

  async handleSyncStep2(key: string, syncStep2: VersionedSyncStep2Update): Promise<void> {
    await this.handleUpdate(key, {
      version: syncStep2.version,
      data: syncStep2.data,
    } as unknown as VersionedUpdate);
  }

  async handleCompaction(
    key: string,
    compactedSidecar: IndexedSidecar,
    baseSV: Uint8Array,
  ): Promise<boolean> {
    return this.transaction(key, async () => {
      const state = await this.getDocumentState(key);
      if (!state) return false;

      const currentSV = Y.encodeStateVectorFromUpdateV2(state.update);
      if (!bytesEqual(currentSV, baseSV)) return false;

      await this.replaceDocumentState(key, state.update, [compactedSidecar]);
      return true;
    });
  }

  async getDocument(key: string): Promise<Document | null> {
    const now = Date.now();
    const state = await this.getDocumentState(key);
    if (!state) return null;

    const metadata = normalizeMetadata(await this.getDocumentMetadata(key), now, this.encrypted);
    const serverSV = Y.encodeStateVectorFromUpdateV2(state.update) as StateVector;

    const update = encodeContentEncryptedPayload({
      structureUpdate: state.update,
      encryptedSidecars: state.sidecars.map((s) => s.encrypted),
    }) as unknown as UpdateV2;

    return {
      id: key,
      metadata: { ...metadata, updatedAt: now },
      content: { update, stateVector: serverSV },
    };
  }
}

/**
 * Batch-merge pending updates with an optional base state.
 */
function materialize(base: DocumentState | null, pending: PendingUpdate[]): DocumentState {
  const updates: Uint8Array[] = base ? [base.update] : [];
  for (const p of pending) updates.push(p.structureUpdate);
  const merged = updates.length === 1 ? updates[0] : Y.mergeUpdatesV2(updates);

  let sidecars = base ? [...base.sidecars] : [];
  for (const p of pending) {
    sidecars = applySidecarUpdate(sidecars, p.sidecars, p.compaction);
  }

  return { update: merged, sidecars };
}
