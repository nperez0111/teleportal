import * as Y from "yjs";

import type { StateVector, Update } from "teleportal";
import { UnencryptedDocumentStorage } from "../unencrypted";
import { DocumentMetadata } from "../document-storage";
import { FileStorage } from "../file-storage";

export class YDocStorage extends UnencryptedDocumentStorage {
  public static docs = new Map<string, Y.Doc>();
  public static metadata = new Map<string, DocumentMetadata>();

  constructor(
    public readonly fileStorage: FileStorage | undefined = undefined,
  ) {
    super();
  }

  /**
   * Persist a Y.js update to storage
   */
  async write(key: string, update: Update): Promise<void> {
    if (!YDocStorage.docs.has(key)) {
      YDocStorage.docs.set(key, new Y.Doc());
    }
    const doc = YDocStorage.docs.get(key)!;

    Y.applyUpdateV2(doc, update);
  }

  /**
   * Retrieve a Y.js update from storage
   */
  async fetch(key: string): Promise<{
    update: Update;
    stateVector: StateVector;
  } | null> {
    const doc = YDocStorage.docs.get(key) ?? new Y.Doc();

    YDocStorage.docs.set(key, doc);
    const update = Y.encodeStateAsUpdateV2(doc) as Update;
    return {
      update,
      stateVector: Y.encodeStateVectorFromUpdateV2(update) as StateVector,
    };
  }

  async writeDocumentMetadata(
    key: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    YDocStorage.metadata.set(key, metadata);
  }

  async fetchDocumentMetadata(key: string): Promise<DocumentMetadata> {
    return YDocStorage.metadata.get(key) ?? {};
  }

  async deleteDocument(key: string): Promise<void> {
    // Cascade delete files
    if (this.fileStorage) {
      await this.fileStorage.deleteFilesByDocument(key);
    }

    YDocStorage.docs.delete(key);
    YDocStorage.metadata.delete(key);
  }
}
