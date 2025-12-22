import * as Y from "yjs";

import type { StateVector, Update } from "teleportal";
import { UnencryptedDocumentStorage } from "../unencrypted/document-storage";
import {
  DocumentMetadata,
  FileStorage,
  MilestoneStorage,
  Document,
} from "../types";

export class YDocStorage extends UnencryptedDocumentStorage {
  public static docs = new Map<string, Y.Doc>();
  public static metadata = new Map<string, DocumentMetadata>();
  public readonly milestoneStorage: MilestoneStorage | undefined;

  constructor(
    public readonly fileStorage: FileStorage | undefined = undefined,
    milestoneStorage: MilestoneStorage | undefined = undefined,
  ) {
    super();
    this.milestoneStorage = milestoneStorage;
  }

  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  /**
   * Persist a Y.js update to storage
   */
  async handleUpdate(documentId: string, update: Update): Promise<void> {
    if (!YDocStorage.docs.has(documentId)) {
      YDocStorage.docs.set(documentId, new Y.Doc());
    }
    const doc = YDocStorage.docs.get(documentId)!;

    Y.applyUpdateV2(doc, update);
  }

  /**
   * Retrieve a Y.js update from storage
   */
  async getDocument(documentId: string): Promise<Document | null> {
    const doc = YDocStorage.docs.get(documentId);
    if (!doc) {
      return null;
    }

    const update = Y.encodeStateAsUpdateV2(doc) as Update;
    return {
      id: documentId,
      metadata: YDocStorage.metadata.get(documentId) ?? {},
      content: {
        update,
        stateVector: Y.encodeStateVectorFromUpdateV2(update) as StateVector,
      },
    };
  }

  async writeDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    YDocStorage.metadata.set(documentId, metadata);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    return YDocStorage.metadata.get(documentId) ?? {};
  }

  async deleteDocument(documentId: string): Promise<void> {
    // Cascade delete files
    if (this.fileStorage) {
      await this.fileStorage.deleteFilesByDocument(documentId);
    }

    if (this.milestoneStorage) {
      const milestones = await this.milestoneStorage.getMilestones(documentId);
      if (milestones.length > 0) {
        await this.milestoneStorage.deleteMilestone(
          documentId,
          milestones.map((m) => m.id),
        );
      }
    }

    YDocStorage.docs.delete(documentId);
    YDocStorage.metadata.delete(documentId);
  }
}
