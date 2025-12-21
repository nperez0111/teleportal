import * as Y from "yjs";

import {
  getEmptyUpdate,
  getEmptyStateVector,
  type StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";

import {
  DocumentStorage,
  Document,
  DocumentMetadata,
  FileStorage,
  MilestoneStorage,
} from "../types";

export abstract class UnencryptedDocumentStorage implements DocumentStorage {
  readonly type = "document-storage";
  readonly storageType = "unencrypted";

  abstract fileStorage?: FileStorage;
  abstract milestoneStorage?: MilestoneStorage;

  abstract getDocument(documentId: Document["id"]): Promise<Document | null>;
  abstract handleUpdate(
    documentId: Document["id"],
    update: Update,
  ): Promise<void>;

  abstract writeDocumentMetadata(
    documentId: Document["id"],
    metadata: DocumentMetadata,
  ): Promise<void>;
  abstract getDocumentMetadata(
    documentId: Document["id"],
  ): Promise<DocumentMetadata>;
  abstract deleteDocument(documentId: Document["id"]): Promise<void>;
  abstract transaction<T>(
    documentId: Document["id"],
    cb: () => Promise<T>,
  ): Promise<T>;

  /**
   * Implements a default sync implementation that diffs the update with the sync step 1.
   *
   * This is useful for unencrypted documents, where the update is not encrypted and can be merged by Y.js.
   */
  async handleSyncStep1(
    documentId: string,
    syncStep1: StateVector,
  ): Promise<Document> {
    const doc = await this.getDocument(documentId);

    if (doc) {
      return {
        id: doc.id,
        metadata: doc.metadata,
        content: {
          update: Y.diffUpdateV2(
            doc.content.update,
            syncStep1,
          ) as unknown as Update,
          stateVector: doc.content.stateVector,
        },
      };
    }

    return {
      id: documentId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: false,
      },
      content: {
        update: getEmptyUpdate(),
        stateVector: getEmptyStateVector(),
      },
    };
  }

  /**
   * Implements a default sync implementation that writes the sync step 2 to the storage.
   *
   * This is useful for unencrypted documents, where the update is not encrypted and can be merged by Y.js.
   */
  async handleSyncStep2(
    documentId: string,
    syncStep2: SyncStep2Update,
  ): Promise<void> {
    // when unencrypted, there is no difference between the sync step 2 and the update message type
    await this.handleUpdate(documentId, syncStep2 as unknown as Update);
  }
}
