import * as Y from "yjs";

import {
  getEmptyUpdate,
  getEmptyStateVector,
  type StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";

import { DocumentStorage } from "../document-storage";

export abstract class UnencryptedDocumentStorage extends DocumentStorage {
  public encrypted = false;

  /**
   * Implements a default sync implementation that diffs the update with the sync step 1.
   *
   * This is useful for unencrypted documents, where the update is not encrypted and can be merged by Y.js.
   */
  async handleSyncStep1(
    key: string,
    syncStep1: StateVector,
  ): Promise<{
    update: SyncStep2Update;
    stateVector: StateVector;
  }> {
    const { update, stateVector } = (await this.fetch(key)) ?? {
      update: getEmptyUpdate(),
      stateVector: getEmptyStateVector(),
    };

    return {
      update: Y.diffUpdateV2(update, syncStep1) as SyncStep2Update,
      stateVector,
    };
  }

  /**
   * Implements a default sync implementation that writes the sync step 2 to the storage.
   *
   * This is useful for unencrypted documents, where the update is not encrypted and can be merged by Y.js.
   */
  async handleSyncStep2(
    key: string,
    syncStep2: SyncStep2Update,
  ): Promise<void> {
    // when unencrypted, there is no difference between the sync step 2 and the update message type
    await this.write(key, syncStep2 as unknown as Update);
  }
}
