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
import type { Document, DocumentMetadata, DocumentStorage, EncodedContentMap } from "./types";

export type DocumentState = {
  update: Uint8Array;
  sidecars: IndexedSidecar[];
};

function normalizeMetadata(
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

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Document storage base class.
 *
 * All updates arrive and leave in content-encrypted envelope format
 * (structure update V2 + sidecars). Internally stores as V2 + sidecars.
 * For unencrypted documents, sidecars are empty and the structure update
 * is the full Y.js update.
 */
export abstract class AbstractDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  readonly encrypted: boolean;

  get storageType(): "encrypted" | "unencrypted" {
    return this.encrypted ? "encrypted" : "unencrypted";
  }

  constructor(encrypted: boolean = false) {
    this.encrypted = encrypted;
  }

  abstract getDocumentState(key: string): Promise<DocumentState | null>;
  abstract replaceDocumentState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void>;
  abstract getDocumentMetadata(key: string): Promise<DocumentMetadata>;
  abstract writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void>;
  abstract deleteDocument(key: string): Promise<void>;

  protected async storeAttribution(_key: string, _attribution: EncodedContentMap): Promise<void> {}

  transaction<T>(_key: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }

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

    const diffMeta = Y.parseUpdateMetaV2(diff);
    const relevantSidecars = state.sidecars.filter((s) => sidecarOverlapsDiff(s.index, diffMeta));

    const update = encodeContentEncryptedPayload({
      structureUpdate: diff,
      encryptedSidecars: relevantSidecars.map((s) => s.encrypted),
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

  async handleUpdate(
    key: string,
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    await this.transaction(key, async () => {
      const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
      if (decoded.structureUpdate.length === 0) return;

      const incomingMeta = Y.parseUpdateMetaV2(decoded.structureUpdate);
      const index = buildSidecarIndexFromUpdateMeta(incomingMeta);
      const incomingSidecars: IndexedSidecar[] = decoded.encryptedSidecars.map((encrypted) => ({
        encrypted,
        index,
        hash: hashSidecar(encrypted),
      }));

      const now = Date.now();
      const existing = await this.getDocumentState(key);

      let merged: Uint8Array;
      let newSidecars: IndexedSidecar[];

      if (existing) {
        merged = Y.mergeUpdatesV2([existing.update, decoded.structureUpdate]);

        const svBefore = Y.encodeStateVectorFromUpdateV2(existing.update);
        const svAfter = Y.encodeStateVectorFromUpdateV2(merged);
        const isNoOp = arraysEqual(svBefore, svAfter);
        if (isNoOp && !decoded.compaction) return;

        // When the update adds no new state, keep the existing update unchanged
        // and don't append a sidecar for the empty diff.
        if (isNoOp) merged = existing.update;
        const appendedSidecars = isNoOp ? [] : incomingSidecars;

        if (decoded.compaction) {
          const matchedIndices = new Set<number>();
          for (const sourceHash of decoded.compaction.sourceHashes) {
            const idx = existing.sidecars.findIndex((s) => arraysEqual(s.hash, sourceHash));
            if (idx !== -1) matchedIndices.add(idx);
          }

          if (matchedIndices.size === decoded.compaction.sourceHashes.length) {
            const compactedSidecar: IndexedSidecar = {
              encrypted: decoded.compaction.sidecar,
              index: decoded.compaction.index,
              hash: decoded.compaction.hash,
            };
            const keptSidecars = existing.sidecars.filter((_, i) => !matchedIndices.has(i));
            newSidecars = [compactedSidecar, ...keptSidecars, ...appendedSidecars];
          } else {
            newSidecars = [...existing.sidecars, ...appendedSidecars];
          }
        } else {
          newSidecars = [...existing.sidecars, ...appendedSidecars];
        }
      } else {
        merged = decoded.structureUpdate;
        newSidecars = [...incomingSidecars];
      }

      await this.replaceDocumentState(key, merged, newSidecars);

      const metadata = normalizeMetadata(await this.getDocumentMetadata(key), now, this.encrypted);
      await this.writeDocumentMetadata(key, {
        ...metadata,
        updatedAt: now,
        sizeBytes: merged.length + newSidecars.reduce((s, b) => s + b.encrypted.length, 0),
      });

      if (attribution) {
        await this.storeAttribution(key, attribution);
      }
    });
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
      if (!arraysEqual(currentSV, baseSV)) return false;

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
