import * as Y from "yjs";

import {
  getStateVectorFromUpdate,
  getUpdateFromDoc,
  type Update,
} from "teleportal";
import { calculateDocumentSize } from "../utils";
import { UnencryptedDocumentStorage } from "../unencrypted";
import type { Document, DocumentMetadata } from "../types";

export class YDocStorage extends UnencryptedDocumentStorage {
  public static docs = new Map<string, Y.Doc>();
  public static metadata = new Map<string, DocumentMetadata>();

  constructor() {
    super();
  }

  /**
   * Persist a Y.js update to storage
   */
  async handleUpdate(key: string, update: Update): Promise<void> {
    if (!YDocStorage.docs.has(key)) {
      YDocStorage.docs.set(key, new Y.Doc());
    }
    const doc = YDocStorage.docs.get(key)!;

    Y.applyUpdateV2(doc, update);

    await this.transaction(key, async () => {
      const meta = await this.getDocumentMetadata(key);
      const fullUpdate = getUpdateFromDoc(doc);
      const sizeBytes = calculateDocumentSize(fullUpdate as Update);
      await this.writeDocumentMetadata(key, {
        ...meta,
        updatedAt: Date.now(),
        sizeBytes,
      });
    });
  }

  /**
   * Retrieve a Y.js update from storage
   */
  async getDocument(key: string): Promise<Document | null> {
    const doc = YDocStorage.docs.get(key) ?? new Y.Doc();

    YDocStorage.docs.set(key, doc);
    const update = getUpdateFromDoc(doc);
    const metadata = await this.getDocumentMetadata(key);

    return {
      id: key,
      metadata,
      content: {
        update,
        stateVector: getStateVectorFromUpdate(update),
      },
    };
  }

  async writeDocumentMetadata(
    key: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    YDocStorage.metadata.set(key, metadata);
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const existing = YDocStorage.metadata.get(key);
    if (!existing) {
      return { createdAt: now, updatedAt: now, encrypted: false };
    }
    return {
      ...existing,
      createdAt:
        typeof existing.createdAt === "number" ? existing.createdAt : now,
      updatedAt:
        typeof existing.updatedAt === "number" ? existing.updatedAt : now,
      encrypted:
        typeof existing.encrypted === "boolean" ? existing.encrypted : false,
    };
  }

  async deleteDocument(key: string): Promise<void> {
    YDocStorage.docs.delete(key);
    YDocStorage.metadata.delete(key);
  }
}
