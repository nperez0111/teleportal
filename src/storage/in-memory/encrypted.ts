import type { StateVector, Update } from "teleportal";
import {
  appendFauxUpdateList,
  decodeFauxUpdateList,
  encodeFauxStateVector,
  FauxUpdate,
  getEmptyFauxUpdateList,
} from "teleportal/protocol/encryption";
import { DocumentStorage } from "../document-storage";

export class EncryptedMemoryStorage extends DocumentStorage {
  public encrypted = true;

  public static docs = new Map<string, FauxUpdate>();
  /**
   * Persist a Y.js update to storage
   */
  async write(key: string, update: Update): Promise<void> {
    if (!EncryptedMemoryStorage.docs.has(key)) {
      EncryptedMemoryStorage.docs.set(key, getEmptyFauxUpdateList());
    }
    const content = EncryptedMemoryStorage.docs.get(key)!;

    EncryptedMemoryStorage.docs.set(
      key,
      appendFauxUpdateList(content, decodeFauxUpdateList(update)),
    );
  }

  /**
   * Retrieve a Y.js update from storage
   */
  async fetch(key: string): Promise<{
    update: Update;
    stateVector: StateVector;
  } | null> {
    if (!EncryptedMemoryStorage.docs.has(key)) {
      EncryptedMemoryStorage.docs.set(key, getEmptyFauxUpdateList());
    }
    const update = EncryptedMemoryStorage.docs.get(key)!;
    const updates = decodeFauxUpdateList(update);

    // Create a faux state vector with the latest message ID
    // For encrypted documents, the state vector represents all message IDs
    const latestMessageId = updates.length > 0 
      ? updates[updates.length - 1].messageId 
      : null;

    return {
      update,
      stateVector: encodeFauxStateVector({
        messageIds: latestMessageId ? [latestMessageId] : [],
      }),
    };
  }
}
