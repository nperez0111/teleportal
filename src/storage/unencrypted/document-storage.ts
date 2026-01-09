import * as Y from "yjs";

import {
  getEmptyStateVector,
  getEmptyUpdate,
  type StateVector,
  type SyncStep2Update,
  type Update,
} from "teleportal";

import type {
  Document,
  DocumentMetadata,
  DocumentMetadataUpdater,
  DocumentStorage,
  FileStorage,
  MilestoneStorage,
} from "../types";

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
export abstract class UnencryptedDocumentStorage
  implements DocumentStorage, DocumentMetadataUpdater
{
  readonly type = "document-storage" as const;
  storageType: "unencrypted" = "unencrypted";

  fileStorage?: FileStorage;
  milestoneStorage?: MilestoneStorage;

  async addFileToDocument(
    documentId: Document["id"],
    fileId: string,
  ): Promise<void> {
    await this.transaction(documentId, async () => {
      const metadata = await this.getDocumentMetadata(documentId);
      const files = Array.from(new Set([...(metadata.files ?? []), fileId]));
      await this.writeDocumentMetadata(documentId, {
        ...metadata,
        files,
        updatedAt: Date.now(),
      });
    });
  }

  async removeFileFromDocument(
    documentId: Document["id"],
    fileId: string,
  ): Promise<void> {
    await this.transaction(documentId, async () => {
      const metadata = await this.getDocumentMetadata(documentId);
      const files = (metadata.files ?? []).filter((id) => id !== fileId);
      await this.writeDocumentMetadata(documentId, {
        ...metadata,
        files,
        updatedAt: Date.now(),
      });
    });
  }

  abstract handleUpdate(
    documentId: Document["id"],
    update: Update,
  ): Promise<void>;
  abstract getDocument(documentId: Document["id"]): Promise<Document | null>;
  abstract writeDocumentMetadata(
    documentId: Document["id"],
    metadata: DocumentMetadata,
  ): Promise<void>;
  abstract getDocumentMetadata(
    documentId: Document["id"],
  ): Promise<DocumentMetadata>;
  abstract deleteDocument(documentId: Document["id"]): Promise<void>;
  transaction<T>(documentId: Document["id"], cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  async handleSyncStep1(
    documentId: Document["id"],
    syncStep1: StateVector,
  ): Promise<Document> {
    const now = Date.now();
    const doc = (await this.getDocument(documentId)) ?? {
      id: documentId,
      metadata: defaultMetadata(now, false),
      content: {
        update: getEmptyUpdate(),
        stateVector: getEmptyStateVector(),
      },
    };

    const update = Y.diffUpdateV2(doc.content.update, syncStep1) as Update;

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
    syncStep2: SyncStep2Update,
  ): Promise<void> {
    // when unencrypted, there is no difference between the sync step 2 and the update message type
    await this.handleUpdate(documentId, syncStep2 as unknown as Update);
  }
}
