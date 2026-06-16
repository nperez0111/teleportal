import * as Y from "yjs";

import {
  getEmptyStateVector,
  getEmptyUpdate,
  type StateVector,
  type UpdateV2,
  type VersionedSyncStep2Update,
  type VersionedUpdate,
} from "teleportal";

import type { Document, DocumentMetadata, DocumentStorage, EncodedContentMap } from "../types";

function defaultMetadata(now: number, encrypted: boolean): DocumentMetadata {
  return {
    createdAt: now,
    updatedAt: now,
    encrypted,
  };
}

/**
 * Base implementation for unencrypted document storage backends.
 *
 * Provides default sync behavior using Yjs diffing.
 */
export abstract class UnencryptedDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType = "unencrypted" as const;

  abstract handleUpdate(
    documentId: Document["id"],
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
  ): Promise<void>;
  abstract getDocument(documentId: Document["id"]): Promise<Document | null>;
  abstract writeDocumentMetadata(
    documentId: Document["id"],
    metadata: DocumentMetadata,
  ): Promise<void>;
  abstract getDocumentMetadata(documentId: Document["id"]): Promise<DocumentMetadata>;
  abstract deleteDocument(documentId: Document["id"]): Promise<void>;
  transaction<T>(documentId: Document["id"], cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  async handleSyncStep1(documentId: Document["id"], syncStep1: StateVector): Promise<Document> {
    const now = Date.now();
    const doc = (await this.getDocument(documentId)) ?? {
      id: documentId,
      metadata: defaultMetadata(now, false),
      content: {
        update: getEmptyUpdate(),
        stateVector: getEmptyStateVector(),
      },
    };

    const update = Y.diffUpdateV2(doc.content.update, syncStep1) as UpdateV2;

    return {
      ...doc,
      content: {
        update,
        stateVector: doc.content.stateVector,
      },
    };
  }

  async handleSyncStep2(
    documentId: Document["id"],
    syncStep2: VersionedSyncStep2Update,
  ): Promise<void> {
    await this.handleUpdate(documentId, {
      version: syncStep2.version,
      data: syncStep2.data,
    } as unknown as VersionedUpdate);
  }
}
