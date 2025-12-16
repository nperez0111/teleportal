import * as Y from "yjs";

import type { StateVector, Update } from "teleportal";
import { UnencryptedDocumentStorage } from "../unencrypted";
import {
  DocumentMetadata,
  type AttributionMetadata,
} from "../document-storage";
import { FileStorage } from "../file-storage";

export class YDocStorage extends UnencryptedDocumentStorage {
  public static docs = new Map<string, Y.Doc>();
  public static metadata = new Map<string, DocumentMetadata>();
  public static attributions = new Map<string, Y.IdMap<any>>();

  constructor(
    public readonly fileStorage: FileStorage | undefined = undefined,
  ) {
    super();
  }

  /**
   * Persist a Y.js update to storage
   */
  async write(
    key: string,
    update: Update,
    attribution?: AttributionMetadata,
  ): Promise<void> {
    if (!YDocStorage.docs.has(key)) {
      YDocStorage.docs.set(key, new Y.Doc());
    }
    const doc = YDocStorage.docs.get(key)!;

    Y.applyUpdateV2(doc, update);
    this.recordAttribution(key, update, attribution);
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
    YDocStorage.attributions.delete(key);
  }

  async getAttributions(key: string): Promise<Y.IdMap<any>> {
    return YDocStorage.cloneAttributionMap(key);
  }

  private static ensureAttributionMap(key: string): Y.IdMap<any> {
    let map = YDocStorage.attributions.get(key);
    if (!map) {
      map = new Map() as Y.IdMap<any>;
      YDocStorage.attributions.set(key, map);
    }
    return map;
  }

  private static cloneAttributionMap(key: string): Y.IdMap<any> {
    const map = YDocStorage.attributions.get(key);
    return (map ? new Map(map) : new Map()) as Y.IdMap<any>;
  }

  private recordAttribution(
    key: string,
    update: Update,
    attribution?: AttributionMetadata,
  ) {
    if (!attribution) {
      return;
    }

    const changeMap = YDocStorage.buildAttributionMap(update, attribution);
    if (!changeMap) {
      return;
    }

    const targetMap = YDocStorage.ensureAttributionMap(key);
    Y.insertIntoIdMap(targetMap, changeMap);
  }

  private static buildAttributionMap(
    update: Update,
    metadata: AttributionMetadata,
  ): Y.IdMap<any> | null {
    try {
      const ranges = Y.readUpdateIdRanges(update);
      const items = YDocStorage.createAttributionItems(metadata);

      const baseMap = Y.createIdMapFromIdSet(ranges.inserts, items);
      const deleteMap = Y.createIdMapFromIdSet(ranges.deletes, items);
      Y.insertIntoIdMap(baseMap, deleteMap);

      return baseMap;
    } catch {
      return null;
    }
  }

  private static createAttributionItems(
    metadata: AttributionMetadata,
  ): ReturnType<typeof Y.createAttributionItem>[] {
    const baseItems = [
      Y.createAttributionItem("user", metadata.user),
      Y.createAttributionItem("timestamp", metadata.timestamp),
    ];

    if (metadata.customAttributes) {
      for (const [key, value] of Object.entries(metadata.customAttributes)) {
        baseItems.push(Y.createAttributionItem(`custom:${key}`, value));
      }
    }

    return baseItems;
  }
}
