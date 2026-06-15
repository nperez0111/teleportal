import * as Y from "yjs";

import { getStateVectorFromUpdate, getUpdateFromDoc, type Update } from "teleportal";
import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";
import { calculateDocumentSize } from "../utils";
import { UnencryptedDocumentStorage } from "../unencrypted";
import type { Document, DocumentMetadata, EncodedContentMap } from "../types";

export class YDocStorage extends UnencryptedDocumentStorage {
  public static docs = new Map<string, Y.Doc>();
  public static metadata = new Map<string, DocumentMetadata>();
  public static attributionMaps = new Map<string, EncodedContentMap[]>();

  constructor() {
    super();
  }

  async handleUpdate(key: string, update: Update, attribution?: EncodedContentMap): Promise<void> {
    if (!YDocStorage.docs.has(key)) {
      YDocStorage.docs.set(key, new Y.Doc());
    }
    const doc = YDocStorage.docs.get(key)!;

    Y.applyUpdateV2(doc, update);

    if (attribution) {
      let list = YDocStorage.attributionMaps.get(key);
      if (!list) {
        list = [];
        YDocStorage.attributionMaps.set(key, list);
      }
      list.push(attribution);
    }

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

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
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
      createdAt: typeof existing.createdAt === "number" ? existing.createdAt : now,
      updatedAt: typeof existing.updatedAt === "number" ? existing.updatedAt : now,
      encrypted: typeof existing.encrypted === "boolean" ? existing.encrypted : false,
    };
  }

  async deleteDocument(key: string): Promise<void> {
    YDocStorage.docs.delete(key);
    YDocStorage.metadata.delete(key);
    YDocStorage.attributionMaps.delete(key);
  }

  async retrieveAttribution(documentId: string): Promise<EncodedContentMap | null> {
    const list = YDocStorage.attributionMaps.get(documentId);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const merged = mergeContentMaps(list.map((m) => decodeContentMap(m)));
    return encodeContentMap(merged) as EncodedContentMap;
  }
}
