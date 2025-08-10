import * as Y from "yjs";

import type { StateVector, Update } from "teleportal";
import { UnencryptedDocumentStorage } from "../unencrypted";

export class YDocStorage extends UnencryptedDocumentStorage {
  public static docs = new Map<string, Y.Doc>();
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
}
